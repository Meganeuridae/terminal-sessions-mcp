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
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import { acquireDataDirLock, bootId, listProcesses, LOCK_FILE, parseProcStat, PROC_START_SLACK_MS, procStart, readProcStat, type ProcessSource } from '../src/core/lock.js';

/**
 * The builtin modules as lock.js sees them: patching a function here and calling syncBuiltinESMExports
 * reaches the module's own `import * as fs` bindings, which the test runner's mocks cannot. Every patch
 * is restored in a finally.
 */
const fsc = createRequire(import.meta.url)('node:fs') as { fsyncSync: typeof fs.fsyncSync; fstatSync: typeof fs.fstatSync; mkdirSync: typeof fs.mkdirSync; openSync: typeof fs.openSync; readFileSync: typeof fs.readFileSync; writeFileSync: typeof fs.writeFileSync };
const cpc = createRequire(import.meta.url)('node:child_process') as { execFileSync: (file: string, args?: readonly string[], ...rest: unknown[]) => unknown };
const eio = () => Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
/** A directory fsync that fails with EIO while `fn` runs (file fsyncs still work). */
function withDirFsyncEIO<T>(fn: () => T): T {
  const real = fsc.fsyncSync;
  fsc.fsyncSync = ((fd: number) => {
    if (fsc.fstatSync(fd).isDirectory()) throw eio();
    return real(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsc.fsyncSync = real;
    syncBuiltinESMExports();
  }
}
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

/** A node child running `src`; resolves each stdout line to `lines`. With `stdin`, the child can be written to. */
function child(src: string, opts: { stdin?: boolean } = {}): { proc: ChildProcess; lines: string[]; line: (re: RegExp, ms?: number) => Promise<string>; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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
    // A start barrier, not a wall-clock instant (the house's read of 59f660b, #22): every racer says it is
    // ready, then waits for the word, so they take the lock together however slowly the machine starts them.
    const racers = Array.from({ length: 6 }, () =>
      child(
        `
        import { acquireDataDirLock } from ${JSON.stringify(LOCK_JS)};
        process.stdin.once('data', () => {
          // The winner holds until told: a fixed hold let a slow racer find the lock free and win too (the house's read of the 38 commits, #22).
          try { acquireDataDirLock(${JSON.stringify(race)}); console.log('won'); process.stdin.once('data', () => process.exit(0)); }
          catch (e) { console.log(e.code === 'data_dir_locked' ? 'refused' : 'error ' + e.message); process.exit(0); }
        });
        console.log('ready');
      `,
        { stdin: true },
      ),
    );
    await Promise.all(racers.map((r) => r.line(/^ready$/)));
    for (const r of racers) r.proc.stdin!.write('go\n');
    // Every racer's outcome first; only then is the winner released.
    await Promise.all(racers.map((r) => r.line(/^(won|refused|error)/)));
    for (const r of racers) if (r.lines.includes('won')) r.proc.stdin!.write('release\n');
    await Promise.all(racers.map((r) => r.exited));
    const outcomes = racers.map((r) => r.lines.find((l) => l !== 'ready'));
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

test('jr2-2: a wall-clock step back does not take the lock from a live daemon (the house\'s read of the 36 commits, #22)', async () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  // A live holder whose command names termd: on Linux its boot id and start ticks identify it
  // frame-free, and off Linux the fallback never reads a running termd as stale.
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { acquireDataDirLock } from ${JSON.stringify(LOCK_JS)}; acquireDataDirLock(${JSON.stringify(dir)}); console.log('held'); setInterval(() => {}, 1000);`,
      'termd',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      holder.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('held')) resolve();
      });
      holder.once('exit', () => reject(new Error('holder exited before holding the lock')));
      setTimeout(() => reject(new Error('holder timed out')), 15_000).unref();
    });
    const lockFile = path.join(dir, LOCK_FILE);
    const h = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; startedAt: number };
    assert.equal(h.pid, holder.pid);
    // The wall clock steps forward 3 s after the daemon took its lock (an NTP correction), so its
    // recorded startedAt now sits 3 s in the past. The daemon is alive; its lock must not be taken over.
    fs.writeFileSync(lockFile, JSON.stringify({ ...h, startedAt: h.startedAt - 3000 }) + '\n');
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => code(e) === 'data_dir_locked');
    assert.equal((JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number }).pid, holder.pid, 'the live holder still holds it');
  } finally {
    holder.kill('SIGKILL');
  }
});

/** A /proc/<pid>/stat line after its comm, as the kernel writes it: state S, pgrp 1234, tpgid 4321, start ticks 98765. */
const STAT_TAIL = 'S 1 1234 1234 0 4321 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 12345678 500 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0';

test('the one /proc stat parser counts fields after the last ")" (a comm with spaces and parentheses): state, process group, foreground group and start ticks (the house\'s read of the 36 commits, PR #22, comment 6269992150, item 4; a reviewer\'s read of the fixes for #22)', () => {
  // Field 22 (starttime) sits at index 19 after the comm; a comm like "my (odd) comm" must not shift it.
  const fields = { state: 'S', pgrp: 1234, tpgid: 4321, startTicks: 98765 };
  assert.deepEqual(parseProcStat(`1234 (my (odd) comm) ${STAT_TAIL}`), fields);
  assert.deepEqual(parseProcStat(`1234 (node) ${STAT_TAIL}\n`), fields);
  assert.deepEqual(parseProcStat(`1 (init) ${STAT_TAIL.replace(' 4321 ', ' -1 ')}`), { ...fields, tpgid: -1 }, 'no terminal: tpgid -1');
  assert.equal(parseProcStat('garbage'), undefined);
  assert.equal(parseProcStat('1234 (x) S 1'), undefined, 'too few fields');
  // readProcStat reads /proc/<pid>/stat through the parser: what the lock, procStart, the listing and the backend's foreground and reader checks call.
  const files: Record<string, string> = { '/proc/1234/stat': `1234 (a) b) ${STAT_TAIL}` };
  assert.deepEqual(readProcStat(1234, (f) => files[f]), fields);
  assert.equal(readProcStat(77, (f) => files[f]), undefined, 'gone');
  assert.equal(readProcStat(0, () => assert.fail('no read for pid 0')), undefined);
});

test('Linux: procStart reads a live pid frame-free through the same parser, and the boot id once (the house\'s read of the 36 commits, PR #22, comment 6269992150, item 4)', { skip: process.platform !== 'linux' ? `/proc is Linux's: skipped on ${process.platform}` : false }, () => {
  const self = procStart(process.pid);
  assert.ok(self, 'our own start reads');
  assert.equal(self.startTicks, parseProcStat(fs.readFileSync('/proc/self/stat', 'utf8'))?.startTicks, 'the same parser, the same unit');
  assert.equal(self.zombie, false);
  assert.equal(self.bootId, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  assert.equal(bootId(), self.bootId, 'read once, cached');
  assert.equal(procStart(2_147_483_000), undefined, 'a pid that is not there');
});

test('off Linux there is no frame-free start: procStart and the boot id answer nothing', { skip: process.platform === 'linux' ? 'Linux has them' : false }, () => {
  assert.equal(procStart(process.pid), undefined);
  assert.equal(bootId(), undefined);
});

test('a filesystem without hard links: a link() refused with EPERM falls back to the exclusive write of the synced content, and the handle says so (a reviewer\'s read of the fixes for #22 comment 6269992150)', () => {
  const dir = dataDir();
  const noLinks = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
  };
  const lock = acquireDataDirLock(dir, { link: noLinks });
  try {
    assert.equal(lock.noHardLinks, true, 'the registry logs this once');
    assert.equal(readLock(dir).pid, process.pid, 'taken through the exclusive write');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp left behind');
    // The lock is a lock: another take in this process shares it, and a stale one is still taken over by rename.
    assert.equal(acquireDataDirLock(dir, { link: noLinks }).file, lock.file);
  } finally {
    lock.release();
  }
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 999_999, startedAt: Date.now() - 60_000, hostname: os.hostname() }));
  const over = acquireDataDirLock(dir, { link: noLinks });
  assert.equal(over.tookOver?.pid, 999_999, 'a stale lock is taken over without link()');
  assert.equal(readLock(dir).pid, process.pid);
  over.release();
});

