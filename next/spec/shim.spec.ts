/**
 * The stdio shim as a process (tg-19): piped use gets every answer, a dropped
 * socket fails the requests in flight (never silently) and reconnects with the
 * host's state replayed — the state the daemon accepted, with the daemon's own
 * request ids kept apart per connection — requests that cannot reach a daemon
 * fail after a bound, and on loopback with nothing listening it starts termd
 * itself, unless a supervisor manages one for that port, and again when it dies.
 *
 * Two peers stand in for termd: the real server in-process (`daemon`), and a
 * scripted WebSocket peer (`peer`) that records every frame per connection, for
 * what only the wire shows. The shim's supervisor question (launchctl, systemctl)
 * is answered by stubs first on its PATH, so no unit of the host's decides a test.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { acquireDataDirLock } from '../src/core/lock.js';
import { TermServer } from '../src/transport/server.js';
import { FakeShell } from './fake-shell.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(here, '../src/shim/stdio.js');
const COMPAT = path.resolve(here, '../src/shim/compat.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-shim-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } };

interface Daemon {
  server: TermServer;
  registry: SessionRegistry;
  port: number;
  close(): Promise<void>;
}

let dirs = 0;
async function daemon(port = 0, registry?: SessionRegistry, tokens?: Record<string, string>): Promise<Daemon> {
  const backend = new ScriptedBackend();
  backend.onSpawnShell = (p) => {
    const sh = new FakeShell(p);
    sh.on(/^sleep/, () => ({ hang: true }));
    sh.on('echo hi', () => ({ output: 'hi\r\n', exit: 0 }));
    const kill = p.kill.bind(p);
    p.kill = (sig) => {
      kill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') p.exit({ exitCode: null, signal: sig });
    };
  };
  const reg = registry ?? new SessionRegistry({ dataDir: path.join(tmp, `d${++dirs}`), backend, defaultShell: '/bin/bash', noUserRc: true });
  const resolver = new TokenMapResolver(tokens ? { tokens } : { anonymous: 'token:local-test' });
  const server = new TermServer({ app: new App({ registry: reg, defaultWaitMs: 2000 }), resolver, host: '127.0.0.1', port, shutdownGraceMs: 200 });
  const bound = await server.listen();
  return {
    server,
    registry: reg,
    port: bound.port,
    async close() {
      await server.close();
      await reg.closeAll();
    },
  };
}

type Lane = { open: Set<string>; has(cap: string): boolean; grant: { disabledFeatureSets: string[] } };
const conns = (s: TermServer) => (s as unknown as { conns: Set<{ ws: WebSocket; initialized: boolean; label: string | undefined; inFlight: number; lane: Lane | null }> }).conns;
/** The MCPL lane of the daemon's one connection, or null. */
const laneOf = (d: Daemon): Lane | null => [...conns(d.server)][0]?.lane ?? null;

interface PeerConn {
  index: number;
  ws: WebSocket;
  frames: Msg[];
}
type Answer = { result: unknown } | { error: { code: number; message: string } } | undefined;
interface Peer {
  port: number;
  conns: PeerConn[];
  close(): Promise<void>;
}

/**
 * A scripted peer in termd's place: it records every frame per connection and answers each request
 * as `answer` says (undefined: never). The default answers every request with an empty result.
 */
async function peer(answer: (c: PeerConn, m: Msg) => Answer = () => ({ result: {} })): Promise<Peer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', r));
  const peerConns: PeerConn[] = [];
  wss.on('connection', (ws) => {
    const c: PeerConn = { index: peerConns.length, ws, frames: [] };
    peerConns.push(c);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      c.frames.push(m);
      if (m.method === undefined || m.id === undefined) return;
      const a = answer(c, m);
      if (a) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...a }));
    });
  });
  return {
    port: (wss.address() as net.AddressInfo).port,
    conns: peerConns,
    close: () =>
      new Promise((r) => {
        for (const c of peerConns) c.ws.terminate();
        wss.close(() => r());
      }),
  };
}

interface Shim {
  child: ChildProcess;
  out: Msg[];
  err: string[];
  send(m: unknown): void;
  end(): void;
  exited: Promise<number | null>;
  next(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>;
}

/** Every setting the shim reads, unset: the developer's own TSM_PROFILE or SESSION_SERVER_URL must not reach a test (the house's read of 4e37a11, #22). */
const CLEAN_ENV = {
  TSM_URL: '',
  TSM_TOKEN: '',
  TSM_PROFILE: '',
  TSM_RESULT_TEXT: '',
  TSM_DATA_DIR: '',
  TSM_CONNECT_TIMEOUT_MS: '',
  TSM_NO_SPAWN: '1',
  SESSION_SERVER_URL: '',
  SESSION_SERVER_HOST: '',
  SESSION_SERVER_PORT: '',
  SESSION_SERVER_TOKEN: '',
};
/** Every shim started, ended when the file is done, so a failed test leaves no child holding the runner open. */
const children = new Set<ChildProcess>();
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

function shim(env: NodeJS.ProcessEnv, argv: string[] = [SHIM], cwd?: string): Shim {
  const child = spawn(process.execPath, argv, { env: { ...process.env, ...CLEAN_ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
  children.add(child);
  const out: Msg[] = [];
  const err: string[] = [];
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) out.push(JSON.parse(line) as Msg);
    }
  });
  child.stderr!.on('data', (d: Buffer) => err.push(d.toString()));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    out,
    err,
    send: (m) => child.stdin!.write(JSON.stringify(m) + '\n'),
    end: () => child.stdin!.end(),
    exited,
    async next(pred, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const m = out.find(pred);
        if (m) return m;
        if (Date.now() > end) throw new Error(`no matching output within ${ms} ms; stdout=${JSON.stringify(out)} stderr=${err.join('')}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

/** Waits for `pred`; `what` names it in the timeout error, as a thunk where the state at the timeout matters. */
async function until(pred: () => boolean, ms: number, what: string | (() => string)): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const init = (id: number | string) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spec', version: '0' } } });
const initMcpl = (id: number | string) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: 'spec', version: '0' } } });
const byId = (id: number | string) => (m: Msg) => m.id === id && m.method === undefined;
/** The shim's exit code, or an error when it is still running after `ms`: a shim that should have exited must not hang the run. */
const exitWithin = (s: Shim, ms = 5000) => Promise.race([s.exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the shim did not exit within ${ms} ms; stderr=${s.err.join('')}`)), ms).unref())]);
const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const structured = (m: Msg) => (m.result as { structuredContent: Record<string, unknown> }).structuredContent;
/** No answer to a replayed request (id `tsm-shim:replay:N`) may reach the host. */
const noReplayedAnswer = (s: Shim) => s.out.every((m) => !String(m.id).startsWith('tsm-shim:replay:'));

