/**
 * Line matching for watches, wait_for and service probes (StreamMatcher,
 * LineSplitter): patterns mean what they mean in `search` — per line, anchors at
 * the line's ends — whatever the chunking, each line matched once, prompts seen
 * after a quiet moment, and every pattern on the linear-time engine (m2-10, m2-5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLinePattern, LineSplitter, MAX_LINE, StreamMatcher, type LineMatch } from '../src/core/ansi.js';
import { LINEAR_REGEX } from '../src/core/regex.js';
import { TermError } from '../src/core/errors.js';

const matcher = (pattern: string, opts?: ConstructorParameters<typeof StreamMatcher>[1]) => new StreamMatcher(compileLinePattern(pattern), opts);
const matches = (pattern: string, chunks: string[]) => {
  const m = matcher(pattern);
  return chunks.flatMap((c) => m.feed(c)).map((h) => h.match);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  const m = matcher('Password: ?$', { onPartial: (h) => got.push(h), partialAfterMs: 40 });
  assert.deepEqual(m.feed('Password'), []);
  await sleep(20);
  assert.deepEqual(m.feed(': '), [], 'more output restarts the quiet period');
  await sleep(20);
  assert.equal(got.length, 0);
  await sleep(60);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.line, 'Password: ');
  assert.deepEqual(m.feed('\r\n'), [], 'the completed line already produced its match');
  // Without onPartial, only terminated lines match.
  const plain = matcher('Password:');
  assert.deepEqual(plain.feed('Password: '), []);
  assert.deepEqual(plain.flush().map((h) => h.match), ['Password:'], 'flush completes the last line (its stream ended)');
  m.dispose();
});

test('m2-10: lines are bounded — a line longer than MAX_LINE is matched in pieces, holding no more than that', () => {
  const s = new LineSplitter();
  const pieces = s.feed('x'.repeat(2.5 * MAX_LINE));
  assert.deepEqual(pieces.map((p) => p.length), [MAX_LINE, MAX_LINE]);
  assert.deepEqual(s.feed('\n').map((p) => p.length), [MAX_LINE / 2]);
  const m = matcher('needle');
  assert.equal(m.feed('needle' + 'y'.repeat(3 * MAX_LINE) + '\n').length, 1, 'the piece holding the match reports it, the others nothing');
});
