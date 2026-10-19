#!/usr/bin/env node
/**
 * termd — the terminal sessions daemon (§12). One per machine. Speaks MCP+MCPL
 * and the native family over one WebSocket port, serves the GUI, and keeps
 * journals on disk.
 *
 * Operability (§15): JSON-line logs on stderr (or a size-rotated `--log-file`),
 * a usage log for §16 Measure, and no client and no stray exception ends the
 * process — only a signal does, and then it drains: stop accepting, close
 * connections (terminating stragglers), close every session so its Runs end with
 * reason `daemon-shutdown`, and kill every process group a process Run started,
 * so no process Run outlives the daemon (G19c: without the keeper, live
 * processes do not survive a restart). A session's shell is hung up as a closing
 * terminal hangs it up: its foreground job ends with it, and a job the shell
 * detached on purpose (nohup, setsid, disown) lives on, as it would there. After
 * a SIGKILL nothing here runs; the next start's recovery ends the process Runs'
 * groups instead. A log stream whose reader went away (EPIPE) is dropped, never
 * retried in a loop (tsg-5).
 *
 * Startup order keeps a second daemon from touching a live one's journals
 * (G10, G20; jr2-2, tsg-1): the port is held before the data dir is read, so a
 * duplicate on the same port stops at EADDRINUSE; the registry takes the data
 * dir's lock before recovery, so a duplicate on another port stops at
 * `data_dir_locked`; only then does recovery run and the endpoint start — on the
 * held socket itself, so the port is never unbound in between, and a client that
 * connected during recovery waits and is answered rather than refused or reset
 * (a refused shim starts a daemon of its own: the house's review of #11, API 3).
 *
 * Flags are parsed strictly (tsg-18): an unknown flag, a missing value, or a
 * value that looks like another flag is an error, never a silent fallback to an
 * unauthenticated default.
 */
import { setting } from './core/env.js';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { App } from './api/app.js';
import { readTokensFile, TokenMapResolver } from './api/principals.js';
import { SessionRegistry } from './api/registry.js';
import type { Profile } from './api/tools.js';
import { USAGE_GENERATIONS } from './api/usage.js';
import { NodePtyBackend } from './backends/node-pty.js';
import type { ExecutionBackend, ProcessHandle, PtyHandle, SpawnProcessOptions, SpawnShellOptions } from './backends/types.js';
import { clocks } from './core/clock.js';
import type { JournalEvent } from './core/types.js';
import { errText, LOOPBACK_BINDS, parseAllowHost, PROFILES, TermServer, type LogLevel, type LogRecord } from './transport/server.js';

/** Every flag termd takes; anything else is refused (tsg-18). */
const FLAGS = {
  help: { type: 'boolean' },
  host: { type: 'string' },
  port: { type: 'string' },
  'data-dir': { type: 'string' },
  token: { type: 'string' },
  'tokens-file': { type: 'string' },
  anonymous: { type: 'string' },
  'allow-host': { type: 'string', multiple: true },
  shell: { type: 'string' },
  profile: { type: 'string' },
  'result-text': { type: 'string' },
  'retention-bytes': { type: 'string' },
  'retention-days': { type: 'string' },
  'disk-floor-bytes': { type: 'string' },
  'usage-log': { type: 'string' },
  'no-usage-log': { type: 'boolean' },
  'log-level': { type: 'string' },
  'log-file': { type: 'string' },
  /** 1.x's flag; accepted so a 1.x unit starts termd, and changes nothing (see main). */
  headless: { type: 'boolean' },
  'session-oom-score-adj': { type: 'string' },
} as const;

type Flags = { [K in keyof typeof FLAGS]?: (typeof FLAGS)[K] extends { multiple: true } ? string[] : (typeof FLAGS)[K] extends { type: 'boolean' } ? boolean : string };

function parseFlags(argv: string[]): Flags {
  try {
    return parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false }).values as Flags;
  } catch (e) {
    fail(`${(e as Error).message.replace(/\s+/g, ' ')} (termd --help lists the flags)`);
  }
}

