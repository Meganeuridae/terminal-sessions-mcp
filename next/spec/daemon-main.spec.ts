import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDaemon, type RunningDaemon } from '../src/endpoint/daemon-main.js';
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
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sessions[0]!.closedWith, undefined, 'a connection remains, so it serves on');
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
    await within(d.stopped, 2000, 'the orphaned daemon stopping');
  } finally {
    await d.stop('test');
    await new Promise<void>((r) => other.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