test('tg-19: piped stdin that ends before the socket opens still gets every answer, then exit 0', async () => {
  const d = await daemon();
  try {
    const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
    s.send(init(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    s.send(call(3, 'run', { session: 'p1', command: 'echo hi' }));
    s.end();
    assert.equal(await s.exited, 0, s.err.join(''));
    assert.deepEqual(s.out.map((m) => m.id), [1, 2, 3]);
    assert.ok((s.out[1]!.result as { tools: unknown[] }).tools.length >= 9);
    assert.equal(structured(s.out[2]!).state, 'exited');
    assert.equal(conns(d.server).size === 0 || [...conns(d.server)].every((c) => c.label?.startsWith('shim-')), true);
  } finally {
    await d.close();
  }
});

test('atc-15: TSM_RESULT_TEXT reaches the daemon: a transcript where the default is JSON (the house\'s read of 4e37a11, #22)', async () => {
  const d = await daemon();
  try {
    const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}`, TSM_RESULT_TEXT: 'transcript' });
    s.send(init(1));
    s.send(call(2, 'run', { session: 'p2', command: 'echo hi' }));
    s.end();
    assert.equal(await s.exited, 0, s.err.join(''));
    const text = (s.out[1]!.result as { content: Array<{ text: string }> }).content[0]!.text;
    assert.throws(() => JSON.parse(text), `a transcript, not JSON: ${text}`);
    assert.match(text, /hi/);
  } finally {
    await d.close();
  }
});

test('tg-19: a dropped socket fails the requests in flight with -32000, then the shim reconnects with the host state replayed', async () => {
  const d = await daemon();
  try {
    const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
    s.send(init(1));
    await s.next(byId(1));
    s.send(call(2, 'run', { session: 'r1', command: 'sleep 30', wait: 10_000 }));
    // The daemon has the call (it is in flight on the connection) when the connection drops under it.
    await until(() => [...conns(d.server)].some((c) => c.inFlight > 0), 5000, 'the call to be in flight at the daemon');
    for (const c of conns(d.server)) c.ws.terminate();
    const failed = await s.next(byId(2));
    assert.equal(failed.error?.code, -32000);
    assert.match(failed.error?.message ?? '', /outcome is unknown/);
    // The next request goes over a new connection that was initialized for the host.
    s.send(call(3, 'session_list', {}));
    const listed = await s.next(byId(3));
    assert.ok(listed.result, JSON.stringify(listed));
    const now = [...conns(d.server)];
    assert.equal(now.length, 1);
    assert.equal(now[0]!.initialized, true, 'initialize was replayed on the new connection');
    assert.equal(s.out.filter((m) => m.id === 1).length, 1, 'the replayed initialize answer is swallowed');
    assert.ok(noReplayedAnswer(s), 'no replayed answer reached the host under its replay id');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    await d.close();
  }
});

test('tg-19: after a reconnect an MCPL host keeps its grant and its open channels (and not the ones it closed)', async () => {
  const d = await daemon();
  try {
    const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
    s.send(initMcpl(1));
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'featureSets/update', params: { effectiveCapabilities: ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish'] } });
    await s.next(byId(2));
    for (const [n, id] of [[3, 'ka'], [4, 'kb']] as const) {
      s.send(call(n, 'session_open', { session: id }));
      await s.next(byId(n));
    }
    s.send({ jsonrpc: '2.0', id: 5, method: 'channels/open', params: { address: { session: 'ka' } } });
    s.send({ jsonrpc: '2.0', id: 6, method: 'channels/open', params: { address: { session: 'kb' } } });
    const ka = (await s.next(byId(5))).result as { channel: { id: string } };
    const kb = (await s.next(byId(6))).result as { channel: { id: string } };
    s.send({ jsonrpc: '2.0', id: 7, method: 'channels/close', params: { channelId: kb.channel.id } });
    await s.next(byId(7));
    const first = laneOf(d);
    assert.deepEqual([...first!.open], [ka.channel.id]);
    for (const c of conns(d.server)) c.ws.terminate();
    await until(() => {
      const l = laneOf(d);
      return l !== null && l !== first && l.open.size > 0;
    }, 5000, 'the channel to be reopened on the new connection');
    assert.deepEqual([...laneOf(d)!.open], [ka.channel.id], 'the open channel is back; the closed one is not');
    assert.equal(laneOf(d)!.has('channels.lifecycle'), true, 'the grant was replayed');
    assert.equal(s.out.filter((m) => m.method === undefined && (m.id === 1 || m.id === 2 || m.id === 5)).length, 3, 'replayed answers are swallowed');
    assert.ok(noReplayedAnswer(s), 'no replayed answer reached the host under its replay id');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    await d.close();
  }
});

test("tg-19: the replay follows what the daemon accepted — not a channel closed before its open was answered, not one closed or a reduction made while the daemon was down, and every reduction past 255 (the house's read of 4e37a11, #22)", async () => {
  const first = await daemon();
  const { port, registry } = first;
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_CONNECT_TIMEOUT_MS: '300' });
  let second: Daemon | undefined;
  try {
    s.send(initMcpl(1));
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const caps = ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish'];
    s.send({ jsonrpc: '2.0', id: 2, method: 'featureSets/update', params: { effectiveCapabilities: caps } });
    assert.ok((await s.next(byId(2))).result, 'the grant is accepted');
    for (const [n, id] of [[3, 'ka'], [4, 'kb'], [5, 'kc']] as const) {
      s.send(call(n, 'session_open', { session: id }));
      await s.next(byId(n));
    }
    // ka stays open. kb is closed by a notification sent right behind its open, before the open is
    // answered (a host can: the channel's id is its session's). kc is closed while the daemon is down.
    s.send({ jsonrpc: '2.0', id: 6, method: 'channels/open', params: { address: { session: 'ka' } } });
    s.send({ jsonrpc: '2.0', id: 7, method: 'channels/open', params: { address: { session: 'kb' } } });
    s.send({ jsonrpc: '2.0', method: 'channels/close', params: { channelId: 'terminal:kb' } });
    s.send({ jsonrpc: '2.0', id: 8, method: 'channels/open', params: { address: { session: 'kc' } } });
    const ka = (await s.next(byId(6))).result as { channel: { id: string } };
    const kb = (await s.next(byId(7))).result as { channel: { id: string } };
    const kc = (await s.next(byId(8))).result as { channel: { id: string } };
    assert.equal(kb.channel.id, 'terminal:kb');
    // 300 reductions, each naming a feature set of its own, in bursts under the daemon's in-flight bound.
    for (let i = 1; i <= 300; i++) {
      s.send({ jsonrpc: '2.0', method: 'featureSets/update', params: { disabled: [`x${i}`] } });
      if (i % 100 === 0) {
        s.send({ jsonrpc: '2.0', id: 100 + i, method: 'ping' });
        await s.next(byId(100 + i));
      }
    }
    const lane1 = laneOf(first)!;
    assert.deepEqual([...lane1.open].sort(), [ka.channel.id, kc.channel.id].sort(), 'the daemon has ka and kc open');
    // The daemon goes away. The host closes kc and disables terminal.annotate, both as notifications,
    // and both wait out the queue; so does the ping behind them, which says so.
    await first.server.close();
    await until(() => s.err.join('').includes('ECONNREFUSED'), 5000, 'the shim to find the port refused');
    s.send({ jsonrpc: '2.0', method: 'channels/close', params: { channelId: kc.channel.id } });
    s.send({ jsonrpc: '2.0', method: 'featureSets/update', params: { disabled: ['terminal.annotate'] } });
    s.send({ jsonrpc: '2.0', id: 11, method: 'ping' });
    assert.equal((await s.next(byId(11))).error?.code, -32000, 'the queue expired');
    second = await daemon(port, registry);
    await until(() => {
      const l = laneOf(second!);
      return l !== null && l.open.size > 0;
    }, 8000, 'a channel to be reopened on the new connection');
    const lane2 = laneOf(second)!;
    assert.deepEqual([...lane2.open], [ka.channel.id], 'ka is back; kb (closed before its open was answered) and kc (closed while the daemon was down) are not');
    assert.equal(lane2.has('channels.lifecycle'), true, 'the grant was replayed');
    const disabled = lane2.grant.disabledFeatureSets;
    assert.equal(disabled.filter((n) => /^x\d+$/.test(n)).length, 300, 'every reduction since the grant is replayed');
    assert.ok(disabled.includes('terminal.annotate'), 'the reduction that expired unsent is replayed');
    assert.ok(noReplayedAnswer(s), 'no replayed answer reached the host');
    assert.doesNotMatch(s.err.join(''), /refused/, 'nothing replayed was refused');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    if (second) await second.close();
    else {
      await first.server.close().catch(() => undefined);
      await registry.closeAll();
    }
  }
});

test("tg-19: a grant the daemon refused by failing closed is replayed to fail closed again, with every refusal since the grant in order: after a reconnect the new connection has no more than the host was told — no tools, no channel — until the host grants anew (the house's read of the shim, #22 comment 6269349177; of the 38 commits, #22 comment 6274370651)", async () => {
  const d = await daemon();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
  const tools = async (id: number): Promise<number> => {
    s.send({ jsonrpc: '2.0', id, method: 'tools/list' });
    return ((await s.next(byId(id), 8000)).result as { tools: unknown[] }).tools.length;
  };
  try {
    s.send(initMcpl(1));
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const caps = ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish'];
    s.send({ jsonrpc: '2.0', id: 2, method: 'featureSets/update', params: { effectiveCapabilities: caps } });
    assert.ok((await s.next(byId(2))).result, 'the grant is accepted');
    s.send(call(3, 'session_open', { session: 'fc' }));
    await s.next(byId(3));
    s.send({ jsonrpc: '2.0', id: 4, method: 'channels/open', params: { address: { session: 'fc' } } });
    assert.ok((await s.next(byId(4))).result);
    // A grant whose lists overlap is malformed: the daemon fails the lane closed (§5.4) — no tools, no
    // deliveries until a valid grant — and refuses it. That is what the host was told.
    s.send({ jsonrpc: '2.0', id: 5, method: 'featureSets/update', params: { effectiveCapabilities: caps, deniedCapabilities: ['tools'] } });
    assert.ok((await s.next(byId(5))).error, 'the overlapping grant is refused');
    // A second refusal that leaves the lane as it is — params that are not an object, refused by the
    // frame classifier before dispatch, with nothing said about whether it ran — must not stand in for
    // the one that failed the lane closed (the house's read of the 38 commits, #22 comment 6274370651).
    s.send({ jsonrpc: '2.0', id: 55, method: 'featureSets/update', params: 'not an object' });
    const classifier = await s.next(byId(55));
    assert.equal(classifier.error?.code, -32602, JSON.stringify(classifier));
    assert.equal(classifier.error?.data, undefined, 'refused before dispatch: nothing says whether it ran');
    assert.equal(await tools(6), 0, 'the host was told: no tools');
    const first = laneOf(d)!;
    assert.equal(first.has('channels.lifecycle'), false, 'the daemon failed closed');
    for (const c of conns(d.server)) c.ws.terminate();
    // The replay: initialize, the accepted grant, then the refused one — refused again, as expected — then
    // the channel, refused under the failed-closed grant. The host believes the channel open; it is
    // not, and was not on the connection before either in any way that delivered.
    await until(() => s.err.join('').includes('as it was on the connection before'), 8000, 'the refused grant to be replayed');
    assert.equal(await tools(7), 0, 'the new connection has no more than the host was told');
    const second = laneOf(d)!;
    assert.notEqual(second, first);
    assert.equal(second.has('channels.lifecycle'), false, 'the lane failed closed again');
    assert.equal(second.open.size, 0, 'the channel is not open on it');
    assert.match(s.err.join(''), /replay of featureSets\/update refused \(-32602 .*overlap.*\), as it was on the connection before: the new connection is where the host was told it is/);
    assert.match(s.err.join(''), /replay of featureSets\/update refused \(-32602 params must be an object\), as it was on the connection before/);
    assert.equal(s.err.join('').match(/as it was on the connection before/g)?.length, 2, 'both refusals were replayed');
    assert.match(s.err.join(''), /replay of channels\/open for terminal:fc refused/);
    assert.ok(noReplayedAnswer(s));
    // The host grants anew: the tools are back and the channel opens; a later reconnect replays this
    // grant and not the refused one.
    s.send({ jsonrpc: '2.0', id: 8, method: 'featureSets/update', params: { effectiveCapabilities: caps } });
    assert.ok((await s.next(byId(8))).result, 'a valid grant is accepted');
    assert.ok((await tools(9)) > 0, 'the tools are back');
    s.send({ jsonrpc: '2.0', id: 10, method: 'channels/open', params: { address: { session: 'fc' } } });
    assert.ok((await s.next(byId(10))).result, 'the channel opens again');
    for (const c of conns(d.server)) c.ws.terminate();
    await until(() => {
      const l = laneOf(d);
      return l !== null && l !== second && l.open.size > 0;
    }, 8000, 'the channel to be reopened on the third connection');
    assert.equal(laneOf(d)!.has('channels.lifecycle'), true, 'the new grant was replayed');
    assert.equal(s.err.join('').match(/as it was on the connection before/g)?.length, 2, 'the refusals are not replayed once a later grant was accepted');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    await d.close();
  }
});

test("tg-19: a featureSets/update the daemon refused without running it (the in-flight bound: executed: false) is not replayed, so the new connection gets the accepted grant alone (the house's read of the 38 commits, #22 comment 6274370651)", async () => {
  const d = await daemon();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
  try {
    s.send(initMcpl(1));
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const narrow = ['tools', 'pushEvents', 'channels.register', 'channels.incoming', 'channels.publish'];
    s.send({ jsonrpc: '2.0', id: 2, method: 'featureSets/update', params: { effectiveCapabilities: narrow } });
    assert.ok((await s.next(byId(2))).result, 'the narrow grant is accepted');
    assert.equal(laneOf(d)!.has('channels.lifecycle'), false);
    // A Run that never ends, and 128 waits on it: the daemon's bound on requests in flight is full.
    s.send(call(3, 'run', { session: 'ov', command: 'sleep 30', wait: 100 }));
    const run = structured(await s.next(byId(3)));
    // Running, or still starting under load after the call's 100 ms: either way it never ends, so every wait on it stays in flight.
    assert.ok(['queued', 'starting', 'running'].includes(run.state as string), JSON.stringify(run));
    for (let i = 0; i < 128; i++) s.send(call(100 + i, 'await', { runId: run.runId, wait: 8000 }));
    await until(() => [...conns(d.server)].some((c) => c.inFlight >= 128), 10_000, 'the bound to be full');
    // A wider grant now is refused unrun — the daemon says so — and the lane is as it was.
    s.send({ jsonrpc: '2.0', id: 4, method: 'featureSets/update', params: { effectiveCapabilities: [...narrow, 'channels.lifecycle'] } });
    const refused = await s.next(byId(4));
    assert.equal(refused.error?.code, -32050, JSON.stringify(refused));
    assert.equal((refused.error?.data as { executed: boolean }).executed, false);
    const first = laneOf(d)!;
    assert.equal(first.has('channels.lifecycle'), false);
    for (const c of conns(d.server)) c.ws.terminate();
    // The waits fail with -32000 (their outcome is unknown). Once one has, the shim has seen the drop,
    // so the ping goes over the new connection: sent at once, it could reach the shim before the close
    // did and fail with the waits. The replay is initialize and the grant, nothing else: the refused
    // update, run afresh, would widen the lane past what the host was told.
    const dropped = await s.next(byId(100), 8000);
    assert.equal(dropped.error?.code, -32000, JSON.stringify(dropped));
    s.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    assert.deepEqual((await s.next(byId(5), 8000)).result, {});
    const second = laneOf(d)!;
    assert.notEqual(second, first);
    assert.equal(second.has('channels.lifecycle'), false, 'the unrun refusal was not replayed');
    assert.doesNotMatch(s.err.join(''), /replay of featureSets\/update/);
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    await d.close();
  }
});

test("tg-19: a replay longer than the daemon's bound on requests in flight (128) reopens every channel: it goes in windows, so nothing is refused as overloaded (the house's read of the shim, #22 comment 6269349177)", async () => {
  const d = await daemon();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
  try {
    s.send(initMcpl(1));
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'featureSets/update', params: { effectiveCapabilities: ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish'] } });
    assert.ok((await s.next(byId(2))).result);
    // More channels than the bound, with initialize and the grant on top. The sessions are made in the
    // registry, as the shim's principal owns them; the opens go in bursts under the bound.
    const N = 136;
    await Promise.all(Array.from({ length: N }, (_, i) => d.registry.create({ id: `w${i}`, owner: 'token:local-test' })));
    for (let i = 0; i < N; i += 32) {
      const ids = Array.from({ length: Math.min(32, N - i) }, (_, j) => 1000 + i + j);
      for (const id of ids) s.send({ jsonrpc: '2.0', id, method: 'channels/open', params: { address: { session: `w${id - 1000}` } } });
      for (const id of ids) assert.ok((await s.next(byId(id), 20_000)).result, `channel ${id} open`);
    }
    const first = laneOf(d)!;
    assert.equal(first.open.size, N);
    // From here the daemon answers each open after a pause, as a loaded one would: sent all at once,
    // the reopens would exceed the bound, and the daemon would refuse the rest.
    const srv = d.server as unknown as { dispatch: (conn: unknown, req: { method: string }, ...rest: unknown[]) => Promise<unknown> };
    const dispatch = srv.dispatch;
    srv.dispatch = async function (this: unknown, conn, req, ...rest) {
      if (req.method === 'channels/open') await new Promise((r) => setTimeout(r, 100));
      return dispatch.call(this, conn, req, ...rest);
    };
    for (const c of conns(d.server)) c.ws.terminate();
    await until(() => {
      const l = laneOf(d);
      return l !== null && l !== first && l.open.size === N;
    }, 20_000, () => `all ${N} channels to be reopened (${laneOf(d)?.open.size ?? 'none'} are); stderr=${s.err.join('')}`);
    assert.doesNotMatch(s.err.join(''), /refused|too many requests/, 'nothing replayed was refused');
    s.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    assert.deepEqual((await s.next(byId(3), 8000)).result, {}, 'the queue follows the replay');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    await d.close();
  }
});

test("tg-19: the host's answer to a request from a connection that is gone is dropped, never passed on as the answer to the new connection's request with the same id (the house's read of 4e37a11, #22)", async () => {
  // The peer asks the host something (its id 1, as the daemon's ids restart per connection) on each connection, once initialize is answered.
  const p = await peer((c, m) => {
    if (m.method === 'initialize') setImmediate(() => c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'push/event', params: { conn: c.index + 1 } })));
    return { result: {} };
  });
  const s = shim({ TSM_URL: `ws://127.0.0.1:${p.port}` });
  try {
    s.send(init(1));
    const askedFirst = await s.next((m) => m.method === 'push/event' && m.params?.conn === 1);
    p.conns[0]!.ws.terminate();
    const askedSecond = await s.next((m) => m.method === 'push/event' && m.params?.conn === 2);
    assert.notEqual(askedFirst.id, askedSecond.id, 'the two requests reach the host under ids of their own');
    // The host answers the old one first, then the new one.
    s.send({ jsonrpc: '2.0', id: askedFirst.id, result: { stale: true } });
    s.send({ jsonrpc: '2.0', id: askedSecond.id, result: { fresh: true } });
    const answers = () => p.conns[1]!.frames.filter((f) => f.method === undefined && f.id === 1);
    await until(() => answers().length > 0, 5000, 'an answer on the new connection');
    await new Promise((r) => setTimeout(r, 100)); // room for a second answer to arrive, were one passed on
    assert.deepEqual(answers().map((a) => a.result), [{ fresh: true }], "only the answer to the new connection's own request, under the daemon's id");
    assert.match(s.err.join(''), /dropped the host's answer to request/);
    s.end();
    await s.exited;
  } finally {
    s.child.kill();
    await p.close();
  }
});

test("tg-19: after a drop, the request in flight is failed and not resent, the replay goes before the queue, a reopened channel asks for no history, and a refused replay is said (the house's read of 4e37a11, #22)", async () => {
  const p = await peer((c, m) => {
    if (m.method === 'channels/open') return c.index === 0 ? { result: { channel: { id: 'terminal:k1' } } } : { error: { code: -32017, message: 'unknown channel terminal:k1' } };
    if (m.method === 'tools/call') return undefined; // never answered: in flight when the connection drops
    return { result: {} };
  });
  const s = shim({ TSM_URL: `ws://127.0.0.1:${p.port}` });
  try {
    s.send(init(1));
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', id: 2, method: 'channels/open', params: { address: { session: 'k1' }, history: { limit: 50 } } });
    await s.next(byId(2));
    s.send(call(3, 'run', { session: 'k1', command: 'sleep 9' }));
    await until(() => p.conns[0]!.frames.some((f) => f.id === 3), 5000, 'the call to reach the peer');
    p.conns[0]!.ws.terminate();
    const failed = await s.next(byId(3));
    assert.equal(failed.error?.code, -32000);
    s.send({ jsonrpc: '2.0', id: 4, method: 'ping' }); // queued until the new connection is in the host's state
    assert.deepEqual((await s.next(byId(4))).result, {});
    const frames = p.conns[1]!.frames;
    assert.deepEqual(frames.map((f) => f.method), ['initialize', 'channels/open', 'ping'], 'the replay, then the queue; the failed call is not resent');
    const reopen = frames[1]!;
    assert.match(String(reopen.id), /^tsm-shim:replay:/);
    assert.equal(reopen.params?.channelId, 'terminal:k1');
    assert.equal(reopen.params?.history, undefined, 'catch-up resumes from the delivered cursor, not from history');
    assert.match(s.err.join(''), /replay of channels\/open for terminal:k1 refused \(-32017 unknown channel terminal:k1\)/);
    assert.ok(noReplayedAnswer(s));
    s.end();
    await s.exited;
  } finally {
    s.child.kill();
    await p.close();
  }
});

/** A TCP server that accepts, reads and never answers: a stalled handshake. */
function silentServer(): Promise<{ port: number; accepted(): number; close(): void }> {
  const socks = new Set<net.Socket>();
  let accepted = 0;
  const srv = net.createServer((sock) => {
    accepted++;
    socks.add(sock);
    sock.on('data', () => undefined);
    sock.on('error', () => undefined);
    sock.on('close', () => socks.delete(sock));
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        accepted: () => accepted,
        close: () => {
          for (const s of socks) s.destroy();
          srv.close();
        },
      }),
    ),
  );
}

test("tg-19: a handshake the peer accepts but never answers is given up and tried again (the house's read of 4e37a11, #22)", async () => {
  const srv = await silentServer();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${srv.port}`, TSM_CONNECT_TIMEOUT_MS: '1200' });
  try {
    s.send(init(1));
    const failed = await s.next(byId(1), 5000);
    assert.equal(failed.error?.code, -32000);
    await until(() => srv.accepted() >= 2, 6000, 'a second handshake');
    assert.match(s.err.join(''), /handshake has timed out/i);
  } finally {
    s.child.kill();
    srv.close();
  }
});

test("tg-19: reconnects back off: each attempt waits at least half its delay after the one before, so attempts are bounded by the time elapsed (the house's read of 4e37a11, #22; of the 38 commits, #22 comment 6274935728)", async () => {
  // When each attempt reached the listener. A count after a fixed 1.5 s read a slow start or late
  // timers under load as a defect; load only lengthens the gaps.
  const at: number[] = [];
  const srv = net.createServer((sock) => {
    at.push(performance.now());
    sock.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const s = shim({ TSM_URL: `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, TSM_CONNECT_TIMEOUT_MS: '5000' });
  try {
    s.send(init(1));
    await until(() => at.length >= 4, 20_000, () => `four connection attempts (${at.length} so far)`);
    // The delays are 100, 200, 400 ms …, doubling to 5 s; without them attempts come a few ms apart.
    // Half the delay is the bound, since this process may see an attempt late and the next one on time.
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    const shown = gaps.map((g) => g.toFixed(0)).join(', ');
    gaps.forEach((g, i) => assert.ok(g >= Math.min(5000, 100 * 2 ** i) / 2, `attempt ${i + 2} came ${g.toFixed(0)} ms after the one before (gaps: ${shown} ms)`));
  } finally {
    s.child.kill();
    srv.close();
  }
});

