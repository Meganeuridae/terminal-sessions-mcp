/** A timer callback is a wake-up, not evidence that the quiet deadline passed; and the quiet is measured on the monotonic clock. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import type { JournalEvent } from '../src/core/types.js';
import { clocks } from '../src/core/clock.js';
import { WatchManager, type WaitResult, type WatchHost } from '../src/core/watches.js';

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

test('an ended Run’s last output and a stream’s quiet partial line keep their arrival stamps once other output has come (the house’s read of the 38 commits, #22)', async (t) => {
  const f = bare();
  try {
    // Run r printed and ended; Run q printed since. A silence wait answering for r ages r's last
    // output: the previous stamps kept only each Run's newest output and dropped a Run's at its end,
    // so this age came from the wall clock, and a forward step of 10 s certified 10 s of quiet.
    f.startRun('r');
    f.out('x\n', 'r');
    f.journal.append({ type: 'run.end', runId: 'r', state: 'exited', exit: 0, durationMs: 1 });
    f.startRun('q');
    f.out('y\n', 'q');
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall + 10_000);
    const w = await f.manager.waitFor({ silenceMs: 500, runId: 'r' }, 2000);
    assert.equal(w.matched, true);
    const quiet = Number(/no output for ([\d.]+)ms/.exec(String(w.match))?.[1]);
    assert.ok(quiet < 5000, `the ended Run's last output is aged on the monotonic clock: ${w.match}`);
    // A process Run's stderr left a prompt without a newline, then stdout printed: a wait replaying the
    // output must age the stderr line by its arrival, not by the stepped wall clock, so it is not flushed
    // as already quiet; it is matched once the partial delay has really passed.
    f.startRun('p', 'process');
    f.journal.append({ type: 'output', runId: 'p', data: 'password: ', stream: 'stderr' });
    f.out('progress\n', 'p', 'stdout');
    t.mock.method(Date, 'now', () => wall + 20_000);
    const t0 = performance.now();
    const hit = await f.manager.waitFor({ pattern: 'password:', runId: 'p' }, 5000, 0);
    assert.equal(hit.matched, true);
    assert.ok(performance.now() - t0 >= 150, `the partial line waited its delay instead of being flushed as stale: ${(performance.now() - t0).toFixed(0)} ms`);
  } finally {
    f.close();
  }
});

test('a quiet live Run keeps its last output’s stamp however much another Run prints, and keeps it past its end (the house’s read of the 33 commits, #22, comment 6307351806)', async (t) => {
  // Every output event was stamped and the newest 8,192 kept: once another Run printed 8,192 events,
  // a quiet live Run's last output had no stamp, its age came from the wall clock, and a forward
  // step of 10 s certified 10 s of quiet at once. The ended Run's age is checked the same way.
  const f = bare();
  try {
    f.startRun('r');
    f.out('waiting for input\n', 'r');
    f.startRun('p', 'process');
    const flood = () => {
      for (let i = 0; i < 9000; i++) f.out(`${i}\n`, 'p', 'stdout');
    };
    flood();
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall + 10_000);
    const quietOf = (w: WaitResult) => Number(/no output for (\d+)ms/.exec(String(w.match))?.[1]);
    const live = await f.manager.waitFor({ silenceMs: 200, runId: 'r' }, 5000);
    assert.equal(live.matched, true, JSON.stringify(live));
    // Each ceiling is the step, not a guess at the real time: aged on the wall clock, the quiet is the
    // step and more, while a slow runner flooding 9,000 lines only adds real seconds below it.
    assert.ok(quietOf(live) < 10_000, `the live Run's last output is aged on the monotonic clock: ${live.match}`);
    f.journal.append({ type: 'run.end', runId: 'r', state: 'exited', exit: 0, durationMs: 1 });
    flood();
    const ended = await f.manager.waitFor({ silenceMs: 200, runId: 'r' }, 5000);
    assert.equal(ended.matched, true, JSON.stringify(ended));
    assert.ok(quietOf(ended) < 10_000, `the ended Run's last output is aged on the monotonic clock: ${ended.match}`);
  } finally {
    f.close();
  }
});

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

test('an idle watch stands down once the shell has exited: no recheck loop against a host that answers at once', async () => {
  // A Run that exits the shell ends with the watch armed and the shell gone for good. The host answers
  // every wait at once with false; the watch must not ask again on each answer (that chain of
  // microtasks starved the event loop). (The consolidation of the house's reads of 3eade8a and a6d0c35, #22.)
  const x = bare();
  const host = x.host as typeof x.host & { exit?: { exitCode: number | null } };
  let asked = 0;
  host.waitAvailable = async () => {
    asked++;
    return false;
  };
  // Drain microtasks rather than wait on a timer: without the stand-down guard the recheck chain is a
  // run of microtasks that starves timers, so a timer-based wait would hang; draining fails instead.
  const drain = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
  };
  try {
    const w = x.manager.add({ idle: true }, A);
    x.startRun('r1');
    host.exit = { exitCode: 0 };
    x.journal.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 });
    await drain();
    assert.ok(asked <= 1, `the host was asked ${asked} times`);
    x.journal.append({ type: 'session.exit', code: 0 });
    await drain();
    assert.ok(asked <= 1, `the host was asked ${asked} times after the exit`);
    assert.equal(x.firings(w.watchId).length, 0);
  } finally {
    x.close();
  }
});

test('a pattern watch says when it matched a line on its head only', async () => {
  // The line is longer than the pattern's match window: the hit is reported and marked clipped,
  // as StreamMatcher reports it (the house's read of ed4ecac, #22); a short line is not marked.
  const x = bare();
  try {
    const w = x.manager.add({ pattern: `${'.'.repeat(999)}0` }, A);
    x.out(`${'x'.repeat(999)}0${'y'.repeat(20_000)}\n`);
    await sleep(10);
    const hits = x.firings(w.watchId);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.clipped, true);
    await sleep(1100); // past the pattern spacing
    x.out(`${'x'.repeat(999)}0\n`);
    await sleep(10);
    assert.equal(x.firings(w.watchId).length, 2);
    assert.equal(x.firings(w.watchId)[1]!.clipped, undefined);
  } finally {
    x.close();
  }
});

test('clipped survives when a hit is completed by flush or at stream end, and reaches wait_for (the house\'s read of the 36 commits, #22)', async () => {
  const pat = `${'.'.repeat(999)}0`;
  const clippedLine = `${'x'.repeat(999)}0${'y'.repeat(20_000)}`;
  // Stream end: an unscoped watch completes a process Run's unterminated clipped line at the Run's end.
  {
    const x = bare();
    try {
      const w = x.manager.add({ pattern: pat }, A);
      x.startRun('p', 'process');
      x.out(clippedLine, 'p', 'stdout'); // no newline
      x.journal.append({ type: 'run.end', runId: 'p', state: 'exited', exit: 0, durationMs: 1 });
      await sleep(40);
      const hits = x.firings(w.watchId);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.clipped, true, 'clipped survives the stream-end flush');
    } finally {
      x.close();
    }
  }
  // flush: a watch scoped to a Run completes its clipped last line when that Run ends.
  {
    const x = bare();
    try {
      x.startRun('r');
      const w = x.manager.add({ pattern: pat, runId: 'r' }, A);
      x.out(clippedLine, 'r'); // no newline, pty stream
      x.journal.append({ type: 'run.end', runId: 'r', state: 'exited', exit: 0, durationMs: 1 });
      await sleep(40);
      const hits = x.firings(w.watchId);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.clipped, true, 'clipped survives the flush at the watched Run\'s end');
    } finally {
      x.close();
    }
  }
  // wait_for carries clipped in its result.
  {
    const x = bare();
    try {
      const p = x.manager.waitFor({ pattern: pat }, 1000);
      await sleep(10);
      x.out(`${clippedLine}\n`);
      const r = await p;
      assert.equal(r.matched, true);
      assert.equal(r.clipped, true, 'wait_for reports clipped');
    } finally {
      x.close();
    }
  }
});

test('silence rechecks its deadline deterministically under mock timers, beside the mocked monotonic clock (the house\'s read of the 36 commits, #22)', (t) => {
  // The real-scheduling version above can fail under a 40–60 ms event-loop stall; this one drives the
  // timers and the monotonic clock together, so the recheck-on-early-wake is deterministic.
  let vnow = 0;
  t.mock.method(clocks, 'monotonic', () => vnow);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = new Journal();
  const host: WatchHost = { journal, integration: 'rich', waitAvailable: async () => false, shellAvailable: () => ({ ok: false }) };
  const manager = new WatchManager(host);
  const firingsOf = (id: string) => journal.since(0).events.filter((e) => e.type === 'watch.fired' && (e as Extract<JournalEvent, { type: 'watch.fired' }>).watchId === id);
  try {
    const w = manager.add({ silenceMs: 100 }, A);
    // The 100 ms timer wakes, but only 60 ms of monotonic time has passed: it re-arms for the remainder.
    vnow = 60;
    t.mock.timers.tick(100);
    assert.equal(firingsOf(w.watchId).length, 0, 'an early wake does not certify silence');
    // The remainder elapses: it fires, with 100 ms of quiet.
    vnow = 100;
    t.mock.timers.tick(40);
    assert.equal(firingsOf(w.watchId).length, 1, 're-armed, then fired');
  } finally {
    manager.dispose();
    journal.close();
  }
});

test('a silence wait answering for an ended Run that printed nothing says "no output", as a watch on it does, with no figure from the wall clock (the house’s read of the 40 commits, #22)', async (t) => {
  // Its quiet was Date.now() minus the journal's end: a forward step of 10 s reported 10 s of quiet.
  const f = bare();
  try {
    f.startRun('q');
    const watch = f.manager.add({ silenceMs: 60_000, runId: 'q' }, A);
    f.journal.append({ type: 'run.end', runId: 'q', state: 'exited', exit: 0, durationMs: 1 });
    const fired = f.firings(watch.watchId)[0]?.match;
    assert.equal(fired, 'run q ended (exited 0); no output');
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall + 10_000);
    const w = await f.manager.waitFor({ silenceMs: 200, runId: 'q' }, 5000);
    assert.equal(w.matched, true, JSON.stringify(w));
    assert.equal(w.match, fired);
  } finally {
    f.close();
  }
});

test('the newest 1,024 ended Runs keep their last output’s stamp, and an older one’s output is aged on the wall clock (the house’s read of the 40 commits, #22)', async (t) => {
  // The stamps of ended Runs are bounded: each Run's end past the newest 1,024 lets the oldest go.
  const f = bare();
  try {
    for (let i = 0; i <= 1024; i++) {
      f.startRun(`r${i}`);
      f.out('x\n', `r${i}`);
      f.journal.append({ type: 'run.end', runId: `r${i}`, state: 'exited', exit: 0, durationMs: 1 });
    }
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall + 10_000);
    const quietOf = (w: WaitResult) => Number(/no output for (\d+)ms/.exec(String(w.match))?.[1]);
    const oldestKept = await f.manager.waitFor({ silenceMs: 200, runId: 'r1' }, 5000);
    assert.ok(quietOf(oldestKept) < 10_000, `the 1,024th newest ended Run is aged on the monotonic clock: ${oldestKept.match}`);
    const evicted = await f.manager.waitFor({ silenceMs: 200, runId: 'r0' }, 5000);
    assert.ok(quietOf(evicted) >= 10_000, `the 1,025th newest is aged on the wall clock: ${evicted.match}`);
  } finally {
    f.close();
  }
});

// A hole reaches a read in two shapes: seqs with no event (a gap recorded later sits after its hole), and a
// stretch still lost, read as a gap at its own last seq, which for one seq is the lost event's own (the
// house's read of the 40 commits over our fixes, #22).
for (const shape of ['the events missing', 'a gap at each lost seq'] as const) {
  test(`a wait replaying output from \`since\` starts its lines afresh across a hole: a string or a line open before it takes nothing after it, with ${shape} (the house’s review of the 40 commits through f3750e4, #22, comment 6310921374)`, async () => {
    const f = bare();
    const since = f.journal.since.bind(f.journal);
    try {
      f.startRun('r');
      f.out('ready \x1b]0;my title', 'r');
      const lost = [f.out('the rest of it\x07\n', 'r').seq];
      f.out('ERROR: boom\n', 'r');
      f.out('abc', 'r');
      lost.push(f.out('XYZ', 'r').seq);
      f.out('def\n', 'r');
      // What a store failure took: the read returns no events for those seqs, or the journal's gap for each.
      f.journal.since = (cursor: number, limit?: number) => {
        const r = since(cursor, limit);
        const events =
          shape === 'the events missing'
            ? r.events.filter((e) => !lost.includes(e.seq))
            : r.events.map((e): JournalEvent => (lost.includes(e.seq) ? { type: 'gap', from: e.seq, to: e.seq, reason: 'store-failed', seq: e.seq, ts: e.ts } : e));
        return { ...r, events };
      };
      assert.equal((await f.manager.waitFor({ pattern: '^ERROR' }, 300, 0)).matched, true, 'the title open before the hole took the line after it');
      assert.equal((await f.manager.waitFor({ pattern: 'abcdef' }, 150, 0)).matched, false, 'no line is joined across the hole');
      assert.equal((await f.manager.waitFor({ pattern: '^def' }, 300, 0)).matched, true);
      assert.equal((await f.manager.waitFor({ pattern: '^ready $' }, 300, 0)).matched, true, 'the line open before the hole is a line of its own');
    } finally {
      f.journal.since = since;
      f.close();
    }
  });
}

test('a gap recorded after its hole splits no line the replay reads past it (the house’s read of the 40 commits over our fixes, #22)', async () => {
  // A catch-up records a healed stretch's gap at a new seq, maybe in the middle of a line the shell is
  // printing; the hole itself showed where it lay. The live feed passes such a gap by, and so does the replay.
  const f = bare();
  try {
    f.startRun('r');
    f.out('abc', 'r');
    f.journal.append({ type: 'gap', from: 1, to: 1, reason: 'store-failed' });
    f.out('def\n', 'r');
    assert.equal((await f.manager.waitFor({ pattern: 'abcdef' }, 300, 0)).matched, true);
  } finally {
    f.close();
  }
});
