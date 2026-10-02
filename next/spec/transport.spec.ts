/**
 * The endpoint's guard rails and the native family, against the scripted
 * backend: Host and Origin (DNS rebinding, CSWSH), frames that must never crash
 * the daemon, frame caps, connection identity (api-11), native subscribe paging
 * and backpressure, attach snapshots under concurrent output (G13), static
 * hosting, /health, the usage hook and structured logs.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import xterm from '@xterm/headless';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend, type ScriptedPty } from '../src/backends/scripted.js';
import type { JournalEvent } from '../src/core/types.js';
import { Journal } from '../src/core/journal.js';
import { MemoryStore } from '../src/core/stores.js';
import { Follower } from '../src/transport/follower.js';
import { TermServer, type LogRecord, type ServerOptions, type UsageRecord } from '../src/transport/server.js';
import { FakeShell } from './fake-shell.js';

const { Terminal } = xterm;
const TOKENS = { ta: 'agent:a@test', tb: 'agent:b@test', th: 'human:test:9' };
const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

type Msg = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

interface Harness {
  server: TermServer;
  registry: SessionRegistry;
  app: App;
  backend: ScriptedBackend;
  port: number;
  logs: LogRecord[];
  usage: UsageRecord[];
  close(): Promise<void>;
}

async function start(opts: Partial<ServerOptions> & { prepare?: (dataDir: string) => void } = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-transport-'));
  roots.push(dataDir);
  opts.prepare?.(dataDir);
  const backend = new ScriptedBackend();
  backend.onSpawnShell = (p) => {
    const sh = new FakeShell(p);
    sh.on('echo hello', () => ({ output: 'hello\r\n', exit: 0 }));
    sh.on(/^sleep/, () => ({ hang: true }));
    const kill = p.kill.bind(p);
    p.kill = (sig) => {
      kill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') p.exit({ exitCode: null, signal: sig });
    };
  };
  const registry = new SessionRegistry({ dataDir, backend, defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 2000 });
  const logs: LogRecord[] = [];
  const usage: UsageRecord[] = [];
  const { prepare: _p, ...rest } = opts;
  const so: ServerOptions = {
    app,
    resolver: new TokenMapResolver({ tokens: TOKENS }),
    host: '127.0.0.1',
    port: 0,
    version: 'spec',
    usage: { record: (r) => usage.push(r) },
    ...rest,
  };
  // A test that passes `log` gets the JSON lines; everyone else gets the records.
  if (!opts.log) so.logger = (r) => logs.push(r);
  const server = new TermServer(so);
  const port = (await server.listen()).port;
  return {
    server,
    registry,
    app,
    backend,
    port,
    logs,
    usage,
    async close() {
      await server.close();
      await registry.closeAll();
    },
  };
}

/** Server internals a test may look at. */
const conns = (s: TermServer) => (s as unknown as { conns: Set<{ id: string; ws: WebSocket; followers: Map<string, Follower> }> }).conns;

class Client {
  readonly inbound: Msg[] = [];
  private nextId = 1;
  private readonly pending = new Map<number | string, (m: Msg) => void>();
  private readonly waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      if (m.method === undefined && m.id !== undefined && m.id !== null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        p(m);
        return;
      }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i !== -1) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbound.push(m);
    });
    this.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  }

  static async open(port: number, q: Record<string, string> = {}, wsOpts: WebSocket.ClientOptions = {}): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${new URLSearchParams({ token: 'ta', ...q })}`, wsOpts);
    await new Promise<void>((r, j) => {
      ws.once('open', () => r());
      ws.once('error', j);
    });
    return new Client(ws);
  }

  raw(text: string | Buffer): void {
    this.ws.send(text);
  }

  /** Send a request and resolve with the whole response message. */
  send(method: string, params?: unknown): Promise<Msg> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const m = await this.send(method, params);
    if (m.error) throw Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data });
    return m.result;
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ structured: Record<string, unknown>; isError?: boolean; text: string }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
    const out: { structured: Record<string, unknown>; isError?: boolean; text: string } = { structured: r.structuredContent, text: r.content.map((c) => c.text).join('\n') };
    if (r.isError) out.isError = true;
    return out;
  }

  /** The next inbound message matching `pred` (already received or upcoming). */
  next(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const i = this.inbound.findIndex(pred);
    if (i !== -1) return Promise.resolve(this.inbound.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no matching message within ${ms} ms`)), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  /** Answer for a frame sent raw, matched by id. */
  async rawReply(text: string, id: number | string | null, ms = 2000): Promise<Msg> {
    this.raw(text);
    return this.next((m) => m.method === undefined && (m.id ?? null) === id, ms);
  }

  close(): void {
    this.ws.close(1000);
  }
}

/** Try a WebSocket upgrade; resolve with the socket or the HTTP status that refused it. */
function tryUpgrade(url: string, opts: WebSocket.ClientOptions = {}): Promise<{ ws: WebSocket } | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
      ws.terminate();
    });
    ws.once('error', () => resolve({ status: -1 }));
  });
}

