/**
 * The journal's durability and retention edges, against real files: events the
 * disk refused are never silently dropped or renumbered (jr2-6: G10, G11, G19),
 * age retention reaches the active file and an idle ring (jr2-7: G21, G26), the
 * rotation header stays small enough that retention holds (jr2-8), and every
 * journal has a persisted epoch (mcpl-4). Each test is named for its finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { clocks } from '../src/core/clock.js';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { HIGH_WATER_BLOCK, Journal } from '../src/core/journal.js';
import { boots } from '../src/core/lock.js';
import { cannotSyncDir, FileStore, MemoryStore, writeDurably, type JournalStore } from '../src/core/stores.js';

/** node:fs as stores.js sees it: a patch here plus syncBuiltinESMExports reaches its `import * as fs` bindings. */
const fsc = createRequire(import.meta.url)('node:fs') as { fsyncSync: typeof fs.fsyncSync; fstatSync: typeof fs.fstatSync; renameSync: typeof fs.renameSync; openSync: typeof fs.openSync };
/** A directory fsync that fails with EIO while `fn` runs (file fsyncs still work). */
function withDirFsyncEIO<T>(fn: () => T): T {
  const real = fsc.fsyncSync;
  fsc.fsyncSync = ((fd: number) => {
    if (fsc.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    return real(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsc.fsyncSync = real;
    syncBuiltinESMExports();
  }
}
import type { JournalEvent } from '../src/core/types.js';

const out = (data: string, runId?: string) => ({ type: 'output', data, stream: 'pty', ...(runId ? { runId, attribution: 'temporal' as const } : {}) }) as const;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-durable-'));
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const journalFiles = (dir: string) =>
  fs
    .readdirSync(dir)
    .filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n))
    .sort((a, b) => (a === 'journal.jsonl' ? 1 : b === 'journal.jsonl' ? -1 : Number(a.split('.')[1]) - Number(b.split('.')[1])));
const onDisk = (dir: string) =>
  journalFiles(dir)
    .flatMap((n) => lines(path.join(dir, n)))
    .map((l) => JSON.parse(l) as JournalEvent & { header?: unknown })
    .filter((e) => typeof e.seq === 'number');
const seqs = (events: JournalEvent[]) => events.map((e) => e.seq);
const gaps = (events: JournalEvent[]) => events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap').map((g) => [g.from, g.to, g.reason]);

/** A file store whose appends fail while `broken`, like a full disk (its side files still write). */
class FullDisk extends FileStore {
  broken = false;
  override append(event: JournalEvent): void {
    if (this.broken) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    super.append(event);
  }
}

// ───────────── jr2-6: nothing the ring held is dropped or renumbered at seal ─────────────

test('jr2-6/G19: sealing a journal whose disk has healed writes what only the ring held, whatever the backoff says', () => {
  const dir = tmpDir();
  try {
    const cold = new FullDisk(dir);
    const j = new Journal({ cold });
    for (let i = 0; i < 3; i++) j.append(out(`before-${i}`));
    cold.broken = true;
    for (let i = 0; i < 5; i++) j.append(out(`only-in-ring-${i}`)); // 4..8; the retry deadline is a second away
    cold.broken = false; // space freed, then the session closes within the backoff
    j.seal();
    assert.deepEqual(seqs(onDisk(dir)), [1, 2, 3, 4, 5, 6, 7, 8], 'every event reached the disk at seal');
    assert.equal(j.stats().coldFailed, null);
    const again = new Journal({ cold: new FileStore(dir) });
    assert.equal(again.lastSeq, 8);
    assert.deepEqual(gaps(again.since(0).events), [], 'no hole, so no gap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-6/G10/G11: a journal sealed while the disk still refuses leaves a high water: the next journal numbers above it and records the hole', () => {
  const dir = tmpDir();
  try {
    const cold = new FullDisk(dir);
    const j = new Journal({ cold });
    const seen: number[] = [];
    j.subscribe((e) => seen.push(e.seq));
    for (let i = 0; i < 3; i++) j.append(out(`before-${i}`));
    cold.broken = true;
    for (let i = 0; i < 5; i++) j.append(out(`seen-by-subscribers-${i}`));
    j.seal(); // one last catch-up fails too
    assert.equal(Math.max(...seen), 8, 'a subscriber saw up to 8');
    assert.deepEqual(seqs(j.since(0).events), [1, 2, 3, 4, 5, 6, 7, 8], 'the sealed journal still reads them from its ring');
    // The daemon restarts (or a new life opens the same store) once the disk is back.
    const store = new FileStore(dir);
    assert.deepEqual(store.highWater()?.reservation, { to: 8, failed: true, failedFrom: 4 }, 'sealed: exactly at its last seq, marked failed from the first seq the disk refused');
    const again = new Journal({ cold: store });
    assert.equal(again.lastSeq, 9, 'numbering continues above everything issued');
    assert.deepEqual(gaps(again.since(0).events), [[4, 8, 'store-failed']]);
    // After a restart nothing says the seal lowered the reservation rather than a crash leaving it a block ahead.
    assert.equal(again.since(0).events.find((e) => e.type === 'gap' && e.exact), undefined, 'so its count is a bound');
    assert.equal(again.append(out('after')).seq, 10);
    assert.deepEqual(seqs(onDisk(dir)), [1, 2, 3, 9, 10], 'no seq a subscriber saw is reused');
    assert.equal(store.highWater()?.reservation?.failed, undefined, 'the flag goes once the gap is on disk');
    const third = new Journal({ cold: new FileStore(dir) });
    assert.deepEqual(gaps(third.since(0).events), [[4, 8, 'store-failed']], 'the hole is recorded once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-6/G10: a daemon that dies while the disk refuses writes does not have its seqs reissued when the reserved high water was written (best effort: the reservation is a write to the same disk)', () => {
  const dir = tmpDir();
  try {
    const cold = new FullDisk(dir);
    const j = new Journal({ cold });
    for (let i = 0; i < 3; i++) j.append(out(`before-${i}`));
    cold.broken = true;
    for (let i = 0; i < 40; i++) j.append(out(`lost-with-the-daemon-${i}`)); // 4..43, then a SIGKILL: no seal
    const issued = j.lastSeq;
    const again = new Journal({ cold: new FileStore(dir) });
    assert.ok(again.lastSeq > issued, `numbering resumes above ${issued} (at ${again.lastSeq})`);
    const [gap] = gaps(again.since(3).events);
    assert.ok(gap && gap[0] === 4 && (gap[1] as number) >= issued && gap[2] === 'store-failed', JSON.stringify(gap));
    // Once the disk is healthy the reservation is released: a healed journal leaves no high water behind.
    const kc = new FullDisk(path.join(dir, 'healed'));
    const k = new Journal({ cold: kc });
    k.append(out('a'));
    kc.broken = true;
    k.append(out('b'));
    assert.equal(kc.highWater()?.reservation?.failed, true);
    kc.broken = false;
    assert.equal(k.retryCold(), true);
    assert.equal(kc.highWater()?.reservation?.failed, undefined, 'the reservation stands, no longer failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-6/G10: a journal.meta.json an earlier build wrote is read as it meant: a failed highWater as a refused reservation, whose seqs above the files are a store-failed gap, and a plain highWater as retention\'s floor, with nothing missing (the house\'s read of the 40 commits, PR #22)', () => {
  const dir = tmpDir();
  try {
    const failedDir = path.join(dir, 'failed');
    const j = new Journal({ cold: new FileStore(failedDir) });
    for (let i = 0; i < 40; i++) j.append(out(`e${i}`));
    j.close();
    const epoch = (JSON.parse(fs.readFileSync(path.join(failedDir, 'journal.meta.json'), 'utf8')) as { epoch: string }).epoch;
    // The earlier build kept one mark, `highWater`, and flagged it `failed` while the disk refused the seqs above the files.
    fs.writeFileSync(path.join(failedDir, 'journal.meta.json'), JSON.stringify({ v: 1, epoch, highWater: 60, failed: true }) + '\n');
    const a = new Journal({ cold: new FileStore(failedDir) });
    assert.equal(a.epoch, epoch, 'the same journal');
    assert.deepEqual(gaps(a.since(40).events), [[41, 60, 'store-failed']], 'the refused seqs are a recorded hole');
    assert.equal(a.append(out('next')).seq, 62, 'numbering resumes above the hole');
    a.close();
    // A highWater without `failed` is the floor retention left when it dropped every file: numbering resumes
    // above it, and no seq is missing.
    const floorDir = path.join(dir, 'floor');
    fs.mkdirSync(floorDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(floorDir, 'journal.jsonl'), '');
    fs.writeFileSync(path.join(floorDir, 'journal.meta.json'), JSON.stringify({ v: 1, epoch: 'e'.repeat(16), highWater: 80 }) + '\n');
    const b = new Journal({ cold: new FileStore(floorDir) });
    assert.deepEqual(gaps(b.since(0).events), [], 'nothing is missing');
    assert.equal(b.append(out('next')).seq, 81);
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G10: a daemon that dies after its start honoured an earlier boot\'s reservation, before the gap reached the file, does not have the seqs issued again on the same boot (the house\'s read of the 40 commits, PR #22)', (t) => {
  let boot = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  try {
    const live = path.join(dir, 'live');
    const atDeath = path.join(dir, 'at-death');
    const j = new Journal({ cold: new FileStore(live) });
    const seen: number[] = [];
    j.subscribe((e) => seen.push(e.seq));
    for (let i = 0; i < 50; i++) j.append(out(`a${i}`));
    // A power loss keeps the file's first 20 lines; the machine comes back as boot B.
    const file = path.join(live, 'journal.jsonl');
    fs.writeFileSync(file, lines(file).slice(0, 20).join('\n') + '\n');
    boot = 'boot-B';
    /** What the disk holds when the daemon dies at the gap's append, before its line is written. */
    class DiesAtTheGap extends FileStore {
      override append(event: JournalEvent): void {
        if (event.type === 'gap' && !fs.existsSync(atDeath)) fs.cpSync(live, atDeath, { recursive: true });
        super.append(event);
      }
    }
    const recovered = new Journal({ cold: new DiesAtTheGap(live) });
    assert.deepEqual(gaps(recovered.since(20).events), [[21, HIGH_WATER_BLOCK, 'torn-write']]);
    const peek = new FileStore(live);
    assert.equal(peek.highWater()?.reservation?.boot, 'boot-B', 'with the gap in the file, the block above it takes this boot');
    peek.close();
    // The next start on boot B finds the disk as it was at the death.
    const again = new Journal({ cold: new FileStore(atDeath) });
    const next = again.append(out('after the second crash'));
    assert.ok(next.seq > Math.max(...seen) && !seen.includes(next.seq), `no seq a subscriber saw is issued again (next ${next.seq})`);
    again.close();
    recovered.close(); // `j` is left as the first crash left it
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G10: a start that honours an earlier boot\'s reservation makes one durable write for it, stamped with this boot, and a later daemon crash on the same boot reads nothing missing', (t) => {
  // Written without a boot and then again with it once the gap was in the file, every start over a hole cost two
  // durable writes: 200 journals reopened after a power loss in 3.7 s instead of 2.0 s (a reviewer's read of the
  // house's 5af8f68). The one write is honoured on this boot while the files do not reach the seq it was reserved
  // above, which only a death before the gap's line leaves (the test above).
  let boot = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir) });
    for (let i = 0; i < 50; i++) j.append(out(`a${i}`));
    const file = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(file, lines(file).slice(0, 20).join('\n') + '\n'); // a power loss keeps 20 lines
    boot = 'boot-B';
    class Counting extends FileStore {
      writes = 0;
      override setHighWater(change: Parameters<FileStore['setHighWater']>[0]): boolean {
        this.writes++;
        return super.setHighWater(change);
      }
    }
    const store = new Counting(dir);
    const recovered = new Journal({ cold: store });
    assert.deepEqual(gaps(recovered.since(20).events), [[21, HIGH_WATER_BLOCK, 'torn-write']]);
    assert.equal(store.writes, 1, 'one reservation write');
    assert.deepEqual(store.highWater()?.reservation, { to: 2 * HIGH_WATER_BLOCK, boot: 'boot-B' });
    // The daemon dies on boot B with the gap in the file: the next start numbers on from it, no needless hole.
    const again = new Journal({ cold: new FileStore(dir) });
    assert.equal(again.lastSeq, HIGH_WATER_BLOCK + 1);
    assert.deepEqual(gaps(again.since(20).events), [[21, HIGH_WATER_BLOCK, 'torn-write']], 'only the hole the power loss left');
    again.close();
    recovered.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a start after a stop while the disk refused looks for jumps in the files only from the seq its failed reservation names; a failed mark an earlier build wrote, naming none, is read through every file', () => {
  // Read through every file, the look cost about 3 s a GB before termd served, and a full disk marks every session
  // failed at once (a reviewer's read of the fixes for the review of f3750e4, PR #22).
  const dir = tmpDir();
  const cjs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const readSync = cjs.readSync;
  try {
    let budget = Number.POSITIVE_INFINITY;
    class Budgeted extends FileStore {
      override append(event: JournalEvent): void {
        if (budget-- <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        super.append(event);
      }
    }
    const live = path.join(dir, 'live');
    const j = new Journal({ hot: new MemoryStore(600), cold: new Budgeted(live) });
    for (let i = 0; i < 20_000; i++) j.append(out(`history ${i} ${'h'.repeat(60)}`));
    budget = 0;
    for (let i = 0; i < 20; i++) j.append(out(`a-${i}-${'z'.repeat(40)}`));
    budget = 2;
    j.retryCold(); // two caught up past a stretch the ring dropped, then refused
    budget = 0;
    for (let i = 0; i < 20; i++) j.append(out(`b-${i}-${'z'.repeat(40)}`));
    // The daemon dies.
    const metaFile = (d: string) => path.join(d, 'journal.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile(live), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([meta.failed, meta.failedFrom], [true, 20_001], 'the failed mark names the first seq the files lacked');
    const size = journalFiles(live).reduce((a, n) => a + fs.statSync(path.join(live, n)).size, 0);
    /** The bytes a start reads over a copy of the store with its meta as `edit` leaves it, and the holes it records. */
    const start = (name: string, edit: (m: Record<string, unknown>) => void) => {
      const d = path.join(dir, name);
      fs.cpSync(live, d, { recursive: true });
      const m = { ...meta };
      edit(m);
      fs.writeFileSync(metaFile(d), JSON.stringify(m) + '\n');
      let bytes = 0;
      cjs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
        const n = (readSync as (...a: unknown[]) => number)(...args);
        bytes += n;
        return n;
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      let k: Journal;
      try {
        k = new Journal({ cold: new FileStore(d) });
      } finally {
        cjs.readSync = readSync;
        syncBuiltinESMExports();
      }
      const holes = gaps(k.since(20_000).events).filter((g) => g[2] === 'store-error');
      k.close();
      return { bytes, holes };
    };
    const healthy = start('healthy', (m) => {
      delete m.failed;
      delete m.failedFrom;
    });
    const named = start('named', () => {});
    const older = start('older', (m) => delete m.failedFrom);
    assert.deepEqual(healthy.holes, [], 'a store not marked failed is not looked through');
    assert.equal(named.holes.length, 1, `the jump past the files' 20,000 lines: ${JSON.stringify(named.holes)}`);
    assert.equal(named.holes[0]![0], 20_001);
    assert.deepEqual(older.holes, named.holes, 'the same jump, found by reading every file');
    assert.ok(named.bytes - healthy.bytes < size / 10, `from the named seq: ${named.bytes - healthy.bytes} bytes more than a healthy start, of ${size}`);
    assert.ok(older.bytes - healthy.bytes > size * 0.9, `through every file: ${older.bytes - healthy.bytes} bytes more, of ${size}`);
  } finally {
    cjs.readSync = readSync;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a catch-up whose stretch\'s gap the disk refuses never marks the reservation above the stretch, and a crash with any of its mark writes refused still leaves the next start the hole', () => {
  // The catch-up wrote the mark not failed as it issued the gap, then failed from the files' last seq plus one when
  // the disk refused the gap, then lowered it: with that last write refused, an idle session's crash left the next
  // start reading 10 then 39 with no gap for 11–38 (a reviewer's check of the fixes for the review of f3750e4, PR #22).
  for (const allowed of [0, 1, 2, 3]) {
    const dir = tmpDir();
    try {
      let budget = Number.POSITIVE_INFINITY;
      let marks = Number.POSITIVE_INFINITY;
      const written: string[] = [];
      class Refusing extends FileStore {
        override append(event: JournalEvent): void {
          if (budget-- <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
          super.append(event);
        }
        override setHighWater(change: Parameters<FileStore['setHighWater']>[0]): boolean {
          if (marks-- <= 0) return false;
          const r = change.reservation;
          if (r) written.push(r.failed ? `failed from ${r.failedFrom}` : 'not failed');
          return super.setHighWater(change);
        }
      }
      const cold = new Refusing(dir);
      const j = new Journal({ hot: new MemoryStore(1500), cold, sessionId: 's' });
      for (let i = 0; i < 10; i++) j.append(out(`ok${i}`));
      budget = 0;
      for (let i = 0; i < 40; i++) j.append(out(`a-${i}-${'z'.repeat(40)}`)); // refused from seq 11; the ring drops 11–38
      const held = j.since(0).events.filter((e) => e.type === 'output' && e.seq > cold.lastSeq()!).length;
      budget = held; // the catch-up writes what the ring holds, then the disk refuses the stretch's gap
      written.length = 0;
      marks = allowed;
      j.retryCold();
      assert.equal(j.stats().coldFailed !== null, true, 'the gap was refused');
      assert.deepEqual(written.filter((w) => w !== 'failed from 11'), [], `allowed ${allowed}: no mark above the stretch, none cleared: ${written.join(' → ')}`);
      // The daemon dies, idle; the next start finds the disk taking writes.
      budget = Number.POSITIVE_INFINITY;
      marks = Number.POSITIVE_INFINITY;
      const next = new Journal({ cold: new FileStore(dir), sessionId: 's' });
      assert.ok(gaps(next.since(0).events).some((g) => g[0] === 11 && g[1] === 38), `allowed ${allowed}: the hole is recorded: ${JSON.stringify(gaps(next.since(0).events))}`);
      next.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ───────────── jr2-7: age retention reaches the active file and an idle ring ─────────────

test('a new life numbers on from the last seq the life before it issued, and its hole of events the disk never took counts exactly, even when the seal could not lower the reservation', () => {
  // The reservation a seal could not lower stands a block ahead; the new life numbered past it, and its hole, every
  // seq of which the life before issued, read "up to 9998" (the house's review of the 40 commits through f3750e4,
  // PR #22, comment 6310921374, question 4).
  const dir = tmpDir();
  try {
    const cold = new FullDisk(dir);
    const old = new Journal({ cold, sessionId: 's' });
    for (let i = 0; i < 3; i++) old.append(out(`before-${i}`));
    cold.broken = true;
    for (let i = 0; i < 5; i++) old.append(out(`unwritten-${i}`)); // 4..8, in the ring only
    const setHighWater = cold.setHighWater.bind(cold);
    cold.setHighWater = () => false;
    old.seal();
    cold.setHighWater = setHighWater;
    assert.ok((cold.highWater()?.reservation?.to ?? 0) > 8, 'the reservation stands a block ahead');
    const life = new Journal({ cold, sessionId: 's', startSeq: old.lastSeq, runs: old.runs });
    const gap = life.since(3).events[0]!;
    assert.deepEqual(gap.type === 'gap' && [gap.seq, gap.from, gap.to, gap.reason, gap.exact], [9, 4, 8, 'store-failed', true]);
    assert.equal(life.append(out('second life')).seq, 10);
    // A hole of its own whose count is a bound among them makes the new life's a bound too: here the life before
    // opened above a failed reservation, and the disk refused its gap with its events.
    const dir2 = tmpDir();
    try {
      const c2 = new FullDisk(dir2);
      c2.broken = true;
      assert.equal(c2.setHighWater({ reservation: { to: 5, failed: true } }), true);
      const first = new Journal({ cold: c2, sessionId: 's' }); // seqs 1–5 a bound hole, its gap at 6
      first.append(out('x')); // seq 7
      first.seal();
      const next = new Journal({ cold: c2, sessionId: 's', startSeq: first.lastSeq, runs: first.runs });
      const g = next.since(0).events.find((e) => e.seq > 7)!;
      assert.deepEqual(g.type === 'gap' && [g.from, g.to, g.reason, g.exact], [1, 7, 'store-failed', undefined]);
      next.close();
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
    life.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reservation one seq ahead of the files after a reboot is counted as a bound: that seq may never have been issued', (t) => {
  let boot = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir) });
    for (let i = 0; i < 3; i++) j.append(out(`e${i}`));
    j.close();
    const metaFile = path.join(dir, 'journal.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { reserved?: number };
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, reserved: 4 }) + '\n');
    boot = 'boot-B';
    const again = new Journal({ cold: new FileStore(dir) });
    const gap = again.since(3).events[0]!;
    assert.deepEqual(gap.type === 'gap' && [gap.from, gap.to, gap.reason, gap.exact], [4, 4, 'torn-write', undefined]);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a journal opened over files retention already thinned vouches for no count below what they hold: the gaps recorded there went with them', () => {
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(dir, { maxFileBytes: 2000, maxBytes: 6000 }), hot: new MemoryStore(4000) });
    for (let i = 0; i < 200; i++) j.append(out(`line ${i} ${'r'.repeat(60)}`));
    const oldest = j.oldestSeq!;
    assert.ok(oldest > 1, 'retention took the first files');
    assert.equal(j.runs.countsExactly(1, oldest - 1), true, 'the journal that wrote them saw every gap among them');
    j.close();
    const again = new Journal({ cold: new FileStore(dir, { maxFileBytes: 2000, maxBytes: 6000 }) });
    assert.equal(again.runs.knownFrom, again.oldestSeq);
    assert.equal(again.runs.countsExactly(1, again.oldestSeq! - 1), false, 'one opened after cannot tell');
    assert.equal(again.runs.countsExactly(again.oldestSeq!, again.lastSeq), true);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-7/G21/G26: the active file is rotated once its oldest event is past maxAgeMs, so aged content goes at the next append', () => {
  const dir = tmpDir();
  try {
    let now = 1_000_000;
    const clock = () => now;
    const day = 24 * 3600 * 1000;
    const j = new Journal({ cold: new FileStore(dir, { maxAgeMs: day, now: clock }), hot: new MemoryStore(1 << 20, { maxAgeMs: day, now: clock }), now: clock });
    for (let i = 0; i < 5; i++) j.append(out(`SECRET-${i}`));
    assert.equal(journalFiles(dir).length, 1, 'a low-volume session keeps one active file');
    now += 2 * day;
    j.append(out('later'));
    assert.equal(j.oldestSeq, 6);
    const r = j.since(0);
    assert.deepEqual(r.gap && [r.gap.from, r.gap.to], [1, 5], 'the aged range reads as a gap');
    assert.ok(!r.events.some((e) => e.type === 'output' && e.data.startsWith('SECRET')), 'aged content is not readable');
    assert.ok(!fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').includes('SECRET'), 'and not on disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-7/G21/G10: expire() ages an idle journal — ring and files — without an append, and numbering still never restarts', () => {
  const dir = tmpDir();
  try {
    let now = 1_000_000;
    const clock = () => now;
    const day = 24 * 3600 * 1000;
    const hot = new MemoryStore(1 << 20, { maxAgeMs: day, now: clock });
    const j = new Journal({ cold: new FileStore(dir, { maxAgeMs: day, now: clock }), hot, now: clock });
    for (let i = 0; i < 5; i++) j.append(out(`SECRET-${i}`));
    now += day / 2;
    j.append(out('newer'));
    now += day; // the first five are past the cutoff, `newer` is not
    j.expire();
    assert.equal(hot.oldestSeq(), 6, 'the ring released the aged events without an append');
    // Age applies per file: the active file straddling the cutoff was rotated out of the active
    // slot and stays whole until its newest event ages out too.
    assert.deepEqual(journalFiles(dir), ['journal.1.jsonl']);
    assert.deepEqual(seqs(j.since(0).events), [1, 2, 3, 4, 5, 6]);
    now += day;
    j.expire();
    const none = j.since(0);
    assert.deepEqual(none.events, [], 'nothing retained');
    assert.deepEqual(none.gap && [none.gap.from, none.gap.to], [1, 6], 'and what was issued reads as gone (G11)');
    assert.equal(journalFiles(dir).length, 0);
    assert.equal(new FileStore(dir).highWater()?.floor, 6, 'retention keeps the numbering as the floor');
    j.close();
    const again = new Journal({ cold: new FileStore(dir, { maxAgeMs: day, now: clock }), now: clock });
    assert.equal(again.lastSeq, 6, 'no seq is reissued after everything aged out');
    assert.deepEqual(gaps(again.since(0).events), [], 'aging out is retention, not a failed store');
    assert.equal(again.append(out('next')).seq, 7);
    const r = again.since(0);
    assert.deepEqual(r.gap && [r.gap.from, r.gap.to], [1, 6]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-7: MemoryStore.expire drops every aged event, including the newest', () => {
  let now = 0;
  const m = new MemoryStore(1 << 20, { maxAgeMs: 100, now: () => now });
  for (let i = 1; i <= 3; i++) m.append({ ...out('x'), seq: i, ts: now } as JournalEvent);
  now = 50;
  m.expire();
  assert.equal(m.oldestSeq(), 1);
  now = 101;
  m.expire();
  assert.equal(m.oldestSeq(), undefined);
  assert.equal(m.bytes(), 0);
});

// ───────────── jr2-8: a bounded rotation header ─────────────

test('jr2-8/G21: an open Run with a huge command line no longer makes every append rotate; retention holds most of the budget', () => {
  const dir = tmpDir();
  try {
    const store = new FileStore(dir, { maxBytes: 65536 });
    const j = new Journal({ hot: new MemoryStore(65536), cold: store, sessionId: 's' });
    const script = "python3 - <<'EOF'\n" + '# generated\n'.repeat(1800) + 'EOF';
    j.append({ type: 'run.admit', runId: 'r1-a', target: 'shell', line: script, principal: 'p', origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'r1-a', cwd: '/w' });
    for (let i = 0; i < 400; i++) j.append(out(`progress ${i}: ${'x'.repeat(150)}\r\n`, 'r1-a'));
    j.close();
    const files = journalFiles(dir);
    const highest = Math.max(...files.map((n) => Number(n.split('.')[1]) || 0));
    assert.ok(highest < 20, `rotations: ${highest}`);
    const bytes = files.reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0);
    assert.ok(bytes <= 65536, `on disk ${bytes}`);
    const fresh = new Journal({ cold: new FileStore(dir, { maxBytes: 65536 }), sessionId: 's' });
    const retained = fresh.since(0).events.filter((e) => e.type === 'output').length;
    // About 48 KiB of JSON lines fit the 64 KiB budget beside a full active file; before, 3 events did.
    assert.ok(retained >= 150, `output events retained ${retained} of 400`);
    for (const n of files.filter((f) => f !== 'journal.jsonl')) {
      const ls = lines(path.join(dir, n));
      if (ls[0]!.startsWith('{"header":')) assert.ok(Buffer.byteLength(ls[0]!) <= 16384 / 4, `${n}: header ${Buffer.byteLength(ls[0]!)} bytes`);
      assert.ok(ls.some((l) => !l.startsWith('{"header":')), `${n} holds an event, not just a header`);
    }
    // The Run is still known after its admission rotated out: the header named it, with its line shortened.
    const r = fresh.runs.get('r1-a');
    assert.ok(r && r.state === 'running' && r.line!.endsWith('…') && r.line!.length < 600, JSON.stringify(r?.line?.length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-8: past the header budget the oldest open Runs are left out first; a file holding only a header is never rotated', () => {
  const dir = tmpDir();
  try {
    const store = new FileStore(dir, { maxFileBytes: 4096, maxBytes: 1 << 20 });
    const j = new Journal({ cold: store, sessionId: 's' });
    for (let i = 0; i < 30; i++) j.append({ type: 'run.admit', runId: `r${i}-q`, target: 'shell', line: `echo queued-${i}`, principal: 'p', origin: 'self', queued: true });
    // Events bigger than what is left of a file once the header is in it.
    for (let i = 0; i < 6; i++) j.append(out('y'.repeat(3500)));
    j.close();
    let last: string[] = [];
    for (const n of journalFiles(dir)) {
      const ls = lines(path.join(dir, n));
      assert.ok(ls.some((l) => !l.startsWith('{"header":')), `${n} holds an event`);
      if (ls[0]!.startsWith('{"header":')) {
        assert.ok(Buffer.byteLength(ls[0]!) <= 1024, `${n}: header ${Buffer.byteLength(ls[0]!)} bytes`);
        last = (JSON.parse(ls[0]!) as { header: { openRuns: Array<{ runId: string }> } }).header.openRuns.map((r) => r.runId);
      }
    }
    assert.ok(last.length > 0 && last.length < 30 && last[last.length - 1] === 'r29-q', `the newest Runs are kept: ${last.join(',')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── mcpl-4: the journal's epoch ─────────────

test('mcpl-4: a journal has an epoch, persisted with its store and kept by every journal over it; a new store gets a new one', () => {
  const dir = tmpDir();
  const other = tmpDir();
  try {
    const a = new Journal({ cold: new FileStore(dir) });
    assert.match(a.epoch, /^[0-9a-f]{16}$/);
    a.append(out('x'));
    a.close();
    const b = new Journal({ cold: new FileStore(dir) });
    assert.equal(b.epoch, a.epoch, 'the same journal after a restart');
    assert.notEqual(new Journal({ cold: new FileStore(other) }).epoch, a.epoch);
    assert.equal((fs.statSync(path.join(dir, 'journal.meta.json')).mode & 0o777), 0o600);
    fs.rmSync(dir, { recursive: true, force: true }); // forgotten
    assert.notEqual(new Journal({ cold: new FileStore(dir) }).epoch, a.epoch, 'a re-created name starts a new epoch');
    assert.match(new Journal().epoch, /^[0-9a-f]{16}$/, 'a memory-only journal has one too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('jr2-9/G11: gapAt agrees with a read across a cold-store hole, without reading', () => {
  class Flaky extends MemoryStore {
    broken = false;
    override append(event: JournalEvent): void {
      if (this.broken) throw new Error('ENOSPC: no space left on device, write');
      super.append(event);
    }
  }
  const cold = new Flaky();
  const j = new Journal({ hot: new MemoryStore(600), cold });
  for (let i = 0; i < 3; i++) j.append(out(`ok${i}`));
  cold.broken = true;
  for (let i = 0; i < 20; i++) j.append(out(`kept-${i}-${'z'.repeat(40)}`)); // the small ring drops some of these
  const agrees = (j: Journal, label: string) => {
    for (let from = 0; from <= j.lastSeq + 1; from++) {
      for (const to of [undefined, from, from + 1, from + 3, j.lastSeq]) assert.equal(j.gapAt(from, to), j.range(from, to).gap !== undefined, `${label}: gapAt(${from}, ${to})`);
    }
  };
  agrees(j, 'between the stores');
  // Two stretches apart, the disk holding what a catch-up wrote between them, and an opening hole whose gap the ring dropped.
  let budget = 0; // refusing from the opening gap on
  class Budget extends MemoryStore {
    override append(event: JournalEvent): void {
      if (budget-- <= 0) throw new Error('ENOSPC: no space left on device, write');
      super.append(event);
    }
  }
  const split = new Journal({ hot: new MemoryStore(600), cold: new Budget(), startSeq: 4 });
  for (let i = 0; i < 20; i++) split.append(out(`a-${i}-${'z'.repeat(40)}`));
  budget = 2;
  split.retryCold();
  budget = 0;
  for (let i = 0; i < 20; i++) split.append(out(`b-${i}-${'z'.repeat(40)}`));
  assert.ok(split.since(0).events.filter((e) => e.type === 'gap').length >= 3, 'the opening hole and two stretches');
  agrees(split, 'stretches apart');
});

test('writeDurably surfaces a write failure and its guarded cleanup leaves no temp file beside the target (the house\'s read of the 36 commits, #22)', () => {
  const dir = tmpDir();
  try {
    // A non-empty directory in the target's place makes the rename fail; the catch cleans the temp and
    // rethrows the write error (the cleanup is guarded so it can never replace that error).
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    assert.throws(() => writeDurably(target, 'data'));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), [], 'no stray temp file is left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeDurably swallows only the directory-fsync codes that mean a filesystem cannot sync a directory — a real I/O error propagates (the house\'s read of the 36 commits, #22)', () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR']) assert.equal(cannotSyncDir(code), true, code);
  for (const code of ['EIO', 'ENOSPC', 'EACCES', undefined]) assert.equal(cannotSyncDir(code), false, String(code));
});

test('writeDurably tells "written, directory not synced" (a real EIO after the rename) from "not written", which throws (the house\'s read of the 38 commits, #22)', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'rec.json');
    assert.deepEqual(writeDurably(file, 'first'), { synced: true });
    const w = withDirFsyncEIO(() => writeDurably(file, 'second'));
    assert.equal(w.synced, false, 'the directory could not be synced');
    assert.equal(w.error?.code, 'EIO');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second', 'but the file holds the new content: it was written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with the directory fsync failing, lowering the reservation counts as done (a crash can only bring back the older, higher one) and raising it does not (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 7)', () => {
  const dir = tmpDir();
  try {
    const store = new FileStore(dir);
    assert.equal(store.setHighWater({ reservation: { to: 100, failed: true } }), true);
    // A lower reservation, its flag cleared, while the directory cannot be synced: memory and the file agree.
    assert.equal(withDirFsyncEIO(() => store.setHighWater({ reservation: { to: 50 } })), true, 'the lowering is done');
    assert.deepEqual(store.highWater(), { reservation: { to: 50 } }, 'memory agrees with the disk');
    assert.deepEqual(new FileStore(dir).highWater(), { reservation: { to: 50 } }, 'a store opened after a restart reads the same');
    // A raise while the directory cannot be synced: not done, memory keeps the old one, the caller retries.
    assert.equal(withDirFsyncEIO(() => store.setHighWater({ reservation: { to: 80, failed: true } })), false, 'the raise is not done');
    assert.deepEqual(store.highWater(), { reservation: { to: 50 } }, 'memory keeps the old reservation');
    assert.equal(store.setHighWater({ reservation: { to: 80, failed: true } }), true, 'the retry lands once the directory syncs again');
    assert.deepEqual(store.highWater(), { reservation: { to: 80, failed: true } });
    // The floor is kept beside the reservation, and changed apart from it.
    assert.equal(store.setHighWater({ floor: 7 }), true);
    assert.deepEqual(new FileStore(dir).highWater(), { floor: 7, reservation: { to: 80, failed: true } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new epoch the file holds while its directory cannot be synced counts as written: appends do not rewrite it, and the store says so once; a refused write stays pending until an append lands it (a reviewer\'s read of the fixes for #22, comment 6274603516)', (t) => {
  const dir = tmpDir();
  let mono = 0;
  t.mock.method(clocks, 'monotonic', () => mono);
  const realRename = fsc.renameSync;
  let metaRenames = 0;
  fsc.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith('journal.meta.json')) metaRenames++;
    return realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    const warnings: string[] = [];
    const store = withDirFsyncEIO(() => {
      const st = new FileStore(path.join(dir, 'a'), { log: (_level, text) => void warnings.push(text) });
      for (let seq = 1; seq <= 200; seq++) st.append({ ...out(`x${seq}`), seq, ts: Date.now() } as JournalEvent);
      return st;
    });
    // Kept pending, the meta was renamed and its directory fsynced again at every one of the 200 appends.
    assert.equal(metaRenames, 1, 'written once, at the epoch\'s creation');
    assert.equal(warnings.filter((w) => /journal\.meta\.json\) is written but its directory could not be synced: EIO/.test(w)).length, 1, JSON.stringify(warnings));
    assert.equal(warnings.length, 1, 'said once');
    store.close();
    assert.equal(new FileStore(path.join(dir, 'a')).epoch(), store.epoch(), 'the file holds the epoch');
    // A write the disk refused is still pending: the next append writes it.
    metaRenames = 0;
    fsc.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith('journal.meta.json')) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      return realRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    const refused = new FileStore(path.join(dir, 'b'));
    assert.equal(fs.existsSync(path.join(dir, 'b', 'journal.meta.json')), false, 'refused');
    fsc.renameSync = realRename;
    syncBuiltinESMExports();
    mono += 1000; // the refused write is retried at most once a second (comment 6307349700, item 6)
    refused.append({ ...out('y'), seq: 1, ts: Date.now() } as JournalEvent);
    assert.equal(new FileStore(path.join(dir, 'b')).epoch(), refused.epoch(), 'the append landed the pending epoch');
    refused.close();
  } finally {
    fsc.renameSync = realRename;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── the house's read of the 33 commits (PR #22, comment 6307349700): the high water and the epoch ─────────────

test('a raise the store wrote but could not confirm, then the mark memory already holds: it is written, so a restart reads no lost range of seqs never issued (the house\'s read of the 33 commits, PR #22, comment 6307349700, item 3)', (t) => {
  t.mock.method(boots, 'current', () => 'boot-A');
  const dir = tmpDir();
  try {
    const sdir = path.join(dir, 'store');
    const store = new FileStore(sdir);
    assert.equal(store.setHighWater({ reservation: { to: 100, boot: 'boot-A' } }), true);
    assert.equal(withDirFsyncEIO(() => store.setHighWater({ reservation: { to: 100, failed: true } })), false, 'the raise is not confirmed');
    assert.deepEqual(store.highWater(), { reservation: { to: 100, boot: 'boot-A' } }, 'memory holds the old reservation');
    assert.equal(new FileStore(sdir).highWater()?.reservation?.failed, true, 'the file holds the raise');
    assert.equal(store.setHighWater({ reservation: { to: 100, boot: 'boot-A' } }), true);
    assert.deepEqual(new FileStore(sdir).highWater(), { reservation: { to: 100, boot: 'boot-A' } }, 'written, though memory already held it');
    // The journal's side: its reservation is marked failed on disk but not confirmed when the store
    // refuses an event; once the store holds every seq again, the unmarked reservation is written over it.
    const jdir = path.join(dir, 'journal');
    const kc = new FullDisk(jdir);
    const k = new Journal({ cold: kc });
    k.append(out('a'));
    kc.broken = true;
    withDirFsyncEIO(() => k.append(out('b')));
    assert.equal(kc.highWater()?.reservation?.failed, undefined, 'the failed mark is not confirmed');
    assert.equal(new FileStore(jdir).highWater()?.reservation?.failed, true, 'but the file holds it');
    kc.broken = false;
    assert.equal(k.retryCold(), true);
    kc.close(); // the daemon dies here, on this boot: nothing is sealed
    const again = new Journal({ cold: new FileStore(jdir) });
    assert.equal(again.lastSeq, 2, 'after a restart the numbering continues where it was');
    assert.deepEqual(gaps(again.since(0).events), [], 'and no gap claims the reserved block');
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused reservation, a refused extension of a used-up one and a refused failed mark are each tried at most once a second on the monotonic clock (the house\'s read of the 33 commits, PR #22, comment 6307349700, items 4 and 7)', (t) => {
  let mono = 0;
  t.mock.method(clocks, 'monotonic', () => mono);
  /** A cold store that takes its appends or refuses them all, and accepts only its first `accept` reservation writes. */
  const store = (accept: number, appends: boolean) => {
    let calls = 0;
    const cold: JournalStore = {
      kind: 'counting',
      append() {
        if (!appends) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      },
      read: () => [],
      oldestSeq: () => undefined,
      lastSeq: () => undefined,
      close() {},
      highWater: () => undefined,
      setHighWater: () => ++calls <= accept,
    };
    return { cold, calls: () => calls };
  };
  // Every reservation refused, every event refused: the first is retried once a second, not at every event.
  const none = store(0, false);
  const a = new Journal({ cold: none.cold });
  for (let i = 0; i < 3000; i++) a.append(out(`a${i}`));
  assert.equal(none.calls(), 1, '3,000 events within a second: one attempt');
  mono += 1000;
  a.append(out('a-later'));
  assert.equal(none.calls(), 2, 'a second later: tried again');
  // The first reservation written, then the store refuses events and the failed mark is refused: retried
  // once a second, as it was at every event.
  const first = store(1, false);
  const b = new Journal({ cold: first.cold });
  for (let i = 0; i < 3000; i++) b.append(out(`b${i}`));
  assert.equal(first.calls(), 2, 'the reservation, and one refused failed mark');
  mono += 1000;
  b.append(out('b-later'));
  assert.equal(first.calls(), 3, 'a second later: tried again');
  // A healthy store: one reservation write per block; the extension of a used-up block refused, it is
  // retried once a second, while the events go on being issued and stored.
  const healthy = store(1, true);
  const c = new Journal({ cold: healthy.cold });
  for (let i = 0; i < HIGH_WATER_BLOCK; i++) c.append(out(`c${i}`));
  assert.equal(healthy.calls(), 1, 'one write for the first block');
  for (let i = 0; i < 3000; i++) c.append(out(`c-past-${i}`));
  assert.equal(healthy.calls(), 2, 'the extension, refused, and not tried again within the second');
  assert.equal(c.lastSeq, HIGH_WATER_BLOCK + 3000, 'every event issued meanwhile');
  mono += 1000;
  c.append(out('c-later'));
  assert.equal(healthy.calls(), 3);
  a.close();
  b.close();
  c.close();
});

test('an epoch whose first write is refused is retried at most once a second as appends land, and the store says so once, then says at info when it is written after all, by its retry or by a reservation (the house\'s read of the 33 commits, PR #22, comment 6307349700, item 6)', (t) => {
  const dir = tmpDir();
  let mono = 0;
  t.mock.method(clocks, 'monotonic', () => mono);
  const realOpen = fsc.openSync;
  let attempts = 0;
  let refuse = true;
  fsc.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (refuse && String(p).includes('journal.meta.json')) {
      attempts++;
      throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
    }
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const logged: [string, string][] = [];
    const log = (level: 'warn' | 'info', text: string) => void logged.push([level, text]);
    const said = (level: string) => logged.filter(([l]) => l === level).map(([, text]) => text);
    const warnings = said.bind(null, 'warn');
    const store = new FileStore(path.join(dir, 'a'), { log });
    const ev = (seq: number) => ({ ...out(`x${seq}`), seq, ts: Date.now() }) as JournalEvent;
    for (let seq = 1; seq <= 200; seq++) store.append(ev(seq));
    assert.equal(store.lastSeq(), 200, 'the appends went through');
    assert.equal(attempts, 1, '200 appends within a second: the epoch was tried once, at the first append');
    assert.equal(warnings().length, 1, JSON.stringify(logged));
    assert.match(warnings()[0]!, /journal\.meta\.json\) could not be written: ENOSPC.*retried at most once a second.*new epoch/);
    mono += 1000;
    store.append(ev(201));
    assert.equal(attempts, 2, 'a second later: tried again');
    assert.equal(warnings().length, 1, 'said once');
    assert.deepEqual(said('info'), [], 'not written yet');
    refuse = false;
    mono += 1000;
    store.append(ev(202));
    store.close();
    assert.equal(new FileStore(path.join(dir, 'a')).epoch(), store.epoch(), 'the epoch landed');
    assert.equal(said('info').length, 1, JSON.stringify(logged));
    assert.match(said('info')[0]!, /journal\.meta\.json\) is written now: this journal keeps its epoch/);
    // Under a journal the epoch lands with its first reservation that the disk takes, and that is said too.
    logged.length = 0;
    refuse = true;
    const jstore = new FileStore(path.join(dir, 'b'), { log });
    const j = new Journal({ cold: jstore });
    j.append(out('first'));
    assert.equal(warnings().length, 1, 'the refused epoch is said');
    refuse = false;
    mono += 1000;
    j.append(out('a second later'));
    assert.ok(jstore.highWater()?.reservation, 'the reservation is written');
    assert.equal(said('info').length, 1, JSON.stringify(logged));
    j.close();
    assert.equal(new FileStore(path.join(dir, 'b')).epoch(), j.epoch, 'and with it the epoch');
    assert.equal(said('info').length, 1, 'said once');
  } finally {
    fsc.openSync = realOpen;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── the house's read of the 33 commits (PR #22, comment 6307349700): numbering across a power loss ─────────────

test('numbering survives a power loss: a crash that takes the file\'s unsynced tail restarts numbering above every seq issued, the lost range a torn-write gap; on the same boot nothing was lost and numbering continues (the house\'s read of the 33 commits, PR #22, comment 6307349700, its question of intent)', (t) => {
  let boot: string | undefined = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  /** 50 events in a journal over `sub`, as its subscriber saw them; the journal is left as a crash leaves it unless `seal`. */
  const run = (sub: string, seal = false) => {
    const j = new Journal({ cold: new FileStore(path.join(dir, sub)) });
    const seen: number[] = [];
    j.subscribe((e) => seen.push(e.seq));
    for (let i = 0; i < 50; i++) j.append(out(`${sub}-${i}`));
    if (seal) j.close();
    return seen;
  };
  /** A power loss: the synced reservation survives, the journal file keeps only its first `n` lines. */
  const loseTail = (sub: string, n: number) => {
    const file = path.join(dir, sub, 'journal.jsonl');
    fs.writeFileSync(file, lines(file).slice(0, n).join('\n') + '\n');
  };
  const reopen = (sub: string) => new Journal({ cold: new FileStore(path.join(dir, sub)) });
  try {
    // A power loss on boot A; the machine comes back as boot B.
    const seen = run('power');
    loseTail('power', 20);
    boot = 'boot-B';
    const after = reopen('power');
    assert.deepEqual(gaps(after.since(0).events), [[21, HIGH_WATER_BLOCK, 'torn-write']], 'what the file lost, and the seqs reserved past it');
    assert.equal(after.since(0).events.find((e) => e.type === 'gap' && e.exact), undefined, 'counted as a bound');
    const next = after.append(out('after the crash'));
    assert.ok(next.seq > Math.max(...seen) && !seen.includes(next.seq), `no seq a subscriber saw is issued again (next ${next.seq})`);
    after.close();
    // A daemon crash on the same boot: the page cache kept every line, so nothing is missing.
    boot = 'boot-C';
    run('daemon');
    const same = reopen('daemon');
    assert.equal(same.lastSeq, 50, 'numbering continues from the last line');
    assert.deepEqual(gaps(same.since(0).events), []);
    same.close();
    // Where no boot can be read, an unclean stop is taken for a power loss.
    boot = undefined;
    run('unknown');
    const unknown = reopen('unknown');
    assert.deepEqual(gaps(unknown.since(0).events), [[51, HIGH_WATER_BLOCK, 'torn-write']]);
    unknown.close();
    // A clean stop, then a reboot: the seal lowered the reservation to the last seq, so nothing reads as lost...
    boot = 'boot-D';
    run('clean', true);
    boot = 'boot-E';
    const clean = reopen('clean');
    assert.equal(clean.lastSeq, 50);
    assert.deepEqual(gaps(clean.since(0).events), []);
    clean.close();
    // ...unless the power went before the kernel wrote the tail: then exactly what the file lost is a gap.
    boot = 'boot-F';
    run('sealed-then-lost', true);
    loseTail('sealed-then-lost', 20);
    boot = 'boot-G';
    const lost = reopen('sealed-then-lost');
    assert.deepEqual(gaps(lost.since(0).events), [[21, 50, 'torn-write']]);
    assert.equal(lost.lastSeq, 51);
    lost.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reservation written under a known boot is honoured when the next open cannot read the boot: an unclean stop then reads as a power loss', (t) => {
  let boot: string | undefined = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  try {
    const j = new Journal({ cold: new FileStore(path.join(dir, 'a')) });
    for (let i = 0; i < 50; i++) j.append(out(`e${i}`));
    const peek = new FileStore(path.join(dir, 'a'));
    assert.equal(peek.highWater()?.reservation?.boot, 'boot-A', 'the reservation names its boot');
    peek.close();
    // Left as a crash leaves it; the next open cannot read this boot.
    boot = undefined;
    const after = new Journal({ cold: new FileStore(path.join(dir, 'a')) });
    assert.deepEqual(gaps(after.since(0).events), [[51, HIGH_WATER_BLOCK, 'torn-write']], 'honoured: what a power loss may have taken, and the seqs reserved past it');
    assert.ok(after.append(out('after')).seq > HIGH_WATER_BLOCK, 'numbering resumes above the reservation');
    after.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused reservation write that leaves numbering exposed is said once until a write lands, and the write that lands is said too: a failed mark refused while the store refuses events, or any write once the next seq is past the reservation on disk', (t) => {
  let mono = 0;
  t.mock.method(clocks, 'monotonic', () => mono);
  t.mock.method(boots, 'current', () => 'boot-A');
  const dir = tmpDir();
  const realRename = fsc.renameSync;
  let refuseMeta = false;
  fsc.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (refuseMeta && String(to).endsWith('journal.meta.json')) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    return realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  const said: string[] = [];
  try {
    // A store whose events are refused while `refuseEvents` holds, and whose reservation writes get the answers
    // given, in turn (then true).
    const refusing = (answers: boolean[]) => {
      const s = { refuseEvents: true, calls: 0 };
      const store: JournalStore = {
        kind: 'refusing',
        append() {
          if (s.refuseEvents) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        },
        read: () => [],
        oldestSeq: () => undefined,
        lastSeq: () => undefined,
        close() {},
        highWater: () => undefined,
        setHighWater: () => answers[s.calls++] ?? true,
      };
      return { s, store };
    };
    const about = (lines: string[], level: string, words: string) => lines.filter((l) => l.startsWith(`${level}: `) && l.includes(words));
    // The failed mark refused while the store refuses events: the reservation on disk still covers the next seq,
    // but it is not marked failed, so a daemon crash on this boot would number from the files' last line.
    const crash = refusing([true, false]);
    const crashSaid: string[] = [];
    const k = new Journal({ cold: crash.store, log: (level, text) => crashSaid.push(`${level}: ${text}`) });
    k.append(out('k0'));
    k.append(out('k1'));
    assert.equal(crash.s.calls, 2, 'the reservation, then its failed mark refused');
    const refusedMark = about(crashSaid, 'warn', 'could not be marked failed');
    assert.equal(refusedMark.length, 1, crashSaid.join(' | '));
    assert.match(refusedMark[0]!, /a daemon crash on this boot, or a power loss for seqs past 10000,/);
    mono += 1000;
    k.append(out('k2'));
    assert.equal(about(crashSaid, 'info', 'reservation is written again (seqs up to 10000, marked failed)').length, 1, 'the mark landing is said');
    k.close();
    // Once the store takes events again, clearing the failed mark is refused: nothing is said, since a reservation
    // marked failed is honoured on any boot and still covers the next seq.
    const healing = refusing([true, true, false]);
    const healingSaid: string[] = [];
    const h = new Journal({ cold: healing.store, log: (level, text) => healingSaid.push(`${level}: ${text}`) });
    h.append(out('h0'));
    h.append(out('h1'));
    healing.s.refuseEvents = false;
    mono += 60_000;
    h.append(out('h2'));
    assert.equal(healing.s.calls, 3, 'the reservation, its failed mark, and the clear refused at the catch-up');
    assert.deepEqual(about(healingSaid, 'warn', 'reservation could not be'), [], 'nothing said');
    h.close();
    // A healthy store whose extension is refused once its block is used up.
    const store = new FileStore(path.join(dir, 'a'));
    const j = new Journal({ cold: store, log: (level, text) => said.push(`${level}: ${text}`) });
    j.append(out('first'));
    assert.equal(store.highWater()?.reservation?.to, HIGH_WATER_BLOCK, 'the first reservation lands');
    refuseMeta = true;
    for (let i = 1; i < HIGH_WATER_BLOCK + 50; i++) {
      j.append(out(`e${i}`));
      if (i % 1000 === 0) mono += 1000; // retries come due as the seconds pass
    }
    assert.equal(store.lastSeq(), HIGH_WATER_BLOCK + 50, 'every event issued and stored meanwhile');
    const refused = said.filter((s) => s.startsWith('warn: ') && s.includes('reservation could not be written'));
    assert.equal(refused.length, 1, `said once: ${said.join(' | ')}`);
    assert.match(refused[0]!, new RegExp(`seq ${HIGH_WATER_BLOCK + 1} is past the one on disk \\(seqs up to ${HIGH_WATER_BLOCK}\\)`));
    refuseMeta = false;
    mono += 1000;
    j.append(out('landed'));
    assert.equal(store.highWater()?.reservation?.to, 2 * HIGH_WATER_BLOCK + 50, 'written a block past the last seq');
    assert.deepEqual(said.filter((s) => s.startsWith('info: ') && s.includes('reservation is written again')).length, 1, 'its landing said once');
    j.close();
  } finally {
    fsc.renameSync = realRename;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a store syncs a directory it created into its parent with its first metadata write, and counts a reservation only once that sync lands', (t) => {
  t.mock.method(boots, 'current', () => 'boot-A');
  const root = tmpDir();
  const realFsync = fsc.fsyncSync;
  const synced: number[] = [];
  let failIno: number | undefined;
  fsc.fsyncSync = ((fd: number) => {
    const st = fsc.fstatSync(fd);
    if (st.isDirectory()) {
      if (st.ino === failIno) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
      synced.push(st.ino);
    }
    return realFsync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  const ino = (p: string) => fs.statSync(p).ino;
  const reserve = (s: FileStore, to: number) => s.setHighWater({ reservation: { to, boot: 'boot-A' } });
  try {
    // sessions/ and sessions/x are both new: each is synced into its parent before the reservation counts.
    const x = new FileStore(path.join(root, 'sessions', 'x'));
    assert.equal(reserve(x, 100), true);
    assert.ok(synced.includes(ino(root)) && synced.includes(ino(path.join(root, 'sessions'))), 'the data dir and sessions/ were synced');
    x.close();
    // A new session whose entry in sessions/ cannot be synced: the file holds the reservation, which is not counted until the sync lands.
    failIno = ino(path.join(root, 'sessions'));
    const y = new FileStore(path.join(root, 'sessions', 'y'));
    assert.equal(reserve(y, 100), false, 'not counted while its directory entry may not survive a power loss');
    failIno = undefined;
    assert.equal(reserve(y, 100), true, 'counted once the sync lands');
    y.close();
    // A directory that was already there is not synced into its parent again.
    synced.length = 0;
    const again = new FileStore(path.join(root, 'sessions', 'x'));
    assert.equal(reserve(again, 200), true);
    assert.ok(!synced.includes(ino(path.join(root, 'sessions'))), 'only the store\'s own directory, for its file');
    again.close();
  } finally {
    fsc.fsyncSync = realFsync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appends are never synced: a journal syncs one reservation write per block of seqs, and a refused reservation write leaves the events issued and stored, retried once a second (the house\'s read of the 33 commits, PR #22, comment 6307349700, its question of intent)', (t) => {
  let mono = 0;
  t.mock.method(clocks, 'monotonic', () => mono);
  t.mock.method(boots, 'current', () => 'boot-A');
  const dir = tmpDir();
  const realFsync = fsc.fsyncSync;
  const realRename = fsc.renameSync;
  const synced: string[] = [];
  let refuseMeta = false;
  fsc.fsyncSync = ((fd: number) => {
    const st = fsc.fstatSync(fd);
    if (!st.isDirectory()) synced.push(String(st.ino));
    return realFsync(fd);
  }) as typeof fs.fsyncSync;
  fsc.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (refuseMeta && String(to).endsWith('journal.meta.json')) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    return realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    const store = new FileStore(path.join(dir, 'a'));
    const j = new Journal({ cold: store });
    const n = 2 * HIGH_WATER_BLOCK + 500;
    for (let i = 0; i < n; i++) j.append(out(`e${i}`));
    const journalIno = String(fs.statSync(path.join(dir, 'a', 'journal.jsonl')).ino);
    assert.equal(synced.filter((ino) => ino === journalIno).length, 0, 'no append was synced');
    assert.equal(synced.length, 3, `one reservation per block begun, the new epoch written with the first: ${n} events`);
    assert.equal(store.highWater()?.reservation?.to, 3 * HIGH_WATER_BLOCK);
    j.close();
    // The reservation's write refused: the journal goes on issuing and storing, and tries again a second later.
    refuseMeta = true;
    const bstore = new FileStore(path.join(dir, 'b'));
    const b = new Journal({ cold: bstore });
    for (let i = 0; i < 100; i++) b.append(out(`b${i}`));
    assert.equal(bstore.lastSeq(), 100, 'issued and stored');
    assert.equal(bstore.highWater(), undefined, 'no reservation yet');
    refuseMeta = false;
    b.append(out('within the second'));
    assert.equal(bstore.highWater(), undefined, 'not tried again within the second');
    mono += 1000;
    b.append(out('a second later'));
    assert.equal(bstore.highWater()?.reservation?.to, 101 + HIGH_WATER_BLOCK, 'written a second later, a block past the last seq');
    b.close();
  } finally {
    fsc.fsyncSync = realFsync;
    fsc.renameSync = realRename;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cleanly sealed journal opened after a reboot seals again without a durable write: its exact reservation does not depend on the boot (an independent read of the fix for the house\'s read of the 33 commits, PR #22, comment 6307349700)', (t) => {
  let boot = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  const realRename = fsc.renameSync;
  let metaWrites = 0;
  fsc.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith('journal.meta.json')) metaWrites++;
    return realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    const j = new Journal({ cold: new FileStore(dir) });
    for (let i = 0; i < 5; i++) j.append(out(`e${i}`));
    j.close();
    assert.deepEqual(new FileStore(dir).highWater()?.reservation, { to: 5, boot: 'boot-A' });
    // A reboot, then the restart's recovery opens and seals it, issuing nothing: one durable write each, before.
    boot = 'boot-B';
    metaWrites = 0;
    const recovered = new Journal({ cold: new FileStore(dir) });
    recovered.close();
    assert.equal(metaWrites, 0, 'no durable write');
    assert.deepEqual(new FileStore(dir).highWater()?.reservation, { to: 5, boot: 'boot-A' }, 'the reservation keeps the boot it was written under');
    // Kept as it was, it still bounds a later power loss: the lines the file loses read as a gap, and nothing more.
    const file = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(file, lines(file).slice(0, 3).join('\n') + '\n');
    boot = 'boot-C';
    const after = new Journal({ cold: new FileStore(dir) });
    assert.deepEqual(gaps(after.since(0).events), [[4, 5, 'torn-write']]);
    after.close();
  } finally {
    fsc.renameSync = realRename;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a sealed journal whose store heals at a retry goes back to a reservation at its last seq, so the next boot reads no gap for a seq never issued (an independent read of the fix for the house\'s read of the 33 commits, PR #22, comment 6307349700)', (t) => {
  let boot = 'boot-A';
  t.mock.method(boots, 'current', () => boot);
  const dir = tmpDir();
  try {
    for (const [sub, hot] of [['whole', undefined], ['ring-dropped', new MemoryStore(700)]] as const) {
      const sdir = path.join(dir, sub);
      const cold = new FullDisk(sdir);
      const j = new Journal({ cold, ...(hot && { hot }) });
      for (let i = 0; i < 5; i++) j.append(out(`kept-${i}`));
      cold.broken = true;
      for (let i = 0; i < 30; i++) j.append(out(`refused-${i}-${'r'.repeat(40)}`)); // the small ring drops most of these
      j.seal(); // the last catch-up is refused too: the reservation stands at the last seq, failed
      assert.equal(cold.highWater()?.reservation?.failed, true, `${sub}: sealed failing`);
      cold.broken = false;
      assert.equal(j.retryCold(), true, `${sub}: healed`);
      assert.deepEqual(cold.highWater()?.reservation, { to: j.lastSeq, boot }, `${sub}: exactly at its last seq`);
      boot = `${boot}+`;
      const next = new Journal({ cold: new FileStore(sdir) });
      const reasons = gaps(next.since(0).events).map((g) => g[2]);
      assert.ok(!reasons.includes('torn-write'), `${sub}: no torn-write gap after the reboot: ${JSON.stringify(gaps(next.since(0).events))}`);
      assert.equal(next.lastSeq, j.lastSeq, `${sub}: numbering continues from the sealed journal's last seq`);
      if (hot) assert.deepEqual(reasons, ['store-error'], 'the ring\'s loss is the one gap, recorded at the heal');
      next.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A store as a crash leaves it under an older build: three events, the fourth cut short, and no metadata file. */
function tornEpochless(dir: string): string {
  const j = new Journal({ cold: new FileStore(dir) });
  for (let i = 0; i < 3; i++) j.append(out(`e${i}`));
  j.close();
  fs.rmSync(path.join(dir, 'journal.meta.json'));
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"type":"output","stream":"pty","data":"cut sh');
  return fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
}
/** Every file under `dir` with its content: what an open must leave as it found it. */
const snapshot = (dir: string) => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));

test('opening a file store changes no content: a torn tail is cut, and a new epoch written, by its first write (an independent read of the fix for the house\'s read of the 33 commits, PR #22, comment 6307349700)', () => {
  const dir = tmpDir();
  try {
    const before = tornEpochless(dir);
    const store = new FileStore(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), before, 'the fragment is still there');
    assert.equal(fs.existsSync(path.join(dir, 'journal.meta.json')), false, 'no epoch written');
    assert.deepEqual(seqs(store.read()), [1, 2, 3], 'reads stop at the last complete line');
    assert.equal(store.lastSeq(), 3);
    // A journal over it records the torn event: its first write, which cuts the fragment and writes the epoch.
    const j = new Journal({ cold: store });
    assert.deepEqual(gaps(j.since(0).events), [[4, 4, 'torn-write']]);
    assert.deepEqual(seqs(onDisk(dir)), [1, 2, 3, 5], 'the fragment is gone: the gap for the torn event 4 is the next whole line');
    assert.ok(lines(path.join(dir, 'journal.jsonl')).every((l) => JSON.parse(l)), 'every line whole');
    assert.equal(new FileStore(dir).epoch(), j.epoch, 'the epoch is on disk');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused open of another principal\'s torn, epoch-less journal leaves its files byte for byte as they were (an independent read of the fix for the house\'s read of the 33 commits, PR #22, comment 6307349700)', async () => {
  const dataDir = tmpDir();
  try {
    const reg = new SessionRegistry({ dataDir, backend: new ScriptedBackend(), lock: false });
    // Written after the registry started, so its recovery never surfaced it: the open goes the fallback way.
    const sdir = path.join(dataDir, 'sessions', 'w');
    tornEpochless(sdir);
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private' }), { mode: 0o600 });
    const before = snapshot(sdir);
    await assert.rejects(reg.ensure({ id: 'w', owner: 'agent:b@test' }), (e: Error & { code?: string }) => e.code === 'forbidden');
    assert.deepEqual(snapshot(sdir), before, 'nothing cut, nothing written');
    await reg.closeAll();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ───────────── the house's review of the 77 commits through 4f4c067, PR #22 ─────────────

/** A file store whose appends are refused once `budget` runs out, and whose reservation and append syncs can be refused, with each call logged. */
class Flaky extends FileStore {
  budget = Number.POSITIVE_INFINITY;
  refuseMarks = false;
  refuseSync = false;
  calls: string[] = [];
  override append(event: JournalEvent): void {
    if (this.budget-- <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    super.append(event);
  }
  override setHighWater(change: Parameters<FileStore['setHighWater']>[0]): boolean {
    const r = change.reservation;
    const what = r ? (r.failed ? 'failed' : 'clear') : 'floor';
    if (this.refuseMarks) {
      this.calls.push(`${what} refused`);
      return false;
    }
    this.calls.push(what);
    return super.setHighWater(change);
  }
  override syncAppends(): boolean {
    this.calls.push(this.refuseSync ? 'sync refused' : 'sync');
    return this.refuseSync ? false : super.syncAppends();
  }
}

/** The reservation on disk, read through a store opened and closed for the look. */
function peekReservation(dir: string) {
  const s = new FileStore(dir);
  try {
    return s.highWater()?.reservation;
  } finally {
    s.close();
  }
}

/** 10 events on disk, then 40 the disk refuses, of which the ring (1500 bytes) drops 11–38. */
function refusedStretch(dir: string) {
  const cold = new Flaky(dir);
  const j = new Journal({ hot: new MemoryStore(1500), cold, sessionId: 's' });
  for (let i = 0; i < 10; i++) j.append(out(`ok${i}`));
  cold.budget = 0;
  for (let i = 0; i < 40; i++) j.append(out(`a-${i}-${'z'.repeat(40)}`));
  return { cold, j };
}

test('a start over the failed mark an earlier life left syncs every file before it clears it, the rotated one holding that life\'s gap among them', () => {
  const dir = tmpDir();
  const realFsync = fsc.fsyncSync;
  const synced = new Set<string>();
  let life1: Journal | undefined;
  try {
    // Life 1: the disk refuses a stretch the ring partly drops, then takes events again while every sync is
    // refused, so the stretch's gap is in the files, unsynced, and the mark on disk is still failed. More events
    // rotate that gap's file out of the active one. Then it dies.
    const cold = new Flaky(dir, { maxFileBytes: 2000 });
    life1 = new Journal({ hot: new MemoryStore(1500), cold, sessionId: 's' });
    for (let i = 0; i < 10; i++) life1.append(out(`ok${i}`));
    cold.budget = 0;
    for (let i = 0; i < 40; i++) life1.append(out(`a-${i}-${'z'.repeat(40)}`));
    cold.refuseSync = true;
    cold.budget = Number.POSITIVE_INFINITY;
    life1.retryCold();
    for (let i = 0; i < 40; i++) life1.append(out(`b-${i}-${'y'.repeat(40)}`));
    const files = fs.readdirSync(dir).filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n));
    const gapFile = files.find((n) => gaps(lines(path.join(dir, n)).map((l) => JSON.parse(l) as JournalEvent)).some((g) => g[0] === 11 && g[1] === 38));
    assert.ok(gapFile !== undefined && gapFile !== 'journal.jsonl', `the stretch's gap is in a rotated file (${gapFile} of ${files.join(', ')})`);
    assert.equal(peekReservation(dir)?.failed, true, 'and the mark on disk is failed');
    // Life 2 starts over it and closes: its clear waits for a sync of every file, the rotated one included.
    fsc.fsyncSync = ((fd: number) => {
      const st = fsc.fstatSync(fd);
      if (!st.isDirectory()) synced.add(String(st.ino));
      return realFsync(fd);
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    const cold2 = new Flaky(dir, { maxFileBytes: 2000 });
    new Journal({ cold: cold2, sessionId: 's' }).close();
    assert.deepEqual(cold2.calls.filter((c) => c === 'sync' || c === 'clear').slice(0, 2), ['sync', 'clear'], cold2.calls.join(' → '));
    assert.ok(synced.has(String(fs.statSync(path.join(dir, gapFile)).ino)), 'the file holding the earlier life\'s gap was synced');
  } finally {
    fsc.fsyncSync = realFsync;
    syncBuiltinESMExports();
    life1?.close(); // every sync it tries is refused, so it changes nothing on disk
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a heal clears the failed mark only once the gaps it waited for are synced, and a refused sync keeps it failed: a power loss after the clear cannot take a stretch\'s gap with it', () => {
  const dir = tmpDir();
  const realFsync = fsc.fsyncSync;
  const synced: string[] = [];
  fsc.fsyncSync = ((fd: number) => {
    const st = fsc.fstatSync(fd);
    if (!st.isDirectory()) synced.push(String(st.ino));
    return realFsync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    const { cold, j } = refusedStretch(dir);
    cold.budget = Number.POSITIVE_INFINITY;
    cold.refuseSync = true;
    cold.calls.length = 0;
    j.retryCold();
    assert.deepEqual(cold.calls, ['sync refused'], 'the clear waits for the sync');
    assert.equal(peekReservation(dir)?.failed, true, 'still failed on disk');
    cold.refuseSync = false;
    cold.calls.length = 0;
    synced.length = 0;
    j.close();
    assert.deepEqual(cold.calls.slice(0, 2), ['sync', 'clear'], `synced, then cleared: ${cold.calls.join(' → ')}`);
    const journalIno = String(fs.statSync(path.join(dir, 'journal.jsonl')).ino);
    assert.ok(synced.includes(journalIno), 'the file holding the stretch\'s gap was synced');
    assert.ok(gaps(onDisk(dir)).some((g) => g[0] === 11 && g[1] === 38), 'and the gap is in it');
  } finally {
    fsc.fsyncSync = realFsync;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a heal whose clearing write is refused writes it again a second later while the session is idle, so a crash after that records no hole of seqs never issued', async (t) => {
  t.mock.method(boots, 'current', () => 'boot-A');
  const dir = tmpDir();
  try {
    const { cold, j } = refusedStretch(dir);
    cold.budget = Number.POSITIVE_INFINITY;
    cold.refuseMarks = true;
    cold.calls.length = 0;
    j.retryCold();
    assert.ok(cold.calls.includes('clear refused'), cold.calls.join(' → '));
    cold.refuseMarks = false;
    // Idle: no event comes. The retry is due a second after the refusal, and a loaded runner can fire it late, so
    // the test looks until it lands, for at most five seconds.
    for (const until = Date.now() + 5000; peekReservation(dir)?.failed === true && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
    assert.equal(peekReservation(dir)?.failed, undefined, `cleared without an event: ${cold.calls.join(' → ')}`);
    // The daemon dies (no close); the next start, same boot, finds nothing but the stretch's gap.
    const next = new Journal({ cold: new FileStore(dir), sessionId: 's' });
    assert.deepEqual(gaps(next.since(0).events), [[11, 38, 'store-error']]);
    assert.equal(next.lastSeq, j.lastSeq, 'numbering goes on from the last seq issued');
    next.close();
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hole the run index holds is listed once by gapsWithin when lost-range compaction joins it into a wider stretch', () => {
  const dir = tmpDir();
  try {
    const first = new Journal({ cold: new FileStore(dir), sessionId: 's' });
    for (let i = 0; i < 520; i++) first.append(out(`e${i}`));
    first.close();
    // A new life inherits 256 holes while the disk refuses: their gaps go to the run index unwritten, the ring
    // drops them, their holes are lost again beside the stretch of the dropped gaps' own seqs, and past MAX_LOST
    // the oldest are joined.
    const cold = new Flaky(dir);
    cold.budget = 0;
    const holes = Array.from({ length: 256 }, (_, k) => ({ from: 2 * k + 1, to: 2 * k + 1, reason: 'store-error' as const, exact: true as const }));
    const j = new Journal({ hot: new MemoryStore(1), cold, startSeq: first.lastSeq, lost: holes, sessionId: 's' });
    j.append(out('last'));
    const listed = j.gapsWithin(1, j.lastSeq).map((g) => [g.from, g.to] as const).sort((a, b) => a[0] - b[0]);
    assert.ok(listed.some(([from, to]) => to > from && from < 512), 'compaction joined holes');
    const overlapping = listed.filter((g, i) => i > 0 && g[0] <= listed[i - 1]![1]);
    assert.deepEqual(overlapping, [], 'no seq is in two of the gaps listed');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stretch gap the disk refused, then the ring dropped, is one hole to gapsWithin, as is one a new life records again', () => {
  const dir = tmpDir();
  try {
    const { cold, j } = refusedStretch(dir);
    const held = j.since(0).events.filter((e) => e.type === 'output' && e.seq > cold.lastSeq()!).length;
    cold.budget = held; // the catch-up writes what the ring holds; the stretch's gap is refused
    j.retryCold();
    cold.budget = 0;
    for (let i = 0; i < 40; i++) j.append(out(`b-${i}-${'y'.repeat(40)}`)); // the ring drops the refused gap
    const holes = j.gapsWithin(1, j.lastSeq).filter((g) => g.from === 11 && g.to === 38);
    assert.equal(holes.length, 1, JSON.stringify(j.gapsWithin(1, j.lastSeq).map((g) => [g.from, g.to, g.seq])));
    assert.equal(holes[0]!.seq, 38, 'seated where the hole ends, as a read finds it');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a catch-up that writes a refused gap and then fails again leaves the gap off unwritten: a new life does not record its hole a second time', () => {
  const dir = tmpDir();
  try {
    const { cold, j } = refusedStretch(dir);
    const held = j.since(0).events.filter((e) => e.type === 'output' && e.seq > cold.lastSeq()!).length;
    cold.budget = held; // the stretch's gap is refused: unwritten
    j.retryCold();
    cold.budget = 0;
    for (let i = 0; i < 2; i++) j.append(out(`c${i}`)); // the ring keeps the refused gap
    cold.budget = 1; // the next catch-up writes the gap, then fails
    j.retryCold();
    assert.deepEqual(gaps(onDisk(dir)).filter((g) => g[0] === 11 && g[1] === 38).length, 1, 'the gap is on disk');
    assert.deepEqual(j.unrecorded().filter((h) => h.from === 11 && h.to === 38), [], 'and no longer a hole the journal holds unrecorded');
    j.seal();
    j.retryCold(); // the registry's one more try for a new life: the disk still refuses
    const lost = j.unrecorded();
    cold.budget = Number.POSITIVE_INFINITY;
    const next = new Journal({ hot: new MemoryStore(1500), cold, runs: j.runs, startSeq: j.lastSeq, lost, sessionId: 's' });
    assert.equal(gaps(onDisk(dir)).filter((g) => g[0] === 11 && g[1] === 38).length, 1, 'recorded once');
    next.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
