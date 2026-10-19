/**
 * Services (§8.3, G9): the status a service reports and the evidence behind it.
 * The monitor's rules against a journal driven by hand (no PTY), then the same
 * rules end to end against real bash and real processes: no probe never means
 * ready (m2-1, atc-7), a lost Run is `lost` (m2-6), fail beats health (m2-15),
 * one message per transition (m2-16), per-stream matching (m2-21).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import { describeSpec, validateServiceSpec, type Connect, type ServiceSpec } from '../src/core/probes.js';
import { ServiceMonitor, type ServiceDeps } from '../src/core/services.js';
import type { JournalEvent, OutputStream, RunTarget } from '../src/core/types.js';
import { sleep, until } from './testhost.js';

const A = 'agent:a@test';

// ───────────── the monitor against a hand-driven journal ─────────────

function fake(target: RunTarget = 'process') {
  const journal = new Journal();
  const host = { journal, run: (id: string) => journal.runs.run(id) };
  const runId = 'r1';
  journal.append({ type: 'run.admit', runId, target, line: 'svc', principal: A, origin: 'self', queued: false });
  return {
    journal,
    runId,
    monitor: (spec: ServiceSpec, deps: ServiceDeps = {}) => new ServiceMonitor(host, runId, spec, A, 'svc', { livenessMs: 60, partialAfterMs: 30, ...deps }),
    start: () => journal.append(target === 'process' ? { type: 'run.start', runId, cwd: '/', envBasis: 'configured' } : { type: 'run.start', runId, cwd: '/' }),
    out: (data: string, stream: OutputStream = target === 'process' ? 'stdout' : 'pty') => journal.append({ type: 'output', runId, data, stream }),
    end: (e: Omit<Extract<JournalEvent, { type: 'run.end' }>, 'type' | 'runId' | 'seq' | 'ts' | 'durationMs'>) => journal.append({ type: 'run.end', runId, durationMs: 1, ...e }),
    statuses: () => journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'service' }> => e.type === 'service').map((e) => e.status),
  };
}

test('m2-1: without a readiness probe nothing asserts ready — `running` after the liveness window, and says so', async () => {
  const f = fake();
  const m = f.monitor({});
  f.start();
  assert.equal(m.status, 'starting', 'a Run that merely started is not ready (G9)');
  const settled = await m.waitSettled(2000);
  assert.equal(settled.status, 'running');
  assert.match(settled.probe, /no readiness probe/);
  assert.match(String(settled.evidence), /no readiness probe was given/);
  assert.deepEqual(f.statuses(), ['starting', 'running']);
  m.dispose();
});

test('m2-1/§8.3: a service whose process is `false` reports exited with code 1 — never passing through ready', async () => {
  const f = fake('shell');
  const m = f.monitor({});
  f.start();
  f.end({ state: 'exited', exit: 1 });
  const info = await m.waitSettled(1000);
  assert.equal(info.status, 'exited');
  assert.equal(info.exit, 1);
  assert.deepEqual(f.statuses(), ['starting', 'exited']);
  await sleep(100);
  assert.deepEqual(f.statuses(), ['starting', 'exited'], 'the liveness window does not fire after the end');
  assert.equal(describeSpec({}), 'no readiness probe (running once alive 2000ms)');
});

test('m2-6: a Run that ends lost leaves the service `lost` — its process may still be alive — not `exited`', async () => {
  const f = fake('shell');
  const m = f.monitor({ ready: { pattern: 'listening' } });
  f.start();
  f.out('listening on 8080\r\n');
  assert.equal(m.status, 'ready');
  f.end({ state: 'lost', reason: 'shell-exited' });
  assert.equal(m.status, 'lost');
  assert.match(String(m.info().evidence), /outcome unknown \(shell-exited\).*may still be running/);
  assert.deepEqual(f.statuses(), ['starting', 'ready', 'lost']);
});

test('m2-15: a fail-pattern verdict is not overridden by health.tcp; a ready line after it clears it, with true evidence', async () => {
  const f = fake();
  let accepting = true;
  const connect: Connect = async () => accepting;
  const m = f.monitor({ ready: { pattern: 'listening' }, fail: { pattern: 'FATAL' }, health: { tcp: { port: 1 }, intervalMs: 20 } }, { connect });
  f.start();
  f.out('listening\n');
  assert.equal(m.status, 'ready');
  f.out('FATAL: database connection lost\n');
  assert.equal(m.status, 'unhealthy');
  assert.equal(m.info().cause, 'fail-pattern');
  await sleep(150);
  assert.equal(m.status, 'unhealthy', 'the port still accepting does not undo what the service said');
  f.out('listening\n');
  assert.equal(m.status, 'ready');
  assert.match(String(m.info().evidence), /ready pattern matched again/);
  // A health failure is the health check's to clear.
  accepting = false;
  await until(() => m.status === 'unhealthy', 1000, 'health unhealthy');
  assert.equal(m.info().cause, 'health');
  accepting = true;
  await until(() => m.status === 'ready', 1000, 'health recovered');
  assert.match(String(m.info().evidence), /accepting again/);
  // A fail line during a health outage takes the verdict: health recovering no longer clears it.
  accepting = false;
  await until(() => m.status === 'unhealthy', 1000, 'health unhealthy again');
  f.out('FATAL: again\n');
  assert.equal(m.info().cause, 'fail-pattern');
  accepting = true;
  await sleep(100);
  assert.equal(m.status, 'unhealthy');
  m.dispose();
});

test('m2-16: a burst of fail lines is one `unhealthy` event; the repeats are counted and the latest is the evidence', () => {
  const f = fake('shell');
  const m = f.monitor({ ready: { pattern: 'ready' }, fail: { pattern: 'ERROR' } });
  f.start();
  f.out('ready\r\n');
  for (let i = 1; i <= 40; i++) f.out(`ERROR request ${i} failed\r\n`);
  assert.deepEqual(f.statuses(), ['starting', 'ready', 'unhealthy']);
  const info = m.info();
  assert.equal(info.repeats, 39);
  assert.equal(info.evidence, 'ERROR request 40 failed');
  m.dispose();
});

test('m2-21: ready and fail patterns keep a line buffer per stream, so interleaved stderr does not hide the ready line', () => {
  const f = fake('process');
  const m = f.monitor({ ready: { pattern: 'listening on \\d+' }, fail: { pattern: '^ERROR' } });
  f.start();
  f.out('Server listen', 'stdout');
  f.out('warn: deprecated\n', 'stderr');
  f.out('ing on 8080\n', 'stdout');
  assert.equal(m.status, 'ready');
  assert.equal(m.info().evidence, 'Server listening on 8080');
  f.out('noise ', 'stdout');
  f.out('ERROR on stderr\n', 'stderr');
  assert.equal(m.status, 'unhealthy', '^ERROR is the start of the stderr line, whatever stdout holds');
  m.dispose();
});

test('m2-5/m2-10: service patterns go through the linear-time engine and are checked before anything starts', () => {
  const bad = (spec: ServiceSpec) => assert.throws(() => validateServiceSpec(spec), (e: unknown) => e instanceof TermError && e.code === 'invalid_argument');
  bad({ ready: { pattern: '(unclosed' } });
  bad({ fail: { pattern: 'x*' } });
  bad({ ready: { tcp: { port: 70000 } } });
  bad({ ready: { timeoutMs: -1 } });
  assert.doesNotThrow(() => validateServiceSpec({ ready: { pattern: '(\\w+\\s?)+ready' }, fail: { pattern: 'FATAL' } }));
  const f = fake();
  assert.throws(() => f.monitor({ ready: { pattern: 'x*' } }), (e: unknown) => e instanceof TermError && e.code === 'invalid_argument');
  assert.deepEqual(f.statuses(), [], 'a refused pattern journals nothing');
});

test('a readiness timeout is cleared by readiness itself; a prompt-like ready line needs no newline', async () => {
  const f = fake('shell');
  const m = f.monitor({ ready: { pattern: '^>>> $', timeoutMs: 30 } });
  f.start();
  await until(() => m.status === 'unhealthy', 1000, 'timeout');
  assert.equal(m.info().cause, 'timeout');
  f.out('Python 3\r\n>>> ');
  await until(() => m.status === 'ready', 1000, 'ready from the prompt');
  m.dispose();
});

// ───────────── the house's read of 3eade8a (#22): services ─────────────

test('health checks start after a fail-pattern recovery too, when the fail line came before readiness', async () => {
  const f = fake();
  let accepting = false;
  let connects = 0;
  const connect: Connect = async () => {
    connects++;
    return accepting;
  };
  const m = f.monitor({ ready: { pattern: '^READY', tcp: { port: 1001 } }, fail: { pattern: '^ERROR' }, health: { tcp: { port: 1002 }, intervalMs: 20 } }, { connect });
  f.start();
  f.out('READY\n');
  f.out('ERROR boom\n');
  assert.equal(m.status, 'unhealthy');
  accepting = true;
  await until(() => f.statuses().length === 2 && m.info().cause === 'fail-pattern' && m.status === 'unhealthy', 1000, 'tcp met while the fail verdict stands');
  await sleep(300);
  assert.equal(m.status, 'unhealthy', 'the port coming up does not clear a fail line');
  f.out('READY\n');
  assert.equal(m.status, 'ready');
  assert.match(String(m.info().evidence), /ready pattern matched again/);
  connects = 0;
  await sleep(150);
  assert.ok(connects >= 3, `health checks run after the recovery: ${connects} connects in 150 ms`);
  accepting = false;
  await until(() => m.status === 'unhealthy', 1000, 'a health failure after recovery');
  assert.equal(m.info().cause, 'health');
  m.dispose();
});

test('a cause that changes within an unhealthy period is journaled: a fail line after a readiness timeout', async () => {
  const f = fake('shell');
  const m = f.monitor({ ready: { pattern: 'ready', timeoutMs: 30 }, fail: { pattern: 'ERROR' } });
  f.start();
  await until(() => m.status === 'unhealthy', 1000, 'timeout');
  assert.equal(m.info().cause, 'timeout');
  f.out('ERROR disk full\r\n');
  assert.deepEqual(f.statuses(), ['starting', 'unhealthy', 'unhealthy']);
  const events = f.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'service' }> => e.type === 'service');
  assert.equal(events.at(-1)!.evidence, 'ERROR disk full');
  assert.equal(m.info().cause, 'fail-pattern');
  assert.equal(m.info().seq, events.at(-1)!.seq);
  f.out('ERROR again\r\n');
  assert.equal(f.statuses().length, 3, 'a repeat of the same cause is counted, not journaled (m2-16)');
  assert.equal(m.info().repeats, 1);
  m.dispose();
});

test('service durations past what a timer can hold are refused', () => {
  const bad = (spec: ServiceSpec) => assert.throws(() => validateServiceSpec(spec), (e: unknown) => e instanceof TermError && e.code === 'invalid_argument' && /2147483647/.test(e.message));
  bad({ ready: { pattern: 'x', timeoutMs: 3e9 } });
  bad({ ready: { exitWithinMs: 2 ** 31 } });
  bad({ health: { tcp: { port: 1 }, intervalMs: 3e9 } });
  assert.doesNotThrow(() => validateServiceSpec({ ready: { pattern: 'x', timeoutMs: 2 ** 31 - 1 } }));
});

test('output from before the monitor existed is read page by page to the end when a read stops short', () => {
  const f = fake();
  f.start();
  for (let i = 1; i <= 4; i++) f.out(`warming up ${i}\n`);
  f.out('listening on 8080\n');
  const since = f.journal.since.bind(f.journal);
  f.journal.since = (cursor: number) => since(cursor, 2);
  try {
    const m = f.monitor({ ready: { pattern: 'listening on \\d+' } });
    assert.equal(m.status, 'ready', 'the ready line is behind the first page');
    m.dispose();
  } finally {
    f.journal.since = since;
  }
});

// ───────────── end to end: real bash, real processes ─────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-svc-'));
let registry: SessionRegistry;
let app: App;
const C: Caller = { principal: A, connectionId: 'cs' };
const live = (id: string) => {
  const s = registry.get(id);
  assert.ok(s?.kind === 'live', `${id} is live`);
  return s.session;
};
const serviceEvents = (j: Journal) => j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'service' }> => e.type === 'service');

before(() => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  app = new App({ registry, defaultWaitMs: 5000 });
});

after(async () => {
  await registry.closeAll({ graceful: false });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('m2-1/atc-7 (real bash): `start false` with no probe is exited 1 — the envelope never says ready; a live one is running after 2 s', async () => {
  const dead = await app.start(C, { session: 'svc-false', command: 'false', wait: 5000 });
  assert.equal(dead.service, 'exited', JSON.stringify(dead));
  assert.equal(dead.exit, 1);
  assert.deepEqual(serviceEvents(live('svc-false').journal).map((e) => e.status), ['starting', 'exited']);

  const t0 = Date.now();
  const alive = await app.start(C, { session: 'svc-sleep', command: 'sleep 30', target: 'process', wait: 5000 });
  assert.equal(alive.service, 'running', JSON.stringify(alive));
  assert.ok(Date.now() - t0 >= 1900, `the 1.x liveness window: ${Date.now() - t0} ms`);
  assert.match(String(alive.probe), /no readiness probe/);
  const crash = await app.start(C, { session: 'svc-crash', command: 'node /nonexistent-tsm.js', target: 'process', wait: 5000 });
  assert.equal(crash.service, 'exited', 'a command that crashes at startup is not reported ready (atc-7)');
  await app.cancel(C, { runId: alive.runId! });
});

test('m2-6 (real bash): closing the shell under a service that ignores SIGHUP reports it lost, and close then ends it (ss-6)', async () => {
  const tag = `TSMHUP${process.pid}`;
  const js = `process.on('SIGHUP',()=>{});const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log('listening ${tag}',s.address().port)});`;
  try {
    const r = await app.start(C, { session: 'svc-hup', command: `node -e "${js}"`, ready: { pattern: 'listening' }, wait: 8000 });
    assert.equal(r.service, 'ready', JSON.stringify(r));
    const j = live('svc-hup').journal;
    await registry.close('svc-hup', { graceful: true });
    const statuses = serviceEvents(j).map((e) => e.status);
    assert.deepEqual(statuses, ['starting', 'ready', 'lost'], 'never `exited`: its end was not observed (G9)');
    assert.match(String(serviceEvents(j).at(-1)?.evidence), /outcome unknown/);
    // The job survived the hangup, so close sent it SIGTERM, then SIGKILL (ss-6): nothing is left running.
    await until(() => spawnSync('pgrep', ['-f', tag]).status !== 0, 3000, 'the job is gone');
  } finally {
    try {
      execFileSync('pkill', ['-f', tag]);
    } catch {
      // already gone
    }
  }
});

test('m2-15 (real process): a fail line while the port keeps accepting stays unhealthy through health checks', async () => {
  const js = `const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log('listening '+s.address().port);setTimeout(()=>console.log('FATAL: database connection lost'),300)});`;
  const probe = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => probe.once('listening', r));
  const port = (probe.address() as net.AddressInfo).port;
  try {
    const r = await app.start(C, { session: 'svc-fatal', target: 'process', command: `node -e "${js}"`, ready: { pattern: 'listening' }, fail: { pattern: 'FATAL' }, health: { tcp: { port }, intervalMs: 250 }, wait: 5000 });
    assert.equal(r.service, 'ready');
    const mon = app.extras(live('svc-fatal')).services.get(r.runId!)!;
    await until(() => mon.status === 'unhealthy', 3000, 'unhealthy');
    await sleep(900);
    assert.equal(mon.status, 'unhealthy', serviceEvents(live('svc-fatal').journal).map((e) => `${e.status}(${e.evidence})`).join(' → '));
    await app.cancel(C, { runId: r.runId! });
  } finally {
    probe.close();
  }
});

test('m2-21 (real process): a ready line split on stdout around a stderr write still passes', async () => {
  const js = `process.stdout.write('Server listen');setTimeout(()=>{process.stderr.write('warn: deprecated\\\\n');setTimeout(()=>{process.stdout.write('ing on 8080\\\\n');setInterval(()=>{},1000)},100)},100)`;
  const r = await app.start(C, { session: 'svc-split', target: 'process', command: `node -e "${js}"`, ready: { pattern: 'listening on \\d+' }, wait: 5000 });
  assert.equal(r.service, 'ready', JSON.stringify(r));
  await app.cancel(C, { runId: r.runId! });
});

test('m2-5: a start whose pattern the engine refuses fails with invalid_argument and leaves no Run running', async () => {
  const bad = app.start(C, { session: 'svc-bad', command: 'sleep 30', target: 'process', ready: { pattern: 'x*' }, wait: 1000 });
  await assert.rejects(bad, (e: unknown) => e instanceof TermError && e.code === 'invalid_argument');
  const s = registry.get('svc-bad');
  if (s?.kind === 'live') await until(() => s.session.listRuns().every((r) => r.state !== 'running' && r.state !== 'starting'), 3000, 'no Run left running');
});

test('a fail-pattern match on a line longer than the pattern\'s window says it matched on the line\'s head (the house\'s read of the 36 commits, #22)', () => {
  const f = fake('process');
  // A costly pattern gets a small match window, so a moderate line is matched on its head.
  const m = f.monitor({ ready: { pattern: 'up' }, fail: { pattern: `${'.'.repeat(999)}0` } });
  f.start();
  f.out('up\n');
  f.out(`${'x'.repeat(999)}0${'y'.repeat(20_000)}\n`, 'stdout');
  assert.equal(m.status, 'unhealthy');
  assert.match(String(m.info().evidence), /\(matched on the line's head\)$/);
  m.dispose();
});