function httpGet(port: number, pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const lines = [`${method} ${pathname} HTTP/1.1`, `Host: ${headers.Host ?? `127.0.0.1:${port}`}`, 'Connection: close'];
    for (const [k, v] of Object.entries(headers)) if (k !== 'Host') lines.push(`${k}: ${v}`);
    sock.write(lines.join('\r\n') + '\r\n\r\n');
    const chunks: Buffer[] = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [head = '', ...rest] = text.split('\r\n\r\n');
      const [statusLine = '', ...hl] = head.split('\r\n');
      const h: Record<string, string> = {};
      for (const l of hl) {
        const i = l.indexOf(':');
        if (i > 0) h[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      let body = rest.join('\r\n\r\n');
      if (h['transfer-encoding'] === 'chunked') {
        let out = '';
        let s = body;
        for (;;) {
          const nl = s.indexOf('\r\n');
          const n = parseInt(s.slice(0, nl), 16);
          if (!n) break;
          out += s.slice(nl + 2, nl + 2 + n);
          s = s.slice(nl + 2 + n + 2);
        }
        body = out;
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers: h, body });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function liveSession(h: Harness, id: string) {
  const s = h.registry.get(id);
  assert.ok(s && s.kind === 'live', `session ${id} is live`);
  return s.session;
}

// ───────────────────────────── Host and Origin (sec-1) ─────────────────────────────

test('sec-1: Host rebinding is refused (421) on HTTP and on upgrade; loopback names and --allow-host names are served', async () => {
  const h = await start({ allowHosts: ['term.example', 'proxy.example:8443'] });
  try {
    const p = h.port;
    assert.equal((await httpGet(p, '/health', { Host: `evil.example:${p}` })).status, 421);
    assert.equal((await httpGet(p, '/', { Host: `evil.example:${p}` })).status, 421);
    assert.equal((await httpGet(p, '/health', { Host: 'proxy.example' })).status, 421, 'an entry with a port matches only that port');
    assert.equal((await httpGet(p, '/health', { Host: `term.example:${p + 1}` })).status, 421, 'an --allow-host name without a port: ours or none');
    for (const ok of [`127.0.0.1:${p}`, `localhost:${p}`, `LOCALHOST:${p}`, `[::1]:${p}`, `term.example:${p}`, 'term.example', 'proxy.example:8443']) {
      assert.equal((await httpGet(p, '/health', { Host: ok })).status, 200, ok);
    }
    const bad = await tryUpgrade(`ws://127.0.0.1:${p}/?token=ta`, { headers: { Host: `attacker.example:${p}` } });
    assert.deepEqual(bad, { status: 421 });
    const good = await tryUpgrade(`ws://127.0.0.1:${p}/?token=ta`, { headers: { Host: `term.example:${p}` } });
    assert.ok('ws' in good, 'an --allow-host name is served');
    good.ws.close();
    assert.ok(h.logs.some((l) => l.msg === 'upgrade refused: Host not served (serve it with --allow-host)' && l.status === 421));
  } finally {
    await h.close();
  }
});

test('sec-1: cross-site WebSocket hijacking is refused (403); a same-origin browser is the GUI human, human:gui:<name>', async () => {
  const h = await start({ allowHosts: ['term.example'] });
  try {
    const p = h.port;
    const base = `ws://127.0.0.1:${p}/?token=ta`;
    assert.deepEqual(await tryUpgrade(base, { origin: 'https://evil.example' }), { status: 403 });
    assert.deepEqual(await tryUpgrade(base, { origin: 'null' }), { status: 403 });
    assert.deepEqual(await tryUpgrade(base, { origin: `http://localhost:${p}` }), { status: 403 }, 'same site, other origin');
    assert.equal((await httpGet(p, '/health', { Origin: 'https://evil.example' })).status, 403);

    // Our own page: same origin as the Host it connected to.
    const owner = await Client.open(p);
    await owner.call('session_open', { session: 'shared1', visibility: 'shared' });
    const gui = await Client.open(p, { token: 'ta' }, { origin: `http://127.0.0.1:${p}` });
    const att = (await gui.request('terminal/attach', { session: 'shared1' })) as { principal: string; role: string };
    assert.equal(att.principal, 'human:gui:agent:a@test');
    assert.equal(att.role, 'observer', 'the GUI human is not the owner, so it does not take the seat');
    const human = await Client.open(p, { token: 'th' }, { origin: `http://127.0.0.1:${p}` });
    assert.equal(((await human.request('terminal/attach', { session: 'shared1' })) as { principal: string }).principal, 'human:test:9', 'a human principal is kept');
    const proxied = await tryUpgrade(base, { headers: { Host: `term.example:${p}` }, origin: `http://term.example:${p}` });
    assert.ok('ws' in proxied, 'same origin through an allowed name');
    proxied.ws.close();
    // Non-browser clients send no Origin and keep their principal.
    const opened = await owner.call('session_open', { session: 'mine' });
    assert.equal((opened.structured.info as { owner: string }).owner, 'agent:a@test');
    for (const c of [owner, gui, human]) c.close();
  } finally {
    await h.close();
  }
});

// ───────────────────────────── nothing a client sends crashes the daemon ─────────────────────────────

test('api-1/sec-2: malformed frames get JSON-RPC errors; the daemon keeps serving and a live session survives', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    const opened = await c.call('session_open', { session: 'survivor' });
    assert.equal(opened.isError, undefined, opened.text);
    const cases: Array<[string, number | string | null, number]> = [
      ['null', null, -32600],
      ['[]', null, -32600],
      ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', null, -32600],
      ['5', null, -32600],
      ['"s"', null, -32600],
      ['true', null, -32600],
      ['not json', null, -32700],
      ['{"jsonrpc":"2.0","id":7,"method":5}', 7, -32600],
      ['{"jsonrpc":"2.0","id":"m","method":""}', 'm', -32600],
      ['{"jsonrpc":"2.0","id":{},"method":"ping"}', null, -32600],
      ['{"jsonrpc":"2.0","id":8,"method":"ping","params":"x"}', 8, -32602],
      ['{"jsonrpc":"2.0","id":9,"method":"ping","params":[1]}', 9, -32602],
      ['{"jsonrpc":"2.0","id":11,"method":"terminal/subscribe","params":{"session":{}}}', 11, -32602],
      ['{"jsonrpc":"2.0","id":12,"method":"terminal/attach","params":{"session":"nope"}}', 12, -32602],
      ['{"jsonrpc":"2.0","id":13,"method":"terminal/subscribe","params":{"session":"survivor","since":-4}}', 13, -32602],
      ['{"jsonrpc":"2.0","id":14,"method":"channels/open","params":{}}', 14, -32601],
      ['{"jsonrpc":"2.0","id":15,"method":"no/such"}', 15, -32601],
      ['{"jsonrpc":"2.0","method":7}', null, -32600],
      ['{}', null, -32600],
      ['{"jsonrpc":"2.0","id":16}', 16, -32600],
    ];
    for (const [frame, id, code] of cases) {
      const r = await c.rawReply(frame, id);
      assert.equal(r.error?.code, code, `${frame} → ${JSON.stringify(r)}`);
    }
    // Response-shaped frames are never answered (two peers could answer each other forever): stray,
    // malformed or id-less responses are dropped. Binary garbage is a parse error.
    for (const frame of ['{"jsonrpc":"2.0","id":99,"error":"boom"}', '{"jsonrpc":"2.0","id":98,"result":1}', '{"jsonrpc":"2.0","id":null,"error":{"code":1,"message":"x"}}', '{"result":{}}']) c.raw(frame);
    const garbage = await c.rawReply('\u0000ÿ{', null);
    assert.equal(garbage.error?.code, -32700);
    const odd = await c.call('run', { session: 'survivor', command: ['x'] } as unknown as Record<string, unknown>);
    assert.equal(odd.isError, true);
    const weird = (await c.request('tools/call', { name: 5, arguments: [1] })) as { isError?: boolean };
    assert.equal(weird.isError, true);
    const init = (await c.request('initialize', { capabilities: null, protocolVersion: 3 })) as { protocolVersion: string };
    assert.equal(init.protocolVersion, '2025-06-18');
    // Still serving, on this connection and new ones, and the session is alive.
    assert.deepEqual(await c.request('ping'), {});
    const r = await c.call('run', { session: 'survivor', command: 'echo hello' });
    assert.equal(r.structured.state, 'exited', r.text);
    const c2 = await Client.open(h.port);
    assert.deepEqual(await c2.request('ping'), {});
    c.close();
    c2.close();
  } finally {
    await h.close();
  }
});

