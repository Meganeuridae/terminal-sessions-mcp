/**
 * The data dir's lock, and the process facts it and recovery rely on.
 *
 * One daemon owns a data dir. A second one — a shim's auto-spawn racing
 * launchd's KeepAlive, or a daemon started on another port — must not recover
 * (append `lost` ends and `recovered` markers to) journals a live daemon is
 * still numbering: the same seq would appear twice and a live Run would end
 * twice (G10, G20). `<dataDir>/termd.lock` is created exclusively and names
 * its holder; a lock whose holder is gone is taken over.
 *
 * A pid alone does not identify a process: pids are reused. A holder counts
 * only when its process started no later than the lock's `startedAt`; a process
 * group recovery finds counts only when its leader started with the Run.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { err } from './errors.js';

export const LOCK_FILE = 'termd.lock';

/** What the lock file holds. */
export interface LockHolder {
  pid: number;
  /** When the holder took the lock (ms since the epoch); its process started no later. */
  startedAt: number;
  hostname: string;
  /** Distinguishes two takes by one process (a pid alone cannot). */
  nonce?: string;
  /**
   * The holder's start in clock ticks after boot, and the boot id (Linux): a wall-clock step (NTP)
   * does not move these, so a second start compares them frame-free instead of trusting `startedAt`,
   * which a forward step could make a live daemon's lock look stale (the house's read of the 36
   * commits, #22, comment 6269992150). Absent on macOS and older builds: the wall clock decides there.
   */
  startTicks?: number;
  bootId?: string;
}

export interface DataDirLock {
  readonly file: string;
  /** Set when the lock was taken from a holder that is gone: what its file said (empty when it was torn). The daemon logs it (the house's read of 59f660b, #22). */
  readonly tookOver?: Partial<LockHolder>;
  /** Give the lock up (idempotent). The file is removed only by the handle that took it, while it holds it. */
  release(): void;
}

/** A process as `ps` (or /proc) reports it: start times have one-second resolution. */
export interface ProcessRow {
  pid: number;
  pgid: number;
  /** Start time, truncated to the second (ms since the epoch). */
  startMs: number;
  /**
   * The process's start in clock ticks after boot, read from /proc on Linux (undefined with `ps`,
   * and on macOS): a wall-clock step does not move it, so recovery compares it frame-free against a
   * Run's recorded ticks (the house's read of the 36 commits, #22, comment 6269992150).
   */
  startTicks?: number;
  /** The boot id this listing was taken under (Linux): a different one means the process cannot be a pre-restart Run's. */
  bootId?: string;
  /** Exited, not yet reaped by its parent: it counts as gone. */
  zombie: boolean;
}

/** The machine's boot id (Linux), read once: /proc/sys/kernel/random/boot_id, trimmed. Undefined elsewhere or when unreadable. */
function readBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return id.length ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Block the thread: only for startup paths bounded to a few seconds, before the daemon serves anyone. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True while `target` exists: a pid, or a process group as `-pgid` (EPERM: it exists, and it is not ours to signal). */
function exists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True while any process belongs to process group `pgid`. */
export const groupAlive = (pgid: number): boolean => pgid > 1 && exists(-pgid);

/** Linux without a full `ps`: /proc/<pid>/stat's start time (clock ticks after boot) and /proc/stat's btime. */
function procRows(): ProcessRow[] | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const btime = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
    if (!Number.isFinite(btime)) return undefined;
    const hz = 100; // USER_HZ: 100 on every mainstream Linux ABI
    const bootId = readBootId();
    const out: ProcessRow[] = [];
    for (const name of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue; // gone meanwhile
      }
      // pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime …
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const pgid = Number(f[2]);
      const start = Number(f[19]);
      // starttime is in clock ticks after boot: frame-free, so recovery compares it without a wall-clock frame.
      if (Number.isFinite(pgid) && Number.isFinite(start)) out.push({ pid: Number(name), pgid, startMs: Math.floor(btime + start / hz) * 1000, startTicks: start, ...(bootId !== undefined && { bootId }), zombie: f[0] === 'Z' });
    }
    return out;
  } catch {
    return undefined;
  }
}

function psRows(): ProcessRow[] | undefined {
  let text: string;
  try {
    text = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined; // no `ps`, or one without these columns (BusyBox)
  }
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const startMs = Date.parse(m[4]!); // `lstart`: "Thu Sep 24 10:00:00 2026", local time
    if (Number.isFinite(startMs)) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), startMs, zombie: m[3]!.startsWith('Z') });
  }
  return rows;
}

/**
 * Every process on the machine; undefined when neither `ps` nor /proc answers. A listing
 * without this very process is not an answer either: absence must mean gone.
 */
