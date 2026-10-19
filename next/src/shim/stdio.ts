#!/usr/bin/env node
/**
 * stdio ↔ WebSocket shim for hosts that only speak stdio (§12). Every line on
 * stdin goes to the daemon, every message from the daemon goes to stdout. It
 * adds no protocol logic, only what keeps the pipe honest (`tsm-shim --help` lists the
 * settings; this header says what the shim does with them):
 *
 *  - Lines read before the socket opens are queued and sent in order once it
 *    does, so `printf '…' | tsm-shim` gets its answers. A request that waits
 *    longer than TSM_CONNECT_TIMEOUT_MS for a connection is answered with a
 *    JSON-RPC error (-32000) saying why none came; a notification that waits
 *    that long is dropped. The wait is measured on a monotonic clock.
 *  - At stdin EOF it waits for the answer to every request it forwarded, then
 *    closes the socket and exits 0.
 *  - When the socket drops, every request in flight is answered with -32000:
 *    its outcome is unknown, and the host must not blindly resend it (G16); it
 *    is not resent here either. The daemon numbers the requests it makes of the
 *    host per connection, so the shim gives them ids of its own and maps the
 *    host's answers back; an answer to a request from a connection that is gone
 *    is dropped, never passed on as the answer to a new one. The shim reconnects
 *    with backoff (a handshake the peer accepts but never answers is given up
 *    and tried again) and replays the host's `initialize`, its MCPL grant with
 *    the reductions since, and its open channels, so the new connection is in
 *    the state the host believes it is in. The replay follows what the daemon
 *    did with what the host sent — a request counts when its answer says it took,
 *    a notification when it arrives, and a grant the daemon refused by failing
 *    closed is replayed to fail closed again — goes in bounded windows, its
 *    answers are swallowed, and a refusal is logged. What expires in the queue
 *    is logged once per pass, by count and method.
 *  - When the URL is a plain ws:// loopback address and nothing listens, it
 *    starts termd — detached, same port, logging to <data-dir>/termd.log
 *    (rotated), its stderr kept in <data-dir>/termd.stderr.log — unless
 *    TSM_NO_SPAWN=1, the address came from a 1.x setting, or a supervisor manages
 *    a termd for that port or out of the same data dir (launchd's job on macOS,
 *    systemd's user unit on Linux; a check that does not answer, or fails, is not
 *    taken as "no supervisor"). A termd started here that exits is reported with
 *    what it said (its stderr, else the end of its log), and started again when
 *    the port is refused later: soon when it had served, 30 s after a start that
 *    never answered. The daemon gets a minimal environment (HOME, USER, LOGNAME, SHELL,
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
 * may wait for a connection, default 15000; a duration — a number of milliseconds, or
 * 500ms, 15s, 2m, 1h — empty = default).
 */
import { clocks, MAX_TIMER_MS } from '../core/clock.js';
import { parseDuration, setting } from '../core/env.js';
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
  TSM_CONNECT_TIMEOUT_MS  how long a request may wait for a connection, default 15000 (a duration: 15s, 2m, 1h also read)
  TSM_DATA_DIR            data dir of a termd started here, default ~/.tsm (relative: from the cwd)
  TSM_NO_SPAWN=1          never start termd
  1.x names, read where the TSM_* name is unset: SESSION_SERVER_URL, or SESSION_SERVER_HOST +
  SESSION_SERVER_PORT, and SESSION_SERVER_TOKEN. No termd is ever started for an address from them.