test('sec-3: a malformed upgrade request target answers 400 and the daemon keeps serving', async () => {
  const h = await start();
  try {
    for (const target of ['//[', '//[::1', 'http://[']) {
      const reply = await new Promise<string>((resolve) => {
        const s = net.connect(h.port, '127.0.0.1');
        let buf = '';
        s.on('data', (d) => (buf += d.toString()));
        s.on('close', () => resolve(buf));
        s.on('error', () => resolve(buf));
        s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      assert.match(reply, /^HTTP\/1\.1 400/, `${target}: ${reply.slice(0, 40)}`);
    }
    const c = await Client.open(h.port);
    assert.deepEqual(await c.request('ping'), {});
    c.close();
  } finally {
    await h.close();
  }
});

test('sec-8: frames beyond maxPayload close that socket (1009) and nothing else', async () => {
  const h = await start({ maxPayload: 64 * 1024 });
  try {
    const c = await Client.open(h.port);
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(100 * 1024) } }));
    assert.equal((await c.closed).code, 1009);
    const c2 = await Client.open(h.port);
    assert.deepEqual(await c2.request('ping'), {});
    c2.close();
  } finally {
    await h.close();
  }
  // The default cap is 4 MiB, not ws's 100 MiB.
  const d = await start();
  try {
    const c = await Client.open(d.port);
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }));
    assert.equal((await c.closed).code, 1009);
  } finally {
    await d.close();
  }
});

test('sec-8: requests in flight per connection are bounded', async () => {
  const h = await start({ maxInFlight: 2 });
  try {
    const c = await Client.open(h.port);
    const r = await c.call('run', { session: 'busy1', command: 'sleep 9', wait: 0 });
    const runId = r.structured.runId as string;
    const waits = [1, 2, 3].map(() => c.send('tools/call', { name: 'await', arguments: { session: 'busy1', runId, wait: 800 } }));
    const third = await waits[2]!;
    assert.equal(third.error?.code, -32050, JSON.stringify(third));
    const [a, b] = await Promise.all([waits[0]!, waits[1]!]);
    assert.equal(((a.result as { structuredContent: { state: string } }).structuredContent).state, 'running');
    assert.equal(((b.result as { structuredContent: { state: string } }).structuredContent).state, 'running');
    assert.deepEqual(await c.request('ping'), {}, 'slots are released');
    c.close();
  } finally {
    await h.close();
  }
});

// ───────────────────────────── connection identity (api-11) ─────────────────────────────

test('api-11: a client reusing another connection label cannot detach its attachments or release its seat', async () => {
  const h = await start();
  try {
    const a = await Client.open(h.port, { token: 'ta', connection: 'shim-12345' });
    const opened = await a.call('session_open', { session: 'hij', visibility: 'shared' });
    assert.equal(opened.structured.role, 'controller');
    const b = await Client.open(h.port, { token: 'tb', connection: 'shim-12345' });
    const bo = await b.call('session_open', { session: 'hij' });
    assert.equal(bo.structured.role, 'observer');
    b.close();
    await b.closed;
    await sleep(50);
    const s = liveSession(h, 'hij');
    assert.equal(s.currentController, 'agent:a@test', 'the seat survives another principal disconnecting under the same label');
    const typed = await a.call('input', { session: 'hij', text: 'x' });
    assert.equal(typed.isError, undefined, typed.text);
    const ids = [...conns(h.server)].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^c-[0-9a-f]{16}$/.test(id)), 'connection ids are generated by the server');
    // Closing A's own connection does remove A's attachments (they are keyed by its id).
    a.close();
    await a.closed;
    await until(() => !s.listAttachments().some((x) => x.principal === 'agent:a@test'), 2000, "A's attachments to go with A's connection");
  } finally {
    await h.close();
  }
});

// ───────────────────────────── native subscribe (jr-7, tg-10, jr-15) ─────────────────────────────

function eventsOf(c: Client, session: string): JournalEvent[] {
  return c.inbound.filter((m) => m.method === 'terminal/event' && (m.params as { session: string }).session === session).map((m) => (m.params as { event: JournalEvent }).event);
}

function assertContiguous(seqs: number[], from: number, to: number, what: string): void {
  assert.equal(seqs.length, to - from + 1, `${what}: expected ${to - from + 1} events ${from}..${to}, got ${seqs.length} (first ${seqs[0]}, last ${seqs[seqs.length - 1]})`);
  seqs.forEach((s, i) => assert.equal(s, from + i, `${what}: seq ${from + i} expected at ${i}, got ${s}`));
}

test('jr-7/tg-10 (G13): terminal/subscribe replays past 5000 events with no hole or duplicate, then goes live', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'big' });
    const s = liveSession(h, 'big');
    for (let i = 0; i < 6500; i++) s.journal.append({ type: 'note', text: `n${i}`, principal: 'agent:a@test' });
    const last = s.journal.lastSeq;
    const sub = (await c.request('terminal/subscribe', { session: 'big', since: 0 })) as { nextCursor: number; gap: unknown; lastSeq: number };
    assert.equal(sub.gap, null);
    assert.equal(sub.lastSeq, last);
    await until(() => eventsOf(c, 'big').length >= last, 5000, 'full replay');
    s.journal.append({ type: 'note', text: 'live-1', principal: 'agent:a@test' });
    s.journal.append({ type: 'note', text: 'live-2', principal: 'agent:a@test' });
    await until(() => eventsOf(c, 'big').length >= last + 2, 3000, 'live events');
    assertContiguous(eventsOf(c, 'big').map((e) => e.seq), 1, last + 2, 'replay then live');
    c.close();
  } finally {
    await h.close();
  }
});

test('G11: a subscribe cursor older than retention is answered with terminal/gap naming the missing range', async () => {
  const h = await start({
    prepare: (dataDir) => {
      const dir = path.join(dataDir, 'sessions', 'old');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private' }));
      const lines: string[] = [];
      for (let seq = 100; seq < 130; seq++) lines.push(JSON.stringify({ type: 'note', text: `n${seq}`, principal: 'agent:a@test', seq, ts: Date.now() }));
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
    },
  });
  try {
    const c = await Client.open(h.port);
    const sub = (await c.request('terminal/subscribe', { session: 'old', since: 0 })) as { gap: { from: number; to: number } | null; lastSeq: number };
    assert.deepEqual(sub.gap && { from: sub.gap.from, to: sub.gap.to }, { from: 1, to: 99 });
    const gap = await c.next((m) => m.method === 'terminal/gap');
    assert.deepEqual(gap.params, { session: 'old', from: 1, to: 99, reason: 'retention' });
    await until(() => eventsOf(c, 'old').length >= sub.lastSeq - 99, 2000, 'retained events');
    assertContiguous(eventsOf(c, 'old').map((e) => e.seq), 100, sub.lastSeq, 'after the gap');
    c.close();
  } finally {
    await h.close();
  }
});

