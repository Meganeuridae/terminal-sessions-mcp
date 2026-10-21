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
import { isSessionId, SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import type { ScriptedBackend, ScriptedPty } from '../src/backends/scripted.js';
import type { JournalEvent } from '../src/core/types.js';
import { Journal } from '../src/core/journal.js';
import { MemoryStore } from '../src/core/stores.js';
import { Follower } from '../src/transport/follower.js';
import { TermServer, type LogRecord, type ServerOptions, type UsageRecord } from '../src/transport/server.js';
import { McplLane } from '../src/transport/mcpl.js';
import { fakeShellBackend } from './fake-shell.js';
import { sleep, until } from './testhost.js';

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
  const backend = fakeShellBackend((sh) => {
    sh.on('echo hello', () => ({ output: 'hello\r\n', exit: 0 }));
    sh.on(/^sleep/, () => ({ hang: true }));
  });
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
const conns = (s: TermServer) => (s as unknown as { conns: Set<{ id: string; ws: WebSocket; followers: Map<string, Follower>; attaching: Map<string, unknown>; inFlight: number }> }).conns;

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

/** A gate a test holds: the code under test awaits `reached()`, `entered` tells the test it got there, `release()` lets it go. */
function gated(): { entered: Promise<void>; reached(): Promise<void>; release(): void } {
  let enter!: () => void;
  let open!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const gate = new Promise<void>((r) => (open = r));
  return {
    entered,
    reached: () => {
      enter();
      return gate;
    },
    release: () => open(),
  };
}

/** Hold the next `settled()` of a screen behind a gate (one call only: a session close awaits it too). */
function holdSettled(screen: { settled(): Promise<void> }): ReturnType<typeof gated> {
  const gate = gated();
  const settled = screen.settled.bind(screen);
  screen.settled = () => {
    screen.settled = settled;
    return gate.reached().then(settled);
  };
  return gate;
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
      ['{"jsonrpc":"2.0","id":17,"method":"terminal/subscribe","params":{"session":"survivor","since":1000000}}', 17, -32602],
      ['{"jsonrpc":"2.0","id":18,"method":"terminal/attach","params":{"session":"survivor","role":"owner"}}', 18, -32602],
      [`{"jsonrpc":"2.0","id":19,"method":"terminal/detach","params":{"session":"${'n'.repeat(65)}"}}`, 19, -32602],
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
    // malformed or id-less responses are dropped, and so is one with an unusable id (the house's read
    // of 2f357bd, #22). Frames are handled in order, so once the ping after them is answered, any
    // answer to them would have arrived. Binary garbage is a parse error.
    const strays = () => c.inbound.filter((m) => m.method === undefined);
    assert.equal(strays().length, 0);
    for (const frame of ['{"jsonrpc":"2.0","id":99,"error":"boom"}', '{"jsonrpc":"2.0","id":98,"result":1}', '{"jsonrpc":"2.0","id":null,"error":{"code":1,"message":"x"}}', '{"result":{}}', '{"jsonrpc":"2.0","id":true,"result":1}', '{"jsonrpc":"2.0","id":{},"error":{"code":1,"message":"x"}}']) c.raw(frame);
    assert.deepEqual(await c.request('ping'), {});
    assert.deepEqual(strays(), [], 'no response-shaped frame was answered');
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
    const s = liveSession(h, 'hij');
    // The server has processed b's close once b's own attachment is gone; the seat is checked after that, not after a pause.
    await until(() => !s.listAttachments().some((x) => x.principal === 'agent:b@test'), 2000, "b's attachment to go with b's connection");
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

    const hist = (await c.request('terminal/attach', { session: 'past' })) as { snapshot: null; transcript: string; lastSeq: number; runs: Array<{ runId: string; state: string; exit: number; line: string; durationMs: number }> };
    assert.equal(hist.snapshot, null);
    assert.match(hist.transcript, /built ok/);
    assert.ok(hist.lastSeq >= 4);
    // The journaled duration (5 ms), not the wall clock's end minus start, which the one `ts` makes 0
    // (the house's read of the 33 commits, #22, comment 6307351372).
    assert.deepEqual(hist.runs.map((x) => [x.runId, x.state, x.exit, x.line, x.durationMs]), [['r1', 'exited', 0, 'make', 5]]);
    const forbidden = await Client.open(h.port, { token: 'tb' });
    await assert.rejects(forbidden.request('terminal/attach', { session: 'past' }), /forbidden/);
    c.close();
    forbidden.close();
    setup.close();
  } finally {
    await h.close();
  }
});

