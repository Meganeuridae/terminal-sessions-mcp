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
import { Journal } from '../src/core/journal.js';
import { cleanLine } from '../src/core/ansi.js';
import { MemoryStore } from '../src/core/stores.js';
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
  // A line cleared with ESC [ K after the carriage return reads as the transcript shows it (the house's read of 78c4d6e, #22: it read `Doneress: 100%`).
  out(src.journal, 'Progress: 100%\r\x1b[KDone\r\n');
  assert.deepEqual(lines(await search(src, { pattern: 'Done', since: 0 })), ['Done']);
  assert.deepEqual(lines(await search(src, { pattern: 'Doneress', since: 0 })), [], 'the overwritten tail is gone');
});

test('er-5: stdout and stderr of a process Run are one source, as a read shows them, and its lines never mix with the terminal\'s; a match names its first character\'s pipe (the house\'s review of f3750e4..4f4c067, #22, comment 6315636412, question 4)', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, 'out-a ', 'stdout', 'r1');
  out(src.journal, 'err-a ', 'stderr', 'r1');
  out(src.journal, 'shell line\r\n');
  out(src.journal, 'out-b\n', 'stdout', 'r1');
  out(src.journal, 'err-b\n', 'stderr', 'r1');
  endRun(src.journal, 'r1');
  const r = await search(src, { pattern: '.', since: 0, context: 0 });
  assert.deepEqual(lines(r).sort(), ['err-b', 'out-a err-a out-b', 'shell line'], 'they were the lines `out-a out-b` and `err-a err-b`');
  const read = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  for (const l of lines(r)) assert.ok(read.text!.split('\n').includes(l), `${l} is a line of the read: ${JSON.stringify(read.text)}`);
  const by = (line: string) => r.matches.find((m) => m.line === line)!;
  assert.equal(by('out-a err-a out-b').stream, 'stdout');
  assert.equal(by('out-a err-a out-b').mixed, true);
  assert.equal(by('err-b').stream, 'stderr');
  assert.equal(by('err-b').mixed, undefined);
  assert.equal(by('shell line').stream, undefined, 'the terminal\'s lines name no pipe');
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
    for (let guard = 0; next.more; guard++) {
      assert.ok(guard < 100, 'the scan makes progress');
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

test('a LF a CSI executes ends a line, and the next line reads the CSI on: its rest is no text, wherever the events split it or a continuation starts (the house’s review of the 40 commits through f3750e4, #22, comment 6310921374)', async () => {
  const data = 'A\x1b[3\r\n1mB here\r\nnext\r\n';
  for (let cut = 0; cut < data.length; cut++) {
    const src = source();
    if (cut) out(src.journal, data.slice(0, cut));
    out(src.journal, data.slice(cut));
    const all = await search(src, { pattern: '.', since: 0, context: 0 });
    assert.deepEqual(lines(all), ['A', 'B here', 'next'], `split at ${cut}`);
  }
  // A continuation from the line's start, which lies inside the CSI, reads it as the scan did.
  const src = source();
  out(src.journal, data);
  const m = (await search(src, { pattern: '^B', since: 0 })).matches[0]!;
  assert.equal(m.offset, 6, 'the line begins after the LF, inside the CSI');
  const again = await search(src, { pattern: '.', since: m.cursor, offset: m.offset!, context: 0 });
  assert.deepEqual(lines(again), ['B here', 'next']);
  // A tail across another source's line, which the interleave puts after the LF inside the CSI, reads it as search does.
  const two = source();
  out(two.journal, 'A\x1b[3\r\n');
  startRun(two.journal, 'r1');
  out(two.journal, 'r1\n', 'stdout', 'r1');
  out(two.journal, '1mB here\r\n');
  for (const tail of [1, 2, 3]) assert.ok(!/1m/.test((await readJournal(two, { tail }, { resultBytes: 16384 })).text!), `tail ${tail}`);
  assert.deepEqual((await readJournal(two, { tail: 3 }, { resultBytes: 16384 })).text!.split('\n'), ['[terminal]', 'A', '[run r1]', 'r1', '[terminal]', 'B here']);
});

test('Cyrillic read as Latin-1 and written again is searchable: the DCS its `А` opens ends at its next character, as the emulator ends it, wherever the events split it (an independent read of the house’s fixes for #22)', async () => {
  const data = `${Buffer.from('Анна', 'utf8').toString('latin1')}\r\nline2\r\nline3\r\nline4\r\n`;
  for (let cut = 0; cut < data.length; cut++) {
    const src = source();
    if (cut) out(src.journal, data.slice(0, cut));
    out(src.journal, data.slice(cut));
    assert.deepEqual(lines(await search(src, { pattern: '^line3$', since: 0 })), ['line3'], `split at ${cut}`);
  }
});

test('one event holding a CSI with many line feeds is read back in time linear in it: a tail, a search and a page (an independent read of the house’s fixes for #22)', async () => {
  // Every reader asked each LF's head, read from the CSI's start: an 80 KB event took 15.5 s to tail, 7.8 s to search.
  const src = source();
  out(src.journal, `x\r\n\x1b[${'\n'.repeat(80 * 1024)}mdone\r\n`);
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const r = await f();
    assert.ok(performance.now() - t0 < 2000, `${name}: ${(performance.now() - t0).toFixed(0)} ms`);
    return r;
  };
  const tail = await timed('tail', () => readJournal(src, { tail: 5 }, { resultBytes: 16384 }));
  assert.ok(tail.text!.endsWith('done'));
  assert.equal((await timed('search', () => search(src, { pattern: '^done$', since: 0 }))).matches.length, 1);
  await timed('page', () => readJournal(src, { since: 0 }, { resultBytes: 16384 }));
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
    assert.ok(calls < 100, 'the scan makes progress');
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
  for (let guard = 0; r.more; guard++) {
    assert.ok(guard < 100, 'the scan makes progress');
    assert.equal(r.stoppedBy, 'limit');
    r = await search(src, { pattern: '^hit', runId: 'r1', limit: 7, context: 0, since: r.nextCursor!, ...(r.nextOffset ? { offset: r.nextOffset } : {}) });
    seen.push(...lines(r));
  }
  assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => `hit ${i}`));
});

