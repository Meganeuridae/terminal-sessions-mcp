/**
 * The application layer's round-2 fixes against real bash: authorization of a name
 * another call is creating (jr2-1), idempotency bounds, argument checks and restart
 * survival (G16), earlier lives (G30), and results that tell agents what to do next
 * (the compat pack's 1.x fidelity: compat.spec).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { callTool, TOOLS, type ResultText, type ToolResult } from '../src/api/tools.js';
import { validate } from '../src/api/validate.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { sleep, until } from './testhost.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-app2-'));
let registry: SessionRegistry;
let app: App;
const A: Caller = { principal: 'agent:a@test', connectionId: 'ca' };
const B: Caller = { principal: 'agent:b@test', connectionId: 'cb' };

async function tool(name: string, args: Record<string, unknown>, caller: Caller = A, mode: ResultText = 'transcript'): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name)!;
  const r = await callTool(name, args, { app, caller, resultText: mode }, TOOLS);
  if (r.isError) assert.equal(r.structured, undefined, `${name}: error results carry no envelope`);
  else if (def.outputSchema) validate(r.structured, def.outputSchema);
  return r;
}

before(() => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  app = new App({ registry, defaultWaitMs: 5000 });
});

after(async () => {
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('jr2-1: a principal racing another principal’s first open of a new private name is refused, never handed the session', async () => {
  const [a, bOpen, bRun] = await Promise.all([
    tool('session_open', { session: 'race1' }),
    tool('session_open', { session: 'race1' }, B),
    tool('run', { session: 'race1', command: 'echo pwned' }, B),
  ]);
  assert.equal(a.isError, undefined, a.text);
  for (const r of [bOpen, bRun]) {
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /^session_exists: the name race1 belongs to another principal/);
  }
  const s = registry.get('race1');
  assert.ok(s?.kind === 'live');
  assert.ok(!s.session.listAttachments().some((x) => x.principal === B.principal), 'B was never attached');
  assert.ok(!s.session.listRuns().some((r) => r.principal === B.principal), 'B ran nothing');
});

test('G16: a key reused with other arguments is refused; a busy outcome is not remembered; keys are bounded', async () => {
  const k = `k-${Date.now()}`;
  const first = await tool('run', { session: 'idem1', command: 'echo one', idempotencyKey: k });
  assert.equal(first.structured?.state, 'exited');
  const again = await tool('run', { session: 'idem1', command: 'echo one', idempotencyKey: k, wait: 1000 });
  assert.equal(again.structured?.replayed, true, 'wait does not count as an argument');
  const other = await tool('run', { session: 'idem1', command: 'echo two', idempotencyKey: k });
  assert.match(other.text, /^invalid_argument: idempotencyKey .* other arguments/);
  const long = await tool('run', { session: 'idem1', command: 'echo x', idempotencyKey: 'x'.repeat(201) });
  assert.match(long.text, /^invalid_argument: idempotencyKey must be/);

  await tool('run', { session: 'idem1', command: 'sleep 1.5', wait: 0 });
  const kb = `kb-${Date.now()}`;
  const busy = await tool('run', { session: 'idem1', command: 'echo after-busy', idempotencyKey: kb, wait: 50 });
  assert.equal(busy.structured?.state, 'busy');
  assert.match(busy.text, /busy: running r\S+ by agent:a@test \(sleep 1\.5\) — nothing was run; await or cancel it, pass queue:true/);
  await sleep(1800);
  const retry = await tool('run', { session: 'idem1', command: 'echo after-busy', idempotencyKey: kb });
  assert.equal(retry.structured?.state, 'exited', 'the retry of a busy call runs');
  assert.notEqual(retry.structured?.replayed, true);
});

test('G16: a keyed run retried after a restart is the same Run, never a second execution (jr2-5, atc-13)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-idem-restart-'));
  const log = path.join(dir, 'deploys.log');
  const k = 'deploy-42';
  let reg = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  let a = new App({ registry: reg, defaultWaitMs: 3000 });
  const call = (name: string, args: Record<string, unknown>) => callTool(name, args, { app: a, caller: A, resultText: 'json' }, TOOLS);
  try {
    const r1 = JSON.parse((await call('run', { session: 'dep', command: `echo deploying >> ${log}; sleep 30`, wait: 300, idempotencyKey: k })).text);
    assert.equal(r1.state, 'running');
    await reg.closeAll();
    reg = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    a = new App({ registry: reg, defaultWaitMs: 3000 });
    // Check before replay populates the in-memory cache: the journal must retain
    // key identity separately from the original tool and arguments.
    for (const changed of [
      { session: 'dep', command: `echo duplicate >> ${log}` },
      { session: 'elsewhere', command: `echo deploying >> ${log}; sleep 30` },
      { session: 'dep', command: `echo deploying >> ${log}; sleep 30`, target: 'process' },
    ]) {
      const conflict = await call('run', { ...changed, idempotencyKey: k });
      assert.equal(conflict.isError, true);
      assert.match(conflict.text, /other arguments/);
    }
    const otherTool = await call('input', { session: 'dep', text: 'unexpected', idempotencyKey: k });
    assert.equal(otherTool.isError, true);
    assert.match(otherTool.text, /was used for run, not input/);
    const r2 = JSON.parse((await call('run', { session: 'dep', command: `echo deploying >> ${log}; sleep 30`, wait: 300, idempotencyKey: k })).text);
    assert.equal(r2.runId, r1.runId, 'the same Run');
    assert.equal(r2.replayed, true);
    assert.equal(r2.state, 'lost');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'executed once');
  } finally {
    await reg.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G16: a replay after the session was forgotten returns the first outcome (atc-21); control, env capture and unwatch take keys', async () => {
  const k = `kf-${Date.now()}`;
  const first = await tool('run', { session: 'forg', command: 'echo gone', idempotencyKey: k });
  await tool('session_close', { session: 'forg', forget: true });
  const again = await tool('run', { session: 'forg', command: 'echo gone', idempotencyKey: k });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.structured?.replayed, true);
  assert.equal(again.structured?.runId, first.structured?.runId);
  for (const [name, args] of [
    ['control', { session: 'idem1', action: 'take' }],
    ['session_env_capture', { session: 'idem1' }],
  ] as const) {
    const key = `${name}-${Date.now()}`;
    const r1 = await tool(name, { ...args, idempotencyKey: key });
    assert.equal(r1.isError, undefined, r1.text);
    const r2 = await tool(name, { ...args, idempotencyKey: key });
    assert.equal(r2.structured?.replayed, true, name);
  }
});

test('G30: cancel on an earlier life’s Run returns its recorded outcome (jr2-13); watches survive a new life (m2-14); wait_for refuses an exited shell (m2-24)', async () => {
  const r = await tool('run', { session: 'lives', command: 'echo first-life' });
  await tool('watch', { session: 'lives', pattern: 'DEPLOYED', label: 'deploy' });
  await tool('run', { session: 'lives', command: 'exit 3' });
  await until(() => registry.get('lives')?.kind === 'live' && (registry.get('lives') as { session: { exit?: unknown } }).session.exit !== undefined, 5000);
  const w = await tool('wait_for', { session: 'lives', pattern: 'x', wait: 5000 });
  assert.match(w.text, /no pattern match · session exited \(code 3\)/);
  const next = await tool('run', { session: 'lives', command: 'echo second-life' });
  assert.equal(next.structured?.created, true);
  const c = await tool('cancel', { runId: r.structured?.runId, session: 'lives' });
  assert.equal(c.isError, undefined, c.text);
  assert.equal(c.structured?.state, 'exited');
  const list = await tool('watches', { session: 'lives' });
  assert.equal((list.structured?.watches as Array<{ label: string }>).map((x) => x.label).join(), 'deploy');
});

test('atc-15: every tool’s success text is JSON in json mode', async () => {
  await tool('session_open', { session: 'js1' });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['run', { session: 'js1', command: 'echo j' }],
    ['input', { session: 'js1', text: '' , keys: ['C-u'] }],
    ['session_list', {}],
    ['screen', { session: 'js1' }],
    ['read', { session: 'js1', tail: 3 }],
    ['control', { session: 'js1', action: 'status' }],
    ['resize', { session: 'js1', cols: 100, rows: 30 }],
    ['session_env_capture', { session: 'js1' }],
    ['watch', { session: 'js1', pattern: 'zz' }],
    ['watches', { session: 'js1' }],
    ['wait_for', { session: 'js1', pattern: 'j', since: 0, wait: 500 }],
    ['search', { session: 'js1', pattern: 'j' }],
    ['signal', { session: 'js1', signal: 'SIGINT' }],
    ['session_close', { session: 'js1' }],
  ];
  for (const [name, args] of calls) {
    const r = await tool(name, args, A, 'json');
    assert.equal(r.isError, undefined, `${name}: ${r.text}`);
    assert.doesNotThrow(() => JSON.parse(r.text), `${name}: ${r.text}`);
  }
});

test('G28: a terminal Run result is marked delivered only when the transport says it was sent (mcpl-1)', async () => {
  const r = await callTool('run', { session: 'sent1', command: 'echo sent' }, { app, caller: A, resultText: 'transcript' }, TOOLS);
  const s = registry.get('sent1');
  assert.ok(s?.kind === 'live');
  const runId = r.structured?.runId as string;
  assert.equal(s.session.outcomeDeliveredTo(runId, A.principal), false, 'not before it was sent');
  assert.equal(typeof r.onSent, 'function');
  r.onSent!();
  assert.equal(s.session.outcomeDeliveredTo(runId, A.principal), true);
  const running = await callTool('run', { session: 'sent1', command: 'sleep 1', wait: 0 }, { app, caller: A, resultText: 'transcript' }, TOOLS);
  assert.equal(running.onSent, undefined, 'a running result delivers no outcome');
  await sleep(1100);
});

test('results name what to do next: queued, waiting for input, ignored cwd, integration, runs in the session summary, search cursors', async () => {
  await tool('run', { session: 'ux1', command: 'sleep 1', wait: 0 });
  const q = await tool('run', { session: 'ux1', command: 'echo q', wait: 100, queue: true });
  assert.equal(q.structured?.state, 'queued');
  assert.match(q.text, /queued for \S+, not started — it runs when the shell is free; await it/);
  await tool('await', { runId: q.structured?.runId });

  const asked = await tool('run', { session: 'ux1', command: 'read -p "Overwrite existing config? [y/N] " a; echo "got $a"', wait: 3600 });
  assert.equal(asked.structured?.state, 'running');
  assert.equal((asked.structured?.waiting as { kind: string }).kind, 'input');
  assert.match(asked.text, /seems to wait for input .*Overwrite existing config\? \[y\/N\]/);
  await tool('input', { session: 'ux1', text: 'n', keys: ['Enter'] });
  await tool('await', { runId: asked.structured?.runId });

  const cwd = await tool('run', { session: 'ux1', command: 'pwd', cwd: os.tmpdir() });
  assert.deepEqual(cwd.structured?.ignored, ['cwd']);
  assert.match(cwd.text, /ignored: cwd \(the session exists; cd in the command instead\)/);
  assert.equal(cwd.structured?.integration, 'rich');

  const p = await tool('run', { session: 'ux1', command: 'sleep 2', target: 'process', wait: 0 });
  const list = await tool('session_list', {});
  assert.match(list.text, new RegExp(`runs ${p.structured?.runId as string} running \\(process\\) "sleep 2"`));
  await tool('cancel', { runId: p.structured?.runId });

  await tool('run', { session: 'ux1', command: 'printf "a\\nNEEDLE here\\nb\\n"' });
  const found = await tool('search', { session: 'ux1', pattern: 'NEEDLE' });
  const m = /\[read since=(\d+)(?: offset=(\d+))?\]/.exec(found.text);
  assert.ok(m, found.text);
  const page = await tool('read', { session: 'ux1', since: Number(m[1]), ...(m[2] ? { offset: Number(m[2]) } : {}) });
  assert.match(page.text, /NEEDLE here/, 'reading from the cursor includes the match');
});
