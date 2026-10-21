/**
 * G29 against real shells: cancel of a queued Run, of a Run the shell may not have
 * started yet (no delay after admit), of a running job, of jobs that ignore ^C and
 * ^\, of a process Run whose group outlives its leader, and of a marker-strategy Run
 * whose ^C aborts the marker echo (dash). Every cancel leaves the shell usable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, hasShell, pgrep, realSession, reap, until } from './fake-shell.js';

for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  test(`${shell}: G29 (core-4, tg-6): cancelling a queued Run leaves the Run ahead running and never runs the line`, async () => {
    const x = await realSession(shell);
    try {
      const first = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 1; echo first-done', principal: AGENT });
      const queued = x.session.admit({ target: 'shell', line: 'echo queued-ran', principal: AGENT, queue: true });
      assert.ok(first.admitted && queued.admitted);
      const c = await x.session.cancel(queued.run.runId, AGENT);
      assert.equal(c.state, 'cancelled');
      assert.deepEqual(c.steps, ['removed from the queue']);
      const r = await x.session.awaitRun(first.run.runId, 5000);
      assert.equal(r.state, 'exited', 'the Run ahead was not interrupted');
      assert.equal(r.exit, 0);
      assert.equal((await x.session.runTranscript(r.runId)).text, 'first-done');
      assert.equal((await x.run('echo after')).text, 'after');
      await x.session.screen.settled();
      assert.ok(!x.session.snapshot().lines.some((l) => l.includes('queued-ran')), 'the cancelled line never ran');
    } finally {
      await x.close();
    }
  });

  test(`${shell}: G29 (core-1, tg-3): a cancel issued right after admit never leaves a Run starting or the shell wedged`, async () => {
    const x = await realSession(shell);
    try {
      for (let i = 0; i < 6; i++) {
        const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 5', principal: AGENT }, 3000);
        assert.ok(a.admitted);
        const c = await x.session.cancel(a.run.runId, AGENT);
        assert.equal(c.state, 'cancelled', `round ${i}: ${JSON.stringify(c)}`);
        assert.equal(c.escalation, undefined);
      }
      assert.equal((await x.run('sh -c "exit 3"')).exit, 3, 'the shell is usable');
    } finally {
      await x.close();
    }
  });

  test(`${shell}: G29: jobs that ignore ^C and ^\\ get SIGTERM, then SIGKILL, in their own process group — never the shell`, async () => {
    const x = await realSession(shell);
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: `/bin/bash -c "trap '' INT QUIT; sleep 30"`, principal: AGENT });
      assert.ok(a.admitted);
      await x.session.awaitRun(a.run.runId, 300);
      const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 300 });
      assert.equal(c.state, 'cancelled', JSON.stringify(c));
      assert.equal(c.steps.length, 3);
      assert.deepEqual(c.steps.slice(0, 2), ['^C', '^\\']);
      assert.match(c.steps[2]!, /^SIGTERM → foreground process group \d+$/);
      assert.equal(x.session.run(a.run.runId).exit, 143);
      const b = await x.session.admitWhenAvailable({ target: 'shell', line: `/bin/bash -c "trap '' INT QUIT TERM; sleep 30"`, principal: AGENT });
      assert.ok(b.admitted);
      await x.session.awaitRun(b.run.runId, 300);
      const cb = await x.session.cancel(b.run.runId, AGENT, { graceMs: 300 });
      assert.equal(cb.state, 'cancelled', JSON.stringify(cb));
      assert.match(cb.steps[3] ?? '', /^SIGKILL → foreground process group \d+$/);
      assert.equal(x.session.run(b.run.runId).exit, 137);
      // The end mark precedes the prompt by a few ms (prompt-pending, G5); then the
      // shell — never signalled itself — is back and idle.
      assert.equal(await x.session.waitAvailable(3000), true, 'the shell itself was never signalled');
      assert.ok(await x.session.waitAvailable(2000), 'the prompt confirmed the shell is available');
      assert.equal(x.session.state, 'idle');
      assert.equal((await x.run('echo alive')).text, 'alive');
    } finally {
      await x.close();
    }
  });
}

// The house's read of the 33 commits (#22 comment 6307351617, item 1), by run with bash 5.2: two ^C that
// bring no mark made the shell available at once, the next Run was written, discarded at the prompt the
// shell printed for the ^C when it ran again, and its line ran after its command file was gone. Now the
// shell is busy until it has run an empty line the cancel typed after the ^C.
for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  test(`${shell}: a cancel whose two ^C reach a stopped shell (standing in for one not yet scheduled) keeps it busy until it is back, and a Run admitted right after the cancel still runs`, async () => {
    const x = await realSession(shell, { login: false });
    const pid = x.session.info().pid;
    try {
      await until(() => x.session.shellAvailable().ok, 5000, 'the shell is ready');
      process.kill(pid, 'SIGSTOP');
      const a = x.session.admit({ target: 'shell', line: 'echo first-ran', principal: AGENT });
      assert.ok(a.admitted);
      const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 200 });
      assert.deepEqual([c.state, c.escalation], ['cancelled', undefined], JSON.stringify(c));
      assert.deepEqual(x.session.shellAvailable(), { ok: false, reason: 'prompt-pending' }, 'nothing says the shell acted on the ^C');
      const b = x.session.admit({ target: 'shell', line: 'echo second-$((40+2))', principal: AGENT, queue: true });
      assert.ok(b.admitted && b.run.state === 'queued', JSON.stringify(b));
      process.kill(pid, 'SIGCONT');
      const r = await x.session.awaitRun(b.run.runId, 8000);
      assert.deepEqual([r.state, r.exit, r.reason], ['exited', 0, undefined], JSON.stringify(r));
      assert.equal((await x.session.runTranscript(r.runId)).text, 'second-42');
      assert.deepEqual([x.session.run(a.run.runId).state, x.session.run(a.run.runId).reason], ['cancelled', 'cancelled-before-start']);
    } finally {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        // gone
      }
      await x.close();
    }
  });
}

test('/bin/bash: a cancel whose two ^C a DEBUG trap of the user’s ignores, before the start mark, keeps the shell busy until it is back, and a Run admitted right after the cancel still runs', { skip: !hasShell('/bin/bash') }, async () => {
  // The integration's DEBUG hook runs the user's trap before it prints the start mark; here that trap
  // is a subshell that ignores ^C, for daemon lines only (the house's second way to reach item 1).
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': `trap 'case $BASH_COMMAND in *tsm-cmd*) ( trap "" INT; sleep 1 ) ;; esac' DEBUG\n` } });
  const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
  try {
    await until(() => x.session.shellAvailable().ok, 5000, 'the shell is ready');
    const a = x.session.admit({ target: 'shell', line: 'echo first-$((6*7))', principal: AGENT });
    assert.ok(a.admitted);
    const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 200 });
    assert.deepEqual([c.state, c.escalation], ['cancelled', undefined], JSON.stringify(c));
    const b = x.session.admit({ target: 'shell', line: 'echo second-$((40+2))', principal: AGENT, queue: true });
    assert.ok(b.admitted && b.run.state === 'queued', JSON.stringify(b));
    const r = await x.session.awaitRun(b.run.runId, 10_000);
    assert.deepEqual([r.state, r.exit, r.reason], ['exited', 0, undefined], JSON.stringify(r));
    assert.equal((await x.session.runTranscript(r.runId)).text, 'second-42');
    assert.doesNotMatch(output(), /first-42/, 'the cancelled line’s command never ran');
  } finally {
    await x.close();
  }
});

test('/bin/bash: G29 (tg-12): a process cancel signals the group until it is empty, even after the leader exits', async () => {
  const x = await realSession('/bin/bash');
  try {
    // `&` jobs of a non-interactive sh ignore SIGINT: the leader dies, 301.25 stays.
    const a = x.session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'sleep 301.25 & sleep 302.25; wait'], principal: AGENT });
    assert.ok(a.admitted);
    await x.session.awaitRun(a.run.runId, 300);
    // (Anchored: `pgrep -f` would also match the `sh -c` command line that contains it.)
    assert.equal(pgrep('^sleep 301\\.25').length, 1);
    const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 300 });
    assert.equal(c.state, 'cancelled');
    assert.deepEqual(c.steps, ['SIGINT → process group', 'SIGTERM → process group']);
    assert.deepEqual(pgrep('^sleep 301\\.25'), [], 'no member of the group survived');
    // A process Run's stdin is /dev/null: a reader sees EOF instead of hanging (core-12).
    const cat = x.session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'cat; echo cat-done'], principal: AGENT });
    assert.ok(cat.admitted);
    const r = await x.session.awaitRun(cat.run.runId, 3000);
    assert.equal(r.state, 'exited');
    assert.equal((await x.session.runTranscript(r.runId)).text, 'cat-done');
    // A spawn failure is lost with the reason, with no invented signal (core-15).
    const bad = x.session.admit({ target: 'process', argv: ['/nonexistent/binary'], principal: AGENT });
    assert.ok(bad.admitted);
    const rb = await x.session.awaitRun(bad.run.runId, 3000);
    assert.equal(rb.state, 'lost');
    assert.match(rb.reason ?? '', /^spawn-failed: ENOENT/);
    assert.equal(rb.signal, undefined);
  } finally {
    await x.close();
    reap('sleep 30[12].25');
  }
});

test('/bin/bash: G19/G29 (core-11): close waits for a process Run that ignores SIGINT; nothing outlives the session', async () => {
  const x = await realSession('/bin/bash');
  const a = x.session.admit({ target: 'process', argv: ['/bin/sh', '-c', "trap '' INT; exec sleep 97.25"], principal: AGENT });
  assert.ok(a.admitted);
  await x.session.awaitRun(a.run.runId, 300);
  const n = x.journal.lastSeq;
  await x.close();
  try {
    assert.equal(x.session.run(a.run.runId).state, 'cancelled');
    assert.equal(x.session.run(a.run.runId).reason, 'session-closed');
    assert.deepEqual(pgrep('sleep 97.25'), [], 'the process did not outlive the session');
    const after = x.journal.lastSeq;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(x.journal.lastSeq, after, 'nothing is journaled after close resolves');
    assert.ok(after > n);
  } finally {
    reap('sleep 97.25');
  }
});

test('/bin/dash: G29 (core-6): a ^C that aborts the marker echo is resolved once the shell is back at its prompt', { skip: !hasShell('/bin/dash') }, async () => {
  const x = await realSession('/bin/dash');
  try {
    assert.equal(x.session.integration, 'none');
    const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(a.admitted);
    assert.equal(x.session.state, 'busy', 'a marker Run occupies the shell (core-8)');
    await x.session.awaitRun(a.run.runId, 300);
    const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 400 });
    assert.equal(c.state, 'cancelled', JSON.stringify(c));
    assert.equal(c.escalation, undefined);
    assert.ok(c.steps.includes('end-marker probe'), JSON.stringify(c.steps));
    // ss-5: the probe's $? is its own line's; the Run's exit stays unobserved (G2, G3).
    assert.equal(x.session.run(a.run.runId).exit, undefined);
    const r = await x.run('echo after');
    assert.equal(r.state, 'exited');
    assert.equal(r.text, 'after');
  } finally {
    await x.close();
  }
});

for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  test(`${shell}: G19 close: what the shell forked outside any job ends with it; a pending command substitution does not stall the hangup (core-17: no timer outlives close)`, async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const baseline = timers();
    // A command substitution's child is in the shell's own process group; bash defers
    // its hangup until that child ends.
    const x = await realSession(shell);
    const a = await x.session.admitWhenAvailable({ target: 'shell', line: ': $(sleep 32.75)', principal: AGENT });
    assert.ok(a.admitted);
    await x.session.awaitRun(a.run.runId, 300);
    const t0 = Date.now();
    await x.session.close();
    assert.ok(Date.now() - t0 < 1500, `close took ${Date.now() - t0} ms`);
    assert.ok(timers() <= baseline, 'close left no timer keeping the event loop alive');
    await x.close();
    // One that ignores the hangup does not outlive the session either.
    const y = await realSession(shell);
    try {
      const b = await y.session.admitWhenAvailable({ target: 'shell', line: ": $(trap '' HUP; sleep 33.75)", principal: AGENT });
      assert.ok(b.admitted);
      await y.session.awaitRun(b.run.runId, 300);
      assert.equal(pgrep('^sleep 33\\.75').length, 1);
      await y.session.close({ timeoutMs: 800 });
      assert.deepEqual(pgrep('^sleep 3[23]\\.75'), [], 'nothing the shell forked outlived it');
      assert.equal(y.session.run(b.run.runId).state, 'lost');
    } finally {
      await y.close();
      reap('sleep 3[23].75');
    }
  });
}

for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  test(`${shell}: closing a session hangs up its foreground job (bash 3.2 does not pass SIGHUP on to a job started from a sourced file)`, async () => {
    const x = await realSession(shell);
    const n = `4${String(process.pid % 10000).padStart(4, '0')}.5`;
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: `sleep ${n}`, principal: AGENT });
      assert.ok(a.admitted);
      const end = Date.now() + 3000;
      while (!pgrep(`^sleep ${n}`).length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.equal(pgrep(`^sleep ${n}`).length, 1, 'the job is running');
    } finally {
      await x.close();
    }
    await new Promise((r) => setTimeout(r, 200));
    const left = pgrep(`^sleep ${n}`);
    reap(`^sleep ${n}`);
    assert.deepEqual(left, [], 'no foreground job outlives its session');
  });
}