test('tg-19: when the daemon goes away and comes back on the same port, queued requests are delivered', async () => {
  const first = await daemon();
  const port = first.port;
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}` });
  let second: Daemon | undefined;
  try {
    s.send(init(1));
    await s.next(byId(1));
    await first.close();
    // Once the shim has found the port refused, nothing it reads can go anywhere but its queue until a
    // reconnect succeeds, and the next attempt is a backoff away.
    await until(() => s.err.join('').includes('ECONNREFUSED'), 5000, 'the shim to find the port refused');
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    second = await daemon(port);
    const pong = await s.next(byId(2), 8000);
    assert.deepEqual(pong.result, {});
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    await second?.close();
  }
});

test("tg-19: a request that cannot reach any daemon fails after TSM_CONNECT_TIMEOUT_MS instead of hanging, with stdin still open; what expired is logged once, by count and method (the house's read of the shim, #22 comment 6269349177)", async () => {
  const port = await unusedPort();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_CONNECT_TIMEOUT_MS: '400' });
  s.send(init(7));
  // A notification and an answer to a (supposed) request of the daemon's wait with it: neither can be answered, so only the log can say they were dropped.
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', id: 'tsm-shim:1:n:1', result: {} });
  // stdin stays open: the bound is the setting's, not stdin's end (the house's read of 4e37a11, #22).
  const failed = await s.next(byId(7), 2000);
  assert.equal(failed.error?.code, -32000);
  assert.match(failed.error?.message ?? '', /cannot reach/);
  await until(() => /waited 400 ms for a connection/.test(s.err.join('')), 2000, 'the expiry line');
  assert.match(s.err.join(''), /waited 400 ms for a connection to ws:\/\/127\.0\.0\.1:\d+: 1 request answered with -32000, 1 notification dropped, 1 answer to the daemon's requests dropped \(initialize, notifications\/initialized\)/);
  s.end();
  await s.exited;
});

test("tg-19: the wait for a connection is on a monotonic clock: a wall-clock step after the request was queued does not stretch it (the house's read of 4e37a11, #22)", async () => {
  // The step is gated on the request having been queued, not on a delay: the preload's stdin listener
  // is added behind readline's, so it runs once the shim has handled the line (the house's read of the
  // shim, #22 comment 6269349177).
  const preload = path.join(tmp, 'clock-step.cjs');
  fs.writeFileSync(
    preload,
    [
      'const real = Date.now; let shift = 0; Date.now = () => real() - shift;',
      'const stdin = process.stdin; const on = stdin.on.bind(stdin); let hooked = false;',
      'stdin.on = stdin.addListener = function (ev, fn) {',
      '  const r = on(ev, fn);',
      "  if (ev === 'data' && !hooked) { hooked = true; on('data', () => { if (!shift) { shift = 3600_000; process.stderr.write('[clock-step] stepped back an hour after the line was read\\n'); } }); }",
      '  return r;',
      '};',
      '',
    ].join('\n'),
  );
  const port = await unusedPort();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_CONNECT_TIMEOUT_MS: '600' }, ['--require', preload, SHIM]);
  try {
    s.send(init(1));
    const failed = await s.next(byId(1), 3000);
    assert.equal(failed.error?.code, -32000);
    assert.match(s.err.join(''), /\[clock-step\] stepped back an hour after the line was read/, 'the step happened, after the request was queued');
  } finally {
    s.child.kill();
  }
});

test("tg-19: a profile that is none of core, full, compat, a --profile without its value, and a connect timeout that is not a duration are mistakes: said, exit 2 (the house's read of 4e37a11, #22; of the shim, #22 comment 6269721389)", async () => {
  const typo = shim({ TSM_PROFILE: 'comapt' });
  assert.equal(await exitWithin(typo), 2);
  assert.match(typo.err.join(''), /profile must be one of core, full, compat, not "comapt"/);
  const flag = shim({}, [SHIM, '--profile=comapt']);
  assert.equal(await exitWithin(flag), 2);
  // A trailing --profile is not a fallback to TSM_PROFILE or the invoked name: it is a mistake like the others.
  for (const env of [{}, { TSM_PROFILE: 'compat' }]) {
    const trailing = shim(env, [SHIM, '--profile']);
    assert.equal(await exitWithin(trailing), 2, JSON.stringify(env));
    assert.match(trailing.err.join(''), /--profile needs a value: one of core, full, compat/);
  }
  for (const bad of ['abc', 'Infinity', '-1', '1e3']) {
    const s = shim({ TSM_CONNECT_TIMEOUT_MS: bad });
    assert.equal(await exitWithin(s), 2, bad);
    assert.match(s.err.join(''), /TSM_CONNECT_TIMEOUT_MS must be a duration/);
  }
});

test("tg-19: --help (and -h) prints the settings and exits 0 before anything is read or started (the house's read of 4e37a11, #22)", async () => {
  const port = await unusedPort();
  const dir = path.join(tmp, 'spawn-help');
  for (const flag of ['--help', '-h']) {
    const text = execFileSync(process.execPath, [SHIM, flag], {
      encoding: 'utf8',
      env: { ...process.env, ...CLEAN_ENV, TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: dir, HOME: tmp, PATH: supervisorPath('none', port) },
    });
    for (const name of ['TSM_URL', 'TSM_TOKEN', 'TSM_PROFILE', 'TSM_RESULT_TEXT', 'TSM_CONNECT_TIMEOUT_MS', 'TSM_DATA_DIR', 'TSM_NO_SPAWN', 'SESSION_SERVER_URL', 'SESSION_SERVER_TOKEN']) assert.ok(text.includes(name), `${flag} names ${name}`);
    assert.match(text, /starts termd/);
  }
  assert.equal(fs.existsSync(dir), false, 'nothing was started');
});

/** A port nothing listens on: one the kernel just handed out and we released. */
function unusedPort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** The command line of a process, or '' when it is gone. */
function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The process group of a process, or '' when it is gone. */
function pgidOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Shell bodies that stand in for `launchctl print` (macOS) and `systemctl --user show` (Linux). */
interface Stub {
  launchctl: string;
  systemctl: string;
}

/** A unit as the shim reads it: termd's flags (`port: 'none'` leaves --port out), its environment, and whether it runs or is enabled to. */
interface Unit {
  port?: number | 'none';
  dataDir?: string;
  env?: Record<string, string>;
  active?: boolean;
  enabled?: boolean;
}

/** The two supervisors' answers for a loaded unit: a launchd job's `print` and a systemd unit's `show`, with the same command line and environment. */
function unitStub(u: Unit): Stub {
  const args = [...(u.port === 'none' ? [] : ['--port', String(u.port ?? 3101)]), ...(u.dataDir ? ['--data-dir', u.dataDir] : [])];
  const env = Object.entries(u.env ?? {});
  const q = (s: string) => `'${s}'`;
  const systemctl = [
    'LoadState=loaded',
    `ActiveState=${u.active === false ? 'inactive' : 'active'}`,
    `UnitFileState=${u.enabled ? 'enabled' : 'disabled'}`,
    // As systemd 255 prints them: the argv unquoted, an assignment with spaces in double quotes.
    `ExecStart={ path=/bin/sh ; argv[]=/bin/sh /pkg/next/config/termd-launch.sh ${args.join(' ')} ; ignore_errors=no }`,
    `Environment=${env.map(([k, v]) => (/\s/.test(v) ? `"${k}=${v}"` : `${k}=${v}`)).join(' ')}`,
  ];
  const launchctl = [
    'com.animalabs.termd = {',
    '\targuments = {',
    '\t\t/bin/sh',
    '\t\t/pkg/next/config/termd-launch.sh',
    ...args.map((a) => `\t\t${a}`),
    '\t}',
    '\tenvironment = {',
    ...env.map(([k, v]) => `\t\t${k} => ${v}`),
    '\t}',
    '}',
  ];
  return { launchctl: `printf '%s\\n' ${launchctl.map(q).join(' ')}`, systemctl: `printf '%s\\n' ${systemctl.map(q).join(' ')}` };
}

/** The answers that are not a loaded unit: nothing managed; a check that does not answer in time; a check that fails (systemctl without the user manager's bus, launchctl without a GUI domain, as over ssh). */
const STUBS: Record<'none' | 'slow' | 'failed', Stub> = {
  none: { launchctl: 'exit 113', systemctl: "printf 'LoadState=not-found\\nActiveState=inactive\\nUnitFileState=\\nExecStart=\\nEnvironment=\\n'" },
  slow: { launchctl: 'sleep 3; exit 113', systemctl: 'sleep 3' },
  failed: { launchctl: "echo 'Bad request.' >&2; echo 'Could not find domain for user gui: 501' >&2; exit 112", systemctl: "echo 'Failed to connect to bus: No medium found' >&2; exit 1" },
};
let stubDirs = 0;

/**
 * A PATH whose first directory answers the shim's supervisor question (launchctl on macOS, systemctl on
 * Linux) as `kind` says, so the host's own units never decide a test (the house's read of 4e37a11, #22):
 * `none` — nothing managed; `ours` — a unit running termd on `port` (not enabled, as a unit started by
 * hand is); `other` — a unit for another port with a data dir of its own; `slow` — a check that does not
 * answer in time; `failed` — a check that fails; or a `Stub` of the test's own.
 */
function supervisorPath(kind: keyof typeof STUBS | 'ours' | 'other' | Stub, port: number): string {
  const dir = path.join(tmp, `supervisor-${++stubDirs}`);
  fs.mkdirSync(dir, { recursive: true });
  const stub = typeof kind === 'object' ? kind : kind === 'ours' ? unitStub({ port }) : kind === 'other' ? unitStub({ port: 3101, dataDir: path.join(tmp, 'unit-data') }) : STUBS[kind];
  for (const [name, body] of [['launchctl', stub.launchctl], ['systemctl', stub.systemctl]] as const) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${dir}:${process.env.PATH ?? ''}`;
}