test('/health’s uptime and a tool call’s latency are elapsed times on the monotonic clock, which a wall-clock step moves in neither direction', async (t) => {
  // Both read Date.now (the house's read of the 33 commits, #22, comment 6307351372): a step back made
  // the uptime negative, a step forward added the step, and a step during a call made its latency in the
  // usage record negative. Neither the server nor the call can have taken an hour.
  const realNow = Date.now;
  let wall = (): number => realNow();
  t.mock.method(Date, 'now', () => wall());
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const uptime = async () => (JSON.parse((await httpGet(h.port, '/health')).body) as { uptimeMs: number }).uptimeMs;
    wall = () => realNow() - 3_600_000;
    const afterBack = await uptime();
    assert.ok(afterBack >= 0, `uptime after a step back: ${afterBack} ms`);
    wall = () => realNow() + 3_600_000;
    const afterForward = await uptime();
    assert.ok(afterForward < 3_600_000, `uptime after a step forward: ${afterForward} ms`);
    // Each read of the wall clock during the call is a second earlier than the one before.
    let reads = 0;
    wall = () => realNow() - 1000 * reads++;
    await c.call('session_list', {});
    wall = () => realNow();
    const rec = h.usage.at(-1)!;
    assert.equal(rec.tool, 'session_list');
    assert.ok(rec.ms >= 0, `the call's latency: ${rec.ms} ms`);
    c.close();
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

test('/health on a host that cannot open sessions says so, with the reason session_open refuses with, to every caller', async () => {
  // termd keeps serving history, the GUI and the lane without bash; /health answered "ok" with nothing
  // about it, and the startup warning is one line (the house's answers, #22 comment 6275033749).
  const h = await start();
  try {
    const reason = new NodePtyBackend({ bash: null }).processSupport();
    assert.ok(!reason.ok);
    Object.assign(h.backend, { processSupport: () => reason });
    type Health = { status: string; unsupported?: string };
    for (const q of ['/health', '/health?token=ta']) {
      const res = await fetch(`http://127.0.0.1:${h.port}${q}`);
      const body = (await res.json()) as Health;
      assert.deepEqual([res.status, body.status, body.unsupported], [200, 'degraded', reason.reason], q);
    }
    const a = await Client.open(h.port);
    await a.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const opened = await a.call('session_open', { session: 'nobash' });
    assert.equal(opened.isError, true);
    assert.ok(opened.text.includes(reason.reason), `the refusal carries the same reason: ${opened.text}`);
    a.close();
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
    // The snapshot waits for the emulator (output streaming); the client leaves while it waits. The
    // wait is a gate the test holds: it sees the attach reach it, closes the client, then lets it go.
    for (let i = 0; i < 5; i++) {
      const gate = holdSettled(s.screen);
      const c = await Client.open(h.port);
      c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'terminal/attach', params: { session: 'orph', role: 'auto' } }));
      await gate.entered;
      c.close();
      await c.closed;
      await until(() => conns(h.server).size === 1, 2000, 'the server to see the close');
      gate.release();
      await new Promise((r) => setImmediate(r)); // the attach resumes in microtasks once the gate opens
    }
    assert.deepEqual(s.listAttachments().filter((a) => a.principal === 'agent:a@test' && a.connectionId !== [...conns(h.server)][0]?.id).length, 0, 'no orphan attachments');
    assert.equal(s.currentController, null, 'the owner did not take the seat for a dead connection');

    // The same through the application layer: a session_open whose spawn outlives its connection.
    const ensure = h.registry.ensure.bind(h.registry);
    const spawnGate = gated();
    h.registry.ensure = (async (o: Parameters<typeof ensure>[0]) => {
      await spawnGate.reached();
      return ensure(o);
    }) as typeof h.registry.ensure;
    const c = await Client.open(h.port);
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_open', arguments: { session: 'orph2' } } }));
    await spawnGate.entered;
    c.close();
    await c.closed;
    spawnGate.release();
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
    await c.call('session_open', { session: 'nf', visibility: 'shared' });
    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'run', arguments: { session: 'nf2', command: 'echo hello' } } }));
    // Another principal's attach, as a notification: had it run, it would be a second attachment.
    const b = await Client.open(h.port, { token: 'tb' });
    b.raw(JSON.stringify({ jsonrpc: '2.0', method: 'terminal/attach', params: { session: 'nf' } }));
    assert.deepEqual(await c.request('ping'), {});
    assert.deepEqual(await b.request('ping'), {});
    await sleep(50);
    assert.equal(h.registry.get('nf2'), undefined, 'the notification-form run did not execute');
    assert.equal(h.usage.filter((u) => u.session === 'nf2').length, 0);
    assert.deepEqual(liveSession(h, 'nf').listAttachments().map((a) => a.principal), ['agent:a@test'], 'only the session_open attachment');
    assert.equal(h.logs.filter((l) => l.msg === 'dropped a notification-form request (it needs an id)').length, 2);
    b.close();
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
  let gate: ReturnType<typeof gated> | undefined;
  def.run = async (ctx, a) => {
    await gate?.reached();
    return { ...(await original(ctx, a)), onSent: () => void sent++ };
  };
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_list', {});
    await until(() => sent === 1, 1000, 'onSent');
    await sleep(50);
    assert.equal(sent, 1, 'exactly once');
    // The call is held until the connection is gone; its slot is released when the write is skipped (2f357bd, #22).
    gate = gated();
    const conn = [...conns(h.server)][0]!;
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'session_list', arguments: {} } }));
    await gate.entered;
    assert.equal(conn.inFlight, 1);
    c.ws.terminate();
    await until(() => conns(h.server).size === 0, 2000, 'the server to see the close');
    gate.release();
    await until(() => conn.inFlight === 0, 2000, 'the held call to finish');
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

