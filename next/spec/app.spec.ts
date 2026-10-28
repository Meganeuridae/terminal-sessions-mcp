/**
 * The application API and the tool table against real bash: idempotency (G16),
 * verbs (G17/G18), every result envelope against its outputSchema (G27), read
 * paging (G11), search, services (G9), and watches (the compat pack: compat.spec).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { callTool, TOOLS, toolsFor, type ResultText, type ToolResult } from '../src/api/tools.js';
import { analyze, type UsageRecord } from '../src/api/usage.js';
import { validate } from '../src/api/validate.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { clocks } from '../src/core/clock.js';
import { until } from './testhost.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-app-'));
let registry: SessionRegistry;
let app: App;
const A: Caller = { principal: 'agent:a@test', connectionId: 'ca' };
const B: Caller = { principal: 'agent:b@test', connectionId: 'cb' };

/** Call a tool and check its envelope against the declared outputSchema, in both renderings. */
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

test('G27: every run/await envelope conforms to its outputSchema — exited, running, busy (with and without a Run), cancelled, errors — in both renderings', async () => {
  for (const mode of ['json', 'transcript'] as const) {
    const s = `schema-${mode}`;
    const ok = await tool('run', { session: s, command: 'echo ok' }, A, mode);
    assert.equal(ok.structured?.state, 'exited');
    const running = await tool('run', { session: s, command: 'sleep 3', wait: 30 }, A, mode);
    assert.ok(['starting', 'running'].includes(running.structured?.state as string), String(running.structured?.state));
    const busy = await tool('run', { session: s, command: 'echo no', wait: 30 }, A, mode);
    assert.equal(busy.structured?.state, 'busy');
    assert.equal(busy.structured?.runId, undefined, 'a busy result admits nothing and names no runId of its own');
    const c = await tool('cancel', { runId: running.structured?.runId }, A, mode);
    assert.equal(c.structured?.state, 'cancelled', JSON.stringify(c.structured));
    await tool('wait_for', { session: s, idle: true, wait: 3000 }, A, mode);
    await tool('input', { session: s, text: 'half-typed' }, A, mode);
    const editing = await tool('run', { session: s, command: 'echo no', wait: 30 }, A, mode);
    assert.equal(editing.structured?.state, 'busy');
    assert.equal((editing.structured?.busy as { runId?: string }).runId, undefined, 'no occupying Run: busy.runId is omitted, not null');
    await tool('input', { session: s, keys: ['C-u'] }, A, mode);
    const err = await tool('await', { runId: 'r999-nope' }, A, mode);
    assert.equal(err.isError, true);
    assert.match(err.text, /^run_not_found:/);
    const scr = await tool('screen', { session: s }, A, mode);
    assert.ok(Array.isArray(scr.structured?.lines));
    await tool('read', { session: s, tail: 5 }, A, mode);
    await tool('session_list', {}, A, mode);
  }
});

test('G16: a retried run with the same idempotency key is the same Run, executed once; a retried input is not typed twice', async () => {
  const first = await tool('run', { session: 'idem', command: 'echo once-$RANDOM', idempotencyKey: 'k-run-1' });
  const again = await tool('run', { session: 'idem', command: 'echo once-$RANDOM', idempotencyKey: 'k-run-1' });
  assert.equal(again.structured?.runId, first.structured?.runId);
  assert.equal(again.structured?.replayed, true);
  const s = registry.get('idem');
  assert.ok(s?.kind === 'live');
  assert.equal(s.session.journal.since(0).events.filter((e) => e.type === 'run.admit').length, 1, 'executed once');

  const slow = await tool('run', { session: 'idem', command: 'sleep 0.6; echo slow-done', wait: 20, idempotencyKey: 'k-run-2' });
  assert.ok(['starting', 'running'].includes(slow.structured?.state as string), `still running: ${slow.structured?.state}`);
  const retried = await tool('run', { session: 'idem', command: 'sleep 0.6; echo slow-done', wait: 5000, idempotencyKey: 'k-run-2' });
  assert.equal(retried.structured?.runId, slow.structured?.runId, 'the retry awaits the same Run');
  assert.equal(retried.structured?.state, 'exited');

  await tool('input', { session: 'idem', text: 'x', idempotencyKey: 'k-in' });
  await tool('input', { session: 'idem', text: 'x', idempotencyKey: 'k-in' });
  assert.equal(s.session.journal.since(0).events.filter((e) => e.type === 'input' && e.data === 'x').length, 1, 'typed once');
  await tool('input', { session: 'idem', keys: ['C-u'] });

  const misuse = await tool('signal', { session: 'idem', idempotencyKey: 'k-in' });
  assert.equal(misuse.isError, true);
  assert.match(misuse.text, /invalid_argument/);
});

