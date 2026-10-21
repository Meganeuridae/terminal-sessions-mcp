/**
 * The run index (G1, G12, G20): what it reconstructs from run lifecycle events,
 * and a Run's output read by range. `RunIndex.output(journal, runId, range)`
 * must equal `narrowOutput` applied to the whole output — the reference
 * semantics — while reading only what the range asks for (jr2-9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Journal } from '../src/core/journal.js';
import { boundHeader, narrowOutput, RunIndex, type RunOutput, type RunOutputRange } from '../src/core/runindex.js';
import { FileStore, MemoryStore } from '../src/core/stores.js';
import type { EventInput, JournalEvent, RunInfo } from '../src/core/types.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-runindex-'));

/** A small deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('item 11/er-4/jr2-4: the index reconstructs a Run\'s geometry and process group from run.start', () => {
  const idx = new RunIndex('s');
  const ev = (e: EventInput, seq: number): JournalEvent => ({ ...e, seq, ts: 1000 + seq }) as JournalEvent;
  idx.feed(ev({ type: 'run.admit', runId: 'r1', target: 'process', line: 'make', principal: 'p', origin: 'self', queued: false, idem: 'k1' }, 1));
  idx.feed(ev({ type: 'run.start', runId: 'r1', cwd: '/w', envBasis: 'configured', cols: 91, rows: 27, pid: 4242, pgid: 4242 }, 2));
  const r = idx.run('r1');
  assert.deepEqual([r.cols, r.rows, r.pid, r.pgid, r.idem, r.state], [91, 27, 4242, 4242, 'k1', 'running']);
  // And they survive a rotation header, which is how recovery knows a Run whose admission rotated out.
  const again = new RunIndex('s');
  again.absorbHeader(idx.header());
  assert.deepEqual([again.run('r1').cols, again.run('r1').pgid], [91, 4242]);
});

test('jr2-8: boundHeader shortens long lines, then leaves out the oldest Runs, and fits the budget', () => {
  const run = (i: number, line: string): RunInfo => ({ runId: `r${i}`, sessionId: 's', target: 'shell', origin: 'self', principal: 'p', state: 'queued', line, admittedAt: i, seq: { admit: i }, attribution: 'temporal' });
  const small = { v: 1 as const, openRuns: [run(1, 'echo a'), run(2, 'echo b')] };
  assert.equal(boundHeader(small, 10_000), small, 'within budget: unchanged');
  const long = boundHeader({ v: 1, openRuns: [run(1, 'x'.repeat(50_000))] }, 4096);
  assert.equal(long.openRuns.length, 1);
  assert.ok(long.openRuns[0]!.line!.length <= 513 && long.openRuns[0]!.line!.endsWith('…'));
  const many = boundHeader({ v: 1, openRuns: Array.from({ length: 100 }, (_, i) => run(i, `echo ${i}`)) }, 2048);
  assert.ok(Buffer.byteLength(JSON.stringify({ header: many })) + 1 <= 2048);
  assert.equal(many.openRuns[many.openRuns.length - 1]!.runId, 'r99', 'the newest Runs stay');
  assert.ok(many.openRuns.length < 100);
});

/**
 * A journal of interleaved Runs over a small file store and ring, so reads cross
 * files, the ring's edge and retention: three concurrent process Runs, shell Runs
 * one after another, other events between them, some Runs still open.
 */