// ───────────── the house's read of the 38 commits (PR #22, comment 6274603516): two holders ─────────────

test('a lock naming this pid that this process did not write is a predecessor\'s, taken over — "self" means the content this process wrote (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 1)', () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  // A predecessor on the same pid, from another boot, stamped by a clock that then read later than ours does now.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() + 60_000, hostname: os.hostname(), nonce: 'predecessor', bootId: 'an-earlier-boot', startTicks: 1 }) + '\n');
  const lock = acquireDataDirLock(dir);
  try {
    assert.equal(lock.tookOver?.nonce, 'predecessor', 'taken over, not taken as our own');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('predecessor'), 'the file holds our record now');
    assert.equal(readLock(dir).pid, process.pid);
    assert.equal(acquireDataDirLock(dir).file, file, 'what we wrote is "self" for another take in this process');
  } finally {
    lock.release();
  }
  assert.equal(fs.existsSync(file), false, 'ours to release');
});

test('the no-hard-links fallback takes the lock only if termd.lock still holds its own record after the write — a taker that read it empty wins alone (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 2)', () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const noLinks = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
  };
  // While this start's exclusive write is in flight (between its write and its fsync), another starter
  // read the file empty, judged it old, and took it over: it names a live stranger (our parent) now.
  const stranger = JSON.stringify({ pid: process.ppid, startedAt: Date.now(), hostname: os.hostname(), nonce: 'taker' }) + '\n';
  const realOpen = fsc.openSync;
  const realFsync = fsc.fsyncSync;
  const lockFds = new Set<number>();
  fsc.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest);
    if (String(p) === file) lockFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fsc.fsyncSync = ((fd: number) => {
    if (lockFds.delete(fd)) fsc.writeFileSync(file, stranger);
    return realFsync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireDataDirLock(dir, { link: noLinks }), (e: unknown) => code(e) === 'data_dir_locked', 'the file is the taker\'s: refused, not a second holder');
    assert.equal(readLock(dir).pid, process.ppid, 'the taker still holds it');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp left behind');
  } finally {
    fsc.openSync = realOpen;
    fsc.fsyncSync = realFsync;
    syncBuiltinESMExports();
  }
});

test('an EEXIST from a link that took effect (NFS) is this attempt\'s take when termd.lock holds its record: registered and released, not left behind (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 4)', () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const nfsLink = (a: string, b: string) => {
    fs.linkSync(a, b);
    throw Object.assign(new Error('EEXIST: file already exists, link'), { code: 'EEXIST' });
  };
  const lock = acquireDataDirLock(dir, { link: nfsLink });
  assert.equal(lock.tookOver, undefined, 'a fresh take');
  assert.equal(readLock(dir).pid, process.pid);
  lock.release();
  assert.equal(fs.existsSync(file), false, 'released, so a clean exit leaves no lock naming a dead pid');
});