test('G18: verbs hold for every tool — a non-owner cannot touch a private session; an observer of a shared one cannot act or destroy', async () => {
  await tool('session_open', { session: 'priv' });
  const r = await tool('run', { session: 'priv', command: 'sleep 2', wait: 20 });
  for (const [name, args] of [
    ['read', { session: 'priv', tail: 3 }],
    ['screen', { session: 'priv' }],
    ['await', { runId: r.structured?.runId, session: 'priv' }],
    ['cancel', { runId: r.structured?.runId, session: 'priv' }],
    ['input', { session: 'priv', text: 'x' }],
    ['run', { session: 'priv', command: 'id' }],
    ['session_close', { session: 'priv' }],
  ] as const) {
    const res = await tool(name, args, B);
    assert.equal(res.isError, true, `${name} by a non-owner`);
    // run names a session it could create: someone else's name says so (ux-9).
    assert.match(res.text, name === 'run' ? /^session_exists: the name priv belongs to another principal/ : /^(forbidden|run_not_found|session_not_found):/, `${name}: ${res.text}`);
  }
  await tool('cancel', { runId: r.structured?.runId });

  await tool('session_open', { session: 'shared1', visibility: 'shared' });
  const seen = await tool('session_open', { session: 'shared1' }, B);
  assert.equal(seen.structured?.role, 'observer');
  for (const [name, args, code] of [
    ['input', { session: 'shared1', text: 'x' }, 'not_controller'],
    ['session_close', { session: 'shared1' }, 'forbidden'],
  ] as const) {
    const res = await tool(name, args, B);
    assert.equal(res.isError, true, `${name} by an observer`);
    assert.match(res.text, new RegExp(`^${code}:`), res.text);
  }
  for (const [name, args] of [
    ['signal', { session: 'shared1', signal: 'SIGINT' }],
    ['resize', { session: 'shared1', cols: 100, rows: 30 }],
  ] as const) {
    const def = TOOLS.find((t) => t.name === name)!;
    const res = await callTool(def.name, args, { app, caller: B, resultText: 'transcript' }, TOOLS);
    assert.equal(res.isError, true, `${name} by an observer`);
  }
});

test('G11: read pages forward head-first — every output line exactly once, with truthful more/nextCursor; tail gives the last lines', async () => {
  await tool('run', { session: 'pages', command: 'for i in $(seq 1 3000); do echo "line-$i-padding-padding-padding"; done' });
  const seen: string[] = [];
  let cursor = 0;
  let offset: number | undefined;
  let carry = '';
  for (let i = 0; i < 100; i++) {
    // A page may end inside a large output event: continue there with nextOffset, or text repeats.
    const r = await tool('read', { session: 'pages', since: cursor, ...(offset ? { offset } : {}), maxBytes: 8192 });
    // A page that ends mid-line says so; its last line continues on the next page.
    carry += r.structured?.text as string;
    if (r.structured?.splitLine !== true) carry += '\n';
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const l of lines) if (/^line-\d+-/.test(l)) seen.push(l);
    const next = r.structured?.nextCursor as number;
    assert.ok(next >= cursor, 'the cursor never goes back');
    cursor = next;
    offset = r.structured?.nextOffset as number | undefined;
    if (!r.structured?.more) break;
  }
  const nums = seen.map((l) => Number(/^line-(\d+)-/.exec(l)![1]));
  assert.equal(nums.length, 3000, `lines read: ${nums.length}`);
  assert.deepEqual(nums, Array.from({ length: 3000 }, (_, i) => i + 1));
  const tail = await tool('read', { session: 'pages', tail: 3 });
  const lines = (tail.structured?.text as string).split('\n').filter((l) => l.trim());
  assert.ok(lines.some((l) => l.includes('line-3000-')), lines.join('|'));
  const byRun = await tool('run', { session: 'pages', command: 'seq 1 5' });
  const rr = await tool('read', { session: 'pages', runId: byRun.structured?.runId });
  assert.equal((rr.structured?.text as string).trim(), '1\n2\n3\n4\n5');
});

