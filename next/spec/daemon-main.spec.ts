import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ORPHAN_CHECK_MS, runDaemon, type RunningDaemon } from '../src/endpoint/daemon-main.js';
import { helloLine } from '../src/endpoint/hello.js';
import type { OpenOptions } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

function options(socket: string, sessions: FakeSession[]) {
  return {
    socket,
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      sessions.push(s);
      return s;
    },
    shell: '/bin/bash',
    env: {},
    version: '2.0.0',
    log: () => {},
    confirmMs: 50,
  };
}

const running = (r: RunningDaemon | 'running'): RunningDaemon => {
  assert.notEqual(r, 'running');
  return r as RunningDaemon;
};

async function openMain(socket: string): Promise<net.Socket> {
  const c = net.connect(socket);
  c.on('error', () => {});
  c.setEncoding('utf8');
  let buf = '';
  const answered = new Promise<void>((resolve) => {
    c.on('data', (d: string) => {
      buf += d;
      if (buf.includes('"id":2')) resolve();
    });
  });
  await new Promise<void>((r) => c.once('connect', () => r()));
  c.write(helloLine({ version: '2.0.0', scope: 'a', client: 'relay' }));
  c.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}\n');
  c.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open","arguments":{"name":"main"}}}\n');
  await answered;
  return c;
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} not within ${ms} ms`)), ms))]);

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-d-'));

test('H2: a second daemon at the same socket finds the first and starts none', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const first = running(await runDaemon(options(socket, [])));
  try {
    assert.equal(await runDaemon(options(socket, [])), 'running');
  } finally {
    await first.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H10: stopping hangs up every shell and removes the socket', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const sessions: FakeSession[] = [];
  const d = running(await runDaemon(options(socket, sessions)));
  try {
    const c = await openMain(socket);
    c.destroy();
    assert.equal(sessions.length, 1);
    await d.stop('test');
    assert.ok(sessions[0]!.closedWith, 'the shell was hung up');
    assert.equal(fs.existsSync(socket), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection made while the daemon stops is accepted and closed at once, so the stop still finishes', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const sessions: FakeSession[] = [];
  const d = running(await runDaemon(options(socket, sessions)));
  let release = (): void => {};
  let late: net.Socket | undefined;
  try {
    const c = await openMain(socket);
    c.destroy();
    const gate = new Promise<void>((r) => (release = r));
    const s = sessions[0]!;
    const close = s.close.bind(s);
    s.close = async (o) => {
      await gate;
      return close(o);
    };
    const stopping = d.stop('test');
    const conn = net.connect(socket);
    late = conn;
    conn.on('error', () => {});
    await within(new Promise<void>((r) => conn.once('connect', () => r())), 2_000, 'the late connection');
    await within(new Promise<void>((r) => conn.once('close', () => r())), 2_000, 'the late connection closing');
    release();
    await within(stopping, 5_000, 'the stop');
    assert.equal(fs.existsSync(socket), false);
  } finally {
    late?.destroy();
    release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H2: a daemon whose socket another took, with no connection left, ends its shells and stops', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const sessions: FakeSession[] = [];
  const d = running(await runDaemon(options(socket, sessions)));
  const other = net.createServer((c) => c.destroy());
  try {
    const c = await openMain(socket);
    await new Promise<void>((r) => other.listen(path.join(dir, 'other.sock'), r));
    fs.renameSync(path.join(dir, 'other.sock'), socket);
    await new Promise((r) => setTimeout(r, ORPHAN_CHECK_MS + 300));
    assert.equal(sessions[0]!.closedWith, undefined, 'a connection remains, so it serves on past an orphan check');
    c.destroy();
    await within(d.stopped, 2000, 'the orphaned daemon stopping');
    assert.ok(sessions[0]!.closedWith);
  } finally {
    await d.stop('test');
    await new Promise<void>((r) => other.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H2: a daemon with no connection whose socket another took stops when the socket is replaced', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const d = running(await runDaemon(options(socket, [])));
  const other = net.createServer((c) => c.destroy());
  try {
    await new Promise<void>((r) => other.listen(path.join(dir, 'other.sock'), r));
    fs.renameSync(path.join(dir, 'other.sock'), socket);
    await within(d.stopped, 7000, 'the orphaned daemon stopping, at its next check of its socket');
  } finally {
    await d.stop('test');
    await new Promise<void>((r) => other.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a daemon starting removes the session directories of daemons that died, and leaves a live one\'s and its own', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const sessions = path.join(dir, 'sessions');
  const live = spawn('sleep', ['30'], { stdio: 'ignore' });
  const gone = spawn('true', { stdio: 'ignore' });
  await new Promise((r) => gone.once('exit', r));
  for (const name of [`${gone.pid}-1`, `${live.pid}-2`]) {
    fs.mkdirSync(path.join(sessions, name, 'main-x'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessions, name, 'main-x', 'command'), 'echo secret');
  }
  fs.chmodSync(sessions, 0o700);
  const opened: FakeSession[] = [];
  const d = running(await runDaemon(options(socket, opened)));
  try {
    const left = fs.readdirSync(sessions).sort();
    const own = left.find((n) => n.startsWith(`${process.pid}-`));
    assert.deepEqual(left, [`${live.pid}-2`, own].sort(), 'the dead daemon\'s directory went, the live one\'s stayed');
    const c = await openMain(socket);
    c.destroy();
    assert.equal(opened[0]!.opts.parent, path.join(sessions, own!), 'sessions open under this daemon\'s own directory');
  } finally {
    live.kill();
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