/** The package's version: next/dist/src → the package root (next/package.json is a private marker without one). */
function version(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = 'info';

/**
 * Where log lines go: stderr, or a file of our own that rotates by size. Once the
 * stream fails (EPIPE: the reader of a pipe went away) it is dropped for good —
 * logging to a dead stream would fail again, raise again and spin (tsg-5).
 */
let stderrGone = false;
let logFile: RotatingFile | undefined;

/**
 * An append-only 0600 file that rotates to `.1` … `.N` past `maxBytes`, so a long-lived log stays
 * bounded. A file that already exists is made 0600 too, and a torn last line (a crash mid-write) is
 * ended before the first new record, so every record has a line of its own. A rotation that fails is
 * said through `report` and the file is kept, growing, until the next attempt a cap later: a lost
 * generation or a silent move elsewhere is worse than an oversized file (the house's read of 59f660b, #22).
 */
class RotatingFile {
  private fd: number | undefined;
  private bytes = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes: number,
    private readonly generations: number,
    private readonly report: (msg: string, fields: Record<string, unknown>) => void,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.open();
  }

  private open(): void {
    // 'a+': every write goes to the end, and the last byte can be read back.
    const fd = fs.openSync(this.file, 'a+', 0o600);
    this.fd = fd;
    const st = fs.fstatSync(fd);
    this.bytes = st.size;
    if (st.mode & 0o077) {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch (e) {
        this.report('log file is not owner-only and could not be made so', { file: this.file, error: errText(e) });
      }
    }
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, st.size - 1);
      if (last[0] !== 0x0a) {
        fs.writeSync(fd, '\n');
        this.bytes++;
      }
    }
  }

  /** Throws on a write error (and when a rotation left nothing open); the caller decides what that means. */
  write(line: string): void {
    if (this.fd === undefined) return;
    fs.writeSync(this.fd, line);
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > this.maxBytes) this.rotate();
  }

  /** Older generations shift up, the file becomes `.1`, and a fresh one is opened. */
  private rotate(): void {
    const fd = this.fd;
    if (fd === undefined) return;
    try {
      for (let i = this.generations - 1; i >= 1; i--) {
        try {
          fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
        } catch (e) {
          // That generation does not exist yet. Anything else (a directory in the way, a read-only
          // directory) is given up before the file is renamed over `.1` and a generation lost.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch (e) {
      // Said once per cap: the counter restarts, so the next attempt is a cap of bytes away. The
      // report may log through this very file, which stays open.
      this.bytes = 0;
      this.report('log rotation failed; the file keeps growing until the next attempt', { file: this.file, error: errText(e), nextAttemptBytes: this.maxBytes });
      return;
    }
    fs.closeSync(fd);
    this.fd = undefined;
    this.open(); // a failure here is the caller's: the file is `.1` now and nothing is open
  }

  close(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // already gone
      }
    }
    this.fd = undefined;
  }
}

function write(rec: LogRecord): void {
  if (LEVELS[rec.level] < LEVELS[minLevel]) return;
  const line = JSON.stringify(rec) + '\n';
  if (logFile) {
    try {
      logFile.write(line);
      return;
    } catch (e) {
      // Once: the file is given up and stderr takes over, starting with why (the house's read of 59f660b, #22).
      const file = logFile.file;
      logFile.close();
      logFile = undefined;
      log('warn', 'log file given up after a write error; logging to stderr', { file, error: errText(e) });
    }
  }
  if (stderrGone) return;
  try {
    process.stderr.write(line);
  } catch {
    stderrGone = true;
  }
}

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const rec: LogRecord = { ts: new Date().toISOString(), level, msg };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) rec[k] = v;
  write(rec);
}


/** At most `limit` stray-exception lines a minute, and a line a minute saying how many more were dropped (tsg-5). */
function boundedLogger(limit: number): (msg: string, e: unknown) => void {
  let count = 0;
  let dropped = 0;
  setInterval(() => {
    if (dropped) log('warn', 'suppressed repeated errors', { dropped, windowMs: 60_000 });
    count = dropped = 0;
  }, 60_000).unref();
  return (msg, e) => {
    if (++count > limit) dropped++;
    else log('error', msg, { error: errText(e) });
  };
}

