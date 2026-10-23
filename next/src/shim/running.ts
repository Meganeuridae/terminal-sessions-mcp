/**
 * A supervisor's termd that runs, asked what it uses. A systemd unit's text is what the unit will run
 * next, not what its termd was started with: after an edit and a daemon-reload without a restart, the
 * text names another port or data dir than the termd it shows running, and the shim compared against the
 * edited one (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question 1). termd retitles
 * itself (`termd --port N`, tsg-20), so its start arguments no longer show, but the title gives the port
 * it listens on, and that port's /health gives its data dir to a caller with a principal and a loopback peer address.
 *
 * The answer counts only from the termd itself: before a byte is sent, the connection's other end is
 * shown to be the pid's (Linux's /proc), since its pid is public and another process may listen on its
 * port, bound to 127.0.0.1 beside a termd on ::1. Only then does the shim's own credential go, so a
 * termd that requires one tells the shim too; an unproven listener never sees it. Where whose the socket
 * is cannot be shown, termd is not asked, and the shim reads the unit's text.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import { clocks } from '../core/clock.js';

/**
 * The port a running termd's title names, as Linux shows the title in /proc/<pid>/cmdline; or why there is
 * none. Only a systemd unit's termd is asked, so only Linux's /proc is read: the `ps` it fell back to reads
 * the same /proc there (the house's read of the 17 commits over our fixes, #22).
 */
