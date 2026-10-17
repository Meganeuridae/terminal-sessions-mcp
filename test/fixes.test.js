/**
 * Regression tests for timeout/teardown fixes:
 * - client request timeouts must always exceed the server-side wait
 * - graceful killSession must not burn its full fallback timeout
 * - session creation waits for the shell, not a fixed sleep
 * - the server's SIGINT fallback yields to an embedding program's handler
 */
const { test, after } = require('node:test');
const assert = require('node:assert');

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

test("the server's SIGINT fallback steps aside when the embedding program handles SIGINT, so a graceful shutdown can run", () => {
  // The constructor registered the fallback; start-session-server registers
  // `shutdown` after it. With both present the fallback must do nothing, or
  // it would SIGKILL every shell before the graceful killAll runs, and a
  // killed shell can't pass the hangup on to its background jobs.
  const fallback = process.listeners('SIGINT').find((l) => l.toString().includes('forceKillAllSync'));
  assert.ok(fallback, 'the fallback is registered');
  const exit = process.exit;
  let exited = false;
  process.exit = () => { exited = true; };
  const noop = () => {};
  process.on('SIGINT', noop);
  try {
    fallback();
    assert.strictEqual(exited, false, 'with another handler registered, the fallback neither kills nor exits');
  } finally {
    process.off('SIGINT', noop);
    process.exit = exit;
  }
});
