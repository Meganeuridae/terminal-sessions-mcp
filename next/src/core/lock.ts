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
import { syncDir } from './stores.js';

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
  /** Set when the directory's filesystem refused link(): the lock was created by an exclusive write instead (the registry logs it once). */
  readonly noHardLinks?: true;
  /** Set when the lock is taken but its directory could not be synced (a real fsync error): a lock that vanishes after a crash is simply taken anew; the registry logs it once (comment 6274603516). */
  readonly unsynced?: true;
  /** Give the lock up (idempotent). The file is removed only by the handle that took it, while it holds it. */
  release(): void;
}

/** A process as /proc (Linux) or `ps` (elsewhere) reports it. */
export interface ProcessRow {
  pid: number;
  pgid: number;
  /**
   * The earliest the process can have started (ms since the epoch), in the wall-clock frame of the
   * listing: it started before `startMs + startSlackMs`. From /proc, its start ticks placed against the
   * uptime; from `ps`, `lstart` truncated to the second.
   */
  startMs: number;
  /**
   * How far after `startMs` the process may have started: PROC_START_SLACK_MS for a /proc row whose
   * uptime read, 1000 (whole seconds) for `ps`'s rows and when absent (the house's read of the 38
   * commits, PR #22, comment 6274857431, item 3).
   */
  startSlackMs?: number;
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

let bootIdCache: { value: string | undefined } | undefined;

/** The machine's boot id (Linux), read once per daemon from /proc/sys/kernel/random/boot_id, trimmed. Undefined elsewhere or when unreadable. */
export function bootId(): string | undefined {
  if (bootIdCache) return bootIdCache.value;
  let value: string | undefined;
  if (process.platform === 'linux') {
    try {
      const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      value = id.length ? id : undefined;
    } catch {
      value = undefined;
    }
  }
  bootIdCache = { value };
  return value;
}

/**
 * The start time, in clock ticks after boot, from one /proc/<pid>/stat line (field 22). The comm field
 * (2) may hold spaces and parentheses, so the fields are counted after the last ')' (the house's read
 * of the 36 commits, #22, comment 6269992150, item 4). Undefined when the line does not parse.
 */
export function statStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  // pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime …
  const start = Number(stat.slice(close + 2).split(' ')[19]);
  return Number.isFinite(start) ? start : undefined;
}

/**
 * A live pid's frame-free start on Linux — its start ticks and the boot id they count from — read
 * through the same parser the process listing and the lock use, so every side agrees on the unit.
 * The backend records it on a process Run's run.start when the group leader is known; recovery and
 * the lock compare it. Undefined off Linux, when the pid is gone, or when either part is unreadable.
 */
export function procStart(pid: number): { startTicks: number; bootId: string; zombie: boolean } | undefined {
  if (process.platform !== 'linux' || !(pid > 0)) return undefined;
  const id = bootId();
  if (id === undefined) return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTicks = statStartTicks(stat);
    return startTicks === undefined ? undefined : { startTicks, bootId: id, zombie: statIsZombie(stat) };
  } catch {
    return undefined;
  }
}

