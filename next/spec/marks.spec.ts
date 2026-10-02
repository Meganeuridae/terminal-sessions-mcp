import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_REDACTED, MarksParser, decodeVscodeValue, encodeVscodeValue, type Mark, type Piece } from '../src/core/marks.js';

const OSC = (s: string) => `\x1b]${s}\x07`;
const KEY = '0123456789abcdef0123456789abcdef';
const K = (s: string) => OSC(`${s};k=${KEY}`);
const marksOf = (pieces: Piece[]): Mark[] => pieces.filter((x): x is Extract<Piece, { kind: 'mark' }> => x.kind === 'mark').map((x) => x.mark);
const outputOf = (pieces: Piece[]) => pieces.filter((x): x is Extract<Piece, { kind: 'output' }> => x.kind === 'output').map((x) => x.data).join('');

test('atc-3: splits output at marks; a keyed mark\'s bytes are not output (the key never leaves the daemon)', () => {
  const p = new MarksParser(KEY);
  const pieces = p.feed('hello' + K('133;A') + 'world');
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces[0], { kind: 'output', data: 'hello' });
  assert.equal(pieces[1]!.kind, 'mark');
  assert.deepEqual(pieces[1], { kind: 'mark', mark: { osc: 133, code: 'A', params: [] }, raw: K('133;A') });
  assert.deepEqual(pieces[2], { kind: 'output', data: 'world' });
});

test('keyed marks: 133 codes with exit, 633;E lines and 633;P properties with VS Code escaping; the key is not a param', () => {
  const p = new MarksParser(KEY);
  const marks = marksOf(p.feed(K('133;D;42') + K('633;P;Cwd=/tmp/a b\\x3bc\\\\d') + K('633;E;echo a\\x3b b\\\\c\\x0ad') + K('633;P;TsmHello=bash') + K('133;B;a=1')));
  assert.deepEqual(marks[0], { osc: 133, code: 'D', exit: 42, params: ['42'] });
  assert.deepEqual(marks[1], { osc: 633, code: 'P', params: ['Cwd=/tmp/a b\\x3bc\\\\d'], property: 'Cwd', value: '/tmp/a b;c\\d' });
  assert.deepEqual(marks[2], { osc: 633, code: 'E', params: ['echo a\\x3b b\\\\c\\x0ad'], line: 'echo a; b\\c\nd' });
  assert.deepEqual(marks[3], { osc: 633, code: 'P', params: ['TsmHello=bash'], property: 'TsmHello', value: 'bash' });
  assert.deepEqual(marks[4], { osc: 133, code: 'B', params: ['a=1'] });
});

test('G2/G7 (core-3, emu-6, emu-14, shell-16): unkeyed, wrongly keyed and OSC 7 sequences are ordinary output', () => {
  const p = new MarksParser(KEY);
  const foreign = OSC('133;A') + OSC('133;D;0') + OSC('133;C;') + OSC('7;file://host/tmp/a%41b') + OSC('633;P;Cwd=/srv') + OSC(`133;A;k=${KEY}x`) + OSC('133;A;k=') + OSC(`133;A;k=${KEY};x=1`);
  const pieces = p.feed(foreign);
  assert.deepEqual(marksOf(pieces), []);
  assert.equal(outputOf(pieces), foreign.split(KEY).join(KEY_REDACTED), 'the bytes pass through, save the key\'s own text (atc-3)');
  // A path with a literal %41 is never percent-decoded (cwd comes from 633;P;Cwd).
  const cwd = marksOf(p.feed(K(`633;P;Cwd=${encodeVscodeValue('/tmp/100%41')}`)))[0] as Extract<Mark, { osc: 633 }>;
  assert.equal(cwd.value, '/tmp/100%41');
});

test('emu-1: a mark split at every offset — and fed byte by byte — is still found exactly once', () => {
  const stream = 'out' + K('133;D;7') + K('633;P;Cwd=/x') + K('133;A') + '$ ' + K('133;B') + '\x1b]133;C;k=' + KEY + '\x1b\\' + 'tail';
  const expected = marksOf(new MarksParser(KEY).feed(stream)).map((m) => `${m.osc}:${m.code}`);
  assert.equal(expected.length, 5);
  for (let cut = 1; cut < stream.length; cut++) {
    const p = new MarksParser(KEY);
    const pieces = [...p.feed(stream.slice(0, cut)), ...p.feed(stream.slice(cut)), ...p.flush()];
    assert.deepEqual(marksOf(pieces).map((m) => `${m.osc}:${m.code}`), expected, `cut at ${cut}`);
    assert.equal(outputOf(pieces), 'out$ tail', `output intact, without the keyed marks, at ${cut}`);
  }
  const p = new MarksParser(KEY);
  const pieces: Piece[] = [];
  for (const ch of stream) pieces.push(...p.feed(ch));
  assert.deepEqual(marksOf(pieces).map((m) => `${m.osc}:${m.code}`), expected, 'byte by byte');
  assert.equal(outputOf(pieces), 'out$ tail');
});

