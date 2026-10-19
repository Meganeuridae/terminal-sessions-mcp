/** A timer callback is a wake-up, not evidence that the quiet deadline passed; and the quiet is measured on the monotonic clock. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Journal } from '../src/core/journal.js';
import { clocks, WatchManager, type WatchHost } from '../src/core/watches.js';

test('silence rechecks its deadline when the timer wakes before the quiet duration has passed, and a wall-clock step neither delays nor hastens it', async (t) => {
  // After arming, the monotonic clock falls 40 ms behind the timer: the first wake, at 100 ms, sees
  // 60 ms of quiet and re-arms for the remainder.
  const real = performance.now.bind(performance);
  let lag = 0;
  t.mock.method(clocks, 'monotonic', () => real() - lag);
  const journal = new Journal();
  const host: WatchHost = { journal, integration: 'rich', waitAvailable: async () => false, shellAvailable: () => ({ ok: false }) };
  const manager = new WatchManager(host);
  const firingsOf = (id: string) => journal.since(0).events.filter((e) => e.type === 'watch.fired' && e.watchId === id);
  try {
    const early = manager.add({ silenceMs: 100 }, 'agent:a@test');
    lag = 40;
    await sleep(120);
    assert.equal(firingsOf(early.watchId).length, 0, 'an early wake must not certify silence');
    lag = 0;
    await sleep(80);
    assert.equal(firingsOf(early.watchId).length, 1, 're-armed for the remainder, then fired');
    const hit = firingsOf(early.watchId)[0];
    assert.ok(hit?.type === 'watch.fired');
    assert.match(hit.match ?? "", /^no output for 1\d\dms$/);
    // The wall clock steps back two seconds right after arming: silence still fires on time (the
    // previous version re-armed for the size of the step, so a watch waited 2.1 s for 100 ms of quiet).
    const stepped = manager.add({ silenceMs: 100 }, 'agent:a@test');
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall - 2000);
    await sleep(160);
    assert.equal(firingsOf(stepped.watchId).length, 1, 'fired within 160 ms despite the step');
    const hit2 = firingsOf(stepped.watchId)[0];
    assert.ok(hit2?.type === 'watch.fired');
    assert.match(hit2.match ?? "", /^no output for 1[0-5]\dms$/);
  } finally {
    manager.dispose();
    journal.close();
  }
});
