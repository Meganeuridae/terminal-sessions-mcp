import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { helloLine, parseClientHello, type ClientHello } from '../src/endpoint/hello.js';
import { relay, startDaemon } from '../src/relay.js';

const HELLO: ClientHello = { version: '2.0.0', scope: 'agent-a', client: 'relay' };

interface Fake {
  socket: string;
  server: net.Server;
  conns: net.Socket[];
  firstLines: string[];
  received: string;
  close(): Promise<void>;
}

function fakeDaemon(socket: string, version = '2.0.0'): Promise<Fake> {
  const f: Fake = { socket, server: net.createServer(), conns: [], firstLines: [], received: '', close: () => new Promise((r) => f.server.close(() => r())) };
  f.server.on('connection', (c) => {
    c.on('error', () => {});
    f.conns.push(c);
    c.write(helloLine({ version, pid: 4242, startedAt: '2026-11-08T12:00:00.000Z' }));
    let buf = '';
    let first = true;
    c.on('data', (b) => {
      buf += b.toString();
      if (first) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        f.firstLines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        first = false;
      }
      f.received += buf;
      if (buf.includes('ping\n')) c.write('pong\n');
      buf = '';
    });
  });
  return new Promise((r) => f.server.listen(socket, () => r(f)));
}

function io() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (b) => (out += b));
  stderr.on('data', (b) => (err += b));
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-relay-'));