test('emu-15: a non-mark OSC is never held (C1 ST or no terminator); C1 OSC and C1-terminated 133 are output', () => {
  const p = new MarksParser(KEY);
  assert.equal(outputOf(p.feed('\x1b]0;title\u009c')), '\x1b]0;title\u009c');
  assert.deepEqual(p.feed('Password: '), [{ kind: 'output', data: 'Password: ' }], 'later output is not held back');
  assert.equal(outputOf(p.feed('\x1b]2;unterminated title ')), '\x1b]2;unterminated title ', 'cannot be a mark: released at once');
  assert.deepEqual(marksOf(p.feed(`\u009d133;A;k=${KEY}\u009c`)), []);
  assert.deepEqual(marksOf(p.feed(`\x1b]133;A;k=${KEY}\u009c`)), []);
  assert.deepEqual(p.flush(), []);
});

test('an unterminated tail that can still become a mark is held, then flushed as output at the end', () => {
  const p = new MarksParser(KEY);
  assert.deepEqual(p.feed('abc\x1b]133;D;'), [{ kind: 'output', data: 'abc' }]);
  assert.deepEqual(p.flush(), [{ kind: 'output', data: '\x1b]133;D;' }]);
  assert.deepEqual(p.feed('x\x1b'), [{ kind: 'output', data: 'x' }], 'a trailing lone ESC is held');
  assert.deepEqual(p.feed('[31mred'), [{ kind: 'output', data: '\x1b[31mred' }], 'and released when it is not an OSC');
  assert.deepEqual(p.feed('\x1b]133;A\x1b[31mred'), [{ kind: 'output', data: '\x1b]133;A\x1b[31mred' }], 'an ESC that is not ST: a malformed OSC, output');
});

test('decodeVscodeValue / encodeVscodeValue round-trip, including the controls that would end an OSC', () => {
  assert.equal(decodeVscodeValue('a\\x3bb\\\\c'), 'a;b\\c');
  for (const s of ['plain', 'a;b\\c', 'line1\nline2\r', 'bel\x07esc\x1b', 'tab\there', '100%41']) assert.equal(decodeVscodeValue(encodeVscodeValue(s)), s);
  assert.ok(!/[\x07\x1b;]/.test(encodeVscodeValue('x;\x07\x1b')));
});

test('atc-3: the key\'s literal text in output is redacted, even split across reads at every offset; nothing else is held', () => {
  // A `set` or `declare -p` in the shell prints the integration's variables, key included.
  const stream = `__tsm_key=${KEY}\n__tsm_b='...k=${KEY}...'\nplain 0123 text\n`;
  const want = stream.split(KEY).join(KEY_REDACTED);
  for (let cut = 0; cut <= stream.length; cut++) {
    const p = new MarksParser(KEY);
    const pieces = [...p.feed(stream.slice(0, cut)), ...p.feed(stream.slice(cut)), ...p.flush()];
    const out = outputOf(pieces);
    assert.equal(out, want, `cut at ${cut}`);
    for (const piece of pieces) if (piece.kind === 'output') assert.ok(!piece.data.includes(KEY.slice(0, 8)), `no fragment of the key at ${cut}`);
  }
  const p = new MarksParser(KEY);
  assert.deepEqual(p.feed('prompt> '), [{ kind: 'output', data: 'prompt> ' }], 'text that cannot start the key is never held');
  assert.deepEqual(p.feed('value 0'), [{ kind: 'output', data: 'value ' }], 'a trailing key prefix is held…');
  assert.deepEqual(p.feed('!'), [{ kind: 'output', data: '0!' }], '…and released with the next read');
  assert.deepEqual(p.flush(), []);
  // A terminal query whose final byte is the key's first character is never held: the
  // program that sent it (fish at startup) waits for the emulator's answer.
  const c = new MarksParser('c' + KEY.slice(1));
  assert.deepEqual(c.feed('\x1b[0c'), [{ kind: 'output', data: '\x1b[0c' }]);
  assert.deepEqual(c.feed('\x1b[c'), [{ kind: 'output', data: '\x1b[c' }]);
  assert.deepEqual(c.feed('\x1bc'), [{ kind: 'output', data: '\x1bc' }], 'RIS');
  assert.deepEqual(c.feed('abc'), [{ kind: 'output', data: 'ab' }], 'text is still held');
  assert.deepEqual(c.flush(), [{ kind: 'output', data: 'c' }]);
  // A query split across reads: its final byte opens the next read, and is not text either.
  assert.deepEqual(c.feed('\x1b[0'), [{ kind: 'output', data: '\x1b[0' }]);
  assert.deepEqual(c.feed('c'), [{ kind: 'output', data: 'c' }]);
});

test('ss-4: rekey retires the old key — its marks become output, and its text is no longer the redacted one', () => {
  const p = new MarksParser(KEY);
  const other = 'f'.repeat(32);
  p.rekey(other);
  const pieces = p.feed(K('133;D;0') + OSC(`133;A;k=${other}`));
  assert.deepEqual(marksOf(pieces).map((m) => m.code), ['A']);
  assert.equal(outputOf(pieces), K('133;D;0'));
});