test('jr2-10: the after-context of the last match is complete even when the next line is the match past the limit', async () => {
  const src = source();
  for (const l of ['m1', 'm2', 'x', 'y']) out(src.journal, `${l}\r\n`);
  const r = await search(src, { pattern: '^m', since: 0, limit: 1, context: 2 });
  assert.deepEqual(lines(r), ['m1']);
  assert.deepEqual(r.matches[0]!.after, ['m2', 'x'], 'two lines of after-context, as asked');
  assert.equal(r.more, true);
  assert.equal(r.stoppedBy, 'limit');
  // Continuing finds the match past the limit first, with its own context.
  const next = await search(src, { pattern: '^m', since: r.nextCursor!, ...(r.nextOffset ? { offset: r.nextOffset } : {}), limit: 1, context: 2 });
  assert.deepEqual(lines(next), ['m2']);
  assert.deepEqual(next.matches[0]!.after, ['x', 'y']);
  assert.equal(next.more, false);
  // The context lines read past the limit are never matches: `x` and `y` match nothing here, but a matching one would not count.
  const strict = await search(src, { pattern: '.', since: 0, limit: 1, context: 2 });
  assert.deepEqual(lines(strict), ['m1']);
  assert.deepEqual(strict.matches[0]!.after, ['m2', 'x']);
});

test('a context line cut by the raw bound is marked clipped on the match it belongs to', async () => {
  const src = source();
  // 300 KiB of colour codes, then text: the raw head kept for the line holds no text at all.
  out(src.journal, `${'\x1b[31m'.repeat(60_000)}text\r\nneedle\r\n`);
  const r = await search(src, { pattern: '^needle', since: 0, context: 1 });
  assert.equal(r.matches.length, 1);
  assert.deepEqual(r.matches[0]!.before, ['']);
  assert.equal(r.matches[0]!.clipped, true, 'the context line is not what it was');
  assert.equal(r.clippedLines, 1);
  // The raw cut leaves no half sequence to show as text.
  const h = source();
  out(h.journal, `${'\x1b[31m'.repeat(60_000)}\r\nneedle\r\n`);
  const r2 = await search(h, { pattern: '^needle', since: 0, context: 1 });
  assert.deepEqual(r2.matches[0]!.before, ['']);
});

