/**
 * Regression tests for timeout/teardown fixes:
 * - client request timeouts must always exceed the server-side wait
 * - graceful killSession must not burn its full fallback timeout
 * - session creation waits for the shell, not a fixed sleep
 * - a graceful kill ends the jobs a session's shell started in the background
 * - the class leaves SIGINT to the program that embeds it
 * - a program's exit removes its sessions' temp files, with the event loop stopped
 * - a fresh session's first read isn't blank
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');
const { RobustSessionClient } = require('../dist/src/client/websocket-client.js');

const server = new PersistentSessionServer();

after(async () => {
  await server.killAll(false);
});

test('graceful kill of an idle shell is fast (SIGHUP, not a burned 3s timeout)', async () => {
  await server.createSession('t-kill');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const start = Date.now();
  await server.killSession('t-kill', true);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, `graceful kill took ${elapsed}ms; must not burn the full 3s`);
});

// kill(pid, 0) checks that the process exists, on Linux and macOS alike.
const exists = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function goneAfterGracefulKill(id, command) {
  await server.createSession(id, { shell: '/bin/bash' });
  const r = await server.execCommand(id, command, 5000);
  const pid = Number((String(r.output).match(/BGPID=(\d+)/) || [])[1]);
  assert.ok(pid > 0, `the job's pid: ${JSON.stringify(r.output)}`);
  try {
    await server.killSession(id, true);
    const deadline = Date.now() + 3000;
    while (exists(pid) && Date.now() < deadline) await pause(50);
    return { pid, gone: !exists(pid) };
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// On Linux the listings read /proc and spawn no ps, so only on macOS can this test fail.
test('a graceful kill whose deadline has passed runs no ps, and still ends the shell', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-ps-'));
  const mark = path.join(dir, 'called');
  fs.writeFileSync(path.join(dir, 'ps'), `#!/bin/sh\necho "$*" >> '${mark}'\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  await server.createSession('t-kill-deadline', { shell: '/bin/bash' });
  const r = await server.execCommand('t-kill-deadline', 'echo SHELLPID=$$', 5000);
  const shellPid = Number((String(r.output).match(/SHELLPID=(\d+)/) || [])[1]);
  assert.ok(shellPid > 0, `the shell's pid: ${JSON.stringify(r.output)}`);
  const PATH = process.env.PATH;
  process.env.PATH = `${dir}:${PATH}`;
  try {
    await server.killSession('t-kill-deadline', true, performance.now() - 1);
  } finally {
    process.env.PATH = PATH;
  }
  const ended = Date.now() + 3000;
  while (exists(shellPid) && Date.now() < ended) await pause(50);
  assert.strictEqual(exists(shellPid), false, `the shell (pid ${shellPid}) outlived the kill`);
  assert.strictEqual(fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '', '', 'no ps ran');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session opened while killAll waits on a kill is still listed, and alive, after it', async () => {
  await server.createSession('t-killall-held');
  let release;
  const held = new Promise((r) => (release = r));
  const kill = server.killSession;
  let pid = 0;
  server.killSession = async function (id, ...rest) {
    await kill.call(this, id, ...rest);
    if (id === 't-killall-held') await held;
  };
  try {
    const all = server.killAll(false);
    await server.createSession('t-killall-new', { shell: '/bin/bash' });
    const r = await server.execCommand('t-killall-new', 'echo SHELLPID=$$', 5000);
    pid = Number((String(r.output).match(/SHELLPID=(\d+)/) || [])[1]);
    assert.ok(pid > 0, `the new shell's pid: ${JSON.stringify(r.output)}`);
    release();
    await all;
    assert.ok(server.listSessions().some((s) => s.id === 't-killall-new'), 'the session opened during killAll is listed');
    assert.strictEqual(exists(pid), true, `the new shell (pid ${pid}) is alive`);
  } finally {
    release();
    delete server.killSession;
    await server.killSession('t-killall-new', false);
    // A shell whose entry was lost can't be killed through the server, and would keep this run open.
    if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

test('a graceful kill that ends after a force kill of its session leaves a session opened since under that id listed', async () => {
  await server.createSession('t-kill-reused', { shell: '/bin/bash' });
  const sleep = server.sleep;
  let release;
  const held = new Promise((r) => (release = r));
  let reached;
  const atGate = new Promise((r) => (reached = r));
  let first = true;
  server.sleep = async function (ms) {
    if (first) {
      first = false;
      reached();
      await held;
    }
    return sleep.call(this, ms);
  };
  let pid = 0;
  try {
    const graceful = server.killSession('t-kill-reused', true);
    await atGate;
    await server.killSession('t-kill-reused', false);
    await server.createSession('t-kill-reused', { shell: '/bin/bash' });
    const r = await server.execCommand('t-kill-reused', 'echo SHELLPID=$$', 5000);
    pid = Number((String(r.output).match(/SHELLPID=(\d+)/) || [])[1]);
    assert.ok(pid > 0, `the new shell's pid: ${JSON.stringify(r.output)}`);
    release();
    await graceful;
    assert.ok(server.listSessions().some((s) => s.id === 't-kill-reused'), 'the session opened since is listed');
    assert.strictEqual(exists(pid), true, `the new shell (pid ${pid}) is alive`);
  } finally {
    release();
    server.sleep = sleep;
    await server.killSession('t-kill-reused', false);
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

test('a graceful kill ends the jobs the session started in the background', async () => {
  const { pid, gone } = await goneAfterGracefulKill('t-kill-job', 'sleep 60 & echo BGPID=$!');
  assert.strictEqual(gone, true, `the background job (pid ${pid}) outlived the graceful kill`);
});

test('a graceful kill ends a disowned job', async () => {
  const { pid, gone } = await goneAfterGracefulKill('t-kill-disowned', 'sleep 60 & echo BGPID=$!; disown');
  assert.strictEqual(gone, true, `the disowned job (pid ${pid}) outlived the graceful kill`);
});

test('a graceful kill ends a job started from a subshell, whose parent is gone before the kill', async () => {
  const { pid, gone } = await goneAfterGracefulKill('t-kill-doublefork', '(sleep 60 & echo BGPID=$!)');
  assert.strictEqual(gone, true, `the subshell's job (pid ${pid}) outlived the graceful kill`);
});

test('a graceful kill ends a stopped, disowned job', async () => {
  const { pid, gone } = await goneAfterGracefulKill('t-kill-stopped', 'sleep 60 & p=$!; kill -STOP $p; echo BGPID=$p; disown');
  assert.strictEqual(gone, true, `the stopped, disowned job (pid ${pid}) outlived the graceful kill`);
});

const python3 = require('node:child_process').spawnSync('python3', ['-c', '']).status === 0;

async function withPython(id, start, body) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const base = path.join(os.tmpdir(), `tsm-fixes-${id}-${process.pid}`);
  const script = `${base}.py`;
  fs.writeFileSync(script, [
    'import os, signal, sys, time',
    'f = sys.argv[1]',
    "mode = sys.argv[2] if len(sys.argv) > 2 else ''",
    "if mode == 'setsid':",
    '    if os.fork(): sys.exit(0)',
    '    os.setsid()',
    "if mode == 'stopped-child':",
    "    open(f + '.parent', 'w').write(str(os.getpid()))",
    '    if os.fork():',
    '        while True: time.sleep(60)',
    '    os.setpgid(0, 0)',
    '    signal.signal(signal.SIGHUP, signal.SIG_DFL)',
    "signal.signal(signal.SIGUSR1, lambda *_: open(f + '.answer', 'w').write('yes'))",
    "open(f + '.tmp', 'w').write(str(os.getpid()))",
    "os.rename(f + '.tmp', f)",
    "if mode == 'stopped-child': os.kill(os.getpid(), signal.SIGSTOP)",
    'while True: time.sleep(60)',
  ].join('\n'));
  const pids = [];
  try {
    await server.createSession(id, { shell: '/bin/bash' });
    await server.execCommand(id, start(script, base), 5000);
    let pid = 0;
    const ready = Date.now() + 5000;
    while (!(pid > 0) && Date.now() < ready) {
      try { pid = Number(fs.readFileSync(base, 'utf8')); } catch { await pause(50); }
    }
    assert.ok(pid > 0, `the python3 process wrote its pid to ${base}`);
    pids.push(pid);
    try { pids.push(Number(fs.readFileSync(`${base}.parent`, 'utf8'))); } catch {}
    return await body(pid, `${base}.answer`);
  } finally {
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch {} }
    for (const f of [script, base, `${base}.parent`, `${base}.answer`]) { try { fs.unlinkSync(f); } catch {} }
  }
}

// A signal the kill sent is pending before the SIGUSR1 is, and the kernel acts
// on a process's pending signals each time it returns to the process. So a
// fatal one ends it before Python's own handler can write the answer.
const answersAfterGracefulKill = (id, start) => withPython(id, start, async (pid, answer) => {
  const fs = require('node:fs');
  await server.killSession(id, true);
  try { process.kill(pid, 'SIGUSR1'); } catch { return { pid, answered: false }; }
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(answer) && Date.now() < deadline) await pause(50);
  return { pid, answered: fs.existsSync(answer) };
});

test('a process that left the terminal with setsid outlives a graceful kill', { skip: python3 ? false : 'needs python3' }, async () => {
  const { pid, answered } = await answersAfterGracefulKill('t-kill-setsid', (script, file) => `python3 '${script}' '${file}' setsid &`);
  assert.strictEqual(answered, true, `the setsid process (pid ${pid}) didn't outlive the graceful kill`);
});

test('a job started with nohup outlives a graceful kill', { skip: python3 ? false : 'needs python3' }, async () => {
  const { pid, answered } = await answersAfterGracefulKill('t-kill-nohup', (script, file) => `nohup python3 '${script}' '${file}' >/dev/null 2>&1 &`);
  assert.strictEqual(answered, true, `the nohup job (pid ${pid}) didn't outlive the graceful kill`);
});

// The kernel hangs up and continues a stopped group only once no member's
// parent is in another group on the terminal, and on Linux a stopped process
// holds a SIGHUP until it's continued. This child's parent outlives the kill,
// so only the kill's own signals can end it. It takes SIGHUP's default back
// from nohup. Its parent never reaps it, so once it has ended, ps shows it as
// a zombie (Z).
test('a graceful kill ends a stopped process in its own group, whose parent outlives the kill', { skip: python3 ? false : 'needs python3' }, async () => {
  await withPython('t-kill-stopped-child', (script, file) => `nohup python3 '${script}' '${file}' stopped-child >/dev/null 2>&1 &`, async (pid) => {
    const { execFileSync } = require('node:child_process');
    const state = () => { try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    const stopped = Date.now() + 5000;
    while (!state().startsWith('T') && Date.now() < stopped) await pause(50);
    assert.match(state(), /^T/, `the child (pid ${pid}) stopped itself before the kill`);
    await server.killSession('t-kill-stopped-child', true);
    const ended = () => /^(Z|$)/.test(state());
    const deadline = Date.now() + 3000;
    while (!ended() && Date.now() < deadline) await pause(50);
    assert.ok(ended(), `the stopped child (pid ${pid}, ps: ${state()}) outlived the graceful kill`);
  });
});

test('client request timeout always exceeds the server-side wait', () => {
  const compute = RobustSessionClient.prototype['computeRequestTimeout'];
  const self = { requestTimeout: 10000 };
  // exec with no explicit timeout must cover the server's 30s default —
  // this used to be 10s, killing any 10-30s command client-side.
  assert.strictEqual(compute.call(self, 'session.exec', {}), 35000);
  assert.strictEqual(compute.call(self, 'session.exec', { timeout: 60000 }), 65000);
  assert.strictEqual(compute.call(self, 'session.exec', { timeout: -1 }), 5000);
  assert.ok(compute.call(self, 'service.start') > 15000, 'must exceed the 15s pattern poll');
  assert.strictEqual(compute.call(self, 'session.list'), 10000);
});

test("session creation waits for the shell to be ready: a slow rc file does not leak into the first command's output", async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  // An interactive sh reads the file $ENV names; this one outlives the 200ms
  // sleep 1.6.0 waited, then prints a line.
  const rc = path.join(os.tmpdir(), `tsm-fixes-env-${process.pid}`);
  fs.writeFileSync(rc, 'sleep 0.6\necho RC_LINE\n');
  try {
    const start = Date.now();
    await server.createSession('t-ready', { shell: '/bin/sh', env: { ENV: rc } });
    const waited = Date.now() - start;
    assert.ok(waited >= 550, `creation waited for the rc file (${waited}ms)`);
    const first = await server.execCommand('t-ready', 'echo FIRST', 5000);
    assert.strictEqual(first.exitCode, 0);
    assert.ok(first.output.includes('FIRST'), first.output);
    assert.ok(!first.output.includes('RC_LINE'), `rc output leaked into the first command's output: ${JSON.stringify(first.output)}`);
  } finally {
    fs.rmSync(rc, { force: true });
    await server.killSession('t-ready', false);
  }
});

test('the class registers no SIGINT handler, so Ctrl+C belongs to the program that embeds it', () => {
  // start-session-server handles SIGINT with its graceful shutdown. A handler
  // of the class's own would run before that shutdown could.
  const before = process.listenerCount('SIGINT');
  const another = new PersistentSessionServer();
  assert.strictEqual(process.listenerCount('SIGINT'), before);
  void another;
});

test("a program's exit removes its sessions' temp files, though the event loop has stopped", async () => {
  // A child program, given a TMPDIR of its own, embeds a server and starts a
  // multi-line command in each of two bash sessions; each command goes
  // through a temp file. While both still run, the child lists its TMPDIR and
  // calls process.exit(0). An 'exit' listener can't await, so only a
  // synchronous cleanup removes the files.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-fixes-exit-')));
  const mod = path.resolve(__dirname, '../dist/src/server/session-server-v3.js');
  const code = `
    const fs = require('node:fs');
    const os = require('node:os');
    const { PersistentSessionServer } = require(${JSON.stringify(mod)});
    (async () => {
      const s = new PersistentSessionServer();
      for (const id of ['t-exit-1', 't-exit-2']) {
        await s.createSession(id, { shell: '/bin/bash' });
        s.execCommand(id, 'echo one\\nsleep 5').catch(() => {});
      }
      for (let i = 0; i < 100 && fs.readdirSync(os.tmpdir()).length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      console.log(JSON.stringify({ tmpdir: fs.realpathSync(os.tmpdir()), files: fs.readdirSync(os.tmpdir()) }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(2); });`;
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, TMPDIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  // 'close', not 'exit': the child's stdout can still be draining when 'exit' fires.
  const status = await new Promise((resolve) => child.on('close', (c) => resolve(c)));
  try {
    assert.strictEqual(status, 0);
    const before = JSON.parse(out.trim());
    assert.strictEqual(before.tmpdir, dir, "the child's os.tmpdir() is its own directory");
    assert.ok(before.files.length >= 2, `both running commands' temp files, before the exit: ${out.trim()}`);
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'a temp file outlived the program');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh session's first read isn't blank: the prompt stays in the line buffer, which getOutput appends", async () => {
  await server.createSession('t-prompt');
  try {
    // An idle shell prints nothing more, so a first read that is blank stays blank.
    const shown = () => server.getOutput('t-prompt').some((l) => l.trim().length > 0);
    const deadline = Date.now() + 2000;
    while (!shown() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(shown(), `the first read of a fresh session is blank: ${JSON.stringify(server.getOutput('t-prompt'))}`);
  } finally {
    await server.killSession('t-prompt', false);
  }
});
