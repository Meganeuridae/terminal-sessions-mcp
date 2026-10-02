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
import * as path from 'node:path';
import { Journal } from '../src/core/journal.js';
import { FileStore, MemoryStore } from '../src/core/stores.js';
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
    assert.deepEqual(store.highWater(), { seq: 8, failed: true });
    const again = new Journal({ cold: store });
    assert.equal(again.lastSeq, 9, 'numbering continues above everything issued');
    assert.deepEqual(gaps(again.since(0).events), [[4, 8, 'store-failed']]);
    assert.equal(again.append(out('after')).seq, 10);
    assert.deepEqual(seqs(onDisk(dir)), [1, 2, 3, 9, 10], 'no seq a subscriber saw is reused');
    assert.equal(store.highWater(), undefined, 'the flag goes once the gap is on disk');
    const third = new Journal({ cold: new FileStore(dir) });
    assert.deepEqual(gaps(third.since(0).events), [[4, 8, 'store-failed']], 'the hole is recorded once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jr2-6/G10: a daemon that dies while the disk refuses writes never has its seqs reissued (a reserved high water)', () => {
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
    assert.equal(kc.highWater()?.failed, true);
    kc.broken = false;
    assert.equal(k.retryCold(), true);
    assert.equal(kc.highWater(), undefined);
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
    assert.deepEqual(new FileStore(dir).highWater(), { seq: 6, failed: false });
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
