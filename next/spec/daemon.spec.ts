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

test('the process shows in ps as `termd` and its port, whatever its flags say (core: `pgrep -f node` never selects it, even with "node" in a path)', async () => {
  // A data dir with "node" in its path: a title that copied flag values would be selected by `pkill -f node` (the house's read of 59f660b, #22).
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'node', 'd21'), '--no-usage-log']);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const title = execFileSync('ps', ['-o', 'command=', '-p', String(d.child.pid)], { encoding: 'utf8' }).trim();
    assert.match(title, /^termd --port \d+$/, `ps shows: ${title}`);
    assert.equal(title, `termd --port ${new URL(urlOf(d)).port}`, 'the port it listens on, so two daemons can be told apart');
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
  assert.match(bad.lines.join('\n'), /--session-oom-score-adj is empty/);
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

// ───────────── the house's read of 59f660b (#22): logs, flags, startup and shutdown ─────────────

/** The exit code, or 'listening' (the daemon is then stopped): a check that must refuse never leaves a daemon running. */
async function exitOrListen(d: Daemon): Promise<number | null | 'listening' | 'never'> {
  const started = until(() => listening(d) !== undefined, 10_000, 'listening').then(() => 'listening' as const, () => 'never' as const);
  const outcome = await Promise.race([d.exited, started]);
  if (outcome === 'listening' || outcome === 'never') await stop(d);
  return outcome;
}

/** One JSON-RPC request over a fresh connection, with the query string the caller wants. */
async function rpc(url: string, method: string, params: unknown, query = ''): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`${url}/${query}`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  try {
    return await new Promise((resolve) => {
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString()) as { id?: number; result?: Record<string, unknown> };
        if (msg.id === 1) resolve(msg.result ?? {});
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
  } finally {
    ws.close(1000);
  }
}

/** Processes whose command line contains `needle`, as `ps` lists them. */
const alive = (needle: string): string[] =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(needle) && !l.includes('ps -axo'));

const parsed = (d: Daemon) => d.lines.map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string });

test('a stray EPIPE or ECONNRESET thrown by anything is logged like any exception and does not end logging; strays are bounded at 50 a minute; the drain still logs', async () => {
  // Once termd announces readiness, throw from timers: the codes a dead log reader raises, from somewhere
  // else; a rejected promise; then sixty ordinary errors, more than the bound.
  const preload = `const w = process.stderr.write.bind(process.stderr); let armed = false;
    process.stderr.write = (chunk, ...rest) => {
      if (!armed && String(chunk).includes('"msg":"listening"')) { armed = true; schedule(); }
      return w(chunk, ...rest);
    };
    function at(ms, make) { setTimeout(() => { throw make(); }, ms); }
    function schedule() {
      at(20, () => Object.assign(new Error('reset thrown from a timer'), { code: 'ECONNRESET' }));
      at(40, () => Object.assign(new Error('pipe thrown from a timer'), { code: 'EPIPE' }));
      setTimeout(() => { Promise.reject(new Error('a rejected promise')); }, 60);
      for (let i = 0; i < 60; i++) at(80 + i, () => new Error('ordinary error ' + i + ' '));
    }`;
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dstray'), '--no-usage-log'], { env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}` } });
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const logged = (text: string) => d.lines.filter((l) => l.includes(text));
    // The three codes and 'ordinary error 46' make 50: the bound.
    await until(() => logged('ordinary error 46 ').length > 0, 10_000, `the strays to be logged; got:\n${d.lines.join('\n')}`);
    await sleep(300);
    assert.equal(logged('reset thrown from a timer').length, 1, d.lines.join('\n'));
    assert.equal(logged('pipe thrown from a timer').length, 1, d.lines.join('\n'));
    assert.equal(logged('unhandled rejection (daemon keeps serving)').length, 1, d.lines.join('\n'));
    assert.equal(logged('uncaught exception (daemon keeps serving)').length, 49, 'the bound is 50 strays a minute, the rejection among them');
    assert.equal(logged('ordinary error 47 ').length, 0, 'the 51st stray is not logged');
    const r = await call(urlOf(d), 'session_list', {});
    assert.ok(Array.isArray(r.sessions), 'termd still serves');
  } finally {
    if (d.child.exitCode === null && (await stop(d)) !== 0) assert.fail(`the drain did not complete: ${d.lines.slice(-5).join('\n')}`);
  }
  assert.ok(d.lines.some((l) => l.includes('"shutting down"')) && d.lines.some((l) => l.includes('"stopped"')), `the drain is logged after the strays:\n${d.lines.slice(-5).join('\n')}`);
});