function build(dir: string, seed: number, events: number): Journal {
  const rand = rng(seed);
  const j = new Journal({ hot: new MemoryStore(24 * 1024), cold: new FileStore(dir, { maxFileBytes: 8 * 1024, maxBytes: 160 * 1024 }), sessionId: 's' });
  const open: string[] = [];
  let n = 0;
  const start = (target: 'shell' | 'process') => {
    const runId = `r${++n}-${seed}`;
    j.append({ type: 'run.admit', runId, target, line: `cmd ${n}`, principal: 'p', origin: 'self', queued: false });
    j.append({ type: 'run.start', runId, cwd: '/w', ...(target === 'process' ? { envBasis: 'configured' as const } : {}) });
    open.push(runId);
  };
  for (let i = 0; i < 3; i++) start('process');
  for (let i = 0; i < events; i++) {
    const x = rand();
    if (x < 0.02 && open.length > 1) {
      const runId = open.splice(Math.floor(rand() * open.length), 1)[0]!;
      j.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 1 });
    } else if (x < 0.04) start(rand() < 0.5 ? 'shell' : 'process');
    else if (x < 0.1) j.append({ type: 'cwd', path: `/w/${i}` });
    else {
      const runId = open.length && rand() < 0.9 ? open[Math.floor(rand() * open.length)] : undefined;
      const size = 1 + Math.floor(rand() * rand() * 700);
      j.append({ type: 'output', data: `${i}:${'o'.repeat(size)}\n`, stream: 'stdout', ...(runId ? { runId, attribution: 'exact' as const } : {}) });
    }
  }
  return j;
}

test('a Run’s output says `older` when output came before what it returns — a maxBytes cut — and not for a hole inside it, which `truncated` says (our read of the house’s fixes for its review of f3750e4, PR #22)', () => {
  const j = new Journal({ sessionId: 's' });
  j.append({ type: 'run.admit', runId: 'r1', target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
  j.append({ type: 'run.start', runId: 'r1', cwd: '/' });
  j.append({ type: 'output', data: 'one\n', stream: 'stdout', runId: 'r1' });
  j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 1, reason: 'store-error' });
  j.append({ type: 'output', data: 'two\n', stream: 'stdout', runId: 'r1' });
  const all = j.runs.output(j, 'r1');
  assert.deepEqual([all.truncated, all.older], [true, undefined], 'a hole inside: truncated, not older');
  const last = j.runs.output(j, 'r1', { maxBytes: 4 });
  assert.deepEqual([last.events.length, last.older], [1, true], 'the newest part: older output came before it');
});