// ───────────── the house's read of 1cabc6a (#22): where a scan stops ─────────────

const follow = async (src: ReturnType<typeof source>, o: Omit<SearchOptions, 'pattern'> & { pattern: string }, limits?: Parameters<typeof searchJournal>[2]) => {
  const all: SearchResult[] = [];
  let r = await searchJournal(src, o, limits);
  all.push(r);
  for (let guard = 0; r.more; guard++) {
    assert.ok(guard < 100, 'the scan makes progress');
    r = await searchJournal(src, { ...o, since: r.nextCursor!, ...(r.nextOffset ? { offset: r.nextOffset } : {}) }, limits);
    all.push(r);
  }
  return all;
};

test('1cabc6a 1: a scan at its limit whose unfinished last line is the next match says more, and continuing finds it', async () => {
  const src = source();
  for (let i = 0; i < 50; i++) out(src.journal, `hit ${i}\r\n`);
  out(src.journal, 'hit unfinished');
  const [first, next, ...rest] = await follow(src, { pattern: '^hit', since: 0, limit: 50 });
  assert.equal(first!.matches.length, 50);
  assert.equal(first!.stoppedBy, 'limit', 'the 51st match is in the unfinished last line');
  assert.deepEqual(lines(next!), ['hit unfinished']);
  assert.equal(rest.length, 0);
});

test('1cabc6a 2: a prompt without its newline before a Run\'s output neither hides the matches past the limit nor repeats any', async () => {
  // Open since the scan began (the cursor lies right before it), or begun after other events: either way it is
  // matched on what there is of it, and the scan continues at the match past the limit.
  for (const atCursor of [true, false]) {
    const src = source();
    startRun(src.journal, 'r1');
    const since = atCursor ? src.journal.lastSeq : 0;
    out(src.journal, 'prompt$ ');
    for (let k = 0; k < 3; k++) out(src.journal, Array.from({ length: 20 }, (_, i) => `hit ${k * 20 + i}\n`).join(''), 'stdout', 'r1');
    endRun(src.journal, 'r1');
    const calls = await follow(src, { pattern: 'hit|prompt', since, limit: 50, context: 0 });
    const seen = calls.flatMap(lines);
    const where = new Set(calls.flatMap((r) => r.matches.map((m) => `${m.cursor}:${m.offset ?? 0}`)));
    assert.equal(seen.length, 61, `${atCursor ? 'at the cursor' : 'after other events'}: ${seen.length} matches in ${calls.length} calls`);
    assert.equal(where.size, 61, 'no match reported twice');
    assert.equal(calls.length, 2);
    assert.ok(seen.includes('prompt$ '), 'the prompt line is matched on what there is of it');
  }
});

test('1cabc6a 2: a line longer than a whole scan is matched on each part scanned, and the scan still gets further', async () => {
  const src = source();
  // 1 KiB events, 100 per scan: the third scan's part of the line begins with NEEDLE (parts are matched on their head, rule 5).
  const line = `${'x'.repeat(204_800)}NEEDLE${'y'.repeat(100_000)}\r\n`;
  for (let i = 0; i < line.length; i += 1024) out(src.journal, line.slice(i, i + 1024));
  out(src.journal, 'after\r\n');
  const calls = await follow(src, { pattern: 'NEEDLE|after', since: 0, context: 0 }, { events: 100 });
  assert.equal(calls.length, 3, 'every scan gets further: 299 events, 100 a scan');
  assert.deepEqual(calls.flatMap(lines).map((l) => l.slice(0, 6)), ['NEEDLE', 'after'], 'the part beginning with NEEDLE once, and `after`');
  assert.equal(calls.at(-1)!.more, false);
});

