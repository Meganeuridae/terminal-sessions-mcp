/**
 * The native follower on its own (the house's read of 2f357bd, #22): what a resume from a
 * stall costs, the hysteresis between the water marks, a cursor taken as given, and the
 * caught-up hook the endpoint ends a closed session's stream with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/core/journal.js';
import { MemoryStore } from '../src/core/stores.js';
import { Follower, MIN_PAGE, PAGE_SIZE, type FollowerSink } from '../src/transport/follower.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function filled(journal: Journal, n: number): Journal {
  for (let i = 0; i < n; i++) journal.append({ type: 'note', text: `n${i}`, principal: 'agent:a@test' });
  return journal;
}

/** A journal that records the page size of every read. */
function recording(journal: Journal): { source: ConstructorParameters<typeof Follower>[0]; limits: number[] } {
  const limits: number[] = [];
  return {
    limits,
    source: {
      get lastSeq() {
        return journal.lastSeq;
      },
      subscribe: journal.subscribe.bind(journal),
      since: (c: number, l?: number) => {
        limits.push(l ?? Number.POSITIVE_INFINITY);
        return journal.since(c, l);
      },
    },
  };
}

test('a catch-up starts with a small page and grows while the socket takes whole pages; a resume after a stall reads a small page, so a socket that fills after every event costs one small read per event', async () => {
  const journal = filled(new Journal({ hot: new MemoryStore(1 << 20) }), 100);
  const { source, limits } = recording(journal);
  const got: number[] = [];
  let buffered = 0;
  const sink: FollowerSink = {
    event: (e) => {
      got.push(e.seq);
      buffered = fullAfterEach ? 1_000_000 : buffered;
    },
    gap: () => undefined,
    buffered: () => buffered,
    open: () => true,
  };
  let fullAfterEach = false;
  const f = new Follower(source, 0, sink, { highWaterBytes: 100, pollMs: 2 });
  f.start();
  assert.equal(got.length, 100);
  assert.deepEqual(limits, [MIN_PAGE, MIN_PAGE * 4, MIN_PAGE * 16], 'pages grow fourfold while whole pages go through');
  assert.equal(f.state, 'live');
  // The socket fills: the follower pauses, and from now on it fills again after every event it is sent.
  buffered = 1_000_000;
  fullAfterEach = true;
  filled(journal, 5);
  assert.equal(f.state, 'paused');
  for (let i = 0; i < 5; i++) {
    buffered = 0; // the socket drained
    const n: number = got.length;
    await until(() => got.length > n, 1000, `resume ${i}`);
    assert.equal(got.length, n + 1, 'one event went, then the socket was full again');
  }
  const resumes = limits.slice(3);
  assert.equal(resumes.length, 5);
  assert.ok(resumes.every((l) => l === MIN_PAGE), `every resume read a page of ${MIN_PAGE}, not ${PAGE_SIZE}: ${resumes.join(', ')}`);
  assert.deepEqual(got.slice(-5), [101, 102, 103, 104, 105]);
  f.close();
});

test('a long catch-up reaches the full page size and stays there', () => {
  const journal = filled(new Journal({ hot: new MemoryStore(4 << 20) }), 7000);
  const { source, limits } = recording(journal);
  const got: number[] = [];
  const f = new Follower(source, 0, { event: (e) => got.push(e.seq), gap: () => undefined, buffered: () => 0, open: () => true });
  f.start();
  assert.equal(got.length, 7000);
  assert.deepEqual(limits, [16, 64, 256, 1024, 2000, 2000, 2000]);
  assert.equal(f.state, 'live');
  f.close();
});

test('hysteresis: a paused follower resumes once the queue is down to the low-water mark, not before and not only when it is empty', async () => {
  const journal = filled(new Journal({ hot: new MemoryStore(1 << 20) }), 3);
  let buffered = 0;
  const got: number[] = [];
  const f = new Follower(journal, 0, { event: (e) => got.push(e.seq), gap: () => undefined, buffered: () => buffered, open: () => true }, { highWaterBytes: 100, pollMs: 2 });
  f.start();
  assert.equal(got.length, 3);
  buffered = 100; // at the high-water mark: full
  filled(journal, 2);
  assert.equal(f.state, 'paused');
  buffered = 60; // below high, above low (25): still draining, nothing is sent yet
  await sleep(30);
  assert.equal(f.state, 'paused', 'between the marks the follower stays paused (hysteresis)');
  assert.equal(got.length, 3);
  buffered = 25; // the low-water mark itself, not an empty socket
  await until(() => f.state === 'live', 1000, 'resume at the low-water mark');
  assert.deepEqual(got, [1, 2, 3, 4, 5]);
  f.close();
});

test('the cursor is taken as given: events at or before it are never delivered, even when it is past the journal', () => {
  const journal = filled(new Journal({ hot: new MemoryStore(1 << 20) }), 5);
  const got: number[] = [];
  const f = new Follower(journal, 8, { event: (e) => got.push(e.seq), gap: () => undefined, buffered: () => 0, open: () => true });
  f.start();
  assert.equal(f.state, 'live');
  assert.equal(f.cursor, 8);
  filled(journal, 5); // seqs 6..10: 6, 7, 8 are at or before the cursor
  assert.deepEqual(got, [9, 10]);
  f.close();
});

test('onceCaughtUp runs at once on a live follower, after the catch-up on a paused one, and never on a closed one', async () => {
  const journal = filled(new Journal({ hot: new MemoryStore(1 << 20) }), 2);
  let buffered = 0;
  const got: number[] = [];
  const f = new Follower(journal, 0, { event: (e) => got.push(e.seq), gap: () => undefined, buffered: () => buffered, open: () => true }, { highWaterBytes: 100, pollMs: 2 });
  f.start();
  let ran = 0;
  f.onceCaughtUp(() => ran++);
  assert.equal(ran, 1, 'live: now');
  assert.equal(f.ending, false);
  buffered = 1_000_000;
  filled(journal, 3);
  assert.equal(f.state, 'paused');
  f.onceCaughtUp(() => ran++);
  assert.equal(ran, 1, 'paused: not yet');
  assert.equal(f.ending, true);
  buffered = 0;
  await until(() => ran === 2, 1000, 'the hook after the catch-up');
  assert.deepEqual(got, [1, 2, 3, 4, 5], 'everything was delivered before the hook ran');
  assert.equal(f.ending, false);
  f.close();
  f.onceCaughtUp(() => ran++);
  assert.equal(ran, 2, 'closed: never');
});
