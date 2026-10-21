/**
 * The daemon's one endpoint (§12): JSON-RPC 2.0 over WebSocket with two method
 * families — MCP+MCPL (tools, channels, manifest, policy) and `terminal/*` (the
 * native family for the GUI and CLI: subscribe, attach, detach) — plus `/health`
 * and the GUI's static files over HTTP. Every connection is a caller with its
 * own attachments, cursors and MCPL lane.
 *
 * Who may talk to it. Checked on every HTTP request and every upgrade, in this
 * order, before anything else runs:
 *  1. Host must name this daemon: `localhost`, `127.0.0.1` or `[::1]` (and the
 *     bind address when it is a specific one) with our port or none, or a name
 *     given with `--allow-host` (required for non-loopback binds). Anything else
 *     is 421: a DNS-rebinding page sends its own name, so it never gets through.
 *  2. Origin, when present, must be same-origin with that allowed Host — that is
 *     our own GUI. Any other Origin is 403. The browser's same-origin policy does
 *     not cover WebSocket connects, so without this any page the user visits could
 *     drive their shells (cross-site WebSocket hijacking). No Origin at all means a
 *     non-browser client (shim, CLI, agent hosts); a page cannot send none.
 *  3. The credential: `?token=` or `Authorization: Bearer` resolves to a principal
 *     (§4.5), or 401. A same-origin browser connection is the GUI's human: its
 *     principal is `human:gui:<token principal>` (unchanged when the token's
 *     is already `human:…`).
 *
 * Loopback names are served on any port while the bind is loopback: a port
 * forward (`ssh -L 13101:127.0.0.1:3101`) changes the port, and pinning it adds
 * nothing against DNS rebinding, whose Host is always the attacker's own name
 * (tsg-12). A refused Host is told which flag serves it (`--allow-host`).
 *
 * Nothing a client sends can take the daemon down: every frame is classified
 * before use (null, batches, primitives and bad ids get JSON-RPC errors), every
 * entry point is guarded (upgrade, message, HTTP, continuations), frames are
 * capped (`maxPayload`), and work in flight per connection is bounded —
 * notifications included; a `tools/call` or `terminal/*` sent as a notification
 * is not executed at all, since nobody could learn its outcome (tsg-14).
 * Connections are bounded per daemon and per principal; one that sends nothing
 * is closed after `pendingTimeoutMs`; and every connection is pinged, so a peer
 * that vanished without a FIN (a laptop lid) is terminated and its seat goes
 * through the §9 grace instead of being held forever (tsg-19).
 * Connection identity is generated here; the client's `?connection=` is only a
 * sanitized label for logs and usage, so no client can detach another's
 * attachments or seat by reusing its name.
 *
 * Logs are JSON lines with fixed fields (ts, level, msg, connection, principal,
 * session, runId, …); client strings only ever appear JSON-encoded and
 * length-limited, and tokens never appear at all (G26).
 */
import { isSessionId } from '../api/registry.js';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { commitReadDelivery, type App, type Caller } from '../api/app.js';
import { guiPrincipal, type PrincipalResolver } from '../api/principals.js';
import type { AnySession, HistorySession, LiveSession } from '../api/registry.js';
import { callTool, TOOLS, toolsFor, type Profile, type ResultText, type ToolDef, type ToolResult } from '../api/tools.js';
import { clipField, newUsageKey, usageDigest, type UsageRecord } from '../api/usage.js';
import { clocks } from '../core/clock.js';
import { err, TermError } from '../core/errors.js';
import type { Principal, Seq } from '../core/types.js';
import { Follower, type JournalSource } from './follower.js';
import { classify, INTERNAL, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, OVERLOADED, Outbound, PARSE_ERROR, RpcError, type Id, type Message, type Request } from './jsonrpc.js';
import { manifest, McplLane } from './mcpl.js';
import { StaticFiles } from './static.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One structured log line (§15). Fields beyond these are event-specific. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  connection?: string;
  label?: string;
  principal?: Principal;
  session?: string;
  runId?: string;
  [field: string]: unknown;
}

export type { UsageRecord };

/** The tool profiles plain MCP connections may ask for (§11). */
export const PROFILES: readonly Profile[] = ['core', 'full', 'compat'];

export interface ServerOptions {
  app: App;
  resolver: PrincipalResolver;
  host?: string;
  port?: number;
  /** Tool profile for plain MCP hosts; MCPL hosts are governed by their grant. */
  profile?: Profile;
  resultText?: ResultText;
  version?: string;
  /** Receives each log record as a JSON line (used when `logger` is absent). */
  log?: (line: string) => void;
  /** Receives each log record. */
  logger?: (r: LogRecord) => void;
  /** Host names (optionally `name:port`) served besides the loopback names. */
  allowHosts?: string[];
  /** Largest accepted WebSocket frame in bytes (default 4 MiB). */
  maxPayload?: number;
  /** Most simultaneous connections (default 512). */
  maxConnections?: number;
  /** Most simultaneous connections for one principal (default a quarter of maxConnections), so one client cannot lock everyone out. */
  maxConnectionsPerPrincipal?: number;
  /** A connection that sends no frame within this long is closed (default 30 000 ms; 0 disables). */
  pendingTimeoutMs?: number;
  /** WebSocket ping interval; a peer that has not answered the previous ping is terminated (default 30 000 ms; 0 disables). */
  heartbeatMs?: number;
  /** Most requests being processed at once on one connection (default 128). */
  maxInFlight?: number;
  /** Native subscriptions stop sending past this many queued bytes (default 1 MiB); see follower.ts. */
  highWaterBytes?: number;
  /** How long close() waits for clients to finish the closing handshake before terminating them (default 1000 ms). */
  shutdownGraceMs?: number;
  /** Called for every tools/call except the GUI's successful read-only calls, which are its own bookkeeping (§16 Measure, tsg-16). */
  usage?: { record(r: UsageRecord): void };
  /** The daemon's data dir, which /health tells a caller that has a principal and a loopback peer address (see health). */
  dataDir?: string;
}

/** A loopback peer address: the IPv4 loopback range or ::1, as a dual-stack socket also shows them. */
const loopbackPeer = (address: string | undefined): boolean => address !== undefined && (address === '::1' || /^(::ffff:)?127\./.test(address));

/** An attach of one session waiting on its snapshot or transcript; `gen` moves when terminal/detach arrives meanwhile (tsg-4). */
interface AttachWait {
  gen: number;
  waiting: number;
}

type ConnKind = 'pending' | 'mcp' | 'mcpl' | 'native' | 'gui' | 'cli';

