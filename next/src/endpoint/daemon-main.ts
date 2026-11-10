import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as path from 'node:path';
import type { OpenSession } from '../session/types.js';
import { Host } from '../tools/host.js';
import { serveConnection } from './connection.js';
import { ensurePrivateDir, listenAt, type Listening } from './socket.js';

export interface DaemonOptions {
  socket: string;
  openSession: OpenSession;
  shell: string;
  env: Record<string, string>;
  version: string;
  log: (line: string) => void;
  oomScoreAdj?: number;
  confirmMs?: number;
}

export interface RunningDaemon {
  stop(why: string): Promise<void>;
  stopped: Promise<void>;
}

/**
 * How soon a daemon with no connection notices that its socket is no longer its own: each check is
 * one stat, and the shells it holds run on either way until it stops.
 */
export const ORPHAN_CHECK_MS = 5_000;

export async function runDaemon(o: DaemonOptions): Promise<RunningDaemon | 'running'> {
  const dir = path.dirname(o.socket);
  ensurePrivateDir(dir);
  const sessionsRoot = path.join(dir, 'sessions');
  ensurePrivateDir(sessionsRoot);
  const startedAt = Date.now();
  const ownName = `${process.pid}-${startedAt}`;
  const sessionsDir = path.join(sessionsRoot, ownName);
  fs.mkdirSync(sessionsDir, { mode: 0o700 });
  const host = new Host({ openSession: o.openSession, shell: o.shell, env: o.env, sessionsDir, startedAt, log: o.log, ...(o.oomScoreAdj ? { oomScoreAdj: o.oomScoreAdj } : {}) });
  const info = { version: o.version, pid: process.pid, startedAt, socket: o.socket };
  const conns = new Set<net.Socket>();
  let listening: Listening | undefined;
  let stopping: Promise<void> | undefined;
  let checking: NodeJS.Timeout | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));

  const stop = (why: string): Promise<void> => {
    stopping ??= (async () => {
      o.log(`stopping: ${why}`);
      clearInterval(checking);
      for (const c of conns) c.destroy();
      await host.closeAll().catch((e: Error) => o.log(`closing the sessions failed: ${e.message}`));
      await listening?.close().catch((e: Error) => o.log(`closing the socket failed: ${e.message}`));
      resolveStopped();
    })();
    return stopping;
  };
  const lostSocket = (): boolean => listening !== undefined && !listening.stillOurs();
  const orphaned = (): void => {
    if (conns.size === 0 && lostSocket()) void stop(`${o.socket} is no longer this daemon's socket, and no connection remains, so no client can reach its shells`);
  };

  let r: Listening | 'running';
  try {
    r = await listenAt(
      o.socket,
      (c) => {
        if (stopping) {
          c.destroy();
          return;
        }
        conns.add(c);
        c.once('close', () => {
          conns.delete(c);
          orphaned();
        });
        serveConnection(c, host, info, (why) => void stop(why), o.log);
      },
      o.confirmMs === undefined ? {} : { confirmMs: o.confirmMs },
    );
  } catch (e) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    throw e;
  }
  if (r === 'running') {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    return 'running';
  }
  listening = r;
  removeDeadDaemonsDirs(sessionsRoot, ownName, o.log);
  // Checked against this daemon's inode on a timer, not watched for changes: a watch can miss a
  // change made just as it starts (macOS's directory events and fs.watchFile's first stat both start
  // asynchronously), and a missed one would leave this daemon holding shells no client can reach.
  checking = setInterval(orphaned, ORPHAN_CHECK_MS);
  checking.unref();
  o.log(`listening at ${o.socket}, version ${o.version}, pid ${process.pid}`);
  return { stop, stopped };
}

function removeDeadDaemonsDirs(root: string, own: string, log: (line: string) => void): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    log(`can't list ${root} for what a daemon that died left there: ${(e as Error).message}`);
    return;
  }
  for (const name of names) {
    const m = /^(\d+)-\d+$/.exec(name);
    if (!m || name === own || alive(Number(m[1]))) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch (e) {
      log(`can't remove ${path.join(root, name)}, which a daemon that died left: ${(e as Error).message}`);
    }
  }
}

function alive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