test('a zombie\'s stat reads state Z after any comm, which the lock and the listing count as gone (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 5)', () => {
  assert.equal(parseProcStat(`1234 (node) ${STAT_TAIL}`)?.state, 'S');
  assert.equal(parseProcStat(`1234 (my (odd) comm) ${STAT_TAIL.replace(/^S/, 'Z')}`)?.state, 'Z');
});

test('Linux: a zombie holder is gone — its stat still has the start ticks and kill(pid, 0) succeeds, but state Z is exited (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 5)', { skip: process.platform !== 'linux' ? `a real zombie needs /proc: skipped on ${process.platform}` : false }, async () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const holder = path.join(dir, 'holder.mjs');
  fs.writeFileSync(holder, `const { acquireDataDirLock } = await import(${JSON.stringify(LOCK_JS)}); acquireDataDirLock(${JSON.stringify(dir)}); process.kill(process.pid, 'SIGKILL');\n`);
  // sh starts the holder, then becomes `sleep`, which never waits for it: killed, it stays a zombie.
  const parent = spawn('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(holder)} & exec sleep 20`], { stdio: 'ignore' });
  try {
    // Wait for the state asserted, with a deadline: after its link the holder still removes its temp,
    // registers the take and syncs the directory before its SIGKILL, which a loaded runner can stretch
    // past any fixed wait (the house's read of the 33 commits, PR #22, comment 6307349700, item 8).
    let pid: number | undefined;
    let state: string | undefined;
    for (const end = Date.now() + 15_000; state !== 'Z' && Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
      try {
        pid = readLock(dir).pid;
        state = readProcStat(pid)?.state;
      } catch {
        // not linked yet
      }
    }
    assert.equal(state, 'Z', 'the holder is a zombie');
    const lock = acquireDataDirLock(dir);
    assert.equal(lock.tookOver?.pid, pid!, 'taken over: a zombie holds nothing');
    lock.release();
  } finally {
    parent.kill('SIGKILL');
  }
});

test('a liveness check that cannot answer keeps the holder — an unknown is not stale (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 6)', async () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  // A live holder (not termd) whose lock the wall clock reads as a pid reuse (its startedAt is long past):
  // only its command line could keep it, and that check is made to fail.
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  const realExec = cpc.execFileSync;
  const realRead = fsc.readFileSync;
  cpc.execFileSync = (file, args, ...rest) => {
    if (args?.includes('command=')) throw Object.assign(new Error('ETIMEDOUT: ps timed out'), { code: 'ETIMEDOUT' });
    return realExec(file, args, ...rest);
  };
  fsc.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(p).endsWith('/cmdline')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return (realRead as (...a: unknown[]) => ReturnType<typeof fs.readFileSync>)(p, ...rest);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() - 3_600_000, hostname: os.hostname() }));
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => code(e) === 'data_dir_locked', 'unknown keeps the holder');
    assert.equal(readLock(dir).pid, sleeper.pid);
  } finally {
    cpc.execFileSync = realExec;
    fsc.readFileSync = realRead;
    syncBuiltinESMExports();
    sleeper.kill('SIGKILL');
  }
});

test('Linux: only the frame-free branch decides — a live holder whose lock\'s start ticks or boot id differ from its own is a reused pid, taken over (the house\'s read of the 38 commits, PR #22, comment 6274603516)', { skip: process.platform !== 'linux' ? `start ticks and the boot id are Linux's: skipped on ${process.platform}` : false }, async () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  // A live holder with nothing in its command line to keep it off the frame-free branch's verdict.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireDataDirLock } from ${JSON.stringify(LOCK_JS)}; acquireDataDirLock(${JSON.stringify(dir)}); console.log('held'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      holder.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('held')) resolve();
      });
      holder.once('exit', () => reject(new Error('holder exited before holding the lock')));
      setTimeout(() => reject(new Error('holder timed out')), 15_000).unref();
    });
    const lockFile = path.join(dir, LOCK_FILE);
    const h = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; startTicks: number; bootId: string };
    assert.equal(typeof h.startTicks, 'number');
    for (const variant of [{ startTicks: h.startTicks + 1 }, { bootId: 'another-boot' }]) {
      fs.writeFileSync(lockFile, JSON.stringify({ ...h, ...variant }) + '\n');
      // The wall clock alone would keep it (the process started before the lock was written); the ticks or
      // the boot id say the pid was reused, and that decides.
      const lock = acquireDataDirLock(dir);
      assert.equal(lock.tookOver?.pid, holder.pid, `taken over on ${JSON.stringify(variant)}`);
      lock.release();
    }
  } finally {
    holder.kill('SIGKILL');
  }
});

