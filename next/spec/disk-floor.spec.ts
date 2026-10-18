/**
 * Shell tools 4 (the house's review of #11): a retention cap bounds one session, nothing bounded
 * the machine. The free-space floor refuses a store's appends while the filesystem is below it;
 * the journal treats that as the store error it already handles (ring carries on, retries, a gap
 * for what the ring dropped). Here with a fake statfs, so the disk never has to be full.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Journal } from '../src/core/journal.js';
import { FileStore, FreeSpaceFloor, MemoryStore } from '../src/core/stores.js';

const out = (data: string) => ({ type: 'output', data, stream: 'pty' }) as const;
const MiB = 1024 * 1024;

test('the floor asks the filesystem once a second or once a megabyte, and refuses below the floor', () => {
  let free = 500 * MiB;
  let asked = 0;
  let now = 1_000_000;
  const floor = new FreeSpaceFloor(200 * MiB, () => (asked++, { bavail: free / 4096, bsize: 4096 }), () => now);
  for (let i = 0; i < 1000; i++) assert.equal(floor.allow('/d', 100), true);
  assert.equal(asked, 1, 'a thousand small appends within a second: one statfs');
  for (let i = 0; i < 12; i++) floor.allow('/d', 100 * 1024);
  assert.equal(asked, 2, 'a megabyte written: asked again');
  now += 1000;
  free = 100 * MiB;
  assert.equal(floor.allow('/d', 100), false, 'below the floor after a second has passed');
  assert.equal(asked, 3);
  assert.equal(floor.allow('/d', 100), false, 'the answer holds for the second');
  assert.equal(asked, 3);
  now += 1000;
  free = 300 * MiB;
  assert.equal(floor.allow('/d', 100), true, 'space came back');
  // A filesystem that cannot be asked is not a full one.
  const silent = new FreeSpaceFloor(200 * MiB, () => {
    throw new Error('ENOSYS');
  });
  assert.equal(silent.allow('/d', 100), true);
});

test('below the floor the journal keeps the ring and the disk is left alone; above it again, the store catches up and nothing is lost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-floor-'));
  try {
    let allowed = true;
    const store = new FileStore(dir, { floor: { allow: () => allowed } });
    const j = new Journal({ hot: new MemoryStore(4 * MiB), cold: store });
    j.append(out('before'));
    allowed = false;
    for (let i = 0; i < 5; i++) assert.doesNotThrow(() => j.append(out(`held-${i}`)));
    assert.match(j.stats().coldFailed ?? '', /below the floor/);
    assert.deepEqual(j.since(0).events.map((e) => e.seq), [1, 2, 3, 4, 5, 6], 'reads come from the ring');
    assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"output"')).length, 1, 'nothing written while below the floor');
    allowed = true;
    assert.equal(j.retryCold(), true);
    assert.equal(j.stats().coldFailed, null);
    j.append(out('after'));
    const onDisk = fs
      .readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"output"'))
      .map((l) => (JSON.parse(l) as { data: string }).data);
    assert.deepEqual(onDisk, ['before', 'held-0', 'held-1', 'held-2', 'held-3', 'held-4', 'after'], 'the held events reached the disk, in order, with no gap');
    j.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