test('a Run result cut to the result size carries the omission line, is truncated, and leaves the read cursor at the Run\'s end (the house\'s read of 1cabc6a)', async () => {
  const r = await app.run(A, { session: 'omit', command: 'seq 1 5000', wait: 20_000 });
  assert.equal(r.state, 'exited');
  assert.equal(r.output.truncated, true);
  assert.match(r.output.text, new RegExp(`^\\[… earlier output omitted · read session=omit runId=${r.runId} pages through all of it\\]\\n`));
  assert.ok(Buffer.byteLength(r.output.text) <= 16 * 1024 + 200, `${Buffer.byteLength(r.output.text)} bytes`);
  assert.match(r.output.text, /\n5000\s*$/);
  const s = registry.get('omit');
  assert.ok(s?.kind === 'live');
  assert.equal(s.session.cursorsOf(A.principal).read, r.output.nextCursor, 'nothing else unread: the cursor is at the Run\'s end');
});

test('search: regex matches with seq anchors and context', async () => {
  await tool('run', { session: 'srch', command: 'printf "alpha\\nbeta ERROR one\\ngamma\\ndelta\\nERROR two\\nomega\\n"' });
  const r = await tool('search', { session: 'srch', pattern: 'ERROR', context: 1 });
  const m = r.structured?.matches as Array<{ line: string; before: string[]; after: string[]; seq: number }>;
  assert.equal(m.filter((x) => !x.line.includes('printf')).length, 2);
  const one = m.find((x) => x.line === 'beta ERROR one')!;
  assert.deepEqual(one.before, ['alpha']);
  assert.deepEqual(one.after, ['gamma']);
  assert.ok(one.seq > 0);
});

test('G9: a Service is ready only by its probe, and exited only when its process ends — never because the shell is alive', async () => {
  const ready = await tool('start', { session: 'svc1', command: 'echo booting; sleep 0.3; echo "listening on 7777"; sleep 30', ready: { pattern: 'listening on \\d+' }, wait: 5000 });
  assert.equal(ready.structured?.service, 'ready', JSON.stringify(ready.structured));
  assert.match(String(ready.structured?.evidence), /listening on 7777/);
  const svcRun = ready.structured?.runId as string;
  await tool('cancel', { runId: svcRun });
  const s1 = registry.get('svc1');
  assert.ok(s1?.kind === 'live');
  await until(() => app.extras(s1.session).services.get(svcRun)?.status === 'exited', 4000, 'service exited');

  const dead = await tool('start', { session: 'svc2', command: 'false', ready: { pattern: 'never' }, wait: 3000 });
  assert.equal(dead.structured?.service, 'exited', 'a service whose process is `false` is exited with code 1, not running');
  assert.equal(dead.structured?.exit, 1);

  const srv = net.createServer().listen(0);
  const port = (srv.address() as net.AddressInfo).port;
  const tcp = await tool('start', { session: 'svc3', command: 'sleep 20', target: 'process', ready: { tcp: { port } }, wait: 3000 });
  assert.equal(tcp.structured?.service, 'ready');
  srv.close();
  await tool('cancel', { runId: tcp.structured?.runId });

  const unhealthy = await tool('start', { session: 'svc4', command: 'echo up; sleep 0.3; echo "FATAL: boom"; sleep 20', ready: { pattern: 'up' }, fail: { pattern: 'FATAL' }, wait: 2000 });
  assert.equal(unhealthy.structured?.service, 'ready');
  const s4 = registry.get('svc4');
  assert.ok(s4?.kind === 'live');
  await until(() => app.extras(s4.session).services.get(unhealthy.structured?.runId as string)?.status === 'unhealthy', 3000, 'unhealthy');
  await tool('cancel', { runId: unhealthy.structured?.runId });
});

test('watches: a pattern watch fires as a journal event; wait_for sees a line printed before the call via since; idle and silence', async () => {
  await tool('session_open', { session: 'wat' });
  const w = await tool('watch', { session: 'wat', pattern: 'DEPLOYED', label: 'deploy' });
  assert.equal(w.structured?.kind, 'pattern');
  const before = registry.get('wat');
  assert.ok(before?.kind === 'live');
  const since = before.session.journal.lastSeq;
  // printf keeps the pattern out of the echoed command line.
  await tool('run', { session: 'wat', command: "printf 'all DEPL%s ok\\n' OYED" });
  await until(() => before.session.journal.since(since).events.some((e) => e.type === 'watch.fired' && e.label === 'deploy'), 2000, 'watch fired');
  const waited = await tool('wait_for', { session: 'wat', pattern: 'DEPLOYED', since, wait: 100 });
  assert.equal(waited.structured?.matched, true);
  assert.match(String(waited.structured?.line), /all DEPLOYED ok/);
  const idle = await tool('wait_for', { session: 'wat', idle: true, wait: 1000 });
  assert.equal(idle.structured?.matched, true);
  await tool('run', { session: 'wat', command: 'sleep 1', wait: 10 });
  const quiet = await tool('wait_for', { session: 'wat', silenceMs: 300, wait: 3000 });
  assert.equal(quiet.structured?.matched, true);
  const none = await tool('wait_for', { session: 'wat', pattern: 'NEVER-PRINTED', wait: 200 });
  assert.equal(none.structured?.matched, false);
  const list = await tool('watches', { session: 'wat' });
  assert.equal((list.structured?.watches as unknown[]).length, 1);
  const rm = await tool('unwatch', { session: 'wat', watchId: w.structured?.watchId }, B);
  assert.equal(rm.isError, true, 'only the watch owner or session owner removes it');
  await tool('unwatch', { session: 'wat', watchId: w.structured?.watchId });
});

