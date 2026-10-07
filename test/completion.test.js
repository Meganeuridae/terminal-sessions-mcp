/**
 * Regression tests for command-completion detection (the "doesn't notice the
 * command ended / waits for the full timeout" family of bugs).
 *
 * These run against the compiled build (npm test builds first) and use real
 * PTYs, so they are integration tests; each asserts on wall-clock behavior
 * with generous margins to stay robust on slow CI machines.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');

let server;

/** Command temp files this process's server has on disk right now. */
const ourTempFiles = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`tsm-cmd-${process.pid}-`));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

before(() => {
  server = new PersistentSessionServer();
});

after(async () => {
  await server.killAll(false);
});

test('fast command resolves promptly with clean output', async () => {
  await server.createSession('t-fast');
  const start = Date.now();
  const result = await server.execCommand('t-fast', 'echo hello-world', 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(Date.now() - start < 3000, 'should resolve well before the timeout');
  assert.match(result.output, /hello-world/);
  assert.ok(!result.output.includes('<<<EXIT'), 'markers must be stripped');
  assert.ok(!result.output.includes("tsm-cmd"), 'wrapper echo must be stripped');
});

test('exit codes propagate through the marker', async () => {
  const result = await server.execCommand('t-fast', 'sh -c "exit 42"', 10000);
  assert.strictEqual(result.exitCode, 42);
});

test('env and cwd persist across the temp-file exec path', async () => {
  await server.execCommand('t-fast', 'export TSMCP_TEST=persisted; cd /', 10000);
  const env = await server.execCommand('t-fast', 'echo "$TSMCP_TEST"', 10000);
  assert.match(env.output, /persisted/);
  const pwd = await server.execCommand('t-fast', 'pwd', 10000);
  assert.match(pwd.output, /^\/\s*$/m);
});

test('shell death resolves the in-flight command instead of hanging until timeout', async () => {
  await server.createSession('t-exit');
  const start = Date.now();
  const result = await server.execCommand('t-exit', 'exit', 8000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `resolved in ${elapsed}ms; must not wait out the 8s timeout`);
  assert.ok(!result.output.includes('<<<EXIT'));
});

test('shell death fails queued commands instead of hanging', async () => {
  await server.createSession('t-exit-q');
  const [first, second] = await Promise.all([
    server.execCommand('t-exit-q', 'exit', 8000),
    server.execCommand('t-exit-q', 'echo never-runs', 8000)
  ]);
  assert.strictEqual(second.exitCode, -1);
  assert.match(second.output, /session exited/);
});

test('a stdin-reading command times out without the marker being fed to it', async () => {
  await server.createSession('t-read');
  const start = Date.now();
  const result = await server.execCommand('t-read', 'read x', 1500);
  const elapsed = Date.now() - start;
  assert.strictEqual(result.exitCode, -1, 'stdin reader cannot complete; must time out');
  assert.ok(elapsed >= 1400 && elapsed < 4000, `timed out at ${elapsed}ms`);
  // Nothing was typed into `read` behind the caller's back: it is still
  // waiting, and the session can be unblocked explicitly.
  server.sendInput('t-read', '', true); // plain Enter -> read returns
  const follow = await server.execCommand('t-read', 'echo unblocked', 8000);
  assert.strictEqual(follow.exitCode, 0);
  assert.match(follow.output, /unblocked/);
});

test('marker-shaped text in command/output cannot cause premature completion', async () => {
  await server.createSession('t-fake');
  const start = Date.now();
  const result = await server.execCommand(
    't-fake',
    'printf "see <<<EXIT:7>>> and <<<EXIT:abc:0>>> here\\n"; sleep 0.4; echo done',
    10000
  );
  const elapsed = Date.now() - start;
  assert.strictEqual(result.exitCode, 0);
  assert.ok(elapsed >= 380, `resolved at ${elapsed}ms; must wait for the real completion`);
  assert.match(result.output, /done/);
});

test('a timed-out command does not corrupt the next command (stale-marker cascade)', async () => {
  await server.createSession('t-cascade');
  const timedOut = await server.execCommand('t-cascade', 'sleep 1', 300);
  assert.strictEqual(timedOut.exitCode, -1);
  // sleep is still running; the next command queues behind it in the tty and
  // must resolve with ITS OWN result, not sleep's stale marker.
  const next = await server.execCommand('t-cascade', 'echo after-cascade', 8000);
  assert.strictEqual(next.exitCode, 0);
  assert.match(next.output, /after-cascade/);
  assert.ok(!next.output.includes('<<<EXIT'), 'stale markers must be stripped');
});

test('single-line commands longer than the tty canonical buffer survive', async () => {
  // macOS line discipline truncates canonical-mode input at 1024 bytes; the
  // temp-file path sidesteps the line editor entirely.
  await server.createSession('t-long');
  const payload = 'x'.repeat(3000);
  const result = await server.execCommand('t-long', `echo ${payload} | wc -c`, 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /3001/); // payload + newline
});

test('session logs stay free of exec plumbing lines', async () => {
  await server.createSession('t-logs');
  await server.execCommand('t-logs', 'echo log-hygiene', 10000);
  const logs = server.getOutput('t-logs');
  const joined = logs.join('\n');
  assert.match(joined, /\$ echo log-hygiene/, 'issued command should be logged');
  assert.match(joined, /^log-hygiene/m, 'command output should be logged');
  assert.ok(!joined.includes('tsm-cmd'), 'wrapper echoes must not be logged');
  assert.ok(!/<<<EXIT:[0-9a-z]+:\d+>>>/.test(joined), 'markers must not be logged');
});

test('multi-line commands (heredocs) still work through the temp-file path', async () => {
  await server.createSession('t-ml');
  const result = await server.execCommand('t-ml', 'cat <<EOF\nline-one\nline-two\nEOF', 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /line-one/);
  assert.match(result.output, /line-two/);
});

test('a command queued behind a timed-out one still runs: caller timeouts do not delete its file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-queued-'));
  await server.createSession('t-queued', { cwd: dir });
  const first = await server.execCommand('t-queued', 'sleep 1', 100);
  assert.strictEqual(first.exitCode, -1);
  // Written into the tty while sleep still owns it: typeahead, not yet sourced.
  const queued = await server.execCommand('t-queued', 'printf MUST_RUN > queued', 100);
  assert.strictEqual(queued.exitCode, -1);
  // Issuing a third command used to delete the second one's temp file before
  // the shell got to source it.
  const third = await server.execCommand('t-queued', 'printf after', 8000);
  assert.strictEqual(third.exitCode, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'queued'), 'utf8'), 'MUST_RUN');
});

