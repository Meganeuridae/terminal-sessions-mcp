import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { endpointPaths, ensurePrivateDir, listenAt, probe, type Listening } from '../src/endpoint/socket.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-ep-'));

const greet = (tag: string) => (c: net.Socket): void => {
  c.on('error', () => {});
  c.end(`${tag}\n`);
};

const ask = (socket: string): Promise<string> =>
  new Promise((resolve) => {
    const c = net.connect(socket);
    let got = '';
    c.on('data', (b) => (got += b));
    c.on('close', () => resolve(got.trim() || 'closed without a word'));
    c.on('error', (e: NodeJS.ErrnoException) => resolve(`error ${e.code}`));
  });

const listening = (r: Listening | 'running'): Listening => {
  assert.notEqual(r, 'running');
  return r as Listening;
};

test('H1: the socket lives in the runtime directory, else in a directory of the user\'s own under /tmp', () => {
  assert.deepEqual(endpointPaths({ XDG_RUNTIME_DIR: '/run/user/1000' }), { dir: '/run/user/1000/terminal-sessions', socket: '/run/user/1000/terminal-sessions/daemon.sock' });
  const fallback = endpointPaths({ TMPDIR: '/var/host-tmp' });
  assert.equal(fallback.dir, `/tmp/terminal-sessions-${os.userInfo().uid}`, "not $TMPDIR, which a host may set for its children alone");
  assert.equal(fallback.socket, path.join(fallback.dir, 'daemon.sock'));
  assert.equal(endpointPaths({ XDG_RUNTIME_DIR: 'relative/dir' }).dir, fallback.dir);
});

test('H1: the directory is made 0700, and one others can enter, or a symbolic link, is refused', () => {
  const root = tmp();
  try {
    const dir = path.join(root, 'ts');
    ensurePrivateDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    ensurePrivateDir(dir);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => ensurePrivateDir(dir), /can be entered by others \(mode 755\); `chmod 700/);
    const link = path.join(root, 'link');
    fs.symlinkSync(dir, link);
    assert.throws(() => ensurePrivateDir(link), /isn't a directory \(it is a symbolic link\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H1: only the user can connect: the socket is 0600', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const l = listening(await listenAt(socket, greet('A')));
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    assert.equal(await ask(socket), 'A');
  } finally {
    await l.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: a socket path too long for the platform is refused with the reason, counting the name the daemon binds first', async () => {
  const fits = `/tmp/${'x'.repeat(100 - '/tmp//d.sock'.length)}/d.sock`;
  assert.equal(fits.length, 100);
  await assert.rejects(listenAt(fits, greet('A')), /is too long: the name the daemon binds first, \d+ bytes longer, is past the 103/);
});

test('H2: a second daemon finds the first answering and serves nothing', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const first = listening(await listenAt(socket, greet('A')));
  try {
    assert.equal(await listenAt(socket, greet('B')), 'running');
    assert.equal(await ask(socket), 'A');
    assert.deepEqual(fs.readdirSync(dir), ['daemon.sock'], 'the second leaves nothing behind');
  } finally {
    await first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H2: a dead daemon\'s socket file is replaced', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(path.join(dir, 'dead.sock'), r));
  fs.linkSync(path.join(dir, 'dead.sock'), socket);
  await new Promise<void>((r) => dead.close(() => r()));
  assert.equal(await probe(socket), 'refused');
  const l = listening(await listenAt(socket, greet('A'), { confirmMs: 50 }));
  try {
    assert.equal(await ask(socket), 'A');
  } finally {
    await l.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H2: a daemon whose replacement of a dead socket is itself replaced serves no request, and its held connections close unanswered', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  fs.writeFileSync(socket, '');
  let served = 0;
  const loser = listenAt(socket, (c) => {
    c.on('error', () => {});
    served++;
    c.end('A\n');
  }, { confirmMs: 300 });
  // Once the loser has renamed its socket into place, a connection reaches it; then another daemon renames over it.
  while ((await probe(socket)) !== 'answers') await new Promise((r) => setTimeout(r, 5));
  const heldAnswer = ask(socket);
  const winner = net.createServer(greet('B'));
  await new Promise<void>((r) => winner.listen(path.join(dir, 'winner.sock'), r));
  fs.renameSync(path.join(dir, 'winner.sock'), socket);
  try {
    assert.equal(await loser, 'running');
    assert.equal(await heldAnswer, 'closed without a word');
    assert.equal(served, 0);
    assert.equal(await ask(socket), 'B');
  } finally {
    await new Promise<void>((r) => winner.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H10: closing removes the socket when it is still ours, and leaves one another daemon put there', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  try {
    const a = listening(await listenAt(socket, greet('A')));
    await a.close();
    assert.equal(fs.existsSync(socket), false);

    const b = listening(await listenAt(socket, greet('B')));
    const other = net.createServer(greet('C'));
    await new Promise<void>((r) => other.listen(path.join(dir, 'other.sock'), r));
    fs.renameSync(path.join(dir, 'other.sock'), socket);
    assert.equal(b.stillOurs(), false);
    await b.close();
    assert.equal(await ask(socket), 'C');
    await new Promise<void>((r) => other.close(() => r()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
