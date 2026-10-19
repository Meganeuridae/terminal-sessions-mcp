/**
 * The MCPL lane end to end, over the real endpoint against real bash: the
 * milestone-1 acceptance sentence, catch-up after reconnect (G22), completion
 * suppression (G28), explicit interest, relative origin tags, notes instead of
 * typing, feature-set gating, fail-closed policy, channel history, presence.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { TermServer } from '../src/transport/server.js';
import { TestHost, sleep, until, type Delivery } from './testhost.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-mcpl-'));
let registry: SessionRegistry;
let server: TermServer;
let port = 0;

const A = 'agent:a@test';
const host = (token: string, connection: string, extra: Partial<ConstructorParameters<typeof TestHost>[0]> = {}) => new TestHost({ port, token, connection, mcpl: true, ...extra }).connect();
const aboutRun = (runId: unknown) => (d: Delivery) => d.metadata.runId === runId && d.tags.some((t) => t === 'terminal:run-finished' || t === 'terminal:run-lost');

before(async () => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 5000, segmenter: { runSettleMs: 30, cadenceMs: 400, needsInputMs: 700 } });
  server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { ta: A, tb: 'agent:b@test', th: 'human:test:9' } }), host: '127.0.0.1', port: 0, version: 'mcpl-spec' });
  port = (await server.listen()).port;
});

after(async () => {
  await server.close();
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the milestone-1 sentence: start, get a run id, stop waiting, disconnect, reconnect, recover output and outcome, get one notification — while another client observes without interfering', async () => {
  const a = await host('ta', 'accept-a');
  await a.call('session_open', { session: 'acc', visibility: 'shared' });
  const b = await host('tb', 'accept-b');
  await b.request('channels/open', { channelId: 'terminal:acc' });

  // Start work and receive a run id; stop waiting.
  const r = await a.call('run', { session: 'acc', command: 'sleep 1.2; echo accepted-output', wait: 50 });
  assert.ok(['starting', 'running'].includes(r.structured?.state as string), String(r.structured?.state));
  const runId = r.structured?.runId;
  assert.ok(typeof runId === 'string');

  // Disconnect while it runs.
  await a.close();

  // The observer sees the completion and never took the seat.
  const seen = await b.delivery(aboutRun(runId), 6000);
  assert.match(seen.text, /accepted-output/);
  assert.ok(seen.tags.includes('terminal:origin=agent') && seen.tags.includes('chat:from-agent'), `observer's tags are relative: ${seen.tags}`);
  const s = registry.get('acc');
  assert.ok(s?.kind === 'live');
  assert.notEqual(s.session.currentController, 'agent:b@test', 'the observer does not hold the seat');

  // Reconnect: exactly one completion notification for the run, with its outcome and tail.
  const a2 = await host('ta', 'accept-a2');
  const note = await a2.delivery(aboutRun(runId), 4000);
  assert.equal(note.via, 'push', 'closed channel → push event by explicit interest');
  assert.ok(note.tags.includes('terminal:exit=ok') && note.tags.includes('terminal:origin=self') && note.tags.includes('chat:from-self'), `${note.tags}`);
  assert.match(note.text, /^\[terminal\] acc: `sleep 1\.2; echo accepted-output` → exit 0 in \S+ · run r\S+ · read since=\d+\naccepted-output$/);
  await sleep(300);
  assert.equal(a2.deliveries().filter(aboutRun(runId)).length, 1, 'one notification, not several');

  // Recover the retained output and the correct outcome by id.
  const w = await a2.call('await', { runId });
  assert.equal(w.structured?.state, 'exited');
  assert.equal(w.structured?.exit, 0);
  assert.match(w.text, /accepted-output/);
  const rd = await a2.call('read', { session: 'acc', runId });
  assert.match(rd.text, /accepted-output/);

  // A second reconnect does not redeliver: the delivered cursor advanced on acceptance.
  await a2.close();
  const a3 = await host('ta', 'accept-a3');
  await a3.noDelivery(aboutRun(runId), 700, 'after a second reconnect');
  await a3.close();
  await b.close();
});

test('G28: a run whose outcome its call returned is not delivered to its caller again, whatever the size of its output', async () => {
  const a = await host('ta', 'g28-a');
  await a.call('session_open', { session: 'g28' });
  await a.request('channels/open', { channelId: 'terminal:g28' });
  const r = await a.call('run', { session: 'g28', command: 'seq 1 30000 | tail -n 3', wait: 20000 });
  assert.equal(r.structured?.state, 'exited');
  const big = await a.call('run', { session: 'g28', command: 'seq 1 40000', wait: 30000 });
  assert.equal(big.structured?.state, 'exited');
  // Only the completion is withheld (G28): a progress digest of a Run that outlasts the cadence on a
  // loaded machine is delivered to an open channel as designed (the house's read).
  const completion = (d: Delivery) => d.tags.includes('terminal:run-finished') || d.tags.includes('terminal:run-lost');
  await a.noDelivery((d) => completion(d) && (d.metadata.runId === r.structured?.runId || d.metadata.runId === big.structured?.runId), 1200, 'for runs whose outcome the call returned');
  await a.close();
});

test('explicit interest: an observer with a closed channel hears nothing about another principal’s runs or the session’s exit', async () => {
  const a = await host('ta', 'int-a');
  await a.call('session_open', { session: 'int', visibility: 'shared' });
  const b = await host('tb', 'int-b');
  const r = await a.call('run', { session: 'int', command: 'sleep 0.3; echo x', wait: 50 });
  assert.ok(['starting', 'running'].includes(r.structured?.state as string), String(r.structured?.state));
  await a.delivery(aboutRun(r.structured?.runId), 4000);
  await a.call('session_close', { session: 'int' });
  await a.delivery((d) => d.tags.includes('terminal:session-exited'), 4000);
  await b.noDelivery(() => true, 500, 'to an uninterested observer');
  await a.close();
  await b.close();
});

test('publish records a note for observers and never types into the shell', async () => {
  const a = await host('ta', 'note-a');
  await a.call('session_open', { session: 'note', visibility: 'shared' });
  await a.request('channels/open', { channelId: 'terminal:note' });
  const res = (await a.request('channels/publish', { channelId: 'terminal:note', content: [{ type: 'text', text: 'Build finished.\ntouch /tmp/tsm-should-not-exist' }] })) as { delivered: boolean; messageId: string; reason?: string };
  // Delivered means recorded in the journal, whoever is watching now.
  assert.equal(res.delivered, true);
  assert.match(res.messageId, /:note:\d+$/);
  await sleep(400);
  const s = registry.get('note');
  assert.ok(s?.kind === 'live');
  const events = s.session.journal.since(0).events;
  assert.ok(events.some((e) => e.type === 'note' && e.text.includes('Build finished.') && e.principal === A), 'the note is journaled with provenance');
  assert.ok(!events.some((e) => e.type === 'input'), 'nothing was typed');
  assert.ok(!events.some((e) => e.type === 'run.admit'), 'nothing ran');
  assert.ok(!fs.existsSync('/tmp/tsm-should-not-exist'));
  await a.delivery(() => false, 1).catch(() => undefined);
  await a.noDelivery((d) => d.channelId === 'terminal:note', 300, 'from a note (no feedback loop)');
  await a.close();
});

test('reconnect keeps the owner seated even when the host reopens its channel first (§9, mcpl-3)', async () => {
  const a = await host('ta', 'seat-a');
  const o = await a.call('session_open', { session: 'seat' });
  assert.equal(o.structured?.role, 'controller');
  await a.close();
  const a2 = await host('ta', 'seat-a2');
  await a2.request('channels/open', { channelId: 'terminal:seat' });
  const r = await a2.call('run', { session: 'seat', command: 'echo seated' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.structured?.state, 'exited');
  const i = await a2.call('input', { session: 'seat', text: '' , keys: ['C-u'] });
  assert.equal(i.isError, undefined, i.text);
  await a2.close();
});

test('channels/register goes out after the policy receipt, and is retried while the host still refuses it (mcpl-2)', async () => {
  const a = await host('ta', 'reg-a');
  await a.call('session_open', { session: 'reg' });
  await a.close();
  let refusals = 0;
  const order: string[] = [];
  const h = new TestHost({
    port,
    token: 'ta',
    connection: 'reg-a2',
    mcpl: true,
    answer: (m) => {
      if (m.method === 'channels/register' && refusals < 2) {
        refusals++;
        order.push('register-refused');
        h.respondError(m, -32002, 'initial policy not yet established (§5.3)');
        return null;
      }
      if (m.method === 'channels/register') order.push('register');
      return undefined;
    },
  });
  await h.connect();
  order.push('receipt-received');
  await until(() => order.includes('register'), 4000, 'a successful register');
  assert.equal(refusals, 2);
  await h.close();
});

test('feature sets: the shipped selection lists the ten core tools; a tools-only grant keeps session tools; a malformed policy fails closed', async () => {
  const core = await host('ta', 'fs-core', { enabled: ['terminal.core', 'terminal.live', 'terminal.presence'] });
  const tools = (await core.request('tools/list')) as { tools: Array<{ name: string }> };
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['await', 'cancel', 'input', 'read', 'run', 'screen', 'session_close', 'session_declare_shell', 'session_list', 'session_open']);
  await core.close();

  const toolsOnly = await host('ta', 'fs-tools', { grant: ['tools'] });
  const t2 = (await toolsOnly.request('tools/list')) as { tools: Array<{ name: string }> };
  assert.ok(t2.tools.some((t) => t.name === 'session_open') && t2.tools.some((t) => t.name === 'input'), 'core is available with only `tools`');
  await toolsOnly.close();

  const bad = await host('ta', 'fs-bad');
  await assert.rejects(bad.request('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: ['pushEvents'] }), (e: { code: number }) => e.code === -32602);
  const t3 = (await bad.request('tools/list')) as { tools: Array<{ name: string }> };
  assert.ok(t3.tools.length <= 10, 'nothing beyond the pre-policy core after a malformed update');
  await bad.close();
});

test('channels/open returns history only when asked, bounded by the limit, stamped with event times', async () => {
  const a = await host('ta', 'hist-a');
  await a.call('session_open', { session: 'hist' });
  for (const n of [1, 2, 3]) await a.call('run', { session: 'hist', command: `echo h${n}` });
  const none = (await a.request('channels/open', { channelId: 'terminal:hist' })) as { history?: unknown[] };
  assert.equal(none.history, undefined);
  await a.request('channels/close', { channelId: 'terminal:hist' });
  const two = (await a.request('channels/open', { channelId: 'terminal:hist', history: { limit: 2 } })) as { history: Array<{ content: Array<{ text: string }>; timestamp: string }>; historyTruncated?: boolean };
  assert.equal(two.history.length, 2);
  assert.match(two.history[1]!.content[0]!.text, /echo h3/);
  assert.equal(two.historyTruncated, true);
  assert.ok(Date.parse(two.history[0]!.timestamp) <= Date.parse(two.history[1]!.timestamp));
  // A fractional limit is a whole one (the house's read of 2f357bd): never a way past the cap.
  await a.request('channels/close', { channelId: 'terminal:hist' });
  const frac = (await a.request('channels/open', { channelId: 'terminal:hist', history: { limit: 2.5 } })) as { history: unknown[]; historyTruncated?: boolean };
  assert.equal(frac.history.length, 2);
  assert.equal(frac.historyTruncated, true);
  await a.request('channels/close', { channelId: 'terminal:hist' });
  await assert.rejects(a.request('channels/open', { channelId: 'terminal:hist', history: { limit: 'all' } }), (e: { code: number }) => e.code === -32602);
  await assert.rejects(a.request('channels/open', { channelId: 'terminal:hist', history: { limit: null } }), (e: { code: number }) => e.code === -32602);
  await assert.rejects(a.request('channels/open', { channelId: 'terminal:hist', history: { limit: 5, beforeMessageId: 'not-one-of-ours' } }), (e: { code: number }) => e.code === -32602);
  // A refused open did not open the channel: the next completion reaches this host by its interest,
  // as a push, not as a channel message (the house's read of cc8c909..39787b3, #22).
  const bg = await a.call('run', { session: 'hist', command: 'sleep 0.3; echo after-refusal', wait: 20 });
  const d = await a.delivery(aboutRun(bg.structured?.runId), 6000);
  assert.equal(d.via, 'push');
  await a.close();
});

test('presence: context/beforeInference says what changed since your last read', async () => {
  const a = await host('ta', 'pres-a');
  await a.call('session_open', { session: 'pres' });
  await a.call('run', { session: 'pres', command: 'echo seen' });
  const quiet = (await a.request('context/beforeInference', { inferenceId: 'i1', conversationId: 'c', turnIndex: 0, userMessage: null })) as { contextInjections: Array<{ position: string; content: Array<{ text: string }> }> };
  assert.equal(quiet.contextInjections[0]?.position, 'beforeUser');
  assert.match(quiet.contextInjections[0]!.content[0]!.text, /idle, nothing new: .*pres/);
  const r = await a.call('run', { session: 'pres', command: 'sleep 0.2; echo unseen-output', wait: 20 });
  await sleep(700);
  const news = (await a.request('context/beforeInference', { inferenceId: 'i2', conversationId: 'c', turnIndex: 1, userMessage: null })) as { contextInjections: Array<{ content: Array<{ text: string }> }> };
  const text = news.contextInjections[0]!.content[0]!.text;
  assert.match(text, /\[terminal\] pres: .*new since your last read/);
  assert.match(text, /sleep 0\.2; echo unseen-output` → 0/);
  void r;
  await a.close();
});

test('digests while a command runs carry supersedes; needs-input fires for a prompt that waits (G15)', async () => {
  const a = await host('ta', 'dig-a');
  await a.call('session_open', { session: 'dig' });
  await a.request('channels/open', { channelId: 'terminal:dig' });
  const r = await a.call('run', { session: 'dig', command: 'for i in 1 2 3 4 5 6; do echo tick $i; sleep 0.25; done', wait: 50 });
  await a.delivery(aboutRun(r.structured?.runId), 6000);
  const digests = a.deliveries().filter((d) => d.tags.includes('terminal:output'));
  assert.ok(digests.length >= 2, `digests: ${digests.length}`);
  assert.equal(digests[1]!.metadata.supersedes, digests[0]!.messageId);
  const q = await a.call('run', { session: 'dig', command: "read -p 'Continue? [y/N] ' ans; echo got-$ans", wait: 50 });
  const ask = await a.delivery((d) => d.tags.includes('terminal:needs-input'), 5000);
  assert.match(ask.text, /Continue\? \[y\/N\]/);
  await a.call('input', { session: 'dig', text: 'y', keys: ['Enter'] });
  const done = await a.delivery(aboutRun(q.structured?.runId), 5000);
  assert.match(done.text, /got-y/);
  await a.close();
});

test('§9: a connection that closes on purpose gives up the seat at once; a dropped one keeps it through the grace', async () => {
  const a = await host('ta', 'seat-clean-a', { mcpl: false });
  await a.call('session_open', { session: 'seatc', visibility: 'shared' });
  await a.close(); // clean (1000): a finished CLI call
  const b = await host('tb', 'seat-clean-b', { mcpl: false, profile: 'full' });
  const took = await b.call('control', { session: 'seatc', action: 'take' });
  assert.equal(took.isError, undefined, took.text);
  assert.equal(took.structured?.controller, 'agent:b@test');
  await b.call('control', { session: 'seatc', action: 'release' });
  await b.close();

  const a2 = await host('ta', 'seat-drop-a', { mcpl: false });
  const o = await a2.call('session_open', { session: 'seatc' });
  assert.equal(o.structured?.role, 'controller');
  a2.ws.terminate(); // dropped: no close handshake
  await sleep(200);
  const c = await host('tb', 'seat-drop-b', { mcpl: false, profile: 'full' });
  const refused = await c.call('control', { session: 'seatc', action: 'take' });
  assert.equal(refused.isError, true, 'the seat is held for the dropped owner');
  await c.close();
  const a3 = await host('ta', 'seat-drop-a3', { mcpl: false });
  const back = await a3.call('session_open', { session: 'seatc' });
  assert.equal(back.structured?.role, 'controller', 'the owner gets it back on reconnect');
  await a3.close();
});
