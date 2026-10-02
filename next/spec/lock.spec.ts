/**
 * One daemon per data dir (jr2-2, tsg-1; G10, G20): `<dataDir>/termd.lock` is
 * taken before recovery writes anything. A live holder — another process,
 * checked by pid and start time against pid reuse — makes a second registry
 * (and a second termd, on any port) refuse with `data_dir_locked` before it
 * touches a journal; a dead holder's lock is taken over, exactly once when
 * several processes race for it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import { acquireDataDirLock, LOCK_FILE } from '../src/core/lock.js';
import { FileStore } from '../src/core/stores.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_JS = new URL('../src/core/lock.js', import.meta.url).href;
const REGISTRY_JS = new URL('../src/api/registry.js', import.meta.url).href;
const PTY_JS = new URL('../src/backends/node-pty.js', import.meta.url).href;
const DAEMON = path.resolve(here, '../src/daemon.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lock-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;
const dataDir = () => path.join(tmp, `d${++dirs}`);
const code = (e: unknown) => (e instanceof TermError ? e.code : String(e));

/** A node child running `src`; resolves each stdout line to `lines`. */
function child(src: string): { proc: ChildProcess; lines: string[]; line: (re: RegExp, ms?: number) => Promise<string>; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let buf = '';
  let err = '';
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
  const line = async (re: RegExp, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return hit;
      if (Date.now() > end || proc.exitCode !== null) throw new Error(`no line ${re} (exit ${proc.exitCode}): ${lines.join('\n')}\n${err}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { proc, lines, line, exited };
}

const readLock = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')) as { pid: number; startedAt: number; hostname: string };

test('jr2-2/tsg-1/G10: a registry refuses a data dir another live process holds, before it writes a byte', async () => {
  const dir = dataDir();
  // A journal with a Run in flight: recovery would end it `lost` and mark the restart.
  const sdir = path.join(dir, 'sessions', 'w');
  const j = new Journal({ cold: new FileStore(sdir), sessionId: 'w' });
  j.append({ type: 'run.admit', runId: 'r1-live00', target: 'shell', line: 'sleep 20', principal: 'agent:a@test', origin: 'self', queued: false });
  j.append({ type: 'run.start', runId: 'r1-live00', cwd: '/' });
  j.close();
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private' }), { mode: 0o600 });
  const holder = child(`
    import { acquireDataDirLock } from ${JSON.stringify(LOCK_JS)};
    acquireDataDirLock(${JSON.stringify(dir)});
    console.log('held');
    setInterval(() => {}, 1000);
  `);
  try {
    await holder.line(/^held$/);
    const before = fs.readFileSync(path.join(sdir, 'journal.jsonl'), 'utf8');
    let thrown: unknown;
    try {
      new SessionRegistry({ dataDir: dir, backend: new ScriptedBackend() });
    } catch (e) {
      thrown = e;
    }
    assert.equal(code(thrown), 'data_dir_locked');
    assert.match((thrown as Error).message, new RegExp(`pid ${holder.proc.pid}`));
    assert.match((thrown as Error).message, /termd\.lock/);
    assert.equal(fs.readFileSync(path.join(sdir, 'journal.jsonl'), 'utf8'), before, 'the journal is untouched');
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => code(e) === 'data_dir_locked');
    // Tests only: an explicit opt-out.
    const unlocked = new SessionRegistry({ dataDir: path.join(tmp, 'elsewhere'), backend: new ScriptedBackend(), lock: false });
    assert.equal(fs.existsSync(path.join(tmp, 'elsewhere', LOCK_FILE)), false);
    await unlocked.closeAll();
    // The holder dies without releasing (SIGKILL): its lock is stale and taken over.
    holder.proc.kill('SIGKILL');
    await holder.exited;
    const reg = new SessionRegistry({ dataDir: dir, backend: new ScriptedBackend() });
    assert.equal(readLock(dir).pid, process.pid);
    const h = reg.get('w');
    assert.ok(h && h.kind === 'history' && h.run('r1-live00').state === 'lost');
    await reg.closeAll();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false, 'released at closeAll');
  } finally {
    holder.proc.kill('SIGKILL');
  }
});

test('jr2-2: a lock naming a live pid that started after the lock was written is stale (pid reuse); a hostname does not decide', async () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() - 3_600_000, hostname: os.hostname() }));
    const lock = acquireDataDirLock(dir);
    assert.equal(readLock(dir).pid, process.pid, 'taken over: that pid is a newer process');
    lock.release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
    // The hostname is reported, not trusted: a laptop's changes with its network. A live, old-enough pid decides.
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now(), hostname: 'renamed-host' }));
    assert.throws(() => acquireDataDirLock(dir), (e: Error) => code(e) === 'data_dir_locked' && new RegExp(`pid ${sleeper.pid}.*renamed-host`).test(e.message));
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 999_999, startedAt: Date.now(), hostname: 'renamed-host' }));
    acquireDataDirLock(dir).release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  } finally {
    sleeper.kill('SIGKILL');
  }
});

test('jr2-2: within one process the lock is shared, and released by its taker; an old handle never releases a newer take', () => {
  const dir = dataDir();
  const a = acquireDataDirLock(dir);
  const b = acquireDataDirLock(dir); // another registry in this process (a test standing in for a restart)
  b.release();
  assert.ok(fs.existsSync(path.join(dir, LOCK_FILE)), 'still held by a');
  a.release();
  a.release(); // idempotent
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  const c = acquireDataDirLock(dir);
  fs.rmSync(path.join(dir, LOCK_FILE)); // lost under it (a cleaner)
  const d = acquireDataDirLock(dir); // taken afresh
  c.release();
  assert.ok(fs.existsSync(path.join(dir, LOCK_FILE)), 'c does not release d');
  d.release();
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
});

test('jr2-2: a holder that exits without releasing leaves no lock behind; racing processes take a free or stale lock exactly once', async () => {
  const dir = dataDir();
  const quitter = child(`
    import { acquireDataDirLock } from ${JSON.stringify(LOCK_JS)};
    acquireDataDirLock(${JSON.stringify(dir)});
    console.log('held');
    process.exit(0);
  `);
  await quitter.exited;
  assert.deepEqual(quitter.lines, ['held']);
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  for (const stale of [false, true]) {
    const race = dataDir();
    fs.mkdirSync(race, { recursive: true });
    if (stale) fs.writeFileSync(path.join(race, LOCK_FILE), JSON.stringify({ pid: 999_999, startedAt: Date.now() - 60_000, hostname: os.hostname() }));
    const racers = Array.from({ length: 6 }, () =>
      child(`
        import { acquireDataDirLock } from ${JSON.stringify(LOCK_JS)};
        const go = ${Date.now() + 400};
        while (Date.now() < go) {}
        try { acquireDataDirLock(${JSON.stringify(race)}); console.log('won'); setTimeout(() => process.exit(0), 1500); }
        catch (e) { console.log(e.code === 'data_dir_locked' ? 'refused' : 'error ' + e.message); process.exit(0); }
      `),
    );
    await Promise.all(racers.map((r) => r.exited));
    const outcomes = racers.map((r) => r.lines[0]);
    assert.equal(outcomes.filter((o) => o === 'won').length, 1, `${stale ? 'stale' : 'free'}: ${outcomes.join(', ')}`);
    assert.equal(outcomes.filter((o) => o === 'refused').length, 5, outcomes.join(', '));
  }
});

test('jr2-2/tsg-1/G10/G20: a second termd on the same data dir — same port or another — exits before touching a live session\'s journal', { timeout: 60_000 }, async () => {
  const dir = dataDir();
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, TSM_TOKEN: '' };
  const daemon = (port: number) => {
    const p = spawn(process.execPath, [DAEMON, '--port', String(port), '--data-dir', dir, '--shell', '/bin/bash', '--no-usage-log'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    p.stderr!.on('data', (d: Buffer) => (log += d.toString()));
    return { p, log: () => log, exited: new Promise<number | null>((r) => p.on('exit', (c) => r(c))) };
  };
  // The live daemon, with a session and a shell Run in flight (a registry of its own in a child, as termd holds one).
  const live = child(`
    import { SessionRegistry } from ${JSON.stringify(REGISTRY_JS)};
    import { NodePtyBackend } from ${JSON.stringify(PTY_JS)};
    const reg = new SessionRegistry({ dataDir: ${JSON.stringify(dir)}, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    const { session } = await reg.ensure({ id: 'w', owner: 'agent:a@test' });
    session.attach('agent:a@test', 'c');
    const a = await session.admitWhenAvailable({ target: 'shell', line: 'sleep 3.25; echo done', principal: 'agent:a@test' });
    for (let i = 0; i < 100 && session.run(a.run.runId).state !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    console.log('running ' + a.run.runId);
    const end = await session.awaitRun(a.run.runId, 10000);
    console.log('ended ' + end.state + ' ' + end.exit);
    await reg.closeAll();
    process.exit(0);
  `);
  try {
    const runId = (await live.line(/^running /)).split(' ')[1]!;
    const journal = path.join(dir, 'sessions', 'w', 'journal.jsonl');
    const before = fs.readFileSync(journal, 'utf8');
    for (const port of [3265, 3266]) {
      const d = daemon(port);
      assert.equal(await d.exited, 1, d.log());
      assert.match(d.log(), /data_dir_locked|in use by termd pid/, d.log());
      assert.doesNotMatch(d.log(), /"listening"/);
    }
    assert.equal(fs.readFileSync(journal, 'utf8').startsWith(before), true, 'nothing was inserted into the live journal');
    await live.line(/^ended /);
    await live.exited; // after its closeAll: nothing of the session is left in /tmp
    const events = fs
      .readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { seq: number; type: string; runId?: string; state?: string });
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'seqs unique and increasing');
    const ends = events.filter((e) => e.type === 'run.end' && e.runId === runId);
    assert.deepEqual(ends.map((e) => e.state), ['exited'], 'the Run ended once, as observed');
    assert.equal(events.filter((e) => e.type === 'recovered').length, 0, 'no false restart marker');
  } finally {
    live.proc.kill('SIGKILL');
  }
});
