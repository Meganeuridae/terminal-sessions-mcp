/**
 * Journal stores (§6). Two implementations behind one interface: a byte-bounded
 * memory ring for the hot path, and an append-only JSONL file with rotation that
 * makes history survive a daemon restart (G19b, G20). Retention is explicit —
 * bytes and age — and the oldest retained seq is exact (G21).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
   * Stream every retained event whose serialized line contains `needle`, oldest
   * first, without holding the journal in memory; rotation headers go to `onHeader`.
   */
  scan?(needle: string, visit: (ev: JournalEvent) => void, onHeader?: (h: RotationHeader) => void): void;
  /** What to write at the head of each file this store rotates into, within the byte budget the provider is given. */
  setRotationHeader?(provider: ((maxBytes?: number) => RotationHeader | undefined) | undefined): void;
  /** True once if opening the store cut a torn final event (a crash mid-write); see Journal. */
  takeTornTail?(): boolean;
  /** Apply age retention now rather than at the next append: an idle session's content ages out too (G21). */
  expire?(now?: number): void;
  /** The journal's incarnation, persisted with the store: the same across lives and restarts, new after a forget (see Journal.epoch). */
  epoch?(): string;
  /**
   * The highest seq the journal may have issued, when that is above what the store holds (G10): numbering
   * resumes above it. `failed`: the store refused the events above its last one (a gap `store-failed`).
   */
  highWater?(): { seq: Seq; failed: boolean } | undefined;
  /** Record the high-water mark (best effort: false when the disk refused it too). */
  setHighWater?(seq: Seq, failed: boolean): boolean;
}

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
 * The hot ring. Bounded by approximate bytes over every event; eviction moves a
 * head index and compacts occasionally, so appends are O(1) amortized.
 */
/**
 * Write `text` through a temp file beside `file`, synced to disk, then renamed over it, with the
 * directory synced too: after a crash of the process or the machine the file is the old one or the
 * new one, never torn or missing (the house's read of 2c35df8, #22). Owner-only (G26). The session records, the store's own
 * metadata and the lock file are all written this way.
 */
export function writeDurably(file: string, text: string): void {
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
    fs.rmSync(tmp, { force: true }); // a failed write leaves no stray beside the file
    throw e;
  }
  let dir: number | undefined;
  try {
    dir = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dir);
  } catch {
    // a filesystem that cannot sync a directory: the rename is still atomic
  } finally {
    if (dir !== undefined) fs.closeSync(dir);
  }
}

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
 * be asked is not a full one: the write itself decides then.
 */
export class FreeSpaceFloor implements DiskFloor {
  private readonly seen = new Map<string, { at: number; written: number; ok: boolean }>();
  constructor(
    readonly floorBytes: number,
    private readonly statfs: (dir: string) => { bavail: number | bigint; bsize: number | bigint } = (d) => fs.statfsSync(d),
    private readonly now: () => number = Date.now,
  ) {}

  allow(dir: string, bytes: number): boolean {
    const t = this.now();
    const s = this.seen.get(dir);
    if (s && t - s.at < 1000 && s.written + bytes < 1024 * 1024) {
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

interface StoreMeta {
  v: 1;
  epoch: string;
  /** Numbering resumes above this even when no file holds it any more (G10). */
  highWater?: Seq;
  /** The events between the files' last seq and `highWater` were refused by the disk (a `store-failed` gap). */
  failed?: boolean;
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
 * reads only the head and tail of each file.
 */
export class FileStore implements JournalStore {
  readonly kind = 'file';
  private readonly active: string;
  private fd: number | null = null;
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
  /** The epoch's first write was refused (a disk refusing writes): retried after the next successful append. */
  private metaPending = false;
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
    // The journal holds whatever programs printed: private to the daemon's user (G26).
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
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

  // ───────────── epoch and high water (G10, mcpl-4, jr2-6) ─────────────

  private loadMeta(): StoreMeta {
    const file = path.join(this.dir, META);
    try {
      fs.chmodSync(file, FILE_MODE);
      const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreMeta>;
      if (typeof m.epoch === 'string' && /^[0-9a-f]{8,64}$/.test(m.epoch)) {
        const out: StoreMeta = { v: 1, epoch: m.epoch };
        if (typeof m.highWater === 'number' && Number.isFinite(m.highWater) && m.highWater > 0) out.highWater = Math.floor(m.highWater);
        if (m.failed === true && out.highWater !== undefined) out.failed = true;
        return out;
      }
    } catch {
      // absent (a new journal, or one an older build wrote) or damaged: a new epoch
    }
    const meta: StoreMeta = { v: 1, epoch: newEpoch() };
    this.metaPending = !this.writeMeta(meta);
    return meta;
  }

  /** Atomically and privately (G26); false when the disk refuses. */
  private writeMeta(meta: StoreMeta): boolean {
    try {
      writeDurably(path.join(this.dir, META), JSON.stringify(meta) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  epoch(): string {
    return this.meta.epoch;
  }

  highWater(): { seq: Seq; failed: boolean } | undefined {
    const hw = this.meta.highWater;
    return hw === undefined ? undefined : { seq: hw, failed: this.meta.failed === true };
  }

  setHighWater(seq: Seq, failed: boolean): boolean {
    const meta: StoreMeta = { v: 1, epoch: this.meta.epoch };
    if (seq > 0) meta.highWater = seq;
    if (failed && seq > 0) meta.failed = true;
    if (meta.highWater === this.meta.highWater && meta.failed === this.meta.failed) return true;
    // Confirmed only once it is on disk (the house's read of b047b92, point 1): a refused write
    // changes nothing here, so a prune cannot delete the file whose newest seq the high water was
    // to keep, and a refused reservation is never written later as if its seqs had been issued.
    if (!this.writeMeta(meta)) return false;
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
   * it, its seq is kept as the high water, so numbering never restarts (G10).
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
        if (!this.setHighWater(newest, this.meta.failed === true)) break; // cannot keep the numbering: keep the file
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
    if (n === 0 && bytes > 0) bytes = this.cutTornTail(file, bytes, true);
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
   * A file whose last byte is not a newline ends in a line a crash (or a failed
   * write) cut short. Truncate it to the last complete line so the next append
   * starts on a clean line instead of being swallowed into the fragment (jr-9).
   * Returns the new size.
   */
  private cutTornTail(file: string, bytes: number, atOpen: boolean): number {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r+');
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
    const buf = Buffer.from(JSON.stringify(event) + '\n');
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
    if (this.metaPending) this.metaPending = !this.writeMeta(this.meta);
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
      const buf = Buffer.from(JSON.stringify({ header }) + '\n');
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

  scan(needle: string, visit: (ev: JournalEvent) => void, onHeader?: (h: RotationHeader) => void): void {
    const nb = Buffer.from(needle);
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
        // Only lines holding the needle are decoded and parsed; the rest is a memchr.
        let p = chunk.indexOf(nb);
        while (p !== -1) {
          const ls = chunk.lastIndexOf(10, p) + 1;
          let le = chunk.indexOf(10, p);
          if (le === -1) le = chunk.length;
          const ev = parseEvent(chunk.toString('utf8', ls, le));
          if (ev) visit(ev);
          p = le < chunk.length ? chunk.indexOf(nb, le + 1) : -1;
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
