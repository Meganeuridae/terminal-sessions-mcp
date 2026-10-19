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
 *  - When the URL is a plain ws:// loopback address and nothing listens, it
 *    starts termd — detached, same port, logging to <data-dir>/termd.log
 *    (rotated), its stderr kept in <data-dir>/termd.stderr.log — unless
 *    TSM_NO_SPAWN=1, the address came from a 1.x setting, or a supervisor manages
 *    a termd for that port (launchd's job on macOS, systemd's user unit on Linux;
 *    a check that does not answer counts as a supervisor). A termd started here
 *    that exits is reported with what it said, and started again when the port is
 *    refused later: soon when it had served, 30 s after a start that never
 *    answered. The daemon gets a minimal environment (HOME, USER, LOGNAME, SHELL,
 *    PATH, LANG/LC_*, TMPDIR, TZ, TERM) and no credential: it outlives this host
 *    and serves every other one, so neither this host's variables (API keys,
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
 * no name survives (atc-19). Any other profile name is a mistake and exits 2.
 * `--help` prints the settings and exits.
 *
 * Env (an empty value is unset, as for termd): TSM_RESULT_TEXT (json|transcript),
 * TSM_NO_SPAWN, TSM_DATA_DIR (for a spawned termd; a relative path is taken from
 * this process's working directory), TSM_CONNECT_TIMEOUT_MS (how long a request
 * may wait for a connection, default 15000).
 */
import { execFile, spawn } from 'node:child_process';
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

/** `tsm-shim --help`: the settings and what the shim does, before anything is read or started. */
const HELP = `tsm-shim: stdio MCP server for hosts without a WebSocket client; relays to termd (2.0).

Usage: tsm-shim [--profile core|full|compat]

Settings (an empty value is unset):
  TSM_URL                 the daemon, default ws://127.0.0.1:3101
  TSM_TOKEN               credential, sent as ?token=
  TSM_PROFILE             core (default) | full | compat (the 1.x tool names); --profile wins
  TSM_RESULT_TEXT         json (default) | transcript: the text form of tool results
  TSM_CONNECT_TIMEOUT_MS  how long a request may wait for a connection, default 15000
  TSM_DATA_DIR            data dir of a termd started here, default ~/.tsm (relative: from the cwd)
  TSM_NO_SPAWN=1          never start termd
  1.x names, read where the TSM_* name is unset: SESSION_SERVER_URL, or SESSION_SERVER_HOST +
  SESSION_SERVER_PORT, and SESSION_SERVER_TOKEN. No termd is ever started for an address from them.

When nothing listens on a plain ws:// loopback TSM_URL, the shim starts termd on that port
(detached, log <data-dir>/termd.log, stderr <data-dir>/termd.stderr.log), unless TSM_NO_SPAWN=1
or a launchd job / systemd user unit manages a termd for that port. A termd it started that
exits is started again when the port is refused later. A request that waits longer than
TSM_CONNECT_TIMEOUT_MS for a connection fails with a JSON-RPC error (-32000).
`;
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
/** A setting from the environment; empty is unset, as termd reads them (so TSM_DATA_DIR="" never becomes --data-dir ''). */
const setting = (name: string): string | undefined => process.env[name] || undefined;

/** The 1.x names of this bin; invoked under one of them, the shim serves the 1.x tools. */
const COMPAT_BINS: ReadonlySet<string> = new Set(['terminal-sessions-mcp']);
/** Set by the dedicated entry file of a compat bin (see the header): the name the host invoked. */
const INVOKED_AS = Symbol.for('term-sessions.shim.invokedAs');
/** The tool profiles the daemon serves (transport/server.ts PROFILES; the shim imports nothing of the daemon's). */
const PROFILES: ReadonlySet<string> = new Set(['core', 'full', 'compat']);

/** Where to connect, and whether this address may be served by a daemon we start (atc-6). */
function target1x(): { base: string; token: string | undefined; from: string | undefined } {
  const token = setting('TSM_TOKEN') ?? setting('SESSION_SERVER_TOKEN');
  const url = setting('TSM_URL');
  if (url) return { base: url, token, from: undefined };
  const oneX = setting('SESSION_SERVER_URL');
  if (oneX) return { base: oneX, token, from: 'SESSION_SERVER_URL' };
  const host = setting('SESSION_SERVER_HOST');
  const port = setting('SESSION_SERVER_PORT');
  if (host || port) {
    const h = host ?? 'localhost'; // what 1.x's own frontend dialed when only the port was set
    const hostPart = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
    const from = [host ? 'SESSION_SERVER_HOST' : '', port ? 'SESSION_SERVER_PORT' : ''].filter(Boolean).join(' + ');
    return { base: `ws://${hostPart}:${port ?? '3100'}`, token, from };
  }
  return { base: 'ws://127.0.0.1:3101', token, from: undefined };
}