test('the lock is written whole and fsynced before it is published: a link that reads the temp at publication finds the full record already synced (the house\'s read of the 38 commits, #22)', () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const synced = new Set<number>();
  const realFsync = fsc.fsyncSync;
  fsc.fsyncSync = ((fd: number) => {
    synced.add(fsc.fstatSync(fd).ino);
    return realFsync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    let checked = false;
    const link = (tmp: string, file: string) => {
      const h = JSON.parse(fs.readFileSync(tmp, 'utf8')) as { pid: number; nonce: string; startedAt: number };
      assert.deepEqual([h.pid, typeof h.nonce, typeof h.startedAt], [process.pid, 'string', 'number'], 'the whole record is there before it is published');
      assert.ok(synced.has(fs.statSync(tmp).ino), 'and it was fsynced first');
      checked = true;
      fs.linkSync(tmp, file);
    };
    const lock = acquireDataDirLock(dir, { link });
    assert.equal(checked, true);
    lock.release();
  } finally {
    fsc.fsyncSync = realFsync;
    syncBuiltinESMExports();
  }
});

test('a directory fsync failing with EIO after the lock is published is reported on the handle and logged once by the registry; the lock is held (the house\'s read of the 38 commits, PR #22, comment 6274603516, items 7 and 8)', async () => {
  const dir = dataDir();
  const lock = withDirFsyncEIO(() => acquireDataDirLock(dir));
  assert.equal(lock.unsynced, true, 'held, and the directory sync failure is reported');
  assert.equal(readLock(dir).pid, process.pid);
  lock.release();
  const warnings: string[] = [];
  const reg = withDirFsyncEIO(() => new SessionRegistry({ dataDir: path.join(dir, 'reg'), backend: new ScriptedBackend(), log: (level, text) => void (level === 'warn' && warnings.push(text)) }));
  assert.equal(warnings.filter((w) => /lock is taken but its directory could not be synced/.test(w)).length, 1, JSON.stringify(warnings));
  await reg.closeAll();
});

test('the process listing takes /proc first on Linux — rows with start ticks, the boot id and a start placed to the tick — and ps only when /proc does not answer, or off Linux (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 1)', () => {
  // With ps first, as before, a Linux host's rows carried neither ticks nor the boot id, so recovery's
  // frame-free checks and its boot guard never ran there. The Linux branch is driven through an injected
  // source, so this runs on every host; the machine's own /proc is the next test's, on Linux.
  const stat = (pid: number, pgid: number, ticks: number, state = 'S') => `${pid} (sleep (x) y) ${state} 1 ${pgid} ${pgid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 12345678 500`;
  const now = 1_700_000_000_000;
  const files: Record<string, string> = {
    '/proc/uptime': '1000.50 2000.00\n',
    '/proc/stat': 'cpu  1 2 3 4\nbtime 1699998999\n',
    '/proc/77/stat': stat(77, 77, 5000),
    '/proc/78/stat': stat(78, 77, 5012, 'Z'),
  };
  const psText = `   77    77 Ss   ${new Date(now - 950_000).toString().slice(0, 24)}\n   88    88 S    ${new Date(now).toString().slice(0, 24)}\n`;
  const source = (over: Partial<ProcessSource> = {}): ProcessSource => ({ platform: 'linux', read: (f) => files[f], entries: () => ['77', '78', 'self', 'net'], ps: () => psText, now: () => now, bootId: () => 'boot-A', self: 77, ...over });
  const shape = (rows: ReturnType<typeof listProcesses>) => rows?.map((r) => [r.pid, r.pgid, r.startTicks, r.bootId, r.zombie]);
  const rows = listProcesses(source())!;
  assert.deepEqual(shape(rows), [[77, 77, 5000, 'boot-A', false], [78, 77, 5012, 'boot-A', true]], '/proc\'s rows, though ps answered too');
  // Placed against the uptime: boot was 1000.50 s before now; tick 5000 is 50 s after it; the row says the
  // earliest the process can have started (a tick earlier) and how far after that it may lie.
  assert.deepEqual([rows[0]!.startMs, rows[0]!.startSlackMs], [now - 1_000_500 + 50_000 - 10, PROC_START_SLACK_MS]);
  // No uptime: btime's whole seconds, and their slack.
  const btimeRows = listProcesses(source({ read: (f) => (f === '/proc/uptime' ? undefined : files[f]) }))!;
  assert.deepEqual([btimeRows[0]!.startMs, btimeRows[0]!.startSlackMs], [(1_699_998_999 + 50) * 1000, 1000]);
  // No boot id: rows without it, which recovery compares by the wall clock.
  assert.equal(listProcesses(source({ bootId: () => undefined }))![0]!.bootId, undefined);
  // /proc that does not answer — unlistable, or a listing without this process — and off Linux: ps's rows, whole seconds, no ticks.
  for (const [why, over] of [
    ['unlistable', { entries: () => undefined }],
    ['without this process', { self: 88 }],
    ['off Linux', { platform: 'darwin' }],
  ] as [string, Partial<ProcessSource>][]) {
    const ps = listProcesses(source(over));
    assert.ok(ps?.some((r) => r.pid === 88), `${why}: ps's rows`);
    assert.ok(ps!.every((r) => r.startTicks === undefined && r.bootId === undefined && r.startSlackMs === undefined), `${why}: no ticks from ps`);
  }
  assert.equal(listProcesses(source({ entries: () => undefined, ps: () => undefined })), undefined, 'neither answers');
  // The uptime is read on both sides of the wall clock: the later read places the boot (starts at their
  // earliest), and the 80 ms between the reads widens the slack. Read once, after the clock, a stall
  // between the clock and that read moved the starts earlier than the slack covered (a reviewer's read
  // of the fixes for #22).
  const uptimes = ['1000.50 2000.00\n', '1000.58 2000.00\n'];
  let reads = 0;
  const stalled = listProcesses(source({ read: (f) => (f === '/proc/uptime' ? uptimes[Math.min(reads++, 1)] : files[f]) }))!;
  assert.equal(reads, 2, 'two uptime reads per listing');
  assert.deepEqual([stalled[0]!.startMs, stalled[0]!.startSlackMs], [now - 1_000_580 + 50_000 - 10, PROC_START_SLACK_MS + 80]);
  // The true start lies within the row's window wherever the clock's read fell between the two uptime reads.
  for (const upAtClock of [1000.5, 1000.54, 1000.58]) {
    const trueStart = now - upAtClock * 1000 + 50_000;
    assert.ok(stalled[0]!.startMs <= trueStart && trueStart <= stalled[0]!.startMs + stalled[0]!.startSlackMs!, `uptime ${upAtClock} at the clock's read`);
  }
});

