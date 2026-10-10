/**
 * Unit tests for ANSI stripping, focused on the full-CSI-grammar fix:
 * sequences with non-letter final bytes (ESC[1@, ESC[2 q) used to leave
 * residue like "[1@" in cleaned output.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { stripAnsi, cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');

test('strips SGR color sequences', () => {
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m plain'), 'red plain');
});

test('strips CSI sequences with non-letter final bytes', () => {
  assert.strictEqual(stripAnsi('\x1b[1@abc'), 'abc', 'insert-character (ESC[n@)');
  assert.strictEqual(stripAnsi('\x1b[3Pabc'), 'abc', 'delete-character with digit param');
  assert.strictEqual(stripAnsi('\x1b[2 qabc'), 'abc', 'cursor style with intermediate byte');
});

test('strips private-mode and OSC sequences', () => {
  assert.strictEqual(stripAnsi('\x1b[?1034habc'), 'abc');
  assert.strictEqual(stripAnsi('\x1b]0;window title\x07abc'), 'abc');
});

test('strips two-character and charset escapes without leaving their final byte', () => {
  assert.strictEqual(stripAnsi('42\x1b>'), '42', 'keypad numeric mode (ESC >), printed by less on exit');
  assert.strictEqual(stripAnsi('\x1b=abc'), 'abc', 'keypad application mode (ESC =)');
  assert.strictEqual(stripAnsi('\x1b7abc\x1b8'), 'abc', 'save/restore cursor (ESC 7 / ESC 8)');
  assert.strictEqual(stripAnsi('\x1bMabc'), 'abc', 'reverse index (ESC M)');
  assert.strictEqual(stripAnsi('\x1b(Babc\x1b)0'), 'abc', 'charset selection (ESC ( B, ESC ) 0)');
  assert.strictEqual(stripAnsi('\x1bOAabc'), 'abc', 'SS3 cursor key (ESC O A)');
  assert.strictEqual(stripAnsi('a > b'), 'a > b', 'a plain > is output');
});

test('carriage-return overwrite keeps final state', () => {
  assert.strictEqual(
    cleanTerminalOutput('Downloading 10%\rDownloading 50%\rDownloading 100%'),
    'Downloading 100%'
  );
});