export function listProcesses(): ProcessRow[] | undefined {
  const answer = (rows: ProcessRow[] | undefined) => (rows?.some((r) => r.pid === process.pid) ? rows : undefined);
  return answer(psRows()) ?? answer(procRows());
}

/** One process: null when it is gone (or a zombie), undefined when nothing can say. */
export function processInfo(pid: number): ProcessRow | null | undefined {
  const rows = listProcesses();
  if (rows === undefined) return undefined;
  const row = rows.find((r) => r.pid === pid);
  return row && !row.zombie ? row : null;
}

/** The groups among `pgids` with a member that is not a zombie (a zombie holds its pid until reaped): one listing for all. */
export function livingGroups(pgids: number[]): number[] {
  const signalled = pgids.filter(groupAlive);
  if (!signalled.length) return signalled;
  const rows = listProcesses();
  return rows === undefined ? signalled : signalled.filter((g) => rows.some((r) => r.pgid === g && !r.zombie));
}

/** This process's own start (ms): a lock naming our pid but written before we started is a predecessor's. */
const selfStartMs = Date.now() - process.uptime() * 1000;

/** This process's own start in clock ticks after boot (Linux): recorded in the lock so a second start can compare frame-free. */
function selfStartTicks(): number | undefined {
  if (process.platform !== 'linux') return undefined;
  return procStartTicks(process.pid);
}

/** A pid's start in clock ticks after boot (Linux): /proc/<pid>/stat field 22. Undefined off Linux or when gone. */
function procStartTicks(pid: number): number | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a live pid's command names termd: a wall-clock step must not take the lock from a running daemon (macOS, where there are no ticks). */
function commandNamesTermd(pid: number): boolean {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('termd');
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).includes('termd');
  } catch {
    return false;
  }
}

// ───────────── the lock ─────────────

/** The locks this process took, by file, with the content it wrote: we remove only our own lock. */
const taken = new Map<string, string>();

function readRaw(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function removeIfOurs(file: string, raw: string): void {
  try {
    if (readRaw(file) === raw) fs.unlinkSync(file);
  } catch {
    // best effort; a stale lock is taken over at the next start anyway
  }
}

// Any exit path, including process.exit() from a signal handler: leave no lock naming a dead process.
process.on('exit', () => {
  for (const [file, raw] of taken) removeIfOurs(file, raw);
});

function parseHolder(raw: string): LockHolder | undefined {
  try {
    const h = JSON.parse(raw) as LockHolder;
    return typeof h?.pid === 'number' && typeof h.startedAt === 'number' && typeof h.hostname === 'string' ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the holder named in a lock file still holds it: its pid lives, and that process is the one
 * that wrote it. `self`: this very process wrote it (another registry in this process). The lock is
 * host-local, like the data dir it guards; `hostname` is only reported (a laptop's hostname changes
 * with its network, and a stale lock must not outlive that).
 *
 * On Linux the holder's boot id and start ticks decide, frame-free: a different boot id, or a pid now
 * holding different ticks, is a new process (the lock is stale); matching ticks are the holder, however
 * the wall clock has stepped since. Off Linux (no ticks) the wall clock decides — a process that
 * started after the lock was written is a pid reuse — but a wall-clock step must not take the lock from
 * a running daemon, so a live pid whose command names termd is never read as stale (the house's read of
 * the 36 commits, #22, comment 6269992150).
 */
function holderLive(h: LockHolder): 'live' | 'stale' | 'self' {
  if (h.pid === process.pid) return h.startedAt >= selfStartMs - 1000 ? 'self' : 'stale';
  if (!(h.pid > 0) || !exists(h.pid)) return 'stale';
  if (h.bootId !== undefined && process.platform === 'linux') {
    const bootId = readBootId();
    if (bootId !== undefined && bootId !== h.bootId) return 'stale'; // a different boot: the pid is a new process
    const ticks = procStartTicks(h.pid);
    if (h.startTicks !== undefined && ticks !== undefined) return ticks === h.startTicks ? 'live' : 'stale';
  }
  const info = processInfo(h.pid);
  if (info === null) return 'stale';
  // Unknown start time: assume the holder is who it says (refusing is recoverable; sharing journals is not).
  // A process that started after the lock was written cannot have written it — the pid was reused — unless
  // its command names termd, which a wall-clock step (not a reuse) can make look so: never take that over.
  if (info === undefined || info.startMs <= h.startedAt + 1000) return 'live';
  return commandNamesTermd(h.pid) ? 'live' : 'stale';
}

const lockedError = (dataDir: string, file: string, h: LockHolder | undefined, why: string) =>
  err('data_dir_locked', `data dir ${dataDir} is in use by ${why}; one daemon per data dir (remove ${file} only if no termd is running)`, {
    dataDir,
    lockFile: file,
    ...(h ? { pid: h.pid, hostname: h.hostname, startedAt: h.startedAt } : {}),
  });

/** Write `raw` to `tmp`, fsynced and owner-only, before `tmp` is linked or renamed into place: the lock is never seen empty or torn. */
function writeSyncedTemp(tmp: string, raw: string): void {
  const data = Buffer.from(raw);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
}

/** fsync the directory so a create or rename survives a crash; a filesystem that cannot is left (the rename/link is still atomic). */
function syncDir(file: string): void {
  let dir: number | undefined;
  try {
    dir = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dir);
  } catch {
    // a filesystem that cannot sync a directory
  } finally {
    if (dir !== undefined) fs.closeSync(dir);
  }
}

const rmTemp = (tmp: string) => {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best effort
  }
};

/**
 * Replace a stale lock, atomically: under a short-lived guard (an exclusive mkdir), confirm the file
 * still holds what was judged stale, then rename `tmp` — already written and synced before the guard
 * was taken — over it, so only the compare and the rename run inside the guard, never a slow write
 * (the house's read of the 36 commits, #22, comment 6269992150). Returns false when the file changed
 * meanwhile (the caller starts over and judges again); `tmp` is then left for the caller to remove.
 */
function takeOver(file: string, staleRaw: string, tmp: string): boolean {
  const guard = `${file}.takeover`;
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another taker is inside its (microsecond) critical section; one that crashed there left the guard behind.
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > 5000) fs.rmSync(guard, { recursive: true, force: true });
    } catch {
      // gone meanwhile
    }
    return false;
  }
  try {
    if (readRaw(file) !== staleRaw) return false;
    fs.renameSync(tmp, file);
    syncDir(file);
    return true;
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
}

