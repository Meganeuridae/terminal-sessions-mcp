/**
 * termd's startup and hardening as a process: strict flags (tsg-18), no
 * `--anonymous` on a network bind (tsg-6), a warned and scrubbed `--token`
 * (tsg-20), a dead log reader that neither spins nor blocks the drain (tsg-5),
 * a second daemon that never touches a live one's journals (jr2-2, tsg-1),
 * sessions that start in $HOME (ux-16), and a log file of its own (tsg-16).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(here, '../src/daemon.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-termd-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Daemon {
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
}

/** HOME and HISTFILE point into the temp dir: no shell here touches the user's files. */
function termd(argv: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; stderr?: 'pipe' | 'ignore' } = {}): Daemon {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [DAEMON, ...argv], {
    env: { ...process.env, HOME: home, HISTFILE: path.join(home, '.bash_history'), TSM_TOKEN: '', SHELL: '/bin/bash', ...opts.env },
    cwd: opts.cwd ?? tmp,
    stdio: ['ignore', 'ignore', opts.stderr ?? 'pipe'],
  });
  const lines: string[] = [];
  let buf = '';
  child.stderr?.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, lines, exited };
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function stop(d: Daemon): Promise<number | null> {
  if (d.child.exitCode !== null) return d.child.exitCode;
  d.child.kill('SIGTERM');
  const code = await Promise.race([d.exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 10_000))]);
  if (code === 'hung') {
    d.child.kill('SIGKILL');
    return null;
  }
  return code;
}

const listening = (d: Daemon) => d.lines.find((l) => l.includes('"listening"'));
const urlOf = (d: Daemon) => (JSON.parse(listening(d)!) as { url: string }).url;

function unusedPort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** One tools/call over a fresh connection. */
async function call(url: string, name: string, args: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`${url}/?profile=full${token ? `&token=${token}` : ''}`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  try {
    return await new Promise((resolve) => {
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString()) as { id?: number; result?: { structuredContent: Record<string, unknown> } };
        if (msg.id === 1) resolve(msg.result?.structuredContent ?? {});
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    });
  } finally {
    ws.close(1000);
  }
}

test('tsg-18/ux-24: unknown flags, missing values and values that look like flags are errors, never a silent unauthenticated start', async () => {
  const f = path.join(tmp, 'tokens.json');
  fs.writeFileSync(f, JSON.stringify({ 'tok-1': 'agent:a@x' }), { mode: 0o600 });
  for (const argv of [
    ['--tokens_file', f], // a typo
    ['--token', '--secret-token'], // a value that is another flag
    ['--anonymous'], // a flag missing its value
    ['--port', '0', 'stray'], // a positional
  ]) {
    const d = termd([...argv, '--port', '0', '--data-dir', path.join(tmp, 'flags')]);
    // It must exit; a daemon that starts listening instead is the bug (and is stopped here).
    const started = until(() => listening(d) !== undefined, 10_000, 'listening').then(() => 'listening' as const, () => 'never' as const);
    const outcome = await Promise.race([d.exited, started]);
    if (outcome === 'listening') await stop(d);
    assert.equal(outcome, 2, `${argv.join(' ')}: ${d.lines.join('\n')}`);
    assert.match(d.lines.join('\n'), /termd --help/);
  }
});

test('tsg-6: --anonymous never satisfies a network bind, and the refusal does not recommend it', async () => {
  const f = path.join(tmp, 'tokens6.json');
  fs.writeFileSync(f, JSON.stringify({ 'tok-6': 'agent:a@x' }), { mode: 0o600 });
  const anon = termd(['--host', '192.0.2.1', '--port', '0', '--allow-host', 'myhost', '--anonymous', 'token:anyone', '--data-dir', path.join(tmp, 'd6')]);
  assert.equal(await anon.exited, 2);
  assert.match(anon.lines.join('\n'), /refusing --anonymous on a non-loopback bind/);
  const both = termd(['--host', '192.0.2.1', '--port', '0', '--allow-host', 'myhost', '--tokens-file', f, '--anonymous', 'token:anyone', '--data-dir', path.join(tmp, 'd6b')]);
  assert.equal(await both.exited, 2, 'tokens do not make an anonymous fallback safe on the network');
  const none = termd(['--host', '192.0.2.1', '--port', '0', '--allow-host', 'myhost', '--data-dir', path.join(tmp, 'd6c')]);
  assert.equal(await none.exited, 2);
  const msg = none.lines.join('\n');
  assert.match(msg, /--tokens-file/);
  assert.doesNotMatch(msg, /--anonymous/, 'the refusal does not point at the unauthenticated option');
});