test("log-1: the log says where each connection's tools come from — the profile for a plain MCP host, the grant for an MCPL host — and warns when no grant arrives", async () => {
  const warnWas = McplLane.grantWarnMs;
  McplLane.grantWarnMs = 60;
  const h = await start();
  const mcpl = { experimental: { mcpl: { version: '0.5', pushEvents: true, contextHooks: { beforeInference: true }, channels: { register: true, publish: true, incoming: true, lifecycle: true }, featureSets: true } } };
  const init = (c: Client, capabilities: unknown) => c.request('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'spec', version: '0' } });
  const since = (n: number) => h.logs.slice(n);
  try {
    // A plain MCP host: the profile, and how many tools it comes to.
    let n = h.logs.length;
    const plain = await Client.open(h.port, { profile: 'full', connection: 'plain' });
    await init(plain, {});
    const opened = since(n).find((r) => r.msg === 'connection opened')!;
    assert.ok(opened && !('profile' in opened), 'the open line names no profile: whether one applies is known only at initialize');
    const plainInit = since(n).find((r) => String(r.msg).startsWith('initialized'))!;
    assert.deepEqual([plainInit.msg, plainInit.profile, plainInit.tools, plainInit.kind], ['initialized: a plain MCP host; the profile decides its tools', 'full', 20, 'mcp']);
    // An MCPL host: no profile, even one asked for in the URL; the grant decides, and the log says what it came to.
    n = h.logs.length;
    const host = await Client.open(h.port, { profile: 'full', connection: 'mcpl-host' });
    await init(host, mcpl);
    const hostInit = since(n).find((r) => String(r.msg).startsWith('initialized'))!;
    assert.equal(hostInit.msg, 'initialized: an MCPL host; its grant (featureSets/update) decides its tools and deliveries, the core tools until it arrives');
    assert.ok(!('profile' in hostInit) && hostInit.kind === 'mcpl');
    // The recipe's four sets asked for, but channels.publish not granted: annotate is not enabled, and the log says why.
    await host.request('featureSets/update', {
      effectiveCapabilities: ['tools', 'pushEvents', 'contextHooks.beforeInference.inject.beforeUser'],
      enabled: ['terminal.core', 'terminal.live', 'terminal.presence', 'terminal.annotate'],
    });
    const grant = since(n).find((r) => String(r.msg).startsWith('grant received'))!;
    assert.equal(grant.level, 'info');
    assert.match(String(grant.msg), /^grant received: 10 tools; enabled terminal\.core, terminal\.live, terminal\.presence; not enabled: /);
    assert.match(String(grant.msg), /terminal\.annotate \(missing channels\.publish\)/);
    assert.match(String(grant.msg), /terminal\.control \(not enabled by the host\)/);
    const tools = (await host.request('tools/list', {})) as { tools: Array<{ name: string }> };
    assert.equal(tools.tools.length, 10, 'the profile in the URL changed nothing for the MCPL host');
    // An MCPL host that never sends its grant: a warning, once, after the grace; a plain host gets none.
    n = h.logs.length;
    const silent = await Client.open(h.port, { connection: 'silent' });
    await init(silent, mcpl);
    await sleep(200);
    const warns = since(n).filter((r) => r.level === 'warn');
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]!.msg), /^no featureSets\/update from the host 60 ms after initialize: serving the core tools only/);
    assert.equal(warns[0]!.connection, (since(n).find((r) => r.msg === 'connection opened')!).connection);
    n = h.logs.length;
    const late = await Client.open(h.port, { connection: 'late' });
    // The grant follows the initialize in the same write, so no round trip has to fit inside the 60 ms grace.
    const lateInit = init(late, mcpl);
    const lateGrant = late.request('featureSets/update', { effectiveCapabilities: ['tools'] });
    await Promise.all([lateInit, lateGrant]);
    await sleep(200);
    assert.equal(since(n).filter((r) => r.level === 'warn').length, 0, 'a grant within the grace: no warning');
    assert.match(String(since(n).find((r) => String(r.msg).startsWith('grant received'))!.msg), /^grant received: 20 tools; enabled terminal\.core, terminal\.control, terminal\.services, terminal\.watch, terminal\.search; not enabled: terminal\.live \(missing pushEvents\)/);
    for (const c of [plain, host, silent, late]) c.close();
  } finally {
    McplLane.grantWarnMs = warnWas;
    await h.close();
  }
});

// ───────────────────────────── the house's read of 2f357bd (#22) ─────────────────────────────

function historyDir(dataDir: string, id: string, visibility: 'private' | 'shared', events: Array<Record<string, unknown>>): void {
  const dir = path.join(dataDir, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility }));
  const ts = Date.now();
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), events.map((e, i) => JSON.stringify({ seq: i + 1, ts, ...e })).join('\n') + '\n');
}

test('2f357bd-1 (G18): a subscriber to a shared session that is reopened private is cut off from the new life and told so', async () => {
  const h = await start();
  try {
    const a = await Client.open(h.port);
    await a.call('session_open', { session: 'vis', visibility: 'shared' });
    const b = await Client.open(h.port, { token: 'tb' });
    const closed = await a.call('session_close', { session: 'vis' });
    assert.equal(closed.isError, undefined, closed.text);
    const sub = (await b.request('terminal/subscribe', { session: 'vis', since: 0 })) as { lastSeq: number };
    await until(() => eventsOf(b, 'vis').length >= sub.lastSeq, 2000, 'the shared history');
    const old = sub.lastSeq;
    // The owner gives the name a new, private life.
    const reopened = await a.call('session_open', { session: 'vis', visibility: 'private' });
    assert.equal(reopened.structured.created, true, reopened.text);
    assert.equal((reopened.structured.info as { visibility: string }).visibility, 'private');
    const ended = await b.next((m) => m.method === 'terminal/closed');
    assert.deepEqual(ended.params, { session: 'vis', reason: 'forbidden' });
    const ran = await a.call('run', { session: 'vis', command: 'echo hello' });
    assert.equal(ran.structured.state, 'exited', ran.text);
    assert.deepEqual(await b.request('ping'), {});
    assert.deepEqual(eventsOf(b, 'vis').filter((e) => e.seq > old), [], 'nothing of the private life reached the former observer');
    await assert.rejects(b.request('terminal/subscribe', { session: 'vis' }), /forbidden/);
    assert.equal(((await b.request('terminal/sessions', {})) as { sessions: Array<{ id: string }> }).sessions.some((x) => x.id === 'vis'), false);
    a.close();
    b.close();
  } finally {
    await h.close();
  }
});