/**
 * Does a process group we may still signal exist? True while any member lives; EPERM means the id is
 * now a stranger's (reused), so false. Named for what it answers: the backend's groupAlive answers
 * "does any process of the group remain", where EPERM is true (the reviewer's read of 2f32e8a..a088780).
 */
function ourGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wraps the backend to remember the process group of every process Run (they
 * are spawned detached, each in its own group), so shutdown — and, as a last
 * resort, process exit — can make sure none outlives the daemon, including
 * members that outlived their group leader.
 */
class OwnedProcessGroups implements ExecutionBackend {
  readonly kind: string;
  /**
   * The process handle of every process Run, keyed by its group id. Signals go through the handle's
   * own `kill`, which checks the group is still the Run's before it signals (groupStillOurs), so a
   * group number reused by a stranger within the prune window is never signalled (the house's read,
   * #22 comment 6264958172). A bare `process.kill(-pgid)` here would skip that check.
   */
  private readonly groups = new Map<number, ProcessHandle>();

  constructor(private readonly inner: ExecutionBackend) {
    this.kind = inner.kind;
    // Forget dead groups promptly: a pgid kept after its group died could be reused by a stranger's.
    setInterval(() => {
      for (const [g, h] of this.groups) if (!(h.groupAlive?.() ?? ourGroupAlive(g))) this.groups.delete(g);
    }, 2000).unref();
  }

  spawnShell(opts: SpawnShellOptions): PtyHandle {
    return this.inner.spawnShell(opts);
  }

  processSupport(): { ok: true } | { ok: false; reason: string } {
    return this.inner.processSupport?.() ?? { ok: true };
  }

  spawnProcess(opts: SpawnProcessOptions): ProcessHandle {
    const h = this.inner.spawnProcess(opts);
    const pgid = h.pgid ?? h.pid;
    if (pgid > 0) {
      this.groups.set(pgid, h);
      h.onExit(() => {
        if (!(h.groupAlive?.() ?? ourGroupAlive(pgid))) this.groups.delete(pgid);
      });
    }
    return h;
  }

  live(): number[] {
    return [...this.groups].filter(([g, h]) => h.groupAlive?.() ?? ourGroupAlive(g)).map(([g]) => g);
  }

  signalAll(signal: NodeJS.Signals): void {
    for (const [g, h] of this.groups) {
      // The handle signals the group only while it is still the Run's; once it is gone the handle
      // latches and the group is forgotten here.
      h.kill(signal);
      if (!(h.groupAlive?.() ?? ourGroupAlive(g))) this.groups.delete(g);
    }
  }

  /** SIGTERM whatever is left, then SIGKILL after `graceMs`. Resolves with how many groups had to be signalled. */
  async drain(graceMs: number): Promise<number> {
    const left = this.live().length;
    for (const [signal, ms] of [['SIGTERM', graceMs], ['SIGKILL', 1000]] as const) {
      if (!this.live().length) break;
      this.signalAll(signal);
      const until = clocks.monotonic() + ms;
      while (this.live().length && clocks.monotonic() < until) await new Promise((r) => setTimeout(r, 25));
    }
    return left;
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);

/**
 * A startup failure: logged, and said on stderr even once the log file has taken over, since what
 * started this termd reads stderr — the shim quotes it, a supervisor's journal keeps it — and a port
 * in use or a locked data dir, found after the log opens, otherwise left them only an exit code (the
 * house's read of the shim, #22 comment 6269349177).
 */
function fail(message: string, code = 2): never {
  log('error', message);
  if (logFile && !stderrGone) {
    try {
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: message }) + '\n');
    } catch {
      // the reader is gone; the log file has it
    }
  }
  process.exit(code);
}

/**
 * The port, held from before anything reads the data dir (jr2-2, tsg-1: a second termd for the
 * same port stops at EADDRINUSE instead of running recovery over a live daemon's journals) until
 * the endpoint takes the socket over (see the header). Port 0 has nothing to hold.
 */
interface HeldPort {
  server: net.Server;
  /** Connections accepted during the hold, paused with their first bytes unread, for the endpoint to serve once it listens. */
  parked: net.Socket[];
}
/** More waiting connections than this during one recovery are closed instead (a reset, as every connection during the hold got before). */
const MAX_PARKED = 128;

