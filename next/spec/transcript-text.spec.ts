/** api-20: UTF-8-safe cutting (src/core/text.ts) for byte-capped results (G11). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutTail, headIndex, indexAtByte, tailIndex, utf8Length, safeCut, sequenceEnd, unfinishedSequence } from '../src/core/text.js';

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