test('2f357bd-2: a detach naming a session that does not exist keeps nothing on the connection, and session names are bounded', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    for (let i = 0; i < 40; i++) assert.deepEqual(await c.request('terminal/detach', { session: `ghost-${i}` }), { session: `ghost-${i}`, detached: 0 });
    const conn = [...conns(h.server)][0]!;
    assert.equal(conn.attaching.size, 0, 'no per-session state outlives a detach');
    await assert.rejects(c.request('terminal/detach', { session: 'x'.repeat(65) }), /1 to 64 characters/);
    await c.call('session_open', { session: 'real' });
    await c.request('terminal/attach', { session: 'real' });
    assert.equal(conn.attaching.size, 0, 'an attach that answered waits no more');
    c.close();
  } finally {
    await h.close();
  }
});

test('2f357bd-3: a reply is in flight until written, so a client that stops reading is refused once the limit of replies waits for it, and the queue stays bounded', async () => {
  const LIMIT = 8;
  const HIGH = 64 * 1024;
  const h = await start({ maxInFlight: LIMIT, highWaterBytes: HIGH });
  try {
    const c = await Client.open(h.port, { profile: 'full' });
    await c.call('session_open', { session: 'deaf' });
    const s = liveSession(h, 'deaf');
    await c.request('terminal/subscribe', { session: 'deaf' });
    const conn = [...conns(h.server)][0]!;
    const one = JSON.stringify(await c.request('tools/list')).length;
    assert.ok(one > 10_000, `a tools/list reply is ${one} bytes`);
    // The client stops reading; a flood fills the kernel's buffers and pauses the follower at the high-water mark (as jr-15 shows).
    c.ws.pause();
    const chunk = 'y'.repeat(8 * 1024);
    for (let i = 0; i < 2500; i++) {
      s.journal.append({ type: 'note', text: `${i}:${chunk}`, principal: 'agent:a@test' });
      if (i % 100 === 0) await sleep(1);
    }
    assert.equal(conn.followers.get('deaf')!.state, 'paused');
    const base = conn.ws.bufferedAmount;
    // Now every reply waits on the socket: the limit of them, and a small refusal for each request past it.
    const N = 1500;
    for (let i = 0; i < N; i++) c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1000 + i, method: 'tools/list' }));
    await until(() => conn.inFlight === LIMIT, 3000, 'the limit of replies waiting on the socket');
    await sleep(300); // whatever frames are still being handled are refused with a small reply each
    assert.equal(conn.inFlight, LIMIT, 'no more than the limit is in flight while the client reads nothing');
    const queued = conn.ws.bufferedAmount - base;
    assert.ok(queued < LIMIT * one + N * 400, `queued ${queued} more bytes for ${N} requests whose replies would come to ${((N * one) / 1048576).toFixed(1)} MiB`);
    c.ws.resume();
    await until(() => conn.inFlight === 0, 15_000, 'the slots to go as the replies are written');
    assert.deepEqual(await c.request('ping'), {}, 'once the client reads again the connection serves it');
    const answered = c.inbound.filter((m) => typeof m.id === 'number' && m.id >= 1000);
    assert.equal(answered.length, N, 'every request was answered: a reply or a refusal');
    const refused = answered.filter((m) => m.error?.code === -32050);
    assert.ok(refused.length > 0 && refused.length < N, `${refused.length} refused`);
    assert.deepEqual(refused[0]!.error!.data, { limit: LIMIT, executed: false });
    assert.match(refused[0]!.error!.message, /not run/);
    c.close();
  } finally {
    await h.close();
  }
});