test('G13: a subscriber to a history-only session follows it into its new life with no hole', async () => {
  const h = await start({
    prepare: (dataDir) => {
      const dir = path.join(dataDir, 'sessions', 'reborn');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private' }));
      const lines = [1, 2, 3].map((seq) => JSON.stringify({ type: 'note', text: `old${seq}`, principal: 'agent:a@test', seq, ts: Date.now() }));
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
    },
  });
  try {
    const c = await Client.open(h.port);
    const sub = (await c.request('terminal/subscribe', { session: 'reborn', since: 0 })) as { lastSeq: number };
    await until(() => eventsOf(c, 'reborn').length >= sub.lastSeq, 2000, 'history replay');
    const opened = await c.call('session_open', { session: 'reborn' });
    assert.equal(opened.structured.created, true, opened.text);
    const s = liveSession(h, 'reborn');
    s.journal.append({ type: 'note', text: 'new life', principal: 'agent:a@test' });
    await until(() => eventsOf(c, 'reborn').at(-1)?.seq === s.journal.lastSeq, 3000, 'events of the new life');
    assertContiguous(eventsOf(c, 'reborn').map((e) => e.seq), 1, s.journal.lastSeq, 'across the new life');
    c.close();
  } finally {
    await h.close();
  }
});

test('jr-15 (G13): a stalled subscriber costs the daemon at most the high-water mark, and resumes by cursor with nothing lost', async () => {
  const HIGH = 64 * 1024;
  const h = await start({ highWaterBytes: HIGH });
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'flood' });
    const s = liveSession(h, 'flood');
    const from = s.journal.lastSeq;
    await c.request('terminal/subscribe', { session: 'flood' });
    c.ws.pause(); // the client stops reading
    const conn = [...conns(h.server)][0]!;
    const chunk = 'y'.repeat(8 * 1024);
    let peak = 0;
    for (let i = 0; i < 2500; i++) {
      s.journal.append({ type: 'note', text: `${i}:${chunk}`, principal: 'agent:a@test' });
      peak = Math.max(peak, conn.ws.bufferedAmount);
      if (i % 100 === 0) await sleep(1); // let the socket write what the kernel takes
    }
    const follower = conn.followers.get('flood')!;
    assert.equal(follower.state, 'paused', 'the follower fell back to cursor mode');
    assert.ok(peak <= HIGH + 16 * 1024, `socket queue peaked at ${peak} bytes for a 20 MB flood`);
    const last = s.journal.lastSeq;
    c.ws.resume();
    await until(() => eventsOf(c, 'flood').length >= last - from, 15_000, 'catch-up after resume');
    assertContiguous(eventsOf(c, 'flood').map((e) => e.seq), from + 1, last, 'after the stall');
    assert.equal(c.inbound.filter((m) => m.method === 'terminal/gap').length, 0, 'the file store retained everything: no gap');
    c.close();
  } finally {
    await h.close();
  }
});

test('G13: a follower that falls behind retention sends a gap, then the retained events, then live — never silently skipping', async () => {
  const journal = new Journal({ hot: new MemoryStore(4096) });
  for (let i = 0; i < 10; i++) journal.append({ type: 'note', text: `a${i}`, principal: 'agent:a@test' });
  let buffered = 0;
  const got: number[] = [];
  const gaps: Array<{ from: number; to: number }> = [];
  const f = new Follower(journal, 0, { event: (e) => got.push(e.seq), gap: (g) => gaps.push({ from: g.from, to: g.to }), buffered: () => buffered, open: () => true }, { highWaterBytes: 1000, pollMs: 5 });
  f.start();
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(f.state, 'live');
  buffered = 1_000_000; // the socket is full
  for (let i = 0; i < 400; i++) journal.append({ type: 'note', text: `b${i}`, principal: 'agent:a@test' });
  assert.equal(f.state, 'paused');
  assert.equal(got.length, 10, 'nothing is queued while stalled');
  const oldest = journal.oldestSeq!;
  assert.ok(oldest > 11, 'retention moved past the cursor');
  buffered = 0;
  await until(() => f.state === 'live', 1000, 'resume');
  assert.deepEqual(gaps, [{ from: 11, to: oldest - 1 }]);
  assertContiguous(got.slice(10), oldest, journal.lastSeq, 'after the gap');
  journal.append({ type: 'note', text: 'c', principal: 'agent:a@test' });
  assert.equal(got[got.length - 1], journal.lastSeq);
  f.close();
  journal.append({ type: 'note', text: 'd', principal: 'agent:a@test' });
  assert.notEqual(got[got.length - 1], journal.lastSeq, 'a closed follower sends nothing');
});

test('a follower whose journal read fails or makes no progress ends visibly instead of hanging the daemon', async () => {
  const sink = { event: () => undefined, gap: () => undefined, buffered: () => 0, open: () => true };
  const base = { lastSeq: 10, subscribe: () => () => undefined };
  // A journal that claims more but returns nothing would spin a synchronous loop forever.
  const stuck = new Follower({ ...base, since: (c: number) => ({ events: [], nextCursor: c, more: true }) }, 0, sink);
  assert.throws(() => stuck.start(), /no events after seq 0/);
  assert.equal(stuck.state, 'closed');
  const broken = new Follower({ ...base, since: () => { throw new Error('EIO'); } }, 0, sink);
  assert.throws(() => broken.start(), /EIO/);
  assert.equal(broken.state, 'closed');
  // A read that fails while resuming from a stall goes to onError, and the follower is closed.
  const journal = new Journal();
  for (let i = 0; i < 3; i++) journal.append({ type: 'note', text: `x${i}`, principal: 'agent:a@test' });
  let buffered = 1_000_000;
  const errors: unknown[] = [];
  let failing = false;
  const source = { get lastSeq() { return journal.lastSeq; }, subscribe: journal.subscribe.bind(journal), since: (c: number, l?: number) => { if (failing) throw new Error('EIO later'); return journal.since(c, l); } };
  const f = new Follower(source, 0, { ...sink, buffered: () => buffered }, { highWaterBytes: 10, pollMs: 5, onError: (e) => errors.push(e) });
  f.start();
  assert.equal(f.state, 'paused');
  failing = true;
  buffered = 0;
  await until(() => errors.length > 0, 1000, 'onError');
  assert.equal(f.state, 'closed');
  assert.match(String(errors[0]), /EIO later/);
});

