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
// Every wait below whose expiry fails a check runs on the monotonic clock, so a step of the wall clock
// neither ends one early nor stretches it (the house's read of the 33 commits, #22, comment 6307351372).
const now = () => performance.now();
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
/** The Run's completion messages in the scout's context, however each came. */
const completionMessages = (runId) =>
  framework.agents
    .get('scout')
    .getContextManager()
    .getAllMessages()
    .filter((m) => m.metadata?.runId === runId && m.metadata?.tags?.includes('terminal:run-finished'));
/** When the check's poll first saw the Run's completion in the scout's context, at or after its first showing; the recount waits two seconds on from it. */
let firstCompletionAt;

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
    for (const until = now() + 3000; ; await sleep(100)) {
      open = await framework.executeToolCall({ id: 'open-1', name: 'channel_open', input: { channelId: CHANNEL, serverId: 'terminal' }, callerAgentName: 'scout' });
      if (!open.isError || now() > until) break;
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
  // #22 comment 6269721389). The command stays short: the completion head shows 100 characters. Its
  // text doesn't hold the word it prints, which the head repeats with the command: looked for in the
  // whole completion, `acceptance-output` matched the head of one with no output at all (the house's
  // read of f3750e4..4f4c067 over our fixes, #22).
  const released = path.join(tmp, 'reconnected');
  const COMMAND = 'until [ -e reconnected ]; do sleep 0.1; done; echo acceptance-out""put';
  let runId;
  const sighted = () => {
    if (firstCompletionAt === undefined && completionMessages(runId).length) firstCompletionAt = now();
    return firstCompletionAt !== undefined;
  };
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
    const until = now() + 5000;
    while (!(conn.isConnected && conn.policyEstablished) && now() < until) await sleep(50);
    assert.ok(conn.isConnected && conn.policyEstablished, 'reconnected with a policy');
    assert.equal(scoutConnections(), before + 1, `termd accepted a new connection from the scout:\n${serverLog.slice(-10).join('\n')}`);
    assert.equal(registry.get(SESSION).session.run(runId).state, 'running', 'the Run was in flight across the drop');
  });
  // Shown or failed, the Run is released now, so the checks after this one see it end. A completion
  // that falls inside the disconnect is not staged here: mcpl-lane.spec stages it in mcpl-8 (the
  // connection drops while a completion settles, and the new one gets it once) and in the
  // channels-only host's reconnect (a completion nothing could carry while the host was away,
  // delivered when the new connection opens the channel).
  fs.writeFileSync(released, '');

  await check('a useful completion notification through the host, and the inference call it woke', async () => {
    // The poll looks for the completion as well as the output text, so the recount below counts from the poll's first
    // sight of it: sampled once after the loop, a completion that showed after the text left the recount no window and
    // its log saying none had shown (the house's review of bc4bc85..5d8ce0e, PR #22).
    const until = now() + 8000;
    while (!(sighted() && context().includes('acceptance-output')) && now() < until) await sleep(100);
    sighted();
    const ctx = context();
    assert.ok(ctx.includes(`${SESSION}: \`${COMMAND}\` → exit 0`), `agent context:\n${ctx.slice(-800)}`);
    assert.match(ctx, /acceptance-output/);
    // On the session's channel, as the open above intends, not as a push event with no channel to answer
    // into. Any push or batch counted before, so this passed with the channel closed; and the host's traces
    // carry no Run, so a batch naming the channel passed beside a completion pushed. The completion's own
    // message says how it came: one from the channel carries its message id, a push its event id and
    // feature set (the house's read of the 40 commits over our fixes, #22).
    const mine = completionMessages(runId);
    const route = mine.map((m) => JSON.stringify({ channelId: m.metadata.channelId, messageId: m.metadata.messageId, eventId: m.metadata.eventId, featureSet: m.metadata.featureSet })).join('; ') || 'no message for the Run';
    assert.equal(mine.length, 1, `the completion's messages in the agent context: ${route}`);
    assert.ok(mine[0].metadata.channelId === CHANNEL && mine[0].metadata.messageId !== undefined && mine[0].metadata.eventId === undefined, `delivered on the session's channel, not pushed: ${route}`);
    // The wake itself, seen from the model's side and apart from any note: an inference call carrying the
    // completion, with a bound of its own, so a delivery that took most of its wait leaves this one its time.
    for (const inferenceUntil = now() + 8000; !membrane.calls.length && now() < inferenceUntil; ) await sleep(50);
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
    const until = now() + 8000;
    while (!byTool(scoutNotes(journal())).length && !journal().some((e) => e.type === 'input') && now() < until) await sleep(100);
    // The prose path is the rest of the turn after the tool call (the mock's yielding stream plays the
    // prose in the same inference call; a host that infers again after the tool result makes a second)
    // and then the host's routing of the prose, which the turn awaits before the agent is idle. A fixed
    // second here let a publish that landed later pass unseen (the house's read, #22 comment
    // 6269721389): the check waits for the host's idle, then for termd's own evidence that the note
    // passed through the scout's lane: a principal's own note is never sent back to it (mcpl-14), so
    // the lane settles it and the scout's delivered cursor moves past the note's seq. The observer's
    // copy would show nothing of that lane (the house's read, #22 comment 6274806357). The wait ends
    // when the cursor has passed the note, or at its bound, and the assertions after it say which
    // case a run that ran out of time is: no note (the count, with the host's channel_publish calls
    // and routing in its message), or a note the scout's lane had not settled (the cursor). The
    // count alone passed the second case (the house's read of the 33 commits, #22, comment
    // 6307351372). The idle waits are generous: each ends as soon as the host is idle, and only a
    // host that never goes idle meets the bound.
    await within(framework.runUntilIdle(), 30_000, 'the host going idle after the turn');
    const scoutDelivered = () => registry.get(SESSION).session.cursorsOf('agent:scout@test').delivered;
    const noteSeq = () => byTool(scoutNotes(journal()))[0]?.seq;
    for (const settle = now() + 10_000; (noteSeq() === undefined || scoutDelivered() < noteSeq()) && now() < settle; ) await sleep(50);
    log(`   the scout's delivered cursor: ${scoutDelivered()}; the note's seq: ${noteSeq() ?? 'no note'}`);
    await within(framework.runUntilIdle(), 30_000, 'the host idle again after the note passed its lane');
    const events = journal();
    assert.ok(!events.some((e) => e.type === 'input'), 'no input events');
    assert.ok(!fs.existsSync(marker), 'neither text executed');
    const notes = scoutNotes(events);
    const calls = traces.filter((t) => (t.type === 'tool:completed' || t.type === 'tool:failed') && t.tool === 'channel_publish').map((t) => `${t.type}${t.error ? ` (${t.error})` : ''}`);
    const routing = traces.filter((t) => t.type === 'mcpl:speech-routed' || t.type === 'mcpl:speech-route-failed').map((t) => `${t.type}${t.reason ? ` (${t.reason})` : ''}`);
    assert.equal(byTool(notes).length, 1, `notes from the scout's channel_publish call: ${byTool(notes).length}; the host's channel_publish calls: ${calls.join('; ') || 'none'}; its routing: ${routing.join('; ') || 'nothing routed'}`);
    const settled = scoutDelivered();
    assert.ok(settled >= byTool(notes)[0].seq, `the scout's lane settled the note: its delivered cursor ${settled}, the note's seq ${byTool(notes)[0].seq}`);
    const fromProse = notes.filter((n) => n.text === PROSE);
    assert.equal(notes.length, 1 + fromProse.length, `unexpected notes from the scout: ${JSON.stringify(notes.map((n) => n.text))}`);
    log(`   the note came by the channel_publish tool call; the plain reply ${fromProse.length ? 'was also routed into the channel by the host (tolerated)' : 'stayed with the host, not routed'}; routing traces: ${routing.join('; ') || 'none'}`);
    log('   inference calls:', membrane.calls.length);
    assert.ok(membrane.calls.length <= 2, `inference calls: ${membrane.calls.length}`);
    // Counted again once the scout's lane has passed the note, which it reached in journal order after the
    // completion (the wait above), and two seconds on from when the check's poll first saw the completion, so
    // at least two seconds from its first showing: the bridge's check counts its own after a fence and two
    // seconds too. Counted only as it first showed, a second copy landing later went uncounted (the house's
    // read of f3750e4..4f4c067 over our fixes, #22); and the host's idle waits end at once with nothing in
    // flight, so a copy the lane sent on a timer could land after them (the house's read of a8b6f28..4860d4c,
    // #22). The two seconds cover a copy sent on a timer within them, as a retry from 500 ms would be; a copy
    // sent later than that isn't seen here. The poll's time, not the first showing, is what is measured (the
    // house's read of 4860d4c..bc4bc85, #22).
    sighted();
    const sinceFirst = firstCompletionAt === undefined ? undefined : now() - firstCompletionAt;
    if (firstCompletionAt !== undefined) await sleep(Math.max(0, firstCompletionAt + 2000 - now()));
    log(`   the recount: ${sinceFirst === undefined ? 'no completion showed within the poll' : `the check reached it ${Math.round(sinceFirst)} ms after its poll first saw the completion${sinceFirst < 2000 ? ', and waited to two seconds' : ''}`}`);
    assert.equal(completionMessages(runId).length, 1, "the Run's completion messages two seconds after the check first saw one");
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
