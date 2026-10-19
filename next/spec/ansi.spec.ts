/**
 * Line matching for watches, wait_for and service probes (StreamMatcher,
 * LineSplitter): patterns mean what they mean in `search` — per line, anchors at
 * the line's ends — whatever the chunking, each line matched once, prompts seen
 * after a quiet moment, and every pattern on the linear-time engine (m2-10, m2-5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLine, compileLinePattern, LineSplitter, MAX_LINE, StreamMatcher, type LineMatch } from '../src/core/ansi.js';
import { LINEAR_REGEX, MIN_WINDOW, matchWindow } from '../src/core/regex.js';
import { TermError } from '../src/core/errors.js';
import { sleep } from './testhost.js';

const matcher = (pattern: string, opts?: ConstructorParameters<typeof StreamMatcher>[1]) => new StreamMatcher(compileLinePattern(pattern), opts);
const matches = (pattern: string, chunks: string[]) => {
  const m = matcher(pattern);
  return chunks.flatMap((c) => m.feed(c)).map((h) => h.match);
};
const refused = (f: () => unknown) => assert.throws(f, (e: unknown) => e instanceof TermError && e.code === 'invalid_argument');

test('m2-10: anchors mean the line’s start and end, however the output was chunked', () => {
  // One chunk holding several lines: `^ERROR` is the second line's start.
  assert.deepEqual(matches('^ERROR', ['ok\r\nERROR: boom\r\n']), ['ERROR']);
  assert.deepEqual(matches('^ERROR', ['ok\r\n', 'ERROR: boom\r\n']), ['ERROR']);
  // `$` is the line's end, before CRLF.
  assert.deepEqual(matches('ready$', ['server ready\r\n']), ['ready']);
  assert.deepEqual(matches('done$', ['building\nERROR: boom\nall done\n']), ['done']);
  // After a match, `^` does not match again mid-line: one line, one match.
  assert.deepEqual(matches('^a', ['aaa\n']), ['a']);
  assert.deepEqual(matches('ERR', ['ERR ERR ERR\n']), ['ERR'], 'a line yields at most one match');
  // `^` does not match mid-line at a chunk boundary.
  assert.deepEqual(matches('^ERROR', ['ok then ', 'ERROR later\n']), []);
});

test('m2-10: a split write is reported once, complete — never cut at the chunk boundary', () => {
  const m = matcher('listening on port \\d+');
  assert.deepEqual(m.feed('listening on port 30'), [], 'nothing until the line is complete');
  const hits = m.feed('00\r\nnext line\r\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.match, 'listening on port 3000');
  assert.equal(hits[0]!.line, 'listening on port 3000');
  assert.deepEqual(m.feed('more\n'), [], 'text is never matched twice');
});

test('m2-10: patterns that match the empty string are refused (they would fire on every line)', () => {
  for (const p of ['x*', '(error)?', '^$', '']) refused(() => compileLinePattern(p));
  assert.doesNotThrow(() => compileLinePattern('x+'));
  // The reason fits the pattern: `^$` matches only an empty line, which the splitter never offers.
  assert.throws(() => compileLinePattern('x*'), /matches the empty string, so it would match every line/);
  assert.throws(() => compileLinePattern('^$'), /matches only an empty line, which is never offered/);
  assert.throws(() => compileLinePattern('^\\s*$'), /matches only an empty line/);
});

test('cleanLine applies overwrites on the raw text: a U+E000 in the output is text, not a backspace', () => {
  assert.equal(cleanLine('ab\uE000c'), 'ab\uE000c');
  assert.equal(cleanLine('\uE000x'), '\uE000x', 'a leading one stays too');
  assert.equal(cleanLine('ABCDE\rXY'), 'XYCDE');
  assert.equal(cleanLine('|\b/\b-\b\\'), '\\', 'a spinner reads its last frame');
  assert.equal(cleanLine('\x1b[31mred\x1b[0m\rX\x1b(B'), 'Xed', 'sequences are skipped, charset designations whole');
  assert.equal(cleanLine('a\x00b\x7fc\td'), 'abc\td', 'other controls go, a tab stays');
  assert.equal(cleanLine('😀\bx'), 'x', 'a backspace steps over a whole code point');
  assert.equal(cleanLine('text\r\r'), 'text');
});

test('cleanLine renders a line as the transcript does: erase in line and in-line cursor moves apply, everything else is dropped', () => {
  // The house's read of 78c4d6e (#22): a progress line cleared with ESC [ K read `Doneress: 100%`.
  assert.equal(cleanLine('Progress: 100%\r\x1b[KDone'), 'Done');
  assert.equal(cleanLine('Progress: 100%\r\x1b[0KDone'), 'Done', '0K is K');
  assert.equal(cleanLine('Progress: 100%\r\x1b[2KDone'), 'Done', '2K clears the whole row');
  assert.equal(cleanLine('abcdef\x1b[3DXY'), 'abcXYf', 'cursor back, then overwrite');
  assert.equal(cleanLine('abc\x1b[5Cz'), 'abc     z', 'cursor forward pads with blanks');
  assert.equal(cleanLine('abcdef\x1b[2Gz'), 'azcdef', 'cursor to a column (1-based)');
  assert.equal(cleanLine('abcdef\x1b[Gz'), 'zbcdef', 'to column 1 by default');
  assert.equal(cleanLine('abcdef\x1b[Dz'), 'abcdez', 'back one by default');
  assert.equal(cleanLine('x\x1b[1K\x1b[2Ky'), ' y', 'as the transcript shows it: 1K blanks through the cursor, 2K clears, y lands at column 1');
  assert.equal(cleanLine('abcdef\x1b[3D\x1b[K'), 'abc', 'erase to the end from the cursor');
  assert.equal(cleanLine('abcdef\x1b[3D\x1b[1K'), '    ef', 'erase to the start, the cursor cell included');
  assert.equal(cleanLine('\x9b3Dq'), 'q', 'the C1 CSI form too');
  // Moves that are not in-line, and every other sequence, are dropped without effect.
  assert.equal(cleanLine('ab\x1b[2Acd\x1b[?25l\x1b[1;1Hef'), 'abcdef');
  assert.equal(cleanLine(`a\x1b[${10 ** 9}Cb`).length <= 2 + 1024 + 1, true, 'a move far past the end pads a bounded number of cells');
});

test('cleanLine drops every escape sequence proper, including charset designations (`tput sgr0` is ESC ( B ESC [ m), and an unfinished one takes its payload with it', () => {
  assert.equal(cleanLine('\x1b[31merror: disk full\x1b(B\x1b[m'), 'error: disk full');
  assert.deepEqual(new StreamMatcher(compileLinePattern('disk full$')).feed('\x1b[31merror: disk full\x1b(B\x1b[m\n').map((h) => h.match), ['disk full']);
  // Two-byte escapes beyond the 0x40–0x5f range, and three-byte ones with an intermediate.
  assert.equal(cleanLine('a\x1b=b\x1b>c\x1b7d\x1b8e\x1bcf\x1b#8g\x1b%Gh\x1b)0i'), 'abcdefghi');
  assert.equal(cleanLine('\x1bM\x1bD\x1bE\x1bHx'), 'x');
  // CSI, OSC, DCS and the C1 CSI.
  assert.equal(cleanLine('\x1b[1;31mred\x1b]0;title\x07\x1bPq#0\x1b\\\x9b0mend'), 'redend');
  // A sequence left unfinished at the end: its payload is not text (the house's read of 78c4d6e, #22).
  assert.equal(cleanLine('ready\x1b]0;title'), 'ready');
  assert.equal(cleanLine('working \x1b[3'), 'working ');
  assert.equal(cleanLine('tail\x1b'), 'tail');
});

test('a watch reads a frame as it displays: backspaces, erases and cursor moves apply, and a lone CR still ends a frame', () => {
  // The house's read of 78c4d6e (#22): `ab\bc` was `abc` to a watch and `ac` to search, so /^ac$/ never fired.
  assert.deepEqual(matches('^ac$', ['ab\bc\n']), ['ac']);
  assert.deepEqual(matches('^Done$', ['Progress: 100%\r\x1b[KDone\n']), ['Done']);
  // Frames: a progress bar matches as it moves, where search would read the line's last state (`XYCDE`).
  assert.deepEqual(new LineSplitter().feed('ABCDE\rXY\n').map((l) => l.text), ['ABCDE', 'XY']);
  assert.deepEqual(matches('^XYCDE$', ['ABCDE\rXY\n']), []);
});

test('a line is matched on its head within the pattern’s match window, and a hit on a longer line says so', () => {
  const re = compileLinePattern(`${'.'.repeat(999)}0`);
  assert.equal(matchWindow(re), MIN_WINDOW);
  const m = new StreamMatcher(re);
  // The only match lies past the window: not seen (search would not see it either).
  assert.deepEqual(m.feed(`${'x'.repeat(1500)}0\n`), []);
  // A match within the window on a line longer than it: reported, marked clipped.
  const hits = m.feed(`${'x'.repeat(1023)}0${'y'.repeat(2000)}\n`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.clipped, true);
  assert.equal(hits[0]!.line.length, 3024, 'the whole line is still reported');
  assert.equal(m.feed(`${'x'.repeat(999)}0\n`)[0]!.clipped, undefined, 'a line within the window is not clipped');
  // The point of the window: a thousand-character pattern on a 64 KiB line costs a bounded match.
  const t0 = performance.now();
  assert.deepEqual(m.feed(`${'q'.repeat(MAX_LINE)}\n`), []);
  const ms = performance.now() - t0;
  assert.ok(ms < 2500, `took ${Math.round(ms)} ms`);
});

test('m2-5: every pattern runs on the linear-time engine — a nested quantifier cannot stall the daemon', () => {
  const t0 = Date.now();
  const m = matcher('(\\w+\\s?)+ready');
  // 48 characters took ~51 s before; a hundred words now take nothing.
  const line = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ') + ' !\n';
  assert.deepEqual(m.feed(line), []);
  assert.deepEqual(matches('(a+)+$', ['a'.repeat(5000) + 'b\n']), []);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  if (LINEAR_REGEX) refused(() => compileLinePattern('(a)\\1'));
  refused(() => compileLinePattern('(unclosed'));
});

test('m2-10: control sequences are stripped per line, even when a write splits one', () => {
  assert.deepEqual(matches('^ERROR: boom$', ['\x1b[3', '1mERROR: boom\x1b[0m\r\n']), ['ERROR: boom']);
  // CRLF split across writes is one line end; a lone CR (a progress bar) ends a line too.
  const m = matcher('^\\d+%$');
  assert.deepEqual([...m.feed('10%\r'), ...m.feed('\n20%\r30%\r')].map((h) => h.match), ['10%', '20%', '30%']);
});

test('m2-10: a prompt with no newline is matched after a quiet moment, once — not again when the line completes', async () => {
  const got: LineMatch[] = [];
  // A quiet period long against the sleeps between writes, so a loaded runner's late timer cannot fire it early.
  const quiet = 400;
  const m = matcher('Password: ?$', { onPartial: (h) => got.push(h), partialAfterMs: quiet });
  const t0 = performance.now();
  assert.deepEqual(m.feed('Password'), []);
  await sleep(50);
  assert.deepEqual(m.feed(': '), [], 'more output restarts the quiet period');
  const fed = performance.now();
  await sleep(50);
  if (performance.now() - fed < quiet) assert.equal(got.length, 0, 'nothing before the quiet period has passed');
  const deadline = Date.now() + 5000;
  while (got.length === 0 && Date.now() < deadline) await sleep(20);
  assert.equal(got.length, 1);
  assert.ok(performance.now() - fed >= quiet - 5, `fired ${Math.round(performance.now() - fed)} ms after the last write, quiet since ${Math.round(fed - t0)}`);
  assert.equal(got[0]!.line, 'Password: ');
  assert.deepEqual(m.feed('\r\n'), [], 'the completed line already produced its match');
  // Without onPartial, only terminated lines match.
  const plain = matcher('Password:');
  assert.deepEqual(plain.feed('Password: '), []);
  assert.deepEqual(plain.flush().map((h) => h.match), ['Password:'], 'flush completes the last line (its stream ended)');
  m.dispose();
});

test('m2-10: lines are bounded — a line longer than MAX_LINE is matched on its head only, the hit says clipped, and the rest is dropped', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.feed('x'.repeat(2.5 * MAX_LINE)), [], 'nothing comes out before the line ends');
  const [line, ...rest] = s.feed('\n');
  assert.deepEqual(rest, []);
  assert.equal(line!.text.length, MAX_LINE, 'its head is kept');
  assert.equal(line!.cut, true);
  assert.deepEqual(s.feed('next\n'), [{ text: 'next' }], 'the line after it is whole and not cut');
  const m = matcher('needle');
  const hits = m.feed('needle' + 'y'.repeat(3 * MAX_LINE) + '\n');
  assert.equal(hits.length, 1, 'one hit for one line, however long');
  assert.equal(hits[0]!.clipped, true);
  // The house's read of 78c4d6e (#22): matched in pieces, `^MATCH` hit on the second piece of a line that does not start with it.
  const long = 'x'.repeat(MAX_LINE) + 'MATCH\n';
  assert.deepEqual(matches('^MATCH', [long]), []);
  assert.deepEqual(matches('xMATCH', [long]), [], 'past the head: not seen, as search would not see it past the head it keeps');
  assert.deepEqual(matches('^x', [long]).length, 1);
  // The head is cut before a sequence the cut would split, so no half of one is read as text.
  const split = new LineSplitter();
  const head = 'a'.repeat(MAX_LINE - 2) + '\x1b[31mb'.repeat(2) + '\n';
  assert.equal(split.feed(head)[0]!.text, 'a'.repeat(MAX_LINE - 2));
});