interface Conn {
  /** Server-generated, unique: the identity attachments are keyed by. */
  id: string;
  /** The principal the credential resolved to (before the GUI mapping): what the per-principal bound counts. */
  credential: Principal;
  /** The client's `?connection=`, sanitized; for logs and usage only. */
  label: string | undefined;
  ws: WebSocket;
  caller: Caller;
  out: Outbound;
  lane: McplLane | null;
  profile: Profile;
  resultText: ResultText;
  initialized: boolean;
  /** A same-origin browser: the GUI. */
  gui: boolean;
  /** What this connection is: pending until initialize, then an MCP or MCPL host, the GUI, the tsm CLI (`?client=cli`), or a native client. The GUI and the CLI are the native family in usage records, not agent surfaces (the house's read of 4e37a11, #22). */
  kind: ConnKind;
  followers: Map<string, Follower>;
  /**
   * Attaches waiting on their snapshot, by session, so a terminal/detach meanwhile stops them attaching
   * after it. An entry lives only while an attach waits (the in-flight bound caps them), so a detach
   * naming a session that does not exist leaves nothing behind (the house's read of 2f357bd, #22).
   */
  attaching: Map<string, AttachWait>;
  inFlight: number;
  /** Set first thing in onClose: an await that resumes after it must not attach anything (tsg-4). */
  closed: boolean;
  /** How it closed: on purpose (1000/1001) gives up seats at once, a drop keeps them through the grace (§9). */
  closedClean: boolean;
  /** Any frame arrived (the pending timeout is off). */
  seenFrame: boolean;
  /** Answered the last ping (or sent something since). */
  alive: boolean;
  pendingTimer: NodeJS.Timeout | undefined;
  /** Asked for registry changes (`terminal/sessions {watch: true}`): the GUI's list, pushed rather than polled (tsg-16). */
  watchSessions: boolean;
}

export const LOOPBACK_BINDS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const WILDCARD_BINDS = new Set(['', '0.0.0.0', '::', '[::]']);
/** A bracketed IPv6 literal, or dot-separated labels (underscores allowed: container service names use them). */
const HOST_NAME = /^(\[[0-9a-f:.]+\]|[a-z0-9_][a-z0-9_-]{0,62}(\.[a-z0-9_][a-z0-9_-]{0,62})*)$/;

interface HostPattern {
  name: string;
  /** When set, only this port; otherwise our port or none. */
  port: string | undefined;
  /** Any port at all (loopback names on a loopback bind: port forwards change the port, tsg-12). */
  anyPort?: boolean;
}

/** Parse a Host header (or an --allow-host entry) into a lower-cased name and optional port. */
function parseHost(value: string): HostPattern | undefined {
  const v = value.trim().toLowerCase();
  if (!v || v.length > 260) return undefined;
  let name: string;
  let port: string | undefined;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end === -1) return undefined;
    name = v.slice(0, end + 1);
    const rest = v.slice(end + 1);
    if (rest !== '') {
      if (!/^:\d{1,5}$/.test(rest)) return undefined;
      port = rest.slice(1);
    }
  } else {
    const i = v.lastIndexOf(':');
    if (i === -1) name = v;
    else {
      name = v.slice(0, i);
      port = v.slice(i + 1);
      if (!/^\d{1,5}$/.test(port)) return undefined;
    }
  }
  if (!HOST_NAME.test(name)) return undefined;
  return { name, port };
}

/** An --allow-host entry (or a bind address): a bare IPv6 literal has several colons and no brackets; anything else parses as given. */
export const parseAllowHost = (v: string): HostPattern | undefined => parseHost((v.match(/:/g)?.length ?? 0) > 1 && !v.includes('[') ? `[${v}]` : v);

/** Keep a client-chosen label to a safe alphabet and length. */
function sanitizeLabel(v: string | null): string | undefined {
  if (v === null || v === '') return undefined;
  return v.replace(/[^A-Za-z0-9._:@-]/g, '_').slice(0, 64);
}

/** Client strings in log fields: bounded; JSON encoding does the escaping. */
function clip(v: unknown, n = 200): unknown {
  return typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v;
}

/** The presented token: `?token=` or `Authorization: Bearer`. */
function tokenOf(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  return url.searchParams.get('token') ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
}

function parseUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? '/', 'http://localhost');
  } catch {
    return undefined;
  }
}

/** Answer an upgrade we will not accept, on the raw socket (`body` says what to do about it). */
function refuse(socket: Duplex, status: number, text: string, body = text): void {
  try {
    if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch {
    // the peer is gone
  }
  socket.destroy();
}

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...extra });
  res.end(text);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A session name as the registry admits one, checked here too so nothing keyed by a name grows with what a client sends. */
function sessionParam(p: Record<string, unknown>): string {
  if (typeof p.session !== 'string' || !isSessionId(p.session)) throw new RpcError(INVALID_PARAMS, 'session must be 1 to 64 characters of letters, digits, dot, underscore or dash, starting with a letter or digit');
  return p.session;
}

const DIGEST_KEYS = ['command', 'text', 'keys', 'input'] as const;
/** Every tool name the daemon serves, on any profile or lane: anything else is recorded as `(unknown)`. */
const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));
/** Tools that change nothing: from the GUI they are its own bookkeeping, not use to measure (§16, tsg-16). */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['session_list', 'screen', 'read', 'search', 'watches', 'listSessions', 'tailLogs', 'searchLogs']);
/** Close code for a connection that never sent anything (policy violation). */
const CLOSE_IDLE = 1008;
/** A history attach reads this many lines of the end of the journal and carries at most this many. */
const TRANSCRIPT_READ_LINES = 5000;
const TRANSCRIPT_LINES = 3000;
const MISDIRECTED = 'misdirected request: this Host is not served here; start termd with --allow-host <host:port> to serve it';

