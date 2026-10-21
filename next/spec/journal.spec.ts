import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { clocks } from '../src/core/clock.js';
import { Journal } from '../src/core/journal.js';
import { FileStore, MemoryStore } from '../src/core/stores.js';
import { pageOutput } from '../src/core/runindex.js';
import type { JournalEvent } from '../src/core/types.js';

const out = (data: string) => ({ type: 'output', data, stream: 'pty' }) as const;

test('G10: seq is monotonic and events are typed and timestamped', () => {
  const j = new Journal({ now: () => 1234 });
  const a = j.append(out('a'));
  const b = j.append({ type: 'cwd', path: '/x' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.ts, 1234);
  assert.equal(j.lastSeq, 2);
});

test('G11: since(cursor) returns exactly the retained events after it', () => {
  const j = new Journal();
  for (let i = 0; i < 5; i++) j.append(out(`c${i}`));
  const r = j.since(2);
  assert.deepEqual(
    r.events.map((e) => e.seq),
    [3, 4, 5],
  );
  assert.equal(r.nextCursor, 5);
  assert.equal(r.gap, undefined);
  const none = j.since(5);
  assert.equal(none.events.length, 0);
  assert.equal(none.nextCursor, 5);
});

test('G11: reading past retention yields a visible gap', () => {
  const j = new Journal({ hot: new MemoryStore(400) });
  for (let i = 0; i < 20; i++) j.append(out('x'.repeat(50)));
  const oldest = j.oldestSeq!;
  assert.ok(oldest > 1, 'the ring must have dropped something');
  const r = j.since(0);
  assert.ok(r.gap, 'gap expected');
  assert.equal(r.gap!.from, 1);
  assert.equal(r.gap!.to, oldest - 1);
  assert.equal(r.events[0]!.seq, oldest);
});

test('limit reports more', () => {
  const j = new Journal();
  for (let i = 0; i < 5; i++) j.append(out('a'));
  const r = j.since(0, 2);
  assert.equal(r.events.length, 2);
  assert.equal(r.more, true);
  assert.equal(r.nextCursor, 2);
});

test('G19b: file store persists, rotates, and seq numbering resumes after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-journal-'));
  try {
    const cold = new FileStore(dir, { maxFileBytes: 300 });
    const j = new Journal({ cold });
    for (let i = 0; i < 12; i++) j.append(out(`line-${i}-${'p'.repeat(20)}`));
    cold.close();
    assert.ok(fs.readdirSync(dir).some((n) => /^journal\.\d+\.jsonl$/.test(n)), 'rotation expected');
    const cold2 = new FileStore(dir);
    const j2 = new Journal({ cold: cold2 });
    assert.equal(j2.lastSeq, 12, 'seq resumes');
    const all = cold2.read();
    assert.equal(all.length, 12);
    assert.equal(j2.append(out('after')).seq, 13);
    // Cold store serves reads the hot ring no longer has.
    const r = j2.since(0);
    assert.equal(r.events.length, 13);
    assert.equal(r.gap, undefined);
    cold2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file store drops files beyond maxBytes and reports a gap for what it dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-journal-'));
  try {
    const cold = new FileStore(dir, { maxFileBytes: 200, maxBytes: 400 });
    const j = new Journal({ hot: new MemoryStore(200), cold });
    for (let i = 0; i < 30; i++) j.append(out(`${i}-${'q'.repeat(30)}`));
    const r = j.since(0);
    assert.ok(r.gap, 'gap expected once both stores dropped the head');
    assert.equal(r.events[0]!.seq, r.gap!.to + 1);
    cold.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G19b/G20: a journal reopened with an empty hot ring reads its history from the cold store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-journal-'));
  try {
    const cold = new FileStore(dir);
    const j = new Journal({ cold });
    for (let i = 0; i < 5; i++) j.append(out(`c${i}`));
    cold.close();
    const reopened = new Journal({ cold: new FileStore(dir) });
    assert.equal(reopened.since(0).events.length, 5, 'history readable before anything new is appended');
    assert.equal(reopened.tail(2).length, 2);
    reopened.append(out('new'));
    assert.equal(reopened.since(0).events.length, 6);
    assert.equal(reopened.since(4).events.map((e) => e.seq).join(','), '5,6');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── journal robustness, retention and reads (jr-2, jr-9, jr-14, jr-19, jr-21, sec-9, G21) ─────────────

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-journal-'));
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const seqsOnDisk = (dir: string) =>
  fs
    .readdirSync(dir)
    .filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n))
    .sort((a, b) => (a === 'journal.jsonl' ? 1 : b === 'journal.jsonl' ? -1 : Number(a.split('.')[1]) - Number(b.split('.')[1])))
    .flatMap((n) => lines(path.join(dir, n)))
    .map((l) => JSON.parse(l) as { seq?: number })
    .filter((e) => typeof e.seq === 'number')
    .map((e) => e.seq!);

/** A cold store that refuses writes while `broken`, like a full disk. */
class FlakyStore extends MemoryStore {
  broken = true;
  override append(event: Parameters<MemoryStore['append']>[0]): void {
    if (this.broken) throw new Error('ENOSPC: no space left on device, write');
    super.append(event);
  }
}

test('jr-19/G13: an event appended inside a listener reaches every listener after the one that triggered it', () => {
  const j = new Journal();
  const seenB: number[] = [];
  const seenC: number[] = [];
  j.subscribe((e) => {
    if (e.type === 'run.end') {
      j.append({ type: 'note', text: 'watch fired', principal: 'system' });
      // A subscriber that joins mid-dispatch gets nothing it could already have read.
      j.subscribe((ev) => seenC.push(ev.seq));
    }
  });
  j.subscribe((e) => seenB.push(e.seq));
  j.append(out('x'));
  j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 });
  j.append(out('y'));
  assert.deepEqual(seenB, [1, 2, 3, 4], 'seq order at every listener');
  assert.deepEqual(seenC, [4], 'no duplicates for a late subscriber');
});