/**
 * Take `<dataDir>/termd.lock` or throw `data_dir_locked` naming the live holder. The complete lock is
 * written and synced to a temp file first, then `link()`ed to `termd.lock` (EEXIST means taken, as `wx`
 * did), so no starter ever reads an empty or half-written lock (comment 6269992150). A lock left by a
 * dead process (or by a pid reused since) is taken over. Within one process the lock is shared: its
 * taker releases it.
 */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  const dir = path.resolve(dataDir);
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const take = (raw: string, tookOver?: Partial<LockHolder>): DataDirLock => {
    taken.set(file, raw);
    return {
      file,
      ...(tookOver ? { tookOver } : {}),
      release() {
        // A handle from before the file was lost and taken again must not release the new take.
        if (taken.get(file) === raw) taken.delete(file);
        removeIfOurs(file, raw);
      },
    };
  };
  const bootId = readBootId();
  const startTicks = selfStartTicks();
  for (let attempt = 0; attempt < 50; attempt++) {
    const me: LockHolder = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname(), nonce: randomBytes(8).toString('hex'), ...(startTicks !== undefined && { startTicks }), ...(bootId !== undefined && { bootId }) };
    const raw = JSON.stringify(me) + '\n';
    const tmp = `${file}.${process.pid}.${me.nonce}.tmp`;
    try {
      writeSyncedTemp(tmp, raw);
    } catch (e) {
      rmTemp(tmp);
      throw e;
    }
    try {
      fs.linkSync(tmp, file);
      rmTemp(tmp);
      syncDir(file);
      return take(raw);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        rmTemp(tmp);
        throw e;
      }
    }
    const current = readRaw(file);
    if (current === undefined) {
      rmTemp(tmp);
      continue; // released meanwhile: try again
    }
    const holder = parseHolder(current);
    if (!holder) {
      // Empty or torn: a taker that crashed there, or an older build between its create and its write
      // (link() of a synced temp no longer leaves such a window). Take it over only when it is old.
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        rmTemp(tmp);
        continue;
      }
      if (age < 2000) {
        rmTemp(tmp);
        sleepSync(20);
        continue;
      }
    } else {
      const state = holderLive(holder);
      if (state === 'self') {
        rmTemp(tmp);
        return { file, release: () => undefined }; // another registry in this process took it; its taker releases it
      }
      if (state === 'live') {
        rmTemp(tmp);
        throw lockedError(dataDir, file, holder, `termd pid ${holder.pid}${holder.hostname !== os.hostname() ? ` (written on host ${holder.hostname})` : ''}`);
      }
    }
    if (takeOver(file, current, tmp)) return take(raw, holder ?? {});
    rmTemp(tmp);
    sleepSync(10);
  }
  throw lockedError(dataDir, file, parseHolder(readRaw(file) ?? ''), 'another termd starting at the same time');
}