test('1cabc6a 3: events lost while the scan ran are a hole: no line is joined across it, and the hole is reported', async () => {
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(256 * 1024) });
  // `LEFT-` is the last event of the first batch of 2,048; the line it begins goes on in the next.
  for (let i = 0; i < 2047; i++) out(j, `filler ${i}\r\n`);
  out(j, 'LEFT-');
  for (let i = 0; i < 1000; i++) out(j, `rest ${i}\r\n`);
  // The journal as the scan sees it: by its second fetch, a flood has evicted everything fetched so far and the rest.
  let fetches = 0;
  const seen = new Proxy(j, {
    get(target, prop) {
      if (prop === 'range') {
        return (...args: Parameters<Journal['range']>) => {
          if (++fetches === 2) for (let i = 0; i < 3000; i++) out(j, `${'x'.repeat(100)} new ${i}\r\n`);
          return target.range(...args);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const r = await searchJournal(source({ journal: seen }), { pattern: 'LEFT-\\S+', since: 0 }, { ms: 60_000 });
  assert.ok(fetches >= 2);
  assert.deepEqual(lines(r), [], 'LEFT- was never joined with a line after the hole');
  assert.equal(r.gap?.reason, 'retention');
  assert.equal(r.gap?.from, 2049, 'the hole begins where the second fetch did');
});

test('1cabc6a: the size budget counts UTF-8 bytes and stops with where to continue; a line past the match window is clipped and says so', async () => {
  const ascii = source();
  const euro = source();
  for (let i = 0; i < 100; i++) {
    out(ascii.journal, `${'a'.repeat(1200)}\r\n`);
    out(euro.journal, `${'€'.repeat(400)}\r\n`); // 1,200 bytes too
  }
  const a = await searchJournal(ascii, { pattern: 'zzz', since: 0 }, { bytes: 6000 });
  const e = await searchJournal(euro, { pattern: 'zzz', since: 0 }, { bytes: 6000 });
  assert.equal(a.stoppedBy, 'size');
  assert.equal(e.stoppedBy, 'size');
  assert.equal(e.scanned[1] - e.scanned[0], a.scanned[1] - a.scanned[0], 'the same bytes scanned whatever the characters');
  assert.ok(a.more && a.nextCursor !== undefined && a.nextCursor >= a.scanned[1]);
  const long = source();
  out(long.journal, `${'a'.repeat(300_000)}END\r\n`);
  out(long.journal, 'short aaa\r\n');
  const r = await search(long, { pattern: 'aaa', since: 0, context: 0 });
  assert.equal(r.matches.length, 2);
  assert.equal(r.clippedLines, 1);
  assert.equal(r.matches[0]!.clipped, true);
});

test('1cabc6a: without a cursor the recent window is scanned; a cursor older than retention names the hole at its start', async () => {
  const src = source();
  for (let i = 0; i < 100; i++) out(src.journal, `line ${i}\r\n`);
  const r = await search(src, { pattern: '^line 50$' });
  assert.equal(r.matches.length, 1);
  assert.equal(r.bounded, false);
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(64 * 1024) });
  for (let i = 0; i < 2000; i++) out(j, `${'x'.repeat(100)} ${i}\r\n`);
  const oldest = j.oldestSeq!;
  assert.ok(oldest > 1);
  const g = await search(source({ journal: j }), { pattern: 'zzz', since: 0 });
  assert.deepEqual(g.gap, { from: 1, to: oldest - 1, reason: 'retention', exact: true });
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
  // A loaded CI runner stalls the loop on its own (the house saw 1,034 ms): the bound is generous, the point is that it stays bounded.
  assert.ok(worst < 2500, `the event loop stalled for ${Math.round(worst)} ms`);
});

test('er-9: a pattern the linear-time engine refuses is invalid_argument, never run', async () => {
  const src = source();
  out(src.journal, 'x\r\n');
  await assert.rejects(search(src, { pattern: '(a)\\1', since: 0 }), (e: Error & { code?: string }) => e.code === 'invalid_argument');
});
