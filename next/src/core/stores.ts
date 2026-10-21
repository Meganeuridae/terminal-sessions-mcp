/**
 * Journal stores (§6). Two implementations behind one interface: a byte-bounded
 * memory ring for the hot path, and an append-only JSONL file with rotation that
 * makes history survive a daemon restart (G19b, G20). Retention is explicit —
 * bytes and age — and the oldest retained seq is exact (G21).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clocks } from './clock.js';
import type { RotationHeader } from './runindex.js';
import type { JournalEvent, Seq } from './types.js';

/** Retention bounds (G21). Absent means unbounded on that axis. */
export interface Retention {
  maxBytes?: number;
  maxAgeMs?: number;
}

export interface JournalStore {
  readonly kind: string;
  append(event: JournalEvent): void;
  /** Events with `from <= seq <= to`, ascending, at most `limit`. Missing bounds mean open. */
  read(from?: Seq, to?: Seq, limit?: number): JournalEvent[];
  /** Oldest retained seq, or undefined when empty. */
  oldestSeq(): Seq | undefined;
  lastSeq(): Seq | undefined;
  close(): void;
  /** The last `n` retained events with `seq <= to`, ascending. The journal falls back to `read` without it. */
  tail?(n: number, to?: Seq): JournalEvent[];
  /** Retained bytes (approximate for the memory ring). */
  bytes?(): number;
  retention?(): Retention;
  /**
   * Stream every retained event whose serialized line contains one of the `needles`, oldest
   * first, without holding the journal in memory; rotation headers go to `onHeader`.
   */
  scan?(needles: string | string[], visit: (ev: JournalEvent) => void, onHeader?: (h: RotationHeader) => void): void;
  /** What to write at the head of each file this store rotates into, within the byte budget the provider is given. */
  setRotationHeader?(provider: ((maxBytes?: number) => RotationHeader | undefined) | undefined): void;
  /** True once if opening the store cut a torn final event (a crash mid-write); see Journal. */
  takeTornTail?(): boolean;
  /** Apply age retention now rather than at the next append: an idle session's content ages out too (G21). */
  expire?(now?: number): void;
  /** The journal's incarnation, persisted with the store: the same across lives and restarts, new after a forget (see Journal.epoch). */
  epoch?(): string;
  /** What the store keeps beside its files for the numbering (G10); undefined when it keeps nothing. */
  highWater?(): HighWater | undefined;
  /**
   * Sync to disk every file holding a seq this store has not synced since it opened: all of them at its first call,
   * since an earlier life on this boot may have left its appends unsynced, and after that the files appended to
   * since the last call, then the directory that holds them, so their entries are durable too. False when the disk
   * refused, which is said once. Appends are not synced otherwise: a journal syncs them only before it clears a
   * failed reservation, whose holes the gaps it and the lives before it appended record (Journal.writeReservation).
   */
  syncAppends?(): boolean;
  /**
   * Change the parts given, keeping the others. False when the disk refused the write, or when a raise is
   * written but could not be confirmed (its directory could not be synced): the caller retries.
   */
  setHighWater?(change: HighWater): boolean;
}

/**
 * The numbering a journal's store keeps beside its files, so that no seq is ever issued twice (G10), even
 * when the files no longer hold it.
 */
export interface HighWater {
  /** Numbering resumes above this, with nothing missing below it: retention dropped the files that held it. */
  floor?: Seq;
  /**
   * The journal's reservation: no seq above `to` was issued, unless a write of a higher one was refused, when
   * the journal issues on meanwhile (best effort: Journal.keepMark says what that exposes).
   */
  reservation?: Reservation;
}

/**
 * A journal keeps its reservation written and synced a block ahead of the seqs it issues, while its
 * appends are not synced as they are written (only before a failed mark is cleared), and lowers it to
 * its last seq when it seals. A write of it the disk refuses is tried again at most once a second, and
 * the journal issues on meanwhile, past it if need be (best effort, Journal.keepMark). After a power
 * loss the files may have lost their unsynced tail, but not the reservation, so the next journal
 * numbers above every seq issued before it and records the seqs between the files' last and `to` as a
 * `torn-write` gap (the house's read of the 33 commits, PR #22, comment 6307349700, its question of
 * intent).
 */
export interface Reservation {
  to: Seq;
  /** The disk refused the events between the files' last seq and `to`: a `store-failed` gap on any boot. */
  failed?: true;
  /**
   * With `failed`: the lowest seq a hole the refusal left inside the files can start at (the first seq they
   * lacked, or a stretch or a refused gap below it). A start after a stop while the disk refused looks for jumps
   * in the files from here, not through every file (a reviewer's read of the fixes for the review of f3750e4, PR #22: about 3 s
   * a GB, for every session a full disk marked at once). A failed reservation an earlier build wrote has none.
   */
  failedFrom?: Seq;
  /**
   * The boot it was written under (Linux's boot id, macOS's boot session). On another boot, or with none
   * known, it is honoured. On the same boot an unclean stop lost nothing the page cache held, so it is
   * honoured only while the store accounts for less than the seq its block was reserved above: the one
   * block a start reserves above a hole it opened, before that hole's gap is in the file
   * (reservationHonoured).
   */
  boot?: string;
}

/** The line the file store writes for a record (an event, a rotation header): its JSON and a newline. */
const lineOf = (record: object): string => JSON.stringify(record) + '\n';

/**
 * The stored size of a record, UTF-8 bytes of its line: the one count for what a retention budget
 * holds and what a page of events weighs, wherever it is estimated (the reader's events pages, a
 * note's share of retention, the run index's header bound).
 */
export const lineBytes = (record: object): number => Buffer.byteLength(lineOf(record));

/**
 * Approximate serialized size: every string, number and nested value counts, so
 * an `env.snapshot` or a long `run.admit` line weighs what it holds (jr-21).
 */
export function approxBytes(v: unknown): number {
  switch (typeof v) {
    case 'string':
      return v.length + 2;
    case 'number':
      return 8;
    case 'boolean':
      return 5;
    case 'object': {
      if (v === null) return 4;
      let n = 2;
      if (Array.isArray(v)) {
        for (const x of v) n += approxBytes(x) + 1;
        return n;
      }
      for (const k in v) n += k.length + 4 + approxBytes((v as Record<string, unknown>)[k]);
      return n;
    }
    default:
      return 0;
  }
}