function holdPort(host: string, port: number): Promise<HeldPort | undefined> {
  if (port === 0) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const held: HeldPort = { server: net.createServer(), parked: [] };
    held.server.on('connection', (sock) => {
      if (held.parked.length >= MAX_PARKED) {
        sock.destroy();
        return;
      }
      sock.pause();
      sock.on('error', () => undefined);
      held.parked.push(sock);
      sock.once('close', () => {
        const i = held.parked.indexOf(sock);
        if (i !== -1) held.parked.splice(i, 1);
      });
    });
    held.server.once('error', reject);
    held.server.listen({ host, port, exclusive: true }, () => resolve(held));
  });
}

const HELP = `termd — terminal sessions daemon
  --host <addr>          bind address (default 127.0.0.1)
  --port <n>             port (default 3101)
  --data-dir <dir>       journals and metadata (default $TSM_DATA_DIR or ~/.tsm)
  --tokens-file <f>      JSON map { "<token>": "agent:name@domain", ... }; must be chmod 600
  --token <t>            a shared token (principal token:default); prefer TSM_TOKEN or --tokens-file:
                         a token on the command line is visible to every local user in ps
  --anonymous <p>        accept unauthenticated connections as principal <p> (loopback development
                         only; refused on a network bind)
  --allow-host <name>    a Host name clients may use besides localhost/127.0.0.1/[::1]
                         (repeatable or comma-separated; required for non-loopback binds)
  --shell <path>         default shell (default $SHELL)
  --profile core|full|compat  tool profile for plain MCP hosts (default core; compat serves the 1.x tool names)
  --result-text json|transcript   default result text rendering (default json)
  --retention-bytes <n>  cap each session's history on disk at n bytes (default: no cap)
  --retention-days <n>   delete history older than n days (default: never)
  --disk-floor-bytes <n> stop writing history to disk while the data dir's filesystem has less than n bytes
                         free (default 209715200, 200 MiB; 0: never): the recent part stays in memory and is
                         written once space returns; what the memory ring had to drop meanwhile reads as a gap
  --usage-log <file>     usage records, one JSON line per tool call, except the GUI's successful read-only
                         ones (default <data-dir>/usage.jsonl)
  --no-usage-log         do not record usage
  --log-file <file>      write logs to this file (0600, rotated by size) instead of stderr; a startup
                         failure is said on stderr as well
  --log-level <level>    debug|info|warn|error (default info)
  --headless             accepted for a 1.x command line; changes nothing (the GUI is at the daemon's address)
  --session-oom-score-adj <n>  Linux: sessions' processes get this oom_score_adj (default 200), so the kernel
                         takes a build before termd; it counts against every process on the machine, so a
                         shared host may want less, or 0
Env: TSM_TOKEN (the shared token; removed from the environment once read), TSM_DATA_DIR, TSM_HOST, TSM_PORT,
TSM_SESSION_OOM_SCORE_ADJ, TSM_DISK_FLOOR_BYTES;
the 1.x names SESSION_SERVER_HOST, SESSION_SERVER_PORT and SESSION_SERVER_TOKEN are read where those are not set.
Logs are JSON lines on stderr. Sessions start in $HOME unless given a cwd. The GUI is served at
http://<host>:<port>/ (add ?token=… when one is required).`;