test('Linux: the machine\'s own listing is /proc\'s — every row with start ticks, the boot id read once, and the /proc slack', { skip: process.platform !== 'linux' ? `the machine's /proc is Linux's: skipped on ${process.platform}` : false }, () => {
  const real = listProcesses()!;
  assert.ok(real.some((r) => r.pid === process.pid), 'the machine\'s listing has this process');
  assert.ok(real.every((r) => r.startTicks !== undefined && r.bootId === bootId() && r.startSlackMs! >= PROC_START_SLACK_MS), 'the machine\'s rows are /proc\'s');
});

// ───────────── the house's read of the 33 commits (PR #22, comment 6307349700): the guard, and an unreadable holder ─────────────

const locked = (e: unknown) => code(e) === 'data_dir_locked';
/**
 * Child source: say `said` on stdout, synchronously (a pipe's console.log is asynchronous on macOS and would
 * wait out the stall), then block this thread until `go` exists: a stop the test ends. The child keeps the
 * unpatched writeSync as `realWrite`.
 */
const stallUntil = (said: string, go: string) =>
  `realWrite(1, ${JSON.stringify(said + '\n')}); while (!fsc.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`;

test('without hard links, a start stalled between creating termd.lock in place and writing it, and a taker that reads the file empty and old: one holder, however long the stall (the house\'s read of the 33 commits, PR #22, comment 6307349700, item 1)', async () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const goA = path.join(tmp, `goA-${dirs}`);
  const goB = path.join(tmp, `goB-${dirs}`);
  const outcome = /^(won|refused|error)/;
  // A: no hard links; its write into termd.lock blocks until the test says go.
  const a = child(`
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fsc = createRequire(import.meta.url)('node:fs');
    const realOpen = fsc.openSync, realWrite = fsc.writeSync;
    const lockFds = new Set();
    fsc.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); if (String(p) === ${JSON.stringify(file)}) lockFds.add(fd); return fd; };
    fsc.writeSync = (fd, ...rest) => { if (lockFds.delete(fd)) { ${stallUntil('stalling', goA)} } return realWrite(fd, ...rest); };
    syncBuiltinESMExports();
    const { acquireDataDirLock } = await import(${JSON.stringify(LOCK_JS)});
    const noLinks = () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); };
    try { acquireDataDirLock(${JSON.stringify(dir)}, { link: noLinks }); console.log('won'); }
    catch (e) { console.log(e.code === 'data_dir_locked' ? 'refused' : 'error ' + e.message); }
    setInterval(() => {}, 1000);
  `);
  let b: ReturnType<typeof child> | undefined;
  try {
    await a.line(/^stalling$/);
    // A stall of seconds, without waiting them out: the empty file reads as old to the taker, and so does
    // any guard beside it.
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(file, old, old);
    if (fs.existsSync(`${file}.takeover`)) fs.utimesSync(`${file}.takeover`, old, old);
    // B: hard links work for it; its rename onto termd.lock, if it gets that far, blocks until the test says go.
    b = child(`
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const fsc = createRequire(import.meta.url)('node:fs');
      const realRename = fsc.renameSync, realWrite = fsc.writeSync;
      fsc.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(file)}) { ${stallUntil('renaming', goB)} } return realRename(from, to); };
      syncBuiltinESMExports();
      const { acquireDataDirLock } = await import(${JSON.stringify(LOCK_JS)});
      try { acquireDataDirLock(${JSON.stringify(dir)}); console.log('won'); }
      catch (e) { console.log(e.code === 'data_dir_locked' ? 'refused' : 'error ' + e.message); }
      setInterval(() => {}, 1000);
    `);
    const first = await b.line(/^(renaming|won|refused|error)/);
    fs.writeFileSync(goA, ''); // A's write lands, and it reads its record back
    await a.line(outcome);
    if (first === 'renaming') fs.writeFileSync(goB, ''); // the taker's delayed rename lands after that read-back
    await b.line(outcome);
    const outcomes = [a, b].map((c) => c.lines.find((l) => outcome.test(l)));
    assert.equal(outcomes.filter((o) => o === 'won').length, 1, `one holder: A ${outcomes[0]}, B ${outcomes[1]}`);
    assert.ok(!outcomes.some((o) => o?.startsWith('error')), outcomes.join(', '));
    const winner = outcomes[0] === 'won' ? a : b;
    assert.equal(readLock(dir).pid, winner.proc.pid, 'termd.lock names the one holder');
  } finally {
    a.proc.kill('SIGKILL');
    b?.proc.kill('SIGKILL');
  }
});