test('2f357bd-4: closing a session does not cut a paused subscriber off: it gets everything to the exit, then terminal/closed', async () => {
  const HIGH = 64 * 1024;
  const h = await start({ highWaterBytes: HIGH });
  try {
    const owner = await Client.open(h.port);
    await owner.call('session_open', { session: 'slowview' });
    const s = liveSession(h, 'slowview');
    const ownerConn = [...conns(h.server)][0]!;
    const viewer = await Client.open(h.port);
    await viewer.request('terminal/subscribe', { session: 'slowview' });
    const from = s.journal.lastSeq;
    viewer.ws.pause();
    const conn = [...conns(h.server)].find((x) => x !== ownerConn)!;
    const chunk = 'z'.repeat(8 * 1024);
    // Write until the follower pauses, not a fixed count: a host whose loopback socket buffers hold
    // megabytes stays `live` well past 400 chunks (3.2 MB on Linux), so the test's volume must follow
    // the backpressure, with a bound so a stream that never pauses fails rather than hangs (the house's
    // read of 78c4d6e, #22).
    const follower = conn.followers.get('slowview')!;
    // A pause is the socket's only once the loopback buffers are full: a burst of synchronous appends
    // queues frames the loop has not written yet, which pauses the follower for an instant and drains
    // without the viewer reading a byte, and a close in that instant found the stream already
    // delivered (CI's macOS runner on Node 24, and this machine under load). So at least 8 MiB goes
    // in first, more than the loopback buffers hold, and the pause must hold for 50 ms; the viewer is
    // paused, so a socket that is really full stays full.
    for (let i = 0; i < 20_000; i++) {
      s.journal.append({ type: 'note', text: `${i}:${chunk}`, principal: 'agent:a@test' });
      if (i >= 1024 && follower.state === 'paused') {
        await sleep(50);
        if (follower.state === 'paused') break;
      } else if (i % 100 === 0) await sleep(1);
    }
    assert.equal(follower.state, 'paused', 'the follower pauses once the socket and the high-water mark fill');
    const closed = await owner.call('session_close', { session: 'slowview' });
    assert.equal(closed.isError, undefined, closed.text);
    const hist = h.registry.get('slowview')!;
    assert.equal(hist.kind, 'history');
    const last = hist.kind === 'history' ? hist.lastSeq : -1;
    assert.equal(conn.followers.get('slowview'), follower, 'the stream is kept until it has delivered the end');
    assert.equal(follower.ending, true);
    viewer.ws.resume();
    const ended = await viewer.next((m) => m.method === 'terminal/closed', 15_000);
    assert.deepEqual(ended.params, { session: 'slowview', reason: 'session-closed' });
    const evs = eventsOf(viewer, 'slowview');
    assertContiguous(evs.map((e) => e.seq), from + 1, last, 'everything to the end, after the stall');
    assert.ok(evs.some((e) => e.type === 'session.exit'), 'the exit itself was streamed');
    assert.equal(conn.followers.has('slowview'), false);
    owner.close();
    viewer.close();
  } finally {
    await h.close();
  }
});

test('2f357bd-6: a history attach during which the name gets a new life answers with that life, and its events follow', async () => {
  const h = await start({ prepare: (dataDir) => historyDir(dataDir, 'reborn2', 'shared', [1, 2, 3].map((i) => ({ type: 'note', text: `old${i}`, principal: 'agent:a@test' }))) });
  try {
    const owner = await Client.open(h.port);
    const viewer = await Client.open(h.port, { token: 'tb' });
    const read = h.app.read.bind(h.app);
    const gate = gated();
    (h.app as { read: App['read'] }).read = (async (caller, o) => {
      await gate.reached();
      return read(caller, o);
    }) as App['read'];
    const attach = viewer.send('terminal/attach', { session: 'reborn2' });
    await gate.entered;
    const opened = await owner.call('session_open', { session: 'reborn2' });
    assert.equal(opened.structured.created, true, opened.text);
    gate.release();
    const r = (await attach).result as { snapshot: { seq: number } | null; role: string };
    assert.ok(r.snapshot, 'attached to the new life, not described by the old transcript');
    assert.equal(r.role, 'observer');
    const ran = await owner.call('run', { session: 'reborn2', command: 'echo hello' });
    assert.equal(ran.structured.state, 'exited', ran.text);
    const s = liveSession(h, 'reborn2');
    await until(() => eventsOf(viewer, 'reborn2').at(-1)?.seq === s.journal.lastSeq, 3000, "the new life's events");
    assert.ok(eventsOf(viewer, 'reborn2').some((e) => e.type === 'output' && e.data.includes('hello')));
    (h.app as { read: App['read'] }).read = read;
    owner.close();
    viewer.close();
  } finally {
    await h.close();
  }
});

test('2f357bd-7 (G13): an attach starts after the last event the snapshot covers, not at the last output, so notes after it are neither replayed nor reported as a gap', async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'notes' });
    const ran = await c.call('run', { session: 'notes', command: 'echo hello' });
    assert.equal(ran.structured.state, 'exited', ran.text);
    const s = liveSession(h, 'notes');
    await s.screen.settled();
    const lastOutput = s.screen.serialize().seq;
    for (let i = 0; i < 10; i++) s.journal.append({ type: 'note', text: `n${i}`, principal: 'agent:a@test' });
    const last = s.journal.lastSeq;
    assert.ok(lastOutput < last);
    for (let i = 0; i < 3; i++) {
      const r = (await c.request('terminal/attach', { session: 'notes' })) as { snapshot: { seq: number } };
      assert.equal(r.snapshot.seq, last, `attach ${i}: the snapshot reflects everything journaled before it`);
    }
    s.journal.append({ type: 'note', text: 'after', principal: 'agent:a@test' });
    await until(() => eventsOf(c, 'notes').some((e) => e.seq === last + 1), 2000, 'the next event');
    assert.deepEqual(eventsOf(c, 'notes').filter((e) => e.seq <= last), [], 'nothing the snapshot already covers is replayed');
    assert.equal(c.inbound.filter((m) => m.method === 'terminal/gap').length, 0);
    c.close();
  } finally {
    await h.close();
  }
});