// ───────────────────────────── attach (G13) ─────────────────────────────

function screenLines(t: InstanceType<typeof Terminal>): string[] {
  const buf = t.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < t.rows; y++) out.push((buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
  return out;
}

test('G13: terminal/attach gives a snapshot at N and then exactly the events after N, under concurrent output', async () => {
  const h = await start();
  try {
    const owner = await Client.open(h.port);
    await owner.call('session_open', { session: 'g13', visibility: 'shared', cols: 60, rows: 12 });
    const s = liveSession(h, 'g13');
    const pty = h.backend.ptys[h.backend.ptys.length - 1] as ScriptedPty;
    let running = true;
    let i = 0;
    const flood = (async () => {
      while (running) {
        i++;
        let chunk = `\x1b[3${i % 8}mline ${i} ${'#'.repeat(i % 37)}\x1b[0m\r\n`;
        if (i % 17 === 0) chunk += `\x1b[${(i % 10) + 1};${(i % 40) + 1}H*${i}*`;
        if (i % 97 === 0) chunk += '\x1b[2J\x1b[H';
        if (i % 13 === 0) chunk += 'part-';
        pty.emit(chunk);
        // A little faster than the emulator parses (one chunk per timer tick), so a backlog is
        // pending whenever an attach waits for the screen, and output keeps arriving during the wait.
        if (i % 4 === 0) pty.emit(`extra ${i}\r\n`);
        await new Promise((r) => setTimeout(r, 0));
      }
    })();
    const clients: Array<{ c: Client; snap: { data: string; cols: number; rows: number; seq: number } }> = [];
    for (let k = 0; k < 6; k++) {
      await sleep(15 + k * 11);
      const c = await Client.open(h.port, { token: 'tb' });
      const r = (await c.request('terminal/attach', { session: 'g13' })) as { snapshot: { data: string; cols: number; rows: number; seq: number }; role: string };
      assert.equal(r.role, 'observer');
      clients.push({ c, snap: r.snapshot });
    }
    running = false;
    await flood;
    await s.screen.settled();
    const last = s.journal.lastSeq;
    const expected = s.snapshot().lines.map((l) => l.replace(/\s+$/, ''));
    for (const [k, { c, snap }] of clients.entries()) {
      await until(() => (eventsOf(c, 'g13').at(-1)?.seq ?? snap.seq) >= last, 5000, `client ${k} caught up`);
      const evs = eventsOf(c, 'g13');
      assertContiguous(evs.map((e) => e.seq), snap.seq + 1, last, `client ${k}`);
      const t = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true });
      await new Promise<void>((r) => t.write(snap.data, r));
      for (const e of evs) if (e.type === 'output') await new Promise<void>((r) => t.write(e.data, r));
      assert.deepEqual(screenLines(t), expected, `client ${k} (snapshot at ${snap.seq}) rebuilds the daemon's screen`);
      t.dispose();
    }
    for (const { c } of clients) c.close(); // after the checks: a detach is an event too
    assert.ok(i > 50, `the flood ran (${i} chunks)`);
    assert.ok(!h.logs.some((l) => l.msg.startsWith('attach snapshot taken during continuous output')), 'every snapshot had a provable seq');
    owner.close();
  } finally {
    await h.close();
  }
});

test('terminal/attach: the owner takes the free seat; detach releases it and stops the stream; history sessions attach with a transcript', async () => {
  const h = await start({
    prepare: (dataDir) => {
      const dir = path.join(dataDir, 'sessions', 'past');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private' }));
      const ts = Date.now();
      const ev = [
        { type: 'run.admit', runId: 'r1', target: 'shell', principal: 'agent:a@test', origin: 'self', queued: false, line: 'make', seq: 1, ts },
        { type: 'run.start', runId: 'r1', cwd: '/w', seq: 2, ts },
        { type: 'output', data: 'built ok\r\n', stream: 'pty', runId: 'r1', seq: 3, ts },
        { type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 5, seq: 4, ts },
      ];
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
  });
  try {
    const setup = await Client.open(h.port, { profile: 'full' });
    await setup.call('session_open', { session: 'seat1' });
    const released = await setup.call('control', { session: 'seat1', action: 'release' });
    assert.equal(released.isError, undefined, released.text);
    const s = liveSession(h, 'seat1');
    assert.equal(s.currentController, null);
    const c = await Client.open(h.port);
    const r = (await c.request('terminal/attach', { session: 'seat1' })) as { role: string; controller: string; attachmentId: string; runs: unknown[]; info: { id: string } };
    assert.equal(r.role, 'controller');
    assert.equal(r.controller, 'agent:a@test');
    assert.equal(r.info.id, 'seat1');
    const again = (await c.request('terminal/attach', { session: 'seat1' })) as { attachmentId: string };
    assert.equal(again.attachmentId, r.attachmentId, 'attaching twice on one connection reuses the attachment');
    const d = (await c.request('terminal/detach', { session: 'seat1' })) as { detached: number };
    assert.equal(d.detached, 1);
    assert.ok(!s.listAttachments().some((x) => x.attachmentId === r.attachmentId), 'the attachment is gone');
    const n = eventsOf(c, 'seat1').length;
    s.journal.append({ type: 'note', text: 'after detach', principal: 'agent:a@test' });
    await sleep(50);
    assert.equal(eventsOf(c, 'seat1').length, n, 'no events after detach');

    const hist = (await c.request('terminal/attach', { session: 'past' })) as { snapshot: null; transcript: string; lastSeq: number; runs: Array<{ runId: string; state: string; exit: number; line: string }> };
    assert.equal(hist.snapshot, null);
    assert.match(hist.transcript, /built ok/);
    assert.ok(hist.lastSeq >= 4);
    assert.deepEqual(hist.runs.map((x) => [x.runId, x.state, x.exit, x.line]), [['r1', 'exited', 0, 'make']]);
    const forbidden = await Client.open(h.port, { token: 'tb' });
    await assert.rejects(forbidden.request('terminal/attach', { session: 'past' }), /forbidden/);
    c.close();
    forbidden.close();
    setup.close();
  } finally {
    await h.close();
  }
});

test('a subscriber is told when its session is closed (terminal/closed), rather than left waiting', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'gone' });
    await c.request('terminal/subscribe', { session: 'gone' });
    const closed = await c.call('session_close', { session: 'gone' });
    assert.equal(closed.isError, undefined, closed.text);
    const note = await c.next((m) => m.method === 'terminal/closed');
    const p = note.params as { session: string; reason: string };
    assert.equal(p.session, 'gone');
    assert.match(p.reason, /^session-(removed|closed)$/);
    assert.ok(eventsOf(c, 'gone').some((e) => e.type === 'session.exit'), 'the exit itself was streamed first');
    c.close();
  } finally {
    await h.close();
  }
});