test('recovery after a SIGKILL is logged: the lock taken over, the Runs ended, the process groups ended', async () => {
  const dataDir = path.join(tmp, 'dkill');
  const tag = `4${String(process.pid % 1000).padStart(3, '0')}7`;
  const a = termd(['--port', '0', '--data-dir', dataDir, '--no-usage-log', '--shell', '/bin/bash']);
  let b: Daemon | undefined;
  try {
    await until(() => listening(a) !== undefined, 10_000, 'the first termd');
    const r = await call(urlOf(a), 'run', { session: 'k1', target: 'process', command: `sleep ${tag}`, wait: 300 });
    assert.equal(r.state, 'running', JSON.stringify(r));
    await until(() => alive(`sleep ${tag}`).length > 0, 5000, 'the process Run');
    a.child.kill('SIGKILL');
    await a.exited;
    assert.ok(alive(`sleep ${tag}`).length > 0, 'a daemon killed outright runs nothing: the process Run outlives it until the next start');
    b = termd(['--port', '0', '--data-dir', dataDir, '--no-usage-log']);
    await until(() => listening(b!) !== undefined, 15_000, 'the second termd');
    const text = b.lines.join('\n');
    assert.match(text, /took over the data dir lock/, text);
    assert.match(text, /recovery ended Runs a previous daemon left in flight/, text);
    assert.match(text, /recovery ended process groups a previous daemon left running/, text);
    assert.ok(parsed(b).some((m) => m.msg === 'recovery ended Runs a previous daemon left in flight' && m.session === 'k1' && Array.isArray(m.runs) && m.runs.includes(r.runId)), text);
    assert.deepEqual(alive(`sleep ${tag}`), [], 'recovery ended the group');
    assert.equal((JSON.parse(listening(b)!) as { recovered?: number }).recovered, 1);
  } finally {
    if (a.child.exitCode === null) a.child.kill('SIGKILL');
    if (b) await stop(b);
    for (const l of alive(`sleep ${tag}`)) {
      if (!l.trim().endsWith(`sleep ${tag}`)) continue;
      try {
        process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
});

const CAP = 16 * 1024 * 1024;
/** A log file ten bytes under termd's cap, so the first record crosses it. Sparse: it costs no space. */
function nearCap(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.truncateSync(file, CAP - 10);
}
/** The log's text after the sparse part (or all of it, once rotation has replaced the file). */
function logText(file: string): string {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  if (size < CAP - 10) return fs.readFileSync(file, 'utf8');
  const buf = Buffer.alloc(size - (CAP - 10));
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, CAP - 10);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8');
}

test('log rotation: a generation that cannot move is reported in the file, which is kept, and the generation it would have overwritten is not', async () => {
  const file = path.join(tmp, 'rot1', 'termd.log');
  nearCap(file);
  fs.writeFileSync(`${file}.1`, 'the older generation\n');
  fs.mkdirSync(`${file}.2`);
  fs.writeFileSync(path.join(`${file}.2`, 'x'), 'a directory where .1 would go');
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'drot1'), '--no-usage-log', '--log-file', file]);
  try {
    await until(() => listening(d) !== undefined || logText(file).includes('"listening"'), 10_000, 'termd to listen');
  } finally {
    assert.equal(await stop(d), 0);
  }
  const text = logText(file);
  assert.match(text, /log rotation failed/, text);
  assert.match(text, /"listening"/, 'the record that crossed the cap is in the file');
  assert.match(text, /"stopped"/, 'the file is kept: logging goes on in it');
  assert.equal(d.lines.length, 0, `nothing on stderr: ${d.lines.join('\n')}`);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'the older generation\n', 'the generation in the way was not overwritten');
});

