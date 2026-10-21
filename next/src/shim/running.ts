/**
 * A supervisor's termd that runs, asked what it uses. A systemd unit's text is what the unit will run
 * next, not what its termd was started with: after an edit and a daemon-reload without a restart, the
 * text names another port or data dir than the termd it shows running, and the shim compared against the
 * edited one (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question 1). termd retitles
 * itself (`termd --port N`, tsg-20), so its start arguments no longer show, but the title gives the port
 * it listens on, and that port's /health gives its data dir to a loopback caller that may see sessions.
 *
 * The answer counts only from the termd itself: before a byte is sent, the connection's other end is
 * shown to be the pid's (Linux's /proc), since its pid is public and another process may listen on its
 * port, bound to 127.0.0.1 beside a termd on ::1. Only then does the shim's own credential go, so a
 * termd that requires one tells the shim too; an unproven listener never sees it. Where whose the socket
 * is cannot be shown, termd is not asked, and the shim reads the unit's text.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { clocks } from '../core/clock.js';

/** The port a running termd's title names, as Linux shows the title in /proc/<pid>/cmdline (else `ps`); or why there is none. */
export function titlePort(pid: number): number | { error: string } {
  let title: string | undefined;
  try {
    title = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    try {
      title = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return { error: 'its title cannot be read' };
    }
  }
  const m = /^termd --port (\d+)$/.exec(title.trim());
  const port = m ? Number(m[1]) : NaN;
  return port > 0 && port <= 65535 ? port : { error: `its title is not a termd's with a port: ${JSON.stringify(title.slice(0, 80))}` };
}

export interface AskOptions {
  /** The whole ask's bound: the connection, its proof, the request and every byte of the answer. */
  timeoutMs: number;
  /** The shim's own credential, sent only on a connection shown to be the termd's. */
  token?: string | undefined;
  /** Why the connection's other end is not shown to be `pid`'s, or undefined when it is; Linux's /proc by default (see connectionOf). */
  prove?: (socket: net.Socket, pid: number) => Promise<string | undefined>;
}

/** The most of /health's answer read: past it, the answer is not taken. */
const HEALTH_MAX_BYTES = 1 << 20;

/**
 * What the termd on `port` says its data dir is, over /health, from a connection shown to be `pid`'s.
 * Tried on 127.0.0.1, then ::1, within one deadline for both: the socket's idle timeout alone let a
 * listener that wrote a byte every 200 ms hold a 300 ms ask for ten seconds (a reviewer's read of the
 * fixes for #22).
 */
export async function askDataDir(port: number, pid: number, o: AskOptions): Promise<{ dataDir: string } | { error: string }> {
  const end = clocks.monotonic() + o.timeoutMs;
  let last = 'it did not answer';
  for (const host of ['127.0.0.1', '::1']) {
    const left = end - clocks.monotonic();
    if (left <= 0) return { error: `it did not answer /health within ${o.timeoutMs} ms` };
    const r = await health(host, port, pid, o, left);
    if ('error' in r) {
      last = r.error;
      if (r.refused) continue;
      return r;
    }
    if (r.body.pid !== pid) return { error: `port ${port} answers as pid ${String(r.body.pid)}, not as it` };
    if (typeof r.body.dataDir !== 'string') return { error: `its /health names no data dir: ${o.token ? 'the credential' : 'no credential'} was presented, and one older than this shim never names it` };
    return { dataDir: r.body.dataDir };
  }
  return { error: last };
}

function health(host: string, port: number, pid: number, o: AskOptions, ms: number): Promise<{ body: Record<string, unknown> } | { error: string; refused?: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const socket = net.connect({ host, port });
    const finish = (r: { body: Record<string, unknown> } | { error: string; refused?: boolean }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    // The whole exchange's deadline: it destroys the request however the bytes trickle in.
    const timer = setTimeout(() => finish({ error: `it did not answer /health within ${o.timeoutMs} ms` }), ms);
    socket.once('error', (e: NodeJS.ErrnoException) => finish({ error: e.code === 'ECONNREFUSED' ? `nothing listens on port ${port}` : e.message, refused: e.code === 'ECONNREFUSED' || e.code === 'EADDRNOTAVAIL' }));
    socket.once('connect', () => {
      void (o.prove ?? connectionOf)(socket, pid).then((why) => {
        if (done) return;
        if (why !== undefined) return finish({ error: why });
        const headers: Record<string, string> = { host: `${host.includes(':') ? `[${host}]` : host}:${port}` };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        // No agent: the request goes on this proven connection and no other.
        const req = http.request({ method: 'GET', path: '/health', headers, createConnection: () => socket }, (res) => {
          const parts: Buffer[] = [];
          let bytes = 0;
          res.on('data', (c: Buffer) => {
            bytes += c.length;
            if (bytes > HEALTH_MAX_BYTES) return finish({ error: `its /health answer is over ${HEALTH_MAX_BYTES} bytes` });
            parts.push(c);
          });
          res.on('end', () => {
            if (res.statusCode !== 200) return finish({ error: `its /health answered ${res.statusCode}` });
            try {
              const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
              finish(typeof body === 'object' && body !== null ? { body: body as Record<string, unknown> } : { error: 'its /health answer is not an object' });
            } catch {
              finish({ error: 'its /health answer is not JSON' });
            }
          });
        });
        req.once('error', (e) => finish({ error: e.message }));
        req.end();
      });
    });
  });
}

/**
 * Why `socket`'s other end, a connection to a local port, is not shown to be `pid`'s, or undefined when
 * it is: the server side of the connection in /proc/net/tcp or tcp6 (the port dialled as its local port,
 * this socket's as its remote one, established), its inode among /proc/<pid>/fd's sockets. The accepted
 * socket has an inode only once the termd accepts it, so the lookup is tried again, for at most a second.
 * Elsewhere whose a socket is cannot be shown, and the answer is not taken.
 */
export async function connectionOf(socket: net.Socket, pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return 'this system does not show whose a socket is';
  const port = socket.remotePort;
  const local = socket.localPort;
  if (port === undefined || local === undefined) return 'the connection has no ports';
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  for (let tries = 0; tries < 100 && !socket.destroyed; tries++) {
    let inode: string | undefined;
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text: string;
      try {
        text = fs.readFileSync(table, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        // sl local_address rem_address st … uid timeout inode; 01 is ESTABLISHED.
        if (f[1]?.endsWith(`:${hex(port)}`) && f[2]?.endsWith(`:${hex(local)}`) && f[3] === '01') inode = f[9];
      }
    }
    if (inode !== undefined && inode !== '0') {
      let fds: string[];
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch (e) {
        return `whose the socket on port ${port} is cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
      }
      const owned = fds.some((fd) => {
        try {
          return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`;
        } catch {
          return false;
        }
      });
      return owned ? undefined : `the socket that answered on port ${port} is not its`;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return `the socket that answered on port ${port} was not found accepted`;
}