test('a temp file is released by its own marker, including one that arrives after a caller timeout', async () => {
  await server.createSession('t-files');
  const before = new Set(ourTempFiles());
  const fresh = () => ourTempFiles().filter(f => !before.has(f));
  const done = await server.execCommand('t-files', 'echo done', 8000);
  assert.strictEqual(done.exitCode, 0);
  assert.deepStrictEqual(fresh(), [], 'a completed command leaves no temp file behind');
  const timedOut = await server.execCommand('t-files', 'sleep 0.6', 100);
  assert.strictEqual(timedOut.exitCode, -1);
  assert.strictEqual(fresh().length, 1, 'a timed-out command keeps its file while the shell may still source it');
  // No command is current when sleep ends; its late marker still releases the file.
  await sleep(1500);
  assert.deepStrictEqual(fresh(), [], 'the late marker released the file');
});

test('PTY exit releases the files of commands that can no longer run', async () => {
  await server.createSession('t-exit-files');
  const before = new Set(ourTempFiles());
  const timedOut = await server.execCommand('t-exit-files', 'sleep 5', 100);
  assert.strictEqual(timedOut.exitCode, -1);
  assert.strictEqual(ourTempFiles().filter(f => !before.has(f)).length, 1);
  server.sendSignal('t-exit-files', 'SIGKILL');
  for (let i = 0; i < 50 && server.listSessions().find(s => s.id === 't-exit-files')?.isAlive; i++) await sleep(50);
  assert.deepStrictEqual(ourTempFiles().filter(f => !before.has(f)), []);
});