test('an old guard is broken only when no other live process has a lock attempt in flight: one whose attempt\'s temp names a live process is kept, one a dead process left goes (the house\'s read of the 33 commits, PR #22, comment 6307349700, item 1)', () => {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const guard = `${file}.takeover`;
  const record = (pid: number, nonce: string) => JSON.stringify({ pid, startedAt: Date.now(), hostname: os.hostname(), nonce }) + '\n';
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999, startedAt: Date.now() - 60_000, hostname: os.hostname() }) + '\n');
  fs.mkdirSync(guard);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(guard, old, old);
  // A live process (the test runner, our parent) is inside the guard: its attempt's temp names it.
  const live = path.join(dir, `${LOCK_FILE}.${process.ppid}.abcdef0123456789.tmp`);
  fs.writeFileSync(live, record(process.ppid, 'abcdef0123456789'));
  assert.throws(() => acquireDataDirLock(dir), locked, 'refused: the guard\'s holder may still be about to rename');
  assert.ok(fs.existsSync(guard), 'the guard is kept');
  assert.equal(readLock(dir).pid, 999_999, 'and the lock is untouched');
  // Its process is gone, leaving the temp and the guard behind: a lone start breaks the guard and takes the stale lock.
  fs.rmSync(live);
  fs.writeFileSync(path.join(dir, `${LOCK_FILE}.999999.0123456789abcdef.tmp`), record(999_999, '0123456789abcdef'));
  const lock = acquireDataDirLock(dir);
  try {
    assert.equal(lock.tookOver?.pid, 999_999);
    assert.equal(readLock(dir).pid, process.pid);
  } finally {
    lock.release();
  }
});

test('a live holder whose /proc stat cannot be read is kept: a listing that leaves its pid out says nothing of it while a signal still finds it (the house\'s read of the 33 commits, PR #22, comment 6307349700, item 2)', () => {
  // The Linux branch is driven through an injected /proc, so this runs on every host; the holder is a real,
  // live process, which the lock's signal check finds. On Linux an EACCES, EMFILE or LSM denial on its stat
  // reads the same: what the injected reader returns for it here.
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const held = sleeper.pid!;
    const stat = (pid: number, ticks: number) => `${pid} (sleep) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 12345678 500`;
    const files: Record<string, string> = { '/proc/uptime': '1000.50 2000.00\n', [`/proc/${process.pid}/stat`]: stat(process.pid, 5000), [`/proc/${held}/stat`]: stat(held, 4242), [`/proc/${held}/cmdline`]: 'sleep\u000030' };
    let readable = true;
    const linux: ProcessSource = {
      platform: 'linux',
      read: (f) => (f === `/proc/${held}/stat` && !readable ? undefined : files[f]),
      entries: () => [String(process.pid), String(held)],
      ps: () => undefined,
      now: () => Date.now(),
      bootId: () => 'boot-A',
      self: process.pid,
    };
    fs.writeFileSync(file, JSON.stringify({ pid: held, startedAt: Date.now(), hostname: os.hostname(), nonce: 'holder', startTicks: 4242, bootId: 'boot-A' }) + '\n');
    assert.throws(() => acquireDataDirLock(dir, { processes: linux }), locked, 'its stat reads, its ticks match: live');
    readable = false;
    assert.throws(() => acquireDataDirLock(dir, { processes: linux }), locked, 'its stat cannot be read: kept, not taken over');
    assert.equal(readLock(dir).pid, held);
    readable = true;
    files[`/proc/${held}/stat`] = stat(held, 4243);
    const lock = acquireDataDirLock(dir, { processes: linux });
    assert.equal(lock.tookOver?.pid, held, 'its stat reads other ticks: a reused pid, taken over');
    lock.release();
  } finally {
    sleeper.kill('SIGKILL');
  }
});

// ───────────── the house's review of the 40 commits through f3750e4 (PR #22, comment 6310921374, question 3): the guard carries its owner ─────────────

const guardOf = (dir: string) => path.join(dir, `${LOCK_FILE}.takeover`);
const record = (pid: number, nonce: string, startedAt = Date.now()) => JSON.stringify({ pid, startedAt, hostname: os.hostname(), nonce }) + '\n';
/** A lock whose holder is long gone, so a start takes it over under the guard. */
const staleLock = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCK_FILE), record(999_999, 'stale', Date.now() - 60_000));
};
/** A stop of seconds, without waiting them out. */
const aged = (p: string) => {
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(p, old, old);
};
const noLinks = () => {
  throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
};

