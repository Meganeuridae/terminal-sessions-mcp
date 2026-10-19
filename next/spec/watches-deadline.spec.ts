/** A timer callback is a wake-up, not evidence that the quiet deadline passed; and the quiet is measured on the monotonic clock. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import type { JournalEvent } from '../src/core/types.js';
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

// ───────────── the house's read of 3eade8a (#22): watches ─────────────

const A = 'agent:a@test';

function bare() {
  const journal = new Journal();
  const waiters: Array<() => void> = [];
  const host: WatchHost & { available: boolean; notify: () => void } = {
    journal,
    integration: 'rich',
    available: false,
    notify: () => {
      for (const w of waiters.splice(0)) w();
    },
    waitAvailable: (ms) =>
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        waiters.push(() => {
          clearTimeout(t);
          resolve(host.available);
        });
      }),
    shellAvailable: () => ({ ok: host.available }),
  };
  const manager = new WatchManager(host);
  const startRun = (runId: string, target: 'shell' | 'process' = 'shell') => {
    journal.append({ type: 'run.admit', runId, target, line: runId, principal: A, origin: 'self', queued: false });
    journal.append({ type: 'run.start', runId, cwd: '/' });
  };
  const out = (data: string, runId?: string, stream: 'pty' | 'stdout' = 'pty') => journal.append({ type: 'output', data, stream, ...(runId !== undefined ? { runId } : {}) });
  const firings = (watchId: string) => journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'watch.fired' }> => e.type === 'watch.fired' && e.watchId === watchId);
  return { journal, host, manager, startRun, out, firings, close: () => (manager.dispose(), journal.close()) };
}

test('a silence measured from earlier output takes its age from the monotonic clock, whatever the wall clock did since', async (t) => {
  const f = bare();
  try {
    f.startRun('r');
    f.out('line\n', 'r');
    const wall = Date.now();
    // Stepped forward 10 s: the output is still fresh.
    t.mock.method(Date, 'now', () => wall + 10_000);
    const t0 = performance.now();
    const w = await f.manager.waitFor({ silenceMs: 500, runId: 'r' }, 2000);
    const took = performance.now() - t0;
    assert.equal(w.matched, true);
    assert.ok(took >= 450, `waited the quiet out instead of certifying it at once: ${took.toFixed(0)} ms`);
    assert.match(String(w.match), /^no output for [5-9]\d\dms$/);
    // Stepped back 3 s right after output: a 300 ms silence still fires in about 300 ms, not 3.3 s.
    f.out('again\n', 'r');
    t.mock.method(Date, 'now', () => wall - 3000);
    const t1 = performance.now();
    const w2 = await f.manager.waitFor({ silenceMs: 300, runId: 'r' }, 5000);
    assert.equal(w2.matched, true);
    assert.ok(performance.now() - t1 < 1000, `fired within a second: ${(performance.now() - t1).toFixed(0)} ms`);
    // A standing watch armed from the Run's last output waits the remainder too.
    f.out('more\n', 'r');
    t.mock.method(Date, 'now', () => wall + 10_000);
    const sw = f.manager.add({ silenceMs: 400, runId: 'r' }, A);
    await sleep(150);
    assert.equal(f.firings(sw.watchId).length, 0, 'not fired at once on a forward step');
    await sleep(400);
    assert.equal(f.firings(sw.watchId).length, 1);
    assert.match(f.firings(sw.watchId)[0]!.match ?? '', /^no output for [4-6]\d\dms$/);
  } finally {
    f.close();
  }
});

test('output from before the manager existed takes a wall-clock age clamped at zero', async (t) => {
  const journal = new Journal();
  try {
    journal.append({ type: 'run.admit', runId: 'r', target: 'shell', line: 'r', principal: A, origin: 'self', queued: false });
    journal.append({ type: 'run.start', runId: 'r', cwd: '/' });
    journal.append({ type: 'output', data: 'old\n', stream: 'pty', runId: 'r' });
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall - 60_000);
    const host: WatchHost = { journal, integration: 'rich', waitAvailable: async () => false, shellAvailable: () => ({ ok: false }) };
    const manager = new WatchManager(host);
    const t0 = performance.now();
    const w = await manager.waitFor({ silenceMs: 200, runId: 'r' }, 3000);
    assert.equal(w.matched, true);
    const took = performance.now() - t0;
    assert.ok(took >= 150 && took < 1000, `a negative age is zero, not a wait of a minute: ${took.toFixed(0)} ms`);
    manager.dispose();
  } finally {
    journal.close();
  }
});

test('durations past what a timer can hold are refused instead of waking in a loop', () => {
  const f = bare();
  try {
    assert.throws(() => f.manager.add({ silenceMs: 3e9 }, A), (e: unknown) => e instanceof TermError && e.code === 'invalid_argument' && /2147483647/.test(e.message));
    assert.throws(() => f.manager.add({ silenceMs: 2 ** 31 }, A), (e: unknown) => e instanceof TermError && e.code === 'invalid_argument');
    const ok = f.manager.add({ silenceMs: 2 ** 31 - 1 }, A);
    assert.equal(ok.kind, 'silence');
  } finally {
    f.close();
  }
});

test('pattern spacing is measured on the monotonic clock, and a hit past the spacing carries the held hits with it instead of passing them', async (t) => {
  const real = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(clocks, 'monotonic', () => real() + offset);
  const f = bare();
  try {
    const w = f.manager.add({ pattern: 'ERR\\d+' }, A);
    f.out('ERR1\n');
    assert.equal(f.firings(w.watchId).length, 1);
    // The wall clock steps back 5 s; 1.2 s later on the monotonic clock a hit is past the spacing.
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall - 5000);
    offset = 1200;
    f.out('ERR2\n');
    assert.equal(f.firings(w.watchId).length, 2, 'fired at once: the spacing had passed');
    // Within the spacing two hits are held; the next past it is the latest of them and goes out with their count, before the timer.
    offset = 1500;
    f.out('ERR3\n');
    f.out('ERR4\n');
    assert.equal(f.firings(w.watchId).length, 2, 'held');
    offset = 2300;
    f.out('ERR5\n');
    const fired = f.firings(w.watchId);
    assert.equal(fired.length, 3);
    assert.equal(fired[2]!.match, 'ERR5');
    assert.equal(fired[2]!.suppressed, 2, 'ERR3 and ERR4 are the two not shown');
    await sleep(700);
    assert.equal(f.firings(w.watchId).length, 3, 'the pending timer did not fire the older held hit after it');
  } finally {
    f.close();
  }
});

test('an idle watch fires when the shell becomes available on a timer that journals nothing', async () => {
  const f = bare();
  try {
    const w = f.manager.add({ idle: true }, A);
    f.startRun('r');
    f.journal.append({ type: 'run.end', runId: 'r', state: 'exited', exit: 0, durationMs: 1 });
    await sleep(30);
    assert.equal(f.firings(w.watchId).length, 0, 'the shell is not available yet (a typed-ahead grace, say)');
    f.host.available = true;
    f.host.notify();
    await sleep(30);
    assert.equal(f.firings(w.watchId).length, 1, 'fired without another journal event');
  } finally {
    f.close();
  }
});

test('a wait replays retained output page by page to the end when a read stops short, and matches a prompt already quiet at once', async (t) => {
  const real = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(clocks, 'monotonic', () => real() + offset);
  const f = bare();
  try {
    f.startRun('r');
    for (let i = 1; i <= 5; i++) f.out(`line ${i}\n`, 'r');
    const since = f.journal.since.bind(f.journal);
    // A read that stops at a hole: two events per call, `more` set.
    f.journal.since = (cursor: number) => since(cursor, 2);
    const w = await f.manager.waitFor({ pattern: 'line 5' }, 300, 0);
    assert.equal(w.matched, true, 'the fifth line is behind the first page');
    f.journal.since = since;
    // A prompt with no newline, quiet for longer than the partial delay before the wait began.
    f.out('Password: ', 'r');
    offset = 600;
    const t0 = performance.now();
    const p = await f.manager.waitFor({ pattern: '^Password:' }, 200, 0);
    assert.equal(p.matched, true, 'matched within a 200 ms wait: the delay did not restart');
    assert.ok(performance.now() - t0 < 150, `at once: ${(performance.now() - t0).toFixed(0)} ms`);
  } finally {
    f.close();
  }
});

test("an unscoped pattern watch completes a process Run's last line at its end and drops its matchers", async () => {
  const f = bare();
  try {
    const w = f.manager.add({ pattern: 'ERROR' }, A);
    f.startRun('p', 'process');
    f.out('ERROR half a line', 'p', 'stdout');
    f.journal.append({ type: 'run.end', runId: 'p', state: 'exited', exit: 1, durationMs: 1 });
    await sleep(60);
    assert.equal(f.firings(w.watchId).length, 1, 'fired at the end, not after the 500 ms partial delay');
    assert.equal(f.firings(w.watchId)[0]!.line, 'ERROR half a line');
  } finally {
    f.close();
  }
});
