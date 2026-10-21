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
 * A pid alone does not identify a process: pids are reused. On Linux a lock
 * that records its holder's boot id and start ticks is judged by those, frame-free;
 * elsewhere, or for a lock without them, a holder counts only when its process
 * started no later than the lock's `startedAt`, and a live pid whose command names
 * termd is never read as stale on that path (the house's read of the 33 commits,
 * PR #22, comment 6307349700, item 11). A process group recovery finds counts only
 * when its leader started with the Run.
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
  /** Set when the directory's filesystem refused link(): the lock was created by an exclusive write under the guard instead (the registry logs it once per take, that is once per registry; the house's read of the 33 commits, PR #22, comment 6307349700, item 10). */
  readonly noHardLinks?: true;
  /** Set when the lock is taken but its directory could not be synced (a real fsync error): a lock that vanishes after a crash is simply taken anew; the registry logs it once per take (comment 6274603516; item 10 of comment 6307349700). */
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
   * How far after `startMs` the process may have started: PROC_START_SLACK_MS plus the time between the
   * listing's two uptime reads for a /proc row whose uptime read, 1000 (whole seconds) for `ps`'s rows
   * and when absent (the house's read of the 38 commits, PR #22, comment 6274857431, item 3).
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

const readFile = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

let bootIdCache: { value: string | undefined } | undefined;

/**
 * The machine's boot id (Linux), read once per daemon from /proc/sys/kernel/random/boot_id, trimmed:
 * the lock, procStart and the machine's process listing all take it from here (a reviewer's read of
 * the fixes for #22 comment 6274857431). Undefined elsewhere or when unreadable.
 */
export function bootId(): string | undefined {
  if (bootIdCache) return bootIdCache.value;
  const id = process.platform === 'linux' ? readFile('/proc/sys/kernel/random/boot_id')?.trim() : undefined;
  bootIdCache = { value: id || undefined };
  return bootIdCache.value;
}

let machineBootCache: { value: string | undefined } | undefined;

/**
 * This boot, as the journal's reservation records it (G10): Linux's boot id, macOS's boot session UUID
 * (`sysctl kern.bootsessionuuid`). Read once per daemon; undefined elsewhere or when it cannot be read,
 * which the journal takes for possibly another boot. A spec replaces `boots.current`.
 */
export const boots = {
  current: (): string | undefined => {
    if (machineBootCache) return machineBootCache.value;
    let id: string | undefined;
    if (process.platform === 'linux') id = bootId();
    else if (process.platform === 'darwin') {
      try {
        id = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
      } catch {
        id = undefined;
      }
    }
    machineBootCache = { value: id };
    return id;
  },
};

/** What the lock, recovery and the backend read from one /proc/<pid>/stat line. */
export interface ProcStat {
  /** Field 3: R, S, D, … ; Z is exited and not yet reaped, which the lock and recovery count as gone (comment 6274603516). */
  state: string;
  /** Field 5: the process group. */
  pgrp: number;
  /** Field 8: the foreground process group of the process's terminal (-1 without one). */
  tpgid: number;
  /** Field 22: the start, in clock ticks after boot. */
  startTicks: number;
}

/**
 * One /proc/<pid>/stat line's fields. The comm (field 2) may hold spaces and parentheses, so the
 * fields are counted after the last ')' (the house's read of the 36 commits, #22, comment 6269992150,
 * item 4). The one parser of that line: the lock, procStart, the process listing and the backend's
 * foreground and reader checks all read through it, so none counts the fields its own way (a
 * reviewer's read of the fixes for #22 comments 6274603516 and 6274857431). Undefined when the line
 * does not parse.
 */
export function parseProcStat(stat: string): ProcStat | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  // state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime …
  const f = stat.slice(close + 2).split(' ');
  const state = f[0];
  const [pgrp, tpgid, startTicks] = [Number(f[2]), Number(f[5]), Number(f[19])];
  if (!state || !Number.isInteger(pgrp) || !Number.isInteger(tpgid) || !Number.isInteger(startTicks)) return undefined;
  return { state, pgrp, tpgid, startTicks };
}

/** `pid`'s /proc/<pid>/stat fields (Linux's /proc); undefined when it is gone, unreadable or does not parse. */
export function readProcStat(pid: number, read: (file: string) => string | undefined = readFile): ProcStat | undefined {
  const stat = pid > 0 ? read(`/proc/${pid}/stat`) : undefined;
  return stat === undefined ? undefined : parseProcStat(stat);
}

/**
 * A live pid's frame-free start on Linux — its start ticks and the boot id they count from — read
 * through the same parser the process listing and the lock use, so every side agrees on the unit.
 * The backend records it on a process Run's run.start when the group leader is known; recovery and
 * the lock compare it. Undefined off Linux, when the pid is gone, or when either part is unreadable.
 * `src` is the machine's unless a spec drives the Linux branch with its own (see ProcessSource).
 */
export function procStart(pid: number, src: ProcessSource = machine): { startTicks: number; bootId: string; zombie: boolean } | undefined {
  if (src.platform !== 'linux') return undefined;
  const id = src.bootId();
  const stat = id === undefined ? undefined : readProcStat(pid, src.read);
  return id === undefined || stat === undefined ? undefined : { startTicks: stat.startTicks, bootId: id, zombie: stat.state === 'Z' };
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
 * clock: the true start lies within this of the row's earliest (two ticks, and a margin for rounding),
 * plus the time between the listing's two uptime reads, which its rows add. The bounds recovery
 * compares it with are wall-clock records, so a clock step between a record and the recovery moves the
 * comparison by the step.
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
  /** The boot id the rows count their ticks from; the machine's is read once (bootId). */
  bootId(): string | undefined;
  /** This process's pid: a listing without it is no answer. */
  self: number;
}

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
  bootId,
  self: process.pid,
};

