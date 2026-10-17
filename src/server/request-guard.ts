/**
 * Host and Origin checks for both 1.x ports (the session API and the web GUI),
 * matching the 2.0 transport (next/src/transport/server.ts).
 *
 * Checked on every HTTP request and every WebSocket / socket.io handshake,
 * before the token:
 *
 *  1. Origin, when present, must be same-origin with the request's Host (the
 *     GUI's own page) or listed with --allow-origin; otherwise 403. Requests
 *     without an Origin come from non-browser clients (the MCP shim, the CLI,
 *     the GUI's server-side client).
 *
 *  2. Without a token, Host must name this server: `localhost`, `127.0.0.1` or
 *     `[::1]`, the bind address when it is a specific one, or a name given with
 *     --allow-host; otherwise 421. Loopback names are served on any port while
 *     the bind is loopback, so port forwards keep working. With a token, the
 *     token is the gate and Host is not checked, so remote setups keep working.
 */

import { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';

export interface AccessOptions {
  /** Host names (optionally `name:port`) served besides the loopback names. */
  allowHosts?: string[];
  /** Origins (e.g. `https://dash.example`) allowed besides our own GUI page. */
  allowOrigins?: string[];
}

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 403 | 421; message: string };

interface HostPattern {
  name: string;
  /** When set, only this port; otherwise our port or none. */
  port: string | undefined;
  /** Any port at all (loopback names on a loopback bind). */
  anyPort?: boolean;
}

const LOOPBACK_BINDS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const WILDCARD_BINDS: ReadonlySet<string> = new Set(['', '0.0.0.0', '::', '[::]']);
/** A bracketed IPv6 literal, or dot-separated labels (underscores allowed: container service names use them). */
const HOST_NAME = /^(\[[0-9a-f:.]+\]|[a-z0-9_][a-z0-9_-]{0,62}(\.[a-z0-9_][a-z0-9_-]{0,62})*)$/;

const MISDIRECTED = 'misdirected request: this Host is not served here; start session-server with --allow-host <host[:port]> (or --token) to serve it';
const CROSS_ORIGIN = 'cross-origin requests are refused; start session-server with --allow-origin <origin> to allow this page';

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

/** An --allow-host entry (or a bind address): a bare IPv6 literal has several colons and no brackets. */
function parseAllowHost(v: string): HostPattern | undefined {
  return parseHost((v.match(/:/g)?.length ?? 0) > 1 && !v.includes('[') ? `[${v}]` : v);
}

/** Normalize an --allow-origin entry to `scheme://host[:port]`, or undefined if it is not an http(s) origin. */
function parseOrigin(v: string): string | undefined {
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** Split comma-separated list values (flags may also repeat). */
export function splitList(values: Array<string | undefined>): string[] {
  return values.flatMap((v) => (v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
}

/** Access options from SESSION_SERVER_ALLOW_HOSTS / SESSION_SERVER_ALLOW_ORIGINS (comma-separated). */
export function accessFromEnv(env: NodeJS.ProcessEnv = process.env): AccessOptions {
  return {
    allowHosts: splitList([env.SESSION_SERVER_ALLOW_HOSTS]),
    allowOrigins: splitList([env.SESSION_SERVER_ALLOW_ORIGINS]),
  };
}

/** Constant-time token comparison. */
export function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse a request target against a fixed base: the Host header is client-chosen and must never be a URL base. */
export function requestUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw || '/', 'http://localhost');
  } catch {
    return undefined;
  }
}

/** Client strings in log lines: bounded and JSON-quoted. */
function clip(v: unknown, n = 200): string {
  const s = typeof v === 'string' ? v : String(v);
  return JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
}

export class RequestGuard {
  private readonly patterns: HostPattern[];
  private readonly origins: Set<string>;

  /**
   * @param bind the address the server listens on (`--host`)
   * @param port the port it listens on, or a function giving it once bound
   * @param tokenRequired whether a token gates every connection
   * @param label log prefix (`SessionAPI`, `WebGUI`)
   */
  constructor(
    bind: string,
    private readonly port: number | (() => number),
    private readonly tokenRequired: boolean,
    access: AccessOptions = {},
    private readonly label = 'session-server',
  ) {
    const b = bind.trim().toLowerCase();
    const anyPort = LOOPBACK_BINDS.has(b);
    this.patterns = ['localhost', '127.0.0.1', '[::1]'].map((name) => ({ name, port: undefined, anyPort }));
    if (!WILDCARD_BINDS.has(b) && !LOOPBACK_BINDS.has(b)) {
      const p = parseAllowHost(b);
      if (p) this.patterns.push({ name: p.name, port: undefined });
    }
    for (const entry of access.allowHosts ?? []) {
      const p = parseAllowHost(entry);
      if (p) this.patterns.push(p);
      else console.error(`[${label}] ignoring --allow-host entry that is not a host name: ${clip(entry)}`);
    }
    this.origins = new Set();
    for (const entry of access.allowOrigins ?? []) {
      const o = parseOrigin(entry);
      if (o) this.origins.add(o);
      else console.error(`[${label}] ignoring --allow-origin entry that is not an http(s) origin: ${clip(entry)}`);
    }
  }

  /** Whether a Host header names this server (rule 2). */
  private hostServed(h: HostPattern): boolean {
    const ours = String(typeof this.port === 'function' ? this.port() : this.port);
    for (const a of this.patterns) {
      if (a.name !== h.name) continue;
      if (a.anyPort || (a.port !== undefined ? h.port === a.port : h.port === undefined || h.port === ours)) return true;
    }
    return false;
  }

  /** Check one request (an HTTP request or an upgrade/handshake). */
  check(req: IncomingMessage): GuardResult {
    const hostHeader = req.headers.host;
    const host = typeof hostHeader === 'string' ? parseHost(hostHeader) : undefined;

    // 1. Origin: absent (not a browser), same-origin with Host (our GUI), or explicitly allowed.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let u: URL | undefined;
      try {
        u = new URL(origin);
      } catch {
        u = undefined;
      }
      const sameOrigin =
        u !== undefined &&
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        typeof hostHeader === 'string' &&
        u.host === hostHeader.trim().toLowerCase();
      if (!sameOrigin && !(u !== undefined && this.origins.has(u.origin))) {
        return this.refuse(req, 403, CROSS_ORIGIN, `cross-origin (origin ${clip(origin)})`);
      }
    }

    // 2. Host: must name this server unless a token gates the connection.
    if (!this.tokenRequired && (!host || !this.hostServed(host))) {
      return this.refuse(req, 421, MISDIRECTED, `Host not served (host ${clip(hostHeader ?? '')})`);
    }
    return { ok: true };
  }

  private refuse(req: IncomingMessage, status: 403 | 421, message: string, why: string): GuardResult {
    console.error(`[${this.label}] refused ${req.method ?? ''} ${clip(req.url ?? '', 80)}: ${why} from ${req.socket?.remoteAddress ?? '?'}`);
    return { ok: false, status, message };
  }
}