async function main(): Promise<void> {
  // A reader that goes away (EPIPE) ends the stream, not the daemon, and is never written to again (tsg-5).
  process.stderr.on('error', () => {
    stderrGone = true;
  });
  process.stdout.on('error', () => undefined);
  const argv = process.argv.slice(2);
  const f = parseFlags(argv);
  if (f.help) {
    if (!stderrGone) process.stdout.write(HELP + '\n');
    return;
  }
  // An empty value is a mistake, not a setting: `--port ''` would have meant port 0 (any), `--host ''`
  // a bind on every address, `--data-dir ''` the working directory (the house's read of 59f660b, #22).
  for (const [name, value] of Object.entries(f)) {
    if (value === '' || (Array.isArray(value) && value.includes(''))) fail(`--${name} is empty: give it a value or leave it out (termd --help lists the flags)`);
  }
  const level = f['log-level'] ?? 'info';
  // Own keys only: `toString` is in every object (the house's read of 59f660b, #22).
  if (!Object.hasOwn(LEVELS, level)) fail(`--log-level must be one of ${Object.keys(LEVELS).join(', ')}`);
  minLevel = level as LogLevel;
  if (f['log-file'] !== undefined) {
    try {
      logFile = new RotatingFile(path.resolve(f['log-file']), 16 * 1024 * 1024, 2, (msg, fields) => log('warn', msg, fields));
    } catch (e) {
      fail(`cannot open --log-file ${f['log-file']}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }

  // Nothing but a signal ends the daemon: a stray exception is logged (a bounded number of
  // times), and the sessions live on. stderr's own failures never arrive here (its 'error'
  // listener and write()'s catch take them), so an EPIPE or ECONNRESET thrown by anything else
  // is a stray exception like any other, and no reason to stop logging (the house's read of 59f660b, #22).
  const stray = boundedLogger(50);
  process.on('uncaughtException', (e) => stray('uncaught exception (daemon keeps serving)', e));
  process.on('unhandledRejection', (e) => stray('unhandled rejection (daemon keeps serving)', e));

  // Resolved here: the integration builds launcher paths from it, and the shell starts in the session's cwd (the house's read of 1d83ffa).
  const dataDir = path.resolve(f['data-dir'] ?? setting('TSM_DATA_DIR') ?? path.join(os.homedir(), '.tsm'));
  // The 1.x names are read where the 2.0 ones are not set, so a daemon command written for 1.x
  // (connectome-host's setup guide: `--host localhost --headless`, SESSION_SERVER_PORT in the
  // unit) starts termd and says what it took from where (the house's review of #11).
  if (f.headless) log('info', "--headless is a 1.x flag: termd has no separate GUI server (the GUI is served at the daemon's own address), so it changes nothing");
  const oneX = (name: string, newName: string) => log('info', `using ${name} (a 1.x setting); ${newName} is the 2.0 name`);
  if (f.host === undefined && setting('TSM_HOST') === undefined && setting('SESSION_SERVER_HOST') !== undefined) oneX('SESSION_SERVER_HOST', 'TSM_HOST');
  if (f.port === undefined && setting('TSM_PORT') === undefined && setting('SESSION_SERVER_PORT') !== undefined) oneX('SESSION_SERVER_PORT', 'TSM_PORT');
  let host = (f.host ?? setting('TSM_HOST') ?? setting('SESSION_SERVER_HOST') ?? '127.0.0.1').trim();
  // `[::1]` is a URL's spelling of an IPv6 address; the bind wants it bare (the house's read of 59f660b, #22).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) fail('--host must be an address');
  const portSetting = (f.port ?? setting('TSM_PORT') ?? setting('SESSION_SERVER_PORT') ?? '3101').trim();
  const port = /^\d+$/.test(portSetting) ? Number(portSetting) : NaN;
  if (host.toLowerCase() === 'localhost') {
    // One address is bound, and a name resolves to one of two: on a host where localhost is
    // ::1 first, a daemon told `localhost` bound only [::1], and a client dialing 127.0.0.1 (the
    // shim's default) was refused. The IPv4 loopback is what every shipped config dials.
    log('info', '--host localhost binds 127.0.0.1 (the address the shipped configs dial); give --host ::1 for the IPv6 loopback');
    host = '127.0.0.1';
  }
  if (!Number.isInteger(port) || port > 65535) fail('--port must be an integer from 0 to 65535');
  const profile = (f.profile ?? 'core') as Profile;
  if (!PROFILES.includes(profile)) fail(`--profile must be one of ${PROFILES.join(', ')}`);
  const resultText = f['result-text'] ?? 'json';
  if (resultText !== 'json' && resultText !== 'transcript') fail('--result-text must be json or transcript');
  const allowHosts = (f['allow-host'] ?? []).flatMap((v) => v.split(',').map((x) => x.trim()).filter(Boolean));
  for (const h of allowHosts) {
    if (!parseAllowHost(h)) fail(`--allow-host ${JSON.stringify(h)} is not a host name (name, name:port, or an IP address)`);
  }
  const loopback = LOOPBACK_BINDS.has(host.toLowerCase());

  const tokensFile = f['tokens-file'];
  let tokens: Record<string, string> = {};
  if (tokensFile) {
    try {
      tokens = readTokensFile(tokensFile);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const tokenOnArgv = f.token !== undefined;
  if (f.token === undefined && setting('TSM_TOKEN') === undefined && setting('SESSION_SERVER_TOKEN') !== undefined) oneX('SESSION_SERVER_TOKEN', 'TSM_TOKEN');
  const shared = f.token ?? setting('TSM_TOKEN') ?? setting('SESSION_SERVER_TOKEN');
  // tsg-20: argv is world-readable (ps). With a token on it, say so. The process title is `termd`
  // and the port, and nothing a flag value could carry: a cleanup such as `pkill -f node` run from
  // a session would otherwise take a daemon whose data dir or host has "node" in its name, and
  // every principal's sessions with it (the house's review of #11; its read of 59f660b, #22).
  if (tokenOnArgv) log('warn', '--token on the command line is visible to every local user (ps); prefer TSM_TOKEN or --tokens-file');
  const title = (p: number) => {
    try {
      process.title = p ? `termd --port ${p}` : 'termd';
    } catch {
      // not settable here
    }
  };
  title(port);
  // G26: the daemon's credential is not part of any session's environment. Sessions and process
  // Runs inherit the daemon's env (G7's configured basis), so it leaves here, before any spawn:
  // otherwise every shell could `echo $TSM_TOKEN` and session_env_capture would journal it (jr-6).
  delete process.env.TSM_TOKEN;
  delete process.env.SESSION_SERVER_TOKEN;
  const anonymous = f.anonymous;
  if (!loopback) {
    // §12: a network bind needs a real credential and a named Host. `--anonymous` is not a
    // credential: it would hand every host on the network a principal that runs commands (tsg-6).
    if (anonymous !== undefined) fail(`refusing --anonymous on a non-loopback bind (${host}): every client on the network would get a principal that can run commands; give each client a token with --tokens-file`);
    if (!shared && !Object.keys(tokens).length) fail('refusing to bind a non-loopback address without a credential: use --tokens-file <f> (or TSM_TOKEN)');
    if (!allowHosts.length) {
      fail(`refusing to bind ${host} without --allow-host: name the host(s) clients will use (e.g. --allow-host ${host === '0.0.0.0' || host === '::' ? os.hostname() : host}), so DNS-rebinding pages are refused`);
    }
  }
  const resolverOpts: ConstructorParameters<typeof TokenMapResolver>[0] = { tokens };
  if (shared) resolverOpts.sharedToken = shared;
  if (anonymous) resolverOpts.anonymous = anonymous;
  const auth = shared || tokensFile ? (anonymous ? 'token+anonymous' : 'token') : anonymous ? 'anonymous' : 'loopback-open';
  if (!shared && !Object.keys(tokens).length && !anonymous) resolverOpts.anonymous = `token:local-${os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  let resolver: TokenMapResolver;
  try {
    resolver = new TokenMapResolver(resolverOpts);
  } catch (e) {
    fail((e as Error).message);
  }

  const groups = new OwnedProcessGroups(new NodePtyBackend());
  // A documented requirement, said once here rather than session by session (the house's review of
  // #11 and read of #22 comment 6269901528): without bash a shell would inherit other sessions'
  // terminals, so opening a session is refused, not only a process Run.
  const support = groups.processSupport();
  if (!support.ok) log('warn', 'this host cannot open sessions or run process Runs; both will be refused', { reason: support.reason });
  // Sessions opened without a cwd start in the home directory, never wherever the daemon
  // happened to be started (launchd: `/`; a shim: its host's project directory) (ux-16, tsg-3).
  const registryOpts: ConstructorParameters<typeof SessionRegistry>[0] = { dataDir, backend: groups, defaultCwd: os.homedir() };
  const shell = f.shell ?? process.env.SHELL;
  if (shell) registryOpts.defaultShell = shell;
  // Linux: sessions' shells and process Runs raise their oom_score_adj so the kernel takes a
  // build before the daemon, whose death loses every session. The preference counts against
  // every process on the machine, so a shared host may want less, or 0.
  // An empty TSM_SESSION_OOM_SCORE_ADJ is unset (the default), not 0; an empty flag value is an error like any other.
  const oomSetting = f['session-oom-score-adj'] ?? setting('TSM_SESSION_OOM_SCORE_ADJ') ?? '200';
  const oomAdj = /^\d+$/.test(oomSetting.trim()) ? Number(oomSetting) : NaN;
  if (!Number.isInteger(oomAdj) || oomAdj < 0 || oomAdj > 1000) fail('--session-oom-score-adj must be an integer from 0 to 1000');
  registryOpts.sessionOomScoreAdj = oomAdj;
  // G21: nothing is deleted by default; these flags set daemon-wide limits, and a session may set its own at creation.
  const retention: NonNullable<typeof registryOpts.retention> = {};
  const rb = f['retention-bytes'];
  const ra = f['retention-days'];
  if (rb !== undefined) {
    const n = Number(rb);
    if (!Number.isFinite(n) || n < 16 * 1024) fail('--retention-bytes must be a number of bytes, at least 16384');
    retention.maxBytes = n;
  }
  if (ra !== undefined) {
    const n = Number(ra);
    if (!Number.isFinite(n) || n <= 0) fail('--retention-days must be a positive number');
    retention.maxAgeMs = n * 24 * 3600 * 1000;
  }
  if (rb !== undefined || ra !== undefined) registryOpts.retention = retention;
  // A cap bounds one session; the floor bounds the machine (the house's review of #11, shell tools
  // 4). Below it, journals keep their ring and leave the disk alone until space returns.
  const floorSetting = f['disk-floor-bytes'] ?? setting('TSM_DISK_FLOOR_BYTES') ?? String(200 * 1024 * 1024);
  const floor = /^\d+$/.test(floorSetting.trim()) ? Number(floorSetting) : NaN;
  if (!Number.isInteger(floor) || floor < 0) fail('--disk-floor-bytes must be a whole number of bytes (0 turns the floor off)');
  if (floor > 0) registryOpts.diskFloorBytes = floor;
  registryOpts.log = (level, text, fields) => log(level, text, fields);

  // The port first, then the data dir's lock, then recovery (see the header).
  let held: HeldPort | undefined;
  try {
    held = await holdPort(host, port);
  } catch (e) {
    fail(`cannot listen on ${host}:${port}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}${(e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? ' (another termd?); the data dir was not touched' : ''}`);
  }
  let registry: SessionRegistry;
  try {
    registry = new SessionRegistry(registryOpts);
  } catch (e) {
    // src/core/lock.ts: another daemon holds this data dir. Recovery never ran, so its journals are untouched.
    if ((e as { code?: unknown }).code === 'data_dir_locked') fail(`another termd is using the data dir ${dataDir}; not starting (${(e as Error).message})`, 1);
    throw e;
  }
  for (const e of registry.recoveryErrors) log('warn', 'a journal could not be recovered', { session: e.id, error: e.error });
  // Age-based retention runs hourly; it never keeps the process alive.
  setInterval(() => {
    registry.expire().then(
      (gone) => gone.length && log('info', 'history expired', { sessions: gone }),
      (e: unknown) => log('warn', 'retention sweep failed', { error: errText(e) }),
    );
  }, 3600_000).unref();
  const app = new App({ registry });

  // Run lifecycle in the log (§15), without command lines: the journal has those.
  const watched = new Map<string, () => void>();
  const watch = (id: string) => {
    const s = registry.get(id);
    if (!s || s.kind !== 'live') return;
    watched.get(id)?.();
    watched.set(
      id,
      s.session.journal.subscribe((ev: JournalEvent) => {
        if (ev.type === 'run.admit') log('info', 'run admitted', { session: id, runId: ev.runId, target: ev.target, principal: ev.principal, origin: ev.origin, queued: ev.queued });
        else if (ev.type === 'run.end') log('info', 'run ended', { session: id, runId: ev.runId, state: ev.state, exit: ev.exit, signal: ev.signal, reason: ev.reason, durationMs: ev.durationMs });
        else if (ev.type === 'session.exit') log('info', 'session shell exited', { session: id, code: ev.code, signal: ev.signal });
        else if (ev.type === 'control') log('info', 'seat changed', { session: id, controller: ev.controller, by: ev.by, how: ev.how });
      }),
    );
  };
  registry.onChange((c) => {
    if (c.type === 'created') {
      watch(c.id);
      log('info', 'session created', { session: c.id });
      return;
    }
    watched.get(c.id)?.();
    watched.delete(c.id);
    // `closed`: the shell ended and the history stays listed (`closed: true`); `removed`: the entry
    // and its files are gone. Two events, two lines (the house's read of 59f660b, #22).
    log('info', c.type === 'closed' ? 'session closed' : 'session removed', { session: c.id });
  });

  // §16 Measure: one JSON line per tools/call (the GUI's successful read-only calls excepted:
  // transport/server.ts), owner-only, rotated by size keeping USAGE_GENERATIONS old files (16 MiB
  // each) so a week of traces fits. A write error disables it; it never breaks a call.
  let usage: RotatingFile | undefined;
  if (!f['no-usage-log']) {
    const file = path.resolve(f['usage-log'] ?? path.join(dataDir, 'usage.jsonl'));
    try {
      usage = new RotatingFile(file, 16 * 1024 * 1024, USAGE_GENERATIONS, (msg, fields) => log('warn', msg, fields));
    } catch (e) {
      log('warn', 'usage log unavailable', { file, error: (e as Error).message });
    }
  }
  const usageFile = usage?.file;

  const serverOpts: ConstructorParameters<typeof TermServer>[0] = {
    app,
    resolver,
    host,
    port,
    profile,
    resultText,
    version: version(),
    logger: write,
    allowHosts,
  };
  if (usage) {
    serverOpts.usage = {
      record(r) {
        try {
          usage?.write(JSON.stringify(r) + '\n');
        } catch (e) {
          log('warn', 'usage log disabled after a write error', { file: usageFile, error: (e as Error).message });
          usage?.close();
          usage = undefined;
        }
      },
    };
  }
  const server = new TermServer(serverOpts);
  let bound: { host: string; port: number };
  try {
    // The endpoint listens on the held socket itself (the port is never unbound in between),
    // then answers the connections that waited through recovery.
    bound = await server.listen(held?.server);
    for (const sock of held?.parked.splice(0) ?? []) server.adopt(sock);
  } catch (e) {
    fail(`cannot listen on ${host}:${port}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  title(bound.port); // port 0: the one the kernel gave
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      log('warn', 'second signal: exiting now', { signal });
      groups.signalAll('SIGKILL');
      process.exit(1);
    }
    stopping = true;
    log('info', 'shutting down', { signal });
    // Socket teardown is bounded (~1 s) and runs beside the session drain, so no client can delay it (sec-7).
    const serverClosed = server.close();
    // The reason reaches every Run the drain ends (G20's wording for a restart).
    await withTimeout(
      registry.closeAll({ reason: 'daemon-shutdown' }).catch((e: unknown) => log('error', 'session drain failed', { error: errText(e) })),
      10_000,
    );
    const killed = await groups.drain(1000);
    if (killed) log('warn', 'killed process groups that outlived their sessions', { count: killed });
    await withTimeout(serverClosed, 3000);
    usage?.close();
    log('info', 'stopped');
    logFile?.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));
  // Last resort on every exit path the process still runs through: no process Run's group survives
  // it. (A SIGKILL runs nothing; the next start's recovery ends those groups.)
  process.on('exit', () => groups.signalAll('SIGKILL'));

  // Supervisors may stop us as soon as readiness is visible. Install the drain
  // and last-resort cleanup before publishing that boundary.
  const recovered = registry.list().filter((s) => s.kind === 'history').length;
  const urlHost = bound.host.includes(':') ? `[${bound.host}]` : bound.host;
  log('info', 'listening', {
    version: version(),
    url: `ws://${urlHost}:${bound.port}`,
    gui: `http://${urlHost}:${bound.port}/`,
    dataDir,
    auth,
    allowHosts: allowHosts.length ? allowHosts : undefined,
    recovered: recovered || undefined,
    usageLog: usageFile,
    logFile: logFile?.file,
    pid: process.pid,
  });
}

main().catch((e) => {
  log('error', 'fatal', { error: errText(e) });
  process.exit(1);
});