test('Measure: the usage report finds the confusion signatures', () => {
  const base = { principal: 'p', connection: 'c', host: 'mcp' as const, profile: 'core', ok: true, ms: 5, session: 's', args: [] };
  const recs: UsageRecord[] = [
    { ...base, ts: 1000, tool: 'run', state: 'running' },
    { ...base, ts: 2000, tool: 'read' },
    { ...base, ts: 3000, tool: 'input', digest: 'aa' },
    { ...base, ts: 3500, tool: 'input', digest: 'aa' },
    { ...base, ts: 4000, tool: 'screen' },
    { ...base, ts: 5000, tool: 'screen' },
    { ...base, ts: 6000, tool: 'screen' },
    { ...base, ts: 7000, tool: 'run', state: 'busy' },
    { ...base, ts: 8000, tool: 'run', state: 'busy' },
    { ...base, ts: 9000, tool: 'cancel', ok: false, error: 'run_not_found' },
  ];
  const r = analyze(recs);
  assert.equal(r.signatures['read-after-short-wait']!.count, 1);
  assert.equal(r.signatures['input-twice']!.count, 1);
  assert.equal(r.signatures['screen-polling']!.count, 1);
  assert.equal(r.signatures['busy-retry']!.count, 1);
  assert.equal(r.signatures['cancel-after-busy']!.count, 1);
  assert.equal(r.byTool.cancel!.errors, 1);
});

