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
  const sessionsDir = path.join(dir, 'sessions');
  ensurePrivateDir(sessionsDir);
  const startedAt = Date.now();
  const host = new Host({ openSession: o.openSession, shell: o.shell, env: o.env, sessionsDir, startedAt, ...(o.oomScoreAdj ? { oomScoreAdj: o.oomScoreAdj } : {}) });
  const info = { version: o.version, pid: process.pid, startedAt };
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
      await listening?.close();
      await host.closeAll();
      resolveStopped();
    })();
    return stopping;
  };
  const lostSocket = (): boolean => listening !== undefined && !listening.stillOurs();
  const orphaned = (): void => {
    if (conns.size === 0 && lostSocket()) void stop(`${o.socket} is no longer this daemon's socket, and no connection remains, so no client can reach its shells`);
  };

  const r = await listenAt(
    o.socket,
    (c) => {
      conns.add(c);
      c.once('close', () => {
        conns.delete(c);
        orphaned();
      });
      serveConnection(c, host, info);
    },
    o.confirmMs === undefined ? {} : { confirmMs: o.confirmMs },
  );
  if (r === 'running') return 'running';
  listening = r;
  // Checked against this daemon's inode on a timer, not watched for changes: a watch can miss a
  // change made just as it starts (macOS's directory events and fs.watchFile's first stat both start
  // asynchronously), and a missed one would leave this daemon holding shells no client can reach.
  checking = setInterval(orphaned, ORPHAN_CHECK_MS);
  checking.unref();
  o.log(`listening at ${o.socket}, version ${o.version}, pid ${process.pid}`);
  return { stop, stopped };
}
