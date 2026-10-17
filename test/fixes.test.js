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

test('a graceful kill ends the jobs the session started in the background', async () => {
  // The shell gets SIGHUP while its terminal is still open, and passes it on to
  // its jobs before it exits. An interactive bash ignores SIGINT, and SIGKILL
  // would end the shell before it could pass anything on.
  await server.createSession('t-kill-job', { shell: '/bin/bash' });
  const r = await server.execCommand('t-kill-job', 'sleep 60 & echo BGPID=$!', 5000);
  const pid = Number((String(r.output).match(/BGPID=(\d+)/) || [])[1]);
  assert.ok(pid > 0, `the background job's pid: ${JSON.stringify(r.output)}`);
  await server.killSession('t-kill-job', true);
  // kill(pid, 0) checks that the process exists, on Linux and macOS alike.
  const running = () => {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
  };
  const deadline = Date.now() + 3000;
  while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const outlived = running();
  if (outlived) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  assert.strictEqual(outlived, false, `the background job (pid ${pid}) outlived the graceful kill`);
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