When nothing listens on a plain ws:// loopback TSM_URL, the shim starts termd on that port
(detached, log <data-dir>/termd.log, stderr <data-dir>/termd.stderr.log), unless TSM_NO_SPAWN=1
or a launchd job / systemd user unit manages a termd for that port or out of the same data dir
(a check that fails or does not answer also stops the start). A termd it started that exits is
started again when the port is refused later. A request that waits longer than
TSM_CONNECT_TIMEOUT_MS for a connection fails with a JSON-RPC error (-32000).
`;
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

/** The 1.x names of this bin; invoked under one of them, the shim serves the 1.x tools. */
const COMPAT_BINS: ReadonlySet<string> = new Set(['terminal-sessions-mcp']);
/** Set by the dedicated entry file of a compat bin (see the header): the name the host invoked. */
const INVOKED_AS = Symbol.for('term-sessions.shim.invokedAs');
/** The tool profiles the daemon serves (transport/server.ts PROFILES; the shim imports nothing of the transport's). */
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
    if (a === '--profile') {
      // A flag without its value is a mistake, as `--profile=` and an unknown name are: falling back to
      // TSM_PROFILE or the invoked name served a profile the command line did not ask for (the house's
      // read of the shim, #22 comment 6269721389).
      if (argv[i + 1] === undefined) {
        log(`--profile needs a value: one of ${[...PROFILES].join(', ')}`);
        process.exit(2);
      }
      return argv[i + 1];
    }
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  const fromEnv = setting('TSM_PROFILE');
  if (fromEnv) return fromEnv;
  const stem = (p: string | undefined) => (p ? path.basename(p).replace(/\.(c|m)?js$/, '') : '');
  const named = (globalThis as Record<symbol, unknown>)[INVOKED_AS];
  const names = [typeof named === 'string' ? named : '', stem(process.argv[1]), stem(process.argv0)];
  return names.some((n) => COMPAT_BINS.has(n)) ? 'compat' : undefined;
}

/** A setting in milliseconds: a whole number up to what a timer takes; anything else is a mistake, not a value (the house's read of 4e37a11, #22). */
function msSetting(name: string, fallback: number): number {
  const raw = setting(name);
  if (raw === undefined) return fallback;
  // The grammar tsm's flags use (core/env.ts): `15000`, `15s`, `2m`.
  const ms = parseDuration(raw);
  if (ms === undefined || ms > MAX_TIMER_MS) {
    log(`${name} must be a duration (milliseconds, or 500ms, 20s, 2m, 1h; at most ${MAX_TIMER_MS} ms), not ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return ms;
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
const connectTimeoutMs = msSetting('TSM_CONNECT_TIMEOUT_MS', 15_000);
// A handshake the peer accepts but never answers would otherwise wait forever, and no later attempt
// could find a daemon that answers (the house's read of 4e37a11, #22).
const handshakeTimeoutMs = Math.max(1000, Math.min(connectTimeoutMs, 10_000));
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

/** A supervised termd: who manages it, the port it serves and the data dir it uses (both from the unit's text). */
type Supervisor = { kind: 'managed'; by: string; port: string; dataDir: string } | { kind: 'none' } | { kind: 'unknown'; why: string };
const SUPERVISOR_CHECK_MS = 1500;
const SUPERVISOR_CACHE_MS = 30_000;
let supervisorCache: { at: number; result: Supervisor } | undefined;
/** The launchd job's label; its plist, when installed, is `<label>.plist` in a LaunchAgents directory. */
const LAUNCH_AGENT = 'com.animalabs.termd';

type Asked = { out: string } | { failed: string; status: number | null } | 'timeout' | 'missing';

/** Run a command for its output: its stdout when it exited 0; else why not — a nonzero exit comes with its status and the last line it said. */
function ask(cmd: string, args: string[]): Promise<Asked> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SUPERVISOR_CHECK_MS, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: stdout });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
      if (e.code === 'ENOENT') return resolve('missing');
      if (e.killed || e.signal) return resolve('timeout');
      const status = typeof e.code === 'number' ? e.code : null;
      // The last line: launchctl says "Bad request." first and why on the line after.
      const said = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean).pop();
      resolve({ failed: said ? said.slice(0, 200) : `exit ${status ?? '?'}`, status });
    });
  });
}

/**
 * The port a unit's text gives termd: `--port N` (`--port=N`), else TSM_PORT, else SESSION_SERVER_PORT
 * in its environment — the order termd reads them in, so a unit that sets both is read as termd reads
 * it (the house's read of the shim, #22 comment 6269349177) — else termd's default.
 */
