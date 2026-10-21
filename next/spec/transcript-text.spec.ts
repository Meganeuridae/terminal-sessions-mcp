/** api-20: UTF-8-safe cutting (src/core/text.ts) for byte-capped results (G11). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutTail, executedIn, headIndex, indexAtByte, isStringStart, lineCarry, lineEnds, tailIndex, tailStart, utf8Length, safeCut, sequenceEnd, stripEscapes, unfinishedSequence } from '../src/core/text.js';

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

test('a tail cut never starts inside a control sequence, a surrogate pair or a CRLF: it moves forward past it, so the budget holds and no payload shows', () => {
  // The house's read of 78c4d6e (#22): `tailStart` over 1,000 A and `ESC [ 31 m Hello` with 8 bytes kept `31mHello`; and of the
  // 38 commits after it (comment 6274773484): the cut then moved back and kept 58 bytes of a 30-byte budget.
  const red = `${'A'.repeat(1000)}\x1b[31mHello`;
  assert.equal(red.slice(tailStart(red, 8)), 'Hello', 'past the sequence, not back to its start');
  assert.deepEqual(cutTail(red, 8), { text: 'Hello', cut: true });
  // An OSC 8 link cut at 40 showed the link's tail as text; the kept tail now begins after the link's opening string.
  const link = `${'x'.repeat(200)}\x1b]8;;https://example.com/a/very/long/link\x1b\\link\x1b]8;;\x1b\\ tail`;
  assert.equal(link.slice(tailStart(link, 40)), 'link\x1b]8;;\x1b\\ tail');
  const short = `${'a'.repeat(40)}\x1b]8;;https://example.com/a/very/long/link\x1b\\link\x1b]8;;\x1b\\ tail`;
  assert.ok(Buffer.byteLength(cutTail(short, 30).text) <= 30, `at most the budget: ${Buffer.byteLength(cutTail(short, 30).text)} bytes`);
  // A long control string (an OSC 52 clipboard, its base64 wrapped with newlines as GNU base64 wraps it) is looked back
  // through whole: a tail of 100 or of 3,000 bytes never begins inside its payload, and a newline in the payload begins no line.
  const payload = Array.from({ length: 80 }, () => 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk='.slice(0, 76)).join('\n');
  const clip = `${'A'.repeat(500)}\x1b]52;c;${payload}\x07after the clipboard\nlast line`;
  for (const budget of [100, 3000]) {
    const at = tailStart(clip, budget);
    assert.ok(at >= clip.indexOf('\x07') + 1, `budget ${budget}: the tail begins after the string, not in it (${JSON.stringify(clip.slice(at, at + 12))})`);
    assert.ok(Buffer.byteLength(clip.slice(at)) <= budget, `budget ${budget} holds`);
  }
  assert.equal(clip.slice(tailStart(clip, 100)), 'last line', 'the line boundary after the string is still preferred');
  // A pair and a CRLF at the cut move forward too.
  const pair = `${'a'.repeat(100)}😀b`;
  assert.equal(pair.slice(tailStart(pair, 5)), '😀b');
  assert.equal(pair.slice(tailStart(pair, 3)), 'b', 'half the budget of a pair is none of it');
  const crlf = `${'a'.repeat(100)}\r\nb`;
  assert.equal(crlf.slice(tailStart(crlf, 2)), 'b');
  // The line-boundary rule still applies after the move.
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

test('an escape sequence or a CSI ends where the emulator ends it: the C0 controls inside execute and it goes on (the house’s review of the 40 commits through f3750e4, #22, comment 6310921374)', () => {
  // The emulator shows `A ESC [ 3 LF C B` as `A`, then `    B`: the LF moves the cursor down, and `C` ends the CSI.
  assert.equal(sequenceEnd('\x1b[3\nCB', 0), 5, 'the LF is inside the CSI, and C its final byte');
  assert.deepEqual(executedIn('\x1b[3\nCB', 0, 5), [3]);
  assert.equal(sequenceEnd('\x1b[3\x7fCB', 0), 5, 'DEL is ignored inside a CSI');
  assert.equal(sequenceEnd('\x1b[3\x18CB', 0), 3, 'CAN aborts it, and is not part of it');
  assert.equal(sequenceEnd('\x1b[3\x1b[31m', 0), 3, 'an ESC begins another');
  assert.equal(sequenceEnd('\x1b[3éB', 0), 4, 'a code point from U+00A0 is an error that ends it, taken with it');
  assert.equal(sequenceEnd('\x1b[3\u{1F600}B', 0), 5, 'both halves of a pair');
  assert.equal(sequenceEnd('\x1b[1?éCB', 0), 6, 'once a misplaced byte set it to ignore the rest, the code point is ignored, and C ends it');
  assert.equal(sequenceEnd('\x1b[3\n', 0), undefined, 'still open after its LF');
  // An ESC: the C0 controls after it execute too, and the byte after them says what it begins.
  assert.equal(sequenceEnd('\x1b\n[31mB', 0), 6, 'ESC LF [ opens a CSI');
  assert.equal(sequenceEnd('\x1b(\nBx', 0), 4, 'an intermediate, a LF, the final byte');
  assert.equal(sequenceEnd('\x1b\x7f7B', 0), 3, 'DEL is ignored after ESC');
  assert.equal(sequenceEnd('\x1b\x1b[31m', 0), 1, 'an ESC after ESC begins another: the first is alone');
  assert.equal(sequenceEnd('\x1b\x9b31m', 0), 1, 'a C1 control after ESC acts');
  assert.equal(sequenceEnd('\x1béB', 0), 2, 'a code point from U+00A0 after ESC is an error, taken with it');
  assert.equal(sequenceEnd('\x1b\n', 0), undefined);
  assert.equal(isStringStart('\x1b\n]0;t\x07', 0), true, 'ESC LF ] opens an OSC');
  assert.equal(sequenceEnd('\x1b\n]0;t\x07B', 0), 7);
  assert.deepEqual(executedIn('\x1b\n]0;a\nb\x07', 0, 9), [1], 'a string executes only what comes before the byte that says what it is');
  // stripEscapes keeps the tabs and newlines a sequence executes, where they stand, and the CSI's rest is no text.
  assert.deepEqual(stripEscapes('A\x1b[3\nCB'), { text: 'A\nB', map: [0, 4, 6] });
  assert.equal(stripEscapes('A\x1b[\t2CB').text, 'A\tB');
  assert.equal(stripEscapes('A\x1b[3\n').text, 'A\n', 'what an unfinished CSI executed so far stays');
  assert.equal(stripEscapes('A\x1b\n]0;t\x07B').text, 'A\nB');
  // safeCut and unfinishedSequence follow: the CSI is one sequence across its LF.
  assert.equal(safeCut('A\x1b[3\nCB', 5), 1, 'a cut after the LF is inside the CSI: before it');
  assert.equal(unfinishedSequence('A\x1b[3\n'), 1);
});

test('a LF a CSI executes ends a line: lineEnds reports it with the head the next line begins with only when asked, and a tail never begins inside the CSI', () => {
  const data = 'A\x1b[3\nCB\nnext\n';
  assert.deepEqual(lineEnds(data), [7, 12], 'a reader that cuts gets only the ends outside every sequence');
  const inside = new Map<number, string>();
  assert.deepEqual(lineEnds(data, lineCarry(), Number.POSITIVE_INFINITY, false, inside), [4, 7, 12]);
  assert.deepEqual([...inside], [[4, '\x1b[3']], 'the line after it begins with the CSI so far');
  // Across events: the CSI open at the end of the first is carried without its LF, which is reported once.
  const carry = lineCarry();
  const first = new Map<number, string>();
  assert.deepEqual(lineEnds('A\x1b[3\n', carry, Number.POSITIVE_INFINITY, false, first), [4]);
  assert.equal(carry.open, '\x1b[3');
  const second = new Map<number, string>();
  assert.deepEqual(lineEnds('\n1mB\n', carry, Number.POSITIVE_INFINITY, false, second), [0, 4]);
  assert.deepEqual([...second], [[0, '\x1b[3']], 'a second LF inside the same CSI');
  // The executed controls before an ESC's string end lines too; the payload's do not.
  const osc = new Map<number, string>();
  assert.deepEqual(lineEnds('A\x1b\n]0;a\nb\x07B\n', lineCarry(), Number.POSITIVE_INFINITY, false, osc), [2, 11]);
  assert.deepEqual([...osc], [[2, '\x1b']]);
  // A long malformed head is kept short, in the state it leaves the parser in.
  const long = `\x1b[${'1;'.repeat(100)}`;
  const c = lineCarry();
  lineEnds(`${long}\n`, c);
  assert.equal(c.open, '\x1b[0', 'a CSI in its parameters, without them');
  // A tail cut takes a CSI holding a LF whole or moves past it, and takes no line boundary inside it: it began with `CB`.
  const t = `${'x'.repeat(100)}\x1b[3\nCB\nend`;
  assert.equal(t.slice(tailStart(t, 10)), '\x1b[3\nCB\nend');
  assert.equal(t.slice(tailStart(t, 9)), 'end');
});