/**
 * Linux: /proc/<pid>/stat's start ticks after boot, with the boot id they count from, and a start time
 * placed against /proc/uptime (10 ms; /proc/stat's btime, whole seconds, when the uptime cannot be read).
 */
function procRows(src: ProcessSource): ProcessRow[] | undefined {
  if (src.platform !== 'linux') return undefined;
  const names = src.entries();
  // The uptime is read on both sides of the wall clock, so the uptime at the clock's read lies between
  // the two: the boot is placed by the later read, which puts every start at its earliest, and the time
  // between the reads widens the slack. Read once, after the clock, a stall between the clock and that
  // read moved the starts earlier than the slack covered, leaning towards reading a stranger's start as
  // before a Run's last event (a reviewer's read of the fixes for #22 comment 6274857431).
  const uptime = () => Number(/^(\d+(?:\.\d+)?)\s/.exec(src.read('/proc/uptime') ?? '')?.[1]);
  const upBefore = uptime();
  const now = src.now();
  const upAfter = uptime();
  const btime = Number(/^btime (\d+)$/m.exec(src.read('/proc/stat') ?? '')?.[1]);
  const placed = Number.isFinite(upBefore) && Number.isFinite(upAfter);
  if (!names || (!placed && !Number.isFinite(btime))) return undefined;
  const bootMs = placed ? now - upAfter * 1000 : btime * 1000;
  // Uptimes have two decimals: the difference rounds to whole milliseconds exactly.
  const slack = placed ? PROC_START_SLACK_MS + Math.max(0, Math.round((upAfter - upBefore) * 1000)) : 1000;
  const boot = src.bootId();
  const out: ProcessRow[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(Number(name), src.read);
    if (stat === undefined) continue; // gone meanwhile, or not a line this parser reads
    // The earliest the process can have started: its tick, less the uptime's own tick when placed by it.
    const startMs = placed ? Math.floor(bootMs + stat.startTicks * TICK_MS) - TICK_MS : Math.floor(btime + stat.startTicks * (TICK_MS / 1000)) * 1000;
    out.push({ pid: Number(name), pgid: stat.pgrp, startMs, startSlackMs: slack, startTicks: stat.startTicks, ...(boot !== undefined && { bootId: boot }), zombie: stat.state === 'Z' });
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

/**
 * One process: null when it is gone (or a zombie), undefined when nothing can say. A listing leaves
 * out a process whose line it could not read (EACCES, EMFILE, an LSM's denial) as well as one that is
 * gone, so a pid missing from it is gone only when a signal finds no such process either: a live
 * holder whose stat could not be read was taken over as gone (the house's read of the 33 commits,
 * PR #22, comment 6307349700, item 2).
 */
export function processInfo(pid: number, src: ProcessSource = machine): ProcessRow | null | undefined {
  const rows = listProcesses(src);
  if (rows === undefined) return undefined;
  const row = rows.find((r) => r.pid === pid);
  if (row) return row.zombie ? null : row;
  return exists(pid) ? undefined : null;
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
function commandNamesTermd(pid: number, src: ProcessSource): boolean | undefined {
  try {
    if (src.platform === 'linux') return src.read(`/proc/${pid}/cmdline`)?.includes('termd');
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
function holderLive(h: LockHolder, current: string, file: string, src: ProcessSource): 'live' | 'stale' | 'self' {
  // "Self" means this process wrote what the file holds now — what `taken` records, nonce and all. Any
  // other lock naming our pid is a predecessor's that this pid was reused from (a device without a
  // real-time clock booting into the same pid, a backward step): we did not write it, and no other
  // process has our pid, so it is stale — judging it by the pid and the wall clock alone took it as our
  // own and left two holders (the house's read of the 38 commits, PR #22, comment 6274603516).
  if (taken.get(file) === current) return 'self';
  if (h.pid === process.pid) return 'stale';
  if (!(h.pid > 0) || !exists(h.pid)) return 'stale';
  if (h.bootId !== undefined && src.platform === 'linux') {
    const boot = src.bootId();
    if (boot !== undefined && boot !== h.bootId) return 'stale'; // a different boot: the pid is a new process
    const now = procStart(h.pid, src);
    // kill(pid, 0) succeeds for a zombie and its stat still holds the start ticks: exited and unreaped is gone (comment 6274603516).
    if (now?.zombie) return 'stale';
    if (h.startTicks !== undefined && now !== undefined) return now.startTicks === h.startTicks ? 'live' : 'stale';
  }
  const info = processInfo(h.pid, src);
  if (info === null) return 'stale';
  // Unknown start time: assume the holder is who it says (refusing is recoverable; sharing journals is not).
  // A process that started after the lock was written cannot have written it — the pid was reused — unless
  // its command names termd, which a wall-clock step (not a reuse) can make look so: never take that over.
  // A check that cannot answer keeps the holder too, by the same rule (comment 6274603516).
  if (info === undefined || info.startMs <= h.startedAt + 1000) return 'live';
  return commandNamesTermd(h.pid, src) === false ? 'stale' : 'live';
}

/**
 * The refusal. Given the takeover guard (its path and what it holds), the advice is to remove the guard:
 * without it the next start takes over or creates the lock as usual, where a termd.lock removed instead
 * leaves the guard to keep out every later takeover, and every start on a filesystem without hard links.
 */
const lockedError = (dataDir: string, file: string, h: LockHolder | undefined, why: string, guard?: { path: string; entries: string[] }) =>
  err('data_dir_locked', `data dir ${dataDir} is in use by ${why}; one daemon per data dir (${guard ? `remove ${guard.path} only if no termd is starting` : `remove ${file} only if no termd is running`})`, {
    dataDir,
    lockFile: file,
    ...(h ? { pid: h.pid, hostname: h.hostname, startedAt: h.startedAt } : {}),
    ...(guard ? { guard: guard.path, guardEntries: guard.entries } : {}),
  });

/**
 * Write `raw` to `target`, created exclusively, owner-only and fsynced. For an attempt's temp, written
 * before it is linked or renamed into place, no reader ever sees it empty or torn; the guard's owner file
 * is written the same way, so after a crash it holds the whole record or reads as torn. The fallback without
 * hard links calls this on `termd.lock` itself, which a reader can see empty until the write lands: that
 * fallback writes under the guard, so a taker never compares it then (the house's read of the 33 commits,
 * PR #22, comment 6307349700, items 1 and 9).
 */
function writeSyncedTemp(target: string, raw: string): void {
  const data = Buffer.from(raw);
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(target, 0o600);
}

const rmTemp = (tmp: string) => {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best effort
  }
};

/** An attempt's temp beside the lock: `termd.lock.<pid>.<nonce>.tmp`, holding that attempt's whole record. */
const isAttemptTemp = (name: string) => name.startsWith(`${LOCK_FILE}.`) && /^\d+\.[0-9a-f]+\.tmp$/.test(name.slice(LOCK_FILE.length + 1));

/** Whether the process a record names is still its writer, by holderLive; verdicts are kept in `seen`, by record, for one acquire. */
function recordLive(h: LockHolder, raw: string, where: string, src: ProcessSource, seen: Map<string, boolean>): boolean {
  let live = seen.get(raw);
  if (live === undefined) seen.set(raw, (live = holderLive(h, raw, where, src) !== 'stale'));
  return live;
}

/**
 * Whether another live process has a lock attempt in flight here. Every attempt writes and syncs its
 * temp before it links, creates in place, or takes the guard, and the temp goes only when the attempt is
 * done: removed, or renamed into place as a taker's last act under the guard. So a process inside the
 * guard has one until it has nothing left to do there.
 */
function attemptInFlight(file: string, src: ProcessSource, seen: Map<string, boolean>): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(file));
  } catch {
    return true; // cannot look: assume one, which keeps the guard (refusing is recoverable)
  }
  for (const name of names) {
    if (!isAttemptTemp(name)) continue;
    const tmp = path.join(path.dirname(file), name);
    let raw: string | undefined;
    try {
      raw = readRaw(tmp);
    } catch {
      return true;
    }
    const h = raw === undefined ? undefined : parseHolder(raw);
    if (raw === undefined || !h || h.pid === process.pid) continue; // finished meanwhile, a write cut short, or ours
    if (recordLive(h, raw, tmp, src, seen)) return true;
  }
  return false;
}

/** An ownerless guard, or a guard entry without a whole record, is judged by its age past this, beside the attempt scan. */
const GUARD_STALE_MS = 5000;

/** The lock's takeover guard, a directory beside it. */
const guardPath = (file: string) => `${file}.takeover`;

/** A guard's owner file: `<pid>.<nonce>`, the attempt's own pid and nonce, holding the attempt's record. */
interface GuardOwner {
  name: string;
  raw: string;
}
const isOwnerName = (name: string) => /^\d+\.[0-9a-f]+$/.test(name);

const olderThan = (p: string, ms: number) => {
  try {
    return Date.now() - fs.statSync(p).mtimeMs > ms;
  } catch {
    return false; // gone meanwhile
  }
};

/** Remove a guard only while it is empty: rmdir refuses one holding any file, so a guard with an owner in it is never removed. */
function rmdirIfEmpty(guard: string): void {
  try {
    fs.rmdirSync(guard);
  } catch {
    // an owner is in it, or it is gone meanwhile
  }
}

/** Leave the guard: this attempt's owner file by its own name, then the guard if that left it empty. */
function leaveGuard(guard: string, mine: string): void {
  try {
    fs.unlinkSync(mine);
  } catch {
    // gone already
  }
  rmdirIfEmpty(guard);
}

/**
 * Write this attempt's owner file into the guard it just made, and say whether it is inside: only when
 * its file is the one owner there. A guard removed while still empty, between this start's mkdir and its
 * owner file, leaves the file nowhere (ENOENT) or in a later start's guard. Each start looks only once its
 * own file is in, so of two that share a guard the one that looks second sees the other and backs off
 * (both do, when both look after both files are in), removing its own file and nothing else.
 */
function placeOwner(guard: string, mine: string, raw: string): boolean {
  try {
    writeSyncedTemp(mine, raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; // no guard to be in, and nothing of ours to remove
    leaveGuard(guard, mine);
    throw e;
  }
  let alone = false;
  try {
    alone = fs.readdirSync(guard).every((n) => n === path.basename(mine) || !isOwnerName(n));
  } catch {
    // cannot look: not inside
  }
  if (!alone) leaveGuard(guard, mine);
  return alone;
}

/**
 * Whether a guard entry's owner is gone. An owner file is judged by its record, as the lock's holder is,
 * whatever its age: a holder stopped inside keeps its guard however long the stop (the house's review of
 * the 40 commits through f3750e4, PR #22, comment 6310921374, question 3). An entry without a whole record
 * (an owner between its create and its write, one a crash tore, a stray file) is judged as an ownerless
 * guard is: a live owner still writing has its attempt in flight.
 */
function entryGone(entry: string, file: string, src: ProcessSource, seen: Map<string, boolean>): boolean {
  let raw: string | undefined;
  try {
    raw = readRaw(entry);
  } catch {
    return false; // cannot read it: kept (refusing is recoverable)
  }
  if (raw === undefined) return false; // removed meanwhile, by its owner or another breaker
  const h = isOwnerName(path.basename(entry)) ? parseHolder(raw) : undefined;
  if (!h) return olderThan(entry, GUARD_STALE_MS) && !attemptInFlight(file, src, seen);
  return !recordLive(h, raw, entry, src, seen);
}

/**
 * A guard another start holds: remove it only when every owner in it is gone, each owner's file by its
 * own name, then the guard by rmdir. Removing whatever stood at the guard's path, a breaker whose check
 * straddled another breaker's removal and a third start's mkdir deleted that start's fresh guard, and a
 * holder stopped past the guard's age lost it while still inside: two starts inside at once (comment
 * 6310921374, question 3). Now a breaker that judged an owner gone removes that owner's file or nothing,
 * and goes on to the guard only when it emptied it itself. A guard with no owner file (a start between its
 * mkdir and its owner file, a crash there, or an earlier build's) is broken as every guard was before: when
 * it is old and no live process other than this one has an attempt in flight (comment 6307349700, item 1).
 */
function breakGuard(file: string, guard: string, src: ProcessSource, seen: Map<string, boolean>): void {
  let names: string[];
  try {
    names = fs.readdirSync(guard);
  } catch {
    return; // gone meanwhile, or cannot look
  }
  if (!names.length) {
    if (olderThan(guard, GUARD_STALE_MS) && !attemptInFlight(file, src, seen)) rmdirIfEmpty(guard);
    return;
  }
  const entries = names.map((n) => path.join(guard, n));
  if (!entries.every((e) => entryGone(e, file, src, seen))) return;
  for (const e of entries) {
    try {
      fs.unlinkSync(e);
    } catch {
      return; // another breaker removed it: what stands at the guard's path now is not what was judged
    }
  }
  rmdirIfEmpty(guard);
}

/**
 * Run `fn` holding the lock's guard (an exclusive mkdir beside it, with the attempt's owner file in it);
 * undefined when another start holds it. The takers' compare-and-rename and the fallback's create-in-place
 * run under it, so neither ever meets the other halfway. Each start is inside only while its own owner
 * file is the guard's one owner; a guard holding an owner is never removed, and an owner's file is
 * removed only by that owner or by a breaker that judged that owner gone, so two starts are never inside
 * at once. A guard a crashed start left goes as soon as a start finds its owner gone.
 */
function underGuard<T>(file: string, owner: GuardOwner, src: ProcessSource, seen: Map<string, boolean>, fn: () => T): T | undefined {
  const guard = guardPath(file);
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    breakGuard(file, guard, src, seen);
    return undefined;
  }
  const mine = path.join(guard, owner.name);
  if (!placeOwner(guard, mine, owner.raw)) return undefined;
  try {
    return fn();
  } finally {
    leaveGuard(guard, mine);
  }
}

/**
 * Replace a stale lock, atomically: under the guard, confirm the file still holds what was judged stale,
 * then rename `tmp` — already written and synced before the guard was taken — over it, so only the
 * compare and the rename run inside the guard, never a slow write (the house's read of the 36 commits,
 * #22, comment 6269992150). Returns false when the guard is held or the file changed meanwhile (the
 * caller starts over and judges again); `tmp` is then left for the caller to remove.
 */
function takeOver(file: string, staleRaw: string, tmp: string, owner: GuardOwner, src: ProcessSource, seen: Map<string, boolean>): boolean {
  return (
    underGuard(file, owner, src, seen, () => {
      if (readRaw(file) !== staleRaw) return false;
      fs.renameSync(tmp, file);
      return true; // the caller syncs the directory once the take is registered, so a sync error never orphans a held lock
    }) ?? false
  );
}

/**
 * Take `<dataDir>/termd.lock` or throw `data_dir_locked` naming the live holder. The complete lock is
 * written and synced to a temp file first, then `link()`ed to `termd.lock` (EEXIST means taken, as `wx`
 * did), so on that path no starter ever reads an empty or half-written lock (comment 6269992150). On a
 * filesystem without hard links the fallback creates `termd.lock` in place with an exclusive write, which
 * a starter can read empty until the write lands: the fallback creates, writes and reads it back under
 * the guard the takers compare under, so no taker judges it then (the house's read of the 33 commits,
 * PR #22, comment 6307349700, item 1), and the take counts only if the file then holds this attempt's
 * own record (comment 6274603516). A lock left by a dead process (or by a pid reused since) is taken
 * over. Within one process the lock is shared: its taker releases it. `processes`: where the holder's
 * process facts are read (specs drive the Linux branch through it; the machine's by default).
 */
export function acquireDataDirLock(dataDir: string, opts: { link?: (existing: string, newPath: string) => void; processes?: ProcessSource } = {}): DataDirLock {
  const src = opts.processes ?? machine;
  /** Verdicts on other attempts' temps, for this acquire (see attemptInFlight). */
  const seen = new Map<string, boolean>();
  const dir = path.resolve(dataDir);
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const link = opts.link ?? ((existing: string, newPath: string) => fs.linkSync(existing, newPath));
  // The directory's filesystem has no hard links (exFAT, some SMB and FUSE mounts): link() refuses with
  // one of these, where the exclusive write worked. The lock then falls back to that write of the same
  // synced content, under the guard, and the registry says so once per take (a reviewer's read of the
  // fixes for #22 comment 6269992150).
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
  const self = procStart(process.pid, src);
  for (let attempt = 0; attempt < 50; attempt++) {
    const me: LockHolder = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname(), nonce: randomBytes(8).toString('hex'), ...(self && { startTicks: self.startTicks, bootId: self.bootId }) };
    const raw = JSON.stringify(me) + '\n';
    const tmp = `${file}.${process.pid}.${me.nonce}.tmp`;
    // The guard's owner file for this attempt: the same pid, nonce and record as its temp.
    const owner: GuardOwner = { name: `${process.pid}.${me.nonce}`, raw };
    try {
      writeSyncedTemp(tmp, raw);
    } catch (e) {
      rmTemp(tmp);
      throw e;
    }
    // Registered before the directory sync; a sync error is reported on the handle (the registry logs it once per take),
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
        let made: boolean | undefined;
        try {
          // An exclusive ('wx') create of the same content, fsynced, under the guard: a taker compares
          // only while holding it, so none reads this file empty mid-write and renames over it later.
          // The read-back still decides: the take is this attempt's only if the file holds its record.
          made = underGuard(file, owner, src, seen, () => {
            try {
              writeSyncedTemp(file, raw);
            } catch (e2) {
              if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
            }
            return readRaw(file) === raw;
          });
        } catch (e2) {
          rmTemp(tmp);
          throw e2;
        }
        if (made === undefined) {
          rmTemp(tmp);
          sleepSync(10);
          continue; // another start holds the guard: try again
        }
        created = made;
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
      // Empty or torn: a fallback start that crashed between its create and its write, or an older build
      // there (link() leaves no such window, and the fallback writes under the guard the takeover below
      // needs). Take it over only when it is old.
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
      const state = holderLive(holder, current, file, src);
      if (state === 'self') {
        rmTemp(tmp);
        return { file, release: () => undefined }; // another registry in this process took it; its taker releases it
      }
      if (state === 'live') {
        rmTemp(tmp);
        throw lockedError(dataDir, file, holder, `termd pid ${holder.pid}${holder.hostname !== os.hostname() ? ` (written on host ${holder.hostname})` : ''}`);
      }
    }
    let took: boolean;
    try {
      took = takeOver(file, current, tmp, owner, src, seen);
    } catch (e) {
      // The guard's mkdir, this attempt's owner file, or the compare or rename inside refused: the temp goes
      // with the error, as on the fallback's.
      rmTemp(tmp);
      throw e;
    }
    if (took) return publish(holder ?? {});
    rmTemp(tmp);
    sleepSync(10);
  }
  // The attempts ran out: on a guard they kept (a live owner, an entry they cannot read, one still being
  // written), on a torn lock still young, or on a lock that kept changing under them. A guard still there
  // is named, with what it holds, since it can be what kept them out and termd.lock's record says nothing of it.
  const guard = guardPath(file);
  let entries: string[] | undefined;
  try {
    entries = fs.readdirSync(guard);
  } catch {
    // no guard (or none this start can list): the lock's record is all there is to name
  }
  const held = entries === undefined ? '' : `, behind its takeover guard ${guard}, ${entries.length ? `held by ${entries.map((n) => (isOwnerName(n) ? `pid ${n.slice(0, n.indexOf('.'))}` : `an entry named ${n}`)).join(', ')}` : 'with no owner in it yet'}`;
  throw lockedError(dataDir, file, parseHolder(readRaw(file) ?? ''), `another termd starting at the same time${held}`, entries && { path: guard, entries });
}