test('2f357bd-8/9: an MCPL host is promised completion reports only as its grant allows, the watch tool says when it cannot be notified, and a grant that changes the tools sends tools/list_changed', async () => {
  const h = await start();
  const caps = { experimental: { mcpl: { version: '0.5', pushEvents: true, contextHooks: { beforeInference: true }, channels: { register: true, publish: true, incoming: true, lifecycle: true }, featureSets: true } } };
  const listChanged = (c: Client) => c.inbound.filter((m) => m.method === 'notifications/tools/list_changed').length;
  try {
    const host = await Client.open(h.port, { resultText: 'transcript' }); // the status line carries the watch tool's advice
    const init = (await host.request('initialize', { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 'spec', version: '0' } })) as { instructions: string; capabilities: { tools: { listChanged: boolean } } };
    assert.equal(init.capabilities.tools.listChanged, true);
    assert.match(init.instructions, /When your host grants terminal\.live push events, a command you started that outlives your wait is reported when it ends; otherwise `await` it/);
    assert.equal(((await host.request('tools/list', {})) as { tools: unknown[] }).tools.length, 10);
    // Tools only: the control, services, watch and search tiers come with it; push events do not.
    await host.request('featureSets/update', { effectiveCapabilities: ['tools'] });
    await host.next((m) => m.method === 'notifications/tools/list_changed');
    assert.equal(((await host.request('tools/list', {})) as { tools: unknown[] }).tools.length, 20);
    await host.call('session_open', { session: 'w1' });
    const w = await host.call('watch', { session: 'w1', pattern: 'never' });
    assert.equal(w.isError, undefined, w.text);
    assert.match(w.text, /cannot receive notifications/);
    // The same grant again changes no tool: nothing is announced. Push events granted: the watch tool promises delivery.
    await host.request('featureSets/update', { effectiveCapabilities: ['tools'] });
    await host.request('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'] });
    await sleep(50);
    assert.equal(listChanged(host), 0, 'the tool set did not change');
    const w2 = await host.call('watch', { session: 'w1', pattern: 'never2' });
    assert.doesNotMatch(w2.text, /cannot receive notifications/);
    // A grant that takes tools away announces that too.
    await host.request('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], enabled: ['terminal.core', 'terminal.live'] });
    await host.next((m) => m.method === 'notifications/tools/list_changed');
    assert.equal(((await host.request('tools/list', {})) as { tools: unknown[] }).tools.length, 10);
    // A plain MCP host: no grant, no deliveries; the instructions and the watch tool say so.
    const plain = await Client.open(h.port, { profile: 'full', resultText: 'transcript' });
    const pi = (await plain.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })) as { instructions: string };
    assert.match(pi.instructions, /Use `read` with the returned cursor/);
    await plain.call('session_open', { session: 'w2' });
    assert.match((await plain.call('watch', { session: 'w2', pattern: 'never' })).text, /cannot receive notifications/);
    host.close();
    plain.close();
  } finally {
    await h.close();
  }
});

test("2f357bd-10: an attach snapshot carries the screen's damage count when output was dropped under pressure", async () => {
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'dmg' });
    const s = liveSession(h, 'dmg');
    const clean = (await c.request('terminal/attach', { session: 'dmg' })) as { snapshot: Record<string, unknown> };
    assert.equal('droppedUnits' in clean.snapshot, false, 'an undamaged screen says nothing');
    (s.screen as unknown as { dropped: number }).dropped = 7; // what compaction leaves behind
    assert.equal(s.screen.snapshot().droppedUnits, 7);
    const damaged = (await c.request('terminal/attach', { session: 'dmg' })) as { snapshot: { droppedUnits?: number } };
    assert.equal(damaged.snapshot.droppedUnits, 7);
    c.close();
  } finally {
    await h.close();
  }
});

test('2f357bd smaller: a history attach says when its transcript was cut; a close frame without a status code is still a close on purpose', async () => {
  const h = await start({
    prepare: (dataDir) => {
      historyDir(dataDir, 'long', 'private', Array.from({ length: 4000 }, (_, i) => ({ type: 'output', data: `line ${i + 1}\r\n`, stream: 'pty' })));
      historyDir(dataDir, 'short', 'private', [{ type: 'output', data: 'only line\r\n', stream: 'pty' }]);
    },
  });
  try {
    const c = await Client.open(h.port);
    const cut = (await c.request('terminal/attach', { session: 'long' })) as { transcript: string; truncated: boolean };
    assert.equal(cut.truncated, true, 'the response says the transcript does not start where the history does');
    assert.ok(cut.transcript.split('\n').length <= 3000);
    assert.match(cut.transcript, /line 4000/);
    assert.doesNotMatch(cut.transcript, /\bline 500\b/);
    const whole = (await c.request('terminal/attach', { session: 'short' })) as { transcript: string; truncated: boolean };
    assert.equal(whole.truncated, false);
    assert.match(whole.transcript, /only line/);
    // ws.close() with no code arrives as 1005: the seat is given up at once, as after 1000.
    const owner = await Client.open(h.port, { profile: 'full' });
    await owner.call('session_open', { session: 'seat5', visibility: 'shared' });
    await owner.call('control', { session: 'seat5', action: 'release' });
    const b = await Client.open(h.port, { token: 'tb' });
    assert.equal(((await b.request('terminal/attach', { session: 'seat5', role: 'controller' })) as { role: string }).role, 'controller');
    const s = liveSession(h, 'seat5');
    b.ws.close(); // no status code
    await until(() => !s.listAttachments().some((a) => a.principal === 'agent:b@test'), 2000, "b's attachment to go");
    assert.equal(s.currentController, null);
    assert.equal(s.info().seatReservedUntil, undefined, 'a close frame without a code is a close on purpose, not a drop');
    assert.ok(h.logs.some((l) => l.msg === 'connection closed' && l.code === 1005));
    c.close();
    owner.close();
  } finally {
    await h.close();
  }
});

