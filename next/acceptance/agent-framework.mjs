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
framework.onTrace((ev) => traces.push(ev));
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

  const opened = await call('session_open', { session: SESSION, visibility: 'shared', cwd: tmp });
  assert.equal(opened.isError, undefined, opened.text);
  const observer = await new TestHost({ port, token: 'tb', connection: 'observer', mcpl: true }).connect();
  await observer.request('channels/open', { channelId: CHANNEL });

  // The host routes an agent's plain reply to the channel that woke it. So the scout's host opens the
  // session's channel, as the agent's own channel_open tool does: the completion then arrives on that
  // channel, and the prose the model answers with reaches termd's channels/publish. On a closed channel
  // a completion is a push event with no channel to answer into; the host kept the prose in its archive,
  // nothing reached termd, and the mcpl-1 check below passed vacuously, with no publish for it to catch
  // (the house's read of 9f168ff and comment 6269721389, #22). The channel registers with the host a
  // moment after session_open.
  await check("the scout's host opens the session's channel", async () => {
    let open;
    for (const until = Date.now() + 3000; ; await sleep(100)) {
      open = await framework.executeToolCall({ id: 'open-1', name: 'channel_open', input: { channelId: CHANNEL, serverId: 'terminal' }, callerAgentName: 'scout' });
      if (!open.isError || Date.now() > until) break;
    }
    assert.ok(!open.isError, `channel_open: ${open.error}`);
  });

  // The model answers the wake the explicit way first, a channel_publish tool call that puts a note on
  // the session's channel, and then in ordinary prose, as agents do. The tool call is what the check
  // requires: a host that honours the channel's `speech: 'none'` (agent-framework #436) no longer routes
  // the prose into the channel, so a note from the prose is tolerated and reported, never required
  // (comment 6262776182, follow-up). Both texts look like a command: neither may reach the shell.
  const marker = path.join(tmp, 'SHOULD_NOT_EXIST');
  const TOOL_NOTE = `Noted by the scout's channel_publish call: the build finished; a follow-up would be: touch ${marker}`;
  const PROSE = `The build finished. A sensible follow-up would be:\ntouch ${marker}`;
  membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'note-1', name: 'channel_publish', input: { channelId: CHANNEL, content: TOOL_NOTE } }], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: PROSE }]));

  // The Run ends when this file appears in the session's cwd, and the check creates it once the
  // reconnect has been shown: a Run that slept 2 s raced the reconnect's own waits (3 s, then 5 s),
  // so a correct reconnect slower than that failed the check on a slow runner (the house's read,
  // #22 comment 6269721389). The command stays short: the completion head shows 100 characters.
  const released = path.join(tmp, 'reconnected');
  const COMMAND = 'until [ -e reconnected ]; do sleep 0.1; done; echo acceptance-output';
  let runId;
  await check('start work, receive a run id, stop waiting', async () => {
    const r = await call('run', { session: SESSION, command: COMMAND, wait: 100 });
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
  // Shown or failed, the Run is released now, so the checks after this one see it end.
  fs.writeFileSync(released, '');

  await check('a useful completion notification through the host, and the inference call it woke', async () => {
    const until = Date.now() + 8000;
    while (!context().includes('acceptance-output') && Date.now() < until) await sleep(100);
    const ctx = context();
    assert.ok(ctx.includes(`${SESSION}: \`${COMMAND}\` → exit 0`), `agent context:\n${ctx.slice(-800)}`);
    assert.match(ctx, /acceptance-output/);
    const pushes = traces.filter((t) => t.type === 'mcpl:push_event' || t.type === 'mcpl:channels-incoming');
    assert.ok(pushes.length >= 1, 'delivered through the host lane');
    // The wake itself, seen from the model's side and apart from any note: an inference call carrying the completion.
    while (!membrane.calls.length && Date.now() < until) await sleep(50);
    assert.ok(membrane.calls.length >= 1, 'an inference call followed the completion');
    assert.ok(JSON.stringify(membrane.calls[0].messages).includes('acceptance-output'), 'the inference call carries the completion');
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

  await check("the scout's channel_publish call became one note, nothing was typed into the shell (mcpl-1), and no inference loop", async () => {
    // Waits for the note itself, not a fixed time: a sleep passed while nothing reached termd.
    const scoutNotes = (events) => events.filter((e) => e.type === 'note' && e.principal === 'agent:scout@test');
    const byTool = (notes) => notes.filter((n) => n.text === TOOL_NOTE);
    const until = Date.now() + 8000;
    while (!byTool(scoutNotes(journal())).length && !journal().some((e) => e.type === 'input') && Date.now() < until) await sleep(100);
    // The prose path is the rest of the turn after the tool call (the mock's yielding stream plays the
    // prose in the same inference call; a host that infers again after the tool result makes a second)
    // and then the host's routing of the prose, which the turn awaits before the agent is idle. A fixed
    // second here let a publish that landed later pass unseen (the house's read, #22 comment
    // 6269721389): the check waits for the host's idle, then for termd to have handed the tool call's
    // note to the channel's open connections (the scout's host among them) and the host's idle again,
    // so a publish from the prose, or a wake from the note's echo, is counted below rather than missed.
    await within(framework.runUntilIdle(), 8000, 'the host going idle after the turn');
    await observer.delivery((x) => x.text.includes(TOOL_NOTE), 3000);
    await within(framework.runUntilIdle(), 8000, 'the host idle again after the note reached the channel');
    const events = journal();
    assert.ok(!events.some((e) => e.type === 'input'), 'no input events');
    assert.ok(!fs.existsSync(marker), 'neither text executed');
    const notes = scoutNotes(events);
    const calls = traces.filter((t) => (t.type === 'tool:completed' || t.type === 'tool:failed') && t.tool === 'channel_publish').map((t) => `${t.type}${t.error ? ` (${t.error})` : ''}`);
    const routing = traces.filter((t) => t.type === 'mcpl:speech-routed' || t.type === 'mcpl:speech-route-failed').map((t) => `${t.type}${t.reason ? ` (${t.reason})` : ''}`);
    assert.equal(byTool(notes).length, 1, `notes from the scout's channel_publish call: ${byTool(notes).length}; the host's channel_publish calls: ${calls.join('; ') || 'none'}; its routing: ${routing.join('; ') || 'nothing routed'}`);
    const fromProse = notes.filter((n) => n.text === PROSE);
    assert.equal(notes.length, 1 + fromProse.length, `unexpected notes from the scout: ${JSON.stringify(notes.map((n) => n.text))}`);
    log(`   the note came by the channel_publish tool call; the plain reply ${fromProse.length ? 'was also routed into the channel by the host (tolerated)' : 'stayed with the host, not routed'}; routing traces: ${routing.join('; ') || 'none'}`);
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
