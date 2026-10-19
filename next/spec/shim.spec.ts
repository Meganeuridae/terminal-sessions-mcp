/**
 * The stdio shim as a process (tg-19): piped use gets every answer, a dropped
 * socket fails the requests in flight (never silently) and reconnects with the
 * host's state replayed, requests that cannot reach a daemon fail after a bound,
 * and on loopback with nothing listening it starts termd itself.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type WebSocket from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { TermServer } from '../src/transport/server.js';
import { FakeShell } from './fake-shell.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(here, '../src/shim/stdio.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-shim-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string } };

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

const conns = (s: TermServer) => (s as unknown as { conns: Set<{ ws: WebSocket; initialized: boolean; label: string | undefined }> }).conns;

interface Shim {
  child: ChildProcess;
  out: Msg[];
  err: string[];
  send(m: unknown): void;
  end(): void;
  exited: Promise<number | null>;
  next(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>;
}

function shim(env: NodeJS.ProcessEnv, argv: string[] = [SHIM], cwd?: string): Shim {
  const child = spawn(process.execPath, argv, { env: { ...process.env, TSM_NO_SPAWN: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
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

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const init = (id: number | string) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spec', version: '0' } } });
const byId = (id: number | string) => (m: Msg) => m.id === id && m.method === undefined;

test('tg-19: piped stdin that ends before the socket opens still gets every answer, then exit 0', async () => {
  const d = await daemon();
  try {
    const s = shim({ TSM_URL: `ws://127.0.0.1:${d.port}` });
    s.send(init(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: { session: 'p1', command: 'echo hi' } } });
    s.end();
    assert.equal(await s.exited, 0, s.err.join(''));
    assert.deepEqual(s.out.map((m) => m.id), [1, 2, 3]);
    assert.ok((s.out[1]!.result as { tools: unknown[] }).tools.length >= 9);
    assert.equal(((s.out[2]!.result as { structuredContent: { state: string } }).structuredContent).state, 'exited');
    assert.equal(conns(d.server).size === 0 || [...conns(d.server)].every((c) => c.label?.startsWith('shim-')), true);
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
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: { session: 'r1', command: 'sleep 30', wait: 10_000 } } });
    await new Promise((r) => setTimeout(r, 200));
    for (const c of conns(d.server)) c.ws.terminate(); // the daemon side drops the connection mid-call
    const failed = await s.next(byId(2));
    assert.equal(failed.error?.code, -32000);
    assert.match(failed.error?.message ?? '', /outcome is unknown/);
    // The next request goes over a new connection that was initialized for the host.
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_list', arguments: {} } });
    const listed = await s.next(byId(3));
    assert.ok(listed.result, JSON.stringify(listed));
    const now = [...conns(d.server)];
    assert.equal(now.length, 1);
    assert.equal(now[0]!.initialized, true, 'initialize was replayed on the new connection');
    assert.equal(s.out.filter((m) => m.id === 1).length, 1, 'the replayed initialize answer is swallowed');
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
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: 'spec', version: '0' } } });
    await s.next(byId(1));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'featureSets/update', params: { effectiveCapabilities: ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish'] } });
    await s.next(byId(2));
    for (const [n, id] of [[3, 'ka'], [4, 'kb']] as const) {
      s.send({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'session_open', arguments: { session: id } } });
      await s.next(byId(n));
    }
    s.send({ jsonrpc: '2.0', id: 5, method: 'channels/open', params: { address: { session: 'ka' } } });
    s.send({ jsonrpc: '2.0', id: 6, method: 'channels/open', params: { address: { session: 'kb' } } });
    const ka = (await s.next(byId(5))).result as { channel: { id: string } };
    const kb = (await s.next(byId(6))).result as { channel: { id: string } };
    s.send({ jsonrpc: '2.0', id: 7, method: 'channels/close', params: { channelId: kb.channel.id } });
    await s.next(byId(7));
    type Lane = { open: Set<string>; has(path: string): boolean };
    const lane = () => ([...conns(d.server)][0] as unknown as { lane: Lane | null } | undefined)?.lane ?? null;
    const first = lane();
    assert.deepEqual([...first!.open], [ka.channel.id]);
    for (const c of conns(d.server)) c.ws.terminate();
    await until(() => {
      const l = lane();
      return l !== null && l !== first && l.open.size > 0;
    }, 5000, 'the channel to be reopened on the new connection');
    assert.deepEqual([...lane()!.open], [ka.channel.id], 'the open channel is back; the closed one is not');
    assert.equal(lane()!.has('channels.lifecycle'), true, 'the grant was replayed');
    assert.equal(s.out.filter((m) => m.method === undefined && (m.id === 1 || m.id === 2 || m.id === 5)).length, 3, 'replayed answers are swallowed');
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    await d.close();
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
    await new Promise((r) => setTimeout(r, 300));
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' }); // queued while nothing listens
    await new Promise((r) => setTimeout(r, 300));
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

test('tg-19: a request that cannot reach any daemon fails after TSM_CONNECT_TIMEOUT_MS instead of hanging', async () => {
  const port = await unusedPort();
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_CONNECT_TIMEOUT_MS: '400' });
  s.send(init(7));
  s.end();
  const failed = await s.next(byId(7), 5000);
  assert.equal(failed.error?.code, -32000);
  assert.match(failed.error?.message ?? '', /cannot reach/);
  assert.equal(await s.exited, 1);
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

test('tg-19: on loopback with nothing listening the shim starts termd (unless TSM_NO_SPAWN=1)', async () => {
  const port = await unusedPort();
  const dataDir = path.join(tmp, 'spawned');
  const s = shim({ TSM_URL: `ws://127.0.0.1:${port}`, TSM_NO_SPAWN: '', TSM_DATA_DIR: dataDir, HOME: tmp, TSM_TOKEN: '' });
  let pid = 0;
  try {
    s.send(init(1));
    const r = await s.next(byId(1), 15_000);
    assert.ok(r.result, JSON.stringify(r));
    assert.match(s.err.join(''), /started termd/);
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { pid: number };
    // Only ever signal the termd this shim started: the one whose `listening` record is in the log the shim gave it, in our data dir.
    assert.ok(health.pid > 0 && health.pid !== process.pid && health.pid !== s.child.pid);
    assert.ok(spawnedPids(dataDir).includes(health.pid), `the daemon on :${port} is not the one the shim started: ${commandOf(health.pid)}; ours: ${spawnedPids(dataDir).join(' ')}`);
    assert.match(commandOf(health.pid), /^termd --port \d+$/, 'the title says termd and the port, and nothing a flag value could carry');
    pid = health.pid;
    assert.ok(fs.existsSync(path.join(dataDir, 'termd.log')));
    s.end();
    assert.equal(await s.exited, 0);
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

/**
 * The termd processes started with this data dir: each wrote its `listening` record, with its pid,
 * into the log the shim gave it there. (The process title names only the port, so that a path with
 * "node" in it never makes `pkill -f node` take the daemon: the house's read of 59f660b, #22.)
 */