test("2f357bd paths: a detach while an attach waits on the screen supersedes it; a session closed while it waits attaches to the history instead", async () => {
  const h = await start();
  try {
    const owner = await Client.open(h.port);
    await owner.call('session_open', { session: 'waitd', visibility: 'shared' });
    const s = liveSession(h, 'waitd');
    const ownerConn = [...conns(h.server)][0]!;
    const c = await Client.open(h.port, { token: 'tb' });
    const conn = [...conns(h.server)].find((x) => x !== ownerConn)!;
    let gate = holdSettled(s.screen);
    const attach = c.send('terminal/attach', { session: 'waitd' });
    await gate.entered;
    assert.equal(conn.attaching.size, 1, 'the wait is registered while it lasts');
    assert.deepEqual(await c.request('terminal/detach', { session: 'waitd' }), { session: 'waitd', detached: 0 });
    gate.release();
    const r = await attach;
    assert.equal(r.error?.code, -32600, JSON.stringify(r));
    assert.match(r.error!.message, /superseded by terminal\/detach/);
    assert.equal(s.listAttachments().some((a) => a.connectionId === conn.id), false, 'nothing attached after the detach');
    assert.equal(conn.attaching.size, 0);
    // Closed while the screen settles: what the name is now is its history, and that is what attaches.
    gate = holdSettled(s.screen);
    const attach2 = c.send('terminal/attach', { session: 'waitd' });
    await gate.entered;
    const closed = await owner.call('session_close', { session: 'waitd' });
    assert.equal(closed.isError, undefined, closed.text);
    gate.release();
    const r2 = (await attach2).result as { snapshot: unknown; transcript: string; info: { closed?: boolean } };
    assert.equal(r2.snapshot, null, JSON.stringify(r2));
    assert.equal(typeof r2.transcript, 'string');
    assert.equal(r2.info.closed, true);
    assert.equal(conn.attaching.size, 0);
    c.close();
    owner.close();
  } finally {
    await h.close();
  }
});

test('2f357bd paths: a notification over the in-flight bound is dropped and logged; unsubscribe ends the stream; a subscribe is refused for a session the principal may not observe; a positive cursor replays from there', async () => {
  const h = await start({ maxInFlight: 1 });
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'p1' });
    const s = liveSession(h, 'p1');
    for (let i = 0; i < 5; i++) s.journal.append({ type: 'note', text: `n${i}`, principal: 'agent:a@test' });
    const last = s.journal.lastSeq;
    const sub = (await c.request('terminal/subscribe', { session: 'p1', since: last - 2 })) as { nextCursor: number; live: boolean; gap: null };
    assert.deepEqual([sub.nextCursor, sub.live, sub.gap], [last, true, null]);
    await until(() => eventsOf(c, 'p1').length >= 2, 2000, 'the replay');
    assertContiguous(eventsOf(c, 'p1').map((e) => e.seq), last - 1, last, 'from the cursor');
    s.journal.append({ type: 'note', text: 'live', principal: 'agent:a@test' });
    await c.request('ping'); // the event went out before the ping was even sent
    assert.equal(eventsOf(c, 'p1').at(-1)?.seq, last + 1);
    assert.deepEqual(await c.request('terminal/unsubscribe', { session: 'p1' }), {});
    s.journal.append({ type: 'note', text: 'unheard', principal: 'agent:a@test' });
    await c.request('ping');
    assert.equal(eventsOf(c, 'p1').at(-1)?.seq, last + 1, 'nothing after the unsubscribe');
    const conn = [...conns(h.server)][0]!;
    assert.equal(conn.followers.size, 0);
    // One call in flight is the limit: a notification arriving then is dropped, and the log says so.
    const r = await c.call('run', { session: 'p1', command: 'sleep 9', wait: 0 });
    const held = c.send('tools/call', { name: 'await', arguments: { session: 'p1', runId: r.structured.runId, wait: 300 } });
    await until(() => conn.inFlight === 1, 1000, 'the held call');
    c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await until(() => h.logs.some((l) => l.msg === 'dropped a notification: too much in flight'), 1000, 'the drop to be logged');
    const dropped = h.logs.find((l) => l.msg === 'dropped a notification: too much in flight')!;
    assert.deepEqual([dropped.method, dropped.limit], ['notifications/initialized', 1]);
    await held;
    // Another principal may not observe a private session: the subscribe is refused, as the attach is.
    const b = await Client.open(h.port, { token: 'tb' });
    await assert.rejects(b.request('terminal/subscribe', { session: 'p1' }), /forbidden: agent:b@test may not observe session p1/);
    await assert.rejects(b.request('terminal/subscribe', { session: 'nope' }), /session_not_found/);
    b.close();
    c.close();
  } finally {
    await h.close();
  }
});

