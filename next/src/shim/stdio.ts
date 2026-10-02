#!/usr/bin/env node
/**
 * stdio ↔ WebSocket shim for hosts that only speak stdio (§12). Every line on
 * stdin goes to the daemon, every message from the daemon goes to stdout. It
 * adds no protocol logic, only what keeps the pipe honest:
 *
 *  - Lines read before the socket opens are queued and sent in order once it
 *    does, so `printf '…' | tsm-shim` gets its answers.
 *  - At stdin EOF it waits for the answer to every request it forwarded, then
 *    closes the socket and exits 0.
 *  - When the socket drops, every request in flight is answered with a JSON-RPC
 *    error (-32000): its outcome is unknown, and the host must not blindly resend
 *    it (G16). The shim reconnects with backoff and replays the host's
 *    `initialize`, its MCPL policy and its open channels, so the new connection
 *    is in the state the host believes it is in; replayed answers are swallowed.
 *  - When the URL is loopback and nothing listens, it starts termd — detached,
 *    same port, default data dir, cwd $HOME, logging to <data-dir>/termd.log
 *    (rotated) — unless TSM_NO_SPAWN=1, or the address came from a 1.x setting.
 *    The daemon gets a minimal environment (HOME, USER, LOGNAME, SHELL, PATH,
 *    LANG/LC_*, TMPDIR, TZ, TERM) and no credential: it outlives this host and
 *    serves every other one, so neither this host's variables (API keys,
 *    CLAUDECODE, NODE_OPTIONS…) nor its TSM_TOKEN may become the daemon's (tsg-3).
 *    It runs loopback-open, which accepts this shim's token as well.
 *
 * Where it connects: TSM_URL (default ws://127.0.0.1:3101) and TSM_TOKEN. The 1.x
 * bridge's settings still work (atc-6): SESSION_SERVER_URL, or
 * SESSION_SERVER_HOST + SESSION_SERVER_PORT, and SESSION_SERVER_TOKEN, each used
 * only when its TSM_* counterpart is unset. An address taken from them is never
 * replaced by a daemon started here — a 1.x config naming another machine must
 * never run its commands on this one — and a failure names the variable.
 *
 * Profile (§11): `--profile core|full|compat`, else TSM_PROFILE, else by the
 * name the host invoked: `terminal-sessions-mcp` (the 1.x name) serves the 1.x
 * tool names. The name is read from the entry script (argv[1], a symlinked bin)
 * or set by the dedicated `terminal-sessions-mcp` entry file for installs that
 * reach the script through a wrapper (pnpm, cmd-shim, `node …/stdio.js`), where
 * no name survives (atc-19).
 *
 * Env: TSM_RESULT_TEXT (json|transcript), TSM_NO_SPAWN, TSM_DATA_DIR (for a
 * spawned termd), TSM_CONNECT_TIMEOUT_MS (how long a request may wait for a
 * connection, default 15000).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

type Id = string | number;
interface Parsed {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const CONNECTION_CLOSED = -32000;
const log = (m: string) => process.stderr.write(`[tsm-shim] ${m}\n`);

/** The 1.x names of this bin; invoked under one of them, the shim serves the 1.x tools. */
const COMPAT_BINS: ReadonlySet<string> = new Set(['terminal-sessions-mcp']);
/** Set by the dedicated entry file of a compat bin (see the header): the name the host invoked. */
const INVOKED_AS = Symbol.for('term-sessions.shim.invokedAs');

/** Where to connect, and whether this address may be served by a daemon we start (atc-6). */
function target1x(env: NodeJS.ProcessEnv): { base: string; token: string | undefined; from: string | undefined } {
  const token = env.TSM_TOKEN || env.SESSION_SERVER_TOKEN || undefined;
  if (env.TSM_URL) return { base: env.TSM_URL, token, from: undefined };
  if (env.SESSION_SERVER_URL) return { base: env.SESSION_SERVER_URL, token, from: 'SESSION_SERVER_URL' };
  if (env.SESSION_SERVER_HOST || env.SESSION_SERVER_PORT) {
    const h = env.SESSION_SERVER_HOST || '127.0.0.1';
    const hostPart = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
    const from = [env.SESSION_SERVER_HOST ? 'SESSION_SERVER_HOST' : '', env.SESSION_SERVER_PORT ? 'SESSION_SERVER_PORT' : ''].filter(Boolean).join(' + ');
    return { base: `ws://${hostPart}:${env.SESSION_SERVER_PORT || '3100'}`, token, from };
  }
  return { base: 'ws://127.0.0.1:3101', token, from: undefined };
}