/** `--profile p` / `--profile=p`, then TSM_PROFILE, then the invoked name (atc-19). */
function chooseProfile(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--profile' && argv[i + 1] !== undefined) return argv[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  const fromEnv = setting('TSM_PROFILE');
  if (fromEnv) return fromEnv;
  const stem = (p: string | undefined) => (p ? path.basename(p).replace(/\.(c|m)?js$/, '') : '');
  const named = (globalThis as Record<symbol, unknown>)[INVOKED_AS];
  const names = [typeof named === 'string' ? named : '', stem(process.argv[1]), stem(process.argv0)];
  return names.some((n) => COMPAT_BINS.has(n)) ? 'compat' : undefined;
}

const chosen = target1x();
if (chosen.from) log(`using ${chosen.from} (a 1.x setting) for the daemon address; TSM_URL is the 2.0 name`);
if (!setting('TSM_TOKEN') && setting('SESSION_SERVER_TOKEN')) log('using SESSION_SERVER_TOKEN (a 1.x setting); TSM_TOKEN is the 2.0 name');
const base = chosen.base;
let url: URL;
try {
  url = new URL(base);
} catch {
  log(`${chosen.from ?? 'TSM_URL'} is not a URL: ${base}`);
  process.exit(2);
}
if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
  log(`${chosen.from ?? 'TSM_URL'} must be a ws:// or wss:// URL, not ${base}`);
  process.exit(2);
}
if (chosen.token) url.searchParams.set('token', chosen.token);
const profile = chooseProfile(process.argv.slice(2));
if (profile !== undefined && !PROFILES.has(profile)) {
  log(`the profile must be one of ${[...PROFILES].join(', ')}, not ${JSON.stringify(profile)} (--profile or TSM_PROFILE)`);
  process.exit(2);
}
if (profile) url.searchParams.set('profile', profile);
const resultText = setting('TSM_RESULT_TEXT');
if (resultText) url.searchParams.set('resultText', resultText);
url.searchParams.set('connection', `shim-${process.pid}`);
// The port dialled: a URL without one means the scheme's default, and a termd started here listens on that
// same port — the one dialled, never a default of its own (the house's read of 4e37a11, #22).
const port = url.port || (url.protocol === 'wss:' ? '443' : '80');
const target = `${url.protocol}//${url.hostname}:${port}`;
const connectTimeoutMs = Number(setting('TSM_CONNECT_TIMEOUT_MS') ?? 15_000);
const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
// Resolved here, so the shim's crash file and termd's own files are in one directory whatever either
// process's working directory is (the house's read of 4e37a11, #22).
const dataDir = path.resolve(setting('TSM_DATA_DIR') ?? path.join(os.homedir(), '.tsm'));

/**
 * Why no termd is started here for this address, or undefined when one may be. A daemon started here
 * serves only a plain ws:// loopback address that 2.0 settings named: never a 1.x one (atc-6), never a
 * wss:// one (termd has no TLS; a plain termd on that port would fail the shim's own handshake), and
 * never one a supervisor manages (asked when a start is due, see `supervisedTermd`).
 */
function noStartReason(): string | undefined {
  if (setting('TSM_NO_SPAWN') === '1') return 'TSM_NO_SPAWN=1';
  if (chosen.from) return `the address came from ${chosen.from} (a 1.x setting)`;
  if (!loopback) return 'the address is not loopback';
  if (url.protocol !== 'ws:') return 'termd serves ws://, not wss://';
  return undefined;
}

type Supervisor = { kind: 'managed'; by: string; port: string } | { kind: 'none' } | { kind: 'unknown'; why: string };
const SUPERVISOR_CHECK_MS = 1500;
const SUPERVISOR_CACHE_MS = 30_000;
let supervisorCache: { at: number; result: Supervisor } | undefined;

/** Run a command for its output: its stdout when it exited 0, else why not. */
function ask(cmd: string, args: string[]): Promise<{ out: string } | 'failed' | 'timeout' | 'missing'> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SUPERVISOR_CHECK_MS, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout) => {
      if (!err) return resolve({ out: stdout });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (e.code === 'ENOENT') return resolve('missing');
      if (e.killed || e.signal) return resolve('timeout');
      resolve('failed');
    });
  });
}