test('G18: the App rereads a repaired record before judging a new life\'s owner, so the owner reopens without a restart (the house\'s read of the 36 commits, #22, comment 6269992150)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-app-repair-'));
  try {
    const r1 = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    const a1 = new App({ registry: r1, defaultWaitMs: 5000 });
    await a1.sessionOpen(A, { id: 'rp' });
    await a1.sessionClose(A, { session: 'rp' });
    await r1.closeAll();
    // The record is damaged: a fresh daemon surfaces the session with an unknown owner.
    const file = path.join(dir, 'sessions', 'rp', 'session.json');
    fs.writeFileSync(file, '{');
    const r2 = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    const a2 = new App({ registry: r2, defaultWaitMs: 5000 });
    try {
      assert.equal(r2.get('rp')?.kind, 'history');
      // The operator repairs the record on disk, naming the real owner. The owner's own call must
      // reread it before judging — not refuse from the cached unknown owner, as it did before the fix.
      fs.writeFileSync(file, JSON.stringify({ owner: A.principal, visibility: 'private' }));
      const r = await a2.sessionOpen(A, { id: 'rp' });
      assert.ok(r, 'the owner reopens the repaired session with no restart');
      assert.equal(r2.get('rp')?.kind, 'live');
    } finally {
      await r2.closeAll();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run, await and start results report the session’s duration, and a queued Run its wait, on the monotonic clock: a wall-clock step back reads no negative time', async (t) => {
  // A reviewer's read of the fixes for #22: the results computed `endedAt - startedAt` on the wall clock, so with the clock
  // stepped back 3 s while 2.5 s passed a result read `exited 0 in -2999ms` beside a completion's 2.5s. The sessions are
  // created after the stub, as a daemon's would be before a step.
  const realNow = Date.now;
  const realMono = clocks.monotonic;
  let wallStep = 0;
  let monoStep = 0;
  Date.now = () => realNow() + wallStep;
  clocks.monotonic = () => realMono() + monoStep;
  t.after(() => {
    Date.now = realNow;
    clocks.monotonic = realMono;
  });
  // The Run outlives the checks of a Run in flight and is cancelled once they are done: a `sleep 3` could end first
  // on a loaded machine, before those checks (the house's read of the 33 commits, #22, comment 6307350650, item 10).
  const first = await tool('run', { session: 'dur', command: 'sleep 300', wait: 300 });
  const runId = first.structured?.runId as string;
  const live = registry.get('dur');
  assert.ok(live?.kind === 'live');
  await until(() => live.session.run(runId).state === 'running', 5000, 'the Run to start');
  const behind = await tool('run', { session: 'dur', command: 'echo behind', queue: true, wait: 0 });
  assert.equal(behind.structured?.state, 'queued', JSON.stringify(behind.structured));
  const svc = await tool('start', { session: 'dursvc', command: 'echo up; sleep 30', ready: { pattern: 'up' }, wait: 5000, idempotencyKey: 'dur-svc-1' });
  assert.equal(svc.structured?.service, 'ready', JSON.stringify(svc.structured));
  wallStep -= 3000;
  monoStep += 2500;
  const mid = await tool('await', { runId, wait: 50 });
  assert.equal(mid.structured?.state, 'running');
  assert.ok((mid.structured?.durationMs as number) >= 2500, `a Run in flight, so far: ${mid.structured?.durationMs} ms`);
  const waiting = await tool('await', { runId: behind.structured?.runId, wait: 50 });
  assert.equal(waiting.structured?.state, 'queued');
  assert.ok((waiting.structured?.queuedMs as number) >= 2500, `a queued Run's wait: ${waiting.structured?.queuedMs} ms`);
  assert.doesNotMatch(waiting.text, /queued for -/, waiting.text);
  await tool('cancel', { runId });
  const done = await tool('await', { runId, wait: 10_000 });
  assert.equal(done.structured?.state, 'cancelled', JSON.stringify(done.structured));
  assert.ok((done.structured?.durationMs as number) >= 2500, `the ended Run: ${done.structured?.durationMs} ms`);
  assert.doesNotMatch(done.text, /in -\d/, done.text);
  const replayed = await tool('start', { session: 'dursvc', command: 'echo up; sleep 30', ready: { pattern: 'up' }, wait: 5000, idempotencyKey: 'dur-svc-1' });
  assert.equal(replayed.structured?.replayed, true);
  assert.ok((replayed.structured?.durationMs as number) >= 2500, `a service, so far: ${replayed.structured?.durationMs} ms`);
  await app.sessionClose(A, { session: 'dursvc' });
});

async function summariesBuilt(body: () => Promise<unknown> | unknown): Promise<string[]> {
  const built: string[] = [];
  const original = app.summary;
  app.summary = function (this: App, s) {
    const out = original.call(this, s);
    built.push(out.id);
    return out;
  };
  try {
    await body();
  } finally {
    app.summary = original;
  }
  return built;
}

test("compat runCommand finds its session without building any other session's summary", async () => {
  const compat = toolsFor('compat');
  for (const id of ['many-1', 'many-2', 'many-3']) await tool('session_open', { session: id });
  await tool('session_open', { session: 'many-b', visibility: 'shared' }, B);
  await callTool('runCommand', { session: 'many-1', command: 'echo first' }, { app, caller: A, resultText: 'json' }, compat);
  const built = await summariesBuilt(() => callTool('runCommand', { session: 'many-1', command: 'echo again' }, { app, caller: A, resultText: 'json' }, compat));
  assert.ok(built.length > 0, 'runCommand looks its session up');
  assert.deepEqual([...new Set(built)], ['many-1'], `summaries built: ${JSON.stringify(built)}`);
  for (const id of ['many-1', 'many-2', 'many-3']) await app.sessionClose(A, { session: id });
  await app.sessionClose(B, { session: 'many-b' });
});

test("sessionSummary is sessionList's entry for one id, and none for an id the caller can't see or that doesn't exist", async () => {
  await tool('session_open', { session: 'one-a' });
  await tool('session_open', { session: 'one-shared', visibility: 'shared' }, B);
  await tool('session_open', { session: 'one-private' }, B);
  for (const id of ['one-a', 'one-shared', 'one-private', 'one-none']) {
    const listed = app.sessionList(A).find((s) => s.id === id);
    let one: ReturnType<App['sessionSummary']> = undefined;
    const built = await summariesBuilt(() => {
      one = app.sessionSummary(A, id);
    });
    assert.deepEqual(one, listed, id);
    assert.deepEqual(built, listed ? [id] : [], id);
  }
  await app.sessionClose(A, { session: 'one-a' });
  await app.sessionClose(B, { session: 'one-shared' });
  await app.sessionClose(B, { session: 'one-private' });
});