// ───────────────────────────── static hosting, health, usage, logs ─────────────────────────────

test('GUI static assets: whitelist only, exact content types, nosniff, and a CSP limited to self and our WebSocket', async () => {
  const h = await start();
  try {
    const p = h.port;
    const page = await httpGet(p, '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    const csp = String(page.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${p} wss://127\\.0\\.0\\.1:${p}`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(page.body, /<script src="\/app.js"><\/script>/);
    const types: Record<string, string> = {
      '/app.js': 'text/javascript; charset=utf-8',
      '/vendor/xterm.js': 'text/javascript; charset=utf-8',
      '/vendor/addon-fit.js': 'text/javascript; charset=utf-8',
      '/vendor/xterm.css': 'text/css; charset=utf-8',
    };
    for (const [pth, type] of Object.entries(types)) {
      const r = await httpGet(p, pth);
      assert.equal(r.status, 200, pth);
      assert.equal(r.headers['content-type'], type, pth);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', pth);
      assert.ok(r.body.length > 100, pth);
    }
    for (const pth of ['/package.json', '/../package.json', '/%2e%2e/package.json', '/vendor/xterm.mjs', '/gui/app.js', '/src/daemon.ts', '/vendor/', '/app.js/']) {
      assert.equal((await httpGet(p, pth)).status, 404, pth);
    }
    assert.equal((await httpGet(p, '/', {}, 'POST')).status, 405);
    const head = await httpGet(p, '/app.js', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  } finally {
    await h.close();
  }
});

test('sec-10: /health reports per-session state, backend, controller, integration and connections by kind, scoped by token', async () => {
  const h = await start();
  try {
    const a = await Client.open(h.port);
    await a.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await a.call('session_open', { session: 'hp' });
    const r = await a.call('run', { session: 'hp', command: 'sleep 5', wait: 0 });
    const gui = await Client.open(h.port, { token: 'tb' }, { origin: `http://127.0.0.1:${h.port}` });
    await gui.request('ping');
    type Health = { status: string; pid: number; connections: Record<string, number>; sessionCount: number; sessions?: Array<Record<string, unknown>> };
    // tsg-17: with tokens configured, no credential gets liveness and counts only.
    const bare = JSON.parse((await httpGet(h.port, '/health')).body) as Health;
    assert.equal(bare.status, 'ok');
    assert.equal(bare.pid, process.pid);
    assert.equal(bare.connections.total, 2);
    assert.equal(bare.connections.mcp, 1);
    assert.equal(bare.connections.gui, 1);
    assert.equal(bare.sessions, undefined, 'no session list without a credential');
    const full = JSON.parse((await httpGet(h.port, '/health?token=ta')).body) as Health & { sessions: Array<Record<string, unknown>> };
    const hp = full.sessions.find((x) => x.id === 'hp')!;
    assert.equal(hp.state, 'busy');
    assert.equal(hp.backend, 'scripted');
    assert.equal(hp.controller, 'agent:a@test');
    assert.equal(hp.integration, 'rich');
    assert.deepEqual(hp.currentRun, { runId: r.structured.runId, state: 'running', target: 'shell', principal: 'agent:a@test' });
    const asB = JSON.parse((await httpGet(h.port, '/health?token=tb')).body) as Health & { sessions: Array<Record<string, unknown>> };
    assert.equal(asB.sessions.some((x) => x.id === 'hp'), false, "a private session is not in another principal's view");
    assert.equal(asB.sessionCount, full.sessionCount);
    assert.equal((await httpGet(h.port, '/health?token=nope')).status, 401);
    const asA = JSON.parse((await httpGet(h.port, '/health', { Authorization: 'Bearer ta' })).body) as Health & { sessions: Array<Record<string, unknown>> };
    assert.equal(asA.sessions.find((x) => x.id === 'hp')?.controller, 'agent:a@test');
    a.close();
    gui.close();
  } finally {
    await h.close();
  }
});

test('§16 Measure: the usage hook sees every tools/call with host, profile, outcome, argument names and a digest', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port, { connection: 'shim-77', profile: 'full' });
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await c.call('run', { session: 'u1', command: 'echo hello', wait: 1000 });
    await c.call('run', { session: 'u1' });
    await c.call('input', { session: 'u1', text: 'abc' });
    await c.call('input', { session: 'u1', text: 'abc' });
    const gui = await Client.open(h.port, {}, { origin: `http://127.0.0.1:${h.port}` });
    await gui.call('session_list', {}); // the GUI's own bookkeeping: logged at debug, not recorded (tsg-16)
    await gui.call('control', { session: 'u1', action: 'status' });
    assert.equal(h.usage.length, 5);
    const [run, bad, in1, in2, list] = h.usage as [UsageRecord, UsageRecord, UsageRecord, UsageRecord, UsageRecord];
    assert.equal(run.tool, 'run');
    assert.equal(run.ok, true);
    assert.equal(run.host, 'mcp');
    assert.equal(run.profile, 'full');
    assert.equal(run.connection, 'shim-77');
    assert.equal(run.principal, 'agent:a@test');
    assert.equal(run.session, 'u1');
    assert.equal(run.state, 'exited');
    assert.equal(run.wait, 1000);
    assert.match(run.runId ?? '', /^r\d+-/);
    assert.deepEqual(run.args, ['command', 'session', 'wait']);
    assert.match(run.digest ?? '', /^[0-9a-f]{16}$/);
    assert.equal(typeof run.ms, 'number');
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid_argument');
    assert.equal(in1.digest, in2.digest, 'the same input twice has the same digest');
    assert.notEqual(in1.digest, run.digest);
    assert.equal(list.tool, 'control');
    assert.equal(list.host, 'native');
    assert.equal(list.principal, 'human:gui:agent:a@test');
    assert.ok(h.logs.some((l) => l.msg === 'tool call' && l.tool === 'session_list' && l.level === 'debug'), 'the GUI list call is logged at debug');
    assert.ok(!JSON.stringify(h.usage).includes('echo hello'), 'argument values are not recorded');
    c.close();
    gui.close();
  } finally {
    await h.close();
  }
});