test('2f357bd paths: a journal that fails to read ends the subscription visibly (an error on subscribe, terminal/closed on a resume); the daemon-wide connection bound answers 503', async () => {
  const HIGH = 64 * 1024;
  const h = await start({ highWaterBytes: HIGH, maxConnections: 3, maxConnectionsPerPrincipal: 2 });
  try {
    const c = await Client.open(h.port);
    await c.call('session_open', { session: 'eio' });
    const s = liveSession(h, 'eio');
    const since = s.journal.since.bind(s.journal);
    let failing = false;
    (s.journal as { since: typeof since }).since = (cursor, limit) => {
      if (failing) throw new Error('EIO: read failed');
      return since(cursor, limit);
    };
    failing = true;
    const bad = await c.send('terminal/subscribe', { session: 'eio', since: 0 });
    assert.equal(bad.error?.code, -32603, JSON.stringify(bad));
    assert.match(bad.error!.message, /EIO/);
    const conn = [...conns(h.server)][0]!;
    assert.equal(conn.followers.size, 0, 'a subscription that could not start is not kept');
    failing = false;
    await c.request('terminal/subscribe', { session: 'eio' });
    c.ws.pause();
    const chunk = 'q'.repeat(8 * 1024);
    // The client reads nothing, but the kernel's loopback buffers absorb megabytes before the server's own
    // buffer grows past the high water (far more on Linux than on macOS): write until the follower pauses.
    const follower = conn.followers.get('eio')!;
    for (let i = 0; i < 8000 && follower.state !== 'paused'; i++) {
      s.journal.append({ type: 'note', text: `${i}:${chunk}`, principal: 'agent:a@test' });
      if (i % 50 === 0) await sleep(1);
    }
    assert.equal(follower.state, 'paused');
    failing = true;
    c.ws.resume();
    const ended = await c.next((m) => m.method === 'terminal/closed', 5000);
    assert.deepEqual(ended.params, { session: 'eio', reason: 'error' });
    assert.equal(conn.followers.has('eio'), false);
    assert.ok(h.logs.some((l) => l.msg === 'journal read failed; subscription ended' && l.session === 'eio'));
    // Three connections in all: the fourth is refused with 503, whoever it is.
    const c2 = await Client.open(h.port, { token: 'tb' });
    const c3 = await Client.open(h.port, { token: 'th' });
    assert.deepEqual(await tryUpgrade(`ws://127.0.0.1:${h.port}/?token=tb`), { status: 503 });
    assert.ok(h.logs.some((l) => l.msg === 'upgrade refused: too many connections'));
    c3.close();
    await until(() => conns(h.server).size === 2, 2000, 'a slot to free');
    const c4 = await Client.open(h.port, { token: 'tb' });
    c4.close();
    c2.close();
    c.close();
  } finally {
    await h.close();
  }
});

// ───────────── the house's read of 78c4d6e (#22): names, removal, the deferred history attach ─────────────

test('78c4d6e: isSessionId’s alphabet is checked, not only the length, and the endpoint refuses a bad name', async () => {
  // The alphabet: a letter or digit first, then letters, digits, dot, underscore or dash, 1–64 in all.
  assert.equal(isSessionId('a'), true);
  assert.equal(isSessionId('A0.b_c-d'), true);
  assert.equal(isSessionId('x'.repeat(64)), true);
  assert.equal(isSessionId('x'.repeat(65)), false, 'over 64');
  assert.equal(isSessionId(''), false, 'empty');
  assert.equal(isSessionId('.hidden'), false, 'a leading dot is not alphanumeric');
  assert.equal(isSessionId('-lead'), false, 'a leading dash is not alphanumeric');
  assert.equal(isSessionId('has space'), false);
  assert.equal(isSessionId('has/slash'), false);
  assert.equal(isSessionId('bell\u0007'), false);
  const h = await start();
  try {
    const c = await Client.open(h.port);
    await assert.rejects(c.request('terminal/detach', { session: 'has/slash' }), /letters, digits/);
    await assert.rejects(c.request('terminal/subscribe', { session: '.hidden' }), /letters, digits/);
    c.close();
  } finally {
    await h.close();
  }
});

test('78c4d6e: a subscribed history session that is forgotten drives terminal/closed with reason session-removed (the GUI keys on it)', async () => {
  const h = await start({ prepare: (dataDir) => historyDir(dataDir, 'rmhist', 'shared', [1, 2, 3].map((i) => ({ type: 'note', text: `h${i}`, principal: 'agent:a@test' }))) });
  try {
    const c = await Client.open(h.port);
    await c.request('terminal/subscribe', { session: 'rmhist', since: 0 });
    assert.equal(h.registry.get('rmhist')?.kind, 'history');
    await h.registry.remove('rmhist');
    const note = await c.next((m) => m.method === 'terminal/closed', 3000);
    assert.deepEqual(note.params, { session: 'rmhist', reason: 'session-removed' });
    c.close();
  } finally {
    await h.close();
  }
});

test('78c4d6e 5: a history attach advances the read cursor on the write, not before — a reply that never reaches the client moves nothing', async () => {
  const h = await start({ prepare: (dataDir) => historyDir(dataDir, 'hcursor', 'shared', [1, 2, 3, 4, 5].map((i) => ({ type: 'output', data: `line ${i}\r\n`, stream: 'pty' }))) });
  try {
    const hist = h.registry.get('hcursor');
    assert.ok(hist?.kind === 'history');
    const read = () => hist.cursorsOf('agent:b@test').read;
    assert.equal(read(), 0, 'tb has read nothing of this history yet');
    const viewer = await Client.open(h.port, { token: 'tb' });
    const r = (await viewer.request('terminal/attach', { session: 'hcursor' })) as { transcript: string };
    assert.match(r.transcript, /line 5/);
    // The response reached the client: its write ran the deferred commit, so the cursor is now advanced.
    await until(() => read() > 0, 3000, 'the cursor advances once the attach response is written');
    assert.ok(read() >= 5);
    viewer.close();
  } finally {
    await h.close();
  }
});