export interface MemoryStoreOptions {
  /** Drop events older than this (G21); checked as events arrive and by `expire()`. */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Write `text` through a temp file beside `file`, synced to disk, then renamed over it, with the
 * directory synced too: after a crash of the process or the machine the file is the old one or the
 * new one, never torn or missing (the house's read of 2c35df8, #22). Owner-only (G26). The session
 * records, the cursors and the store's own metadata are written this way. The lock is not: it is
 * written to a synced temp and linked into place, or without hard links created in place under its
 * guard (lock.ts), and shares only the directory sync below.
 */
export function writeDurably(file: string, text: string): DurableWrite {
  const tmp = `${file}.${process.pid}.tmp`;
  const data = Buffer.from(text);
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    // A failed write leaves no stray beside the file; the cleanup is guarded so its own error (EIO,
    // EACCES) never replaces the write's, which is what the caller must see (the house's read of the
    // 36 commits, #22, comment 6269992150).
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // the original error below is what matters
    }
    throw e;
  }
  const error = syncDir(file);
  return error ? { synced: false, error } : { synced: true };
}

/**
 * What writeDurably reports once the file holds the new content: whether the directory was synced too.
 * "Not written" is an exception; "written, directory not synced" (a real fsync error such as EIO after
 * the rename) is this result, so a caller can tell the two apart — a reservation it must retry, an
 * advisory write it should not rewrite forever (the house's read of the 38 commits, PR #22, comment
 * 6274603516).
 */
export interface DurableWrite {
  synced: boolean;
  /** The directory fsync's error, when `synced` is false. */
  error?: NodeJS.ErrnoException;
}

/**
 * fsync the directory holding `file`, so a rename or create survives a crash, and say when it could
 * not: a real I/O error (EIO) is returned to the caller, who decides what a change that may not survive
 * a crash means for it (comment 6274603516). A filesystem that cannot sync a directory (cannotSyncDir)
 * is not an error: the rename is still atomic. The one rule for the stores and the lock (a reviewer's
 * read of the fixes for #22 comment 6269992150).
 */
export function syncDir(file: string): NodeJS.ErrnoException | undefined {
  let dir: number | undefined;
  try {
    dir = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dir);
    return undefined;
  } catch (e) {
    return cannotSyncDir((e as NodeJS.ErrnoException).code) ? undefined : (e as NodeJS.ErrnoException);
  } finally {
    if (dir !== undefined) fs.closeSync(dir);
  }
}

/**
 * Make `dir`, and any parent it lacks, with `mode`; the directories this made, outermost first. A new
 * directory's entry in its parent is not durable until that parent is synced (syncMadeDirs): until then a
 * power loss can take the directory with whatever its files had synced.
 */
export function makeDirs(dir: string, mode: number): string[] {
  const made = fs.mkdirSync(dir, { recursive: true, mode });
  const dirs: string[] = [];
  if (made === undefined) return dirs;
  const top = path.resolve(made);
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (d === top || path.dirname(d) === d) break;
  }
  return dirs;
}

/** Sync each of `dirs` (makeDirs) into its parent, outermost first, taking each from `dirs` once it is: undefined once all are, else the first error, the rest left for the next try. */
export function syncMadeDirs(dirs: string[]): NodeJS.ErrnoException | undefined {
  while (dirs.length > 0) {
    const error = syncDir(dirs[0]!);
    if (error) return error;
    dirs.shift();
  }
  return undefined;
}

/** Error codes that mean the filesystem cannot fsync a directory, as opposed to a real I/O failure (EIO) that must propagate. */
export function cannotSyncDir(code: string | undefined): boolean {
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EPERM' || code === 'EISDIR';
}

/**
 * The hot ring. Bounded by approximate bytes over every event; eviction moves a
 * head index and compacts occasionally, so appends are O(1) amortized.
 */
export class MemoryStore implements JournalStore {
  readonly kind = 'memory';
  private events: Array<JournalEvent | undefined> = [];
  private sizes: number[] = [];
  private head = 0;
  private used = 0;
  private readonly maxAgeMs: number | undefined;
  private readonly now: () => number;

  constructor(
    private readonly maxBytes: number = 8 * 1024 * 1024,
    opts: MemoryStoreOptions = {},
  ) {
    this.maxAgeMs = opts.maxAgeMs;
    this.now = opts.now ?? Date.now;
  }

  private get count(): number {
    return this.events.length - this.head;
  }

  private at(i: number): JournalEvent {
    return this.events[this.head + i]!;
  }