test("tg-19: on loopback with nothing listening the shim starts termd (unless TSM_NO_SPAWN=1), in $HOME/.tsm when TSM_DATA_DIR is empty, detached, and again when it dies (the house's read of 4e37a11, #22)", async () => {
  const port = await unusedPort();
  // TSM_DATA_DIR empty is unset: termd's files go to $HOME/.tsm, and termd is never given --data-dir '', which it refuses.
  const home = path.join(tmp, 'home-start');
  fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(home, '.tsm');
  // A supervisor's unit for another port is not in the way.
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: '', HOME: home, TSM_TOKEN: '', PATH: supervisorPath('other', port) });
  let pid = 0;
  try {
    s.send(init(1));
    const r = await s.next(byId(1), 15_000);
    assert.ok(r.result, JSON.stringify(r));
    assert.match(s.err.join(''), /serves port 3101 out of \S+unit-data, not \d+: a termd for \d+ is started here with \S+home-start\/\.tsm/);
    assert.match(s.err.join(''), /started termd/);
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { pid: number };
    // Only ever signal the termd this shim started: the one whose `listening` record is in the log the shim gave it, in our data dir.
    assert.ok(health.pid > 0 && health.pid !== process.pid && health.pid !== s.child.pid);
    assert.ok(spawnedPids(dataDir).includes(health.pid), `the daemon on :${port} is not the one the shim started: ${commandOf(health.pid)}; ours: ${spawnedPids(dataDir).join(' ')}`);
    assert.match(commandOf(health.pid), /^termd --port \d+$/, 'the title says termd and the port, and nothing a flag value could carry');
    assert.notEqual(pgidOf(health.pid), pgidOf(s.child.pid!), 'detached: a signal to the host’s process group never takes termd');
    pid = health.pid;
    assert.ok(fs.existsSync(path.join(dataDir, 'termd.log')));
    assert.ok(fs.existsSync(path.join(dataDir, 'termd.stderr.log')), "termd's stderr has a file of its own");
    // The termd dies. The next request finds the port refused, and termd is started again.
    process.kill(pid, 'SIGTERM');
    await until(() => commandOf(pid) === '', 5000, 'the first termd to exit');
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await s.next(byId(2), 20_000);
    assert.ok(listed.result, JSON.stringify(listed));
    const again = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { pid: number };
    assert.notEqual(again.pid, pid, 'a new termd');
    pid = again.pid;
    assert.equal(s.err.join('').match(/started termd/g)?.length, 2, s.err.join(''));
    // termd takes SIGTERM as a request to stop and exits 0; the shim says when it ended and how, and
    // quotes the end of its log where its stderr says nothing (the house's read of the shim, #22 comment 6269349177).
    assert.match(s.err.join(''), /termd \(pid \d+\) exited \((code 0|signal SIGTERM)\) [\d.]+ s after it was started; it said: .*stopped/);
    s.end();
    assert.equal(await s.exited, 0);
    // Detached and unreferenced: it outlives the shim.
    assert.match(commandOf(pid), /^termd/);
  } finally {
    s.child.kill();
    // Stop every termd this shim started — found by its unique data dir, never anything else —
    // even when the test failed before it learned the pid.
    for (const p of new Set([...spawnedPids(dataDir), ...(pid ? [pid] : [])])) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {
        continue;
      }
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        try {
          process.kill(p, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

test("tg-19: a supervisor's termd on the shim's port is left to it, and a check that does not answer starts nothing (the house's read of 4e37a11, #22)", async () => {
  const port = await unusedPort();
  const cases = [
    ['ours', /is the (launchd job com\.animalabs\.termd|systemd user unit termd)'s to start/],
    ['slow', /did not answer within 1500 ms: no termd is started here/],
  ] as const;
  for (const [kind, expected] of cases) {
    const dir = path.join(tmp, `spawn-${kind}`);
    const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: dir, HOME: tmp, TSM_CONNECT_TIMEOUT_MS: '2500', PATH: supervisorPath(kind, port) });
    s.send(init(1));
    s.end();
    const failed = await s.next(byId(1), 8000);
    assert.equal(failed.error?.code, -32000, kind);
    assert.match(failed.error?.message ?? '', expected, kind);
    assert.doesNotMatch(s.err.join(''), /started termd/, kind);
    assert.equal(fs.existsSync(dir), false, `${kind}: nothing was started`);
    assert.equal(await s.exited, 1);
  }
});

test("tg-19: the supervisor check fails closed and reads a unit as termd does: a query that fails starts nothing (systemctl without its bus; launchctl without a GUI domain while the LaunchAgent is on disk), a LaunchAgent on disk but not loaded is the agent's port and one that cannot be read is unknown, a unit enabled but inactive or one whose port is in its environment is the unit's, TSM_PORT is read before SESSION_SERVER_PORT, a unit for another port out of the same data dir stops the start, and a data dir with spaces is read whole from each supervisor's text (the house's read of the shim, #22 comment 6269349177; of the 38 commits, #22 comment 6274370651)", async () => {
  const port = await unusedPort();
  const darwin = process.platform === 'darwin';
  const linux = process.platform === 'linux';
  /** A HOME whose LaunchAgents holds the shipped plist for `unitPort`, with `--data-dir dataDir` added when given. */
  const plistHome = (name: string, unitPort: number, dataDir?: string): string => {
    const home = path.join(tmp, `home-${name}`);
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    let plist = fs.readFileSync(path.resolve(here, '../../config/com.animalabs.termd.plist'), 'utf8').replace('<string>3101</string>', `<string>${unitPort}</string>`);
    if (dataDir) plist = plist.replace(`<string>${unitPort}</string>`, `<string>${unitPort}</string>\n    <string>--data-dir</string><string>${dataDir}</string>`);
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.animalabs.termd.plist'), plist);
    return home;
  };
  /** As plistHome, with the plist unreadable (mode 0): launchd would load it, the shim cannot read it. */
  const unreadablePlistHome = (name: string, unitPort: number): string => {
    const home = plistHome(name, unitPort);
    fs.chmodSync(path.join(home, 'Library', 'LaunchAgents', 'com.animalabs.termd.plist'), 0o000);
    return home;
  };
  interface Case {
    name: string;
    when: boolean;
    /** The supervisor's answer, given the shim's data dir. */
    stub: keyof typeof STUBS | ((dataDir: string) => Stub);
    home?: string;
    /** `default`: TSM_DATA_DIR unset, so the shim's termd would use $HOME/.tsm, as the unit's does; a path: the shim's TSM_DATA_DIR (one with spaces, read whole from the unit's text). */
    dataDir?: 'default' | string;
    expect: 'unknown' | 'managed' | 'shared' | 'dangling' | 'start';
    says: RegExp;
  }
  const spaced = (name: string) => path.join(tmp, `sup ${name} with spaces`);
  const cases: Case[] = [
    { name: 'shared-data-dir-with-spaces-in-argv', when: true, stub: (dataDir) => unitStub({ port: 3101, dataDir }), dataDir: spaced('argv'), expect: 'shared', says: /serves port 3101 out of the data dir \S+\/sup argv with spaces, which a termd for port \d+ started here would use too/ },
    { name: 'shared-data-dir-with-spaces-in-environment', when: true, stub: (dataDir) => unitStub({ port: 3101, env: { TSM_DATA_DIR: dataDir } }), dataDir: spaced('env'), expect: 'shared', says: /serves port 3101 out of the data dir \S+\/sup env with spaces, which a termd/ },
    { name: 'launchctl-not-loaded-plist-shared-with-spaces', when: darwin, stub: 'none', home: plistHome('not-loaded-spaces', 3101, spaced('plist')), dataDir: spaced('plist'), expect: 'shared', says: /LaunchAgent com\.animalabs\.termd \(.*\) serves port 3101 out of the data dir \S+\/sup plist with spaces, which a termd/ },
    { name: 'launchctl-not-loaded-plist-unreadable', when: darwin && process.getuid?.() !== 0, stub: 'none', home: unreadablePlistHome('unreadable', port), expect: 'unknown', says: /the LaunchAgent com\.animalabs\.termd is on disk \(\S+\.plist\) but could not be read \(EACCES\), so its port and data dir are unknown/ },
    { name: 'execstart-in-another-shape', when: linux, stub: () => ({ launchctl: 'exit 113', systemctl: "printf '%s\\n' 'LoadState=loaded' 'ActiveState=active' 'UnitFileState=disabled' 'ExecStart=/bin/sh /pkg/next/config/termd-launch.sh --port 3101' 'Environment='" }), expect: 'unknown', says: /ExecStart is not in the shape read here/ },
    { name: 'data-dir-flag-without-a-value', when: true, stub: () => unitStub({ port: 'none', dataDir: '--port 3101' }), expect: 'dangling', says: /names --data-dir without a value, so the data dir its termd uses is unknown: none is started here/ },
    { name: 'systemctl-no-bus', when: linux, stub: 'failed', expect: 'unknown', says: /systemctl --user show termd failed \(Failed to connect to bus: No medium found\), so whether a unit manages termd is unknown; the user manager is reached through XDG_RUNTIME_DIR/ },
    { name: 'launchctl-no-domain-plist', when: darwin, stub: 'failed', home: plistHome('no-domain', port), expect: 'unknown', says: /launchctl print failed \(Could not find domain for user gui: 501\) and the LaunchAgent com\.animalabs\.termd is on disk \(\S+\.plist\), so whether it runs termd is unknown/ },
    { name: 'launchctl-no-domain-no-plist', when: darwin, stub: 'failed', expect: 'start', says: /started termd/ },
    { name: 'launchctl-not-loaded-plist', when: darwin, stub: 'none', home: plistHome('not-loaded', port), expect: 'managed', says: /is the LaunchAgent com\.animalabs\.termd \(\S+\.plist; not loaded now, loaded at login\)'s to start/ },
    { name: 'launchctl-not-loaded-plist-other-port', when: darwin, stub: 'none', home: plistHome('not-loaded-other', 3101), expect: 'start', says: /LaunchAgent com\.animalabs\.termd \(.*\) serves port 3101 out of \S+\.tsm, not \d+: a termd for \d+ is started here/ },
    { name: 'enabled-inactive', when: linux, stub: () => unitStub({ port, active: false, enabled: true }), expect: 'managed', says: /is the systemd user unit termd's to start/ },
    { name: 'port-in-environment', when: true, stub: () => unitStub({ port: 'none', env: { TSM_PORT: String(port) } }), expect: 'managed', says: /is the (launchd job com\.animalabs\.termd|systemd user unit termd)'s to start/ },
    { name: 'both-ports-session-server-first', when: true, stub: () => unitStub({ port: 'none', env: { SESSION_SERVER_PORT: '3100', TSM_PORT: String(port) } }), expect: 'managed', says: /'s to start/ },
    { name: 'shared-data-dir-from-environment', when: true, stub: (dataDir) => unitStub({ port: 3101, env: { TSM_DATA_DIR: dataDir } }), expect: 'shared', says: /serves port 3101 out of the data dir \S+, which a termd for port \d+ started here would use too: none is started here \(one termd per data dir; give this shim another TSM_DATA_DIR, or dial port 3101\)/ },
    { name: 'shared-data-dir-by-default', when: true, stub: () => unitStub({ port: 3101 }), dataDir: 'default', expect: 'shared', says: /serves port 3101 out of the data dir \S+\/\.tsm, which a termd for port \d+ started here would use too/ },
  ];
  const run = async (c: Case): Promise<void> => {
    const home = c.home ?? path.join(tmp, `home-${c.name}`);
    fs.mkdirSync(home, { recursive: true });
    const dataDir = c.dataDir === 'default' ? path.join(home, '.tsm') : (c.dataDir ?? path.join(tmp, `sup-${c.name}`));
    // Where a start is expected, termd exits 2 at once (its log path is a directory): the start is what is checked, not a daemon.
    if (c.expect === 'start') fs.mkdirSync(path.join(dataDir, 'termd.log'), { recursive: true });
    const stub = typeof c.stub === 'function' ? c.stub(dataDir) : c.stub;
    const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: c.dataDir === 'default' ? '' : dataDir, HOME: home, TSM_CONNECT_TIMEOUT_MS: '2000', PATH: supervisorPath(stub, port) });
    s.send(init(1));
    s.end();
    const failed = await s.next(byId(1), 8000);
    assert.equal(failed.error?.code, -32000, c.name);
    const said = `${failed.error?.message ?? ''}\n${s.err.join('')}`;
    assert.match(said, c.says, c.name);
    if (c.expect === 'start') assert.match(s.err.join(''), /started termd/, c.name);
    else assert.doesNotMatch(s.err.join(''), /started termd/, c.name);
    if (c.expect === 'unknown') assert.match(failed.error?.message ?? '', /no termd is started here while that is unknown \(TSM_NO_SPAWN=1 skips the check/, c.name);
    assert.equal(await s.exited, 1, c.name);
  };
  await Promise.all(cases.filter((c) => c.when).map(run));
});

test("tg-19: no termd is started for a wss:// address, and a URL without a port means the scheme's port (the house's read of 4e37a11, #22)", async () => {
  const port = await unusedPort();
  const dir = path.join(tmp, 'spawn-wss');
  const s = shim({ TSM_URL: `wss://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: dir, HOME: tmp, TSM_CONNECT_TIMEOUT_MS: '600', PATH: supervisorPath('none', port) });
  s.send(init(1));
  s.end();
  const failed = await s.next(byId(1), 5000);
  assert.equal(failed.error?.code, -32000);
  assert.match(failed.error?.message ?? '', /no termd was started here: termd serves ws:\/\/, not wss:\/\//);
  assert.equal(fs.existsSync(dir), false, 'nothing was started');
  assert.equal(await s.exited, 1);
  // No port: the dial is to the scheme's (80), and so would a start be; the failure names it.
  const bare = shim({ TSM_URL: 'ws://127.0.0.1', TSM_CONNECT_TIMEOUT_MS: '600' });
  bare.send(init(1));
  bare.end();
  const f = await bare.next(byId(1), 5000);
  assert.equal((f.error?.data as { daemon: string }).daemon, 'ws://127.0.0.1:80');
  await bare.exited;
});

test("tg-19: a termd that fails at startup is reported with what it said, and the request that waited names it (the house's read of 4e37a11, #22)", async () => {
  const port = await unusedPort();
  const dir = path.join(tmp, 'spawn-broken');
  fs.mkdirSync(path.join(dir, 'termd.log'), { recursive: true }); // a directory where termd's log file should be: termd exits 2
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: dir, HOME: tmp, TSM_CONNECT_TIMEOUT_MS: '3000', PATH: supervisorPath('none', port) });
  try {
    s.send(init(1));
    s.end();
    const failed = await s.next(byId(1), 10_000);
    assert.equal(failed.error?.code, -32000);
    assert.match(failed.error?.message ?? '', /termd \(pid \d+\) started here exited \(code 2\): cannot open --log-file .*EISDIR/);
    assert.match(s.err.join(''), /termd \(pid \d+\) exited \(code 2\) [\d.]+ s after it was started, before it answered; it said: cannot open --log-file/);
    assert.match(fs.readFileSync(path.join(dir, 'termd.stderr.log'), 'utf8'), /cannot open --log-file/);
    assert.equal(s.err.join('').match(/started termd/g)?.length, 1, 'a start that never answered is not retried within the wait');
    assert.equal(await s.exited, 1);
  } finally {
    s.child.kill();
    await stopSpawned(dir);
  }
});

test("tg-19: a termd that fails after its log opened is reported with what it said too: another termd's data dir, said by termd on stderr as well as in its log (the house's read of the shim, #22 comment 6269349177)", async () => {
  const port = await unusedPort();
  const dir = path.join(tmp, 'spawn-locked');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // This process holds the data dir, as a live termd would: the shim's termd finds it locked after its
  // log is open, and exits 1.
  const lock = acquireDataDirLock(dir);
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: dir, HOME: tmp, TSM_CONNECT_TIMEOUT_MS: '3000', PATH: supervisorPath('none', port) });
  try {
    s.send(init(1));
    s.end();
    const failed = await s.next(byId(1), 10_000);
    assert.equal(failed.error?.code, -32000);
    assert.match(failed.error?.message ?? '', /termd \(pid \d+\) started here exited \(code 1\): another termd is using the data dir/);
    assert.match(s.err.join(''), /termd \(pid \d+\) exited \(code 1\) [\d.]+ s after it was started, before it answered; it said: another termd is using the data dir/);
    assert.match(fs.readFileSync(path.join(dir, 'termd.stderr.log'), 'utf8'), /another termd is using the data dir/, 'termd said it on stderr, with the log file open');
    assert.match(fs.readFileSync(path.join(dir, 'termd.log'), 'utf8'), /another termd is using the data dir/, 'and in its log');
    assert.equal(await s.exited, 1);
  } finally {
    lock.release();
    s.child.kill();
    await stopSpawned(dir);
  }
});

/** The `listening` records in the log the shim gives the termd it starts in `dataDir`. */
function listening(dataDir: string): Array<{ pid: number; dataDir: string }> {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dataDir, 'termd.log'), 'utf8');
  } catch {
    return [];
  }
  const records: Array<{ pid: number; dataDir: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"msg":"listening"')) continue;
    try {
      records.push(JSON.parse(line) as { pid: number; dataDir: string });
    } catch {
      // a torn line
    }
  }
  return records;
}

/**
 * The termd processes started with this data dir: each wrote its `listening` record, with its pid,
 * into the log the shim gave it there. (The process title names only the port, so that a path with
 * "node" in it never makes `pkill -f node` take the daemon: the house's read of 59f660b, #22.)
 */
function spawnedPids(dataDir: string): number[] {
  const pids = new Set<number>();
  for (const r of listening(dataDir)) if (r.pid && /^termd( |$)/.test(commandOf(r.pid))) pids.add(r.pid);
  return [...pids];
}

/** Stop every termd started with this data dir — found by its unique path, never anything else. */
async function stopSpawned(dataDir: string): Promise<void> {
  for (const p of spawnedPids(dataDir)) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      continue;
    }
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      try {
        process.kill(p, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

test('atc-6/ux-15: the 1.x settings reach the daemon they name, TSM_* wins, and no daemon is ever started for a 1.x address', async () => {
  const d = await daemon(0, undefined, { 'tok-1x': 'agent:old@x', 'tok-2x': 'agent:new@x' });
  const spawnDir = path.join(tmp, 'spawn-1x');
  try {
    // TSM_URL is always set (empty = unset): an old shim would otherwise dial the default 3101.
    const viaUrl = shim({ TSM_URL: '', TSM_TOKEN: '', SESSION_SERVER_URL: `ws://127.0.0.1:${d.port}`, SESSION_SERVER_TOKEN: 'tok-1x' });
    viaUrl.send(init(1));
    viaUrl.send(call(2, 'session_open', { session: 'old1' }));
    const opened = await viaUrl.next(byId(2));
    assert.equal((structured(opened).info as { owner: string }).owner, 'agent:old@x', 'SESSION_SERVER_URL and SESSION_SERVER_TOKEN were used');
    assert.match(viaUrl.err.join(''), /SESSION_SERVER_URL \(a 1\.x setting\)/);
    viaUrl.end();
    assert.equal(await viaUrl.exited, 0);

    const viaPort = shim({ TSM_URL: '', TSM_TOKEN: '', SESSION_SERVER_HOST: '127.0.0.1', SESSION_SERVER_PORT: String(d.port), SESSION_SERVER_TOKEN: 'tok-1x' });
    viaPort.send(init(1));
    viaPort.send(call(2, 'session_list', {}));
    assert.ok((await viaPort.next(byId(2))).result, 'SESSION_SERVER_HOST + SESSION_SERVER_PORT');
    viaPort.end();
    await viaPort.exited;

    // The port alone, as connectome-host's guide sets it: the host is `localhost`, as 1.x's own
    // frontend dialed, which reaches a daemon on either loopback address.
    const portOnly = shim({ TSM_URL: '', TSM_TOKEN: '', SESSION_SERVER_PORT: String(d.port), SESSION_SERVER_TOKEN: 'tok-1x' });
    portOnly.send(init(1));
    portOnly.send(call(2, 'session_list', {}));
    assert.ok((await portOnly.next(byId(2))).result, 'SESSION_SERVER_PORT alone');
    portOnly.end();
    await portOnly.exited;

    const both = shim({ TSM_URL: `ws://127.0.0.1:${d.port}`, TSM_TOKEN: 'tok-2x', SESSION_SERVER_URL: 'ws://127.0.0.1:9', SESSION_SERVER_TOKEN: 'tok-1x' });
    both.send(init(1));
    both.send(call(2, 'session_open', { session: 'new1' }));
    assert.equal((structured(await both.next(byId(2))).info as { owner: string }).owner, 'agent:new@x', 'TSM_* wins');
    both.end();
    await both.exited;

    // A 1.x address with nothing listening: fail and say why, never start a daemon for it.
    const port = await unusedPort();
    const none = shim({ TSM_URL: '', TSM_NO_SPAWN: '', SESSION_SERVER_PORT: String(port), TSM_CONNECT_TIMEOUT_MS: '1500', TSM_DATA_DIR: spawnDir, HOME: tmp, PATH: supervisorPath('none', port) });
    none.send(init(7));
    none.end();
    const failed = await none.next(byId(7), 8000);
    assert.equal(failed.error?.code, -32000);
    assert.match(failed.error?.message ?? '', /SESSION_SERVER_PORT/);
    assert.doesNotMatch(none.err.join(''), /started termd/);
    await none.exited;
    assert.equal(fs.existsSync(path.join(spawnDir, 'termd.log')), false, 'no termd was started');
  } finally {
    await stopSpawned(spawnDir);
    await d.close();
  }
});

test('atc-19: the compat profile follows --profile (either spelling, over TSM_PROFILE), TSM_PROFILE, and the invoked name — also through a wrapper that execs node on the compat entry', async () => {
  const d = await daemon();
  const list = async (env: NodeJS.ProcessEnv, argv?: string[]): Promise<string[]> => {
    const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}`, TSM_PROFILE: '', ...env }, argv);
    s.send(init(1));
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const r = await s.next(byId(2));
    s.end();
    await s.exited;
    return (r.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  };
  try {
    assert.ok(!(await list({})).includes('runCommand'), 'tsm-shim: the core');
    assert.ok((await list({}, [SHIM, '--profile', 'compat'])).includes('runCommand'), '--profile compat');
    assert.ok((await list({}, [SHIM, '--profile=compat'])).includes('runCommand'), '--profile=compat');
    assert.ok(!(await list({ TSM_PROFILE: 'compat' }, [SHIM, '--profile', 'core'])).includes('runCommand'), '--profile wins over TSM_PROFILE');
    assert.ok((await list({ TSM_PROFILE: 'compat' })).includes('runCommand'), 'TSM_PROFILE=compat');
    // A pnpm/cmd-shim style install: a wrapper named terminal-sessions-mcp execs node on the compat entry, which says who it is.
    assert.ok((await list({}, [COMPAT])).includes('runCommand'), 'the compat entry file');
    // An npm/Volta install: the bin is a symlink named terminal-sessions-mcp.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(SHIM, path.join(bin, 'terminal-sessions-mcp'));
    assert.ok((await list({}, [path.join(bin, 'terminal-sessions-mcp')])).includes('runCommand'), 'the symlinked 1.x name');
    assert.ok(!(await list({ TSM_PROFILE: 'core' }, [path.join(bin, 'terminal-sessions-mcp')])).includes('runCommand'), 'TSM_PROFILE wins over the name');
  } finally {
    await d.close();
  }
});

test("tsg-3: a termd the shim starts gets a minimal environment, $HOME as its cwd, no credential of the host, and one data dir for a relative TSM_DATA_DIR (the house's read of 4e37a11, #22)", async () => {
  const port = await unusedPort();
  const home = path.join(tmp, 'home-env');
  const hostCwd = path.join(tmp, 'host-project');
  // Relative: resolved once, against the shim's working directory, for the shim's files and termd's alike.
  const dataDir = path.join(hostCwd, 'reldata');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hostCwd, { recursive: true });
  const s = shim(
    {
      TSM_URL: `ws://127.0.0.1:${port}`,
      TSM_NO_SPAWN: '',
      TSM_DATA_DIR: 'reldata',
      HOME: home,
      HISTFILE: path.join(home, '.bash_history'),
      SHELL: '/bin/bash',
      TSM_TOKEN: 'shim-secret-123',
      FAKE_HOST_API_KEY: 'sk-fake-host-secret',
      CLAUDECODE: '1',
      PATH: supervisorPath('none', port),
    },
    [SHIM],
    hostCwd,
  );
  try {
    s.send(init(1));
    assert.ok((await s.next(byId(1), 15_000)).result);
    s.send(call(2, 'run', { session: 'envs', command: 'echo "K=[$FAKE_HOST_API_KEY] C=[$CLAUDECODE] T=[${TSM_TOKEN-unset}]"; pwd', wait: 15_000 }));
    const r = structured(await s.next(byId(2), 20_000));
    assert.equal(r.state, 'exited', JSON.stringify(r));
    const text = (r.output as { text: string }).text;
    assert.match(text, /K=\[\] C=\[\] T=\[unset\]/, 'the host environment did not reach the daemon');
    assert.ok(text.trim().endsWith(home), `the session started in $HOME, not the host's cwd: ${text}`);
    assert.match(String(r.principal), /^token:local-/, 'the shim token did not become a shared daemon token');
    // Every other local client still gets in, token or not.
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { sessions?: unknown[] };
    assert.ok(Array.isArray(health.sessions), 'a token-less client is served (the daemon is loopback-open)');
    assert.deepEqual(listening(dataDir).map((l) => fs.realpathSync(l.dataDir)), [fs.realpathSync(dataDir)], "termd's data dir is the one the shim's log is in");
    assert.equal(fs.existsSync(path.join(home, 'reldata')), false, 'nothing of termd’s went to $HOME/reldata');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    await stopSpawned(dataDir);
  }
});