function unitPort(text: string): string {
  return /--port[=\s]+(\d+)/.exec(text)?.[1] ?? /\bTSM_PORT\W+(\d+)/.exec(text)?.[1] ?? /\bSESSION_SERVER_PORT\W+(\d+)/.exec(text)?.[1] ?? '3101';
}

/**
 * The data dir a unit's termd uses: `--data-dir`, else TSM_DATA_DIR in its environment, else termd's
 * default. The unit runs as this user from $HOME (the launcher starts there), so `~`, `$HOME` and
 * systemd's `%h` are this home, and a relative path is taken from it.
 */
function unitDataDir(text: string): string {
  const named = /--data-dir[=\s]+(\S+)/.exec(text)?.[1] ?? /\bTSM_DATA_DIR(?:\s*=>\s*|=|\s+)(\S+)/.exec(text)?.[1];
  const home = os.homedir();
  if (named === undefined) return path.join(home, '.tsm');
  return path.resolve(home, named.replace(/^["']|["';]+$/g, '').replace(/^(~|\$\{?HOME\}?|%h)(?=\/|$)/, home));
}

/** Whether two paths name one directory: by what they resolve to on disk where they exist, else by their spelling. */
function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * The supervisor that manages a termd for this user, if one does, with the port it serves and the
 * data dir it uses: launchd's job on macOS, systemd's user unit on Linux. A daemon started here while
 * the supervised one was down (its restart delay, an update) took its port, left the unit failing
 * with EADDRINUSE, and ran on with nothing to restart it (the house's review of #11). The question
 * is whether the unit runs termd or will — a running unit need not be enabled, an enabled one starts
 * at login — and a check that does not answer, or fails, is not taken as "no" (the house's read of
 * 4e37a11, #22, and of the shim, #22 comment 6269349177). Asked at each start that is due, at most
 * once per SUPERVISOR_CACHE_MS.
 */
async function supervisedTermd(): Promise<Supervisor> {
  const now = clocks.monotonic();
  if (supervisorCache && now - supervisorCache.at < SUPERVISOR_CACHE_MS) return supervisorCache.result;
  const result = await checkSupervisor();
  supervisorCache = { at: now, result };
  return result;
}

async function checkSupervisor(): Promise<Supervisor> {
  if (process.platform === 'darwin') {
    const r = await ask('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT}`]);
    if (r === 'timeout') return { kind: 'unknown', why: `launchctl print did not answer within ${SUPERVISOR_CHECK_MS} ms` };
    if (r === 'missing') return { kind: 'none' }; // no launchd to ask
    if (typeof r === 'object' && 'failed' in r) {
      const plist = launchAgentOnDisk();
      // 113 is launchd's answer: the job is not loaded. With its plist on disk it loads at the next
      // login (copied there after this login, or booted out until the next), so its port is still
      // the agent's — as a systemd unit that is enabled but inactive is.
      if (r.status === 113) {
        if (!plist) return { kind: 'none' };
        const text = plistText(plist);
        return { kind: 'managed', by: `the LaunchAgent ${LAUNCH_AGENT} (${plist}; not loaded now, loaded at login)`, port: unitPort(text), dataDir: unitDataDir(text) };
      }
      // Any other failure is no answer: over ssh there is no gui domain to ask (exit 112), while the
      // agent may well be running at the console. With its plist on disk that is unknown; with none,
      // nothing of this user's is managed (the house's read of the shim, #22 comment 6269349177).
      if (!plist) return { kind: 'none' };
      return { kind: 'unknown', why: `launchctl print failed (${r.failed}) and the LaunchAgent ${LAUNCH_AGENT} is on disk (${plist}), so whether it runs termd is unknown` };
    }
    return { kind: 'managed', by: `the launchd job ${LAUNCH_AGENT}`, port: unitPort(r.out), dataDir: unitDataDir(r.out) };
  }
  if (process.platform === 'linux') {
    const r = await ask('systemctl', ['--user', 'show', 'termd', '--property=LoadState,ActiveState,UnitFileState,ExecStart,Environment']);
    if (r === 'timeout') return { kind: 'unknown', why: `systemctl --user show termd did not answer within ${SUPERVISOR_CHECK_MS} ms` };
    if (r === 'missing') return { kind: 'none' }; // no systemd: nothing of this user's is managed
    // A failure is no answer: under cron or `sudo -u` the user manager runs, with its units, but systemctl
    // cannot reach its bus without XDG_RUNTIME_DIR (the house's read of the shim, #22 comment 6269349177).
    if (typeof r === 'object' && 'failed' in r) {
      const bus = /bus/i.test(r.failed) ? '; the user manager is reached through XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, which this environment lacks' : '';
      return { kind: 'unknown', why: `systemctl --user show termd failed (${r.failed}), so whether a unit manages termd is unknown${bus}` };
    }
    const prop = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.out)?.[1]?.trim() ?? '';
    if (prop('LoadState') !== 'loaded') return { kind: 'none' };
    // Running or about to (whether or not enabled), or enabled to start at login: the unit's. Loaded,
    // inactive and disabled: nothing will start it but a hand, so a termd started here collides with nothing.
    const running = ['active', 'activating', 'reloading', 'deactivating'].includes(prop('ActiveState'));
    const enabled = /^(enabled|static|linked|indirect|generated|transient|alias)/.test(prop('UnitFileState'));
    if (!running && !enabled) return { kind: 'none' };
    const text = `${prop('ExecStart')} ${prop('Environment')}`;
    return { kind: 'managed', by: 'the systemd user unit termd', port: unitPort(text), dataDir: unitDataDir(text) };
  }
  return { kind: 'none' };
}

/** The LaunchAgent's plist where launchd loads it from at login: this user's LaunchAgents, else the machine's; undefined when neither has it. */
function launchAgentOnDisk(): string | undefined {
  for (const dir of [path.join(os.homedir(), 'Library', 'LaunchAgents'), '/Library/LaunchAgents']) {
    const file = path.join(dir, `${LAUNCH_AGENT}.plist`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** A plist's arguments and environment as a unit's text: its tags become spaces, so the unit readers apply. */
function plistText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').replace(/<[^>]*>/g, ' ');
  } catch {
    return '';
  }
}

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const key = (id: Id) => `${typeof id}:${String(id)}`;
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
/** One per connection attempt: the daemon's request ids are scoped to it. */
let generation = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
/** The last connection error, logged once per change and quoted when a request gives up. */
let lastError = '';
/** Lines from the host, numbered in arrival order: what came after what decides the replay (see `closed`). */
let seq = 0;
interface Line {
  line: string;
  seq: number;
  /** When it arrived (monotonic), for the wait bound. */
  at: number;
  m?: Parsed;
  method?: string;
  id?: Id;
}
/** Lines waiting for an open socket. */
const queue: Line[] = [];
/** Requests forwarded and not yet answered: key → the request, for the host's id and what its answer changes. */
interface Pending {
  id: Id;
  method: string;
  seq: number;
  m: Parsed;
}
const inflight = new Map<string, Pending>();
/**
 * Requests the daemon made of the host on the current connection, by the id the shim gave them: the
 * daemon numbers its requests per connection from 1, so the host's answer to one from a connection
 * that is gone would settle a different request on the new one (the house's read of 4e37a11, #22).
 * Cleared at each close; capped, since a host need not answer.
 */
const asked = new Map<string, { generation: number; id: Id }>();
const ASKED_MAX = 4096;
/**
 * What to replay on a new connection so it is in the host's state: its `initialize`; the MCPL grant
 * (the last request-form `featureSets/update` the daemon accepted) with every reduction since —
 * notification-form updates only ever add `disabled` feature sets (MCPL §6.7), so all of them since
 * the grant fold into one set, however many there were (the house's read of 4e37a11, #22); a later
 * request-form update the daemon refused after running it, replayed after the grant — the daemon
 * fails closed on a malformed one, to an empty grant with no tools, and only its own handling of the
 * same request puts the new connection where the host was told the old one was (the house's read of
 * the shim, #22 comment 6269349177); a refusal the daemon did not run (`executed: false`) changed
 * nothing and is not kept; and the channels the host has open (reopened without `history`: catch-up
 * resumes from the principal's `delivered` cursor, G22). A request's effect is recorded when its
 * answer arrives, a notification's when it does (it is never answered, and one that waits out the
 * queue is never forwarded), so what expired is reflected too (the house's read of 4e37a11, #22).
 */
interface Grant {
  m: Parsed;
  seq: number;
}
const replay: { initialize?: Parsed; initialized?: Parsed; grant?: Grant; refusedGrant?: Grant; reduced: Map<string, number>; channels: Map<string, Parsed> } = {
  reduced: new Map(),
  channels: new Map(),
};
const REDUCED_MAX = 10_000;
/** Channels closed while an open was pending, with the close's seq: a later answer to an earlier open does not reopen them. */
const closedAt = new Map<string, number>();
/** What was replayed under an id, for the log: `refusedBefore` when the daemon refused it on the connection before, so a refusal now is the expected answer. */
interface Replayed {
  method: string;
  channel?: string;
  refusedBefore?: true;
}
/** Ids of replayed requests whose answers the host must not see, with what was replayed, for the log. */
const swallow = new Map<string, Replayed>();
let replayCounter = 0;
/** A replay in progress: sent in windows below the daemon's bound on requests in flight per connection (128), which refuses requests and drops notifications past it. */
interface Replaying {
  items: Array<Replayed & { m: Parsed; request: boolean }>;
  next: number;
  outstanding: number;
  sock: WebSocket;
}
let replaying: Replaying | undefined;
const REPLAY_WINDOW = 32;

function exit(code: number): void {
  process.exitCode = code;
  // Let stdout drain before leaving.
  process.stdout.write('', () => process.exit(code));
}

/** Answer a host request we could not deliver or whose answer will never come. */
function failRequest(id: Id, message: string): void {
  out({ jsonrpc: '2.0', id, error: { code: CONNECTION_CLOSED, message, data: { daemon: target } } });
}

/** What a notification changes in the host's picture, recorded as it arrives (see `replay`). */
function noteNotification(m: Parsed, seq: number): void {
  if (m.method === 'notifications/initialized') replay.initialized = m;
  else if (m.method === 'featureSets/update' && isObj(m.params) && Array.isArray(m.params.disabled)) {
    for (const n of m.params.disabled) {
      if (typeof n !== 'string') continue;
      if (replay.reduced.size >= REDUCED_MAX && !replay.reduced.has(n)) {
        log(`more than ${REDUCED_MAX} distinct feature sets disabled since the grant; ${n} will not be replayed after a reconnect`);
        continue;
      }
      replay.reduced.set(n, seq);
    }
  } else if (m.method === 'channels/close' && isObj(m.params) && typeof m.params.channelId === 'string') closed(m.params.channelId, seq);
}

/** The daemon answered a host request: what that changes in the host's picture (see `replay`). */
function answered(p: Pending, m: Parsed): void {
  if (p.method === 'featureSets/update') return grantAnswered(p, m);
  if (m.error !== undefined) return; // the host saw the refusal; its picture is as before
  if (p.method === 'initialize') replay.initialize = p.m;
  else if (p.method === 'channels/open') opened(p, m);
  else if (p.method === 'channels/close' && isObj(p.m.params) && typeof p.m.params.channelId === 'string') closed(p.m.params.channelId, p.seq);
}

/**
 * The daemon answered a request-form featureSets/update. Accepted, it is the grant. Refused after
 * running it, it is kept to be replayed after the grant: a malformed one failed the lane closed, and
 * the daemon's own handling of it is what fails the new connection closed too — the shim does not
 * read the refusal to tell a fail-closed from one that left the lane as it was (the house's read of
 * the shim, #22 comment 6269349177). Refused without running (the in-flight bound), it changed nothing.
 */
function grantAnswered(p: Pending, m: Parsed): void {
  if (m.error === undefined) {
    replay.grant = { m: p.m, seq: p.seq };
    if (replay.refusedGrant && replay.refusedGrant.seq < p.seq) delete replay.refusedGrant;
    // Reductions before this grant are its to carry (or not); those sent after it still bind.
    for (const [n, at] of replay.reduced) if (at < p.seq) replay.reduced.delete(n);
    return;
  }
  const notRun = isObj(m.error) && isObj(m.error.data) && m.error.data.executed === false;
  if (notRun || (replay.grant?.seq ?? -1) > p.seq || (replay.refusedGrant?.seq ?? -1) > p.seq) return;
  replay.refusedGrant = { m: p.m, seq: p.seq };
}

/** A channels/open the daemon accepted: remember the channel (by the id the daemon gave it) until the host closes it. */
function opened(p: Pending, m: Parsed): void {
  const channel = isObj(m.result) && isObj(m.result.channel) ? m.result.channel.id : undefined;
  if (typeof channel !== 'string' || !isObj(p.m.params)) return;
  // A close the host sent after this open stands — it can, since it can predict the channel's id —
  // and the open's late answer does not undo it (the house's read of 4e37a11, #22).
  if ((closedAt.get(channel) ?? -1) > p.seq) return;
  closedAt.delete(channel);
  const { history: _history, historyLimit: _limit, ...again } = p.m.params;
  replay.channels.set(channel, { jsonrpc: '2.0', method: 'channels/open', params: { ...again, channelId: channel } } as Parsed);
}

function closed(channel: string, at: number): void {
  replay.channels.delete(channel);
  closedAt.set(channel, at);
}

/** `closedAt` matters only while an open is pending; once none is, nothing can arrive late. */
function pruneClosed(): void {
  if (closedAt.size === 0) return;
  const pendingOpen = (p: { method?: string; id?: Id }) => p.method === 'channels/open' && p.id !== undefined;
  if (![...inflight.values()].some(pendingOpen) && !queue.some(pendingOpen)) closedAt.clear();
}

function forward(q: Line): void {
  const m = q.m;
  if (m && q.method !== undefined) {
    if (q.id !== undefined) inflight.set(key(q.id), { id: q.id, method: q.method, seq: q.seq, m });
  } else if (m && isId(m.id)) {
    // The host's answer to a request the daemon made (see `asked`): back under the daemon's own id,
    // and only to the connection that asked.
    const a = typeof m.id === 'string' ? asked.get(m.id) : undefined;
    if (!a || a.generation !== generation) {
      log(`dropped the host's answer to request ${JSON.stringify(m.id)}: the connection it was asked on is gone`);
      return;
    }
    asked.delete(m.id as string);
    ws!.send(JSON.stringify({ ...m, id: a.id }));
    return;
  }
  ws!.send(q.line);
}

function flushQueue(): void {
  if (!open || !ws || replaying) return;
  for (const q of queue.splice(0)) forward(q);
  maybeFinish();
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

/**
 * Requests that waited too long for a connection get an error; notifications, and the host's answers
 * to the daemon's requests, are dropped. The queue is in arrival order. One line per pass says what
 * expired, by count and method: a dropped notification has no other trace (the house's read of the
 * shim, #22 comment 6269349177).
 */
function expireQueue(): void {
  const now = clocks.monotonic();
  if (!queue.length || now - queue[0]!.at < connectTimeoutMs) return;
  const gone = { requests: 0, notifications: 0, answers: 0, other: 0 };
  const methods = new Set<string>();
  while (queue.length && now - queue[0]!.at >= connectTimeoutMs) {
    const q = queue.shift()!;
    if (q.method !== undefined) methods.add(q.method);
    if (q.id !== undefined) {
      gone.requests++;
      failRequest(q.id, `cannot reach the terminal daemon at ${target}${lastError ? ` (${lastError})` : ''}${unreachableHint()}`);
    } else if (q.method !== undefined) gone.notifications++;
    else if (q.m && isId(q.m.id)) gone.answers++;
    else gone.other++;
  }
  const parts = [
    gone.requests ? `${gone.requests} request${gone.requests === 1 ? '' : 's'} answered with -32000` : '',
    gone.notifications ? `${gone.notifications} notification${gone.notifications === 1 ? '' : 's'} dropped` : '',
    gone.answers ? `${gone.answers} answer${gone.answers === 1 ? '' : 's'} to the daemon's requests dropped` : '',
    gone.other ? `${gone.other} other line${gone.other === 1 ? '' : 's'} dropped` : '',
  ].filter(Boolean);
  const named = [...methods].slice(0, 8).join(', ') + (methods.size > 8 ? `, and ${methods.size - 8} more` : '');
  log(`waited ${connectTimeoutMs} ms for a connection to ${target}: ${parts.join(', ')}${named ? ` (${named})` : ''}`);
  pruneClosed();
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

const seconds = (since: number) => (Math.round((clocks.monotonic() - since) / 100) / 10).toFixed(1);

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
  return clocks.monotonic() - spawned.at >= (spawned.reached ? RESTART_AFTER_MS : RETRY_START_MS);
}

function noteNotStarted(why: string): void {
  if (why !== notStarted) log(why);
  notStarted = why;
}

/**
 * What a file of termd's gained from `from` on, by its last lines; a JSON record's `msg` (and `error`)
 * where a line is one, as termd's log and the stderr it is given are both JSON lines.
 */
function lastLines(file: string, from: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // The last lines, so a long stack before the exit is quoted from its end, not its start.
      const buf = Buffer.alloc(8192);
      const size = fs.fstatSync(fd).size;
      if (size <= from) return '';
      const n = fs.readSync(fd, buf, 0, buf.length, Math.max(from, size - buf.length));
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
    if (sup.kind === 'managed') {
      // One termd per data dir (the lock in core/lock.ts). A termd started here with the unit's data
      // dir would either exit at once, locked out, or take the dir while the unit's was down and leave
      // the unit failing on every restart (the house's read of the shim, #22 comment 6269349177).
      if (sameDir(sup.dataDir, dataDir)) {
        noteNotStarted(`${sup.by} serves port ${sup.port} out of the data dir ${dataDir}, which a termd for port ${port} started here would use too: none is started here (one termd per data dir; give this shim another TSM_DATA_DIR, or dial port ${sup.port})`);
        return;
      }
      log(`${sup.by} serves port ${sup.port} out of ${sup.dataDir}, not ${port}: a termd for ${port} is started here with ${dataDir}`);
    }
    // While the supervisor was asked, a reconnect may have found a daemon (one started by a hand, a
    // unit, or another shim): then there is nothing to start, and a termd started now would only exit
    // with the port in use. `starting` admits one start at a time, so nothing else can have changed
    // `roomToStart()` meanwhile (the house's read of the shim, #22 comment 6269721389).
    if (open) return;
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
  // Where termd's log stands now: a failure after the log opens is said there (and on stderr since
  // the house's read of the shim, #22 comment 6269349177); its end is quoted when stderr has nothing.
  let logFrom = 0;
  try {
    logFrom = fs.statSync(logPath).size;
  } catch {
    // no log yet
  }
  try {
    const child = spawn(process.execPath, [daemon, '--host', host, '--port', port, '--data-dir', dataDir, '--log-file', logPath], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => SPAWN_ENV.test(k))),
      cwd: os.homedir(),
    });
    const me: Spawned = { pid: child.pid ?? 0, at: clocks.monotonic(), reached: false };
    spawned = me;
    child.on('error', (e) => {
      me.exit = `could not be started: ${e.message}`;
      log(`could not start termd: ${e.message}`);
    });
    // The exit of a detached child is still seen while this process lives: a termd that fails at
    // startup is reported with what it said instead of leaving only ECONNREFUSED (the house's read of 4e37a11, #22).
    child.on('exit', (code, signal) => {
      me.exit = signal ? `signal ${signal}` : `code ${code}`;
      me.said = (typeof stderrFd === 'number' ? lastLines(stderrPath, stderrFrom) : '') || lastLines(logPath, logFrom);
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
  const items: Replaying['items'] = [];
  if (replay.initialize) items.push({ m: replay.initialize, request: true, method: 'initialize' });
  if (replay.initialized) items.push({ m: replay.initialized, request: false, method: 'notifications/initialized' });
  if (replay.grant) items.push({ m: replay.grant.m, request: true, method: 'featureSets/update' });
  if (replay.refusedGrant) items.push({ m: replay.refusedGrant.m, request: true, method: 'featureSets/update', refusedBefore: true });
  if (replay.reduced.size) items.push({ m: { jsonrpc: '2.0', method: 'featureSets/update', params: { disabled: [...replay.reduced.keys()] } } as Parsed, request: false, method: 'featureSets/update' });
  for (const [channel, m] of replay.channels) items.push({ m, request: true, method: 'channels/open', channel });
  replaying = { items, next: 0, outstanding: 0, sock };
  pumpReplay();
}

/** Send the next window of the replay; when all of it is answered, the queue follows. */
function pumpReplay(): void {
  const r = replaying;
  if (!r || r.sock !== ws) return;
  while (r.next < r.items.length && r.outstanding < REPLAY_WINDOW) {
    const { m, request, ...what } = r.items[r.next++]!;
    if (request) {
      const id = `tsm-shim:replay:${++replayCounter}`;
      swallow.set(key(id), what);
      r.outstanding++;
      r.sock.send(JSON.stringify({ ...m, id }));
    } else r.sock.send(JSON.stringify(m));
  }
  if (r.next >= r.items.length && r.outstanding === 0) {
    replaying = undefined;
    flushQueue();
  }
}

/**
 * A replayed request was answered: a refusal is said, since the host is not told (the house's read of
 * 4e37a11, #22) — unless the daemon refused the same request on the connection before, when the
 * refusal is the answer that leaves the new connection where the host was told it is.
 */
function replayed(what: Replayed, m: Parsed): void {
  if (replaying) replaying.outstanding--;
  const e = m.error === undefined ? '' : isObj(m.error) ? `${String(m.error.code)} ${String(m.error.message)}` : JSON.stringify(m.error);
  if (what.refusedBefore) {
    if (m.error !== undefined) log(`replay of ${what.method} refused (${e}), as it was on the connection before: the new connection is where the host was told it is`);
    else log(`replay of ${what.method} accepted, where the connection before refused it: the host was told otherwise`);
  } else if (m.error !== undefined) log(`replay of ${what.method}${what.channel ? ` for ${what.channel}` : ''} refused (${e}): the host believes otherwise and was not told`);
  pumpReplay();
}

function connect(): void {
  generation++;
  const sock = new WebSocket(url.toString(), { handshakeTimeout: handshakeTimeoutMs });
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
    } else flushQueue();
    everOpened = true;
  });
  sock.on('message', (data) => {
    const text = data.toString();
    const m = parse(text);
    if (m && isId(m.id)) {
      if (typeof m.method === 'string') {
        // A request of the daemon's: under an id of this connection's, so its answer can be told from
        // another connection's (see `asked`).
        const mine = `tsm-shim:${generation}:${typeof m.id === 'number' ? 'n' : 's'}:${String(m.id)}`;
        if (asked.size >= ASKED_MAX) asked.delete(asked.keys().next().value!);
        asked.set(mine, { generation, id: m.id });
        process.stdout.write(JSON.stringify({ ...m, id: mine }) + '\n');
        return;
      }
      const replayedWhat = swallow.get(key(m.id));
      if (replayedWhat) {
        swallow.delete(key(m.id));
        replayed(replayedWhat, m);
        return;
      }
      const p = inflight.get(key(m.id));
      if (p) {
        inflight.delete(key(m.id));
        answered(p, m);
        pruneClosed();
      }
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
    for (const p of inflight.values()) failRequest(p.id, 'the terminal daemon connection closed before a response; the outcome is unknown');
    inflight.clear();
    asked.clear();
    swallow.clear();
    replaying = undefined;
    pruneClosed();
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
  const m = parse(line);
  const entry: Line = { line, seq: ++seq, at: clocks.monotonic() };
  if (m) {
    entry.m = m;
    if (typeof m.method === 'string') {
      entry.method = m.method;
      if (isId(m.id)) entry.id = m.id;
      else noteNotification(m, entry.seq);
    }
  }
  if (open && ws && !replaying) forward(entry);
  else queue.push(entry);
});
rl.on('close', () => {
  stdinClosed = true;
  maybeFinish();
});

connect();
