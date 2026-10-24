/**
 * End to end over the real endpoint: an MCP host, the native family, and
 * recovery after a "daemon restart" — against real bash.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { TermServer } from '../src/transport/server.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-e2e-'));
let registry: SessionRegistry;
let server: TermServer;
let port = 0;

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** A minimal host: request/response, plus a queue of server-initiated messages. */
class Host {
  ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (m: Msg) => void>();
  readonly inbound: Msg[] = [];
  private waiters: Array<{ method: string; resolve: (m: Msg) => void }> = [];

  constructor(readonly token: string, readonly connection: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${this.token}&connection=${this.connection}&resultText=transcript`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      if (m.method) {
        const i = this.waiters.findIndex((w) => w.method === m.method);
        if (i !== -1) this.waiters.splice(i, 1)[0]!.resolve(m);
        else this.inbound.push(m);
      } else if (m.id !== undefined) this.pending.get(m.id)?.(m);
    });
    await new Promise<void>((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data })) : resolve(m.result)));
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Wait for a server-initiated message by method (already received or upcoming). */
  expect(method: string, ms = 4000): Promise<Msg> {
    const i = this.inbound.findIndex((m) => m.method === method);
    if (i !== -1) return Promise.resolve(this.inbound.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`no ${method} within ${ms} ms; inbound=${this.inbound.map((m) => m.method).join(',')}`));
      }, ms);
      this.waiters.push({ method, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, unknown>; isError?: boolean }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
    const out: { text: string; structured: Record<string, unknown>; isError?: boolean } = { text: r.content.map((c) => c.text).join('\n'), structured: r.structuredContent };
    if (r.isError) out.isError = true;
    return out;
  }

  close(): void {
    this.ws.close(1000);
  }
}

before(async () => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 5000 });
  server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { ta: 'agent:a@test', tb: 'agent:b@test', th: 'human:test:9' } }), host: '127.0.0.1', port: 0, version: 'e2e' });
  port = (await server.listen()).port;
});

after(async () => {
  await server.close();
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('MCP host: core tools, dual-rendered results, validation errors, health', async () => {
  const h = new Host('ta', 'mcp1');
  await h.connect();
  const tools = (await h.request('tools/list')) as { tools: Array<{ name: string; outputSchema?: unknown }> };
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ['await', 'cancel', 'input', 'read', 'run', 'screen', 'session_close', 'session_declare_shell', 'session_list', 'session_open'],
    'core profile lists ten single-purpose tools',
  );
  assert.ok(tools.tools.find((t) => t.name === 'run')!.outputSchema, 'run declares an output schema');
  const r = await h.call('run', { session: 'e2e', command: 'echo hi-from-e2e' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.structured.state, 'exited');
  assert.equal(r.structured.exit, 0);
  assert.equal(r.structured.created, true);
  assert.match(r.text, /hi-from-e2e/);
  assert.match(r.text, /\[run r\S+ exited 0 in .* · shell · cwd .* · next=\d+ · session created\]/, r.text);
  const bad = await h.call('run', { session: 'e2e' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /command/);
  const busy = await h.call('run', { session: 'e2e', command: 'sleep 2', wait: 50 });
  assert.ok(['starting', 'running'].includes(busy.structured.state as string), `still running: ${busy.structured.state}`);
  const runId = busy.structured.runId as string;
  const b2 = await h.call('run', { session: 'e2e', command: 'echo no', wait: 50 });
  assert.equal(b2.structured.state, 'busy');
  assert.equal((b2.structured.busy as { runId: string }).runId, runId);
  const waited = await h.call('await', { session: 'e2e', runId, wait: 5000 });
  assert.equal(waited.structured.state, 'exited');
  const read = await h.call('read', { session: 'e2e', since: 0 });
  assert.match(read.text, /hi-from-e2e/);
  assert.ok((read.structured.nextCursor as number) > 0);
  const scr = await h.call('screen', { session: 'e2e' });
  assert.ok((scr.structured.lines as string[]).length > 0);
  const list = await h.call('session_list', {});
  assert.match(list.text, /^e2e: idle/);
  const health = await fetch(`http://127.0.0.1:${port}/health?token=ta`).then((x) => x.json() as Promise<{ status: string; sessions: Array<{ id: string }> }>);
  assert.equal(health.status, 'ok');
  assert.ok(health.sessions.some((s) => s.id === 'e2e'));
  h.close();
});

test('auth: unknown tokens receive a 401 at WebSocket upgrade', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=nope`);
  const status = await new Promise<number>((resolve, reject) => {
    ws.once('open', () => resolve(101));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', reject);
  });
  assert.equal(status, 401);
});

test('native family: terminal/subscribe replays from a cursor and streams new events', async () => {
  const h = new Host('ta', 'native1');
  await h.connect();
  await h.call('run', { session: 'live', command: 'echo one; echo two; echo four' });
  const sub = (await h.request('terminal/subscribe', { session: 'live', since: 0 })) as { nextCursor: number };
  assert.ok(sub.nextCursor > 0);
  const replayed = h.inbound.filter((m) => m.method === 'terminal/event').length;
  assert.ok(replayed > 10, `replayed ${replayed} events`);
  h.inbound.length = 0;
  await h.call('run', { session: 'live', command: 'echo streamed' });
  const ev = await h.expect('terminal/event', 3000);
  assert.equal((ev.params as { session: string }).session, 'live');
  h.close();
});

test('G20: a new daemon recovers the old journals as history-only and marks in-flight runs lost', async () => {
  const h = new Host('ta', 'rec1');
  await h.connect();
  const r = await h.call('run', { session: 'live', command: 'sleep 20', wait: 50 });
  assert.ok(['starting', 'running'].includes(r.structured.state as string), `still running: ${r.structured.state}`);
  h.close();
  // A second registry on the same data dir stands in for the daemon after a crash.
  const again = new SessionRegistry({ dataDir, backend: new NodePtyBackend() });
  const rec = again.get('live');
  assert.ok(rec && rec.kind === 'history', `recovered kind: ${rec?.kind}; ids: ${again.list().map((s) => (s.kind === 'live' ? s.session.id : s.id)).join(',')}`);
  assert.equal(rec.recovered, 'history-only');
  const events = rec.journal.since(0).events;
  const lost = events.find((e) => e.type === 'run.end' && e.runId === r.structured.runId);
  assert.ok(lost && lost.type === 'run.end' && lost.state === 'lost' && lost.reason === 'daemon-restart', `in-flight run end: ${JSON.stringify(lost)}`);
  assert.ok(events.some((e) => e.type === 'recovered'), 'recovered event journaled');
  const app2 = new App({ registry: again });
  const read = await app2.read({ principal: 'agent:a@test', connectionId: 'x' }, { session: 'live', since: 0 });
  assert.match(read.text ?? '', /four/);
  const w = await app2.awaitRun({ principal: 'agent:a@test', connectionId: 'x' }, { runId: r.structured.runId as string });
  assert.equal(w.state, 'lost', 'await on a recovered Run reports its recorded outcome');
  assert.equal(w.reason, 'daemon-restart');
  await again.closeAll();
});