test('sec-10: logs are structured records; a forged label cannot inject a line, and tokens never appear', async () => {
  const lines: string[] = [];
  const h = await start({ log: (l) => lines.push(l) });
  try {
    const forged = 'evil\n{"level":"info","msg":"connection opened","principal":"agent:admin@corp"}';
    const c = await Client.open(h.port, { token: 'tb', connection: forged });
    await c.call('session_list', {});
    c.close();
    await c.closed;
    await tryUpgrade(`ws://127.0.0.1:${h.port}/?token=secret-guess-123`);
    await sleep(20);
    assert.ok(lines.length >= 3);
    for (const l of lines) {
      assert.ok(!l.includes('\n'), 'one record per line');
      const rec = JSON.parse(l) as LogRecord;
      assert.ok(rec.ts && rec.level && rec.msg);
      assert.notEqual(rec.principal, 'agent:admin@corp');
    }
    const opened = lines.map((l) => JSON.parse(l) as LogRecord).find((r) => r.msg === 'connection opened')!;
    assert.equal(opened.principal, 'agent:b@test');
    assert.match(String(opened.label), /^[A-Za-z0-9._:@-]{1,64}$/);
    assert.match(String(opened.connection), /^c-[0-9a-f]{16}$/);
    const all = lines.join('\n');
    for (const t of ['tb', 'secret-guess-123']) assert.ok(!all.includes(`token=${t}`) && !all.includes(`"${t}"`), `token ${t} never logged`);
    assert.ok(lines.some((l) => (JSON.parse(l) as LogRecord).msg === 'tool call'));
  } finally {
    await h.close();
  }
});

test('sec-7: close() terminates a client that never answers the close frame, within the grace', async () => {
  const h = await start({ shutdownGraceMs: 300 });
  const sock = net.connect(h.port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(`GET /?token=ta HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise<void>((r) => sock.once('data', () => r())); // 101, then silence: never answers a close frame
  const t0 = Date.now();
  await h.close();
  const took = Date.now() - t0;
  assert.ok(took < 2000, `close took ${took} ms`);
  sock.destroy();
});

// ───────────────────────────── seats, races, bounds, health, usage ─────────────────────────────

test('ss-13/tsg-10 (§9): an explicit terminal/detach releases the seat at once; only a drop reserves it', async () => {
  const h = await start();
  try {
    const owner = await Client.open(h.port, { profile: 'full' });
    await owner.call('session_open', { session: 'det1', visibility: 'shared' });
    await owner.call('control', { session: 'det1', action: 'release' });
    const b = await Client.open(h.port, { token: 'tb' });
    const att = (await b.request('terminal/attach', { session: 'det1', role: 'controller' })) as { role: string };
    assert.equal(att.role, 'controller');
    const s = liveSession(h, 'det1');
    await b.request('terminal/detach', { session: 'det1' });
    assert.equal(s.currentController, null, 'the seat is free right after the detach');
    assert.equal(s.info().seatReservedUntil, undefined, 'nothing is reserved "while it reconnects"');
    const took = await owner.call('control', { session: 'det1', action: 'take' });
    assert.equal(took.isError, undefined, took.text);
    // A dropped connection (no close frame) still keeps its seat through the grace.
    await owner.call('control', { session: 'det1', action: 'release' });
    const d = await Client.open(h.port, { token: 'tb' });
    await d.request('terminal/attach', { session: 'det1', role: 'controller' });
    d.ws.terminate();
    await until(() => s.info().seatReservedUntil !== undefined, 2000, 'the drop to reserve the seat');
    assert.equal(s.currentController, 'agent:b@test');
    owner.close();
    b.close();
  } finally {
    await h.close();
  }
});

test('tsg-4: an attach that races its connection closing leaves no attachment and no seat behind', async () => {
  const h = await start();
  try {
    const setup = await Client.open(h.port, { profile: 'full' });
    await setup.call('session_open', { session: 'orph', visibility: 'shared' });
    await setup.call('control', { session: 'orph', action: 'release' });
    const s = liveSession(h, 'orph');
    // The snapshot waits for the emulator (output streaming); the client leaves meanwhile.
    const screen = s.screen as { settled(): Promise<void> };
    const settled = screen.settled.bind(screen);
    screen.settled = () => sleep(150).then(settled);
    for (let i = 0; i < 5; i++) {
      const c = await Client.open(h.port);
      c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'terminal/attach', params: { session: 'orph', role: 'auto' } }));
      await sleep(10);
      c.close();
      await c.closed;
    }
    await sleep(400);
    screen.settled = settled;
    assert.deepEqual(s.listAttachments().filter((a) => a.principal === 'agent:a@test' && a.connectionId !== [...conns(h.server)][0]?.id).length, 0, 'no orphan attachments');
    assert.equal(s.currentController, null, 'the owner did not take the seat for a dead connection');

    // The same through the application layer: a session_open whose spawn outlives its connection.
    const ensure = h.registry.ensure.bind(h.registry);
    h.registry.ensure = (async (o: Parameters<typeof ensure>[0]) => {
      await sleep(150);
      return ensure(o);
    }) as typeof h.registry.ensure;
    const c = await Client.open(h.port);
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_open', arguments: { session: 'orph2' } } }));
    await sleep(20);
    c.close();
    await c.closed;
    await until(() => h.registry.get('orph2')?.kind === 'live', 2000, 'the late spawn');
    const s2 = liveSession(h, 'orph2');
    await until(() => s2.listAttachments().length === 0, 2000, 'the late attachment to be swept');
    assert.equal(s2.currentController, null, 'a clean close gives the seat up, even for an attach that landed after it');
    h.registry.ensure = ensure;
    setup.close();
  } finally {
    await h.close();
  }
});

test('tsg-14: a tools/call or terminal/* sent as a notification is not executed', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'nf' });
    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'run', arguments: { session: 'nf2', command: 'echo hello' } } }));
    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'terminal/attach', params: { session: 'nf' } }));
    assert.deepEqual(await c.request('ping'), {});
    await sleep(50);
    assert.equal(h.registry.get('nf2'), undefined, 'the notification-form run did not execute');
    assert.equal(h.usage.filter((u) => u.session === 'nf2').length, 0);
    assert.equal(liveSession(h, 'nf').listAttachments().length, 1, 'only the session_open attachment');
    c.close();
  } finally {
    await h.close();
  }
});

test('tsg-19: connections are bounded per principal, a silent one is closed, and a peer that stops answering pings is dropped (its seat goes through the grace)', async () => {
  const h = await start({ maxConnectionsPerPrincipal: 2, pendingTimeoutMs: 300, heartbeatMs: 100 });
  try {
    const a1 = await Client.open(h.port);
    const a2 = await Client.open(h.port);
    assert.deepEqual(await tryUpgrade(`ws://127.0.0.1:${h.port}/?token=ta`), { status: 429 }, 'a third connection for agent:a');
    const b = await Client.open(h.port, { token: 'tb' });
    await b.request('ping');
    // a2 never says anything: closed after the pending timeout. a1 speaks and stays.
    await a1.request('ping');
    const idle = await a2.closed;
    assert.equal(idle.code, 1008);
    assert.equal(a1.ws.readyState, WebSocket.OPEN);
    // A peer that holds the seat and then vanishes without a FIN: its socket stops reading, so it never answers a ping.
    await a1.call('session_open', { session: 'hb' });
    const s = liveSession(h, 'hb');
    assert.equal(s.currentController, 'agent:a@test');
    (a1.ws as unknown as { _socket: net.Socket })._socket.pause();
    await until(() => !s.listAttachments().some((x) => x.principal === 'agent:a@test'), 3000, 'the dead peer to be terminated');
    assert.ok(s.info().seatReservedUntil !== undefined, 'a drop: the seat is reserved through the grace, not held forever');
    assert.ok(h.logs.some((l) => l.msg === 'terminating a connection that stopped answering pings'));
    b.close();
    a1.ws.terminate();
  } finally {
    await h.close();
  }
});

test('G28 plumbing: ToolResult.onSent runs once after the response is written, and never when the connection closed first', async () => {
  const { TOOLS } = await import('../src/api/tools.js');
  const def = TOOLS.find((t) => t.name === 'session_list')!;
  const original = def.run;
  let sent = 0;
  let delay = 0;
  def.run = async (ctx, a) => {
    await sleep(delay);
    return { ...(await original(ctx, a)), onSent: () => void sent++ };
  };
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_list', {});
    await until(() => sent === 1, 1000, 'onSent');
    await sleep(50);
    assert.equal(sent, 1, 'exactly once');
    delay = 200;
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'session_list', arguments: {} } }));
    await sleep(20);
    c.ws.terminate();
    await sleep(400);
    assert.equal(sent, 1, 'a result that could not be written is not delivered');
  } finally {
    def.run = original;
    await h.close();
  }
});