test('jr-21/G21: the memory ring bounds every event by its size, not just output', () => {
  const ring = new MemoryStore(1024 * 1024);
  const vars: Record<string, string> = {};
  for (let i = 0; i < 1000; i++) vars[`VAR_${i}`] = 'v'.repeat(1100);
  for (let i = 0; i < 50; i++) ring.append({ type: 'env.snapshot', count: Object.keys(vars).length, vars, seq: i + 1, ts: 0 });
  assert.equal(ring.read().length, 1, 'only the newest ~1.1 MB snapshot fits a 1 MiB ring');
  const ring2 = new MemoryStore(64 * 1024);
  for (let i = 0; i < 100; i++) ring2.append({ type: 'run.admit', runId: `r${i}`, target: 'shell', line: 'l'.repeat(4000), principal: 'p', origin: 'self', queued: false, seq: i + 1, ts: 0 });
  assert.ok(ring2.bytes() <= 64 * 1024, `bytes ${ring2.bytes()}`);
  assert.ok(ring2.read().length < 20, `retained ${ring2.read().length} 4 KB admits`);
});

test('jr-21: eviction is O(1) amortized once the ring is full of small events', () => {
  const ring = new MemoryStore(8 * 1024 * 1024);
  let seq = 0;
  for (let i = 0; i < 200_000; i++) ring.append({ type: 'output', data: 'a', stream: 'pty', seq: ++seq, ts: 0 });
  const t0 = performance.now();
  for (let i = 0; i < 200_000; i++) ring.append({ type: 'output', data: 'a', stream: 'pty', seq: ++seq, ts: 0 });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `200k appends with eviction took ${ms.toFixed(0)} ms`);
  const r = ring.read();
  assert.equal(r[r.length - 1]!.seq, seq);
  assert.equal(ring.oldestSeq(), r[0]!.seq);
  assert.deepEqual(ring.read(seq - 2).map((e) => e.seq), [seq - 2, seq - 1, seq]);
});

test('jr-9/G11: a torn last line is cut on open; the next append starts clean and no seq is reissued', () => {
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir) });
    for (let i = 0; i < 5; i++) j.append(out(`c${i}`));
    j.close();
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"type":"output","data":"half-writ');
    const j2 = new Journal({ cold: new FileStore(dir) });
    // The torn event was seq 6 and may have reached a subscriber: 6 is never reused, and a gap says so.
    assert.equal(j2.lastSeq, 7);
    const gap = j2.since(5).events[0]!;
    assert.equal(gap.type, 'gap');
    assert.deepEqual(gap.type === 'gap' && [gap.from, gap.to, gap.reason as string], [6, 6, 'torn-write']);
    assert.equal(gap.type === 'gap' && gap.exact, true, 'one event was being written: the count is exact');
    j2.append({ type: 'recovered', class: 'history-only' });
    j2.close();
    for (const l of lines(path.join(dir, 'journal.jsonl'))) JSON.parse(l); // every line parses
    const j3 = new Journal({ cold: new FileStore(dir) });
    assert.equal(j3.lastSeq, 8, 'nothing torn the second time');
    assert.deepEqual(j3.since(5).events.map((e) => `${e.seq}:${e.type}`), ['7:gap', '8:recovered']);
    assert.deepEqual(seqsOnDisk(dir), [1, 2, 3, 4, 5, 7, 8]);
    j3.close();
    // A torn rotation header lost no event: no seq is skipped for it.
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"header":{"v":1,"openRu');
    const j4 = new Journal({ cold: new FileStore(dir) });
    assert.equal(j4.lastSeq, 8);
    assert.equal(j4.append(out('next')).seq, 9);
    j4.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr-2/G19: a failing cold store never throws out of append; the ring carries on, stats report it, and the store catches up', () => {
  const cold = new FlakyStore();
  const j = new Journal({ cold });
  const seen: number[] = [];
  j.subscribe((e) => seen.push(e.seq));
  for (let i = 0; i < 5; i++) assert.doesNotThrow(() => j.append(out(`c${i}`)));
  assert.deepEqual(seen, [1, 2, 3, 4, 5], 'listeners still get every event');
  assert.match(j.stats().coldFailed ?? '', /ENOSPC/);
  assert.deepEqual(j.since(0).events.map((e) => e.seq), [1, 2, 3, 4, 5], 'reads served from the ring');
  cold.broken = false;
  assert.equal(j.retryCold(), true);
  assert.equal(j.stats().coldFailed, null);
  assert.deepEqual(cold.read().map((e) => e.seq), [1, 2, 3, 4, 5], 'the cold store caught up from the ring, in order');
  j.append(out('after'));
  assert.deepEqual(cold.read().map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
});

test('the cold store is tried again on the monotonic clock: a wall-clock step neither brings the retry on nor delays it', (t) => {
  // The retry deadline was on Date.now: a forward step retried at once, a backward one waited out the step (the
  // house's read of the 38 commits, #22, comment 6274935728, item 7).
  const realNow = Date.now.bind(Date);
  const realMono = clocks.monotonic;
  let wall = 0;
  let mono = 0;
  t.mock.method(Date, 'now', () => realNow() + wall);
  t.mock.method(clocks, 'monotonic', () => realMono() + mono);
  for (const step of [60 * 60_000, -60 * 60_000]) {
    wall = 0;
    const cold = new FlakyStore();
    const j = new Journal({ cold });
    j.append(out('refused')); // the first failure: retried after RETRY_MIN_MS (1 s) of the monotonic clock
    assert.match(j.stats().coldFailed ?? '', /ENOSPC/);
    cold.broken = false;
    wall = step;
    j.append(out('after the step'));
    assert.match(j.stats().coldFailed ?? '', /ENOSPC/, `a wall step of ${step} ms is not time passing: no retry yet`);
    mono += 1100;
    j.append(out('a second later'));
    assert.equal(j.stats().coldFailed, null, `retried once a second has passed, whatever the wall clock did (${step} ms)`);
    assert.deepEqual(cold.read().map((e) => e.seq), [1, 2, 3]);
    j.close();
  }
});

