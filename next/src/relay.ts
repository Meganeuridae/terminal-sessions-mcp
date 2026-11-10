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
  /** Starts a daemon and returns its log's path; `after` says one was seen closing its connections before this. */
  startDaemon: (budgetMs: number, after?: 'closing') => string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  reachMs?: number;
}

/**
 * How long the relay keeps trying to reach a daemon, starting one. A host sends `initialize` as
 * soon as it has launched the relay, and agent-framework gives up on that handshake after 30 s
 * (INITIALIZE_TIMEOUT_MS in src/mcpl/server-connection.ts at 36b6dfe9de) and kills the child, so
 * the relay must reach a daemon, or say why it couldn't, within it; 5 s of it are left for the
 * answer, as for a call's wait.
 */
export const REACH_MS = 25_000;

export type Reached = { socket: net.Socket; daemon: DaemonHello; rest: Buffer };

function reachOnce(socketPath: string, hello: ClientHello, budgetMs: number): Promise<Reached | 'nothing' | 'closing'> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    let done = false;
    let connected = false;
    const timer = setTimeout(() => finish(new Error(`something at ${socketPath} accepted the connection but sent no hello within ${budgetMs} ms`)), budgetMs);
    const finish = (r: Reached | 'nothing' | 'closing' | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off('data', onData);
      if (r === 'nothing' || r === 'closing' || r instanceof Error) socket.destroy();
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
    socket.once('connect', () => {
      connected = true;
      socket.write(helloLine(hello));
    });
    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE') finish(connected ? 'closing' : 'nothing');
      else finish(new Error(`can't reach the daemon at ${socketPath}: ${e.message}`));
    });
    socket.once('close', () => finish(connected ? 'closing' : 'nothing'));
  });
}

export async function reach(o: Pick<RelayOptions, 'socket' | 'hello' | 'startDaemon' | 'reachMs'>): Promise<Reached> {
  const bound = o.reachMs ?? REACH_MS;
  const end = performance.now() + bound;
  let log: string | undefined;
  let closing = false;
  const none = (): Error =>
    new Error(closing
      ? `a terminal-sessions daemon at ${o.socket} still accepted connections and closed them before its hello after ${bound} ms, as one that is stopping does`
      : `no terminal-sessions daemon answered at ${o.socket} within ${bound} ms${log ? `, though one was started; its log is ${log}` : ''}`);
  for (;;) {
    const left = end - performance.now();
    if (left <= 0) throw none();
    const r = await reachOnce(o.socket, o.hello, Math.ceil(left));
    if (r !== 'nothing' && r !== 'closing') return r;
    if (performance.now() >= end) throw none();
    if (r === 'closing') closing = true;
    else {
      log ??= o.startDaemon(Math.ceil(end - performance.now()), closing ? 'closing' : undefined);
      closing = false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function relay(o: RelayOptions): Promise<number> {
  let reached: Reached;
  try {
    reached = await reach(o);
  } catch (e) {
    const reason = `tsm-relay: ${(e as Error).message}`;
    o.stderr.write(`${reason}\n`);
    await answerFirstRequest(o.stdin, o.stdout, reason);
    return 1;
  }
  const { socket, daemon, rest } = reached;
  const note = versionNote(o.hello.version, daemon, o.socket);
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
export function startDaemon(daemonScript: string, socket: string, log: string, budgetMs: number, note: (line: string) => void): string {
  const args = [daemonScript, '--socket', socket];
  if (process.platform === 'linux') {
    const unit = `terminal-sessions-${process.pid}-${Date.now()}`;
    const props = ['KillMode=process', 'OOMPolicy=continue'].flatMap((p) => ['-p', p]);
    const r = spawnSync('systemd-run', ['--user', '--collect', '--quiet', '--unit', unit, ...props, '--', process.execPath, ...args], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: budgetMs, killSignal: 'SIGKILL' });
    if (r.status === 0) return `the user journal (journalctl --user -u ${unit})`;
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT') {
      throw new Error(`systemd-run --user didn't finish within the ${budgetMs} ms left to reach a daemon, so whether it started one is unknown, and no other was started`);
    }
    const why = code ?? `status ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim().split('\n')[0]!.slice(0, 200)}` : ''}`;
    note(`systemd-run --user failed (${why}), so the daemon starts detached in this relay's control group, and ends when the host's service stops`);
  }
  const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
  const fd = fs.openSync(log, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND, 0o600);
  try {
    spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] }).unref();
  } finally {
    fs.closeSync(fd);
  }
  return log;
}

function answerFirstRequest(stdin: Readable, stdout: Writable, reason: string): Promise<void> {
  return new Promise((resolve) => {
    let buf = '';
    const done = (): void => {
      stdin.off('data', onData);
      stdin.off('end', done);
      resolve();
    };
    const onData = (b: string): void => {
      buf += b;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: unknown; method?: unknown } | undefined;
        try {
          m = JSON.parse(line) as { id?: unknown; method?: unknown };
        } catch {
          m = undefined;
        }
        if (m && (typeof m.id === 'number' || typeof m.id === 'string') && typeof m.method === 'string') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: reason } })}\n`);
          return done();
        }
      }
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.resume();
  });
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
    const reason = `tsm-relay: ${(e as Error).message}`;
    process.stderr.write(`${reason}\n`);
    await answerFirstRequest(process.stdin, process.stdout, reason);
    return 1;
  }
  const daemonScript = fileURLToPath(new URL('./daemon.js', import.meta.url));
  return relay({
    socket: paths.socket,
    hello: { version: packageVersion(), scope, client: 'relay' },
    startDaemon: (budgetMs) => startDaemon(daemonScript, paths.socket, path.join(paths.dir, 'daemon.log'), budgetMs, (line) => process.stderr.write(`tsm-relay: ${line}\n`)),
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