/** `--profile p` / `--profile=p`, then TSM_PROFILE, then the invoked name (atc-19). */
function chooseProfile(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--profile' && argv[i + 1] !== undefined) return argv[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  if (env.TSM_PROFILE) return env.TSM_PROFILE;
  const stem = (p: string | undefined) => (p ? path.basename(p).replace(/\.(c|m)?js$/, '') : '');
  const named = (globalThis as Record<symbol, unknown>)[INVOKED_AS];
  const names = [typeof named === 'string' ? named : '', stem(process.argv[1]), stem(process.argv0)];
  return names.some((n) => COMPAT_BINS.has(n)) ? 'compat' : undefined;
}

const chosen = target1x(process.env);
if (chosen.from) log(`using ${chosen.from} (a 1.x setting) for the daemon address; TSM_URL is the 2.0 name`);
if (!process.env.TSM_TOKEN && process.env.SESSION_SERVER_TOKEN) log('using SESSION_SERVER_TOKEN (a 1.x setting); TSM_TOKEN is the 2.0 name');
const base = chosen.base;
let url: URL;
try {
  url = new URL(base);
} catch {
  log(`${chosen.from ?? 'TSM_URL'} is not a URL: ${base}`);
  process.exit(2);
}
if (chosen.token) url.searchParams.set('token', chosen.token);
const profile = chooseProfile(process.argv.slice(2), process.env);
if (profile) url.searchParams.set('profile', profile);
if (process.env.TSM_RESULT_TEXT) url.searchParams.set('resultText', process.env.TSM_RESULT_TEXT);
url.searchParams.set('connection', `shim-${process.pid}`);
const target = `${url.protocol}//${url.host}`;
const connectTimeoutMs = Number(process.env.TSM_CONNECT_TIMEOUT_MS ?? 15_000);
const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
// A daemon started here serves only a loopback address that 2.0 settings named: never a 1.x one (atc-6).
const mayStart = loopback && process.env.TSM_NO_SPAWN !== '1' && chosen.from === undefined;

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const key = (id: Id) => `${typeof id}:${String(id)}`;
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number';

function parse(line: string): Parsed | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Parsed) : undefined;
  } catch {
    return undefined;
  }
}

let ws: WebSocket | null = null;
let open = false;
let stdinClosed = false;
let finishing = false;
let everOpened = false;
let attempt = 0;
let started = false;
let reconnectTimer: NodeJS.Timeout | undefined;
/** The last connection error, logged once per change and quoted when a request gives up. */
let lastError = '';
/** Lines waiting for an open socket, with when they arrived. */
const queue: Array<{ line: string; at: number; id?: Id }> = [];
/** Requests forwarded and not yet answered: key → the host's id. */
const inflight = new Map<string, Id>();
/**
 * What to replay on a new connection so it is in the host's state: its
 * `initialize`, the MCPL policy (the last request-form `featureSets/update`
 * replaces the grant; notification-form ones after it only add reductions, so
 * all of those are kept, in order), and the channels it has open (reopened
 * without `history`: catch-up resumes from the principal's `delivered` cursor,
 * G22).
 */
const replay: { initialize?: Parsed; initialized?: string; policy: Array<{ m: Parsed; request: boolean }>; channels: Map<string, Parsed> } = {
  policy: [],
  channels: new Map(),
};
/** channels/open requests awaiting their answer: request key → the host's params. */
const opening = new Map<string, Record<string, unknown>>();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Ids of replayed requests whose answers the host must not see. */
const swallow = new Set<string>();
let replayCounter = 0;

