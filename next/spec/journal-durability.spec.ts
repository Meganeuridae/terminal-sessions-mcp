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
    assert.deepEqual(store.highWater()?.reservation, { to: 8, failed: true }, 'sealed: exactly at its last seq, marked failed');
    const again = new Journal({ cold: store });
    assert.equal(again.lastSeq, 9, 'numbering continues above everything issued');
    assert.deepEqual(gaps(again.since(0).events), [[4, 8, 'store-failed']]);
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

// ───────────── jr2-7: age retention reaches the active file and an idle ring ─────────────

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
  for (let from = 0; from <= j.lastSeq + 1; from++) {
    for (const to of [undefined, from, from + 3, j.lastSeq]) assert.equal(j.gapAt(from, to), j.range(from, to).gap !== undefined, `gapAt(${from}, ${to})`);
  }
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

test('an epoch whose first write is refused is retried at most once a second as appends land, and the store says so once (the house\'s read of the 33 commits, PR #22, comment 6307349700, item 6)', (t) => {
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
    const warnings: string[] = [];
    const store = new FileStore(dir, { log: (_level, text) => void warnings.push(text) });
    const ev = (seq: number) => ({ ...out(`x${seq}`), seq, ts: Date.now() }) as JournalEvent;
    for (let seq = 1; seq <= 200; seq++) store.append(ev(seq));
    assert.equal(store.lastSeq(), 200, 'the appends went through');
    assert.equal(attempts, 1, '200 appends within a second: the epoch was tried once, at open');
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0]!, /journal\.meta\.json\) could not be written: ENOSPC.*retried at most once a second.*new epoch/);
    mono += 1000;
    store.append(ev(201));
    assert.equal(attempts, 2, 'a second later: tried again');
    assert.equal(warnings.length, 1, 'said once');
    refuse = false;
    mono += 1000;
    store.append(ev(202));
    store.close();
    assert.equal(new FileStore(dir).epoch(), store.epoch(), 'the epoch landed');
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
    assert.equal(synced.length, 1 + 3, `the epoch, then one reservation per block begun: ${n} events`);
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
