/**
 * Presence (§10.4) against real bash: the newest news, never the oldest window
 * after the cursor (m2-8, mcpl-12); running process Runs and troubled services
 * are news (m2-7); a session whose shell went with a daemon restart still says
 * which Runs it lost (mcpl-2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { presence } from '../src/api/presence.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import type { Session } from '../src/core/session.js';
import { until } from './testhost.js';

const A: Caller = { principal: 'agent:a@test', connectionId: 'pa' };
const B: Caller = { principal: 'agent:b@test', connectionId: 'pb' };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pres-'));
let registry: SessionRegistry;
let app: App;

before(() => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  app = new App({ registry, defaultWaitMs: 5000 });
});

after(async () => {
  await registry.closeAll({ graceful: false });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const live = (id: string): Session => {
  const s = registry.get(id);
  assert.ok(s?.kind === 'live', `${id} is live`);
  return s.session;
};
const P = (c: Caller, ids: string[], a = app) => presence(a, c.principal, ids) ?? '(none)';
const notes = (s: Session, n: number) => {
  for (let i = 0; i < n; i++) s.journal.append({ type: 'note', text: `n${i}`, principal: A.principal });
};

test('m2-7: a running process Run and an unhealthy service are news, not "idle, nothing new"', async () => {
  await app.sessionOpen(A, { id: 'pp' });
  await app.run(A, { session: 'pp', command: 'echo hi' });
  assert.match(P(A, ['pp']), /idle, nothing new: pp/);
  const pr = await app.run(A, { session: 'pp', command: 'sleep 3', target: 'process', wait: 0 });
  const busy = P(A, ['pp']);
  assert.doesNotMatch(busy, /idle, nothing new/);
  assert.match(busy, /pp: idle \(cwd .*\) · running `sleep 3` \d+s \(process\)/);
  await app.cancel(A, { runId: pr.runId! });

  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as net.AddressInfo).port;
  const st = await app.start(A, { session: 'pp', name: 'api', command: 'sleep 30', target: 'process', ready: { tcp: { port } }, health: { tcp: { port }, intervalMs: 200 }, wait: 3000 });
  assert.equal(st.service, 'ready');
  srv.close();
  const mon = app.extras(live('pp')).services.get(st.runId!)!;
  await until(() => mon.status === 'unhealthy', 3000, 'unhealthy');
  await app.read(A, { session: 'pp', since: 0 });
  assert.match(P(A, ['pp']), /service api unhealthy \(port \d+ not accepting\)/);
  await app.cancel(A, { runId: st.runId! });
});

test('a Run in a declared shell is news, and named, not "idle, nothing new"', { skip: !fs.existsSync('/bin/bash') }, async () => {
  await app.sessionOpen(A, { id: 'pd' });
  const nested = await app.run(A, { session: 'pd', command: 'bash --norc --noprofile', wait: 400 });
  assert.equal(nested.state, 'running');
  live('pd').declareShell({ principal: A.principal });
  await app.read(A, { session: 'pd', since: 0 });
  assert.match(P(A, ['pd']), /running `bash --norc --noprofile` \d+s \(cwd .*\), a declared sh shell at its prompt/);
  const r = await app.run(A, { session: 'pd', command: 'sleep 3', wait: 300 });
  assert.equal(r.state, 'running');
  const busy = P(A, ['pd']);
  assert.doesNotMatch(busy, /idle, nothing new/);
  assert.match(busy, /running `sleep 3` \d+s in the declared sh shell \(inside `bash --norc --noprofile`\)/);
  await app.cancel(A, { runId: r.runId! });
  await until(() => live('pd').run(r.runId!).state !== 'running', 5000, 'the declared Run to end');
  await app.run(A, { session: 'pd', command: 'exit', wait: 500 });
  await until(() => live('pd').run(nested.runId!).state === 'exited', 5000, 'the nested shell to exit');
});

test('mcpl-12: a background Run that failed behind thousands of events is reported, not "idle, nothing new"', async () => {
  await app.sessionOpen(A, { id: 'bg' });
  const r = await app.run(A, { session: 'bg', command: 'sleep 0.5; false', wait: 0 });
  notes(live('bg'), 6000);
  await until(() => live('bg').run(r.runId!).state === 'exited', 5000, 'failed');
  const text = P(A, ['bg']);
  assert.doesNotMatch(text, /idle, nothing new/);
  assert.match(text, /`sleep 0\.5; false` → 1/);
});

test('m2-8: presence names the newest ended Runs after the cursor, counts the rest exactly, and marks a bounded byte count', async () => {
  await app.sessionOpen(A, { id: 'busy', visibility: 'shared' });
  await app.run(A, { session: 'busy', command: 'echo ancient-one' });
  await app.run(A, { session: 'busy', command: 'echo ancient-two' });
  const s = live('busy');
  notes(s, 6000);
  const recent = await app.run(A, { session: 'busy', command: 'echo recent; false' });
  assert.equal(recent.exit, 1);
  // B has never read this shared session: everything is since its last read.
  const text = P(B, ['busy']);
  assert.match(text, /`echo ancient-two` → 0 by agent:a@test · `echo recent; false` → 1 by agent:a@test · 1 more ended/);
  assert.match(text, /≥ \d+ B new since your last read/, 'the older output lies beyond the scan, and says so');
  assert.doesNotMatch(text, /ancient-one/);
  for (let i = 0; i < 6000; i++) s.journal.append({ type: 'output', data: 'x\n', runId: recent.runId!, stream: 'pty' });
  assert.match(P(B, ['busy']), /≥ [\d.]+ \S+ new since your last read \(read since=0\)/);
});

test('mcpl-2: after a daemon restart, a history-only session reports the Runs the restart lost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pres-restart-'));
  const reg1 = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app1 = new App({ registry: reg1 });
  let reg2: SessionRegistry | undefined;
  try {
    await app1.sessionOpen(A, { id: 'rs' });
    const r = await app1.run(A, { session: 'rs', command: 'sleep 60', wait: 300 });
    assert.equal(r.state, 'running');
    await reg1.closeAll({ reason: 'daemon-shutdown' });
    reg2 = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    const app2 = new App({ registry: reg2 });
    assert.equal(reg2.get('rs')?.kind, 'history');
    const text = P(A, ['rs'], app2);
    assert.match(text, /rs: shell gone \(daemon restarted; history only\)/);
    assert.match(text, /`sleep 60` lost \(daemon-shutdown\)/);
    assert.equal(presence(app2, B.principal, ['rs']), undefined, 'a private session says nothing to others');
  } finally {
    await (reg2 ?? reg1).closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