  append(event: JournalEvent): void {
    const size = approxBytes(event);
    this.events.push(event);
    this.sizes.push(size);
    this.used += size;
    while (this.used > this.maxBytes && this.count > 1) this.dropHead();
    if (this.maxAgeMs !== undefined) {
      const cutoff = this.now() - this.maxAgeMs;
      while (this.count > 1 && this.at(0).ts < cutoff) this.dropHead();
    }
    if (this.head >= 1024 && this.head * 2 >= this.events.length) {
      this.events = this.events.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
  }

  private dropHead(): void {
    this.used -= this.sizes[this.head]!;
    this.events[this.head] = undefined; // release it now, not at the next compaction
    this.head++;
  }

  /** Age out what is past `maxAgeMs` without an append (jr2-7): an idle ring releases old events too (G21, G26). */
  expire(now = this.now()): void {
    if (this.maxAgeMs === undefined) return;
    const cutoff = now - this.maxAgeMs;
    while (this.count > 0 && this.at(0).ts < cutoff) this.dropHead();
    if (this.count === 0) this.close();
  }

  /** Index of the first retained event with seq >= lo. */
  private lowerBound(lo: Seq): number {
    let i = this.head;
    let j = this.events.length;
    while (i < j) {
      const mid = (i + j) >> 1;
      if (this.events[mid]!.seq < lo) i = mid + 1;
      else j = mid;
    }
    return i;
  }

  read(from?: Seq, to?: Seq, limit = Number.POSITIVE_INFINITY): JournalEvent[] {
    const hi = to ?? Number.POSITIVE_INFINITY;
    const out: JournalEvent[] = [];
    for (let i = this.lowerBound(from ?? Number.NEGATIVE_INFINITY); i < this.events.length && out.length < limit; i++) {
      const ev = this.events[i]!;
      if (ev.seq > hi) break;
      out.push(ev);
    }
    return out;
  }

  tail(n: number, to?: Seq): JournalEvent[] {
    const end = to === undefined ? this.events.length : this.lowerBound(to + 1);
    return (this.events.slice(Math.max(this.head, end - Math.max(0, n)), end) as JournalEvent[]);
  }

  oldestSeq(): Seq | undefined {
    return this.count ? this.at(0).seq : undefined;
  }

  lastSeq(): Seq | undefined {
    return this.count ? this.events[this.events.length - 1]!.seq : undefined;
  }

  bytes(): number {
    return this.used;
  }

  retention(): Retention {
    const r: Retention = { maxBytes: this.maxBytes };
    if (this.maxAgeMs !== undefined) r.maxAgeMs = this.maxAgeMs;
    return r;
  }

  close(): void {
    this.events = [];
    this.sizes = [];
    this.head = 0;
    this.used = 0;
  }
}

/**
 * A floor on the free space of the filesystem a store writes to (the daemon's --disk-floor-bytes;
 * the house's review of #11, shell tools 4): a retention cap bounds one session, the floor bounds
 * the machine. A refused append is a store error to the journal, which keeps the ring, retries,
 * and records as a gap what the ring dropped meanwhile.
 */
export interface DiskFloor {
  /** May `bytes` more be written under `dir`? False refuses the append. */
  allow(dir: string, bytes: number): boolean;
}

/**
 * Free space by statfs, asked at most once a second per directory or after a megabyte written
 * since the last answer: a flood of appends costs one syscall a second. A filesystem that cannot
 * be asked is not a full one: the write itself decides then. The second is measured on the
 * monotonic clock: on the wall clock a step back kept a refusal cached long after space returned,
 * an hour's step for 59 minutes (the house's read of the 33 commits, PR #22, comment 6307349700,
 * item 5). An injected clock that goes back asks again rather than trusting the answer.
 */
export class FreeSpaceFloor implements DiskFloor {
  private readonly seen = new Map<string, { at: number; written: number; ok: boolean }>();
  constructor(
    readonly floorBytes: number,
    private readonly statfs: (dir: string) => { bavail: number | bigint; bsize: number | bigint } = (d) => fs.statfsSync(d),
    private readonly now: () => number = () => clocks.monotonic(),
  ) {}