/** The port a unit's command line gives termd (`--port N`, `--port=N`, TSM_PORT or SESSION_SERVER_PORT in its environment), else termd's default. */
function unitPort(text: string): string {
  return /--port[=\s]+(\d+)/.exec(text)?.[1] ?? /(?:TSM_PORT|SESSION_SERVER_PORT)\W+(\d+)/.exec(text)?.[1] ?? '3101';
}

/**
 * The supervisor that manages a termd for this user, if one does, and the port it serves: launchd's
 * job on macOS, systemd's user unit on Linux. A daemon started here while the supervised one was down
 * (its restart delay, an update) took its port, left the unit failing with EADDRINUSE, and ran on
 * with nothing to restart it (the house's review of #11). The question is whether the unit runs
 * termd or will — a running unit need not be enabled, an enabled one starts at login — and a check
 * that does not answer is not taken as "no" (the house's read of 4e37a11, #22). Asked at each start
 * that is due, at most once per SUPERVISOR_CACHE_MS.
 */
async function supervisedTermd(): Promise<Supervisor> {
  const now = Date.now();
  if (supervisorCache && now - supervisorCache.at < SUPERVISOR_CACHE_MS) return supervisorCache.result;
  const result = await checkSupervisor();
  supervisorCache = { at: now, result };
  return result;
}

async function checkSupervisor(): Promise<Supervisor> {
  if (process.platform === 'darwin') {
    const r = await ask('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/com.animalabs.termd`]);
    if (r === 'timeout') return { kind: 'unknown', why: `launchctl print did not answer within ${SUPERVISOR_CHECK_MS} ms` };
    if (r === 'missing' || r === 'failed') return { kind: 'none' }; // not loaded (launchctl exits 113), or no launchd to ask
    return { kind: 'managed', by: 'the launchd job com.animalabs.termd', port: unitPort(r.out) };
  }
  if (process.platform === 'linux') {
    const r = await ask('systemctl', ['--user', 'show', 'termd', '--property=LoadState,ActiveState,UnitFileState,ExecStart,Environment']);
    if (r === 'timeout') return { kind: 'unknown', why: `systemctl --user show termd did not answer within ${SUPERVISOR_CHECK_MS} ms` };
    if (r === 'missing' || r === 'failed') return { kind: 'none' }; // no systemd, or no user manager: nothing of this user's is managed
    const prop = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.out)?.[1]?.trim() ?? '';
    if (prop('LoadState') !== 'loaded') return { kind: 'none' };
    // Running or about to (whether or not enabled), or enabled to start at login: the unit's. Loaded,
    // inactive and disabled: nothing will start it but a hand, so a termd started here collides with nothing.
    const running = ['active', 'activating', 'reloading', 'deactivating'].includes(prop('ActiveState'));
    const enabled = /^(enabled|static|linked|indirect|generated|transient|alias)/.test(prop('UnitFileState'));
    if (!running && !enabled) return { kind: 'none' };
    return { kind: 'managed', by: 'the systemd user unit termd', port: unitPort(`${prop('ExecStart')} ${prop('Environment')}`) };
  }
  return { kind: 'none' };
}

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
  if (chosen.from) {
    return `; the address came from ${chosen.from} (a 1.x setting), so no local daemon was started for it — 2.0's termd listens on 3101 by default: set TSM_URL, or start termd on that address`;
  }
  if (spawned && spawned.exit === undefined) return `; termd (pid ${spawned.pid}) was started here ${seconds(spawned.at)} s ago and has not answered yet`;
  if (spawned) return `; termd (pid ${spawned.pid}) started here exited (${spawned.exit})${spawned.said ? `: ${spawned.said}` : ''}`;
  if (notStarted) return `; ${notStarted}`;
  const reason = noStartReason();
  if (reason !== undefined && loopback) return `; no termd was started here: ${reason}`;
  return '';
}

const seconds = (since: number) => (Math.round((Date.now() - since) / 100) / 10).toFixed(1);

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

/** The termd this shim started last: whether it was ever reached, and how it ended. */
interface Spawned {
  pid: number;
  at: number;
  reached: boolean;
  exit?: string;
  /** The last lines it wrote to stderr as it ended. */
  said?: string;
}
let spawned: Spawned | undefined;
let starting = false;
/** The latest reason a start that was due did not happen, quoted when a request gives up. */
let notStarted: string | undefined;
/** A termd that served and then exited is started again this long after it was started; one that never answered, 30 s after (its cause is likely still there). */
const RESTART_AFTER_MS = 2000;
const RETRY_START_MS = 30_000;

/**
 * Whether the daemon this shim started last leaves room for another: it has exited, long enough ago.
 * A termd that died used to be started at most once, before the first connection; a refused port is
 * reason enough each time (the house's read of 4e37a11, #22).
 */
