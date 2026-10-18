/** A timer callback is a wake-up, not evidence that the quiet deadline passed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Journal } from '../src/core/journal.js';
import { WatchManager, type WatchHost } from '../src/core/watches.js';

test('silence rechecks its deadline when the timer wakes before the quiet duration has passed', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const journal = new Journal();
  const host: WatchHost = { journal, integration: 'rich', waitAvailable: async () => false, shellAvailable: () => ({ ok: false }) };
  const manager = new WatchManager(host);
  const watch = manager.add({ silenceMs: 100 }, 'agent:a@test');
  const firings = () => journal.since(0).events.filter((e) => e.type === 'watch.fired' && e.watchId === watch.watchId);
  try {
    // The real timer wakes, but the wall clock used by journal timestamps has not
    // reached the deadline. This also covers millisecond timer rounding and clock adjustments.
    await sleep(130);
    assert.equal(firings().length, 0, 'an early wake must not certify silence');
    now = 1100;
    await sleep(150);
    assert.equal(firings().length, 1);
    const hit = firings()[0];
    assert.ok(hit?.type === 'watch.fired');
    assert.equal(hit.match, 'no output for 100ms');
  } finally {
    manager.dispose();
    journal.close();
  }
});