test('inside the guard, its owner file names the attempt by pid and nonce and holds its record; a guard whose owner is gone is broken at once, one whose owner lives is kept however old (the house\'s review of the 40 commits through f3750e4, PR #22, comment 6310921374, question 3)', () => {
  // Inside: the fallback without hard links writes termd.lock under the guard, where the guard is looked at.
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  let inside: string[][] | undefined;
  const realOpen = fsc.openSync;
  fsc.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p) === file && inside === undefined) inside = fs.readdirSync(guardOf(dir)).map((n) => [n, fs.readFileSync(path.join(guardOf(dir), n), 'utf8')]);
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  let lock;
  try {
    lock = acquireDataDirLock(dir, { link: noLinks });
  } finally {
    fsc.openSync = realOpen;
    syncBuiltinESMExports();
  }
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(inside, [[`${process.pid}.${(JSON.parse(raw) as { nonce: string }).nonce}`, raw]], 'one owner: this attempt, with its whole record');
  assert.equal(fs.existsSync(guardOf(dir)), false, 'left as it was entered');
  lock.release();

  // A guard a crashed start left, its owner gone: broken at once, though it is fresh.
  const dead = dataDir();
  staleLock(dead);
  fs.mkdirSync(guardOf(dead));
  fs.writeFileSync(path.join(guardOf(dead), '999999.0123456789abcdef'), record(999_999, '0123456789abcdef'));
  const over = acquireDataDirLock(dead);
  assert.equal(over.tookOver?.pid, 999_999, 'taken over without waiting out the guard\'s age');
  assert.equal(fs.existsSync(guardOf(dead)), false);
  over.release();

  // A guard whose owner lives (our parent, the test runner), old and with no attempt in flight: a holder
  // stopped after its rename, its temp gone. Kept, by a taker and by the fallback alike.
  const live = dataDir();
  staleLock(live);
  const owner = path.join(guardOf(live), `${process.ppid}.abcdef0123456789`);
  fs.mkdirSync(guardOf(live));
  fs.writeFileSync(owner, record(process.ppid, 'abcdef0123456789'));
  aged(owner);
  aged(guardOf(live));
  for (const opts of [{}, { link: noLinks }]) {
    assert.throws(() => acquireDataDirLock(live, opts), locked, `refused ${JSON.stringify(Object.keys(opts))}: the guard's owner lives`);
    assert.deepEqual(fs.readdirSync(guardOf(live)), [path.basename(owner)], 'the guard and its owner are kept');
    assert.equal(readLock(live).pid, 999_999, 'and the lock is untouched');
  }

  // An owner file without a whole record (a start between its create and its write, or a crash there):
  // judged as an ownerless guard is, kept while a live attempt is in flight and broken once none is.
  const torn = dataDir();
  staleLock(torn);
  const tornOwner = path.join(guardOf(torn), `${process.ppid}.1111111111111111`);
  fs.mkdirSync(guardOf(torn));
  fs.writeFileSync(tornOwner, '');
  aged(tornOwner);
  aged(guardOf(torn));
  const attempt = path.join(torn, `${LOCK_FILE}.${process.ppid}.1111111111111111.tmp`);
  fs.writeFileSync(attempt, record(process.ppid, '1111111111111111'));
  assert.throws(() => acquireDataDirLock(torn), locked, 'its writer may still be writing');
  fs.rmSync(attempt);
  const afterTorn = acquireDataDirLock(torn);
  assert.equal(afterTorn.tookOver?.pid, 999_999);
  afterTorn.release();
});

/** Child source that patches the builtins before it loads the lock: `fsc` and the unpatched `realWrite` are in scope for stallUntil. */
const patched = (patch: string, run: string) => `
  import { createRequire, syncBuiltinESMExports } from 'node:module';
  const fsc = createRequire(import.meta.url)('node:fs');
  const realWrite = fsc.writeSync;
  ${patch}
  syncBuiltinESMExports();
  const { acquireDataDirLock } = await import(${JSON.stringify(LOCK_JS)});
  try { ${run}; console.log('won'); }
  catch (e) { console.log(e.code === 'data_dir_locked' ? 'refused' : 'error ' + e.message); }
  setInterval(() => {}, 1000);
`;
const outcomeRe = /^(won|refused|error)/;
/** A directory's names; undefined once it is gone. */
const ls = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : undefined);

test('a breaker whose check straddles another breaker\'s removal and a third start\'s mkdir removes nothing of the new guard: one holder (the house\'s review of the 40 commits through f3750e4, PR #22, comment 6310921374, question 3)', async () => {
  const dir = dataDir();
  staleLock(dir);
  const file = path.join(dir, LOCK_FILE);
  const guard = guardOf(dir);
  // A guard a crash left: its owner is gone, and it is old, so it is broken by either rule.
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, '999999.0123456789abcdef'), record(999_999, '0123456789abcdef'));
  aged(path.join(guard, '999999.0123456789abcdef'));
  aged(guard);
  const goX = path.join(tmp, `goX-${dirs}`);
  const goZ = path.join(tmp, `goZ-${dirs}`);
  // X: judges the crashed guard gone, then stops before it removes anything there.
  const x = child(
    patched(
      `let stopped = false;
      for (const fn of ['unlinkSync', 'rmSync', 'rmdirSync']) {
        const real = fsc[fn];
        fsc[fn] = (p, ...rest) => {
          const s = String(p);
          if (!stopped && (s === ${JSON.stringify(guard)} || s.startsWith(${JSON.stringify(guard + path.sep)}))) { stopped = true; ${stallUntil('breaking', goX)} }
          return real(p, ...rest);
        };
      }`,
      `acquireDataDirLock(${JSON.stringify(dir)})`,
    ),
  );
  let z: ReturnType<typeof child> | undefined;
  try {
    await x.line(/^breaking$/);
    // Y: another breaker removes the crashed guard meanwhile.
    fs.rmSync(guard, { recursive: true, force: true });
    // Z: a third start makes a guard of its own and is inside it, about to rename onto the stale lock.
    z = child(patched(`const realRename = fsc.renameSync; fsc.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(file)}) { ${stallUntil('renaming', goZ)} } return realRename(from, to); };`, `acquireDataDirLock(${JSON.stringify(dir)})`));
    await z.line(/^renaming$/);
    const zGuard = ls(guard);
    fs.writeFileSync(goX, ''); // X goes on with the removal it judged
    await x.line(outcomeRe);
    const afterX = ls(guard);
    fs.writeFileSync(goZ, '');
    await z.line(outcomeRe);
    const outcomes = [x, z].map((c) => c.lines.find((l) => outcomeRe.test(l)));
    assert.deepEqual(outcomes, ['refused', 'won'], 'one holder: X waited on a live owner, then refused');
    assert.equal(readLock(dir).pid, z.proc.pid, 'termd.lock names the one holder');
    assert.deepEqual(afterX, zGuard, 'Z\'s guard stood while Z was inside it');
    assert.match(zGuard?.join() ?? '', new RegExp(`^${z.proc.pid}\\.[0-9a-f]+$`), 'owned by Z');
  } finally {
    x.proc.kill('SIGKILL');
    z?.proc.kill('SIGKILL');
  }
});