test('log rotation in a read-only directory is said in the file, which is kept; nothing moves to stderr and no record is written twice', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory modes');
  const dir = path.join(tmp, 'rot2');
  const file = path.join(dir, 'termd.log');
  nearCap(file);
  fs.chmodSync(dir, 0o500);
  try {
    const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'drot2'), '--no-usage-log', '--log-file', file]);
    try {
      await until(() => listening(d) !== undefined || logText(file).includes('"listening"'), 10_000, 'termd to listen');
    } finally {
      assert.equal(await stop(d), 0);
    }
    const text = logText(file);
    assert.match(text, /log rotation failed/, text);
    assert.match(text, /"listening"/);
    assert.match(text, /"stopped"/);
    assert.equal(d.lines.length, 0, `nothing on stderr, so nothing twice: ${d.lines.join('\n')}`);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('an existing log file and usage log are made owner-only, and a torn last line is ended before the first new record', async () => {
  const dir = path.join(tmp, 'modes');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'termd.log');
  const usageFile = path.join(dir, 'usage.jsonl');
  const tornLog = '{"ts":"2026-10-19T00:00:00.000Z","level":"info","msg":"cut off mid-wr';
  const tornUsage = '{"ts":"2026-10-19T00:00:00.000Z","tool":"run","ok":tr';
  fs.writeFileSync(logFile, tornLog);
  fs.writeFileSync(usageFile, tornUsage);
  for (const f of [logFile, usageFile]) fs.chmodSync(f, 0o644);
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dmodes'), '--log-file', logFile, '--usage-log', usageFile]);
  try {
    await until(() => fs.readFileSync(logFile, 'utf8').includes('"listening"'), 10_000, 'the log file');
    const { url } = JSON.parse(fs.readFileSync(logFile, 'utf8').split('\n').find((l) => l.includes('"listening"'))!) as { url: string };
    await call(url, 'session_list', {});
  } finally {
    assert.equal(await stop(d), 0);
  }
  for (const [f, torn] of [
    [logFile, tornLog],
    [usageFile, tornUsage],
  ] as const) {
    assert.equal(fs.statSync(f).mode & 0o077, 0, `${f} is owner-only`);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    assert.equal(lines.at(-1), '', `${f} ends with a newline`);
    assert.equal(lines[0], torn, 'the torn line stands alone');
    const records = lines.slice(1, -1);
    assert.ok(records.length >= 1, `${f} has records after the torn line`);
    for (const l of records) assert.doesNotThrow(() => JSON.parse(l), `${f}: every record after the torn line parses: ${l}`);
  }
});

test('the log follows a session: created, Runs admitted and ended, closed with its history kept, removed once', async () => {
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dlife'), '--no-usage-log', '--shell', '/bin/bash']);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const r = await call(urlOf(d), 'run', { session: 'lc', command: 'true', wait: 10_000 });
    assert.equal(r.state, 'exited', JSON.stringify(r));
    const of = (msg: string) => parsed(d).filter((m) => m.msg === msg && m.session === 'lc');
    assert.equal(of('session created').length, 1, d.lines.join('\n'));
    assert.equal(of('run admitted').length, 1);
    assert.equal(of('run admitted')[0]!.runId, r.runId);
    await until(() => of('run ended').length === 1, 5000, 'the run end line');
    assert.equal(of('run ended')[0]!.state, 'exited');
    const closed = await call(urlOf(d), 'session_close', { session: 'lc' });
    assert.equal(closed.closed, true, JSON.stringify(closed));
    await until(() => of('session closed').length === 1, 5000, `the close line; got:\n${d.lines.join('\n')}`);
    assert.equal(of('session removed').length, 0, 'closed is not removed: the history is still listed');
    const list = await call(urlOf(d), 'session_list', {});
    assert.ok((list.sessions as Array<{ id: string; closed?: boolean }>).some((s) => s.id === 'lc' && s.closed === true), JSON.stringify(list));
    const gone = await call(urlOf(d), 'session_close', { session: 'lc', forget: true });
    assert.equal(gone.forgotten, true, JSON.stringify(gone));
    await until(() => of('session removed').length === 1, 5000, 'the removal line');
    await sleep(100);
    assert.equal(of('session removed').length, 1, 'once');
    assert.equal(of('session closed').length, 1, 'and closed is not said again');
  } finally {
    await stop(d);
  }
});

