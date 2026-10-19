#!/usr/bin/env node
/**
 * Milestone-1 acceptance against a REAL MCPL host: agent-framework's host code
 * (the sibling archipelago-design checkout, built dist), with a mock model, no
 * LLM. termd runs in-process on an ephemeral port.
 *
 *   node next/acceptance/agent-framework.mjs          (after npm run build:next)
 *
 * It checks the sentence — start work, receive a run id, stop waiting,
 * disconnect, reconnect, recover retained output, observe the correct outcome,
 * and receive a useful completion notification through a real MCPL host, while
 * another client observes without interfering — and two regressions: the
 * agent's ordinary speech is never typed into the shell (mcpl-1), and a
 * completion does not start an inference loop.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const AF = process.env.AGENT_FRAMEWORK ?? path.resolve(import.meta.dirname, '../../../archipelago-design/agent-framework');
const DIST = path.resolve(import.meta.dirname, '../dist');
if (!fs.existsSync(path.join(AF, 'dist/src/index.js'))) {
  // In CI the host is checked out and built on purpose (ACCEPTANCE_REQUIRED=1): a missing one is a failure, not a skip.
  console.log(`${process.env.ACCEPTANCE_REQUIRED === '1' ? 'FAIL' : 'skip'}: agent-framework dist not found at ${AF} (set AGENT_FRAMEWORK)`);
  process.exit(process.env.ACCEPTANCE_REQUIRED === '1' ? 1 : 0);
}
const { AgentFramework } = await import(path.join(AF, 'dist/src/index.js'));
const { MockMembrane, createMockResponse } = await import(path.join(AF, 'dist/test/helpers/mock-membrane.js'));
const { App } = await import(path.join(DIST, 'src/api/app.js'));
const { TokenMapResolver } = await import(path.join(DIST, 'src/api/principals.js'));
const { SessionRegistry } = await import(path.join(DIST, 'src/api/registry.js'));
const { NodePtyBackend } = await import(path.join(DIST, 'src/backends/node-pty.js'));
const { TermServer } = await import(path.join(DIST, 'src/transport/server.js'));
const { TestHost, sleep } = await import(path.join(DIST, 'spec/testhost.js'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-accept-af-'));
const registry = new SessionRegistry({ dataDir: path.join(tmp, 'data'), backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
const app = new App({ registry, segmenter: { runSettleMs: 50 } });
const server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { ta: 'agent:scout@test', tb: 'agent:observer@test' } }), host: '127.0.0.1', port: 0, version: 'acceptance' });
const { port } = await server.listen();
log('termd on', port);

const membrane = new MockMembrane();
const framework = await AgentFramework.create({
  storePath: path.join(tmp, 'af.chronicle'),
  membrane: membrane.asMembrane(),
  agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'test' }],
  modules: [],
  mcplServers: [{ id: 'terminal', transport: 'websocket', url: `ws://127.0.0.1:${port}/?resultText=transcript`, token: 'ta', toolPrefix: 'terminal', reconnect: true, reconnectIntervalMs: 300 }],
});
const traces = [];
framework.onTrace((ev) => {
  if (String(ev.type).startsWith('mcpl:')) traces.push(ev);
});
framework.start();
const conn = framework.mcplServerRegistry.getServer('terminal');
const call = async (name, args) => {
  const r = await conn.sendToolsCall(name, args);
  return { text: r.content.map((c) => c.text).join('\n'), structured: r.structuredContent, isError: r.isError };
};
const context = () =>
  framework.agents
    .get('scout')
    .getContextManager()
    .getAllMessages()
    .map((m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' '))
    .join('\n');
const SESSION = `acc${process.pid}`;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    log('PASS', name);
  } catch (e) {
    failures++;
    log('FAIL', name, '\n  ', e.message);
  }
};

try {
  await check('grant and tools', async () => {
    assert.ok(conn.policyEstablished, 'policy established');
    const tools = framework.getAllTools().map((t) => t.name).filter((n) => n.startsWith('terminal'));
    assert.ok(tools.some((n) => n.endsWith('run')) && tools.some((n) => n.endsWith('input')), tools.join(','));
  });

  const opened = await call('session_open', { session: SESSION, visibility: 'shared' });
  assert.equal(opened.isError, undefined, opened.text);
  const observer = await new TestHost({ port, token: 'tb', connection: 'observer', mcpl: true }).connect();
  await observer.request('channels/open', { channelId: `terminal:${SESSION}` });

  // The model will answer the wake with ordinary prose, as agents do.
  const marker = path.join(tmp, 'SHOULD_NOT_EXIST');
  membrane.pushResponse(createMockResponse([{ type: 'text', text: `The build finished. A sensible follow-up would be:\ntouch ${marker}` }]));

  let runId;
  await check('start work, receive a run id, stop waiting', async () => {
    const r = await call('run', { session: SESSION, command: 'sleep 2; echo acceptance-output', wait: 100 });
    assert.equal(r.structured?.state, 'running', r.text);
    runId = r.structured.runId;
    assert.ok(runId);
  });

  await check('disconnect and reconnect while it runs', async () => {
    await conn.reconnectAfterFailure();
    const until = Date.now() + 5000;
    while (!(conn.isConnected && conn.policyEstablished) && Date.now() < until) await sleep(50);
    assert.ok(conn.isConnected && conn.policyEstablished, 'reconnected with a policy');
  });

  await check('a useful completion notification through the host', async () => {
    const until = Date.now() + 8000;
    while (!context().includes('acceptance-output') && Date.now() < until) await sleep(100);
    const ctx = context();
    assert.match(ctx, new RegExp(`${SESSION}: \`sleep 2; echo acceptance-output\` → exit 0`), `agent context:\n${ctx.slice(-800)}`);
    assert.match(ctx, /acceptance-output/);
    const pushes = traces.filter((t) => t.type === 'mcpl:push_event' || t.type === 'mcpl:channels-incoming');
    assert.ok(pushes.length >= 1, 'delivered through the host lane');
  });

  await check('recover retained output and the correct outcome by id', async () => {
    const w = await call('await', { runId });
    assert.equal(w.structured?.state, 'exited');
    assert.equal(w.structured?.exit, 0);
    const rd = await call('read', { session: SESSION, runId });
    assert.match(rd.text, /acceptance-output/);
  });

  await check('another client observed without interfering', async () => {
    const d = await observer.delivery((x) => x.metadata.runId === runId, 3000);
    assert.ok(d.tags.includes('terminal:origin=agent'));
    const s = registry.get(SESSION);
    assert.notEqual(s.session.currentController, 'agent:observer@test');
  });

  await check("the agent's speech is never typed into the shell (mcpl-1), and no inference loop", async () => {
    await sleep(2500);
    const s = registry.get(SESSION);
    const events = s.session.journal.since(0).events;
    assert.ok(!events.some((e) => e.type === 'input'), 'no input events');
    assert.ok(!fs.existsSync(marker), 'the prose did not execute');
    const notes = events.filter((e) => e.type === 'note');
    log('   notes recorded from speech:', notes.length, 'inference calls:', membrane.calls.length);
    assert.ok(membrane.calls.length <= 2, `inference calls: ${membrane.calls.length}`);
  });

  await observer.close();
} finally {
  await call('session_close', { session: SESSION, force: true }).catch(() => undefined);
  await framework.stop();
  await server.close();
  await registry.closeAll();
  fs.rmSync(tmp, { recursive: true, force: true });
}
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