test('a holder stopped for seconds between its rename and leaving the guard keeps it, and its release removes only its own (the house\'s review of the 40 commits through f3750e4, PR #22, comment 6310921374, question 3)', async () => {
  const dir = dataDir();
  staleLock(dir);
  const file = path.join(dir, LOCK_FILE);
  const guard = guardOf(dir);
  const goH = path.join(tmp, `goH-${dirs}`);
  // H: takes the stale lock over, and stops right after its rename, still inside the guard, its temp gone.
  const h = child(patched(`const realRename = fsc.renameSync; fsc.renameSync = (from, to) => { const r = realRename(from, to); if (String(to) === ${JSON.stringify(file)}) { ${stallUntil('renamed', goH)} } return r; };`, `acquireDataDirLock(${JSON.stringify(dir)})`));
  let x: ReturnType<typeof child> | undefined;
  try {
    await h.line(/^renamed$/);
    const hGuard = fs.readdirSync(guard);
    for (const n of hGuard) aged(path.join(guard, n));
    aged(guard);
    // X: a start without hard links, which goes for the guard whatever the lock holds; it says when it is inside.
    x = child(patched(`const realOpen = fsc.openSync; fsc.openSync = (p, flags, ...rest) => { if (String(p) === ${JSON.stringify(file)} && flags === 'wx') realWrite(1, 'inside\\n'); return realOpen(p, flags, ...rest); };`, `acquireDataDirLock(${JSON.stringify(dir)}, { link: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } })`));
    await x.line(outcomeRe);
    assert.deepEqual(x.lines.filter((l) => l !== 'refused'), [], 'X never entered the guard H is inside');
    assert.equal(x.lines.find((l) => outcomeRe.test(l)), 'refused');
    assert.deepEqual(fs.readdirSync(guard), hGuard, 'H\'s guard is kept, however old');
    // Should anything else stand there by the time H leaves (an earlier build's breaker, a hand removal and
    // another start's guard), H's release leaves it.
    fs.rmSync(guard, { recursive: true, force: true });
    fs.mkdirSync(guard);
    fs.writeFileSync(path.join(guard, `${process.ppid}.abcdef0123456789`), record(process.ppid, 'abcdef0123456789'));
    fs.writeFileSync(goH, '');
    await h.line(outcomeRe);
    assert.equal(h.lines.find((l) => outcomeRe.test(l)), 'won');
    assert.deepEqual(fs.readdirSync(guard), [`${process.ppid}.abcdef0123456789`], 'the other guard and its owner are left');
    assert.equal(readLock(dir).pid, h.proc.pid);
  } finally {
    h.proc.kill('SIGKILL');
    x?.proc.kill('SIGKILL');
  }
});

/** Run `fn` with one builtin replaced as lock.js sees it, restored after. */
function patching<K extends keyof typeof fsc, T>(name: K, replacement: (real: (typeof fsc)[K]) => (typeof fsc)[K], fn: () => T): T {
  const real = fsc[name];
  fsc[name] = replacement(real);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsc[name] = real;
    syncBuiltinESMExports();
  }
}
test('a registry syncs each directory it makes into its parent before recovery: the data dir and any parent made on the way, then sessions/; a sync the disk refuses is said once', async () => {
  const base = dataDir();
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, 'a', 'data');
  const sessions = path.join(dir, 'sessions');
  const synced: { ino: number; sessions: boolean }[] = [];
  const reg = patching(
    'fsyncSync',
    (real) =>
      ((fd: number) => {
        const st = fsc.fstatSync(fd);
        if (st.isDirectory()) synced.push({ ino: st.ino, sessions: fs.existsSync(sessions) });
        return real(fd);
      }) as typeof fs.fsyncSync,
    () => new SessionRegistry({ dataDir: dir, backend: new ScriptedBackend() }),
  );
  const ino = (p: string) => fs.statSync(p).ino;
  assert.ok(synced.some((s) => s.ino === ino(base)), 'base, which holds the new a/');
  assert.ok(synced.some((s) => s.ino === ino(path.join(base, 'a'))), 'a/, which holds the new data dir');
  assert.ok(synced.some((s) => s.ino === ino(dir) && s.sessions), 'the data dir, once it holds sessions/');
  await reg.closeAll();
  const warnings: string[] = [];
  const refused = withDirFsyncEIO(() => new SessionRegistry({ dataDir: path.join(base, 'b'), backend: new ScriptedBackend(), log: (level, text) => void (level === 'warn' && warnings.push(text)) }));
  assert.equal(warnings.filter((w) => /a directory the daemon made could not be synced into its parent/.test(w)).length, 1, JSON.stringify(warnings));
  await refused.closeAll();
});