test('an empty value is not a setting: empty TSM_PORT, TSM_HOST and TSM_DATA_DIR are unset; an empty flag value is an error', async () => {
  const port = await unusedPort();
  // No --data-dir: the empty TSM_DATA_DIR must give the default under $HOME, not the working directory.
  const d = termd(['--no-usage-log', '--anonymous', 'token:dev'], { env: { TSM_PORT: '', TSM_HOST: '', TSM_DATA_DIR: '', SESSION_SERVER_PORT: String(port) } });
  try {
    const started = until(() => listening(d) !== undefined, 10_000, 'listening').then(() => 'listening' as const, () => 'never' as const);
    assert.equal(await Promise.race([d.exited, started]), 'listening', d.lines.join('\n'));
    const l = JSON.parse(listening(d)!) as { url: string; dataDir: string; auth: string };
    assert.equal(l.url, `ws://127.0.0.1:${port}`, 'an empty TSM_PORT is unset, so the 1.x name counts; an empty TSM_HOST is the loopback default');
    assert.equal(l.dataDir, path.join(tmp, 'home', '.tsm'), 'an empty TSM_DATA_DIR is the default, not the working directory');
    assert.equal(l.auth, 'anonymous', 'the loopback default is not a network bind, so --anonymous is allowed');
  } finally {
    await stop(d);
  }
  const dd = path.join(tmp, 'dempty');
  for (const argv of [
    ['--port', '', '--data-dir', dd],
    ['--host', '', '--port', '0', '--data-dir', dd],
    ['--port', '0', '--data-dir', ''],
    ['--port', '0', '--data-dir', dd, '--token', ''],
    ['--port', '0', '--data-dir', dd, '--allow-host', ''],
  ]) {
    const bad = termd([...argv, '--no-usage-log']);
    assert.equal(await exitOrListen(bad), 2, `${argv.join(' ')}: ${bad.lines.join('\n')}`);
    assert.match(bad.lines.join('\n'), /--[a-z-]+ is empty/, argv.join(' '));
  }
});

test('bad values are refused: --log-level (an inherited name too), --retention-days, --retention-bytes, --allow-host, --port, and TSM_PORT', async () => {
  const dd = path.join(tmp, 'dchecks');
  const cases: Array<[string[], RegExp]> = [
    [['--log-level', 'toString'], /--log-level must be one of debug, info, warn, error/],
    [['--log-level', 'loud'], /--log-level must be one of/],
    [['--retention-days', '0'], /--retention-days must be a positive number/],
    [['--retention-days', 'soon'], /--retention-days must be a positive number/],
    [['--retention-bytes', '100'], /--retention-bytes must be a number of bytes, at least 16384/],
    [['--retention-bytes', 'lots'], /--retention-bytes must be a number of bytes/],
    [['--allow-host', 'not a host!'], /--allow-host .* is not a host name/],
    [['--port', '70000'], /--port must be an integer from 0 to 65535/],
    [['--port', '12abc'], /--port must be an integer from 0 to 65535/],
  ];
  for (const [argv, re] of cases) {
    const d = termd([...(argv[0] === '--port' ? [] : ['--port', '0']), ...argv, '--data-dir', dd, '--no-usage-log']);
    assert.equal(await exitOrListen(d), 2, `${argv.join(' ')}: ${d.lines.join('\n')}`);
    assert.match(d.lines.join('\n'), re, argv.join(' '));
  }
  const env = termd(['--data-dir', dd, '--no-usage-log'], { env: { TSM_PORT: 'abc' } });
  assert.equal(await exitOrListen(env), 2, env.lines.join('\n'));
  assert.match(env.lines.join('\n'), /--port must be an integer from 0 to 65535/);
});

function ipv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::1', () => s.close(() => resolve(true)));
  });
}

test("--host '[::1]' is the IPv6 loopback in a URL's spelling: it binds ::1", async (t) => {
  if (!(await ipv6Loopback())) return t.skip('no IPv6 loopback here');
  const d = termd(['--host', '[::1]', '--port', '0', '--data-dir', path.join(tmp, 'd6l'), '--no-usage-log']);
  try {
    const started = until(() => listening(d) !== undefined, 10_000, 'listening').then(() => 'listening' as const, () => 'never' as const);
    assert.equal(await Promise.race([d.exited, started]), 'listening', d.lines.join('\n'));
    assert.match(urlOf(d), /^ws:\/\/\[::1\]:\d+$/);
  } finally {
    await stop(d);
  }
});