function exit(code: number): void {
  process.exitCode = code;
  // Let stdout drain before leaving.
  process.stdout.write('', () => process.exit(code));
}

/** Answer a host request we could not deliver or whose answer will never come. */
function failRequest(id: Id, message: string): void {
  out({ jsonrpc: '2.0', id, error: { code: CONNECTION_CLOSED, message, data: { daemon: target } } });
}

function forward(line: string): void {
  const m = parse(line);
  if (m && typeof m.method === 'string') {
    if (isId(m.id)) inflight.set(key(m.id), m.id);
    if (m.method === 'initialize') replay.initialize = m;
    else if (m.method === 'notifications/initialized') replay.initialized = line;
    else if (m.method === 'featureSets/update') {
      if (isId(m.id)) replay.policy = [{ m, request: true }];
      else if (replay.policy.length < 256) replay.policy.push({ m, request: false });
    } else if (m.method === 'channels/open' && isId(m.id) && isObj(m.params)) opening.set(key(m.id), m.params);
    else if (m.method === 'channels/close' && isObj(m.params) && typeof m.params.channelId === 'string') replay.channels.delete(m.params.channelId);
  }
  ws!.send(line);
}

/** A host channels/open was answered: remember the channel (by the id the daemon gave it) until the host closes it. */
function opened(id: Id, m: Parsed): void {
  const params = opening.get(key(id));
  if (!params) return;
  opening.delete(key(id));
  const channel = isObj(m.result) && isObj(m.result.channel) ? m.result.channel.id : undefined;
  if (typeof channel !== 'string') return;
  const { history: _history, historyLimit: _limit, ...again } = params;
  replay.channels.set(channel, { jsonrpc: '2.0', method: 'channels/open', params: { ...again, channelId: channel } } as Parsed);
}

function maybeFinish(): void {
  if (!stdinClosed || finishing) return;
  if (queue.length || inflight.size) return;
  finishing = true;
  if (ws && open) {
    ws.close(1000, 'stdin closed');
    setTimeout(() => exit(0), 1000).unref();
  } else exit(0);
}

/** Requests that waited too long for a connection get an error; notifications are dropped. The queue is in arrival order. */
function expireQueue(): void {
  const now = Date.now();
  if (!queue.length || now - queue[0]!.at < connectTimeoutMs) return;
  while (queue.length && now - queue[0]!.at >= connectTimeoutMs) {
    const q = queue.shift()!;
    if (q.id !== undefined) failRequest(q.id, `cannot reach the terminal daemon at ${target}${lastError ? ` (${lastError})` : ''}${unreachableHint()}`);
  }
  if (stdinClosed && !queue.length && !inflight.size) {
    finishing = true;
    exit(1);
  }
}
setInterval(expireQueue, 250).unref();

/** What to do about an address that does not answer, when the answer is not "wait". */
function unreachableHint(): string {
  if (chosen.from && /ECONNREFUSED/.test(lastError)) {
    return `; the address came from ${chosen.from} (a 1.x setting), so no local daemon was started for it — 2.0's termd listens on 3101 by default: set TSM_URL, or start termd on that address`;
  }
  return '';
}

/** Say what a refused upgrade means (the ws library reports only the status). */
function explain(message: string): string {
  const status = /Unexpected server response: (\d+)/.exec(message)?.[1];
  if (status === '401') return `${message}: the daemon refused the credential (check TSM_TOKEN)`;
  if (status === '421') return `${message}: the daemon does not serve this Host name; start termd with --allow-host <host:port>`;
  if (status === '429' || status === '503') return `${message}: the daemon has too many connections`;
  return message;
}

/**
 * The environment a spawned termd starts with: what a login would give it, nothing of this
 * host's. The daemon outlives this shim and serves every other host, and sessions inherit
 * its environment (G7), so the host's secrets and identity must not ride along (tsg-3).
 */
const SPAWN_ENV = /^(HOME|USER|LOGNAME|SHELL|PATH|LANG|LC_[A-Z_]+|TMPDIR|TZ|TERM)$/;