export class TermServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly opts: ServerOptions;
  private readonly statics: StaticFiles;
  /** When this endpoint was built, on the monotonic clock: `/health`'s uptime is an elapsed time inside one process, which a wall-clock step must not move or make negative (the house's read of the 33 commits, #22, comment 6307351372). It counts from here, after the daemon's startup and its sessions' recovery, so it reads less than the time since termd started, and the more so after a sleep, since that clock does not advance while the host is suspended. */
  private readonly startedAt = clocks.monotonic();
  private offRegistry: (() => void) | undefined;
  private allowed: HostPattern[] = [];
  private boundPort = 0;
  private closing: Promise<void> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  /** The usage digests' HMAC key: random, in memory only, so digests compare within this daemon run and nowhere else (atc-4). */
  private readonly usageKey = newUsageKey();

  constructor(opts: ServerOptions) {
    this.opts = opts;
    // A GUI file that cannot be read is a broken install: the operator's log says which (the house's read of 2f357bd, #22).
    this.statics = new StaticFiles({ onError: (pathname, file, error) => this.emit('warn', 'GUI asset unavailable', { path: pathname, file, error }) });
    this.http = createServer((req, res) => this.onHttp(req, res));
    this.http.on('clientError', (_e, socket) => refuse(socket, 400, 'Bad Request'));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? 4 * 1024 * 1024 });
    this.http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => undefined);
      try {
        this.onUpgrade(req, socket, head);
      } catch (e) {
        this.emit('error', 'upgrade failed', { error: errText(e) });
        refuse(socket, 400, 'Bad Request');
      }
    });
    this.offRegistry = opts.app.registry.onChange((c) => {
      const s = opts.app.registry.get(c.id);
      for (const conn of this.conns) {
        try {
          const visible = s !== undefined && opts.app.can(conn.caller.principal, s, 'observe');
          // The name only to a principal that may see the session (G18); anyone else just re-lists.
          if (conn.watchSessions) conn.out.notify('terminal/sessionsChanged', visible ? { type: c.type, session: c.id } : { type: c.type });
          const f = conn.followers.get(c.id);
          if (f && c.type === 'created') {
            if (!visible) {
              // The new life is one this principal may not observe (reopened private, G18): nothing of
              // the name flows to it any more, and it is told the stream ended (the house's read of 2f357bd, #22).
              this.unfollow(conn, c.id);
              conn.out.notify('terminal/closed', { session: c.id, reason: 'forbidden' });
            } else if (s?.kind === 'live' && f.source !== s.session.journal && !f.ending) {
              // A history-only session given a new life continues the same seq numbering in a
              // new journal: follow it from the same cursor, so the stream goes on with no hole.
              // One still delivering the closed life's end is left to finish, and ends with it.
              this.startFollower(conn, c.id, this.follow(conn, c.id, s.session.journal, f.cursor));
            }
          } else if (f && c.type === 'closed') {
            // The stream ends with the session, but only once everything retained has been delivered:
            // a subscriber paused at a full socket still gets the end of the life, its exit included
            // (the house's read of 2f357bd, #22).
            f.onceCaughtUp(() => {
              if (conn.followers.get(c.id) !== f) return;
              this.unfollow(conn, c.id);
              conn.out.notify('terminal/closed', { session: c.id, reason: 'session-closed' });
            });
          } else if (f) {
            // Removed: its journal is gone, and the subscriber is told so.
            this.unfollow(conn, c.id);
            conn.out.notify('terminal/closed', { session: c.id, reason: 'session-removed' });
          }
          if (!conn.lane) continue;
          if (c.type === 'created') {
            if (visible) conn.lane.sessionCreated(c.id);
          } else {
            const failed = (e: unknown) => this.emit('error', 'lane change handler failed', { ...this.connFields(conn), session: c.id, error: errText(e) });
            (c.type === 'closed' ? conn.lane.sessionClosed(c.id) : conn.lane.sessionRemoved(c.id)).catch(failed);
          }
        } catch (e) {
          this.emit('error', 'registry change handler failed', { ...this.connFields(conn), session: c.id, error: errText(e) });
        }
      }
    });
  }

  /**
   * Start listening: on `handle`, the bound socket the daemon held while it recovered
   * (daemon.ts), so the port is never unbound between the hold and the endpoint — in that
   * gap connections were refused, and a shim that is refused starts a daemon of its own (the
   * house's review of #11, API 3); otherwise on the configured host and port.
   */
  listen(handle?: NetServer): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      const listening = (): void => {
        this.boundPort = (this.http.address() as AddressInfo).port;
        this.allowed = this.hostPatterns(host);
        this.startHeartbeat();
        resolve({ host, port: this.boundPort });
      };
      if (handle) this.http.listen(handle, listening);
      else this.http.listen(this.opts.port ?? 3101, host, listening);
    });
  }

  /** Serve a connection accepted while the port was held, its first bytes still unread: it is answered as if it had arrived now. */
  adopt(socket: Socket): void {
    if (socket.destroyed) return;
    this.http.emit('connection', socket);
    socket.resume();
  }

  /** The Host allowlist: loopback names (on a loopback bind, any port: see the header), a specific bind address, and --allow-host entries. */
  private hostPatterns(bind: string): HostPattern[] {
    const b = bind.toLowerCase();
    const anyPort = LOOPBACK_BINDS.has(b);
    const out: HostPattern[] = ['localhost', '127.0.0.1', '[::1]'].map((name) => ({ name, port: undefined, anyPort }));
    if (!WILDCARD_BINDS.has(b) && !LOOPBACK_BINDS.has(b)) {
      const p = parseAllowHost(b);
      if (p) out.push({ name: p.name, port: undefined });
    }
    for (const entry of this.opts.allowHosts ?? []) {
      const p = parseAllowHost(entry);
      if (p) out.push(p);
      else this.emit('warn', 'ignoring an --allow-host entry that is not a host name', { entry: clip(entry) });
    }
    return out;
  }

  /** The Host header's value when it names this daemon, else undefined. */
  private allowedHost(header: string | undefined): string | undefined {
    if (typeof header !== 'string') return undefined;
    const h = parseHost(header);
    if (!h) return undefined;
    const ours = String(this.boundPort);
    for (const a of this.allowed) {
      if (a.name !== h.name) continue;
      if (a.anyPort || (a.port !== undefined ? h.port === a.port : h.port === undefined || h.port === ours)) return header.trim().toLowerCase();
    }
    return undefined;
  }

  /** `none`: no Origin (not a browser). `same`: our own GUI. `refused`: any other page. */
  private originOf(origin: string | undefined, host: string): 'none' | 'same' | 'refused' {
    if (origin === undefined) return 'none';
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return 'refused';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'refused';
    return u.host === host ? 'same' : 'refused';
  }

  /** Stop accepting, close every connection (terminating stragglers after the grace), and release the port. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.offRegistry?.();
      if (this.heartbeat) clearInterval(this.heartbeat);
      const httpClosed = new Promise<void>((r) => this.http.close(() => r()));
      for (const c of this.conns) {
        for (const f of c.followers.values()) f.close();
        try {
          c.ws.close(1001, 'server shutting down');
        } catch {
          c.ws.terminate();
        }
      }
      const grace = this.opts.shutdownGraceMs ?? 1000;
      // Measured on the monotonic clock, so a backward wall-clock step cannot stretch the wait (#22).
      const until = clocks.monotonic() + grace;
      while (this.conns.size > 0 && clocks.monotonic() < until) await new Promise((r) => setTimeout(r, 20));
      // A client that never answers the close frame does not hold the daemon hostage (sec-7).
      for (const c of this.conns) c.ws.terminate();
      await new Promise<void>((r) => this.wss.close(() => r()));
      this.http.closeAllConnections();
      await Promise.race([httpClosed, new Promise((r) => setTimeout(r, grace).unref())]);
    })();
    return this.closing;
  }

  // ───────────────────────────── logging and usage ─────────────────────────────

  private emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const rec: LogRecord = { ts: new Date().toISOString(), level, msg };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) rec[k] = clip(v);
    try {
      if (this.opts.logger) this.opts.logger(rec);
      else this.opts.log?.(JSON.stringify(rec));
    } catch {
      // a broken log sink is not the endpoint's problem
    }
  }

  private connFields(conn: Conn): Record<string, unknown> {
    return { connection: conn.id, label: conn.label, principal: conn.caller.principal, kind: conn.kind };
  }

  /**
   * One usage record (§16) and one log line per tools/call. The record keeps names, ids,
   * states and a keyed digest, each string clipped; a tool the daemon does not serve is
   * `(unknown)` with a clipped copy of the name (atc-18); input marked sensitive gets no
   * digest (G26, atc-4). The GUI's read-only calls are its own bookkeeping: logged at
   * debug and not recorded, so an open tab does not swamp the measurement (tsg-16).
   */
  private afterToolCall(conn: Conn, tool: string, args: unknown, r: ToolResult, ms: number): void {
    const a = isObj(args) ? args : {};
    const s: Record<string, unknown> = r.structured ?? {};
    const known = TOOL_NAMES.has(tool);
    const rec: UsageRecord = {
      ts: Date.now(),
      principal: clipField(conn.caller.principal, 256),
      connection: conn.label ?? conn.id,
      host: conn.lane ? 'mcpl' : conn.kind === 'mcp' || conn.kind === 'pending' ? 'mcp' : 'native',
      profile: conn.profile,
      tool: known ? tool : '(unknown)',
      ok: !r.isError,
      ms,
      args: Object.keys(a)
        .sort()
        .slice(0, 32)
        .map((k) => clipField(k, 64)),
    };
    if (!known) rec.requested = clipField(tool, 64);
    if (r.isError) {
      // The code is the envelope's `error`, or the `code: message` prefix of an error result's text.
      const code = typeof s.error === 'string' ? s.error : /^([a-z][a-z0-9_]{0,63}):/.exec(r.text)?.[1];
      if (code) rec.error = clipField(code, 64);
    }
    // The session the call named, else the one its result reported (`await {runId}` names none).
    const session = typeof a.session === 'string' ? a.session : typeof s.session === 'string' ? s.session : undefined;
    if (session !== undefined) rec.session = clipField(session);
    if (typeof s.runId === 'string' && s.runId) rec.runId = clipField(s.runId, 64);
    else if (typeof a.runId === 'string') rec.runId = clipField(a.runId, 64);
    if (typeof s.state === 'string') rec.state = clipField(s.state, 32);
    const busy = isObj(s.busy) ? s.busy : undefined;
    if (busy && typeof busy.runId === 'string') rec.blockedBy = clipField(busy.runId, 64);
    if (typeof a.wait === 'number' && Number.isFinite(a.wait)) rec.wait = a.wait;
    if (a.sensitive === true) rec.sensitive = true;
    else {
      const typed = DIGEST_KEYS.filter((k) => a[k] !== undefined).map((k): [string, unknown] => [k, a[k]]);
      if (typed.length) rec.digest = usageDigest(this.usageKey, typed);
    }
    const bookkeeping = conn.gui && READ_ONLY_TOOLS.has(tool) && rec.ok;
    if (!bookkeeping) {
      try {
        this.opts.usage?.record(rec);
      } catch (e) {
        this.emit('warn', 'usage sink failed', { error: errText(e) });
      }
    }
    this.emit(!rec.ok ? 'warn' : bookkeeping ? 'debug' : 'info', 'tool call', {
      ...this.connFields(conn),
      tool: rec.tool,
      requested: rec.requested,
      session: rec.session,
      runId: rec.runId,
      state: rec.state,
      ok: rec.ok,
      error: rec.error,
      ms,
    });
  }

  // ───────────────────────────── HTTP ─────────────────────────────

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    try {
      this.handleHttp(req, res);
    } catch (e) {
      this.emit('error', 'http handler failed', { error: errText(e) });
      if (res.headersSent) res.end();
      else plain(res, 500, 'internal error');
    }
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const host = this.allowedHost(req.headers.host);
    if (!host) {
      this.emit('warn', 'request refused: Host not served (serve it with --allow-host)', { status: 421, host: clip(req.headers.host), remote: req.socket.remoteAddress });
      return plain(res, 421, MISDIRECTED);
    }
    if (this.originOf(req.headers.origin, host) === 'refused') {
      this.emit('warn', 'request refused: cross-origin', { status: 403, origin: clip(req.headers.origin), remote: req.socket.remoteAddress });
      return plain(res, 403, 'cross-origin requests are refused');
    }
    const url = parseUrl(req.url);
    if (!url) return plain(res, 400, 'bad request');
    if (url.pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      return this.health(req, res, url);
    }
    if (!this.statics.serve(req, res, url.pathname, host)) plain(res, 404, 'not found');
  }

  /**
   * §15: per-session state, backend, controller, integration, the current Run,
   * retention, and connections by kind. /health sees what a WebSocket connection
   * with the same credential would (G18): a presented token must be valid (else
   * 401) and scopes the sessions to what its principal may observe; without one,
   * the daemon's anonymous principal when it has one (a loopback daemon without
   * tokens). A daemon that requires a credential tells an unauthenticated caller
   * only that it is alive, with counts — never another agent's private sessions
   * (tsg-17). History sessions report `closed` or `recovered`, their retention and
   * oldest seq (G20, G21; jr2-14). A caller that has a principal and a loopback peer
   * address is also told the data dir.
   */
  private health(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const token = tokenOf(req, url);
    let viewer: Principal | undefined;
    if (token) {
      viewer = this.opts.resolver.resolve(token);
      if (!viewer) return plain(res, 401, 'unauthorized');
    } else viewer = this.opts.resolver.resolve(undefined);
    const app = this.opts.app;
    const all = app.registry.list();
    const byKind: Record<ConnKind, number> = { pending: 0, mcp: 0, mcpl: 0, native: 0, gui: 0, cli: 0 };
    for (const c of this.conns) byKind[c.kind]++;
    const recoveryErrors = app.registry.recoveryErrors;
    const body: Record<string, unknown> = {
      status: 'ok',
      version: this.opts.version ?? 'dev',
      pid: process.pid,
      uptimeMs: Math.round(clocks.monotonic() - this.startedAt),
      connections: { total: this.conns.size, ...byKind },
      sessionCount: all.length,
    };
    // A host without bash or a working /dev/fd keeps serving history, the GUI and the lane, but opens
    // no session and runs no process Run: said here at any time after startup, with the refusal's own
    // reason, to every caller, since it names no one's sessions (the house's answers, #22 comment
    // 6275033749: /health answered "ok" with nothing about it, and the startup warning is one line).
    const support = app.registry.processSupport();
    if (!support.ok) {
      body.status = 'degraded';
      body.unsupported = support.reason;
    }
    if (viewer !== undefined) {
      const who = viewer;
      body.sessions = all.filter((s) => app.can(who, s, 'observe')).map((s) => this.healthOf(s));
      // Recovery errors name sessions whose owner is unknown: details only where no credential separates anyone.
      body.recoveryErrors = this.opts.resolver.open ? recoveryErrors.map((e) => ({ session: e.id, error: clip(e.error) })) : recoveryErrors.length;
      // A supervisor's shim asks a running termd which data dir it uses, since the unit's text may have
      // changed since it started (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question
      // 1). A local path, so told only to a caller with a principal whose peer address is loopback, which is all
      // the gate checks (the house's read of the 17 commits over our fixes, #22).
      if (this.opts.dataDir !== undefined && loopbackPeer(req.socket.remoteAddress)) body.dataDir = this.opts.dataDir;
    } else body.detail = 'present a token (?token= or Authorization: Bearer) for sessions';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  }

  private healthOf(s: AnySession): Record<string, unknown> {
    if (s.kind !== 'live') {
      // A closed session is closed, not recovered from a crash (App.summary says the same).
      const out: Record<string, unknown> = { id: s.id, state: 'exited', owner: s.owner, visibility: s.visibility, lastSeq: s.lastSeq };
      if (s.closed) out.closed = true;
      else out.recovered = s.recovered;
      out.oldestSeq = s.journal.oldestSeq ?? null;
      // The entry's view of it (App.retentionOf): what the store applies, and the record's while recovery owes a judgement.
      Object.assign(out, this.opts.app.retentionOf(s));
      return out;
    }
    const i = s.session.info();
    let currentRun: Record<string, unknown> | null = null;
    if (i.currentRun) {
      try {
        const r = s.session.run(i.currentRun);
        currentRun = { runId: r.runId, state: r.state, target: r.target, principal: r.principal };
      } catch {
        currentRun = { runId: i.currentRun };
      }
    }
    // Everything the session reports about itself (state, backend, integration, controller, and
    // whatever pressure or retention figures it grows), plus the current Run and the retained range.
    return {
      ...i,
      currentRun,
      oldestSeq: s.session.journal.oldestSeq ?? null,
      ...this.opts.app.retentionOf(s),
      journal: s.session.journal.stats(),
      screen: { backlog: s.session.screen.backlog, droppedUnits: s.session.screen.droppedUnits },
    };
  }

  // ───────────────────────────── upgrade and connections ─────────────────────────────

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = req.socket.remoteAddress;
    if (this.closing) return refuse(socket, 503, 'Service Unavailable');
    const url = parseUrl(req.url);
    if (!url) {
      this.emit('warn', 'upgrade refused: malformed request target', { status: 400, remote });
      return refuse(socket, 400, 'Bad Request');
    }
    const host = this.allowedHost(req.headers.host);
    if (!host) {
      this.emit('warn', 'upgrade refused: Host not served (serve it with --allow-host)', { status: 421, host: clip(req.headers.host), remote });
      return refuse(socket, 421, 'Misdirected Request', MISDIRECTED);
    }
    const origin = this.originOf(req.headers.origin, host);
    if (origin === 'refused') {
      this.emit('warn', 'upgrade refused: cross-origin', { status: 403, origin: clip(req.headers.origin), remote });
      return refuse(socket, 403, 'Forbidden');
    }
    if (this.conns.size >= (this.opts.maxConnections ?? 512)) {
      this.emit('warn', 'upgrade refused: too many connections', { status: 503, remote });
      return refuse(socket, 503, 'Service Unavailable');
    }
    const principal = this.opts.resolver.resolve(tokenOf(req, url));
    if (!principal) {
      this.emit('warn', 'upgrade refused: no valid credential', { status: 401, remote });
      return refuse(socket, 401, 'Unauthorized', 'unauthorized: the daemon refused the credential (set TSM_TOKEN, or ?token=)');
    }
    // tsg-19: one principal cannot take every slot (in loopback-open mode every local client is one principal).
    const perPrincipal = this.opts.maxConnectionsPerPrincipal ?? Math.max(1, Math.floor((this.opts.maxConnections ?? 512) / 4));
    let mine = 0;
    for (const c of this.conns) if (c.credential === principal) mine++;
    if (mine >= perPrincipal) {
      this.emit('warn', 'upgrade refused: too many connections for this principal', { status: 429, principal, limit: perPrincipal, remote });
      return refuse(socket, 429, 'Too Many Requests', `too many connections for ${principal} (limit ${perPrincipal})`);
    }
    const gui = origin === 'same';
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        this.onConnection(ws, principal, url, gui, remote);
      } catch (e) {
        this.emit('error', 'connection setup failed', { error: errText(e), remote });
        ws.terminate();
      }
    });
  }

  private onConnection(ws: WebSocket, credential: Principal, url: URL, gui: boolean, remote: string | undefined): void {
    const q = url.searchParams;
    const profileQ = q.get('profile');
    const textQ = q.get('resultText');
    const id = `c-${randomBytes(8).toString('hex')}`;
    const principal = gui ? guiPrincipal(credential) : credential;
    const conn: Conn = {
      id,
      credential,
      label: sanitizeLabel(q.get('connection')),
      ws,
      // A ws connection can drop before a result is written, so its read cursor advances only on delivery (G22).
      caller: { principal, connectionId: id, deferReadDelivery: true },
      out: new Outbound((m) => this.send(ws, m)),
      lane: null,
      profile: PROFILES.includes(profileQ as Profile) ? (profileQ as Profile) : (this.opts.profile ?? 'core'),
      resultText: textQ === 'json' || textQ === 'transcript' ? textQ : (this.opts.resultText ?? 'json'),
      initialized: false,
      gui,
      kind: gui ? 'gui' : q.get('client') === 'cli' ? 'cli' : 'pending',
      followers: new Map(),
      attaching: new Map(),
      inFlight: 0,
      closed: false,
      closedClean: false,
      seenFrame: false,
      alive: true,
      pendingTimer: undefined,
      watchSessions: false,
    };
    this.conns.add(conn);
    this.emit('info', 'connection opened', { ...this.connFields(conn), remote });
    const pendingMs = this.opts.pendingTimeoutMs ?? 30_000;
    if (pendingMs > 0) {
      // tsg-19: a socket that never says anything does not hold a slot forever.
      conn.pendingTimer = setTimeout(() => {
        if (conn.seenFrame || conn.closed) return;
        this.emit('info', 'closing a connection that sent nothing', { ...this.connFields(conn), afterMs: pendingMs });
        try {
          ws.close(CLOSE_IDLE, 'no request received');
        } catch {
          ws.terminate();
        }
      }, pendingMs);
      conn.pendingTimer.unref();
    }
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data) => {
      conn.alive = true;
      if (!conn.seenFrame) {
        conn.seenFrame = true;
        if (conn.pendingTimer) clearTimeout(conn.pendingTimer);
        conn.pendingTimer = undefined;
      }
      this.onMessage(conn, data).catch((e) => this.emit('error', 'message handler failed', { ...this.connFields(conn), error: errText(e) }));
    });
    ws.on('close', (code) => this.onClose(conn, code));
    ws.on('error', (e) => this.emit('debug', 'socket error', { ...this.connFields(conn), error: errText(e) }));
  }

  /**
   * tsg-19: ping every connection each interval; one that has not answered the previous
   * ping (or sent anything) since is gone without a FIN — terminate it, which counts as a
   * drop, so a held seat goes through the §9 grace instead of staying held forever.
   */
  private startHeartbeat(): void {
    const every = this.opts.heartbeatMs ?? 30_000;
    if (every <= 0 || this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const conn of this.conns) {
        if (conn.closed) continue;
        if (!conn.alive) {
          this.emit('info', 'terminating a connection that stopped answering pings', { ...this.connFields(conn), afterMs: every });
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          // closing already; the close handler cleans up
        }
      }
    }, every);
    this.heartbeat.unref();
  }

  private onClose(conn: Conn, code: number): void {
    // First, before anything can yield: an attach or open that resumes after this must not attach (tsg-4).
    conn.closed = true;
    // 1005 is a close frame that carries no status (`ws.close()` with no code): still a close on purpose,
    // unlike 1006, which is no close frame at all (the house's read of 2f357bd, #22).
    conn.closedClean = code === 1000 || code === 1001 || code === 1005;
    if (conn.pendingTimer) clearTimeout(conn.pendingTimer);
    this.conns.delete(conn);
    const guard = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        this.emit('error', `${what} failed on close`, { ...this.connFields(conn), error: errText(e) });
      }
    };
    guard('rejectAll', () => conn.out.rejectAll('connection closed'));
    guard('lane dispose', () => conn.lane?.dispose());
    for (const f of conn.followers.values()) f.close();
    conn.followers.clear();
    this.sweepClosed(conn);
    this.emit('info', 'connection closed', { ...this.connFields(conn), code });
  }

  /**
   * A closed connection's attachments go, keyed by the server-generated id, so only its own
   * (api-11); a clean close (1000/1001) gives up seats at once, a drop keeps them through the
   * grace. Again after every call that was awaiting when the connection closed (a session
   * spawning, a snapshot settling), so nothing it attached late outlives it (tsg-4).
   */
  private sweepClosed(conn: Conn): void {
    if (!conn.closed) return;
    try {
      this.opts.app.detachConnection(conn.id, { clean: conn.closedClean });
    } catch (e) {
      this.emit('error', 'detach failed on close', { ...this.connFields(conn), error: errText(e) });
    }
  }

  /**
   * Write one message. `onSent` runs once it was handed to the socket without error, never when
   * the connection closed first. `onDone` runs once in every case — written, failed, or skipped
   * because the socket is not open — which is when the request it answers stops being in flight.
   */
  private send(ws: WebSocket, m: Message, onSent?: () => void, onDone?: () => void): void {
    if (ws.readyState !== ws.OPEN) {
      onDone?.();
      return;
    }
    try {
      const data = JSON.stringify(m);
      if (!onSent && !onDone) ws.send(data);
      else ws.send(data, (e) => {
        try {
          if (!e) onSent?.();
        } catch (err) {
          this.emit('error', 'onSent hook failed', { error: errText(err) });
        } finally {
          onDone?.();
        }
      });
    } catch (e) {
      this.emit('error', 'send failed', { error: errText(e) });
      onDone?.();
    }
  }

  private reply(conn: Conn, id: Id | null, error: { code: number; message: string; data?: unknown }, onDone?: () => void): void {
    this.send(conn.ws, { jsonrpc: '2.0', id, error }, undefined, onDone);
  }

  private async onMessage(conn: Conn, data: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.reply(conn, null, { code: PARSE_ERROR, message: 'parse error' });
      return;
    }
    const frame = classify(parsed);
    if (frame.kind === 'invalid') {
      if (frame.id !== undefined) this.reply(conn, frame.id, { code: frame.code, message: frame.message });
      return;
    }
    if (frame.kind === 'response') {
      conn.out.handleResponse(frame.msg);
      return;
    }
    const msg = frame.msg;
    const id = msg.id as Id | null | undefined;
    const isCall = id !== undefined;
    // tsg-14: a tool call or native request sent as a notification would execute with no way
    // to report its outcome (G16, G28) and outside any bound: it is not executed at all.
    if (!isCall && (msg.method === 'tools/call' || msg.method.startsWith('terminal/'))) {
      this.emit('debug', 'dropped a notification-form request (it needs an id)', { ...this.connFields(conn), method: clip(msg.method, 64) });
      return;
    }
    // §12: work in flight per connection is bounded, notifications included. A request is in
    // flight until its reply reached the socket, not merely until it was queued: a client that
    // stops reading is refused once `limit` replies wait for it, so what waits for it is `limit`
    // replies plus one short refusal per request it keeps sending, instead of every reply (the
    // house's read of 2f357bd, #22). The refusal says the request did not run, so sending it again
    // is safe.
    const limit = this.opts.maxInFlight ?? 128;
    if (conn.inFlight >= limit) {
      if (isCall) this.reply(conn, id, { code: OVERLOADED, message: 'too many requests in flight on this connection; this one was not run: send it again once earlier ones have answered', data: { limit, executed: false } });
      else this.emit('debug', 'dropped a notification: too much in flight', { ...this.connFields(conn), method: clip(msg.method, 64), limit });
      return;
    }
    conn.inFlight++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      conn.inFlight--;
    };
    // Frames from one TCP packet are delivered in one tick; yield so a response's
    // continuation (e.g. a channel registration) runs before the next request.
    await Promise.resolve();
    const afters: Array<() => void> = [];
    const sent: Array<() => void> = [];
    try {
      const result = await this.dispatch(conn, msg, (fn) => afters.push(fn), (fn) => sent.push(fn));
      // G28: a result counts as delivered only once it is on the wire, so its hooks wait for the write.
      if (isCall) this.send(conn.ws, { jsonrpc: '2.0', id: id as Id, result: result ?? {} }, sent.length ? () => sent.forEach((fn) => fn()) : undefined, release);
      // Continuations that must follow the response on the wire (e.g. channels/register after the policy receipt).
      if (afters.length) {
        setTimeout(() => {
          for (const fn of afters) {
            try {
              fn();
            } catch (e) {
              this.emit('error', 'continuation failed', { ...this.connFields(conn), method: clip(msg.method, 64), error: errText(e) });
            }
          }
        }, 0);
      }
    } catch (e) {
      if (!(e instanceof RpcError) && !(e instanceof TermError)) {
        this.emit('error', 'request failed', { ...this.connFields(conn), method: clip(msg.method, 64), error: errText(e) });
      }
      if (!isCall) return;
      if (e instanceof RpcError) this.reply(conn, id, { code: e.code, message: e.message, data: e.data }, release);
      else if (e instanceof TermError) this.reply(conn, id, { code: INVALID_PARAMS, message: `${e.code}: ${e.message}`, data: { code: e.code, ...(e.data ?? {}) } }, release);
      else this.reply(conn, id, { code: INTERNAL, message: e instanceof Error ? e.message : String(e) }, release);
    } finally {
      // A notification has no reply to wait for; a call's slot goes when its reply has been written.
      if (!isCall) release();
      this.sweepClosed(conn);
    }
  }

  private availableTools(conn: Conn): ToolDef[] {
    if (conn.lane) return TOOLS.filter((t) => conn.lane!.toolAllowed(t.name));
    return toolsFor(conn.profile);
  }

  private async dispatch(conn: Conn, req: Request, after: (fn: () => void) => void, onSent: (fn: () => void) => void): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>;
    const app = this.opts.app;
    // A connection that did not initialize is known by what it asks for (/health counts connections by kind).
    if (conn.kind === 'pending') conn.kind = req.method.startsWith('terminal/') ? 'native' : req.method.startsWith('tools/') ? 'mcp' : 'pending';
    switch (req.method) {
      // ── MCP ──
      case 'initialize': {
        const caps = (isObj(p.capabilities) ? p.capabilities : {}) as { experimental?: { mcpl?: unknown } };
        const wantsMcpl = isObj(caps.experimental) && caps.experimental.mcpl !== undefined;
        if (conn.lane) conn.lane.dispose();
        conn.lane = wantsMcpl ? new McplLane(app, conn.caller, conn.out, (line, level = 'info') => this.emit(level, line, this.connFields(conn))) : null;
        conn.initialized = true;
        conn.kind = conn.lane ? 'mcpl' : conn.kind === 'gui' || conn.kind === 'cli' ? conn.kind : 'mcp';
        // Where this connection's tools come from (§11): the profile only for a
        // plain MCP host; an MCPL host's grant decides its tools and deliveries.
        if (conn.lane) {
          this.emit('info', "initialized: an MCPL host; its grant (featureSets/update) decides its tools and deliveries, the core tools until it arrives", this.connFields(conn));
        } else {
          this.emit('info', 'initialized: a plain MCP host; the profile decides its tools', { ...this.connFields(conn), profile: conn.profile, tools: toolsFor(conn.profile).length });
        }
        const capabilities: Record<string, unknown> = { tools: { listChanged: true } };
        if (wantsMcpl) capabilities.experimental = { mcpl: manifest() };
        return {
          protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
          capabilities,
          serverInfo: { name: 'terminal-sessions', version: this.opts.version ?? 'dev' },
          instructions:
            'Persistent terminal sessions. `run` executes a command and waits; a still-running command returns its runId ' +
            '(`await` it or `read` its output) and keeps running. `screen` shows the terminal now; `input` types into it. ' +
            // What an MCPL host is promised depends on its grant, unknown at initialize (the house's read of 2f357bd, #22).
            (wantsMcpl
              ? 'When your host grants terminal.live push events, a command you started that outlives your wait is reported when it ends; otherwise `await` it or `read` with the returned cursor. Open a session’s channel to follow everything that happens in it.'
              : 'Use `read` with the returned cursor to see what happened since.'),
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.availableTools(conn).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          })),
        };
      case 'tools/call': {
        const name = typeof p.name === 'string' ? p.name : '';
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        // The call's latency in its usage record, on the monotonic clock as /health's uptime is.
        const t0 = clocks.monotonic();
        // A tool's advice about notifications holds only when this connection's grant delivers them for the
        // session it names; being an MCPL host is not enough (the house's read of 2f357bd, #22).
        const notifications = conn.lane !== null && conn.lane.carries(typeof args.session === 'string' ? args.session : '');
        const r = await callTool(name, args, { app, caller: conn.caller, resultText: conn.resultText, notifications }, this.availableTools(conn));
        this.afterToolCall(conn, name, args, r, Math.round(clocks.monotonic() - t0));
        if (r.onSent) onSent(r.onSent);
        return { content: [{ type: 'text', text: r.text }], structuredContent: r.structured, ...(r.isError ? { isError: true } : {}) };
      }
      // ── native family (GUI, CLI) ──
      case 'terminal/sessions':
        return this.nativeSessions(conn, p);
      case 'terminal/subscribe':
        return this.nativeSubscribe(conn, p);
      case 'terminal/unsubscribe':
        this.unfollow(conn, sessionParam(p));
        return {};
      case 'terminal/attach':
        return this.nativeAttach(conn, p, after, onSent);
      case 'terminal/detach':
        return this.nativeDetach(conn, p);
      default:
        // ── MCPL: everything else in the family is the lane's (§10) ──
        if (McplLane.METHODS.has(req.method)) {
          if (!conn.lane) throw new RpcError(METHOD_NOT_FOUND, 'not an MCPL connection');
          const ctx = { isRequest: req.id !== undefined, after };
          if (req.method !== 'featureSets/update') return conn.lane.handle(req.method, p, ctx);
          // A grant changes which tools the host may list: initialize promised `tools.listChanged`, so
          // the host is told to list again, after the receipt is on the wire; a malformed grant that
          // leaves no tools changes them too (the house's read of 2f357bd, #22).
          const before = this.availableTools(conn).map((t) => t.name).join(' ');
          try {
            return await conn.lane.handle(req.method, p, ctx);
          } finally {
            if (this.availableTools(conn).map((t) => t.name).join(' ') !== before) after(() => conn.out.notify('notifications/tools/list_changed'));
          }
        }
        if (req.id === undefined) return undefined;
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${clip(req.method, 64) as string}`);
    }
  }

  // ───────────────────────────── native family (G13) ─────────────────────────────

  /** The session `sid`, when this connection's principal may observe it (G18). */
  private observable(conn: Conn, sid: string): AnySession {
    const s = this.opts.app.registry.get(sid);
    if (!s) throw err('session_not_found', `session ${sid} not found`, { session: sid });
    if (!this.opts.app.can(conn.caller.principal, s, 'observe')) throw err('forbidden', `${conn.caller.principal} may not observe session ${sid}`, { session: sid });
    return s;
  }

  private unfollow(conn: Conn, sid: string): void {
    conn.followers.get(sid)?.close();
    conn.followers.delete(sid);
  }

  private follow(conn: Conn, sid: string, journal: JournalSource, cursor: Seq): Follower {
    conn.followers.get(sid)?.close();
    const f = new Follower(
      journal,
      cursor,
      {
        event: (ev) => conn.out.notify('terminal/event', { session: sid, event: ev }),
        gap: (g) => conn.out.notify('terminal/gap', { session: sid, from: g.from, to: g.to, reason: g.reason }),
        buffered: () => conn.ws.bufferedAmount,
        open: () => conn.ws.readyState === conn.ws.OPEN,
      },
      { highWaterBytes: this.opts.highWaterBytes, onError: (e) => this.followerFailed(conn, sid, f, e) },
    );
    conn.followers.set(sid, f);
    return f;
  }

  /** Start a follower whose response is already on the wire; a journal read failure ends the stream visibly. */
  private startFollower(conn: Conn, sid: string, f: Follower): void {
    try {
      f.start();
    } catch (e) {
      this.followerFailed(conn, sid, f, e);
    }
  }

  private followerFailed(conn: Conn, sid: string, f: Follower, e: unknown): void {
    if (conn.followers.get(sid) === f) conn.followers.delete(sid);
    this.emit('error', 'journal read failed; subscription ended', { ...this.connFields(conn), session: sid, error: errText(e) });
    conn.out.notify('terminal/closed', { session: sid, reason: 'error' });
  }

  /**
   * `terminal/subscribe { session, since? }`: every retained event after `since`
   * (default: now), in pages, then live — no cap, no duplicates, and a
   * `terminal/gap` when retention passed the cursor (G11, G13). The replay that
   * fits under the high-water mark precedes the response; `live: false` means the
   * rest is still streaming (the socket filled up first).
   */
  private nativeSubscribe(conn: Conn, p: Record<string, unknown>): unknown {
    const sid = sessionParam(p);
    const s = this.observable(conn, sid);
    const journal = s.kind === 'live' ? s.session.journal : s.journal;
    let since = journal.lastSeq;
    if (p.since !== undefined) {
      if (typeof p.since !== 'number' || !Number.isInteger(p.since) || p.since < 0) throw new RpcError(INVALID_PARAMS, 'since must be a non-negative integer');
      // A cursor past the journal names events that do not exist: refused, with where the journal ends,
      // rather than moved back to deliver events the caller said it had (the house's read of 2f357bd, #22).
      if (p.since > journal.lastSeq) throw new RpcError(INVALID_PARAMS, `since ${p.since} is past the journal's last seq ${journal.lastSeq}`, { lastSeq: journal.lastSeq });
      since = p.since;
    }
    const f = this.follow(conn, sid, journal, since);
    try {
      f.start();
    } catch (e) {
      if (conn.followers.get(sid) === f) conn.followers.delete(sid);
      throw e;
    }
    return { session: sid, nextCursor: f.cursor, gap: f.firstGap ?? null, lastSeq: journal.lastSeq, live: f.state === 'live' };
  }

  /**
   * `terminal/attach { session, role? }` for the GUI (G13): a snapshot of the
   * screen at cursor N, an Attachment (role `auto` by default: the owner takes a
   * free seat), and then every event after N through a follower — started only
   * once the response is on the wire, so the client has the snapshot before the
   * first event. A history-only session answers with its transcript instead.
   */
  private async nativeAttach(conn: Conn, p: Record<string, unknown>, after: (fn: () => void) => void, onSent: (fn: () => void) => void): Promise<unknown> {
    const sid = sessionParam(p);
    const role = p.role ?? 'auto';
    if (role !== 'auto' && role !== 'observer' && role !== 'controller') throw new RpcError(INVALID_PARAMS, 'role must be auto, observer or controller');
    // tsg-4: the connection may close, or detach, while this waits; nothing may attach for it afterwards.
    const wait = conn.attaching.get(sid) ?? { gen: 0, waiting: 0 };
    wait.waiting++;
    conn.attaching.set(sid, wait);
    const gen = wait.gen;
    const stillWanted = (): void => {
      if (conn.closed) throw new RpcError(INVALID_REQUEST, 'the connection closed during the attach');
      if (wait.gen !== gen) throw new RpcError(INVALID_REQUEST, 'attach superseded by terminal/detach');
    };
    try {
      // The name can change hands while the snapshot or transcript is awaited: a new life begins, a
      // shell exits. What was read then describes the wrong life, so the attach starts over on what
      // the name is now (the house's read of 2f357bd, #22).
      for (let attempt = 0; ; attempt++) {
        const s = this.observable(conn, sid);
        this.unfollow(conn, sid);
        const r = s.kind === 'history' ? await this.attachHistory(conn, s, sid, stillWanted, after, onSent) : await this.attachLive(conn, s, sid, role, stillWanted, after);
        if (r !== undefined) return r;
        if (attempt === 2) throw err('busy', `session ${sid} kept changing while the attach waited; try again`, { session: sid });
      }
    } finally {
      wait.waiting--;
      if (wait.waiting === 0 && conn.attaching.get(sid) === wait) conn.attaching.delete(sid);
    }
  }

  /** The session's summary as this connection sees it, for an attach response. */
  private summaryOf(conn: Conn, sid: string): unknown {
    return this.opts.app.sessionList(conn.caller).find((x) => x.id === sid) ?? null;
  }

  /** A history-only session attaches with its transcript; undefined when the name changed during the read (the caller starts over). */
  private async attachHistory(conn: Conn, s: HistorySession, sid: string, stillWanted: () => void, after: (fn: () => void) => void, onSent: (fn: () => void) => void): Promise<Record<string, unknown> | undefined> {
    const app = this.opts.app;
    const read = await app.read(conn.caller, { session: sid, tail: TRANSCRIPT_READ_LINES, maxBytes: 256 * 1024 });
    stillWanted();
    if (app.registry.get(sid) !== s) return undefined;
    // The transcript is handed to this principal once the response is written: the read cursor the
    // deferred read staged advances then (G22), as for every result on this connection, so a reply
    // that never reaches the client moves nothing (the house's read of 78c4d6e, #22).
    onSent(() => commitReadDelivery(read));
    const lastSeq = s.journal.lastSeq;
    const f = this.follow(conn, sid, s.journal, lastSeq);
    after(() => this.startFollower(conn, sid, f));
    const lines = (read.text ?? '').split('\n');
    return {
      principal: conn.caller.principal,
      role: 'observer',
      controller: null,
      attachmentId: null,
      snapshot: null,
      transcript: lines.slice(-TRANSCRIPT_LINES).join('\n'),
      // Cut at the read's byte cap, or to the last lines: the transcript does not start where the history does.
      truncated: read.truncated || lines.length > TRANSCRIPT_LINES,
      lastSeq,
      // Each ended Run carries its journaled duration, as a live session's activity shows it (never the
      // wall clock's `endedAt - startedAt`: a reviewer's read of the fixes for #22).
      runs: s.listRuns().slice(-50),
      info: this.summaryOf(conn, sid),
    };
  }

  /**
   * A live session attaches with the screen and the seq it reflects exactly (G13), so the follower
   * from there delivers every later event once and nothing earlier; undefined when the session was
   * closed or replaced while the screen settled (the caller starts over on what the name is now).
   */
  private async attachLive(conn: Conn, s: LiveSession, sid: string, role: 'auto' | 'observer' | 'controller', stillWanted: () => void, after: (fn: () => void) => void): Promise<Record<string, unknown> | undefined> {
    const principal = conn.caller.principal;
    const session = s.session;
    const before = session.journal.lastSeq;
    await session.screen.settled();
    stillWanted();
    if (this.opts.app.registry.get(sid) !== s) return undefined;
    const snap = session.screen.serialize();
    // Every output event at or before `before` was issued to the screen before the wait, and settled()
    // covers every write issued; the emulator reports the seq of the last output it applied, which the
    // wait may have carried further. The snapshot therefore reflects the later of the two. Events
    // between the last output and `before` are not output and change no screen; starting after them
    // keeps an attach from reporting, every time, a gap over notes retention has since dropped (the
    // house's read of 2f357bd, #22).
    const at = Math.max(snap.seq, before);
    // Everything from here to the return runs in the tick the snapshot was taken in.
    const mine = session.listAttachments().find((a) => a.connectionId === conn.id && a.principal === principal);
    const att = mine ?? session.attach(principal, conn.id, role);
    const f = this.follow(conn, sid, session.journal, at);
    after(() => this.startFollower(conn, sid, f));
    const snapshot: Record<string, unknown> = { data: snap.data, cols: snap.cols, rows: snap.rows, alt: snap.alt, seq: at };
    // Output the emulator discarded under pressure is damage the snapshot carries; screen.snapshot() says the same.
    if (session.screen.droppedUnits > 0) snapshot.droppedUnits = session.screen.droppedUnits;
    return {
      principal,
      role: att.role,
      controller: session.currentController,
      attachmentId: att.attachmentId,
      snapshot,
      runs: session.listRuns().slice(-50),
      info: this.summaryOf(conn, sid),
    };
  }

  /**
   * `terminal/sessions { watch? }`: the session list for the native family, outside
   * tools/call (so the GUI's list is not usage to measure). With `watch: true` the
   * connection is also told of every registry change (`terminal/sessionsChanged`), so
   * the GUI refreshes on change instead of polling (tsg-16).
   */
  private nativeSessions(conn: Conn, p: Record<string, unknown>): unknown {
    if (p.watch !== undefined && typeof p.watch !== 'boolean') throw new RpcError(INVALID_PARAMS, 'watch must be a boolean');
    if (p.watch !== undefined) conn.watchSessions = p.watch;
    return { sessions: this.opts.app.sessionList(conn.caller), watching: conn.watchSessions };
  }

  /**
   * `terminal/detach { session }`: this connection's attachments on the session and its
   * follower go. A detach is on purpose, so a held seat is released at once (§9: the grace
   * is for connections that drop; ss-13, tsg-10).
   */
  private nativeDetach(conn: Conn, p: Record<string, unknown>): unknown {
    const sid = sessionParam(p);
    // An attach of this session still waiting on its snapshot must not attach after this (tsg-4); nothing is kept when none waits.
    const wait = conn.attaching.get(sid);
    if (wait) wait.gen++;
    this.unfollow(conn, sid);
    const s = this.opts.app.registry.get(sid);
    let detached = 0;
    if (s?.kind === 'live') {
      for (const a of s.session.listAttachments()) {
        if (a.connectionId !== conn.id) continue;
        s.session.detach(a.attachmentId, { keepSeat: false });
        detached++;
      }
    }
    return { session: sid, detached };
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}