test('jr-2/G11: when the ring dropped part of what the disk refused, every read shows the stretch where it is, as the store-error gap the catch-up then records', () => {
  const cold = new FlakyStore();
  cold.broken = false;
  const j = new Journal({ hot: new MemoryStore(600), cold });
  for (let i = 0; i < 3; i++) j.append(out(`ok${i}`)); // 1..3 persisted
  cold.broken = true;
  for (let i = 0; i < 20; i++) j.append(out(`lost-or-kept-${i}-${'z'.repeat(40)}`)); // 4..23 only in the small ring
  const hotOldest = j.tail(1000).find((e) => e.seq > 3 && e.type === 'output')!.seq;
  assert.ok(hotOldest > 4, 'the ring dropped some of the unpersisted events');
  // The cold part ends at 3, the ring's begins at hotOldest: between them, the stretch's gap, seated at its end. A read
  // never joins the two across it, the tail included (the house's review of the 40 commits through f3750e4, PR #22,
  // comment 6310921374), and a read that begins inside it gets it whole, as it would the recorded gap.
  const hole = { type: 'gap', from: 4, to: hotOldest - 1, reason: 'store-error', exact: true, seq: hotOldest - 1 };
  const shape = (e: JournalEvent | undefined) => e && { type: e.type, ...(e.type === 'gap' ? { from: e.from, to: e.to, reason: e.reason, exact: e.exact } : {}), seq: e.seq };
  const all = j.since(0);
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3, hotOldest - 1, ...Array.from({ length: 24 - hotOldest }, (_, i) => hotOldest + i)]);
  assert.deepEqual(shape(all.events[3]), hole);
  assert.equal(all.more, false);
  assert.equal(all.gap, undefined, 'the hole is the event, not a retention hole');
  assert.deepEqual(shape(j.tail(1000)[3]), hole);
  assert.deepEqual(j.tail(1000).map((e) => e.seq), all.events.map((e) => e.seq), 'the tail is the same events');
  assert.deepEqual(shape(j.since(5).events[0]), hole);
  assert.deepEqual(j.range(4, hotOldest - 2).gap, { from: 4, to: hotOldest - 2, reason: 'store-error', exact: true }, 'a read wholly inside it names it');
  assert.deepEqual(j.since(0, 3).events.map((e) => e.seq), [1, 2, 3], 'limit counts it as one event');
  assert.deepEqual(j.since(0, 4).events.map((e) => e.seq), [1, 2, 3, hotOldest - 1]);
  cold.broken = false;
  assert.equal(j.retryCold(), true);
  const gap = cold.read().find((e) => e.type === 'gap');
  assert.ok(gap && gap.type === 'gap' && gap.from === 4 && gap.to === hotOldest - 1 && (gap.reason as string) === 'store-error', JSON.stringify(gap));
});

test('a Run whose output the ring dropped while the disk refused still reads as truncated once the catch-up has recorded the gap, past the Run\'s end', () => {
  // The catch-up writes the gap at the seq current then, after the Run ended: the Run's range held no
  // gap event, the hole between the stores had closed, and the output read as complete (the house's
  // read of cc8c909..39787b3, #22).
  const cold = new FlakyStore();
  cold.broken = false;
  const j = new Journal({ hot: new MemoryStore(600), cold, sessionId: 's' });
  j.append({ type: 'run.admit', runId: 'r1', target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
  const start = j.append({ type: 'run.start', runId: 'r1', cwd: '/' }).seq;
  cold.broken = true;
  for (let i = 0; i < 20; i++) j.append({ type: 'output', data: `lost-or-kept-${i}-${'z'.repeat(40)}`, stream: 'stdout', runId: 'r1' });
  const end = j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 }).seq;
  assert.equal(j.runs.output(j, 'r1').truncated, true, 'while the hole is open between the stores');
  cold.broken = false;
  assert.equal(j.retryCold(), true);
  const gap = j.since(end).events.find((e) => e.type === 'gap');
  assert.ok(gap && gap.type === 'gap' && gap.reason === 'store-error', JSON.stringify(gap));
  const o = j.runs.output(j, 'r1');
  assert.equal(o.truncated, true, 'the hole is recorded past the Run, and still cuts it');
  assert.deepEqual(o.gaps?.map((g) => [g.from, g.to, g.reason]), [[gap.from, gap.to, 'store-error']]);
  assert.equal(j.holeWithin(start, end), true);
});