test('usage log: --no-usage-log records nothing and names no file; the default is <data-dir>/usage.jsonl; a path that cannot be opened is a warning, not a failure', async () => {
  const dd1 = path.join(tmp, 'dusage-off');
  const off = termd(['--port', '0', '--data-dir', dd1, '--no-usage-log']);
  try {
    await until(() => listening(off) !== undefined, 10_000, 'termd to listen');
    assert.equal((JSON.parse(listening(off)!) as { usageLog?: string }).usageLog, undefined);
    await call(urlOf(off), 'session_list', {});
  } finally {
    await stop(off);
  }
  assert.ok(!fs.existsSync(path.join(dd1, 'usage.jsonl')), 'nothing recorded');
  const dd2 = path.join(tmp, 'dusage-on');
  const on = termd(['--port', '0', '--data-dir', dd2]);
  try {
    await until(() => listening(on) !== undefined, 10_000, 'termd to listen');
    assert.equal((JSON.parse(listening(on)!) as { usageLog?: string }).usageLog, path.join(dd2, 'usage.jsonl'));
    await call(urlOf(on), 'session_list', {});
  } finally {
    await stop(on);
  }
  const recs = fs.readFileSync(path.join(dd2, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string });
  assert.deepEqual(recs.map((r) => r.tool), ['session_list']);
  const where = path.join(tmp, 'dusage-dir');
  fs.mkdirSync(where, { recursive: true });
  const bad = termd(['--port', '0', '--data-dir', path.join(tmp, 'dusage-bad'), '--usage-log', where]);
  try {
    await until(() => listening(bad) !== undefined, 10_000, 'termd to listen');
    assert.ok(bad.lines.some((l) => l.includes('usage log unavailable')), bad.lines.join('\n'));
    assert.equal((JSON.parse(listening(bad)!) as { usageLog?: string }).usageLog, undefined);
  } finally {
    await stop(bad);
  }
});

test('--retention-days and --retention-bytes reach new sessions, and days are days', async () => {
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'dret'), '--no-usage-log', '--shell', '/bin/bash', '--retention-days', '2', '--retention-bytes', '65536']);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    await call(urlOf(d), 'session_open', { session: 'ret' });
    const list = await call(urlOf(d), 'session_list', {});
    const s = (list.sessions as Array<{ id: string; retention?: Record<string, unknown> }>).find((x) => x.id === 'ret');
    assert.deepEqual(s?.retention, { maxBytes: 65536, maxAgeMs: 2 * 24 * 3600 * 1000 }, JSON.stringify(list));
  } finally {
    await stop(d);
  }
});

test('a plain connection gets the core profile and JSON result text unless it asks otherwise', async () => {
  const d = termd(['--port', '0', '--data-dir', path.join(tmp, 'ddefaults'), '--no-usage-log', '--shell', '/bin/bash']);
  try {
    await until(() => listening(d) !== undefined, 10_000, 'termd to listen');
    const names = ((await rpc(urlOf(d), 'tools/list', {})).tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.includes('run') && names.includes('session_list'), names.join(' '));
    assert.ok(!names.includes('wait_for') && !names.includes('search') && !names.includes('signal'), `core only: ${names.join(' ')}`);
    const full = ((await rpc(urlOf(d), 'tools/list', {}, '?profile=full')).tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(full.includes('wait_for') && full.includes('search'), full.join(' '));
    const json = (await rpc(urlOf(d), 'tools/call', { name: 'session_list', arguments: {} })) as { content: Array<{ text: string }>; structuredContent: unknown };
    assert.deepEqual(JSON.parse(json.content[0]!.text), json.structuredContent, 'the text is the structured result as JSON');
    const transcript = (await rpc(urlOf(d), 'tools/call', { name: 'session_list', arguments: {} }, '?resultText=transcript')) as { content: Array<{ text: string }> };
    assert.equal(transcript.content[0]!.text, '(no sessions)');
  } finally {
    await stop(d);
  }
});