/** Whether one /proc/<pid>/stat line's state (field 3, after the comm) is Z: exited and not yet reaped, so gone for the lock and recovery (comment 6274603516). */
export function statIsZombie(stat: string): boolean {
  const close = stat.lastIndexOf(')');
  return close !== -1 && stat.slice(close + 2).split(' ')[0] === 'Z';
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

/** A clock tick in ms: USER_HZ is 100 on every mainstream Linux ABI. */
const TICK_MS = 10;
/**
 * A /proc row's start is its ticks (10 ms) placed against /proc/uptime (10 ms) read beside the wall
 * clock: the true start lies within this of the row's earliest (two ticks, and a margin for the reads).
 * The bounds recovery compares it with are wall-clock records, so a clock step between a record and the
 * recovery moves the comparison by the step.
 */
export const PROC_START_SLACK_MS = 2 * TICK_MS + 5;

/**
 * Where the process listing reads from: the machine by default. Specs inject their own, which drives the
 * Linux branch (a /proc tree, its uptime and boot id) on any host (comment 6274857431, item 1).
 */
export interface ProcessSource {
  platform: NodeJS.Platform;
  /** A /proc file's text; undefined when it cannot be read. */
  read(file: string): string | undefined;
  /** The names /proc lists; undefined when it cannot be listed. */
  entries(): string[] | undefined;
  /** `ps -A -o pid=,pgid=,stat=,lstart=`'s output; undefined when `ps` does not answer. */
  ps(): string | undefined;
  /** The wall clock /proc's uptime is read against. */
  now(): number;
  /** This process's pid: a listing without it is no answer. */
  self: number;
}

const readFile = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const machine: ProcessSource = {
  platform: process.platform,
  read: readFile,
  entries: () => {
    try {
      return fs.readdirSync('/proc');
    } catch {
      return undefined;
    }
  },
  ps: () => {
    try {
      return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined; // no `ps`, or one without these columns (BusyBox)
    }
  },
  now: Date.now,
  self: process.pid,
};

/**
 * Linux: /proc/<pid>/stat's start ticks after boot, with the boot id they count from, and a start time
 * placed against /proc/uptime (10 ms; /proc/stat's btime, whole seconds, when the uptime cannot be read).
 */
function procRows(src: ProcessSource): ProcessRow[] | undefined {
  if (src.platform !== 'linux') return undefined;
  const names = src.entries();
  // The wall clock first, then the uptime: a delay between the two reads moves the starts earlier, never later.
  const now = src.now();
  const uptime = Number(/^(\d+(?:\.\d+)?)\s/.exec(src.read('/proc/uptime') ?? '')?.[1]);
  const btime = Number(/^btime (\d+)$/m.exec(src.read('/proc/stat') ?? '')?.[1]);
  const placed = Number.isFinite(uptime);
  if (!names || (!placed && !Number.isFinite(btime))) return undefined;
  const bootMs = placed ? now - uptime * 1000 : btime * 1000;
  const slack = placed ? PROC_START_SLACK_MS : 1000;
  const boot = src.read('/proc/sys/kernel/random/boot_id')?.trim() || undefined;
  const out: ProcessRow[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = src.read(`/proc/${name}/stat`);
    if (stat === undefined) continue; // gone meanwhile
    // The fields after the comm (which may hold spaces and parentheses): state ppid pgrp …; the start
    // ticks come from the one parser every side uses (statStartTicks), frame-free for recovery.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgid = Number(f[2]);
    const start = statStartTicks(stat);
    if (!Number.isFinite(pgid) || start === undefined) continue;
    // The earliest the process can have started: its tick, less the uptime's own tick when placed by it.
    const startMs = placed ? Math.floor(bootMs + start * TICK_MS) - TICK_MS : Math.floor(btime + start * (TICK_MS / 1000)) * 1000;
    out.push({ pid: Number(name), pgid, startMs, startSlackMs: slack, startTicks: start, ...(boot !== undefined && { bootId: boot }), zombie: f[0] === 'Z' });
  }
  return out;
}

function psRows(src: ProcessSource): ProcessRow[] | undefined {
  const text = src.ps();
  if (text === undefined) return undefined;
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
 * Every process on the machine; undefined when nothing answers. A listing without this very process
 * is not an answer either: absence must mean gone. On Linux /proc answers first, since only its rows
 * carry start ticks and the boot id: with `ps` first, as before, recovery's frame-free checks and its
 * boot guard never ran there, and its starts were whole seconds (the house's read of the 38 commits,
 * PR #22, comment 6274857431, item 1). `ps` is the fallback, and the only source elsewhere.
 */
export function listProcesses(src: ProcessSource = machine): ProcessRow[] | undefined {
  const answer = (rows: ProcessRow[] | undefined) => (rows?.some((r) => r.pid === src.self) ? rows : undefined);
  return answer(procRows(src)) ?? answer(psRows(src));
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


/**
 * Whether a live pid's command names termd: a wall-clock step must not take the lock from a running
 * daemon (macOS, where there are no ticks). Undefined when nothing can say (no /proc, `ps` failed or
 * timed out): an unknown keeps the holder, by holderLive's own rule (comment 6274603516).
 */
function commandNamesTermd(pid: number): boolean | undefined {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('termd');
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).includes('termd');
  } catch {
    return undefined;
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
function holderLive(h: LockHolder, current: string, file: string): 'live' | 'stale' | 'self' {
  // "Self" means this process wrote what the file holds now — what `taken` records, nonce and all. Any
  // other lock naming our pid is a predecessor's that this pid was reused from (a device without a
  // real-time clock booting into the same pid, a backward step): we did not write it, and no other
  // process has our pid, so it is stale — judging it by the pid and the wall clock alone took it as our
  // own and left two holders (the house's read of the 38 commits, PR #22, comment 6274603516).
  if (taken.get(file) === current) return 'self';
  if (h.pid === process.pid) return 'stale';
  if (!(h.pid > 0) || !exists(h.pid)) return 'stale';
  if (h.bootId !== undefined && process.platform === 'linux') {
    const boot = bootId();
    if (boot !== undefined && boot !== h.bootId) return 'stale'; // a different boot: the pid is a new process
    const now = procStart(h.pid);
    // kill(pid, 0) succeeds for a zombie and its stat still holds the start ticks: exited and unreaped is gone (comment 6274603516).
    if (now?.zombie) return 'stale';
    if (h.startTicks !== undefined && now !== undefined) return now.startTicks === h.startTicks ? 'live' : 'stale';
  }
  const info = processInfo(h.pid);
  if (info === null) return 'stale';
  // Unknown start time: assume the holder is who it says (refusing is recoverable; sharing journals is not).
  // A process that started after the lock was written cannot have written it — the pid was reused — unless
  // its command names termd, which a wall-clock step (not a reuse) can make look so: never take that over.
  // A check that cannot answer keeps the holder too, by the same rule (comment 6274603516).
  if (info === undefined || info.startMs <= h.startedAt + 1000) return 'live';
  return commandNamesTermd(h.pid) === false ? 'stale' : 'live';
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
    return true; // the caller syncs the directory once the take is registered, so a sync error never orphans a held lock
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
}

/**
 * Take `<dataDir>/termd.lock` or throw `data_dir_locked` naming the live holder. The complete lock is
 * written and synced to a temp file first, then `link()`ed to `termd.lock` (EEXIST means taken, as `wx`
 * did), so on that path no starter ever reads an empty or half-written lock (comment 6269992150). On a
 * filesystem without hard links the fallback creates `termd.lock` in place with an exclusive write, which
 * a starter can read empty for a moment (the age guard covers it); the take counts only if the file then
 * holds this attempt's own record, so a taker that read it empty and took it over wins alone (comment
 * 6274603516). A lock left by a dead process (or by a pid reused since) is taken over. Within one process
 * the lock is shared: its taker releases it.
 */
export function acquireDataDirLock(dataDir: string, opts: { link?: (existing: string, newPath: string) => void } = {}): DataDirLock {
  const dir = path.resolve(dataDir);
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const link = opts.link ?? ((existing: string, newPath: string) => fs.linkSync(existing, newPath));
  // The directory's filesystem has no hard links (exFAT, some SMB and FUSE mounts): link() refuses with
  // one of these, where the exclusive write worked. The lock then falls back to that write of the same
  // synced content; the age guard still covers the brief window an exclusive write opens, and the
  // registry says so once (a reviewer's read of the fixes for #22 comment 6269992150).
  const noLinksCode = (code: string | undefined) => code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV';
  let noHardLinks = false;
  const take = (raw: string, tookOver?: Partial<LockHolder>): DataDirLock => {
    taken.set(file, raw);
    return {
      file,
      ...(tookOver ? { tookOver } : {}),
      ...(noHardLinks ? { noHardLinks: true as const } : {}),
      release() {
        // A handle from before the file was lost and taken again must not release the new take.
        if (taken.get(file) === raw) taken.delete(file);
        removeIfOurs(file, raw);
      },
    };
  };
  // Our own frame-free start (Linux), through the reader recovery and the listing use.
  const self = procStart(process.pid);
  for (let attempt = 0; attempt < 50; attempt++) {
    const me: LockHolder = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname(), nonce: randomBytes(8).toString('hex'), ...(self && { startTicks: self.startTicks, bootId: self.bootId }) };
    const raw = JSON.stringify(me) + '\n';
    const tmp = `${file}.${process.pid}.${me.nonce}.tmp`;
    try {
      writeSyncedTemp(tmp, raw);
    } catch (e) {
      rmTemp(tmp);
      throw e;
    }
    // Registered before the directory sync; a sync error is reported on the handle (the registry logs it once),
    // not thrown: a lock that vanishes after a crash is simply taken anew (comment 6274603516).
    const publish = (tookOver?: Partial<LockHolder>): DataDirLock => {
      const lock = take(raw, tookOver);
      return syncDir(file) ? { ...lock, unsynced: true } : lock;
    };
    let created = false;
    try {
      link(tmp, file);
      created = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' && readRaw(file) === raw) {
        // link(2), BUGS: on NFS the link may have been made and EEXIST returned anyway. The file holds this
        // attempt's record, nonce and all, so the take is this attempt's: registered, and released like any
        // other — read as "self" it returned a no-op handle and left the lock behind a clean exit (comment 6274603516).
        created = true;
      } else if (noLinksCode(code)) {
        noHardLinks = true;
        try {
          writeSyncedTemp(file, raw); // an exclusive ('wx') create of the same content, fsynced
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') {
            rmTemp(tmp);
            throw e2;
          }
        }
        // Created in place: a starter may have read it empty during a slow write and taken it over, so the
        // take is this attempt's only if the file still holds its record (comment 6274603516).
        created = readRaw(file) === raw;
      } else if (code !== 'EEXIST') {
        rmTemp(tmp);
        throw e;
      }
    }
    if (created) {
      rmTemp(tmp);
      return publish();
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
      const state = holderLive(holder, current, file);
      if (state === 'self') {
        rmTemp(tmp);
        return { file, release: () => undefined }; // another registry in this process took it; its taker releases it
      }
      if (state === 'live') {
        rmTemp(tmp);
        throw lockedError(dataDir, file, holder, `termd pid ${holder.pid}${holder.hostname !== os.hostname() ? ` (written on host ${holder.hostname})` : ''}`);
      }
    }
    if (takeOver(file, current, tmp)) return publish(holder ?? {});
    rmTemp(tmp);
    sleepSync(10);
  }
  throw lockedError(dataDir, file, parseHolder(readRaw(file) ?? ''), 'another termd starting at the same time');
}