  allow(dir: string, bytes: number): boolean {
    const t = this.now();
    const s = this.seen.get(dir);
    if (s && t >= s.at && t - s.at < 1000 && s.written + bytes < 1024 * 1024) {
      s.written += bytes;
      return s.ok;
    }
    let ok = true;
    try {
      const st = this.statfs(dir);
      ok = Number(st.bavail) * Number(st.bsize) - bytes >= this.floorBytes;
    } catch {
      ok = true;
    }
    this.seen.set(dir, { at: t, written: bytes, ok });
    return ok;
  }
}

export interface FileStoreOptions {
  /** Rotate the active file past this many bytes. Default: a quarter of `maxBytes`, between 4 KiB and 16 MiB. */
  maxFileBytes?: number;
  /** Refuse appends while the filesystem's free space is below the floor (see DiskFloor). */
  floor?: DiskFloor;
  /** Retained bytes on disk, active file included (G21). Default: no limit. */
  maxBytes?: number;
  /**
   * Where the store says that its metadata could not be written, or is written but its directory could
   * not be synced: each once per store, and a store is one session's (the house's read of the 33
   * commits, PR #22, comment 6307349700, item 10). At 'info', once a refused epoch is written after all.
   */
  log?: ((level: 'warn' | 'info', text: string) => void) | undefined;
  /**
   * Rotated files whose newest event is older than this are dropped (G21). Default: no limit.
   * Age applies per file: the active file is rotated once its oldest event is past the
   * cutoff (at the next append, or at `expire()`), and a file straddling the cutoff stays
   * whole until its newest event ages out. Content therefore outlives `maxAgeMs` by at
   * most one file's span.
   */
  maxAgeMs?: number;
  now?: () => number;
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MIN_FILE_BYTES = 4 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const CHUNK = 1024 * 1024;
const BACK_CHUNK = 64 * 1024;
/** Below this a file is scanned from its start rather than bisected. */
const BISECT_MIN = 256 * 1024;
const ACTIVE = 'journal.jsonl';
const ROTATED = /^journal\.(\d+)\.jsonl$/;
const HEADER_PREFIX = '{"header":';
/** The journal's own facts beside its files: its epoch and, when needed, a high-water seq. */
const META = 'journal.meta.json';

/** One journal file, indexed by its first and last event (jr-14). `n` is the rotation number; 0 is the active file. */
interface Segment {
  file: string;
  n: number;
  bytes: number;
  first?: Seq;
  firstTs?: number;
  last?: Seq;
  lastTs?: number;
}

/**
 * `journal.meta.json`. `highWater` is the floor (HighWater.floor); `reserved`, `failed`, `failedFrom` and `boot`
 * are the reservation. A file an earlier build wrote with `failed` and no `reserved` held a failing reservation in
 * `highWater`, and is read so.
 */
interface StoreMeta {
  v: 1;
  epoch: string;
  highWater?: Seq;
  reserved?: Seq;
  failed?: true;
  failedFrom?: Seq;
  boot?: string;
}

export const newEpoch = (): string => randomBytes(8).toString('hex');

/**
 * The value of `"key":<digits>` nearest the end of a line. The journal writes
 * `seq` and `ts` last, and a quote inside any string value is escaped, so the
 * last unescaped occurrence is the event's own field. Undefined if absent.
 */
function numberAt(line: string, key: string): number | undefined {
  const i = line.lastIndexOf(key);
  if (i === -1) return undefined;
  let j = i + key.length;
  let n = 0;
  const start = j;
  for (; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    n = n * 10 + (c - 48);
  }
  if (j === start) return undefined;
  const next = line.charCodeAt(j);
  return next === 44 || next === 125 ? n : undefined; // ',' or '}'
}

const seqOf = (line: string) => numberAt(line, '"seq":');
const tsOf = (line: string) => numberAt(line, '"ts":');

function parseEvent(line: string): JournalEvent | undefined {
  try {
    const ev = JSON.parse(line) as JournalEvent;
    return typeof ev?.seq === 'number' ? ev : undefined;
  } catch {
    return undefined; // a torn line (a crash, a failed write) or a foreign one
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Append-only JSONL under `dir/journal.jsonl`, rotated to `journal.<n>.jsonl`.
 * An in-memory index of each file's first and last seq lets a range read open
 * only the files that overlap it, bisect within the first by byte offset, and
 * stop at its end; a tail read walks the newest file backwards. Opening a store
 * given no retention reads only the head and tail of each file, and changes no
 * content: a torn tail is cut, and a new epoch written, by the store's first write,
 * so an open the caller refuses after looking at the store leaves it as it was (an
 * independent read of the fix for the house's read of the 33 commits, PR #22,
 * comment 6307349700). It does make an older build's files owner-only (G26), and
 * drops a rotated file that holds nothing. Given retention (`maxBytes`,
 * `maxAgeMs`), the open applies it at once and prunes what is past it, so a caller
 * that may refuse the store opens it with none and sets it afterwards
 * (setRetention), as the registry does.
 */
export class FileStore implements JournalStore {
  readonly kind = 'file';
  private readonly active: string;
  private fd: number | null = null;
  /** The newest seq this store had appended when it last synced its appends (syncAppends); 0 until it first does. */
  private syncedThrough = 0;
  private segments: Segment[] = [];
  private nextN = 1;
  private readonly fixedFileBytes: number | undefined;
  private maxFileBytes = MAX_FILE_BYTES;
  // Nothing is deleted unless a limit was asked for (G21): an absent limit is no limit.
  private maxBytes = Infinity;
  private maxAgeMs = Infinity;
  private readonly now: () => number;
  private header: ((maxBytes?: number) => RotationHeader | undefined) | undefined;
  /** A failed write may have left a partial line; cut it before the next write. */
  private dirty = false;
  private tornEvent = false;
  private meta: StoreMeta;
  /**
   * What `journal.meta.json` holds, as far as this store knows: what it read at open or last wrote there,
   * its directory synced or not; undefined while no write of it has landed. A raise the file holds but
   * memory does not (its directory fsync failed) differs from `meta` until a write settles it: a write
   * compared with memory alone found nothing to do and left that raise on disk, a false lost range
   * after the next restart (the house's read of the 33 commits, PR #22, comment 6307349700, item 3).
   */
  private onDisk: StoreMeta | undefined;
  /**
   * The epoch is not on disk yet. A new one is written by the store's first write, an append or a
   * metadata write, never by the open. A refused write is retried as appends land, at most once
   * a second on the monotonic clock (`metaRetryAt`), and said once. Retried after every append, 200
   * appends made 201 attempts and said nothing (the house's read of the 33 commits, PR #22, comment
   * 6307349700, item 6). Only a refused write: one the file holds while its directory could not be
   * synced counts as written, since a crash that loses it only gives the journal a new epoch at the
   * next open, which is what an absent file does anyway. Kept pending, it was rewritten (a rename and a
   * directory fsync) on every append while the fsync kept failing (a reviewer's read of the fixes for
   * #22 comment 6274603516).
   */
  private metaPending = false;
  private metaRetryAt = 0;
  /** Said once per store: the epoch's write refused, and a metadata write the file holds whose directory could not be synced. */
  private refusedWarned = false;
  private syncWarned = false;
  /** Said once per store too: a refused sync of its files before a clear (appendSyncRefused). */
  private appendSyncWarned = false;
  /**
   * Directories whose entries are not yet synced into their parents, outermost first: those this open created,
   * the store's own and any parent made on the way, or else the store's own, which an earlier open may have made
   * and died before syncing (nothing on disk says which). A metadata write counts as written only once they are:
   * the file's own sync and its directory's left a new session's directory entry unsynced, so a power loss soon
   * after could take the session with the reservation it had synced; and an open that took its directory as old
   * never synced it (the house's review of 4f4c067..a8b6f28, PR #22). One directory sync a life, at its first
   * metadata write: a store that writes none (a closed session a restart seals unchanged) syncs nothing.
   */
  private readonly newDirs: string[];
  private readonly log: FileStoreOptions['log'];
  /** A rotation header the disk refused: written before the new file's first event (the house's read of b047b92, point 4). */
  private headerPending: Buffer | undefined;
  /** Bytes read from disk by reads and scans (observability; the tests bound it). */
  bytesRead = 0;
  private readonly floor: DiskFloor | undefined;

  constructor(
    private readonly dir: string,
    opts: FileStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.fixedFileBytes = opts.maxFileBytes;
    this.floor = opts.floor;
    this.log = opts.log;
    // The journal holds whatever programs printed: private to the daemon's user (G26).
    const made = makeDirs(dir, DIR_MODE);
    this.newDirs = made.length ? made : [path.resolve(dir)];
    try {
      fs.chmodSync(dir, DIR_MODE);
    } catch {
      // not ours to fix
    }
    this.active = path.join(dir, ACTIVE);
    this.meta = this.loadMeta();
    this.load();
    this.setRetention(opts);
  }

  syncAppends(): boolean {
    for (const s of this.segments) {
      if (s.last === undefined || s.last <= this.syncedThrough) continue;
      try {
        if (s.n === 0 && this.fd !== null) fs.fsyncSync(this.fd);
        else {
          const fd = fs.openSync(s.file, 'r');
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // a file retention took holds nothing to sync
        this.appendSyncRefused(e as NodeJS.ErrnoException);
        return false;
      }
    }
    // The files' entries too: a rotation renames the active file, and the next write makes a new one, with no
    // directory sync, so without this the clear's metadata write could reach the disk before them.
    const dirError = syncDir(this.active);
    if (dirError) {
      this.appendSyncRefused(dirError);
      return false;
    }
    this.syncedThrough = this.lastSeq() ?? this.syncedThrough;
    return true;
  }

  /** A refused sync of the files, said once per store: appends are synced nowhere else, so nothing else would say the disk refuses it. */
  private appendSyncRefused(e: NodeJS.ErrnoException): void {
    if (this.appendSyncWarned) return;
    this.appendSyncWarned = true;
    this.log?.('warn', `the journal's files could not be synced before its failed mark is cleared: ${e.message}; the mark stays, and its clear is tried again, until they are`);
  }

  // ───────────── epoch and high water (G10, mcpl-4, jr2-6) ─────────────

  private loadMeta(): StoreMeta {
    const file = path.join(this.dir, META);
    try {
      fs.chmodSync(file, FILE_MODE);
      const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreMeta>;
      if (typeof m.epoch === 'string' && /^[0-9a-f]{8,64}$/.test(m.epoch)) {
        const seq = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
        const out: StoreMeta = { v: 1, epoch: m.epoch };
        const floor = seq(m.highWater);
        let reserved = seq(m.reserved);
        if (reserved === undefined && m.failed === true) reserved = floor; // an earlier build's failing reservation
        else if (floor !== undefined) out.highWater = floor;
        if (reserved !== undefined) {
          out.reserved = reserved;
          if (m.failed === true) {
            out.failed = true;
            const from = seq(m.failedFrom);
            if (from !== undefined) out.failedFrom = from;
          }
          if (typeof m.boot === 'string' && m.boot) out.boot = m.boot;
        }
        this.onDisk = out;
        return out;
      }
    } catch {
      // absent (a new journal, or one an older build wrote) or damaged: a new epoch
    }
    // Written by the store's first write, not here: an open writes nothing (see the class).
    this.metaPending = true;
    return { v: 1, epoch: newEpoch() };
  }

  /**
   * Atomically and privately (G26): `written` (durable, with any directory this open created synced into
   * its parent), `unsynced` (the file holds it, a directory fsync failed: said once per store) or `failed`
   * (nothing changed on disk). A refused write of the `epoch` is said once per store too; a refused high
   * water is the journal's to report (keepMark).
   */
  private writeMeta(meta: StoreMeta, epoch = false): 'written' | 'unsynced' | 'failed' {
    let w: DurableWrite;
    try {
      w = writeDurably(path.join(this.dir, META), JSON.stringify(meta) + '\n');
    } catch (e) {
      if (epoch && !this.refusedWarned) {
        this.refusedWarned = true;
        this.log?.('warn', `the journal's metadata (${META}) could not be written: ${(e as Error).message}; it is retried at most once a second while appends land, and a restart before it is written gives this journal a new epoch, which readers outside the daemon take for a new journal`);
      }
      return 'failed';
    }
    this.onDisk = meta;
    const dirError = syncMadeDirs(this.newDirs);
    if (w.synced && dirError === undefined) return 'written';
    if (!this.syncWarned) {
      this.syncWarned = true;
      const why = w.synced ? `its new directory's entry could not be synced: ${dirError?.message ?? 'unknown error'}` : `its directory could not be synced: ${w.error?.message ?? 'unknown error'}`;
      this.log?.('warn', `the journal's metadata (${META}) is written but ${why}; a crash may undo the write`);
    }
    return 'unsynced';
  }

  epoch(): string {
    return this.meta.epoch;
  }

  /**
   * The file holds the epoch now: by its own retry as appends land, or by any metadata write, which a
   * journal's reservation makes before its first event. After a refusal that was said, its landing is
   * said too, at 'info': the epoch is kept, so a restart no longer gives the journal a new one.
   */
  private epochWritten(): void {
    if (this.metaPending && this.refusedWarned) this.log?.('info', `the journal's metadata (${META}) is written now: this journal keeps its epoch across a restart`);
    this.metaPending = false;
  }

  highWater(): HighWater | undefined {
    const m = this.meta;
    if (m.highWater === undefined && m.reserved === undefined) return undefined;
    const hw: HighWater = {};
    if (m.highWater !== undefined) hw.floor = m.highWater;
    if (m.reserved !== undefined) {
      hw.reservation = { to: m.reserved, ...(m.failed && { failed: true as const }), ...(m.failed && m.failedFrom !== undefined && { failedFrom: m.failedFrom }), ...(m.boot !== undefined && { boot: m.boot }) };
    }
    return hw;
  }

  setHighWater(change: HighWater): boolean {
    const meta: StoreMeta = { ...this.meta };
    if (change.floor !== undefined) meta.highWater = change.floor;
    if (change.reservation) {
      const r = change.reservation;
      meta.reserved = r.to;
      if (r.failed) meta.failed = true;
      else delete meta.failed;
      if (r.failed && r.failedFrom !== undefined) meta.failedFrom = r.failedFrom;
      else delete meta.failedFrom;
      if (r.boot !== undefined) meta.boot = r.boot;
      else delete meta.boot;
    }
    // Nothing to do only when memory and the file both hold these marks already (item 3 of comment 6307349700).
    const mark = (m: StoreMeta | undefined) => `${m?.highWater ?? 0}:${m?.reserved ?? 0}:${m?.failed === true}:${m?.failedFrom ?? ''}:${m?.boot ?? ''}`;
    if (mark(meta) === mark(this.meta) && mark(meta) === mark(this.onDisk)) return true;
    // Confirmed only once it is on disk (the house's read of b047b92, point 1): a refused write
    // changes nothing here, so a prune cannot delete the file whose newest seq the high water was
    // to keep, and a refused reservation is never written later as if its seqs had been issued.
    const w = this.writeMeta(meta);
    if (w === 'failed') return false;
    this.epochWritten(); // the file holds this epoch now, whatever becomes of the mark
    // The file holds the new marks but its directory could not be synced, so a machine crash may bring the
    // old file back. For a lower reservation, or a flag cleared, that is done: the crash can only restore
    // the older, higher one, which is safe. For a raise (a higher floor or reservation, or a reservation
    // newly marked failed) it is not done: the seqs it covers could be reissued after a crash (G10), so
    // memory keeps the old marks and the caller retries (the house's read of the 38 commits, PR #22,
    // comment 6274603516). A new boot on the same reservation is not a raise: either file is honoured on a
    // later boot. Nor is a failed mark's `failedFrom` lowered, for the start that looks for jumps from it: the
    // old file would send it past a hole.
    const scanFrom = (m: StoreMeta) => (m.failed === true ? (m.failedFrom ?? 0) : Number.POSITIVE_INFINITY);
    const raising =
      (meta.highWater ?? 0) > (this.meta.highWater ?? 0) || (meta.reserved ?? 0) > (this.meta.reserved ?? 0) || scanFrom(meta) < scanFrom(this.meta);
    if (w === 'unsynced' && raising) return false;
    this.meta = meta;
    return true;
  }

  // ───────────── retention (G21) ─────────────

  /** Set the bounds (at open, and for a new life of a session with new retention) and enforce them now. */
  setRetention(r: Retention): void {
    this.maxBytes = r.maxBytes ?? Infinity;
    this.maxAgeMs = r.maxAgeMs ?? Infinity;
    this.maxFileBytes = this.fixedFileBytes ?? Math.max(MIN_FILE_BYTES, Math.min(MAX_FILE_BYTES, Math.floor(this.maxBytes / 4)));
    this.prune();
  }

  /**
   * Age retention without an append (jr2-7, G21, G26): an active file whose oldest event is
   * past `maxAgeMs` is rotated so that it can be dropped, then aged files are dropped. A
   * closed store stays closed. A refused rotation is retried at the next sweep or append.
   */
  expire(now = this.now()): void {
    const closed = this.fd === null;
    this.rotateAged(now);
    if (closed) this.closeFd();
    this.prune(now);
  }

  /** Rotate an active file whose oldest event is past the age bound (jr2-7): not worth an event, so a refused rename is retried at the next append or sweep. */
  private rotateAged(now: number): void {
    const act = this.segments[this.segments.length - 1];
    if (!act || act.n !== 0 || act.last === undefined || act.firstTs === undefined || act.firstTs >= now - this.maxAgeMs) return;
    if (this.dirty) this.repair(); // never rotate a fragment out with the file: rotated files are not cut
    if (this.dirty) return;
    try {
      this.rotate();
    } catch {
      // the active file stays until the next try
    }
  }

  /** Timestamp of the newest retained event. */
  newestTs(): number | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const ts = this.segments[i]!.lastTs;
      if (ts !== undefined) return ts;
    }
    return undefined;
  }

  /** The limits in force; an absent one is no limit. */
  retention(): Retention {
    const r: Retention = {};
    if (Number.isFinite(this.maxBytes)) r.maxBytes = this.maxBytes;
    if (Number.isFinite(this.maxAgeMs)) r.maxAgeMs = this.maxAgeMs;
    return r;
  }

  /**
   * Drop rotated files, oldest first, while they and a full active file would
   * exceed `maxBytes`, or while the oldest one's
   * newest event is past `maxAgeMs`. The active file is never dropped here; an aged
   * one is rotated first (`expire`). When a drop takes the store's newest event with
   * it, its seq is kept as the floor, so numbering never restarts (G10), whatever the
   * journal's reservation says.
   */
  private prune(now = this.now()): void {
    const cutoff = now - this.maxAgeMs;
    const rotated = this.segments.filter((s) => s.n !== 0);
    let rotatedBytes = rotated.reduce((a, s) => a + s.bytes, 0);
    while (rotated.length) {
      const oldest = rotated[0]!;
      const drop =
        (oldest.last === undefined && oldest.bytes === 0) ||
        rotatedBytes + this.maxFileBytes > this.maxBytes ||
        (oldest.lastTs !== undefined && oldest.lastTs < cutoff);
      if (!drop) break;
      const newest = this.lastSeq();
      if (oldest.last !== undefined && oldest.last === newest && (this.meta.highWater ?? 0) < newest) {
        if (!this.setHighWater({ floor: newest })) break; // cannot keep the numbering: keep the file
      }
      try {
        fs.rmSync(oldest.file, { force: true });
      } catch {
        break; // retried at the next rotation
      }
      rotated.shift();
      rotatedBytes -= oldest.bytes;
      this.segments.splice(this.segments.indexOf(oldest), 1);
    }
  }

  // ───────────── open ─────────────

  private load(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    const rotated = names
      .map((n) => ROTATED.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ n: Number(m[1]), file: path.join(this.dir, m[0]) }))
      .sort((a, b) => a.n - b.n);
    for (const r of rotated) this.segments.push(this.inspect(r.file, r.n));
    if (rotated.length) this.nextN = rotated[rotated.length - 1]!.n + 1;
    if (names.includes(ACTIVE)) this.segments.push(this.inspect(this.active, 0));
  }