function roomToStart(): boolean {
  if (!spawned) return true;
  if (spawned.exit === undefined) return false;
  return Date.now() - spawned.at >= (spawned.reached ? RESTART_AFTER_MS : RETRY_START_MS);
}

function noteNotStarted(why: string): void {
  if (why !== notStarted) log(why);
  notStarted = why;
}

/** What termd wrote to its stderr from `from` on: its last lines, a JSON record's `msg` where it is one. */
function saidOnStderr(file: string, from: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      const lines = buf
        .toString('utf8', 0, n)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-3);
      return lines
        .map((l) => {
          const m = parse(l) as { msg?: unknown; error?: unknown } | undefined;
          return m && typeof m.msg === 'string' ? `${m.msg}${typeof m.error === 'string' ? ` (${m.error})` : ''}` : l;
        })
        .join(' | ');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function startDaemon(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    const sup = await supervisedTermd();
    if (sup.kind === 'unknown') {
      noteNotStarted(`${sup.why}: no termd is started here while that is unknown (TSM_NO_SPAWN=1 skips the check; a termd started by hand is used)`);
      return;
    }
    if (sup.kind === 'managed' && sup.port === port) {
      noteNotStarted(`termd on port ${port} is ${sup.by}'s to start: none is started here (TSM_NO_SPAWN=1 says so without the check)`);
      return;
    }
    if (sup.kind === 'managed') log(`${sup.by} serves port ${sup.port}, not ${port}: a termd for ${port} is started here`);
    if (!roomToStart()) return; // another start finished while the supervisor was asked
    notStarted = undefined;
    spawnDaemon();
  } finally {
    starting = false;
  }
}

function spawnDaemon(): void {
  const daemon = fileURLToPath(new URL('../daemon.js', import.meta.url));
  const host = url.hostname === 'localhost' ? 'localhost' : url.hostname.replace(/^\[|\]$/g, '');
  const logPath = path.join(dataDir, 'termd.log');
  const stderrPath = path.join(dataDir, 'termd.stderr.log');
  // termd writes and rotates its own log. Its stderr — a startup failure, what node prints if it
  // crashes — goes to a file of its own, since on termd.log it went to an old generation at the first
  // rotation and nowhere at the third (the house's read of 4e37a11, #22).
  let stderrFd: number | 'ignore' = 'ignore';
  let stderrFrom = 0;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    stderrFd = fs.openSync(stderrPath, 'a', 0o600);
    stderrFrom = fs.fstatSync(stderrFd).size;
  } catch (e) {
    log(`termd's stderr cannot be kept in ${stderrPath} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); it is started without it`);
  }
  try {
    const child = spawn(process.execPath, [daemon, '--host', host, '--port', port, '--data-dir', dataDir, '--log-file', logPath], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => SPAWN_ENV.test(k))),
      cwd: os.homedir(),
    });
    const me: Spawned = { pid: child.pid ?? 0, at: Date.now(), reached: false };
    spawned = me;
    child.on('error', (e) => {
      me.exit = `could not be started: ${e.message}`;
      log(`could not start termd: ${e.message}`);
    });
    // The exit of a detached child is still seen while this process lives: a termd that fails at
    // startup is reported with what it said instead of leaving only ECONNREFUSED (the house's read of 4e37a11, #22).
    child.on('exit', (code, signal) => {
      me.exit = signal ? `signal ${signal}` : `code ${code}`;
      me.said = typeof stderrFd === 'number' ? saidOnStderr(stderrPath, stderrFrom) : '';
      log(`termd (pid ${me.pid}) exited (${me.exit}) ${seconds(me.at)} s after it was started${me.reached ? '' : ', before it answered'}${me.said ? `; it said: ${me.said}` : ''}`);
    });
    child.unref();
    log(`no daemon at ${target}; started termd (pid ${child.pid ?? '?'}) on loopback with no credential (every local client is token:local-<user>), log ${logPath}, stderr ${stderrPath}`);
  } finally {
    if (typeof stderrFd === 'number') fs.closeSync(stderrFd);
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
    if (spawned) spawned.reached = true;
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
  sock.on('error', (e: Error & { code?: string; errors?: Array<{ code?: string }> }) => {
    // A name that resolves to both loopback addresses (localhost) fails as an AggregateError
    // with an empty message and the attempts in `errors`: take the code from there.
    const code = e.code ?? [...new Set((e.errors ?? []).map((x) => x.code).filter((c): c is string => c !== undefined))].join('/');
    const message = explain(e.message || code || 'connection failed');
    if (code.includes('ECONNREFUSED') && noStartReason() === undefined && roomToStart()) void startDaemon();
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