function startDaemon(): void {
  started = true;
  const daemon = fileURLToPath(new URL('../daemon.js', import.meta.url));
  const dataDir = process.env.TSM_DATA_DIR ?? path.join(os.homedir(), '.tsm');
  const port = url.port || '3101';
  const host = url.hostname === 'localhost' ? 'localhost' : url.hostname.replace(/^\[|\]$/g, '');
  const logPath = path.join(dataDir, 'termd.log');
  // The daemon writes and rotates its own log; stderr goes there too, for what node prints if it crashes.
  let crashFd: number | 'ignore' = 'ignore';
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    crashFd = fs.openSync(logPath, 'a', 0o600);
  } catch {
    // start it without a crash log rather than not at all
  }
  try {
    const child = spawn(process.execPath, [daemon, '--host', host, '--port', port, '--data-dir', dataDir, '--log-file', logPath], {
      detached: true,
      stdio: ['ignore', 'ignore', crashFd],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => SPAWN_ENV.test(k))),
      cwd: os.homedir(),
    });
    child.on('error', (e) => log(`could not start termd: ${e.message}`));
    child.unref();
    log(`no daemon at ${target}; started termd (pid ${child.pid ?? '?'}) on loopback with no credential (every local client is token:local-<user>), log ${logPath}`);
  } finally {
    if (typeof crashFd === 'number') fs.closeSync(crashFd);
  }
}

function scheduleReconnect(): void {
  if (finishing || reconnectTimer) return;
  const delay = Math.min(5000, 100 * 2 ** Math.min(attempt, 6));
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function replayState(sock: WebSocket): void {
  const send = (m: Parsed) => {
    const id = `tsm-shim:replay:${++replayCounter}`;
    swallow.add(key(id));
    sock.send(JSON.stringify({ ...m, id }));
  };
  if (replay.initialize) send(replay.initialize);
  if (replay.initialized) sock.send(replay.initialized);
  for (const p of replay.policy) {
    if (p.request) send(p.m);
    else sock.send(JSON.stringify(p.m));
  }
  for (const c of replay.channels.values()) send(c);
}

function connect(): void {
  const sock = new WebSocket(url.toString());
  ws = sock;
  sock.on('open', () => {
    if (ws !== sock) return;
    open = true;
    attempt = 0;
    lastError = '';
    if (everOpened) {
      log(`reconnected to ${target}`);
      replayState(sock);
    }
    everOpened = true;
    for (const q of queue.splice(0)) forward(q.line);
    maybeFinish();
  });
  sock.on('message', (data) => {
    const text = data.toString();
    const m = parse(text);
    if (m && m.method === undefined && isId(m.id)) {
      if (swallow.delete(key(m.id))) return;
      inflight.delete(key(m.id));
      opened(m.id, m);
    }
    process.stdout.write(text + '\n');
    maybeFinish();
  });
  sock.on('error', (e: Error & { code?: string }) => {
    const message = explain(e.message);
    if (e.code === 'ECONNREFUSED' && !everOpened && mayStart && !started) startDaemon();
    else if (message !== lastError) log(message);
    lastError = message;
  });
  sock.on('close', (code, reason) => {
    if (ws !== sock) return;
    const wasOpen = open;
    open = false;
    ws = null;
    if (finishing) {
      exit(0);
      return;
    }
    if (wasOpen) log(`daemon connection closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`);
    // Their outcome is unknown: say so, never leave the host waiting forever (G16).
    for (const id of inflight.values()) failRequest(id, 'the terminal daemon connection closed before a response; the outcome is unknown');
    inflight.clear();
    opening.clear();
    swallow.clear();
    if (stdinClosed && !queue.length) {
      finishing = true;
      exit(1);
      return;
    }
    scheduleReconnect();
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  if (open && ws) forward(line);
  else {
    const m = parse(line);
    const entry: { line: string; at: number; id?: Id } = { line, at: Date.now() };
    if (m && typeof m.method === 'string' && isId(m.id)) entry.id = m.id;
    queue.push(entry);
  }
});
rl.on('close', () => {
  stdinClosed = true;
  maybeFinish();
});

connect();