  private inspect(file: string, n: number): Segment {
    try {
      fs.chmodSync(file, FILE_MODE); // files written by an older build were 0644 (G26)
    } catch {
      // unreadable files read as empty below
    }
    let bytes = sizeOf(file);
    if (n === 0 && bytes > 0) bytes = this.tornAt(file, bytes);
    const seg: Segment = { file, n, bytes };
    if (bytes > 0) this.index(seg);
    return seg;
  }

  /** First and last event of a segment, from its head and its tail only. */
  private index(seg: Segment): void {
    const edge = (lines: Iterable<string>): [Seq, number | undefined] | undefined => {
      for (const line of lines) {
        const seq = seqOf(line);
        if (seq !== undefined && parseEvent(line)) return [seq, tsOf(line)];
      }
      return undefined;
    };
    const first = edge(this.linesForward(seg.file, 0, seg.bytes, 16 * 1024));
    const last = first && edge(this.linesBackward(seg.file, seg.bytes));
    if (!first || !last) return;
    [seg.first, seg.last] = [first[0], last[0]];
    if (first[1] !== undefined) seg.firstTs = first[1];
    if (last[1] !== undefined) seg.lastTs = last[1];
  }

  /**
   * At open, read only: where the active file's last complete line ends, when a crash (or a failed
   * write) cut the line after it short, and whether that line was an event (`takeTornTail`). The
   * store reads no further than that; the fragment is cut by its first write (`dirty`), so an open
   * the caller then refuses leaves the file as it found it (an independent read of the fix for the
   * house's read of the 33 commits, PR #22, comment 6307349700). Returns the size to read up to.
   */
  private tornAt(file: string, bytes: number): number {
    const cut = this.cutTornTail(file, bytes, true);
    if (cut !== bytes) this.dirty = true;
    return cut;
  }

