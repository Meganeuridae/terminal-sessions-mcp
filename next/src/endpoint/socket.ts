import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The longest Unix socket path both platforms take: macOS's sun_path holds 104 bytes with its NUL, Linux's 108. */
const SOCKET_PATH_MAX = 103;

export interface EndpointPaths {
  dir: string;
  socket: string;
}

/**
 * Not os.tmpdir() for the fallback: it follows $TMPDIR, which a host may set for its own
 * children, so a relay and a person's tsm would find different sockets and different daemons.
 */
export function endpointPaths(env: NodeJS.ProcessEnv = process.env): EndpointPaths {
  const runtime = env.XDG_RUNTIME_DIR;
  const dir = runtime && path.isAbsolute(runtime) ? path.join(runtime, 'terminal-sessions') : `/tmp/terminal-sessions-${os.userInfo().uid}`;
  return { dir, socket: path.join(dir, 'daemon.sock') };
}

export class EndpointError extends Error {
  override name = 'EndpointError';
}

export function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new EndpointError(`can't create ${dir}: ${(e as Error).message}`);
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new EndpointError(`${dir} isn't a directory${st.isSymbolicLink() ? ' (it is a symbolic link)' : ''}; remove it, or give another with --socket`);
  const uid = os.userInfo().uid;
  if (st.uid !== uid) throw new EndpointError(`${dir} belongs to uid ${st.uid}, not to this user (${uid}); give another with --socket`);
  if ((st.mode & 0o077) !== 0) throw new EndpointError(`${dir} can be entered by others (mode ${(st.mode & 0o777).toString(8)}); \`chmod 700 ${dir}\` fixes it`);
}

export type Probe = 'answers' | 'refused' | 'missing';

export function probe(socket: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socket);
    c.once('connect', () => {
      c.destroy();
      resolve('answers');
    });
    c.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK') resolve('refused');
      else if (e.code === 'ENOENT') resolve('missing');
      // Linux answers a non-blocking connect to a listener whose backlog is full with EAGAIN.
      else if (e.code === 'EAGAIN') resolve('answers');
      else reject(new EndpointError(`can't reach ${socket}: ${e.message}`));
    });
  });
}

export interface Listening {
  path: string;
  stillOurs(): boolean;
  close(): Promise<void>;
}

export interface ListenOptions {
  confirmMs?: number;
}

/**
 * A socket file outlives a daemon that crashed, and a bind fails while it's there, so a dead one
 * must be replaced, and two daemons can find it dead together. Binding under a name of our own and
 * then link()ing it to `socket` fails if the name exists; a rename over a dead one can race, so the
 * daemon that renamed serves only if `socket` is still its inode after `confirmMs`.
 */
export async function listenAt(socket: string, onConnection: (c: net.Socket) => void, opts: ListenOptions = {}): Promise<Listening | 'running'> {
  const own = `${socket}.${process.pid}.${randomBytes(4).toString('hex')}`;
  if (Buffer.byteLength(own) > SOCKET_PATH_MAX) {
    throw new EndpointError(`the socket path ${socket} is too long: the name the daemon binds first, ${Buffer.byteLength(own) - Buffer.byteLength(socket)} bytes longer, is past the ${SOCKET_PATH_MAX} a Unix socket's path can hold; give a shorter one with --socket`);
  }
  let confirmed = false;
  let lost = false;
  const held: net.Socket[] = [];
  const server = net.createServer((c) => {
    if (lost) c.destroy();
    else if (confirmed) onConnection(c);
    else held.push(c);
  });
  const old = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(own, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(old);
  }
  const ino = fs.statSync(own).ino;
  const stillOurs = (): boolean => {
    try {
      return fs.statSync(socket).ino === ino;
    } catch {
      return false;
    }
  };
  const giveUp = async (): Promise<'running'> => {
    lost = true;
    for (const c of held.splice(0)) c.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(own, { force: true });
    return 'running';
  };

  try {
    fs.linkSync(own, socket);
    fs.unlinkSync(own);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      await giveUp();
      throw new EndpointError(`can't place the socket at ${socket}: ${(e as Error).message}`);
    }
    if ((await probe(socket)) === 'answers') return giveUp();
    fs.renameSync(own, socket);
    await new Promise((resolve) => setTimeout(resolve, opts.confirmMs ?? 500));
    if (!stillOurs()) return giveUp();
  }
  confirmed = true;
  for (const c of held.splice(0)) onConnection(c);

  return {
    path: socket,
    stillOurs,
    close: async () => {
      const ours = stillOurs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ours) fs.rmSync(socket, { force: true });
    },
  };
}
