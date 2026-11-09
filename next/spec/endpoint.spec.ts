import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { versionNote } from '../src/endpoint/hello.js';
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

async function deadSocket(dir: string, socket: string): Promise<void> {
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(path.join(dir, 'dead.sock'), r));
  fs.linkSync(path.join(dir, 'dead.sock'), socket);
  await new Promise<void>((r) => dead.close(() => r()));
}

const listening = (r: Listening | 'running'): Listening => {
  assert.notEqual(r, 'running');
  return r as Listening;
};

test('H1: the socket lives in the runtime directory, else in /run/user/<uid>, else in a directory of the user\'s own under /tmp', () => {
  assert.deepEqual(endpointPaths({ XDG_RUNTIME_DIR: '/run/user/1000' }), { dir: '/run/user/1000/terminal-sessions', socket: '/run/user/1000/terminal-sessions/daemon.sock' });
  const fallback = endpointPaths({ TMPDIR: '/var/host-tmp' }, () => undefined);
  assert.equal(fallback.dir, `/tmp/terminal-sessions-${os.userInfo().uid}`, "not $TMPDIR, which a host may set for its children alone");
  assert.equal(endpointPaths({}, (uid) => `/run/user/${uid}`).dir, `/run/user/${os.userInfo().uid}/terminal-sessions`, "without $XDG_RUNTIME_DIR, the user's /run/user directory before /tmp");
  assert.equal(fallback.socket, path.join(fallback.dir, 'daemon.sock'));
  assert.equal(endpointPaths({ XDG_RUNTIME_DIR: 'relative/dir' }, () => undefined).dir, fallback.dir);
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
  await deadSocket(dir, socket);
  let served = 0;
  const loser = listenAt(socket, (c) => {
    c.on('error', () => {});
    served++;
    c.end('A\n');
  }, { confirmMs: 2000 });
  const placed = Date.now() + 5_000;
  while ((await probe(socket)) !== 'answers') {
    if (Date.now() > placed) assert.fail('the first daemon never placed its socket');
    await new Promise((r) => setTimeout(r, 5));
  }
  const held = net.connect(socket);
  await new Promise<void>((r) => held.once('connect', () => r()));
  const heldAnswer = new Promise<string>((resolve) => {
    let got = '';
    held.on('data', (b) => (got += b));
    held.on('error', () => {});
    held.on('close', () => resolve(got ? got.trim() : 'closed without a word'));
  });
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

test('a close that another daemon\'s rename overtakes leaves that daemon\'s socket', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const other = net.createServer(greet('C'));
  try {
    const a = listening(await listenAt(socket, greet('A')));
    await new Promise<void>((r) => other.listen(path.join(dir, 'other.sock'), r));
    const closing = a.close();
    fs.renameSync(path.join(dir, 'other.sock'), socket);
    await closing;
    assert.equal(await ask(socket), 'C');
  } finally {
    await new Promise<void>((r) => other.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a probe that fails after the bind gives up the bound name and rejects', { skip: process.getuid?.() === 0 ? 'root connects through a socket of mode 000' : false }, async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  const stale = net.createServer();
  await new Promise<void>((r) => stale.listen(socket, r));
  fs.chmodSync(socket, 0o000);
  try {
    await assert.rejects(listenAt(socket, greet('A')), /can't reach/);
    assert.deepEqual(fs.readdirSync(dir), ['daemon.sock'], 'its own bound name is gone');
  } finally {
    await new Promise<void>((r) => stale.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('something at the socket path that is not a socket is left as it is, and the daemon says what it is', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'daemon.sock');
  fs.writeFileSync(socket, 'notes');
  try {
    await assert.rejects(listenAt(socket, greet('A'), { confirmMs: 50 }), /daemon\.sock is a regular file, not a socket, so the daemon leaves it alone/);
    assert.equal(fs.readFileSync(socket, 'utf8'), 'notes');
    assert.deepEqual(fs.readdirSync(dir), ['daemon.sock'], 'its own bound name is gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the version note's restart command quotes a socket path the shell would split", () => {
  const note = versionNote('2.0.1', { version: '2.0.0', pid: 1, startedAt: '2026-11-09T00:00:00.000Z' }, '/tmp/my sockets/daemon.sock');
  assert.match(note ?? '', /`tsm --socket '\/tmp\/my sockets\/daemon\.sock' daemon stop`/);
});
