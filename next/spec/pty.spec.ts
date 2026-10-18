/**
 * The guarantee suite against real shells. macOS ships bash 3.2 at /bin/bash,
 * zsh at /bin/zsh, and /bin/sh; the marker fallback is exercised through sh.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { groupStillOurs, NodePtyBackend } from '../src/backends/node-pty.js';
import { Journal } from '../src/core/journal.js';
import { Session } from '../src/core/session.js';
import type { JournalEvent } from '../src/core/types.js';
import { prepareIntegration } from '../src/shell/integration.js';
import { AGENT, hasShell, until } from './fake-shell.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pty-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

test('process output is streaming UTF-8 text with separate stderr, including invalid-byte replacement', async () => {
  const backend = new NodePtyBackend();
  const child = backend.spawnProcess({
    argv: [process.execPath, '-e', "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => { process.stdout.write(Buffer.from([0x82,0xac,0x80,0xff])); process.stderr.write('separate'); }, 30)"],
    cwd: tmp, env: {},
  });
  let stdout = '', stderr = '';
  child.onStdout((s) => { stdout += s; });
  child.onStderr((s) => { stderr += s; });
  await new Promise<void>((resolve) => child.onExit(() => resolve()));
  assert.equal(stdout, '€\ufffd\ufffd');
  assert.equal(stderr, 'separate');
});

async function real(shell: string): Promise<{ session: Session; journal: Journal }> {
  const id = `real-${++n}`;
  const integ = prepareIntegration(shell, { noUserRc: true, dir: path.join(tmp, `integration-${id}`) });
  const journal = new Journal();
  const so: Parameters<typeof Session.start>[0] = {
    id,
    owner: AGENT,
    shell,
    cwd: tmp,
    backend: new NodePtyBackend(),
    journal,
    integrationGraceMs: 4000,
    tempDir: tmp,
    env: { TSM_MARK: 'present' },
  };
  if (integ.kind !== 'none') so.integration = integ;
  const session = await Session.start(so);
  session.attach(AGENT, 'c1');
  return { session, journal };
}

async function runWait(s: Session, line: string, wait = 5000) {
  const a = await s.admitWhenAvailable({ target: 'shell', line, principal: AGENT });
  assert.ok(a.admitted, `admitted: ${JSON.stringify(a)}`);
  return s.awaitRun(a.run.runId, wait);
}

for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  test(`${shell}: G5 rich integration is observed and the shell is available at start`, async () => {
    const { session } = await real(shell);
    try {
      assert.equal(session.integration, 'rich');
      assert.equal(session.state, 'idle');
      assert.ok(session.shellAvailable().ok);
    } finally {
      await session.close();
    }
  });

  test(`${shell}: G1/G2/G6/G12 shell Runs report observed exits, keep cwd, and carry a clean transcript`, async () => {
    const { session } = await real(shell);
    try {
      const r = await runWait(session, 'echo hello');
      assert.equal(r.state, 'exited');
      assert.equal(r.exit, 0);
      assert.equal(r.line, 'echo hello');
      assert.equal((await session.runTranscript(r.runId)).text, 'hello');
      assert.equal((await runWait(session, 'sh -c "exit 42"')).exit, 42);
      await runWait(session, 'cd /tmp');
      await session.waitAvailable(2000); // the cwd mark rides with the next prompt
      assert.equal(session.cwd, '/tmp');
      await runWait(session, 'export TSM_LATER=1');
      const seen = await runWait(session, 'echo "$TSM_LATER-$TSM_MARK"');
      assert.equal((await session.runTranscript(seen.runId)).text, '1-present', 'shell state persists');
      const heredoc = await runWait(session, 'cat <<EOF\nline-one\nline-two\nEOF');
      assert.equal(heredoc.exit, 0);
      assert.equal((await session.runTranscript(heredoc.runId)).text, 'line-one\nline-two');
    } finally {
      await session.close();
    }
  });

  test(`${shell}: a command typed through input becomes a Run attributed to the typer`, async () => {
    const { session } = await real(shell);
    try {
      session.input('echo typed\n', { principal: AGENT });
      await until(() => session.listRuns().some((r) => r.line === 'echo typed' && r.state === 'exited'));
      const r = session.listRuns().find((x) => x.line === 'echo typed')!;
      assert.equal(r.origin, 'agent');
      assert.equal(r.principal, AGENT);
      assert.equal(r.exit, 0);
      assert.equal((await session.runTranscript(r.runId)).text, 'typed');
    } finally {
      await session.close();
    }
  });

  test(`${shell}: G3 a stdin reader stays running across the caller's wait; input completes it`, async () => {
    const { session } = await real(shell);
    try {
      const a = session.admit({ target: 'shell', line: 'read x; echo "got:$x"', principal: AGENT });
      assert.ok(a.admitted);
      const r1 = await session.awaitRun(a.run.runId, 300);
      assert.equal(r1.state, 'running');
      session.input('value\n', { principal: AGENT });
      const r2 = await session.awaitRun(a.run.runId, 3000);
      assert.equal(r2.state, 'exited');
      assert.equal(r2.exit, 0);
      assert.match((await session.runTranscript(r2.runId)).text, /got:value/);
    } finally {
      await session.close();
    }
  });

  test(`${shell}: G29 shell cancel types ^C and reports cancelled on the end mark`, async () => {
    const { session } = await real(shell);
    try {
      const a = session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
      assert.ok(a.admitted);
      await session.awaitRun(a.run.runId, 100);
      const c = await session.cancel(a.run.runId, AGENT, { graceMs: 1500 });
      assert.equal(c.contract, 'shell');
      assert.equal(c.state, 'cancelled');
      assert.equal(session.run(a.run.runId).exit, 130);
      assert.ok(await session.waitAvailable(2000), 'prompt came back');
    } finally {
      await session.close();
    }
  });

  test(`${shell}: G3/G20 shell death makes the in-flight Run lost, and close is fast`, async () => {
    const { session } = await real(shell);
    try {
      const a = session.admit({ target: 'shell', line: 'exit', principal: AGENT });
      assert.ok(a.admitted);
      const r = await session.awaitRun(a.run.runId, 3000);
      assert.equal(r.state, 'lost');
      assert.match(String(r.reason), /^shell-exited \((status \d+|SIG[A-Z]+)\)$/, 'the reason carries how the shell ended');
      assert.equal(session.state, 'exited');
    } finally {
      await session.close();
    }
    const other = await real(shell);
    const t0 = Date.now();
    await other.session.close();
    assert.ok(Date.now() - t0 < 2000, `graceful close took ${Date.now() - t0}ms`);
  });
}

test('/bin/bash: G7 process Runs are exact, separate streams, and can use a captured environment', async () => {
  const { session, journal } = await real('/bin/bash');
  try {
    const a = session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'echo out; echo err 1>&2; exit 3'], principal: AGENT });
    assert.ok(a.admitted);
    const r = await session.awaitRun(a.run.runId, 5000);
    assert.equal(r.state, 'exited');
    assert.equal(r.exit, 3);
    assert.equal(r.attribution, 'exact');
    const evs = journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === r.runId);
    assert.deepEqual(evs.map((e) => [e.stream, e.data]), [['stdout', 'out\n'], ['stderr', 'err\n']]);
    // Configured basis does not see the shell's later export; a snapshot does.
    await runWait(session, 'export TSM_SNAP=yes');
    const c1 = session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'echo "[$TSM_SNAP]"'], principal: AGENT });
    // (process Runs never wait on the shell: admitted even while its prompt is pending)
    assert.ok(c1.admitted);
    const r1 = await session.awaitRun(c1.run.runId, 5000);
    assert.equal(r1.envBasis, 'configured');
    assert.equal((await session.runTranscript(r1.runId)).text, '[]');
    const snap = await session.captureEnv(AGENT);
    assert.equal(snap.vars.TSM_SNAP, 'yes');
    assert.ok(snap.vars.PATH);
    const c2 = session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'echo "[$TSM_SNAP]"'], principal: AGENT, envBasis: 'snapshot' });
    assert.ok(c2.admitted);
    const r2 = await session.awaitRun(c2.run.runId, 5000);
    assert.equal(r2.envBasis, 'snapshot');
    assert.equal((await session.runTranscript(r2.runId)).text, '[yes]');
  } finally {
    await session.close();
  }
});

test('/bin/bash: G29 process cancel observes the exit under the signal that took it', async () => {
  const { session } = await real('/bin/bash');
  try {
    const a = session.admit({ target: 'process', argv: ['sleep', '30'], principal: AGENT });
    assert.ok(a.admitted);
    await session.awaitRun(a.run.runId, 100);
    const c = await session.cancel(a.run.runId, AGENT, { graceMs: 1000 });
    assert.equal(c.contract, 'process');
    assert.equal(c.state, 'cancelled');
    assert.equal(session.run(a.run.runId).signal, 'SIGINT');
  } finally {
    await session.close();
  }
});

test('/bin/bash: G14 the current screen shows the prompt and output without touching the shell', async () => {
  const { session } = await real('/bin/bash');
  try {
    const r = await runWait(session, 'echo on-screen');
    await session.screen.settled();
    const snap = session.snapshot();
    assert.ok(snap.lines.some((l) => l.includes('on-screen')), JSON.stringify(snap.lines));
    assert.equal(snap.alt, false);
    assert.ok(snap.seq >= r.seq.end!);
  } finally {
    await session.close();
  }
});

test('/bin/sh: G5 fallback — no integration, marker strategy, observed exits, clean transcripts', async () => {
  const { session } = await real('/bin/sh');
  try {
    assert.equal(session.integration, 'none');
    const r = await runWait(session, 'echo via-marker');
    assert.equal(r.state, 'exited');
    assert.equal(r.exit, 0);
    const t = await session.runTranscript(r.runId);
    assert.equal(t.text, 'via-marker');
    assert.ok(!t.text.includes('<<<EXIT'));
    assert.equal((await runWait(session, 'false')).exit, 1);
    assert.equal((await runWait(session, 'sh -c "exit 5"')).exit, 5);
    // `exit` in a shell Run exits the session's shell — that is what a persistent shell means.
  } finally {
    await session.close();
  }
});

test('/bin/bash: a process Run inherits no terminal master, and its line is not in any argv', async () => {
  // Two sessions open: before, a process Run in either held both terminals' masters.
  const a = await real('/bin/bash');
  const b = await real('/bin/bash');
  try {
    const fds = a.session.admit({ target: 'process', line: 'ls /dev/fd | tr "\\n" " "', principal: AGENT });
    assert.ok(fds.admitted);
    const r = await a.session.awaitRun(fds.run.runId, 5000);
    assert.equal(r.state, 'exited');
    const out = a.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === r.runId).map((e) => e.data).join('');
    // Exactly what `ls /dev/fd` has when this test process spawns it directly (0, 1, 2 and the
    // descriptors ls opens to read /dev/fd): nothing of the daemon's. On Linux the daemon's
    // children inherited every session's terminal master before the launcher closed them.
    const baseline = execFileSync('ls', ['/dev/fd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).sort();
    assert.deepEqual(out.trim().split(/\s+/).filter(Boolean).sort(), baseline, `descriptors open in a process Run: ${out.trim()}`);
    // The line's text is in a file, not in the shell's argv: a pkill -f for a word of the line
    // finds nothing but pkill itself, which it skips, and the line goes on.
    const own = a.session.admit({ target: 'process', line: "pkill -f 'qz7-relaunch' >/dev/null 2>&1; echo after-the-pkill qz7-relaunch", principal: AGENT });
    assert.ok(own.admitted);
    const r2 = await a.session.awaitRun(own.run.runId, 5000);
    assert.deepEqual([r2.state, r2.exit], ['exited', 0]);
    const out2 = a.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === r2.runId).map((e) => e.data).join('');
    assert.equal(out2.trim(), 'after-the-pkill qz7-relaunch');
    assert.deepEqual(r2.argv, ['/bin/sh', '/dev/fd/3'], 'the text reaches the shell on a descriptor, not on any command line or in a file');
    // The descriptor the text came on is closed before the command's children run, and so are
    // the daemon's: the command sees only what a directly spawned `ls /dev/fd` would.
    const fds3 = a.session.admit({ target: 'process', line: 'ls /dev/fd | tr "\\n" " "', principal: AGENT });
    assert.ok(fds3.admitted);
    const r3 = await a.session.awaitRun(fds3.run.runId, 5000);
    const out3 = a.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === r3.runId).map((e) => e.data).join('');
    assert.deepEqual(out3.trim().split(/\s+/).filter(Boolean).sort(), baseline, `descriptors open in a line's command: ${out3.trim()}`);
    // A long line arrives whole: more than a pipe buffer's worth.
    const big = a.session.admit({ target: 'process', line: `x='${'y'.repeat(100000)}'; echo "len=\${#x}"`, principal: AGENT });
    assert.ok(big.admitted);
    const rb = await a.session.awaitRun(big.run.runId, 8000);
    assert.equal(a.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === rb.runId).map((e) => e.data).join('').trim(), 'len=100000');
    // The group leader is the command's own shell (exec keeps the pid): cancel reaches it.
    const slow = a.session.admit({ target: 'process', line: 'sleep 30', principal: AGENT });
    assert.ok(slow.admitted);
    await until(() => a.session.run(slow.run.runId).state === 'running', 3000);
    const c = await a.session.cancel(slow.run.runId, AGENT);
    assert.equal(c.state, 'cancelled');
  } finally {
    await a.session.close({ graceful: false });
    await b.session.close({ graceful: false });
  }
});

test('a process group whose leader exited is signalled only while it is still the Run\'s: orphans are, a stranger given the freed pid is not, and nothing is when nothing can say', () => {
  const spawnedAt = 1_700_000_000_000;
  const row = (startMs: number) => ({ pid: 4242, pgid: 4242, startMs, zombie: false });
  // No process of the group's id: the members are the Run's orphans (the kernel keeps the pid while they live).
  assert.equal(groupStillOurs(4242, spawnedAt, () => null), true);
  // Our own leader, by its start time (ps truncates to the second).
  assert.equal(groupStillOurs(4242, spawnedAt, () => row(spawnedAt - 900)), true);
  assert.equal(groupStillOurs(4242, spawnedAt, () => row(spawnedAt + 900)), true);
  // A stranger started later with the freed pid, or long before it: not ours.
  assert.equal(groupStillOurs(4242, spawnedAt, () => row(spawnedAt + 60_000)), false);
  assert.equal(groupStillOurs(4242, spawnedAt, () => row(spawnedAt - 60_000)), false);
  // Nothing can list processes: nothing is signalled.
  assert.equal(groupStillOurs(4242, spawnedAt, () => undefined), false);
});