test('jr2-14 (G20, G21): /health reports history sessions as closed or recovered, with retention and oldestSeq', async () => {
  const h = await start({
    prepare: (dataDir) => {
      const dir = path.join(dataDir, 'sessions', 'crashed');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private' }));
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ type: 'output', data: 'x', stream: 'pty', seq: 1, ts: Date.now() }) + '\n');
    },
  });
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'shut' });
    await c.call('session_close', { session: 'shut' });
    const body = JSON.parse((await httpGet(h.port, '/health?token=ta')).body) as { sessions: Array<Record<string, unknown>>; recoveryErrors: unknown };
    const shut = body.sessions.find((x) => x.id === 'shut')!;
    assert.equal(shut.closed, true);
    assert.equal(shut.recovered, undefined, 'a session closed on purpose is not "recovered"');
    // Retention is reported; by default it holds no limits, since nothing is deleted (G21).
    assert.deepEqual(shut.retention, {});
    assert.ok(typeof shut.oldestSeq === 'number');
    const crashed = body.sessions.find((x) => x.id === 'crashed')!;
    assert.equal(crashed.recovered, 'history-only');
    assert.equal(crashed.closed, undefined);
    assert.equal(crashed.oldestSeq, 1);
    assert.equal(typeof body.recoveryErrors, 'number', 'with tokens configured, only a count of recovery errors');
    c.close();
  } finally {
    await h.close();
  }
});

test('tsg-16: terminal/sessions lists sessions outside tools/call and pushes registry changes to a watcher', async () => {
  const h = await start();
  try {
    const gui = await Client.open(h.port, {}, { origin: `http://127.0.0.1:${h.port}` });
    const r = (await gui.request('terminal/sessions', { watch: true })) as { sessions: unknown[]; watching: boolean };
    assert.deepEqual(r, { sessions: [], watching: true });
    const a = await Client.open(h.port);
    await a.call('session_open', { session: 'pushed' });
    const note = await gui.next((m) => m.method === 'terminal/sessionsChanged');
    assert.deepEqual(note.params, { type: 'created', session: 'pushed' });
    // Another principal's private session is announced without its name (G18).
    const b = await Client.open(h.port, { token: 'tb' });
    await b.call('session_open', { session: 'b-private' });
    const hidden = await gui.next((m) => m.method === 'terminal/sessionsChanged');
    assert.deepEqual(hidden.params, { type: 'created' });
    b.close();
    assert.equal(h.usage.filter((u) => u.host === 'native').length, 0, 'the list is not usage');
    gui.close();
    a.close();
  } finally {
    await h.close();
  }
});

test('atc-4/atc-18/tsg-15: usage records never digest sensitive input, key digests per daemon run, and bound client strings', async () => {
  const h = await start();
  const h2 = await start();
  try {
    const c = await Client.open(h.port, { profile: 'full' });
    await c.call('session_open', { session: 'pin' });
    await c.call('input', { session: 'pin', text: '4821', keys: ['Enter'], sensitive: true });
    await c.call('input', { session: 'pin', text: 'ls' });
    const ctor = await c.call('constructor', {});
    assert.equal(ctor.isError, true);
    await c.call('x'.repeat(3_000_000), {});
    const [pin, ls, unknown, huge] = h.usage.filter((u) => u.tool !== 'session_open');
    assert.equal(pin!.sensitive, true);
    assert.equal(pin!.digest, undefined, 'no digest of sensitive input, keyed or not');
    assert.match(ls!.digest ?? '', /^[0-9a-f]{16}$/);
    assert.equal(unknown!.tool, '(unknown)');
    assert.equal(unknown!.requested, 'constructor');
    assert.equal(huge!.tool, '(unknown)');
    assert.ok(JSON.stringify(huge).length < 1000, `a huge name writes a small record (${JSON.stringify(huge).length} bytes)`);
    // The same text on another daemon run digests differently: the key never leaves memory.
    const c2 = await Client.open(h2.port, { profile: 'full' });
    await c2.call('session_open', { session: 'pin' });
    await c2.call('input', { session: 'pin', text: 'ls' });
    const other = h2.usage.find((u) => u.tool === 'input')!;
    assert.notEqual(other.digest, ls!.digest);
    c.close();
    c2.close();
  } finally {
    await h.close();
    await h2.close();
  }
});

test('tsg-12: on a loopback bind the loopback names are served on any port (port forwards); a refused Host is told about --allow-host', async () => {
  const h = await start();
  try {
    const p = h.port;
    for (const fwd of [`127.0.0.1:${p + 1}`, `localhost:13101`, `[::1]:2222`]) assert.equal((await httpGet(p, '/health', { Host: fwd })).status, 200, fwd);
    const up = await tryUpgrade(`ws://127.0.0.1:${p}/?token=ta`, { headers: { Host: '127.0.0.1:13101' } });
    assert.ok('ws' in up, 'an upgrade through a port-changing forward');
    up.ws.close();
    const refused = await httpGet(p, '/health', { Host: 'devbox.example:13101' });
    assert.equal(refused.status, 421);
    assert.match(refused.body, /--allow-host/);
  } finally {
    await h.close();
  }
});
