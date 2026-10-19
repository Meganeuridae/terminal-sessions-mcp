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
// A check that hangs (a host that never reconnects, a shell that never ends) ends here with a verdict,
// not at the CI job's limit half an hour later with no summary (the house's read of 9f168ff, #22).
const DEADLINE_MS = 120_000;
const deadline = setTimeout(() => {
  log(`FAIL: the check did not finish within ${DEADLINE_MS / 1000} s`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}, DEADLINE_MS);
const registry = new SessionRegistry({ dataDir: path.join(tmp, 'data'), backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
const app = new App({ registry, segmenter: { runSettleMs: 50 } });
const serverLog = [];
const server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { ta: 'agent:scout@test', tb: 'agent:observer@test' } }), host: '127.0.0.1', port: 0, version: 'acceptance', log: (line) => serverLog.push(line) });
const { port } = await server.listen();
log('termd on', port);
/** How many connections termd has accepted from the scout's host so far. */
const scoutConnections = () => serverLog.filter((l) => l.includes('"connection opened"') && l.includes('"agent:scout@test"')).length;

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
const CHANNEL = `terminal:${SESSION}`;
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
/** `p`, or a failure naming `what` after `ms`; the timer never outlives the race. */
const within = (p, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
const journal = () => registry.get(SESSION).session.journal.since(0).events;

try {
  await check('grant and tools', async () => {
    assert.ok(conn.policyEstablished, 'policy established');
    const tools = framework.getAllTools().map((t) => t.name).filter((n) => n.startsWith('terminal'));
    assert.ok(tools.some((n) => n.endsWith('run')) && tools.some((n) => n.endsWith('input')), tools.join(','));
  });

  const opened = await call('session_open', { session: SESSION, visibility: 'shared' });
  assert.equal(opened.isError, undefined, opened.text);
  const observer = await new TestHost({ port, token: 'tb', connection: 'observer', mcpl: true }).connect();
  await observer.request('channels/open', { channelId: CHANNEL });

  // The host routes an agent's plain reply to the channel that woke it. So the scout's host opens the
  // session's channel, as the agent's own channel_open tool does: the completion then arrives on that
  // channel, and the prose the model answers with reaches termd's channels/publish. On a closed channel
  // a completion is a push event with no channel to answer into; the host kept the prose in its archive,
  // nothing reached termd, and the mcpl-1 check below passed with publish typing into the shell (the
  // house's read of 9f168ff, #22). The channel registers with the host a moment after session_open.
  await check("the scout's host opens the session's channel", async () => {
    let open;
    for (const until = Date.now() + 3000; ; await sleep(100)) {
      open = await framework.executeToolCall({ id: 'open-1', name: 'channel_open', input: { channelId: CHANNEL, serverId: 'terminal' }, callerAgentName: 'scout' });
      if (!open.isError || Date.now() > until) break;
    }
    assert.ok(!open.isError, `channel_open: ${open.error}`);
  });

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
    // The drop and the new link are both shown: the host's link closes and reconnects, termd accepts one
    // more connection from the scout, and the Run is still in flight (the house's read of 9f168ff, #22).
    const before = scoutConnections();
    const closed = new Promise((r) => conn.once('close', (...a) => r(a)));
    const reconnected = new Promise((r) => conn.once('reconnect', r));
    await conn.reconnectAfterFailure();
    await within(closed, 3000, 'the link closing');
    await within(reconnected, 5000, 'the link coming back');
    const until = Date.now() + 5000;
    while (!(conn.isConnected && conn.policyEstablished) && Date.now() < until) await sleep(50);
    assert.ok(conn.isConnected && conn.policyEstablished, 'reconnected with a policy');
    assert.equal(scoutConnections(), before + 1, `termd accepted a new connection from the scout:\n${serverLog.slice(-10).join('\n')}`);
    assert.equal(registry.get(SESSION).session.run(runId).state, 'running', 'the Run was in flight across the drop');
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

  await check("the agent's speech reached the session as a note, never typed into the shell (mcpl-1), and no inference loop", async () => {
    // Waits for the reply itself, not a fixed time: a sleep passed while the reply never reached termd.
    const scoutNotes = (events) => events.filter((e) => e.type === 'note' && e.principal === 'agent:scout@test');
    const until = Date.now() + 8000;
    while (!scoutNotes(journal()).length && !journal().some((e) => e.type === 'input') && Date.now() < until) await sleep(100);
    const events = journal();
    assert.ok(!events.some((e) => e.type === 'input'), 'no input events');
    assert.ok(!fs.existsSync(marker), 'the prose did not execute');
    const notes = scoutNotes(events);
    const routing = traces.filter((t) => t.type === 'mcpl:speech-routed' || t.type === 'mcpl:speech-route-failed').map((t) => `${t.type}${t.reason ? ` (${t.reason})` : ''}`);
    assert.equal(notes.length, 1, `notes from the scout's reply: ${notes.length}; the host's routing: ${routing.join('; ') || 'nothing routed'}`);
    assert.match(notes[0].text, /A sensible follow-up/);
    // A note is not delivered back to its author; a further wake would follow it within this settle.
    await sleep(1000);
    log('   inference calls:', membrane.calls.length);
    assert.ok(membrane.calls.length <= 2, `inference calls: ${membrane.calls.length}`);
  });

  await observer.close();
} finally {
  await call('session_close', { session: SESSION, force: true }).catch(() => undefined);
  await framework.stop();
  await server.close();
  await registry.closeAll();
  fs.rmSync(tmp, { recursive: true, force: true });
  clearTimeout(deadline);
}
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
