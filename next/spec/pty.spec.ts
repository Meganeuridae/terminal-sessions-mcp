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
import { findBash, groupStillOurs, NodePtyBackend } from '../src/backends/node-pty.js';
import type { PtyExit } from '../src/backends/types.js';
import { Journal } from '../src/core/journal.js';
import { Session } from '../src/core/session.js';
import type { JournalEvent } from '../src/core/types.js';
import { prepareIntegration } from '../src/shell/integration.js';
import { AGENT, hasShell, until } from './fake-shell.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pty-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
// Python's independent close_fds control excludes even descriptors inherited from the CI runner
// before this Node process started. Without python3 (the house's read: the whole file failed to
// load there), a plain child's listing stands in, and inherited handles would show in it.
const cleanChildFds = (() => {
  try {
    return execFileSync('python3', ['-c', "import subprocess; print(subprocess.check_output(['ls', '/dev/fd'], close_fds=True, text=True), end='')"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).sort();
  } catch {
    return execFileSync('ls', ['/dev/fd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).sort();
  }
})();

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

async function real(shell: string, backend: NodePtyBackend = new NodePtyBackend()): Promise<{ session: Session; journal: Journal }> {
  const id = `real-${++n}`;
  const integ = prepareIntegration(shell, { noUserRc: true, dir: path.join(tmp, `integration-${id}`) });
  const journal = new Journal();
  const so: Parameters<typeof Session.start>[0] = {
    id,
    owner: AGENT,
    shell,
    cwd: tmp,
    backend,
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

test('process cleanup ignores ambient bash startup code, for argv and line Runs', async () => {
  const startup = path.join(tmp, 'unexpected-startup.sh');
  fs.writeFileSync(startup, 'printf unexpected-startup >&2; exit 61\n');
  const backend = new NodePtyBackend();
  for (const command of [
    { argv: [process.execPath, '-e', "process.stdout.write('safe')"] },
    { argv: ['/bin/sh'], line: 'printf safe' },
  ]) {
    const child = backend.spawnProcess({ ...command, cwd: tmp, env: { BASH_ENV: startup, PATH: '/no-toolchain' } });
    let stdout = '', stderr = '';
    child.onStdout((s) => { stdout += s; });
    child.onStderr((s) => { stderr += s; });
    const exit = await new Promise<{ exitCode: number | null }>((resolve) => child.onExit(resolve));
    assert.deepEqual([exit.exitCode, stdout, stderr], [0, 'safe', '']);
  }
});

async function runWait(s: Session, line: string, wait = 5000) {
  const a = await s.admitWhenAvailable({ target: 'shell', line, principal: AGENT });
  assert.ok(a.admitted, `admitted: ${JSON.stringify(a)}`);
  return s.awaitRun(a.run.runId, wait);
}

for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  test(`${shell}: G5 rich integration is observed and the shell is available at start`, async () => {
    const { session, journal } = await real(shell);
    try {
      const startupOutput = () => journal.since(0).events.filter((e) => e.type === 'output').map((e) => (e as { data: string }).data).join('');
      assert.equal(session.integration, 'rich', `startup output: ${JSON.stringify(startupOutput())}`);
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
    // Only standard streams and the descriptor ls opens to read /dev/fd remain.
    assert.deepEqual(out.trim().split(/\s+/).filter(Boolean).sort(), cleanChildFds, `descriptors open in a process Run: ${out.trim()}`);
    // Resolving a relative executable uses the Run's cwd; a relative/empty PATH component
    // does too. Those successful launches need the same descriptor cleanup as absolute argv.
    const relative = path.join(tmp, 'relative-fds.sh');
    fs.writeFileSync(relative, '#!/bin/sh\n/bin/ls /dev/fd\n', { mode: 0o700 });
    for (const command of [
      { argv: ['./relative-fds.sh'], env: {} },
      { argv: ['relative-fds.sh'], env: { PATH: '' } },
      { argv: ['ls', '/dev/fd'], env: {} },
    ]) {
      const child = new NodePtyBackend().spawnProcess({ ...command, cwd: tmp });
      let text = '';
      child.onStdout((d) => { text += d; });
      const exit = await new Promise<{ exitCode: number | null }>((resolve) => child.onExit(resolve));
      assert.equal(exit.exitCode, 0);
      assert.deepEqual(text.trim().split(/\s+/).sort(), cleanChildFds, JSON.stringify(command));
    }
    // The line's text arrives on a descriptor, not in the shell's argv: a pkill -f for a word of the line
    // finds nothing but pkill itself, which it skips, and the line goes on.
    const own = a.session.admit({ target: 'process', line: "pkill -f 'qz7-relaunch' >/dev/null 2>&1; echo after-the-pkill qz7-relaunch", principal: AGENT });
    assert.ok(own.admitted);
    const r2 = await a.session.awaitRun(own.run.runId, 5000);
    assert.deepEqual([r2.state, r2.exit], ['exited', 0]);
    const out2 = a.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === r2.runId).map((e) => e.data).join('');
    assert.equal(out2.trim(), 'after-the-pkill qz7-relaunch');
    assert.deepEqual(r2.argv, ['/bin/sh'], 'the text reaches the shell on a descriptor, not on any command line or in a file');
    // The descriptor the text came on is closed before the command's children run, and so are
    // the daemon's: the command sees only what a directly spawned `ls /dev/fd` would.
    const fds3 = a.session.admit({ target: 'process', line: 'ls /dev/fd | tr "\\n" " "', principal: AGENT });
    assert.ok(fds3.admitted);
    const r3 = await a.session.awaitRun(fds3.run.runId, 5000);
    const out3 = a.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === r3.runId).map((e) => e.data).join('');
    assert.deepEqual(out3.trim().split(/\s+/).filter(Boolean).sort(), cleanChildFds, `descriptors open in a line's command: ${out3.trim()}`);
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
  // No process of the group's id: the members are the Run's orphans (the kernel keeps the pid while they live).
  assert.equal(groupStillOurs(4242, () => false), true);
  // The leader has already been reaped: even an immediately reused pid belongs to a stranger.
  assert.equal(groupStillOurs(4242, () => true), false);
  // Nothing can list processes: nothing is signalled.
  assert.equal(groupStillOurs(4242, () => undefined), false);
});

test('/bin/bash: a process Run that leaves a child in the background says so (leftovers); cancel on the ended Run ends the child', async () => {
  const { session, journal } = await real('/bin/bash');
  try {
    const clean = session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'echo alone'], principal: AGENT });
    assert.ok(clean.admitted);
    const r0 = await session.awaitRun(clean.run.runId, 5000);
    assert.deepEqual([r0.state, r0.exit, r0.leftovers], ['exited', 0, undefined], 'nothing left behind: no flag');
    const a = session.admit({ target: 'process', argv: ['/bin/sh', '-c', 'sleep 30 & echo started'], principal: AGENT });
    assert.ok(a.admitted);
    const r = await session.awaitRun(a.run.runId, 5000);
    assert.deepEqual([r.state, r.exit, r.leftovers], ['exited', 0, true], 'the sleep is still in the group');
    const end = journal.since(0).events.find((e) => e.type === 'run.end' && e.runId === r.runId) as Extract<JournalEvent, { type: 'run.end' }>;
    assert.equal(end.leftovers, true, 'journaled, so a reader of the history sees it too');
    // The group is still the Run's: cancel on the ended Run reaches it (ss-10). (A live Run's
    // RunInfo carries no pgid; run.start does.)
    const start = journal.since(0).events.find((e) => e.type === 'run.start' && e.runId === r.runId) as Extract<JournalEvent, { type: 'run.start' }>;
    assert.ok(start.pgid !== undefined && groupLives(start.pgid), 'the child keeps the group alive after the Run ended');
    const c = await session.cancel(r.runId, AGENT);
    assert.ok(c.steps.length > 0, JSON.stringify(c));
    await until(() => !groupLives(start.pgid!), 3000, 'the group to end');
    // A cancelled Run never carries the flag: its cancel keeps signalling the group after the leader's exit.
    const stubborn = session.admit({ target: 'process', argv: ['/bin/sh', '-c', "(trap '' INT; exec sleep 30) & exec sleep 30"], principal: AGENT });
    assert.ok(stubborn.admitted);
    await until(() => session.run(stubborn.run.runId).state === 'running', 3000);
    const cancelled = await session.cancel(stubborn.run.runId, AGENT);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(session.run(stubborn.run.runId).leftovers, undefined, 'the cancel\'s own result says what it reached');
  } finally {
    await session.close();
  }
});

function groupLives(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

test('bash is a checked requirement for process Runs: found at /bin/bash or on PATH; without it termd refuses process Runs with the reason, and shell Runs go on', async () => {
  // The finder: the standard path first, then PATH; nothing found is undefined.
  const bin = path.join(tmp, 'nix-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(findBash(`/nonexistent:${bin}`, path.join(tmp, 'no-such-bash')), path.join(bin, 'bash'));
  assert.equal(findBash('/nonexistent', path.join(tmp, 'no-such-bash')), undefined);
  assert.equal(findBash(process.env.PATH, '/bin/bash'), '/bin/bash', 'this host has it where the launcher looks first');
  // A host without bash: the backend says so once, the daemon logs it at startup, and a process Run is refused, not lost.
  const without = new NodePtyBackend({ bash: null });
  const support = without.processSupport();
  assert.ok(!support.ok && /need bash/.test(support.reason), JSON.stringify(support));
  assert.throws(() => without.spawnProcess({ argv: ['/bin/true'], cwd: tmp, env: {} }), (e: { code?: string }) => e.code === 'unsupported');
  const { session } = await real('/bin/bash', without);
  try {
    assert.throws(() => session.admit({ target: 'process', argv: ['/bin/true'], principal: AGENT }), (e: { code?: string; message: string }) => e.code === 'unsupported' && /need bash/.test(e.message));
    assert.equal(session.listRuns().filter((r) => r.target === 'process').length, 0, 'nothing was admitted to end lost');
    const r = await runWait(session, 'echo shell-still-works');
    assert.deepEqual([r.state, r.exit], ['exited', 0]);
  } finally {
    await session.close();
  }
});

test('a later session’s shell holds no earlier session’s terminal master: the launcher closes what the daemon leaks to it', { skip: process.platform !== 'linux' ? 'readlink of /dev/fd entries needs /proc' : false }, async () => {
  const a = await real('/bin/bash');
  const b = await real('/bin/bash');
  const textOf = (j: Journal, runId: string) => j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.runId === runId).map((e) => e.data).join('');
  try {
    const held = await runWait(b.session, "for f in /dev/fd/*; do readlink \"$f\"; done 2>/dev/null | grep -c ptmx || true");
    assert.match(textOf(b.journal, held.runId), /(^|\n)0\r?\n/, 'the second shell holds no pty master (the first session’s, before this change)');
    const heldA = await runWait(a.session, "for f in /dev/fd/*; do readlink \"$f\"; done 2>/dev/null | grep -c ptmx || true");
    assert.match(textOf(a.journal, heldA.runId), /(^|\n)0\r?\n/);
  } finally {
    await a.session.close();
    await b.session.close();
  }
});

test('a command the kernel could not execute is never spawned: the handle reports the spawn error, naming a missing interpreter; a relative argv through a symlinked cwd still gets the descriptor cleanup', async () => {
  const backend = new NodePtyBackend();
  const missing = await new Promise<PtyExit>((resolve) => backend.spawnProcess({ argv: ['./no-such-tool'], cwd: tmp, env: {} }).onExit(resolve));
  assert.match(missing.spawnError ?? '', /^ENOENT spawn \.\/no-such-tool/);
  const noInterp = path.join(tmp, 'no-interp.sh');
  fs.writeFileSync(noInterp, '#!/nonexistent/interp\necho never\n', { mode: 0o755 });
  const interp = await new Promise<PtyExit>((resolve) => backend.spawnProcess({ argv: [noInterp], cwd: tmp, env: {} }).onExit(resolve));
  assert.match(interp.spawnError ?? '', /ENOENT .*its interpreter \/nonexistent\/interp is missing/);
  const notExec = path.join(tmp, 'not-exec.sh');
  fs.writeFileSync(notExec, 'echo never\n', { mode: 0o644 });
  const eacces = await new Promise<PtyExit>((resolve) => backend.spawnProcess({ argv: [notExec], cwd: tmp, env: {} }).onExit(resolve));
  assert.match(eacces.spawnError ?? '', /^EACCES spawn /);
  // The cwd is a symlink: `../bin/tool` resolves against the real directory, as the kernel does, so
  // the preflight says yes and the tool runs through the launcher (clean descriptors), not directly.
  fs.mkdirSync(path.join(tmp, 'real', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'real', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'real', 'bin', 'tool'), '#!/bin/sh\n/bin/ls /dev/fd\n', { mode: 0o755 });
  const link = path.join(tmp, 'link-to-sub');
  fs.symlinkSync(path.join(tmp, 'real', 'sub'), link);
  let text = '';
  const child = backend.spawnProcess({ argv: ['../bin/tool'], cwd: link, env: {} });
  child.onStdout((d) => (text += d));
  const exit = await new Promise<PtyExit>((resolve) => child.onExit(resolve));
  assert.equal(exit.exitCode, 0, JSON.stringify(exit));
  assert.deepEqual(text.trim().split(/\s+/).sort(), cleanChildFds, 'through the launcher: only the standard descriptors');
});

test('the launcher’s loop variable does not replace a caller’s `f`', async () => {
  const backend = new NodePtyBackend();
  let text = '';
  const child = backend.spawnProcess({ argv: ['/bin/sh'], line: 'printf %s "$f"', cwd: tmp, env: { f: 'from-the-caller', PATH: '/usr/bin:/bin' } });
  child.onStdout((d) => (text += d));
  const exit = await new Promise<PtyExit>((resolve) => child.onExit(resolve));
  assert.deepEqual([exit.exitCode, text], [0, 'from-the-caller']);
});