function spawnedPids(dataDir: string): number[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dataDir, 'termd.log'), 'utf8');
  } catch {
    return [];
  }
  const pids = new Set<number>();
  for (const line of text.split('\n')) {
    if (!line.includes('"msg":"listening"')) continue;
    try {
      const pid = (JSON.parse(line) as { pid?: number }).pid;
      if (pid && /^termd( |$)/.test(commandOf(pid))) pids.add(pid);
    } catch {
      // a torn line
    }
  }
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

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const structured = (m: Msg) => (m.result as { structuredContent: Record<string, unknown> }).structuredContent;

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
    const none = shim({ TSM_URL: '', TSM_NO_SPAWN: '', SESSION_SERVER_PORT: String(port), TSM_CONNECT_TIMEOUT_MS: '1500', TSM_DATA_DIR: spawnDir, HOME: tmp });
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

test('atc-19: the compat profile follows --profile, TSM_PROFILE, and the invoked name — also through a wrapper that execs node on the script', async () => {
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
    assert.ok((await list({ TSM_PROFILE: 'compat' })).includes('runCommand'), 'TSM_PROFILE=compat');
    // A pnpm/cmd-shim style install: a wrapper named terminal-sessions-mcp execs node on an entry file, which says who it is.
    const entry = path.join(tmp, 'compat-entry.mjs');
    fs.writeFileSync(entry, `globalThis[Symbol.for('term-sessions.shim.invokedAs')] = 'terminal-sessions-mcp';\nawait import(${JSON.stringify(SHIM)});\n`);
    assert.ok((await list({}, [entry])).includes('runCommand'), 'the dedicated entry file');
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

test('tsg-3: a termd the shim starts gets a minimal environment, $HOME as its cwd, and no credential of the host', async () => {
  const port = await unusedPort();
  const dataDir = path.join(tmp, 'spawn-env');
  const home = path.join(tmp, 'home-env');
  const hostCwd = path.join(tmp, 'host-project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hostCwd, { recursive: true });
  const s = shim(
    {
      TSM_URL: `ws://127.0.0.1:${port}`,
      TSM_NO_SPAWN: '',
      TSM_DATA_DIR: dataDir,
      HOME: home,
      HISTFILE: path.join(home, '.bash_history'),
      SHELL: '/bin/bash',
      TSM_TOKEN: 'shim-secret-123',
      FAKE_HOST_API_KEY: 'sk-fake-host-secret',
      CLAUDECODE: '1',
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
    s.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
    await stopSpawned(dataDir);
  }
});