test('a journal reopened over its files knows the gaps they hold: after a restart a Run is cut by a hole recorded after its end', () => {
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir), sessionId: 's' });
    j.append({ type: 'run.admit', runId: 'r1', target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'r1', cwd: '/' });
    const a = j.append({ type: 'output', data: 'a', stream: 'stdout', runId: 'r1' }).seq;
    const n1 = j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
    const n2 = j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
    const b = j.append({ type: 'output', data: 'b', stream: 'stdout', runId: 'r1' }).seq;
    j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 });
    j.append({ type: 'gap', from: n1, to: n2, reason: 'store-error' });
    j.close();
    const j2 = new Journal({ cold: new FileStore(dir), sessionId: 's' });
    assert.equal(j2.holeWithin(a, b), true, 'the one pass over the files took the gap in');
    const o = j2.runs.output(j2, 'r1');
    assert.equal(o.truncated, true);
    assert.deepEqual(o.gaps?.map((g) => [g.seq, g.from, g.to]), [[n2, n1, n2]]);
    assert.deepEqual([j2.runs.run('r1').state, j2.runs.run('r1').exit], ['exited', 0], 'the Runs are indexed as before');
    j2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr-2: a real disk refusal (read-only journal, then a refused rotation) keeps the journal alive and loses nothing once it heals', () => {
  if (process.getuid?.() === 0) return; // root ignores modes
  const dir = tmpDir();
  try {
    const cold = new FileStore(dir, { maxFileBytes: 2000 });
    const j = new Journal({ cold });
    for (let i = 0; i < 5; i++) j.append(out(`before-${i}`));
    cold.close();
    fs.chmodSync(path.join(dir, 'journal.jsonl'), 0o400);
    fs.chmodSync(dir, 0o500); // no rename either: rotation fails too
    for (let i = 0; i < 40; i++) assert.doesNotThrow(() => j.append(out(`during-${i}-${'d'.repeat(60)}`)));
    assert.match(j.stats().coldFailed ?? '', /EACCES|EPERM/);
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(path.join(dir, 'journal.jsonl'), 0o600);
    assert.equal(j.retryCold(), true, `still failing: ${j.stats().coldFailed}`);
    j.append(out('after'));
    j.close();
    const onDisk = seqsOnDisk(dir);
    assert.deepEqual(onDisk, Array.from({ length: 46 }, (_, i) => i + 1), 'every event, once, in order');
    assert.ok(fs.readdirSync(dir).some((n) => /^journal\.\d+\.jsonl$/.test(n)), 'the deferred rotation happened');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sec-9/G26: the store dir is 0700 and journal files 0600, including files an older build left 0644', () => {
  const dir = tmpDir();
  try {
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'journal.1.jsonl'), JSON.stringify({ type: 'cwd', path: '/', seq: 1, ts: Date.now() }) + '\n', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'journal.1.jsonl'), 0o644);
    const cold = new FileStore(dir);
    const j = new Journal({ cold });
    j.append(out('secret'));
    const mode = (f: string) => fs.statSync(f).mode & 0o777;
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(path.join(dir, 'journal.1.jsonl')), 0o600);
    assert.equal(mode(path.join(dir, 'journal.jsonl')), 0o600);
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G21: retention by bytes: the disk never holds more than maxBytes, and the oldest seq is exact and queryable', () => {
  const dir = tmpDir();
  try {
    const cold = new FileStore(dir, { maxBytes: 64 * 1024 });
    const j = new Journal({ hot: new MemoryStore(8 * 1024), cold });
    for (let i = 0; i < 4000; i++) {
      j.append(out(`${i}-${'b'.repeat(200)}`));
      const onDisk = fs.readdirSync(dir).reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0);
      assert.ok(onDisk <= 64 * 1024 + 400, `on disk ${onDisk} > maxBytes after ${i}`);
    }
    const firstOnDisk = seqsOnDisk(dir)[0]!;
    assert.equal(j.oldestSeq, firstOnDisk, 'oldestSeq is the first event on disk');
    const s = j.stats();
    assert.equal(s.oldestSeq, firstOnDisk);
    assert.equal(s.retention.maxBytes, 64 * 1024);
    assert.ok(s.coldBytes <= 64 * 1024 + 400);
    const r = j.since(0, 10);
    assert.deepEqual(r.gap && [r.gap.from, r.gap.to], [1, firstOnDisk - 1], 'a read from 0 names the oldest retained seq');
    assert.equal(r.events[0]!.seq, firstOnDisk);
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G21: retention by age: rotated files past maxAgeMs are dropped at rotation and at open, and the ring ages out too', () => {
  const dir = tmpDir();
  try {
    let now = 1_000_000;
    const clock = () => now;
    const day = 24 * 3600 * 1000;
    const cold = new FileStore(dir, { maxFileBytes: 1000, maxAgeMs: day, now: clock });
    const j = new Journal({ cold, hot: new MemoryStore(1 << 20, { maxAgeMs: day, now: clock }), now: clock });
    for (let i = 0; i < 30; i++) j.append(out(`old-${i}-${'o'.repeat(50)}`));
    const oldFiles = fs.readdirSync(dir).filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n)).length;
    assert.ok(oldFiles > 2);
    now += 2 * day;
    for (let i = 0; i < 20; i++) j.append(out(`new-${i}-${'n'.repeat(50)}`));
    // Age applies per file: every file whose newest event is past the cutoff is gone; the one
    // file that straddles the cutoff stays whole until its newest event ages out.
    const onDisk = seqsOnDisk(dir);
    assert.ok(onDisk[0]! > 20, `old files dropped at rotation (first on disk ${onDisk[0]})`);
    for (const n of fs.readdirSync(dir).filter((f) => /^journal\.\d+\.jsonl$/.test(f))) {
      const newest = JSON.parse(lines(path.join(dir, n)).pop()!) as { ts: number };
      assert.ok(newest.ts >= now - day, `${n} holds only aged-out events`);
    }
    assert.equal(j.oldestSeq, j.since(0).events[0]!.seq);
    assert.ok(j.since(0).gap, 'the aged-out range reads as a gap');
    j.close();
    // Everything rotated has aged out by the next open.
    now += 2 * day;
    const reopened = new FileStore(dir, { maxFileBytes: 1000, maxAgeMs: day, now: clock });
    assert.equal(fs.readdirSync(dir).filter((n) => /^journal\.\d+\.jsonl$/.test(n)).length, 0, 'rotated files pruned at open');
    assert.equal(reopened.lastSeq(), 50, 'the active file (and seq numbering) stays');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr-8/G20: a rotation header names the Runs still open, so a Run whose admission rotated out is still known', () => {
  const dir = tmpDir();
  try {
    const cold = new FileStore(dir, { maxFileBytes: 4096, maxBytes: 3 * 4096 });
    const j = new Journal({ cold, sessionId: 's' });
    j.append({ type: 'run.admit', runId: 'r1', target: 'shell', line: 'make flood', principal: 'agent:a', origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'r1', cwd: '/w', line: 'make flood' });
    j.append({ type: 'run.admit', runId: 'r2', target: 'shell', line: 'echo later', principal: 'agent:b', origin: 'self', queued: true });
    for (let i = 0; i < 400; i++) j.append({ ...out(`flood-${i}-${'f'.repeat(60)}`), runId: 'r1', attribution: 'temporal' });
    j.close();
    assert.ok(!seqsOnDisk(dir).includes(1), 'the admission rotated out of retention');
    const again = new Journal({ cold: new FileStore(dir, { maxFileBytes: 4096, maxBytes: 3 * 4096 }), sessionId: 's' });
    const open = again.runs.open().map((r) => [r.runId, r.state, r.principal, r.line, r.seq.admit]);
    assert.deepEqual(open, [
      ['r1', 'running', 'agent:a', 'make flood', 1],
      ['r2', 'queued', 'agent:b', 'echo later', 3],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr-14: a range read opens only the files it overlaps, bisects within them, and a tail starts from the newest file', () => {
  const dir = tmpDir();
  try {
    const w = new Journal({ cold: new FileStore(dir, { maxFileBytes: 64 * 1024, maxBytes: 1 << 30 }) });
    for (let i = 0; i < 20_000; i++) w.append(out(`${i}-${'r'.repeat(100 + (i % 37))}`));
    w.close();
    const cold = new FileStore(dir, { maxFileBytes: 64 * 1024, maxBytes: 1 << 30 });
    const j = new Journal({ cold });
    const total = cold.bytes();
    assert.ok(total > 2_000_000 && fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).length > 30);
    let before = cold.bytesRead;
    const recent = j.since(19_990);
    assert.deepEqual(recent.events.map((e) => e.seq), Array.from({ length: 10 }, (_, i) => 19_991 + i));
    assert.ok(cold.bytesRead - before < 3 * 64 * 1024, `since(last-10) read ${cold.bytesRead - before} of ${total} bytes`);
    before = cold.bytesRead;
    const mid = j.range(10_000, 10_004);
    assert.deepEqual(mid.events.map((e) => e.seq), [10_000, 10_001, 10_002, 10_003, 10_004]);
    assert.ok(cold.bytesRead - before < 3 * 64 * 1024, `range read ${cold.bytesRead - before} bytes`);
    before = cold.bytesRead;
    assert.deepEqual(j.tail(3).map((e) => e.seq), [19_998, 19_999, 20_000]);
    assert.ok(cold.bytesRead - before <= 64 * 1024, `tail read ${cold.bytesRead - before} bytes`);
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G11: bisected reads inside one large file return exactly the requested range', () => {
  const dir = tmpDir();
  try {
    const w = new Journal({ cold: new FileStore(dir, { maxFileBytes: 8 << 20, maxBytes: 1 << 30 }) });
    // Varied line lengths, including lines far longer than the bisection window and non-ASCII data.
    for (let i = 0; i < 6000; i++) w.append(out(i % 500 === 7 ? 'é'.repeat(40_000) : `${i}-${'x'.repeat(i % 300)}`));
    w.close();
    const cold = new FileStore(dir, { maxFileBytes: 8 << 20, maxBytes: 1 << 30 });
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')), ['journal.jsonl']);
    for (const [from, to] of [[1, 3], [6, 9], [2500, 2510], [5000, 5000], [5990, 6000], [3507, 3508]] as const) {
      assert.deepEqual(cold.read(from, to).map((e) => e.seq), Array.from({ length: to - from + 1 }, (_, i) => from + i), `read(${from}, ${to})`);
    }
    assert.deepEqual(cold.tail(4, 3508).map((e) => e.seq), [3505, 3506, 3507, 3508]);
    assert.deepEqual(cold.read(5998, undefined, 2).map((e) => e.seq), [5998, 5999]);
    // Bisection: a read near the end of an ~8 MB file touches a small part of it.
    const before = cold.bytesRead;
    assert.deepEqual(cold.read(5995, 5996).map((e) => e.seq), [5995, 5996]);
    assert.ok(cold.bytesRead - before < 1.5 * 1024 * 1024, `read ${cold.bytesRead - before} of ${cold.bytes()} bytes`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr-10: a closed journal refuses appends, stays readable, and releases its file', () => {
  const dir = tmpDir();
  try {
    const cold = new FileStore(dir);
    const j = new Journal({ cold });
    for (let i = 0; i < 3; i++) j.append(out(`c${i}`));
    j.seal();
    const late = j.append({ type: 'run.end', runId: 'r9', state: 'exited', exit: 0, durationMs: 5 });
    assert.equal(j.lastSeq, 3, 'no seq consumed');
    assert.equal(late.seq, 4, 'the refused event is not part of the journal');
    assert.equal(j.closed, true);
    assert.equal(j.stats().droppedAfterClose, 1);
    assert.deepEqual(seqsOnDisk(dir), [1, 2, 3]);
    assert.deepEqual(j.since(0).events.map((e) => e.seq), [1, 2, 3], 'history stays readable');
    assert.equal(j.stats().hotBytes, 0, 'the ring is released when the disk holds everything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr-2/jr-9: a write cut short by a full disk never leaves a torn line, even when the truncate and the first repair fail', () => {
  const dir = tmpDir();
  const cjs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const real = { writeSync: cjs.writeSync, ftruncateSync: cjs.ftruncateSync, openSync: cjs.openSync };
  const restore = () => {
    Object.assign(cjs, real);
    syncBuiltinESMExports();
  };
  try {
    const j = new Journal({ cold: new FileStore(dir) });
    for (let i = 0; i < 3; i++) j.append(out(`ok-${i}`));
    let failRepairs = 1;
    // Half the line reaches the disk, then ENOSPC; the truncate that would undo it fails too.
    (cjs as { writeSync: unknown }).writeSync = (fd: number, buf: Buffer, off: number, len: number) => {
      if (len > 8) return real.writeSync(fd, buf, off, Math.floor(len / 2));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    (cjs as { ftruncateSync: unknown }).ftruncateSync = () => {
      throw Object.assign(new Error('EIO: i/o error, ftruncate'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    assert.doesNotThrow(() => j.append(out('torn-by-enospc')));
    assert.match(j.stats().coldFailed ?? '', /ENOSPC/);
    restore();
    // The disk is back, but the first repair cannot open the file: the store must stay wary.
    (cjs as { openSync: unknown }).openSync = (p: string, flags: string, mode?: number) => {
      if (flags === 'r+' && failRepairs-- > 0) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return real.openSync(p, flags, mode);
    };
    syncBuiltinESMExports();
    assert.equal(j.retryCold(), false, 'the store refuses to write after an unrepaired tear');
    restore();
    assert.equal(j.retryCold(), true, `healed: ${j.stats().coldFailed}`);
    j.append(out('after'));
    j.close();
    for (const l of lines(path.join(dir, 'journal.jsonl'))) JSON.parse(l);
    assert.deepEqual(seqsOnDisk(dir), [1, 2, 3, 4, 5], 'every event once, no torn line');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── the house's read of b047b92 (#22) ─────────────

test('a refused high-water write changes nothing: the prune keeps the file whose newest seq it was to keep, and the next journal continues the numbering', () => {
  const dir = tmpDir();
  try {
    let now = 1_000_000;
    const store = new FileStore(dir, { maxAgeMs: 1000, now: () => now });
    const j = new Journal({ cold: store, now: () => now });
    for (let i = 0; i < 3; i++) j.append(out(`e${i}`));
    // The meta file's temp path is taken by a directory: its next write fails.
    const blocker = path.join(dir, `journal.meta.json.${process.pid}.tmp`);
    fs.mkdirSync(blocker);
    now += 5000;
    j.expire(now);
    assert.deepEqual(seqsOnDisk(dir), [1, 2, 3], 'the aged file stays: dropping it would lose the numbering');
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir, 'journal.meta.json'), 'utf8')) as { highWater?: number }).highWater, undefined, 'nothing claimed on disk');
    fs.rmdirSync(blocker);
    j.close();
    const j2 = new Journal({ cold: new FileStore(dir) });
    assert.equal(j2.append(out('next')).seq, 4);
    j2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a catch-up after the ring aged out entirely records the hole as a gap and numbers above it, in this journal and the next', () => {
  const dir = tmpDir();
  try {
    let now = 1_000_000;
    let allowed = true;
    const j = new Journal({ hot: new MemoryStore(1 << 20, { maxAgeMs: 1000, now: () => now }), cold: new FileStore(dir, { floor: { allow: () => allowed } }), now: () => now });
    const seen: number[] = [];
    j.subscribe((e) => seen.push(e.seq));
    j.append(out('kept'));
    allowed = false;
    for (let i = 0; i < 5; i++) j.append(out(`lost-${i}`));
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6], 'the listener had them');
    now += 5000;
    j.expire(now); // the ring drops every unwritten event
    allowed = true;
    assert.equal(j.retryCold(), true);
    const gaps = j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
    assert.deepEqual(gaps.map((g) => [g.seq, g.from, g.to, g.reason]), [[7, 2, 6, 'store-error']]);
    assert.equal(j.append(out('after')).seq, 8);
    assert.deepEqual(j.range(2, 6).events, [], 'the hole holds nothing');
    assert.deepEqual(j.range(2, 6).gap, { from: 2, to: 6, reason: 'store-error', exact: true }, 'and a read inside it says so, under the reason it was recorded with');
    j.close();
    const j2 = new Journal({ cold: new FileStore(dir) });
    assert.equal(j2.append(out('next life')).seq, 9, 'seqs the listener saw are never issued again');
    j2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a catch-up that fails partway keeps what the ring had dropped; the gap is written when it succeeds', () => {
  const dir = tmpDir();
  try {
    let allowed = true;
    let budget = Number.POSITIVE_INFINITY;
    const j = new Journal({ hot: new MemoryStore(700), cold: new FileStore(dir, { floor: { allow: () => allowed && budget-- > 0 } }) });
    j.append(out('kept'));
    allowed = false;
    for (let i = 0; i < 30; i++) j.append(out(`z${i}-${'z'.repeat(40)}`)); // the small ring drops most of them
    const oldestHeld = j.since(1).events.find((e) => e.type === 'output')!.seq;
    assert.ok(oldestHeld > 2, `the ring dropped seqs 2..${oldestHeld - 1}`);
    // The first catch-up writes two events and is refused again.
    allowed = true;
    budget = 2;
    assert.equal(j.retryCold(), false);
    assert.equal(seqsOnDisk(dir).length, 3, 'two caught up before the refusal');
    budget = Number.POSITIVE_INFINITY;
    assert.equal(j.retryCold(), true);
    const onDisk = seqsOnDisk(dir);
    const gaps = j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
    assert.deepEqual(gaps.map((g) => [g.from, g.to, g.reason]), [[2, oldestHeld - 1, 'store-error']], 'the hole the first attempt saw is still recorded');
    assert.deepEqual(onDisk, [1, ...Array.from({ length: 31 - oldestHeld + 1 }, (_, i) => oldestHeld + i), 32], 'the kept event, what the ring held, the gap');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a catch-up that wrote part of the ring and was refused again keeps the stretches apart: no gap claims the events the disk took between them', () => {
  // Kept as one stretch from the first seq lost to the last, the gap the catch-up recorded covered the two
  // events the first attempt wrote, and a read showed them inside their own hole.
  const dir = tmpDir();
  try {
    let allowed = true;
    let budget = Number.POSITIVE_INFINITY;
    const j = new Journal({ hot: new MemoryStore(700), cold: new FileStore(dir, { floor: { allow: () => allowed && budget-- > 0 } }) });
    j.append(out('kept'));
    allowed = false;
    for (let i = 0; i < 30; i++) j.append(out(`z${i}-${'z'.repeat(40)}`));
    const firstHeld = j.since(1).events.find((e) => e.type === 'output')!.seq;
    allowed = true;
    budget = 2;
    assert.equal(j.retryCold(), false, 'two caught up, then refused');
    allowed = false;
    for (let i = 0; i < 30; i++) j.append(out(`y${i}-${'y'.repeat(40)}`)); // the ring drops past the two the disk took
    const secondHeld = j.since(firstHeld + 1).events.find((e) => e.type === 'output')!.seq;
    assert.ok(secondHeld > firstHeld + 2);
    const open = j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
    assert.deepEqual(open.map((g) => [g.from, g.to, g.reason, g.exact]), [[2, firstHeld - 1, 'store-error', true], [firstHeld + 2, secondHeld - 1, 'store-error', true]], 'shown apart before the catch-up');
    assert.deepEqual(j.since(0).events.filter((e) => e.type === 'output').slice(0, 3).map((e) => e.seq), [1, firstHeld, firstHeld + 1], 'and the two the disk took read between them');
    allowed = true;
    budget = Number.POSITIVE_INFINITY;
    assert.equal(j.retryCold(), true);
    const recorded = j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
    assert.deepEqual(recorded.map((g) => [g.from, g.to, g.reason, g.exact]), [[2, firstHeld - 1, 'store-error', true], [firstHeld + 2, secondHeld - 1, 'store-error', true]], 'recorded apart');
    const onDisk = seqsOnDisk(dir);
    assert.ok(onDisk.includes(firstHeld) && onDisk.includes(firstHeld + 1), 'the two the first attempt wrote');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hole the journal opened with is recorded at the catch-up even when the ring dropped its gap before the disk took it, and reads show it meanwhile', () => {
  // The gap the constructor records goes to the ring alone while the disk refuses; once the ring dropped it, no event
  // recorded the hole, the catch-up wrote only the stretch after it, and the files jumped over it in silence.
  const cold = new FlakyStore(); // refusing from the start
  const j = new Journal({ hot: new MemoryStore(600), cold, startSeq: 10 }); // a new life: seqs 1–10 are the life before's, never written
  const opening = j.since(0).events[0]!;
  assert.deepEqual(opening.type === 'gap' && [opening.seq, opening.from, opening.to, opening.reason, opening.exact], [11, 1, 10, 'store-failed', true]);
  for (let i = 0; i < 20; i++) j.append(out(`z${i}-${'z'.repeat(40)}`)); // the small ring drops the opening gap and more
  const held = j.tail(1000).find((e) => e.type === 'output')!.seq;
  assert.ok(held > 12, 'the ring dropped the opening gap');
  const want = [
    [1, 10, 'store-failed', true],
    [11, held - 1, 'store-error', true],
  ];
  const gapsOf = (evs: JournalEvent[]) => evs.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap').map((g) => [g.from, g.to, g.reason, g.exact]);
  assert.deepEqual(gapsOf(j.since(0).events), want, 'each read shows both holes, not one taken for retention');
  assert.equal(j.since(0).gap, undefined);
  assert.deepEqual(gapsOf(j.tail(1000)), want);
  cold.broken = false;
  assert.equal(j.retryCold(), true);
  assert.deepEqual(gapsOf(cold.read()), want, 'the catch-up recorded both');
});

/** A file store that takes `budget.n` more appends, then refuses each as a full disk does. */
class Budgeted extends FileStore {
  constructor(dir: string, readonly budget: { n: number }) {
    super(dir);
  }
  override append(event: JournalEvent): void {
    if (this.budget.n-- <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    super.append(event);
  }
}

/** A journal over `cold` that lost two stretches apart: 4–18, then 21–38, a catch-up having written 19 and 20 between them. */
function lostTwice(cold: Budgeted): Journal {
  const j = new Journal({ hot: new MemoryStore(600), cold, sessionId: 's' });
  for (let i = 0; i < 3; i++) j.append(out(`ok${i}\n`));
  cold.budget.n = 0;
  for (let i = 0; i < 20; i++) j.append(out(`a-${i}-${'z'.repeat(40)}\n`));
  cold.budget.n = 2;
  j.retryCold();
  cold.budget.n = 0;
  for (let i = 0; i < 20; i++) j.append(out(`b-${i}-${'z'.repeat(40)}\n`));
  return j;
}
const holesOf = (evs: JournalEvent[]) => evs.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap').map((g) => [g.from, g.to, g.reason, g.exact]);

test('a new life takes over the stretches the life before it lost below the files\' last seq, shows them, and records them', () => {
  // Its own hole starts above the files' last seq: a stretch the life before lost below it, after a catch-up that
  // failed partway, was forgotten. since(0) read 3 then 19, holeWithin(5, 10) said no, and after the heal and a
  // restart nothing recorded 4–18 (an independent read of the fixes for the review of f3750e4, PR #22).
  const dir = tmpDir();
  try {
    const cold = new Budgeted(dir, { n: Number.POSITIVE_INFINITY });
    const old = lostTwice(cold);
    assert.deepEqual(holesOf(old.since(0).events), [[4, 18, 'store-error', true], [21, 38, 'store-error', true]]);
    old.seal();
    old.retryCold(); // the registry's one more try: still refused
    const life = new Journal({ hot: new MemoryStore(600), cold, sessionId: 's', startSeq: old.lastSeq, runs: old.runs, lost: old.unrecorded() });
    assert.deepEqual(holesOf(life.since(0).events), [[4, 18, 'store-error', true], [21, old.lastSeq, 'store-failed', true]]);
    assert.equal(life.holeWithin(5, 10), true);
    assert.deepEqual(life.range(5, 10).gap, { from: 5, to: 10, reason: 'store-error', exact: true });
    assert.equal(life.gapAt(5, 10), true);
    cold.budget.n = Number.POSITIVE_INFINITY;
    assert.equal(life.retryCold(), true);
    life.close();
    const later = new Journal({ cold: new FileStore(dir) });
    assert.deepEqual(holesOf(later.since(0).events), [[21, old.lastSeq, 'store-failed', true], [4, 18, 'store-error', true]], 'both recorded, in the order the new life wrote them');
    later.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a start after a daemon crash while the disk refused records a jump in the files\' seqs that no gap covers, every seq of it issued; a start over a healthy store reads no file for it', () => {
  // Seqs are dense: a file that holds 3 then 19 lost 4–18. Nothing else records the stretch when the daemon died
  // with it in memory (an independent read of the fixes for the review of f3750e4, PR #22, its question 2).
  const dir = tmpDir();
  try {
    const cold = new Budgeted(dir, { n: Number.POSITIVE_INFINITY });
    const died = lostTwice(cold); // no seal: the daemon dies
    assert.equal(cold.highWater()?.reservation?.failed, true);
    const again = new Journal({ cold: new FileStore(dir) });
    const holes = holesOf(again.since(0).events);
    assert.deepEqual(holes[0], [21, holes[0]![1], 'store-failed', undefined], 'the hole above the files, up to the reservation');
    assert.deepEqual(holes.slice(1), [[4, 18, 'store-error', true]], 'and the jump inside them, recorded at once');
    assert.ok((holes[0]![1] as number) >= died.lastSeq);
    again.close();
    // A store whose reservation is not marked failed holds no jump that went unrecorded: its start reads no event.
    class Reads extends FileStore {
      reads = 0;
      override read(from?: number, to?: number, limit?: number): JournalEvent[] {
        this.reads++;
        return super.read(from, to, limit);
      }
    }
    const store = new Reads(dir);
    const healthy = new Journal({ cold: store });
    assert.equal(store.reads, 0);
    healthy.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lost stretches stay in seq order when two refused gaps of a catch-up are dropped in separate calls, so the catch-up records them in order and the stretch after them stays one', () => {
  // The second gap's hole came after a stretch added between the two drops (an independent read of the fixes for the review of f3750e4, PR #22).
  let budget = Number.POSITIVE_INFINITY;
  class Budget extends MemoryStore {
    override append(e: JournalEvent): void {
      if (budget-- <= 0) throw new Error('ENOSPC: no space left on device, write');
      super.append(e);
    }
  }
  const cold = new Budget();
  const j = new Journal({ hot: new MemoryStore(1200), cold });
  j.append(out('kept\n'));
  budget = 0;
  for (let i = 0; i < 20; i++) j.append(out(`a-${i}-${'z'.repeat(40)}\n`));
  budget = 2;
  j.retryCold();
  budget = 0;
  for (let i = 0; i < 20; i++) j.append(out(`b-${i}-${'z'.repeat(40)}\n`));
  // The catch-up writes what the ring holds, then the disk refuses its two gaps.
  budget = j.tail(1000).filter((e) => e.type === 'output' && e.seq > cold.lastSeq()!).length;
  j.retryCold();
  const refused = j.tail(1000).filter((e) => e.type === 'gap' && e.seq > cold.lastSeq()!).map((e) => e.seq);
  assert.equal(refused.length, 2, 'two refused gaps in the ring');
  // The refused gap event itself, not a read-time gap a lost stretch shows, which is seated at its own last seq.
  const holds = (seq: number) => j.tail(1000).some((e) => e.seq === seq && e.type === 'gap' && e.to < e.seq);
  let separately = false;
  for (let n = 0; n < 200 && holds(refused[1]!); n++) {
    j.append(out('x'));
    if (!holds(refused[0]!) && holds(refused[1]!)) separately = true;
  }
  assert.ok(separately, 'the ring dropped the first gap before the second');
  budget = Number.POSITIVE_INFINITY;
  assert.equal(j.retryCold(), true);
  const recorded = cold.read().filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap' && e.seq > refused[1]!);
  const froms = recorded.map((g) => g.from);
  assert.deepEqual(froms, [...froms].sort((a, b) => a - b), `recorded in order: ${JSON.stringify(recorded.map((g) => [g.from, g.to]))}`);
  assert.equal(recorded.filter((g) => g.from >= refused[0]!).length, 1, 'the stretch from the first refused gap on is one');
});

test('a rotation header the disk refused is written before the new file’s first event, so the open Run survives retention', () => {
  const dir = tmpDir();
  const cjs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const realWrite = cjs.writeSync;
  const restore = () => {
    cjs.writeSync = realWrite;
    syncBuiltinESMExports();
  };
  try {
    const j = new Journal({ cold: new FileStore(dir, { maxFileBytes: 4096 }) });
    j.append({ type: 'run.admit', runId: 'r1', target: 'process', principal: 'agent:a@t', origin: 'self', queued: false, argv: ['/bin/sh'] });
    j.append({ type: 'run.start', runId: 'r1', cwd: '/w', pid: 424242, pgid: 424242 });
    // Refuse exactly the header's write at the rotation.
    let refused = 0;
    cjs.writeSync = ((fd: number, buf: Buffer | string, ...rest: unknown[]) => {
      if (Buffer.isBuffer(buf) && buf.subarray(0, 10).toString() === '{"header":') {
        refused++;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return (realWrite as unknown as (...a: unknown[]) => number)(fd, buf, ...rest);
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    for (let i = 0; i < 60; i++) j.append({ type: 'output', data: 'x'.repeat(100), stream: 'stdout', runId: 'r1' });
    assert.equal(refused, 1, 'the header write was refused once');
    restore();
    assert.equal(j.retryCold(), true);
    j.append(out('after'));
    const first = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n')[0]!;
    assert.ok(first.startsWith('{"header":'), `the new file begins with the header: ${first.slice(0, 40)}`);
    assert.match(first, /"r1"/);
    j.close();
    // Retention takes the rotated file: the Run is still known, with its group.
    for (const f of fs.readdirSync(dir)) if (/^journal\.\d+\.jsonl$/.test(f)) fs.rmSync(path.join(dir, f));
    const j2 = new Journal({ cold: new FileStore(dir) });
    const r1 = j2.runs.get('r1');
    assert.deepEqual([r1?.target, r1?.pgid, r1?.state], ['process', 424242, 'running']);
    j2.close();
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run.end that rotates the store leaves a header naming its Run in the new file (the index is fed after the write)', () => {
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir, { maxFileBytes: 4096 }) });
    j.append({ type: 'run.admit', runId: 'r1', target: 'process', principal: 'agent:a@t', origin: 'self', queued: false, argv: ['/bin/sh'] });
    j.append({ type: 'run.start', runId: 'r1', cwd: '/w', pid: 4242, pgid: 4242 });
    const files = () => fs.readdirSync(dir).filter((f) => /^journal\.\d+\.jsonl$/.test(f)).length;
    while (files() === 0) j.append({ type: 'output', data: 'x'.repeat(100), stream: 'stdout', runId: 'r1' });
    // Fill the new active file to just under the limit, then end the Run with an event that rotates.
    let size = fs.statSync(path.join(dir, 'journal.jsonl')).size;
    while (size < 4096 - 150) {
      j.append({ type: 'output', data: 'y'.repeat(100), stream: 'stdout', runId: 'r1' });
      size = fs.statSync(path.join(dir, 'journal.jsonl')).size;
    }
    const before = files();
    j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 5 + 'z'.repeat(200).length, reason: 'z'.repeat(200) });
    assert.equal(files(), before + 1, 'the run.end rotated the store');
    const first = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n')[0]!;
    assert.ok(first.startsWith('{"header":') && /"r1"/.test(first), `the new file names the Run it ends: ${first.slice(0, 60)}`);
    j.close();
    for (const f of fs.readdirSync(dir)) if (/^journal\.\d+\.jsonl$/.test(f)) fs.rmSync(path.join(dir, f));
    const j2 = new Journal({ cold: new FileStore(dir) });
    const r1 = j2.runs.get('r1');
    assert.deepEqual([r1?.target, r1?.pgid, r1?.state, r1?.exit], ['process', 4242, 'exited', 0], 'known whole from the header and its end');
    j2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Run whose output lost a middle stretch to the ring reads as truncated', () => {
  const dir = tmpDir();
  try {
    let allowed = true;
    const j = new Journal({ hot: new MemoryStore(1500), cold: new FileStore(dir, { floor: { allow: () => allowed } }) });
    const admit = j.append({ type: 'run.admit', runId: 'r1', target: 'process', principal: 'agent:a@t', origin: 'self', queued: false, argv: ['/bin/sh'] });
    j.append({ type: 'run.start', runId: 'r1', cwd: '/w' });
    for (let i = 0; i < 5; i++) j.append({ type: 'output', data: `early-${i}`, stream: 'stdout', runId: 'r1' });
    allowed = false;
    for (let i = 0; i < 40; i++) j.append({ type: 'output', data: `middle-${i}-${'m'.repeat(40)}`, stream: 'stdout', runId: 'r1' });
    allowed = true;
    assert.equal(j.retryCold(), true, 'caught up, with a gap for what the ring dropped');
    const end = j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 });
    assert.ok(j.since(0).events.some((e) => e.type === 'gap' && e.reason === 'store-error'));
    const output = pageOutput(j, 'r1', admit.seq, end.seq);
    assert.ok(output.events.length < 45 && output.events.length > 5, `some of the Run's output is gone: ${output.events.length} events`);
    assert.equal(output.truncated, true, 'and the result says so');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a header torn within its first bytes is a torn header, not a torn event: no gap, no seq skipped', () => {
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir) });
    j.append(out('a'));
    j.append(out('b'));
    j.close();
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"hea');
    const j2 = new Journal({ cold: new FileStore(dir) });
    assert.equal(j2.lastSeq, 2);
    assert.equal(j2.append(out('c')).seq, 3);
    assert.deepEqual(j2.since(0).events.filter((e) => e.type === 'gap'), []);
    j2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
