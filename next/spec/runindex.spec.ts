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
import { boundHeader, narrowOutput, RunIndex, type RunOutputRange } from '../src/core/runindex.js';
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
        assert.deepEqual(whole, { events: full.events.filter((e) => e.type === 'output' && e.runId === r.runId), from, to, truncated: full.gap !== undefined }, `${r.runId} whole`);
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
