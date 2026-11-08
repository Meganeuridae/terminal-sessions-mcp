#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { helloLine, parseDaemonHello, SCOPE_RE, versionNote, type ClientHello, type DaemonHello } from './endpoint/hello.js';
import { endpointPaths, ensurePrivateDir } from './endpoint/socket.js';
import { packageVersion } from './endpoint/version.js';

export interface RelayOptions {
  socket: string;
  hello: ClientHello;
  startDaemon: () => string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  reachMs?: number;
}

/**
 * How long the relay keeps trying to reach a daemon, starting one. A host sends `initialize` as
 * soon as it has launched the relay, and agent-framework gives up on a request after 60 s
 * (DEFAULT_REQUEST_TIMEOUT_MS in src/mcpl/server-connection.ts at aa134e75fc), so the daemon must
 * be reached in time to answer it; 5 s of it are left for the answer, as for a call's wait.
 */
export const REACH_MS = 55_000;

export type Reached = { socket: net.Socket; daemon: DaemonHello; rest: Buffer };

function reachOnce(socketPath: string, hello: ClientHello): Promise<Reached | 'nothing'> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r: Reached | 'nothing' | Error): void => {
      if (done) return;
      done = true;
      socket.off('data', onData);
      if (r === 'nothing' || r instanceof Error) socket.destroy();
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const onData = (b: Buffer): void => {
      buf = Buffer.concat([buf, b]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 65536) finish(new Error(`something other than a terminal-sessions daemon listens at ${socketPath}`));
        return;
      }
      const daemon = parseDaemonHello(buf.subarray(0, nl).toString('utf8'));
      if (!daemon) return finish(new Error(`something other than a terminal-sessions daemon listens at ${socketPath}: its first line isn't a hello`));
      socket.pause();
      finish({ socket, daemon, rest: buf.subarray(nl + 1) });
    };
    socket.on('data', onData);
    socket.once('connect', () => socket.write(helloLine(hello)));
    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE') finish('nothing');
      else finish(new Error(`can't reach the daemon at ${socketPath}: ${e.message}`));
    });
    socket.once('close', () => finish('nothing'));
  });
}

export async function reach(o: Pick<RelayOptions, 'socket' | 'hello' | 'startDaemon' | 'reachMs'>): Promise<Reached> {
  const end = Date.now() + (o.reachMs ?? REACH_MS);
  let log: string | undefined;
  for (;;) {
    const r = await reachOnce(o.socket, o.hello);
    if (r !== 'nothing') return r;
    if (Date.now() >= end) {
      throw new Error(`no terminal-sessions daemon answered at ${o.socket} within ${o.reachMs ?? REACH_MS} ms${log ? `, though one was started; its log is ${log}` : ''}`);
    }
    log ??= o.startDaemon();
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function relay(o: RelayOptions): Promise<number> {
  let reached: Reached;
  try {
    reached = await reach(o);
  } catch (e) {
    o.stderr.write(`tsm-relay: ${(e as Error).message}\n`);
    return 1;
  }
  const { socket, daemon, rest } = reached;
  const note = versionNote(o.hello.version, daemon);
  if (note) o.stderr.write(`tsm-relay: ${note}\n`);
  if (rest.length) o.stdout.write(rest);

  return new Promise<number>((resolve) => {
    let inputEnded = false;
    socket.pipe(o.stdout, { end: false });
    o.stdin.pipe(socket, { end: false });
    o.stdin.once('end', () => {
      inputEnded = true;
      socket.end();
    });
    socket.once('error', () => {});
    o.stdout.once('error', () => socket.destroy());
    socket.once('close', () => {
      o.stdin.unpipe(socket);
      if (inputEnded) return resolve(0);
      o.stderr.write(`tsm-relay: the daemon closed the connection (pid ${daemon.pid}, running since ${daemon.startedAt}); its shells may be gone. This relay exits rather than reconnect, so nothing it was sent is sent again.\n`);
      resolve(1);
    });
    socket.resume();
  });
}

/**
 * Detaching from the relay's process group isn't enough under systemd, which stops every process
 * in a service's control group when the service stops, so a daemon a resident's service started
 * would end with the resident. A transient user unit of its own escapes that; it takes the
 * settings next/config/termd.service gives the daemon, for the reasons given there.
 */
export function startDaemon(daemonScript: string, socket: string, log: string): string {
  const args = [daemonScript, '--socket', socket];
  if (process.platform === 'linux') {
    const unit = `terminal-sessions-${process.pid}-${Date.now()}`;
    const props = ['KillMode=process', 'OOMPolicy=continue'].flatMap((p) => ['-p', p]);
    const r = spawnSync('systemd-run', ['--user', '--collect', '--quiet', '--unit', unit, ...props, '--', process.execPath, ...args], { stdio: 'ignore', timeout: REACH_MS });
    if (r.status === 0) return `the user journal (journalctl --user -u ${unit})`;
  }
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] }).unref();
  } finally {
    fs.closeSync(fd);
  }
  return log;
}

function usage(stderr: Writable): number {
  stderr.write('usage: tsm-relay [--scope NAME] [--socket PATH]\n');
  return 2;
}

async function main(argv: string[]): Promise<number> {
  let scope = 'default';
  let socket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope' && argv[i + 1] !== undefined) scope = argv[++i]!;
    else if (a === '--socket' && argv[i + 1] !== undefined) socket = argv[++i]!;
    else return usage(process.stderr);
  }
  if (!SCOPE_RE.test(scope)) {
    process.stderr.write(`tsm-relay: --scope ${JSON.stringify(scope)} isn't a scope: 1 to 64 letters, digits, '.', '_' or '-'\n`);
    return 2;
  }
  const paths = socket ? { dir: path.dirname(socket), socket } : endpointPaths();
  try {
    ensurePrivateDir(paths.dir);
  } catch (e) {
    process.stderr.write(`tsm-relay: ${(e as Error).message}\n`);
    return 1;
  }
  const daemonScript = fileURLToPath(new URL('./daemon.js', import.meta.url));
  return relay({
    socket: paths.socket,
    hello: { version: packageVersion(), scope, client: 'relay' },
    startDaemon: () => startDaemon(daemonScript, paths.socket, path.join(paths.dir, 'daemon.log')),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.stdin.destroy();
    process.exitCode = code;
  });
}
