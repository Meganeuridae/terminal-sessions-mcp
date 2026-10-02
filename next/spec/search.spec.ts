/**
 * Search (§11 `search`, §6): lines rebuilt across event boundaries (er-5, m2-9),
 * match cursors that read from the matching line (er-6, ux-20), scans that page
 * and say where to continue (jr2-10, m2-25), holes reported (jr2-11), and a
 * caller's pattern bounded in time (er-9, atc-2, m2-5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { readJournal, searchJournal, type SearchOptions, type SearchResult } from '../src/api/reader.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { cleanLine } from '../src/core/search.js';
import { endRun, out, source, startRun } from './reader-fixture.spec.js';

const lines = (r: SearchResult) => r.matches.map((m) => m.line);
const search = (src: ReturnType<typeof source>, o: Omit<SearchOptions, 'pattern'> & { pattern: string }) => searchJournal(src, o);

// ───────────── er-5 / m2-9: lines are the same whatever the chunking ─────────────

test('er-5: a CRLF, an escape sequence or a long line split across events still makes one line', async () => {
  const src = source();
  out(src.journal, 'split crlf\r');
  out(src.journal, '\nnext\r\n');
  out(src.journal, '\x1b[3');
  out(src.journal, '1mERROR boom\x1b[0m\r\n');
  const json = JSON.stringify({ ts: 1, level: 'error', msg: 'x'.repeat(9000) });
  for (let i = 0; i < json.length; i += 1024) out(src.journal, json.slice(i, i + 1024));
  out(src.journal, '\r\n');
  assert.deepEqual(lines(await search(src, { pattern: '^split crlf$', since: 0 })), ['split crlf']);
  assert.deepEqual(lines(await search(src, { pattern: '^ERROR boom$', since: 0 })), ['ERROR boom']);
  const head = await search(src, { pattern: '^\\{"ts":1,"level":"error"', since: 0 });
  assert.equal(head.matches.length, 1, 'the head of a line that spans nine events is matched');
  assert.ok(head.matches[0]!.line.length <= 2001 && head.matches[0]!.clipped, 'a long line is shown cut, and says so');
});

test('m2-9: a program\'s CRLF through a PTY (CR CR LF) is searchable, and a progress bar reads as its last state', async () => {
  const src = source();
  out(src.journal, 'alpha\r\r\nbeta ERROR here\r\r\ngamma\r\r\n');
  out(src.journal, 'progress 10%\rprogress 100% ERROR\r\n');
  assert.deepEqual(lines(await search(src, { pattern: 'ERROR', since: 0 })), ['beta ERROR here', 'progress 100% ERROR']);
  assert.equal(cleanLine('text\r\r'), 'text');
});

test('er-5: stdout and stderr of a process Run are separate streams whose lines never mix, nor with the terminal\'s', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, 'out-a ', 'stdout', 'r1');
  out(src.journal, 'err-a ', 'stderr', 'r1');
  out(src.journal, 'shell line\r\n');
  out(src.journal, 'out-b\n', 'stdout', 'r1');
  out(src.journal, 'err-b\n', 'stderr', 'r1');
  endRun(src.journal, 'r1');
  const r = await search(src, { pattern: '.', since: 0, context: 0 });
  assert.deepEqual(lines(r).sort(), ['err-a err-b', 'out-a out-b', 'shell line']);
});

test('er-5: a real PTY `cat` of 5000 lines: every line is found, whatever the read boundaries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-search-'));
  const registry = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 10_000 });
  const A: Caller = { principal: 'agent:a@test', connectionId: 'ca' };
  try {
    const file = path.join(dir, 'rows.txt');
    fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `row-${i}-${'p'.repeat(i % 97)}-end\r\n`).join(''));
    const r = await app.run(A, { session: 'cat', command: `cat ${file}`, wait: 20_000 });
    assert.equal(r.state, 'exited');
    const s = await app.search(A, { session: 'cat', pattern: '^row-\\d+-p*-end$', runId: r.runId!, limit: 500 });
    let n = s.matches.length;
    let next = s;
    while (next.more) {
      next = await app.search(A, { session: 'cat', pattern: '^row-\\d+-p*-end$', runId: r.runId!, limit: 500, since: next.nextCursor!, ...(next.nextOffset ? { offset: next.nextOffset } : {}) });
      n += next.matches.length;
    }
    assert.equal(n, 5000);
  } finally {
    await registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── er-6 / ux-20: a match's cursor reads from its line ─────────────

test('er-6 / ux-20: read since=match.cursor (offset=match.offset) starts at the matching line, even inside a 64 KiB pipe read', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  let body = '';
  for (let i = 1; i <= 20_000; i++) body += i === 1000 ? 'ERROR: disk full at step 1000\n' : `step ${i}\n`;
  for (let i = 0; i < body.length; i += 65536) out(src.journal, body.slice(i, i + 65536), 'stdout', 'r1');
  endRun(src.journal, 'r1');
  const r = await search(src, { pattern: '^ERROR', runId: 'r1', context: 1 });
  const m = r.matches[0]!;
  assert.deepEqual(m.before, ['step 999']);
  assert.ok(m.offset !== undefined && m.offset > 0, 'the line starts inside the event');
  const read = await readJournal(src, { runId: 'r1', since: m.cursor, offset: m.offset! }, { resultBytes: 16384 });
  assert.equal(read.text!.split('\n')[0], 'ERROR: disk full at step 1000');
  // In the whole session's history too.
  const all = await search(src, { pattern: '^ERROR', since: 0 });
  const r2 = await readJournal(src, { since: all.matches[0]!.cursor, offset: all.matches[0]!.offset ?? 0 }, { resultBytes: 16384 });
  assert.equal(r2.text!.split('\n')[0], 'ERROR: disk full at step 1000');
});

// ───────────── jr2-10 / m2-25: a scan pages, and says so ─────────────

test('jr2-10 / m2-25: a scan that hits its budget says more, and continuing from nextCursor finds what lies beyond', async () => {
  const src = source();
  for (let i = 0; i < 6000; i++) out(src.journal, i === 5500 ? 'NEEDLE here\r\n' : `hay ${i}\r\n`);
  const first = await searchJournal(src, { pattern: 'NEEDLE', since: 0 }, { events: 1000 });
  assert.equal(first.matches.length, 0);
  assert.equal(first.more, true, 'the scan stopped early and says so');
  assert.equal(first.stoppedBy, 'size');
  assert.ok(first.nextCursor !== undefined && first.nextCursor >= first.scanned[1] - 1);
  let r = first;
  let found = 0;
  let calls = 1;
  while (r.more) {
    r = await searchJournal(src, { pattern: 'NEEDLE', since: r.nextCursor!, ...(r.nextOffset ? { offset: r.nextOffset } : {}) }, { events: 1000 });
    found += r.matches.length;
    calls++;
  }
  assert.equal(found, 1);
  assert.ok(calls >= 6, `${calls} calls`);
  // The time budget: a scan stops, having made progress, and resumes.
  const t = await searchJournal(src, { pattern: 'NEEDLE', since: 0 }, { ms: 0 });
  assert.equal(t.more, true);
  assert.equal(t.stoppedBy, 'time');
  assert.ok(t.nextCursor! >= 1);
});

test('jr2-10: the match limit stops the scan where the next match starts: continuing repeats nothing and skips nothing', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, Array.from({ length: 300 }, (_, i) => `hit ${i}\n`).join(''), 'stdout', 'r1'); // one event
  endRun(src.journal, 'r1');
  const seen: string[] = [];
  let r = await search(src, { pattern: '^hit', runId: 'r1', limit: 7, context: 0 });
  seen.push(...lines(r));
  while (r.more) {
    assert.equal(r.stoppedBy, 'limit');
    r = await search(src, { pattern: '^hit', runId: 'r1', limit: 7, context: 0, since: r.nextCursor!, ...(r.nextOffset ? { offset: r.nextOffset } : {}) });
    seen.push(...lines(r));
  }
  assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => `hit ${i}`));
});

test('jr2-10 / jr2-11: a scan reports the holes it spans: past retention at its start, and gap events inside', async () => {
  const src = source();
  out(src.journal, 'before hole\r\n');
  src.journal.append({ type: 'gap', from: 2, to: 2, reason: 'store-error' });
  out(src.journal, 'after hole\r\n');
  const r = await search(src, { pattern: 'hole', since: 0 });
  assert.deepEqual(r.gap, { from: 2, to: 2, reason: 'store-error' });
  assert.deepEqual(lines(r), ['before hole', 'after hole']);
  // A line is not joined across a hole.
  const h = source();
  out(h.journal, 'first half ');
  h.journal.append({ type: 'gap', from: 2, to: 2, reason: 'torn-write' });
  out(h.journal, 'second half\r\n');
  assert.deepEqual(lines(await search(h, { pattern: 'half', since: 0 })), ['first half ', 'second half']);
});

test('search without since scans a bounded recent window and says so', async () => {
  const src = source();
  for (let i = 0; i < 60_000; i++) out(src.journal, `line ${i}\r\n`);
  const r = await search(src, { pattern: '^line 0$' });
  assert.equal(r.bounded, true);
  assert.equal(r.matches.length, 0);
  assert.equal((await search(src, { pattern: '^line 0$', since: 0 })).matches.length, 1);
});

// ───────────── er-9 / atc-2 / m2-5: a pattern cannot stall the daemon ─────────────

test('er-9 / atc-2: catastrophic patterns over long lines finish quickly, and the event loop keeps turning', async () => {
  const src = source();
  for (let i = 0; i < 200; i++) out(src.journal, `${'a'.repeat(5000)}!\r\n${'hello world '.repeat(400)}!\r\n`);
  let ticks = 0;
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    ticks++;
  }, 5);
  try {
    for (const pattern of ['^(a+)+$', '^(\\w+\\s?)*$', '(\\w+\\s?){1,80}$', '(.*a){16}x']) {
      const t = performance.now();
      const r = await search(src, { pattern, since: 0 });
      assert.ok(performance.now() - t < 5000, `${pattern} took ${Math.round(performance.now() - t)} ms`);
      // A scan too slow to finish stops on its time budget and says where to go on.
      if (r.more) assert.equal(r.stoppedBy, 'time');
    }
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0);
  assert.ok(worst < 1000, `the event loop stalled for ${Math.round(worst)} ms`);
});

test('er-9: a pattern the linear-time engine refuses is invalid_argument, never run', async () => {
  const src = source();
  out(src.journal, 'x\r\n');
  await assert.rejects(search(src, { pattern: '(a)\\1', since: 0 }), (e: Error & { code?: string }) => e.code === 'invalid_argument');
});