  /**
   * A file whose last byte is not a newline ends in a line a crash (or a failed
   * write) cut short. Truncate it to the last complete line so the next append
   * starts on a clean line instead of being swallowed into the fragment (jr-9).
   * Returns the new size. `atOpen`: only find the cut, and whether an event was
   * cut, without truncating (see tornAt).
   */
  private cutTornTail(file: string, bytes: number, atOpen: boolean): number {
    let fd: number;
    try {
      fd = fs.openSync(file, atOpen ? 'r' : 'r+');
    } catch {
      this.dirty = true; // cannot look now: check again before the next write
      return bytes;
    }
    try {
      const one = Buffer.alloc(1);
      fs.readSync(fd, one, 0, 1, bytes - 1);
      if (one[0] === 10) return bytes;
      let end = bytes;
      let cut = 0;
      const buf = Buffer.allocUnsafe(BACK_CHUNK);
      while (end > 0) {
        const len = Math.min(BACK_CHUNK, end);
        fs.readSync(fd, buf, 0, len, end - len);
        const nl = buf.subarray(0, len).lastIndexOf(10);
        if (nl !== -1) {
          cut = end - len + nl + 1;
          break;
        }
        end -= len;
      }
      if (atOpen) {
        const head = Buffer.alloc(Math.min(HEADER_PREFIX.length, bytes - cut));
        fs.readSync(fd, head, 0, head.length, cut);
        // A torn rotation header lost no event — torn even within its first bytes (the house's read
        // of b047b92); anything else was the event after the last complete line.
        this.tornEvent = !HEADER_PREFIX.startsWith(head.toString('utf8'));
        return cut;
      }
      fs.ftruncateSync(fd, cut);
      return cut;
    } catch {
      this.dirty = true;
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  takeTornTail(): boolean {
    const t = this.tornEvent;
    this.tornEvent = false;
    return t;
  }

  // ───────────── append ─────────────

  setRotationHeader(provider: ((maxBytes?: number) => RotationHeader | undefined) | undefined): void {
    this.header = provider;
  }

  private activeSegment(): Segment {
    const last = this.segments[this.segments.length - 1];
    if (last && last.n === 0) return last;
    const seg: Segment = { file: this.active, n: 0, bytes: 0 };
    this.segments.push(seg);
    return seg;
  }

  /**
   * Throws when the disk refuses (ENOSPC, EACCES, EIO), leaving the store
   * consistent and usable for a retry: no partial line survives, a failed
   * rename leaves the active file in place, and a rotation header the disk
   * refused is written before the new file's first event. The journal decides
   * what a failure means (it never crashes the daemon, G19).
   */
  append(event: JournalEvent): void {
    const buf = Buffer.from(lineOf(event));
    // Below the floor the disk is left alone (shell tools 4): the journal keeps the ring and retries.
    if (this.floor && !this.floor.allow(this.dir, buf.length)) throw new Error(`journal ${this.active}: the disk's free space is below the floor; history stays in memory until space returns`);
    if (this.dirty) {
      this.repair();
      // Writing after a fragment would swallow this event into it (jr-9): refuse until the cut succeeds.
      if (this.dirty) throw new Error(`journal ${this.active}: cannot cut a torn final line`);
    }
    const act = this.activeSegment();
    // A file holding only a rotation header is never rotated (jr2-8): it would carry no event.
    if (act.last !== undefined && act.bytes + buf.length > this.maxFileBytes) this.rotate();
    else this.rotateAged(this.now());
    if (this.headerPending && this.activeSegment().bytes === 0) {
      this.write(this.headerPending);
      this.headerPending = undefined;
    }
    this.write(buf);
    const seg = this.activeSegment();
    seg.first ??= event.seq;
    seg.firstTs ??= event.ts;
    seg.last = event.seq;
    seg.lastTs = event.ts;
    if (this.metaPending && clocks.monotonic() >= this.metaRetryAt) {
      if (this.writeMeta(this.meta, true) === 'failed') this.metaRetryAt = clocks.monotonic() + 1000;
      else this.epochWritten();
    }
  }

  private write(buf: Buffer): void {
    const seg = this.activeSegment();
    if (this.fd === null) this.fd = fs.openSync(this.active, 'a', FILE_MODE);
    let off = 0;
    try {
      // writeSync may write less than asked (ENOSPC on the way): loop to a whole line.
      while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off);
    } catch (e) {
      if (off > 0) {
        try {
          fs.ftruncateSync(this.fd, seg.bytes);
        } catch {
          this.dirty = true;
        }
      }
      this.closeFd();
      throw e;
    }
    seg.bytes += buf.length;
  }

  private repair(): void {
    this.dirty = false; // set again if the cut fails
    const seg = this.activeSegment();
    seg.bytes = sizeOf(this.active);
    if (seg.bytes > 0) seg.bytes = this.cutTornTail(this.active, seg.bytes, false);
  }

  private rotate(): void {
    this.closeFd();
    const act = this.activeSegment();
    const n = this.nextN;
    const target = path.join(this.dir, `journal.${n}.jsonl`);
    try {
      fs.renameSync(this.active, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // the active file stays; retried next append
      this.segments.pop(); // it vanished under us: start a fresh one
      this.segments.push({ file: this.active, n: 0, bytes: 0 });
      return;
    }
    this.nextN = n + 1;
    act.file = target;
    act.n = n;
    this.segments.push({ file: this.active, n: 0, bytes: 0 });
    this.prune();
    // The open Runs, within a quarter of a file (jr2-8): a header near the file size would make every
    // append rotate. Past the budget, long command lines are shortened and the oldest Runs left out.
    const header = this.header?.(Math.floor(this.maxFileBytes / 4));
    if (header && header.openRuns.length) {
      const buf = Buffer.from(lineOf({ header }));
      try {
        this.write(buf);
      } catch (e) {
        this.headerPending = buf; // the new file must not begin without it: before its first event
        throw e;
      }
    }
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // already gone
    }
    this.fd = null;
  }

  // ───────────── read ─────────────

  /** Complete lines of `file` in [start, end), in order. The last line may lack its newline. */
  private *linesForward(file: string, start: number, end: number, size = CHUNK): Generator<string> {
    for (const chunk of this.chunks(file, start, end, size)) {
      let s = 0;
      for (;;) {
        const nl = chunk.indexOf(10, s);
        if (nl === -1) break;
        if (nl > s) yield chunk.toString('utf8', s, nl);
        s = nl + 1;
      }
      if (s < chunk.length) yield chunk.toString('utf8', s);
    }
  }

  /** Buffers of whole lines of `file` in [start, end): each ends at a newline, except possibly the very last. */
  private *chunks(file: string, start: number, end: number, size = CHUNK): Generator<Buffer> {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(size);
      let carry: Buffer | undefined;
      let pos = start;
      while (pos < end) {
        const n = fs.readSync(fd, buf, 0, Math.min(size, end - pos), pos);
        if (n <= 0) break;
        pos += n;
        this.bytesRead += n;
        const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const nl = chunk.lastIndexOf(10);
        if (nl === -1) {
          carry = Buffer.from(chunk);
          continue;
        }
        carry = nl + 1 < chunk.length ? Buffer.from(chunk.subarray(nl + 1)) : undefined;
        yield chunk.subarray(0, nl + 1);
      }
      if (carry?.length) yield carry;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Lines of `file` before byte `end`, newest first. */
  private *linesBackward(file: string, end: number): Generator<string> {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(BACK_CHUNK);
      let carry = Buffer.alloc(0);
      let pos = end;
      while (pos > 0) {
        const len = Math.min(BACK_CHUNK, pos);
        pos -= len;
        const n = fs.readSync(fd, buf, 0, len, pos);
        this.bytesRead += n;
        const chunk = Buffer.concat([buf.subarray(0, n), carry]);
        let e = chunk.length;
        while (e > 0) {
          const nl = chunk.lastIndexOf(10, e - 1);
          if (nl === -1) break;
          if (e - nl - 1 > 0) yield chunk.toString('utf8', nl + 1, e);
          e = nl;
        }
        carry = Buffer.from(chunk.subarray(0, e));
      }
      if (carry.length) yield carry.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Byte bounds around the first event with `seq >= target` in `seg`, found by
   * bisecting over offsets and reading a small window per step (lines are in
   * seq order within a file, and each line's seq sits at its end, just before
   * the newline the window looks for). Every event before `lo` has a smaller
   * seq, and `lo` is a line start; the first event at or past `target` starts
   * at or before `hi`, so every smaller one ends before it.
   */
  private bounds(seg: Segment, target: Seq): { lo: number; hi: number } {
    if (seg.bytes < BISECT_MIN || seg.first === undefined || target <= seg.first) return { lo: 0, hi: seg.bytes };
    let fd: number;
    try {
      fd = fs.openSync(seg.file, 'r');
    } catch {
      return { lo: 0, hi: seg.bytes };
    }
    let lo = 0;
    let hi = seg.bytes;
    try {
      const win = Buffer.allocUnsafe(16 * 1024);
      while (hi - lo > 64 * 1024) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const back = Math.min(mid - lo, 128); // enough of the line before `mid` to hold `"seq":N,"ts":T}`
        let pos = mid - back;
        let skip = back;
        let tail = '';
        let nl = -1;
        while (pos < hi) {
          const n = fs.readSync(fd, win, 0, Math.min(win.length, hi - pos), pos);
          if (n <= 0) break;
          this.bytesRead += n;
          const idx = win.subarray(0, n).indexOf(10, skip);
          if (idx !== -1) {
            tail = (tail + win.toString('latin1', 0, idx)).slice(-256);
            nl = pos + idx;
            break;
          }
          tail = (tail + win.toString('latin1', 0, n)).slice(-256);
          pos += n;
          skip = 0;
        }
        if (nl === -1) {
          hi = mid;
          continue;
        }
        const s = seqOf(tail);
        if (s === undefined || s < target) lo = nl + 1;
        else hi = mid;
      }
    } finally {
      fs.closeSync(fd);
    }
    return { lo, hi };
  }

  read(from?: Seq, to?: Seq, limit = Number.POSITIVE_INFINITY): JournalEvent[] {
    const lo = from ?? Number.NEGATIVE_INFINITY;
    const hi = to ?? Number.POSITIVE_INFINITY;
    const out: JournalEvent[] = [];
    if (limit <= 0 || hi < lo) return out;
    for (const seg of this.segments) {
      if (seg.last === undefined || seg.last < lo) continue;
      if (seg.first !== undefined && seg.first > hi) break;
      for (const line of this.linesForward(seg.file, this.bounds(seg, lo).lo, seg.bytes)) {
        const seq = seqOf(line);
        if (seq === undefined || seq < lo) continue;
        if (seq > hi) return out;
        const ev = parseEvent(line);
        if (!ev) continue;
        out.push(ev);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  tail(n: number, to?: Seq): JournalEvent[] {
    const out: JournalEvent[] = [];
    for (let i = this.segments.length - 1; i >= 0 && out.length < n; i--) {
      const seg = this.segments[i]!;
      if (seg.last === undefined || (to !== undefined && seg.first !== undefined && seg.first > to)) continue;
      // Past `hi` every event is newer than `to`; a fragment cut at `hi` fails to parse and is skipped.
      const end = to !== undefined && to < seg.last ? this.bounds(seg, to + 1).hi : seg.bytes;
      for (const line of this.linesBackward(seg.file, end)) {
        const seq = seqOf(line);
        if (seq === undefined || (to !== undefined && seq > to)) continue;
        const ev = parseEvent(line);
        if (!ev) continue;
        out.push(ev);
        if (out.length >= n) break;
      }
    }
    return out.reverse();
  }

  scan(needles: string | string[], visit: (ev: JournalEvent) => void, onHeader?: (h: RotationHeader) => void): void {
    const nbs = (Array.isArray(needles) ? needles : [needles]).map((n) => Buffer.from(n));
    const hb = Buffer.from(HEADER_PREFIX);
    for (const seg of this.segments) {
      let first = true;
      for (const chunk of this.chunks(seg.file, 0, seg.bytes)) {
        if (first) {
          first = false;
          if (onHeader && chunk.subarray(0, hb.length).equals(hb)) {
            const end = chunk.indexOf(10);
            try {
              const h = (JSON.parse(chunk.toString('utf8', 0, end === -1 ? chunk.length : end)) as { header: RotationHeader }).header;
              onHeader(h);
            } catch {
              // a damaged header only costs the Runs it named
            }
          }
        }
        // Only lines holding a needle are decoded and parsed; the rest is a memchr per needle over the
        // one read of the file, and the lines found go to the visitor in their order.
        const starts: number[] = [];
        for (const nb of nbs) {
          let p = chunk.indexOf(nb);
          while (p !== -1) {
            const ls = chunk.lastIndexOf(10, p) + 1;
            starts.push(ls);
            const le = chunk.indexOf(10, p);
            p = le !== -1 && le < chunk.length ? chunk.indexOf(nb, le + 1) : -1;
          }
        }
        if (nbs.length > 1) starts.sort((a, b) => a - b);
        let seen = -1;
        for (const ls of starts) {
          if (ls === seen) continue; // one line holding two needles
          seen = ls;
          let le = chunk.indexOf(10, ls);
          if (le === -1) le = chunk.length;
          const ev = parseEvent(chunk.toString('utf8', ls, le));
          if (ev) visit(ev);
        }
      }
    }
  }

  oldestSeq(): Seq | undefined {
    for (const s of this.segments) if (s.first !== undefined) return s.first;
    return undefined;
  }

  lastSeq(): Seq | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const l = this.segments[i]!.last;
      if (l !== undefined) return l;
    }
    return undefined;
  }

  bytes(): number {
    return this.segments.reduce((a, s) => a + s.bytes, 0);
  }

  /** Releases the write descriptor. Reads keep working: they open files as they go. */
  close(): void {
    this.closeFd();
  }
}