test('tsg-20: --token on the command line is warned about and taken out of the process title', async () => {
  const secret = `argv-secret-${process.pid}`;
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'd20'), '--no-usage-log', '--token', secret]);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    assert.ok(d.lines.some((l) => l.includes('--token on the command line is visible')), d.lines.join('\n'));
    const title = execFileSync('ps', ['-o', 'command=', '-p', String(d.child.pid)], { encoding: 'utf8' });
    assert.ok(!title.includes(secret), `ps shows: ${title}`);
    assert.ok(!d.lines.join('\n').includes(secret), 'the token is not logged');
  } finally {
    await stop(d);
  }
});

test('the process shows in ps as `termd`, with or without a token (core: `pgrep -f node` never selects it)', async () => {
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'd21'), '--no-usage-log']);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const title = execFileSync('ps', ['-o', 'command=', '-p', String(d.child.pid)], { encoding: 'utf8' }).trim();
    assert.match(title, /^termd( |$)/, `ps shows: ${title}`);
    assert.doesNotMatch(title, /node|daemon\.js/, `ps shows: ${title}`);
  } finally {
    await stop(d);
  }
});

test('tsg-5: when the log reader goes away (EPIPE) termd neither spins nor loses its drain: SIGTERM still exits 0', async () => {
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'd5'), '--no-usage-log', '--log-level', 'debug']);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const port = Number(new URL(urlOf(d)).port);
    d.child.stderr!.destroy(); // the reader of the pipe exits
    // Make it log: refused Hosts are warnings.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((r) => {
        const s = net.connect(port, '127.0.0.1', () => s.end(`GET /health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`));
        s.on('close', () => r());
        s.on('error', () => r());
        s.resume();
      });
    }
    await new Promise((r) => setTimeout(r, 500));
    const cpu = Number(execFileSync('ps', ['-o', '%cpu=', '-p', String(d.child.pid)], { encoding: 'utf8' }).trim());
    assert.ok(cpu < 50, `termd is spinning at ${cpu}% CPU`);
    const code = await stop(d);
    assert.equal(code, 0, 'the drain completed');
  } finally {
    if (d.child.exitCode === null) d.child.kill('SIGKILL');
  }
});

test('jr2-2/tsg-1 (G10, G20): a second termd on the same port stops before it reads the data dir; the live journal gets no recovery records', async () => {
  const port = await unusedPort();
  const dataDir = path.join(tmp, 'dup');
  const a = termd(['--port', String(port), '--data-dir', dataDir, '--no-usage-log', '--shell', '/bin/bash']);
  try {
    await until(() => listening(a) !== undefined, 10_000, 'the first termd');
    const r = await call(urlOf(a), 'run', { session: 'live1', command: 'sleep 4; echo done', wait: 300 });
    assert.equal(r.state, 'running', JSON.stringify(r));
    const journal = path.join(dataDir, 'sessions', 'live1', 'journal.jsonl');
    const before = fs.readFileSync(journal, 'utf8');
    const b = termd(['--port', String(port), '--data-dir', dataDir, '--no-usage-log']);
    assert.equal(await b.exited, 2);
    assert.match(b.lines.join('\n'), /EADDRINUSE.*the data dir was not touched/);
    const afterB = fs.readFileSync(journal, 'utf8');
    const added = afterB.slice(before.length);
    assert.doesNotMatch(added, /"recovered"|daemon-restart/, `the second daemon wrote into the live journal: ${added}`);
    // The Run ends once, with its real outcome, and seqs stay unique.
    const done = await call(urlOf(a), 'await', { runId: r.runId, wait: 10_000 });
    assert.equal(done.state, 'exited');
    const seqs = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { seq: number }).seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seqs');
  } finally {
    await stop(a);
  }
});

test('jr2-2/tsg-1: a second termd on another port that finds the data dir locked exits 1 before recovery (with src/core/lock.ts)', async (t) => {
  if (!fs.existsSync(path.resolve(here, '../src/core/lock.js'))) return t.skip('the data-dir lock (src/core/lock.ts) is not in this tree');
  const dataDir = path.join(tmp, 'locked');
  const a = termd(['--port', '0', '--data-dir', dataDir, '--no-usage-log']);
  try {
    await until(() => listening(a) !== undefined, 10_000, 'the first termd');
    // A finished run leaves the shell idle at its prompt, so the journal only changes if someone writes to it.
    await call(urlOf(a), 'run', { session: 'l1', command: 'true', wait: 10_000 });
    await sleep(300);
    const journal = path.join(dataDir, 'sessions', 'l1', 'journal.jsonl');
    const before = fs.readFileSync(journal, 'utf8');
    const b = termd(['--port', '0', '--data-dir', dataDir, '--no-usage-log']);
    assert.equal(await b.exited, 1);
    assert.match(b.lines.join('\n'), /another termd is using the data dir/);
    assert.equal(fs.readFileSync(journal, 'utf8'), before, 'the live journal is untouched');
  } finally {
    await stop(a);
  }
});