test('H3: with nothing answering, the relay starts the daemon once, reaches it, sends its hello, and copies bytes both ways unchanged', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const s = io();
  let starts = 0;
  let fake: Fake | undefined;
  const done = relay({
    socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr,
    startDaemon: () => {
      starts++;
      setTimeout(() => void fakeDaemon(socket).then((f) => (fake = f)), 300);
      return 'the log';
    },
  });
  try {
    await until(() => fake !== undefined && fake.conns.length === 1);
    s.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nping\n');
    await until(() => s.out().includes('pong\n'));
    assert.equal(starts, 1);
    assert.deepEqual(parseClientHello(fake!.firstLines[0]!), HELLO);
    assert.equal(fake!.received, '{"jsonrpc":"2.0","id":1,"method":"ping"}\nping\n');
    assert.equal(s.out(), 'pong\n', "the daemon's hello isn't passed to the host");
    s.stdin.end();
    assert.equal(await done, 0, 'stdin ending ends the relay with 0');
  } finally {
    await fake?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: a connection that ends before the daemon\'s hello counts as nothing answering, and the relay keeps trying', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const s = io();
  let closedUnserved = 0;
  const loser = net.createServer((c) => {
    c.on('error', () => {});
    c.resume();
    closedUnserved++;
    if (closedUnserved % 2) c.destroy();
    else c.end();
  });
  await new Promise<void>((r) => loser.listen(socket, r));
  let fake: Fake | undefined;
  const done = relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => 'the log' });
  try {
    await until(() => closedUnserved >= 2);
    await new Promise<void>((r) => loser.close(() => r()));
    fake = await fakeDaemon(socket);
    await until(() => fake!.conns.length === 1);
    s.stdin.end();
    assert.equal(await done, 0);
    assert.equal(s.err(), '');
  } finally {
    await fake?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: when the daemon ends the connection, the relay exits nonzero and never reconnects', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const fake = await fakeDaemon(socket);
  const s = io();
  try {
    const done = relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => assert.fail('a daemon answered') });
    await until(() => fake.conns.length === 1);
    fake.conns[0]!.destroy();
    assert.equal(await done, 1);
    assert.match(s.err(), /the daemon closed the connection \(pid 4242, running since 2026-11-08T12:00:00.000Z\); its shells may be gone\. This relay exits rather than reconnect/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fake.conns.length, 1, 'no second connection');
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: nothing answering within the bound ends the relay nonzero, naming where the started daemon logs', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const s = io();
  s.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  try {
    const code = await relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => '/somewhere/daemon.log', reachMs: 300 });
    assert.equal(code, 1);
    assert.match(s.err(), /no terminal-sessions daemon answered at .*daemon\.sock within 300 ms, though one was started; its log is \/somewhere\/daemon\.log/);
    const answer = JSON.parse(s.out().trim()) as { id: number; error: { message: string } };
    assert.equal(answer.id, 0, "the host's initialize is answered");
    assert.match(answer.error.message, /^tsm-relay: no terminal-sessions daemon answered at .* its log is \/somewhere\/daemon\.log$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: something at the socket that isn\'t a daemon is said to be so', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const other = net.createServer((c) => {
    c.on('error', () => {});
    c.resume();
    c.write('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise<void>((r) => other.listen(socket, r));
  const s = io();
  s.stdin.end();
  try {
    assert.equal(await relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => 'x' }), 1);
    assert.match(s.err(), /something other than a terminal-sessions daemon listens at .*: its first line isn't a hello/);
  } finally {
    await new Promise<void>((r) => other.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: a daemon of another version is named on stderr; one of the same version says nothing', { timeout: 10_000 }, async () => {
  const dir = tmp();
  try {
    for (const [version, expect] of [['1.9.0', /daemon is version 1\.9\.0, running since 2026-11-08T12:00:00\.000Z, and the relay that reached it is 2\.0\.0.*`tsm --socket \S*d-1\.9\.0\.sock daemon stop`/], ['2.0.0', /^$/]] as const) {
      const socket = path.join(dir, `d-${version}.sock`);
      const fake = await fakeDaemon(socket, version);
      try {
        const s = io();
        const done = relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => 'x' });
        await until(() => fake.conns.length === 1);
        s.stdin.end();
        await done;
        assert.match(s.err(), expect);
      } finally {
        await fake.close();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('something that accepts the connection and never greets ends the relay within its bound', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const silent = net.createServer((c) => {
    c.on('error', () => {});
    c.resume();
  });
  await new Promise<void>((r) => silent.listen(socket, r));
  const s = io();
  s.stdin.end();
  try {
    assert.equal(await relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => assert.fail('something answered'), reachMs: 300 }), 1);
    assert.match(s.err(), /accepted the connection but sent no hello within ([1-9]\d*) ms/);
    assert.ok(Number(/within (\d+) ms/.exec(s.err())![1]) <= 300);
  } finally {
    await new Promise<void>((r) => silent.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the relay keeps to its bound by the monotonic clock while the wall clock steps back', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const s = io();
  s.stdin.end();
  const wall = Date.now;
  let t = wall();
  Date.now = () => (t -= 1_000);
  try {
    const ended = relay({ socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, startDaemon: () => '/somewhere/daemon.log', reachMs: 300 });
    const first = await ended;
    Date.now = wall;
    assert.equal(first, 1);
    assert.match(s.err(), /within 300 ms, though one was started/);
  } finally {
    Date.now = wall;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a start that uses the whole bound ends the reach with the bound named, not a wait of no time', { timeout: 10_000 }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const silent = net.createServer((c) => {
    c.on('error', () => {});
    c.resume();
  });
  await new Promise<void>((r) => silent.listen(path.join(dir, 'silent.sock'), r));
  const s = io();
  s.stdin.end();
  try {
    const code = await relay({
      socket, hello: HELLO, stdin: s.stdin, stdout: s.stdout, stderr: s.stderr, reachMs: 300,
      startDaemon: () => {
        fs.renameSync(path.join(dir, 'silent.sock'), socket);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        return '/somewhere/daemon.log';
      },
    });
    assert.equal(code, 1);
    assert.match(s.err(), /no terminal-sessions daemon answered at .* within 300 ms, though one was started; its log is \/somewhere\/daemon\.log/);
  } finally {
    await new Promise<void>((r) => silent.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory others can enter is refused, and the host's first request is answered with why", { timeout: 10_000 }, async () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  try {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/relay.js'), '--socket', path.join(dir, 'daemon.sock')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    const code = await new Promise<number | null>((r) => child.once('exit', r));
    assert.equal(code, 1);
    const answer = JSON.parse(out.trim()) as { id: number; error: { message: string } };
    assert.equal(answer.id, 1);
    assert.match(answer.error.message, /^tsm-relay: .* can be entered by others \(mode 755\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a relay that can't reach a daemon answers the host's first request though a notification came first, with an id written in two pieces", { timeout: 10_000 }, async () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  try {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/relay.js'), '--socket', path.join(dir, 'daemon.sock')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    child.stdin.on('error', () => {});
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const request = Buffer.from('{"jsonrpc":"2.0","id":"café","method":"initialize","params":{}}\n', 'utf8');
    const at = request.indexOf(Buffer.from('é', 'utf8')) + 1;
    child.stdin.write(request.subarray(0, at));
    await new Promise((r) => setTimeout(r, 100));
    child.stdin.write(request.subarray(at));
    try {
      assert.equal(await exited, 1);
      assert.ok(out.trim(), 'the relay answered');
      const answer = JSON.parse(out.trim()) as { id: string; error: { message: string } };
      assert.equal(answer.id, 'café');
      assert.match(answer.error.message, /can be entered by others/);
    } finally {
      child.kill();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a relay whose systemd-run fails says so, and that the daemon it starts instead ends with its host', { skip: process.platform !== 'linux', timeout: 10_000 }, async () => {
  const dir = tmp();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemd-run'), '#!/bin/sh\necho "Failed to start transient service unit: Unit already exists." >&2\nexit 1\n', { mode: 0o755 });
  const script = path.join(dir, 'daemon.js');
  fs.writeFileSync(script, '');
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was ?? ''}`;
  try {
    const notes: string[] = [];
    const log = startDaemon(script, path.join(dir, 'daemon.sock'), path.join(dir, 'daemon.log'), 5_000, (n) => notes.push(n));
    assert.equal(log, path.join(dir, 'daemon.log'));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /^systemd-run --user failed \(status 1: Failed to start transient service unit: Unit already exists\.\), so the daemon starts detached in this relay's control group, and ends when the host's service stops$/);
  } finally {
    process.env.PATH = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
