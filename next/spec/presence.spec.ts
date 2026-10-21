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
import { performance } from 'node:perf_hooks';
import { App, type Caller } from '../src/api/app.js';
import { presence } from '../src/api/presence.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { clocks } from '../src/core/clock.js';
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

test('presence names the immediate enclosing shell in a second declared hop', { skip: !fs.existsSync('/bin/dash') }, async () => {
  await app.sessionOpen(A, { id: 'two-hops' });
  try {
    await app.run(A, { session: 'two-hops', command: 'bash --norc --noprofile', wait: 100 });
    await app.declareShell(A, { session: 'two-hops' });
    await app.run(A, { session: 'two-hops', command: '/bin/dash', wait: 100 });
    await app.declareShell(A, { session: 'two-hops' });
    const inner = await app.run(A, { session: 'two-hops', command: 'sleep 30', wait: 100 });
    assert.match(P(A, ['two-hops']), /running `sleep 30` .*inside `\/bin\/dash`/);
    await app.cancel(A, { runId: inner.runId! });
  } finally {
    await app.sessionClose(A, { session: 'two-hops', force: true });
  }
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

test('1cabc6a 8: a later Run\'s result does not move the read cursor past an earlier Run\'s unread output', async () => {
  await app.sessionOpen(A, { id: 'rc' });
  await app.run(A, { session: 'rc', command: 'echo first' });
  assert.match(P(A, ['rc']), /idle, nothing new: rc/);
  // Y: started with wait 0, its outcome and output never fetched.
  const y = await app.run(A, { session: 'rc', command: "echo unread; sh -c 'exit 3'", wait: 0 });
  await until(() => live('rc').run(y.runId!).state === 'exited', 5000, 'Y to end');
  const before = P(A, ['rc']);
  assert.match(before, /new since your last read/);
  assert.match(before, /→ 3/);
  // X: a later Run whose result the caller got. Its result shows X's output, not Y's.
  const x = await app.run(A, { session: 'rc', command: 'echo later' });
  assert.equal(x.exit, 0);
  const after = P(A, ['rc']);
  assert.doesNotMatch(after, /idle, nothing new/, "X's result must not hide Y");
  assert.match(after, /new since your last read/);
  assert.match(after, /→ 3/);
  assert.ok(live('rc').cursorsOf(A.principal).read < live('rc').runOutput(y.runId!).events[0]!.seq, "the cursor stays before Y's output");
  // A page of X alone leaves Y unread too; a read of the session clears it; results seen move the cursor as before.
  await app.read(A, { session: 'rc', runId: x.runId! });
  assert.match(P(A, ['rc']), /→ 3/);
  await app.read(A, { session: 'rc', since: 0 });
  assert.match(P(A, ['rc']), /idle, nothing new: rc/);
  await app.run(A, { session: 'rc', command: 'echo one' });
  await app.run(A, { session: 'rc', command: 'echo two' });
  assert.match(P(A, ['rc']), /idle, nothing new: rc/);
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
    // An `await` returned the lost Run's history to A: the cursor moves as it does for `read` (G22),
    // and the session has nothing new to say (the house's read of 1cabc6a, #22).
    const got = await app2.awaitRun(A, { runId: r.runId! });
    assert.equal(got.state, 'lost');
    assert.equal(presence(app2, A.principal, ['rs']), undefined, 'after await, nothing ended that A has not seen');
  } finally {
    await (reg2 ?? reg1).closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('late output of a process Run’s background child is news, not a prompt redraw', async () => {
  await app.sessionOpen(A, { id: 'late' });
  const r = await app.run(A, { session: 'late', command: "sh -c '(sleep 0.4; echo late-line) & exit 0'", target: 'process' });
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 0);
  // The result moved A's read cursor to the Run's end; the child's line lands after it, journaled
  // without the Run's id (ss-10).
  const s = live('late');
  await until(() => s.journal.tail(50).some((e) => e.type === 'output' && e.runId === undefined && e.stream === 'stdout' && e.data.includes('late-line')), 4000, 'the late line');
  const text = P(A, ['late']);
  assert.doesNotMatch(text, /idle, nothing new/);
  assert.match(text, /late: idle \(cwd .*\) · \d+ B new since your last read \(read since=\d+\)/);
});

test('a human typing is news; the reader’s own typing and protocol replies are not', async () => {
  const H: Caller = { principal: 'human:test:1', connectionId: 'ph' };
  await app.sessionOpen(A, { id: 'typed', visibility: 'shared' });
  await app.run(A, { session: 'typed', command: 'true' });
  const s = live('typed');
  await app.read(A, { session: 'typed', since: 0 });
  await app.read(H, { session: 'typed', since: 0 });
  assert.match(P(A, ['typed']), /idle, nothing new: typed/);
  s.journal.append({ type: 'input', data: 'ls', principal: H.principal, kind: 'text' });
  assert.match(P(A, ['typed']), /typed: idle \(cwd .*\) · a human typed here/);
  assert.match(P(H, ['typed']), /idle, nothing new: typed/, 'one’s own typing is not news to oneself');
  await app.read(A, { session: 'typed', since: 0 });
  s.journal.append({ type: 'input', data: 'x', principal: A.principal, kind: 'text' });
  s.journal.append({ type: 'input', data: 'y', principal: 'human:test:2', kind: 'protocol-reply' });
  assert.match(P(A, ['typed']), /idle, nothing new: typed/, 'an agent’s typing and a protocol reply are not a human typing');
});

test('G28: a Run whose outcome a result already carried is not news again', async () => {
  await app.sessionOpen(A, { id: 'g28' });
  const r = await app.run(A, { session: 'g28', command: 'sleep 0.3; echo done-g28', wait: 0 });
  assert.notEqual(r.state, 'exited');
  const s = live('g28');
  await until(() => s.run(r.runId!).state === 'exited', 4000, 'ended');
  assert.match(P(A, ['g28']), /`sleep 0\.3; echo done-g28` → 0/);
  app.outcomeSent(A, { session: 'g28', runId: r.runId!, state: 'exited' });
  assert.doesNotMatch(P(A, ['g28']), /done-g28/);
});

test('services: shown to their owner or the session’s, and an ended one the reader has read past is not news', async () => {
  const Cc: Caller = { principal: 'agent:c@test', connectionId: 'pc' };
  await app.sessionOpen(A, { id: 'svc', visibility: 'shared' });
  await app.read(A, { session: 'svc', since: 0 });
  const st = await app.start(A, { session: 'svc', name: 'job', command: 'sleep 0.5', target: 'process', wait: 100 });
  assert.equal(st.service, 'starting');
  assert.match(P(A, ['svc']), /service job starting/);
  assert.doesNotMatch(P(Cc, ['svc']), /service job/, 'another principal’s service is not theirs to see');
  const mon = app.extras(live('svc')).services.get(st.runId!)!;
  await until(() => mon.status === 'exited', 4000, 'exited');
  assert.match(P(A, ['svc']), /service job exited/);
  await app.read(A, { session: 'svc', since: 0 });
  assert.doesNotMatch(P(A, ['svc']), /service job/, 'an ended service the reader has read past');
});

test("a running Run's time is the session's own count of it, on the monotonic clock: a wall-clock step does not change it (the house's read of the 33 commits, #22 comment 6307350861)", async (t) => {
  await app.sessionOpen(A, { id: 'pw' });
  const s = live('pw');
  const proc = await app.run(A, { session: 'pw', command: 'sleep 20', target: 'process', wait: 0 });
  const shell = await app.run(A, { session: 'pw', command: 'sleep 20', wait: 0 });
  try {
    await until(() => s.run(proc.runId!).state === 'running' && s.run(shell.runId!).state === 'running', 5000, 'both Runs running');
    // The wall clock steps two minutes forward: timed against it, both Runs read 2m0s.
    const real = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => real() + 120_000);
    const text = P(A, ['pw']);
    t.mock.restoreAll();
    // Any count of seconds, however slow the runner: the two minutes of the step are what must not show.
    assert.match(text, /running `sleep 20` \d+s \(cwd /, text);
    assert.match(text, /running `sleep 20` \d+s \(process\)/, text);
    assert.doesNotMatch(text, /\dm\d+s/, text);
  } finally {
    await app.cancel(A, { runId: proc.runId! });
    await app.cancel(A, { runId: shell.runId! });
  }
});

test("a Run's time is rounded to whole seconds before it is split into minutes: 119.6 s reads 2m0s and 59.6 s reads 1m0s, never 1m60s or 60s (the house's read of the 40 commits, #22)", async (t) => {
  await app.sessionOpen(A, { id: 'pm' });
  const s = live('pm');
  const proc = await app.run(A, { session: 'pm', command: 'sleep 20', target: 'process', wait: 0 });
  try {
    await until(() => s.run(proc.runId!).state === 'running', 5000, 'the Run running');
    const real = performance.now.bind(performance);
    for (const [ms, shown] of [[119_600, '2m0s'], [59_600, '1m0s']] as const) {
      // The monotonic clock moves on so the Run has run `ms` (and a few ms more, by the time presence reads it).
      const ran = s.runDurationMs(proc.runId!)!;
      t.mock.method(clocks, 'monotonic', () => real() + ms - ran);
      const text = P(A, ['pm']);
      t.mock.restoreAll();
      assert.match(text, new RegExp(`running \`sleep 20\` ${shown} \\(process\\)`), text);
    }
  } finally {
    await app.cancel(A, { runId: proc.runId! });
  }
});