test('ux-16/tsg-3: a session opened without a cwd starts in $HOME, not wherever termd was started', async () => {
  const elsewhere = path.join(tmp, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dcwd'), '--no-usage-log', '--shell', '/bin/bash'], { cwd: elsewhere });
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const r = await call(urlOf(d), 'run', { session: 'where', command: 'pwd', wait: 10_000 });
    assert.equal(r.state, 'exited', JSON.stringify(r));
    assert.equal(((r.output as { text: string }).text ?? '').trim(), path.join(tmp, 'home'));
  } finally {
    await stop(d);
  }
});

test('--log-file: logs go to an owner-only file of termd\'s own, not stderr', async () => {
  const file = path.join(tmp, 'logs', 'sub', 'termd.log');
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dlog'), '--no-usage-log', '--log-file', file]);
  try {
    await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"listening"'), 10_000, 'the log file');
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'owner-only');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'its directory too');
    assert.equal(d.lines.length, 0, 'nothing on stderr');
  } finally {
    assert.equal(await stop(d), 0);
  }
  assert.match(fs.readFileSync(file, 'utf8'), /"stopped"/);
});

test('readiness: SIGTERM at the listening announcement drains cleanly', async () => {
  const file = path.join(tmp, 'ready.log');
  // Act as a supervisor that signals at the instant readiness becomes visible.
  // Hook the child only, rather than racing it from the parent's event loop.
  const atReady = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeSync;
    fs.writeSync = function(fd, data, ...rest) {
      const n = write.call(this, fd, data, ...rest);
      if (typeof data === 'string' && data.includes('"msg":"listening"')) process.kill(process.pid, 'SIGTERM');
      return n;
    };
    syncBuiltinESMExports();`;
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dready'), '--no-usage-log', '--log-file', file], {
    env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(atReady)}` },
  });
  try {
    await until(() => d.child.exitCode !== null || d.child.signalCode !== null, 10_000, 'shutdown after readiness');
    assert.equal(await d.exited, 0, `signal: ${d.child.signalCode}; ${d.lines.join('\n')}`);
    assert.match(fs.readFileSync(file, 'utf8'), /"stopped"/);
  } finally {
    await stop(d);
  }
});

test('an empty TSM_SESSION_OOM_SCORE_ADJ is the default (200), not 0; an empty flag value is an error like any other', async () => {
  const dataDir = path.join(tmp, 'oom-env');
  const d = termd(['--port', '0', '--data-dir', dataDir, '--no-usage-log', '--shell', '/bin/bash'], { env: { TSM_SESSION_OOM_SCORE_ADJ: '' } });
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const r = await call(urlOf(d), 'run', { session: 'oom', command: 'true', wait: 10_000 });
    assert.equal(r.state, 'exited', JSON.stringify(r));
    const find = (dir: string): string | undefined => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const f = find(p);
          if (f) return f;
        } else if (e.name === 'launch.sh') return p;
      }
      return undefined;
    };
    const launcher = find(path.join(dataDir, 'sessions', 'oom'));
    assert.ok(launcher, 'the session shell has a launcher');
    assert.match(fs.readFileSync(launcher, 'utf8'), /echo 200 > \/proc\/self\/oom_score_adj/, 'the default preference, not none');
  } finally {
    await stop(d);
  }
  const bad = termd(['--port', '0', '--data-dir', path.join(tmp, 'oom-bad'), '--no-usage-log', '--session-oom-score-adj', '']);
  assert.equal(await bad.exited, 2);
  assert.match(bad.lines.join('\n'), /--session-oom-score-adj must be an integer from 0 to 1000/);
});

test('--disk-floor-bytes takes a whole number of bytes; 0 turns the floor off; anything else is an error', async () => {
  const bad = termd(['--port', '0', '--data-dir', path.join(tmp, 'floor-bad'), '--no-usage-log', '--disk-floor-bytes', '200MB']);
  assert.equal(await bad.exited, 2);
  assert.match(bad.lines.join('\n'), /--disk-floor-bytes must be a whole number of bytes/);
  const off = termd(['--port', '0', '--data-dir', path.join(tmp, 'floor-off'), '--no-usage-log', '--shell', '/bin/bash', '--disk-floor-bytes', '0']);
  try {
    await until(() => listening(off) !== undefined, 10_000, 'termd with the floor off');
    const r = await call(urlOf(off), 'run', { session: 'nofloor', command: 'echo ok', wait: 10_000 });
    assert.equal(r.state, 'exited', JSON.stringify(r));
  } finally {
    await stop(off);
  }
});
