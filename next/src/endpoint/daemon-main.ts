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
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));
  let watcher: fs.FSWatcher | undefined;

  const stop = (why: string): Promise<void> => {
    stopping ??= (async () => {
      o.log(`stopping: ${why}`);
      watcher?.close();
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
  watcher = fs.watch(dir, () => orphaned());
  watcher.on('error', () => {});
  o.log(`listening at ${o.socket}, version ${o.version}, pid ${process.pid}`);
  return { stop, stopped };
}