test('jr2-9: RunIndex.output(range) equals narrowOutput(whole output, range) — random ranges over rotation and retention', () => {
  const dir = tmpDir();
  try {
    for (const seed of [1, 7, 42]) {
      const sub = path.join(dir, String(seed));
      const j = build(sub, seed, 3000);
      assert.ok(j.oldestSeq! > 1, 'retention cut the head');
      assert.ok(fs.readdirSync(sub).filter((f) => /^journal\.\d+\.jsonl$/.test(f)).length > 3, 'several files');
      const rand = rng(seed * 1000 + 1);
      const runs = j.runs.list();
      let checked = 0;
      for (const r of runs) {
        const whole = j.runs.output(j, r.runId);
        // The whole output is what a plain range read attributes to the Run.
        const from = r.seq.start ?? r.seq.admit;
        const to = r.seq.end ?? j.lastSeq;
        const full = j.range(from, to);
        // Retention took the Run's start: older output existed (`older`), as a hole inside it does not say.
        const expected: RunOutput = { events: full.events.filter((e) => e.type === 'output' && e.runId === r.runId), from, to, truncated: full.gap !== undefined };
        if (j.gapAt(from, to)) expected.older = true;
        assert.deepEqual(whole, expected, `${r.runId} whole`);
        for (let k = 0; k < 25; k++) {
          const span = to - from + 10;
          const pick = () => from - 5 + Math.floor(rand() * span);
          const range: RunOutputRange = {};
          if (rand() < 0.5) range.since = pick();
          if (rand() < 0.4) range.until = pick();
          if (rand() < 0.4) range.limit = Math.floor(rand() * 12);
          if (rand() < 0.5) range.maxBytes = 1 + Math.floor(rand() * 3000);
          assert.deepEqual(j.runs.output(j, r.runId, range), narrowOutput(whole, range), `${r.runId} ${JSON.stringify(range)} (seed ${seed})`);
          checked++;
        }
      }
      assert.ok(checked > 100);
      // The gap test output() uses instead of reading the range agrees with a read of it.
      for (let k = 0; k < 300; k++) {
        const a = Math.floor(rand() * (j.lastSeq + 20)) - 5;
        const b = rand() < 0.2 ? undefined : a + Math.floor(rand() * 400) - 20;
        assert.equal(j.gapAt(a, b), j.range(a, b).gap !== undefined, `gapAt(${a}, ${b})`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-9: a range of a large Run reads only what it asks for — not the Run\'s whole range', () => {
  const dir = tmpDir();
  try {
    const w = new Journal({ cold: new FileStore(dir, { maxFileBytes: 256 * 1024, maxBytes: 1 << 30 }), sessionId: 's' });
    w.append({ type: 'run.admit', runId: 'big', target: 'process', line: 'flood', principal: 'p', origin: 'self', queued: false });
    w.append({ type: 'run.start', runId: 'big', cwd: '/w', envBasis: 'configured' });
    w.append({ type: 'run.admit', runId: 'side', target: 'process', line: 'side', principal: 'p', origin: 'self', queued: false });
    w.append({ type: 'run.start', runId: 'side', cwd: '/w', envBasis: 'configured' });
    for (let i = 0; i < 40_000; i++) w.append({ type: 'output', data: `${i} ${'f'.repeat(200)}\n`, stream: 'stdout', runId: i % 10 === 9 ? 'side' : 'big', attribution: 'exact' });
    w.append({ type: 'run.end', runId: 'big', state: 'exited', exit: 0, durationMs: 1 });
    w.close();
    const cold = new FileStore(dir, { maxFileBytes: 256 * 1024, maxBytes: 1 << 30 });
    const j = new Journal({ cold, sessionId: 's' });
    const total = cold.bytes();
    assert.ok(total > 8_000_000);
    const cost = (range: RunOutputRange) => {
      const before = cold.bytesRead;
      const o = j.runs.output(j, 'big', range);
      return { o, read: cold.bytesRead - before };
    };
    const head = cost({ limit: 5 });
    assert.deepEqual([head.o.events.length, head.o.more], [5, true]);
    assert.ok(head.read < 1024 * 1024, `limit 5 read ${head.read} of ${total}`);
    const mid = cost({ since: 20_000, limit: 3 });
    assert.equal(mid.o.events[0]!.seq > 20_000, true);
    assert.ok(mid.read < 1024 * 1024, `since/limit read ${mid.read}`);
    const tail = cost({ maxBytes: 8 * 1024 });
    // Output i is seq 5 + i; the last one of `big` is i = 39998 (39999 is `side`'s).
    assert.equal(tail.o.events[tail.o.events.length - 1]!.seq, 5 + 39_998);
    assert.ok(tail.o.truncated && tail.read < 1024 * 1024, `maxBytes read ${tail.read}`);
    const window = cost({ since: 30_000, until: 30_050 });
    assert.ok(window.o.events.every((e) => e.seq > 30_000 && e.seq <= 30_050) && window.o.events.length > 30);
    assert.ok(window.read < 1024 * 1024, `since/until read ${window.read}`);
    const all = cost({});
    assert.ok(all.read >= total * 0.9, 'the whole Run costs the whole range (what it asks for)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maxBytes counts UTF-8 bytes, as every cap does: box-drawing output is narrowed by its bytes, not its code units', () => {
  const events: JournalEvent[] = Array.from({ length: 4 }, (_, i) => ({ type: 'output', data: '─'.repeat(20), stream: 'stdout', runId: 'r1', seq: i + 2, ts: 0 }));
  // 20 code units but 60 bytes each: a 100-byte cap keeps one event (plus none that would exceed it), where code units would have kept all four.
  const narrowed = narrowOutput({ events, from: 1, to: 5, truncated: false }, { maxBytes: 100 });
  assert.equal(narrowed.events.length, 1);
  assert.equal(narrowed.truncated, true);
  assert.equal(narrowOutput({ events, from: 1, to: 5, truncated: false }, { maxBytes: 240 }).events.length, 4);
});

test('a Run\'s output carries the gap events of the part it covers, as narrowOutput narrows them (the house\'s read of 1cabc6a)', () => {
  const j = new Journal({ sessionId: 's' });
  const runId = 'r1-gaps00';
  j.append({ type: 'run.admit', runId, target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
  j.append({ type: 'run.start', runId, cwd: '/' });
  const o = (data: string) => j.append({ type: 'output', data, stream: 'stdout', runId }).seq;
  const gap = () => {
    const g = j.lastSeq + 1;
    return j.append({ type: 'gap', from: g, to: g, reason: 'torn-write' }).seq;
  };
  const g0 = gap(); // before the first output
  o('a\n');
  o('b\n');
  const g1 = gap(); // between outputs, behind other events
  for (let i = 0; i < 30; i++) j.append({ type: 'note', text: 'n', principal: 'agent:a@test' });
  o('c\n');
  o('d\n');
  const g2 = gap(); // after the last output
  j.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 1 });
  const whole = j.runs.output(j, runId);
  assert.deepEqual(whole.gaps!.map((g) => g.seq), [g0, g1, g2]);
  assert.equal(whole.truncated, true, 'a hole inside the Run cuts its output');
  // `limit` keeps the holes before the first output it drops; `maxBytes` those after the first output it keeps; `since`/`until` bound both.
  const seqs = (range: RunOutputRange) => j.runs.output(j, runId, range).gaps?.map((g) => g.seq);
  assert.deepEqual(seqs({ limit: 2 }), [g0, g1]);
  assert.deepEqual(seqs({ limit: 3 }), [g0, g1]);
  assert.deepEqual(seqs({ maxBytes: 3 }), [g2]);
  assert.deepEqual(seqs({ since: g0 }), [g1, g2]);
  assert.deepEqual(seqs({ until: g1 }), [g0, g1]);
  for (const range of [{}, { limit: 2 }, { limit: 3 }, { maxBytes: 3 }, { since: g0 }, { until: g1 }, { since: g1, maxBytes: 2 }] as RunOutputRange[]) {
    assert.deepEqual(j.runs.output(j, runId, range), narrowOutput(whole, range), JSON.stringify(range));
  }
});

test('a gap recorded after a Run ended, for seqs inside its range, cuts its output and goes with the result where its hole ends (the house\'s read of cc8c909..39787b3)', () => {
  // The catch-up writes the gap for what the ring dropped at the seq current then, past the Run's end:
  // the Run's own range held no gap event, and its output read as complete.
  const j = new Journal({ sessionId: 's' });
  const runId = 'r1-late000';
  j.append({ type: 'run.admit', runId, target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
  j.append({ type: 'run.start', runId, cwd: '/' });
  const o = (data: string) => j.append({ type: 'output', data, stream: 'stdout', runId }).seq;
  const note = () => j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
  const a = o('a\n');
  const n1 = note();
  note();
  const n3 = note();
  const b = o('b\n');
  const end = j.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 1 }).seq;
  assert.equal(j.runs.output(j, runId).truncated, false);
  const late = j.append({ type: 'gap', from: n1, to: n3, reason: 'store-error' });
  assert.ok(late.seq > end);
  const whole = j.runs.output(j, runId);
  assert.equal(whole.truncated, true, 'the hole cuts the Run');
  assert.deepEqual(whole.events.map((e) => e.seq), [a, b]);
  assert.deepEqual(whole.gaps?.map((g) => [g.seq, g.from, g.to, g.reason]), [[n3, n1, n3, 'store-error']], 'the gap goes with the result, seated where its hole ends');
  assert.equal(j.holeWithin(a, b), true);
  assert.equal(j.holeWithin(b, end), false);
  // Narrowed as every gap is: a range of the Run the hole does not touch has none.
  assert.deepEqual([j.runs.output(j, runId, { until: a }).gaps, j.runs.output(j, runId, { until: a }).truncated], [undefined, false]);
  assert.deepEqual(j.runs.output(j, runId, { since: a }).gaps?.map((g) => g.seq), [n3]);
  // A read bounded by `until` that ends inside the hole keeps the gap, re-seated at `until`, so the
  // reader places the hole instead of reading the Run as complete (the house's read of the 36 commits, #22).
  const mid = n1 + 1; // a note inside the hole [n1, n3]
  const bounded = j.runs.output(j, runId, { until: mid });
  assert.equal(bounded.truncated, true, 'the hole the read ends inside of truncates it');
  assert.deepEqual(bounded.gaps?.map((g) => [g.seq, g.from, g.to]), [[mid, n1, n3]], 'the gap is kept, seated at until');
  for (const range of [{}, { limit: 1 }, { maxBytes: 2 }, { since: a }, { until: n1 }, { until: mid }] as RunOutputRange[]) {
    assert.deepEqual(j.runs.output(j, runId, range), narrowOutput(whole, range), JSON.stringify(range));
  }
  // A gap for seqs past the Run says nothing of it.
  j.append({ type: 'gap', from: late.seq + 1, to: late.seq + 1, reason: 'torn-write' });
  assert.equal(j.runs.output(j, runId).gaps?.length, 1);
});

test('the run index drops a gap line claiming seqs at or past its own seq — a line that is not the journal\'s (the house\'s read of the 36 commits, #22)', () => {
  const idx = new RunIndex('s');
  // A valid gap describes seqs issued before it.
  idx.feed({ type: 'gap', from: 1, to: 40, reason: 'store-error', seq: 50, ts: 0 } as JournalEvent);
  assert.equal(idx.gapsWithin(1, 40).length, 1, 'a gap behind its own seq is kept');
  // A gap claiming its own seq or later is not the journal's: the validation guard drops it.
  idx.feed({ type: 'gap', from: 1, to: 60, reason: 'store-error', seq: 55, ts: 0 } as JournalEvent);
  idx.feed({ type: 'gap', from: 70, to: 70, reason: 'store-error', seq: 70, ts: 0 } as JournalEvent);
  assert.equal(idx.gapsWithin(1, 100).length, 1, 'neither over-reaching gap was kept');
});

test('the run index vouches for a range\'s count only above what it has seen and where no gap whose count is a bound meets it, and a bound it forgets narrows what it vouches for', () => {
  // A hole a read infers (retention took it) counts its events exactly only if no reservation's skipped seqs can lie in
  // it (the house's review of the 40 commits through f3750e4, PR #22, comment 6310921374, question 4).
  const idx = new RunIndex('s');
  assert.equal(idx.countsExactly(1, 1000), true, 'nothing recorded: every seq since 1 was issued');
  idx.feed({ type: 'gap', from: 10, to: 20, reason: 'store-error', exact: true, seq: 30, ts: 0 } as JournalEvent);
  idx.feed({ type: 'gap', from: 40, to: 49, reason: 'torn-write', seq: 50, ts: 0 } as JournalEvent);
  assert.equal(idx.countsExactly(1, 39), true, 'an exact hole is seqs issued');
  assert.equal(idx.countsExactly(45, 60), false, 'a bound meets the range');
  assert.equal(idx.countsExactly(50, 60), true);
  idx.knownFrom = 100;
  assert.equal(idx.countsExactly(99, 200), false, 'below what the index has seen, nothing is known');
  assert.equal(idx.countsExactly(100, 200), true);
  // Past its bound the index forgets its oldest gaps; a forgotten bound's seqs are no longer vouched for.
  const trimmed = new RunIndex('s');
  trimmed.feed({ type: 'gap', from: 1, to: 5, reason: 'torn-write', seq: 6, ts: 0 } as JournalEvent);
  for (let i = 0; i < 10_000; i++) trimmed.feed({ type: 'gap', from: 100 + 2 * i, to: 100 + 2 * i, reason: 'store-error', exact: true, seq: 101 + 2 * i, ts: 0 } as JournalEvent);
  assert.equal(trimmed.gapsWithin(1, 5).length, 0, 'the oldest went');
  assert.equal(trimmed.knownFrom, 6);
  assert.equal(trimmed.countsExactly(1, 5), false);
  assert.equal(trimmed.countsExactly(6, 99), true);
});

test('jr2-4: a run.start\'s start ticks and boot id reach the Run — as journaled, after a reopen\'s scan, and through a rotation header (the house\'s read of the 38 commits, PR #22, comment 6274857431)', () => {
  // The recovery tests set the ticks on a Run's info by hand: with this propagation removed, none failed.
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir), sessionId: 's' });
    j.append({ type: 'run.admit', runId: 'r1-ticks', target: 'process', line: 'sleep 9', principal: 'agent:a@test', origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'r1-ticks', cwd: '/', envBasis: 'configured', pid: 4242, pgid: 4242, startTicks: 987_654, bootId: 'boot-A' });
    const ticks = (r: RunInfo) => [r.startTicks, r.bootId, r.pgid];
    assert.deepEqual(ticks(j.runs.run('r1-ticks')), [987_654, 'boot-A', 4242], 'as journaled');
    j.close();
    const again = new Journal({ cold: new FileStore(dir), sessionId: 's' });
    assert.deepEqual(ticks(again.runs.run('r1-ticks')), [987_654, 'boot-A', 4242], 'after a reopen, from the scan');
    again.close();
    const fromHeader = new RunIndex('s');
    fromHeader.absorbHeader(again.runs.header());
    assert.deepEqual(ticks(fromHeader.run('r1-ticks')), [987_654, 'boot-A', 4242], 'from a rotation header');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a gap recorded past the window is seated where its hole ends: a maxBytes page that begins after the hole reports none, one that begins at it does (the house\'s read of the 38 commits, PR #22, comment 6274857431)', () => {
  // Seated at `until` whatever its hole, a hole wholly inside the window stayed with the page the maxBytes
  // cut began after it, and the page reported a hole before its first event.
  const out = (seq: number): JournalEvent => ({ type: 'output', data: 'xx', stream: 'stdout', runId: 'r', seq, ts: seq }) as JournalEvent;
  const gap = (from: number, to: number): JournalEvent => ({ type: 'gap', from, to, reason: 'store-error', seq: 40, ts: 40 }) as JournalEvent;
  const page = (events: JournalEvent[], g: JournalEvent) =>
    narrowOutput({ events, from: 10, to: 30, truncated: true, gaps: [g as Extract<JournalEvent, { type: 'gap' }>] }, { until: 30, maxBytes: 4 });
  // Outputs at 10, 11, 14..17; the hole [12, 13]; the page holds 16 and 17 alone.
  const early = page([10, 11, 14, 15, 16, 17].map(out), gap(12, 13));
  assert.deepEqual(early.events.map((e) => e.seq), [16, 17]);
  assert.equal(early.gaps, undefined, 'the hole lies before the page\'s first event');
  // Outputs at 10, 11, 14, 17, 18; the hole [15, 16] sits right before the page's first event, 17.
  const at = page([10, 11, 14, 17, 18].map(out), gap(15, 16));
  assert.deepEqual(at.events.map((e) => e.seq), [17, 18]);
  assert.deepEqual(at.gaps?.map((g) => [g.seq, g.from, g.to]), [[16, 15, 16]], 'seated where the hole ends');
  // A hole that runs past `until` is still seated at `until`, where the window ends inside it.
  const past = narrowOutput({ events: [10, 11].map(out), from: 10, to: 30, truncated: true, gaps: [gap(20, 35) as Extract<JournalEvent, { type: 'gap' }>] }, { until: 30 });
  assert.deepEqual(past.gaps?.map((g) => g.seq), [30]);
});

test('a page keeps a gap when its hole meets the seqs it covers and drops it when the hole lies wholly outside, wherever the gap is seated (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 7)', () => {
  // A store-error gap is seated under the next seq once the disk takes writes again, after the outputs that
  // follow its hole: here the hole is 5..8 and the gap sits at 25. Filtered by its seat, a `maxBytes` page of
  // 20..30 kept it though the hole lies wholly before the page, and a `limit` page ending at 12 dropped it,
  // reading as complete across the hole.
  const out = (seq: number): JournalEvent => ({ type: 'output', data: 'xx', stream: 'stdout', runId: 'r', seq, ts: seq }) as JournalEvent;
  const events = [1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30].map(out);
  const gap = { type: 'gap', from: 5, to: 8, reason: 'store-error', seq: 25, ts: 25 } as Extract<JournalEvent, { type: 'gap' }>;
  const whole = { events, from: 1, to: 30, truncated: true, gaps: [gap] };
  const tail = narrowOutput(whole, { maxBytes: 20 });
  assert.deepEqual([tail.events[0]!.seq, tail.gaps], [20, undefined], 'a tail page after the hole reports none');
  const head = narrowOutput(whole, { limit: 8 });
  assert.deepEqual(head.events.map((e) => e.seq), [1, 2, 3, 4, 9, 10, 11, 12]);
  assert.deepEqual(head.gaps?.map((g) => [g.seq, g.from, g.to]), [[8, 5, 8]], 'a head page across the hole reports it, seated where it ends');
  // The page after it does not report it again.
  assert.equal(narrowOutput(whole, { since: 12, limit: 8 }).gaps, undefined);
  // A hole between a page's last output and the first it drops is in what both that page and the next
  // one cover: a reader that pages on reports it once, on the page whose outputs reach past it.
  assert.deepEqual(narrowOutput(whole, { limit: 4 }).gaps?.map((g) => [g.seq, g.from, g.to]), [[8, 5, 8]]);
  assert.deepEqual(narrowOutput(whole, { since: 4, limit: 4 }).gaps?.map((g) => [g.seq, g.from, g.to]), [[8, 5, 8]]);
  // Through a journal: the gap the catch-up wrote, for a hole among the Run's outputs, reads the same.
  const j = new Journal({ sessionId: 's' });
  const runId = 'r1-seat00';
  j.append({ type: 'run.admit', runId, target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
  j.append({ type: 'run.start', runId, cwd: '/' });
  const o = () => j.append({ type: 'output', data: 'xx', stream: 'stdout', runId }).seq;
  const before = [o(), o()];
  const hole = [j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq, j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq];
  const after = [o(), o(), o(), o()];
  const seat = j.append({ type: 'gap', from: hole[0]!, to: hole[1]!, reason: 'store-error' }).seq;
  o();
  j.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 1 });
  const runWhole = j.runs.output(j, runId);
  assert.deepEqual(runWhole.gaps?.map((g) => g.seq), [seat]);
  for (const range of [{ limit: 3 }, { maxBytes: 6 }, { maxBytes: 12 }, { since: before[1]!, limit: 2 }] as RunOutputRange[]) {
    assert.deepEqual(j.runs.output(j, runId, range), narrowOutput(runWhole, range), JSON.stringify(range));
  }
  const headPage = j.runs.output(j, runId, { limit: 3 });
  assert.deepEqual(headPage.events.map((e) => e.seq), [...before, after[0]]);
  assert.deepEqual(headPage.gaps?.map((g) => [g.seq, g.from, g.to]), [[hole[1], hole[0], hole[1]]], 'a head page across the hole, which a read stopping at the first dropped output never reached');
  assert.equal(j.runs.output(j, runId, { maxBytes: 6 }).gaps, undefined, 'a tail page after it');
  // A gap seated among the Run's events for a hole before the Run started is not the Run's.
  const k = new Journal({ sessionId: 's' });
  const early = k.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
  k.append({ type: 'run.admit', runId, target: 'process', principal: 'agent:a@test', origin: 'self', queued: false });
  k.append({ type: 'run.start', runId, cwd: '/' });
  k.append({ type: 'output', data: 'xx', stream: 'stdout', runId });
  k.append({ type: 'gap', from: early, to: early, reason: 'store-error' });
  k.append({ type: 'output', data: 'yy', stream: 'stdout', runId });
  k.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 1 });
  assert.deepEqual([k.runs.output(k, runId).gaps, k.runs.output(k, runId).truncated], [undefined, false]);
});
