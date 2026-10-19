/** api-20: UTF-8-safe cutting (src/core/text.ts) for byte-capped results (G11). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutTail, headIndex, indexAtByte, tailIndex, tailStart, utf8Length, safeCut, sequenceEnd, stripEscapes, unfinishedSequence } from '../src/core/text.js';

const bytes = (s: string) => Buffer.byteLength(s);
const clean = (s: string) => !s.includes('�') && Buffer.from(s).toString() === s;

test('api-20: a cut never splits a character (2-, 3- and 4-byte UTF-8, surrogate pairs)', () => {
  const samples = ['é'.repeat(700), '日本語'.repeat(300), '🙂👍🏽'.repeat(200), `mixed ascii é 日 🙂 ${'x'.repeat(50)}`.repeat(20)];
  for (const s of samples) {
    for (let max = 0; max <= 64; max++) {
      const t = cutTail(s, max);
      assert.ok(clean(t.text), `no broken character at max ${max}`);
      assert.ok(bytes(t.text) <= max, `fits ${max}`);
      assert.equal(t.cut, true);
      // Nothing is dropped beyond the one character that would not fit.
      assert.ok(max - bytes(t.text) < 4, `kept ${bytes(t.text)} of ${max}`);
      assert.ok(s.endsWith(t.text));
    }
  }
});

test('api-20: under the cap nothing is cut', () => {
  assert.deepEqual(cutTail('héllo', 100), { text: 'héllo', cut: false });
  assert.equal(utf8Length('🙂é'), 6);
});

test('api-20: a line boundary in the half of the budget nearest the cut is preferred', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'é'.repeat(10)}`).join('\n');
  const t = cutTail(lines, 500);
  assert.match(t.text, /^line \d\d é{10}\n/);
  assert.ok(t.text.endsWith(`line 49 ${'é'.repeat(10)}`));
  // No boundary within reach: a single long line is cut at a character, not dropped.
  const one = `${'a'.repeat(900)}\n${'b'.repeat(100)}`;
  assert.equal(cutTail(one, 500).text, `${'a'.repeat(399)}\n${'b'.repeat(100)}`.slice(-500));
  assert.equal(cutTail(one, 500).text.length, 500);
  // A newline as the very last character is not a place to start from.
  assert.equal(cutTail(`${'x'.repeat(20)}\n`, 10).text, `${'x'.repeat(9)}\n`);
});

test('headIndex / tailIndex count UTF-8 bytes and respect surrogate pairs', () => {
  assert.equal(headIndex('a🙂b', 4), 1);
  assert.equal(headIndex('a🙂b', 5), 3);
  assert.equal(tailIndex('a🙂b', 4), 3);
  assert.equal(tailIndex('a🙂b', 5), 1);
  assert.equal(headIndex('日本', 5), 1);
  assert.equal(tailIndex('日本', 6), 0);
  // A lone surrogate counts as U+FFFD (3 bytes), as Node encodes it.
  assert.equal(headIndex('\ud83dx', 3), 1);
  assert.equal(utf8Length('\ud83d'), 3);
  // indexAtByte rounds up to a character boundary.
  assert.deepEqual([0, 1, 2, 5, 6, 7].map((b) => indexAtByte('a🙂b', b)), [0, 1, 3, 3, 4, 4]);
});

test('er-1: safeCut never splits a control sequence, a surrogate pair or a CRLF; unfinishedSequence finds one left open', () => {
  const s = 'ab\x1b[31mred\x1b[0m\r\n😀x\x1b]8;;http://h/q\x1b\\link';
  for (let i = 0; i <= s.length; i++) {
    const c = safeCut(s, i);
    assert.ok(c <= i);
    // The head ends at no open sequence, and the tail starts inside none.
    assert.equal(unfinishedSequence(s.slice(0, c)), c, `cut ${c} (asked ${i}) leaves a sequence open`);
    assert.ok(!(s[c - 1] === '\r' && s[c] === '\n'), `cut ${c} splits a CRLF`);
    assert.ok(!((s.charCodeAt(c) & 0xfc00) === 0xdc00 && c > 0), `cut ${c} splits a surrogate pair`);
  }
  assert.equal(safeCut(s, 4), 2, 'inside ESC [ 3 1 m: before it');
  assert.equal(unfinishedSequence('text\x1b[3'), 4);
  assert.equal(unfinishedSequence('text\x1b]0;title'), 4);
  assert.equal(unfinishedSequence('text\x1b]0;title\x07'), 'text\x1b]0;title\x07'.length);
  assert.equal(unfinishedSequence('text\x1b]8;;u\x1b'), 4, 'a lone ESC ending a string: the string is what is open');
  assert.equal(unfinishedSequence('text\x1b]8;;u\x1b\\'), 'text\x1b]8;;u\x1b\\'.length);
  assert.equal(unfinishedSequence('text\x1b'), 4);
  assert.equal(sequenceEnd('\x1b[1;2H!', 0), 6);
  assert.equal(sequenceEnd('\x1b]8;;u\x1b\\!', 0), 8);
  assert.equal(sequenceEnd('\x1b(B!', 0), 3);
  assert.equal(sequenceEnd('\x1b]0;never', 0), undefined);
});

test('two-byte ESC sequences end after their one final byte; intermediates still take a final byte after them', () => {
  for (const two of ['\x1b7', '\x1b8', '\x1b=', '\x1b>', '\x1bM', '\x1bc']) {
    assert.equal(sequenceEnd(two, 0), 2, JSON.stringify(two));
    assert.equal(sequenceEnd(`${two}X`, 0), 2, `${JSON.stringify(two)} does not take the character after it`);
    assert.equal(unfinishedSequence(`abc${two}`), 5, `${JSON.stringify(two)} is complete at the end of the data`);
  }
  assert.equal(sequenceEnd('\x1b(B', 0), 3, 'an intermediate, then the final byte');
  assert.equal(sequenceEnd('\x1b(', 0), undefined, 'an intermediate still waiting for its final byte');
  assert.equal(unfinishedSequence('abc\x1b('), 3);
  assert.equal(sequenceEnd('\x1b[?1l', 0), 5);
  assert.equal(sequenceEnd('\x1b[?1h\x1b=', 5), 7, 'xterm turns keypad mode on with CSI ?1h ESC =');
});

test('a tail cut never starts inside a control sequence, a surrogate pair or a CRLF: it moves earlier, by at most the sequence it would have split', () => {
  // The house's read of 78c4d6e (#22): `tailStart` over 1,000 A and `ESC [ 31 m Hello` with 8 bytes kept `31mHello`.
  const red = `${'A'.repeat(1000)}\x1b[31mHello`;
  assert.equal(red.slice(tailStart(red, 8)), '\x1b[31mHello');
  assert.equal(cutTail(red, 8).text, '\x1b[31mHello');
  // An OSC 8 link cut at 40 showed the link's tail as text.
  const link = `${'x'.repeat(200)}\x1b]8;;https://example.com/a/very/long/link\x1b\\link\x1b]8;;\x1b\\ tail`;
  const at40 = link.slice(tailStart(link, 40));
  assert.ok(at40.startsWith('\x1b]8;;https://example.com/a/very/long/link\x1b\\'), JSON.stringify(at40));
  assert.equal(unfinishedSequence(link.slice(0, tailStart(link, 40))), tailStart(link, 40), 'the dropped head ends at no open sequence');
  // A pair and a CRLF at the cut.
  const pair = `${'a'.repeat(100)}😀b`;
  assert.equal(pair.slice(tailStart(pair, 5)), '😀b');
  const crlf = `${'a'.repeat(100)}\r\nb`;
  assert.equal(crlf.slice(tailStart(crlf, 2)), '\r\nb');
  // The line-boundary rule still applies after the safe cut.
  const lines = `${'a'.repeat(100)}\n\x1b[1mb\nc`;
  assert.equal(lines.slice(tailStart(lines, 12)), '\x1b[1mb\nc');
});

test('stripEscapes: the one grammar, with a map from each kept character to its place in the raw text', () => {
  // Readers: the typeahead echo, the secret-prompt check and the plumbing cut (the house's read of 78c4d6e, #22, found it unspecified).
  const plain = stripEscapes('\x1b[1;31mred\x1b[0m ok');
  assert.equal(plain.text, 'red ok');
  assert.deepEqual(plain.map, [7, 8, 9, 14, 15, 16], 'each kept character maps to its raw index');
  // Two-byte forms (ESC 7, ESC 8, ESC =, ESC >, ESC M, ESC c) take exactly one byte after ESC.
  assert.equal(stripEscapes('a\x1b7b\x1b8c\x1b=d\x1b>e\x1bMf\x1bcg').text, 'abcdefg');
  // Intermediate forms (charset designations, DECALN, UTF-8 select) take their final byte too: ESC ( B leaves no B.
  assert.equal(stripEscapes('a\x1b(Bb\x1b)0c\x1b#8d\x1b%Ge').text, 'abcde');
  // OSC to BEL or ST, DCS to ST, the C1 CSI.
  assert.equal(stripEscapes('x\x1b]0;title\x07y\x1b]8;;u\x1b\\z\x1bPq#0\x1b\\w\x9b0mv').text, 'xyzwv');
  // An unfinished sequence takes the rest of the text with it: its payload is not text.
  assert.deepEqual(stripEscapes('ready\x1b]0;title'), { text: 'ready', map: [0, 1, 2, 3, 4] });
  assert.equal(stripEscapes('working \x1b[3').text, 'working ');
  assert.equal(stripEscapes('tail\x1b').text, 'tail');
  // Controls other than tab and newline go (CR included: the readers compare echoes, not displays); the map skips them.
  const ctl = stripEscapes('a\rb\x00c\td\ne\x7f');
  assert.equal(ctl.text, 'abc\td\ne');
  assert.deepEqual(ctl.map, [0, 2, 4, 5, 6, 7, 8]);
  // A U+FFFD or a private-use character is text.
  assert.equal(stripEscapes('\uE000\uFFFD').text, '\uE000\uFFFD');
});