export function titlePort(pid: number): number | { error: string } {
  let title: string;
  try {
    title = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return { error: 'its title cannot be read' };
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

/** How long a connection termd has yet to accept is looked up again (see connectionOf). */
const ACCEPT_WAIT_MS = 1000;

/**
 * What the termd on `port` says its data dir is, over /health, from a connection shown to be `pid`'s.
 * Tried on 127.0.0.1, then ::1, within one deadline for both: the socket's idle timeout alone let a
 * listener that wrote a byte every 200 ms hold a 300 ms ask for ten seconds (a reviewer's read of the
 * fixes for #22). A listener on 127.0.0.1 that is not shown to be the termd's is no answer: ::1 is tried
 * next, where a termd bound there alone listens, with what is left of the deadline once that listener's
 * proof gave up. Its reason is said when nothing listens on ::1, when ::1 is not shown to be the termd's
 * either, or when the deadline runs out before ::1 is tried; a ::1 that fails otherwise, by its own
 * timeout or answer, gives its own reason (the house's read of the 14 commits over our fixes, #22: said
 * as "when no address answers", it promised more). Stopped
 * at that listener, another process on 127.0.0.1 at termd's port kept the shim from asking the termd on
 * ::1 at all (the house's review of a8b6f28..4860d4c, #22 comment 6341260318, question 5). Nothing is
 * sent to an unproven listener either way.
 */
export async function askDataDir(port: number, pid: number, o: AskOptions): Promise<{ dataDir: string } | { error: string }> {
  const end = clocks.monotonic() + o.timeoutMs;
  let last = 'it did not answer';
  let unproven: string | undefined;
  for (const host of ['127.0.0.1', '::1']) {
    const left = end - clocks.monotonic();
    if (left <= 0) return { error: unproven ?? `it did not answer /health within ${o.timeoutMs} ms` };
    const r = await health(host, port, pid, o, left);
    if ('error' in r) {
      last = r.error;
      if (r.unproven) unproven ??= r.error;
      if (r.refused || r.unproven) continue;
      return r;
    }
    if (r.body.pid !== pid) return { error: `port ${port} answers as pid ${String(r.body.pid)}, not as it` };
    if (typeof r.body.dataDir !== 'string') return { error: `its /health names no data dir: ${o.token ? 'the credential' : 'no credential'} was presented, and one older than this shim never names it` };
    return { dataDir: r.body.dataDir };
  }
  return { error: unproven ?? last };
}

/**
 * /health's answer, or why there is none: nothing listening (`refused`), or a listener not shown to be the termd's
 * (`unproven`): its proof failed, or its connection failed before the proof passed, as by a reset, for any reason but
 * nothing listening. A listener on 127.0.0.1 that reset the connection, as it was made or while it was proved, was read
 * as termd's own failure, and ::1 was never tried (the house's read of the 14 commits over our fixes, #22).
 */
type Answer = { body: Record<string, unknown> } | { error: string; refused?: boolean; unproven?: boolean };

function health(host: string, port: number, pid: number, o: AskOptions, ms: number): Promise<Answer> {
  return new Promise((resolve) => {
    let done = false;
    // Until the proof passes, a failure that isn't "nothing listens" is the listener's, which nothing showed to be termd's.
    let proven = false;
    const socket = net.connect({ host, port });
    const finish = (r: Answer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    // The whole exchange's deadline: it destroys the request however the bytes trickle in.
    const timer = setTimeout(() => finish({ error: `it did not answer /health within ${o.timeoutMs} ms` }), ms);
    socket.once('error', (e: NodeJS.ErrnoException) => {
      const refused = e.code === 'ECONNREFUSED' || e.code === 'EADDRNOTAVAIL';
      finish({ error: e.code === 'ECONNREFUSED' ? `nothing listens on port ${port}` : e.message, refused, unproven: !proven && !refused });
    });
    socket.once('connect', () => {
      void (o.prove ?? connectionOf)(socket, pid).then((why) => {
        if (done) return;
        if (why !== undefined) return finish({ error: why, unproven: true });
        proven = true;
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
 * it is: the server side of this very connection in /proc/net/tcp or tcp6, established, its inode among
 * /proc/<pid>/fd's sockets. The server side is found by both its addresses whole, as /proc writes them:
 * its local one the address and port dialled, its remote one this socket's. Matched by the ports alone, a
 * second connection from the same port number to a termd on ::1 made an impostor's socket on 127.0.0.1
 * read as termd's, and the shim sent it its credential (a reviewer's run of the fixes for #22, on Ubuntu
 * 24.04). An IPv4 connection's server side is in tcp, or in tcp6 as a ::ffff: address when the listener is
 * an IPv6 socket. The accepted socket has an inode only once termd accepts it, so the lookup is tried
 * again every 10 ms for at most a second on the monotonic clock: counted as 100 tries, a loaded host's slow
 * reads stretched it past the second (the house's read of the 17 commits over our fixes, #22). Elsewhere
 * whose a socket is cannot be shown, and the answer is not taken.
 *
 * A read of either table is not one snapshot. The kernel hands it out in page-sized pieces and, once a
 * piece has reached the table's end, counts its way back to its place from the top; sockets added meanwhile
 * make that count land on rows already given, so the table's last rows come twice, and a row can be left out
 * as well. Under the suite's loopback churn a third of the reads listed some socket twice (Ubuntu 24.04, a
 * few thousand connections a second). Rows with one inode are one socket; the refusal, for a connection two
 * sockets claim, stands only for distinct inodes, and a row left out is met by the next try (two shim tests
 * hit the refusal in our fork's run of e8b55ad on Ubuntu). Tests read the tables through `o.read`.
 */
export interface ConnectionOfOptions {
  /** The text of a /proc/net table (`/proc/net/tcp` or `tcp6`), or a throw where it cannot be read; the file itself by default. */
  read?: (table: string) => string;
}

export async function connectionOf(socket: net.Socket, pid: number, o: ConnectionOfOptions = {}): Promise<string | undefined> {
  if (process.platform !== 'linux') return 'this system does not show whose a socket is';
  const read = o.read ?? ((table: string) => fs.readFileSync(table, 'utf8'));
  const { remoteAddress, remotePort: port, localAddress, localPort } = socket;
  if (remoteAddress === undefined || port === undefined || localAddress === undefined || localPort === undefined) return 'the connection has no addresses';
  const v6 = socket.remoteFamily === 'IPv6';
  const wanted: Array<{ table: string; local: string | undefined; remote: string | undefined }> = v6
    ? [{ table: '/proc/net/tcp6', local: procAddress(remoteAddress, port, true), remote: procAddress(localAddress, localPort, true) }]
    : [
        { table: '/proc/net/tcp', local: procAddress(remoteAddress, port, false), remote: procAddress(localAddress, localPort, false) },
        { table: '/proc/net/tcp6', local: procAddress(`::ffff:${remoteAddress}`, port, true), remote: procAddress(`::ffff:${localAddress}`, localPort, true) },
      ];
  if (wanted.some((w) => w.local === undefined || w.remote === undefined)) return `the connection's addresses are not read here (${remoteAddress}, ${localAddress})`;
  const giveUp = clocks.monotonic() + ACCEPT_WAIT_MS;
  while (!socket.destroyed) {
    // The sockets listed as the server side, by inode: a torn read lists one socket in more than one row.
    const inodes = new Set<string>();
    for (const w of wanted) {
      let text: string;
      try {
        text = read(w.table);
      } catch {
        continue;
      }
      for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        // sl local_address rem_address st … uid timeout inode; 01 is ESTABLISHED. A row with inode 0 is the
        // connection before termd accepted it: it names no socket yet, and the next try reads again.
        if (f[1] === w.local && f[2] === w.remote && f[3] === '01' && f[9] !== undefined && f[9] !== '0') inodes.add(f[9]);
      }
    }
    if (inodes.size > 1) return `more than one socket is the other end of this connection on port ${port}`;
    const [inode] = inodes;
    if (inode !== undefined) {
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
    if (clocks.monotonic() >= giveUp) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return `the socket that answered on port ${port} was not found accepted`;
}

/**
 * An address and port as /proc/net/tcp and tcp6 write them: the address's bytes in 32-bit words, each
 * printed as the host reads it (little-endian on x86 and arm64, so 127.0.0.1 is 0100007F), then the port
 * in hex. undefined for an address not read here.
 */
export function procAddress(ip: string, port: number, v6: boolean): string | undefined {
  const bytes = v6 ? ipv6Bytes(ip) : ipv4Bytes(ip);
  if (!bytes) return undefined;
  const le = os.endianness() === 'LE';
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) out += (le ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i)).toString(16).toUpperCase().padStart(8, '0');
  return `${out}:${port.toString(16).toUpperCase().padStart(4, '0')}`;
}

function ipv4Bytes(ip: string): Buffer | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
  return Buffer.from(parts.map(Number));
}

/** An IPv6 address's 16 bytes: `::` and a dotted IPv4 tail (`::ffff:127.0.0.1`) read, a zone (`%lo`) dropped. */
function ipv6Bytes(ip: string): Buffer | undefined {
  let s = ip.replace(/%.*$/, '');
  let tail: Buffer | undefined;
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    tail = ipv4Bytes(dotted[1]!);
    if (!tail) return undefined;
    s = `${s.slice(0, s.length - dotted[1]!.length)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const words = (h: string) => (h ? h.split(':') : []);
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return undefined;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  if (tail) tail.copy(out, 12);
  return out;
}
