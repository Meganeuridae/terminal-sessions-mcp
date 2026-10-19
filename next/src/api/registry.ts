/**
 * The session registry: creates sessions with file-backed journals under the
 * data dir, lists them, closes them into readable history, and at startup
 * surfaces what a previous daemon left behind as `history-only` sessions
 * (G19, G20).
 *
 * A name is owned. Its history stays readable as the session's visibility
 * allows, and only its recorded owner (or `system`) may start a new life for
 * it, because a new life continues the same journal (G18). Names are unique
 * case-insensitively, live or on disk: the data dir may sit on a filesystem
 * that folds case. Every operation that can change what a name refers to runs
 * under that name's lock, so two concurrent opens of one name make one shell
 * and one journal (G10).
 *
 * One registry owns a data dir: it takes `<dataDir>/termd.lock` before
 * recovery writes anything and holds it for its lifetime, so a second daemon
 * never appends to journals a live one is numbering (G10, G20). A session's
 * creation options, and every principal's delivery cursors (G22), are kept
 * beside its journal, so a new life — after the shell ended, or after a
 * restart — is the session it was.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionBackend } from '../backends/types.js';
import { configuredEnv } from '../core/env.js';
import { err, TermError } from '../core/errors.js';
import { Journal, type JournalOptions } from '../core/journal.js';
import { acquireDataDirLock, listProcesses, livingGroups, sleepSync, type DataDirLock, type ProcessRow } from '../core/lock.js';
import type { RunOutput, RunOutputRange } from '../core/runindex.js';
import { Session, trustedDir, type SessionOptions } from '../core/session.js';
import { FileStore, FreeSpaceFloor, MemoryStore, type DiskFloor, type FileStoreOptions, type Retention } from '../core/stores.js';
import { SYSTEM, type ControlPolicy, type Cursors, type JournalEvent, type Principal, type RunInfo, type Seq, type Visibility } from '../core/types.js';
import { prepareIntegration } from '../shell/integration.js';

export interface RegistryOptions {
  dataDir: string;
  backend: ExecutionBackend;
  defaultShell?: string;
  defaultCwd?: string;
  /** Skip the user's rc files when injecting integration (tests). */
  noUserRc?: boolean;
  /** Linux: sessions' shells and process Runs get this oom_score_adj (0: unchanged; the daemon's --session-oom-score-adj). */
  sessionOomScoreAdj?: number;
  /** The hot ring per session (default 8 MiB), never more than the session's disk retention. */
  memoryBytes?: number;
  daemonEnv?: NodeJS.ProcessEnv;
  /** Daemon-wide history limits (G21). Absent: nothing is deleted. */
  retention?: Retention;
  /**
   * Stop writing history to disk while the data dir's filesystem has less free space than this
   * (the daemon's --disk-floor-bytes): the ring carries on, writing resumes when space returns.
   * Absent or 0: no floor.
   */
  diskFloorBytes?: number;
  /** The daemon's log, for what recovery did and what a session's journal has to say about its disk (writes refused, writing resumed). */
  log?: (level: 'warn' | 'info', text: string, fields?: Record<string, unknown>) => void;
  /**
   * Take the data dir's lock (default true). Tests only: `false` lets a registry recover a
   * data dir another process holds — which a daemon must never do (jr2-2).
   */
  lock?: boolean;
  /**
   * At recovery, terminate the process groups of Runs a dead daemon left running (jr2-4).
   * Default: unless the backend is `scripted`, whose pids are not real processes.
   */
  terminateOrphans?: boolean;
}

/** Retention as a session records and reports it (G21). */
/** A session's history limits; an absent one is no limit, the default (G21: nothing is deleted unless asked). */
export type SessionRetention = Retention;

/**
 * What a session was created with, recorded beside its journal (session.json, 0600: `env` may
 * hold secrets) and reused by every new life of the name unless the reopening call overrides it
 * (ux-4). A session recorded by an older build knows only its visibility and retention.
 */
export interface SessionCreationOptions {
  shell?: string;
  shellArgs?: string[];
  /** Started as a login shell (the Session's default). */
  login?: boolean;
  visibility: Visibility;
  control: ControlPolicy | 'open';
  env?: Record<string, string>;
  /** The creation cwd (a new life starts here; the shell's later `cd`s are not carried). */
  cwd?: string;
  cols?: number;
  rows?: number;
  retention: SessionRetention;
  /** `false`: no shell integration (the fallback strategy, G5). */
  integration?: boolean;
  /** `false`: the user's rc files are skipped. */
  userRc?: boolean;
}

/** The public views of a name (see HistoryEntry and LiveEntry below). */
export type HistorySession = Pick<HistoryEntry, keyof HistoryEntry>;
export type LiveSession = Pick<LiveEntry, keyof LiveEntry>;
export type AnySession = LiveSession | HistorySession;

export interface CreateOptions {
  id: string;
  owner: Principal;
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  login?: boolean;
  env?: Record<string, string>;
  visibility?: Visibility;
  control?: 'seat' | 'owner-priority' | 'open';
  cols?: number;
  rows?: number;
  /** Explicit per-session retention (G21); unset fields keep what the session recorded, then the daemon defaults. */
  retention?: Retention;
  /** `false`: start the shell without integration. */
  integration?: boolean;
  /** `false`: skip the user's rc files. */
  userRc?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fold = (id: string) => id.toLowerCase();
const DEFAULT_MEMORY_BYTES = 8 * 1024 * 1024;
const MIN_DISK_BYTES = 16 * 1024;
const MIN_AGE_MS = 1000;
/** Cursor writes are debounced this long at most (G22: a crash loses at most this much cursor progress). */
const CURSOR_FLUSH_MS = 1000;
/** Recovery gives orphaned process groups this long after SIGTERM, then SIGKILLs them (jr2-4). */
const ORPHAN_TERM_MS = 2000;
const ORPHAN_KILL_MS = 500;

/** `created`: a session went live. `closed`: a live session became history. `removed`: an entry and its files are gone. */
export type RegistryChange = { type: 'created' | 'closed' | 'removed'; id: string };

type CloseOptions = NonNullable<Parameters<Session['close']>[0]> & { reason?: string };

/**
 * Per-principal cursors of one name (G22), persisted to `<session dir>/cursors.json`
 * (0600): writes are debounced, and flushed when the session closes.
 */
class CursorBook {
  private readonly map = new Map<Principal, Cursors>();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(private readonly file: string) {
    try {
      fs.chmodSync(file, 0o600);
      for (const [p, c] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Partial<Cursors> | null>)) {
        const d = c?.delivered;
        const r = c?.read;
        if (typeof d === 'number' && typeof r === 'number' && d >= 0 && r >= 0) this.map.set(p, { delivered: d, read: r });
      }
    } catch {
      // none yet, or unreadable: cursors start at 0 (delivery is at-least-once)
    }
  }

  get(principal: Principal): Cursors {
    const c = this.map.get(principal);
    return c ? { ...c } : { delivered: 0, read: 0 };
  }

  /** Take a principal's cursors as the live Session reports them. */
  set(principal: Principal, c: Cursors): void {
    const cur = this.map.get(principal);
    if (cur && cur.delivered === c.delivered && cur.read === c.read) return;
    this.map.set(principal, { delivered: c.delivered, read: c.read });
    this.schedule();
  }

  advance(principal: Principal, field: keyof Cursors, seq: Seq): void {
    const c = this.get(principal);
    if (!(seq > c[field])) return;
    c[field] = seq;
    this.set(principal, c);
  }

  merge(all: Record<Principal, Cursors>): void {
    for (const [p, c] of Object.entries(all)) {
      const cur = this.get(p);
      this.set(p, { delivered: Math.max(cur.delivered, c.delivered), read: Math.max(cur.read, c.read) });
    }
  }

  snapshot(): Record<Principal, Cursors> {
    return Object.fromEntries([...this.map].map(([p, c]) => [p, { ...c }]));
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), CURSOR_FLUSH_MS);
    this.timer.unref();
  }

  /** Write now if anything changed (durably; best effort: cursors are advisory, delivery is at-least-once). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeDurably(this.file, JSON.stringify(this.snapshot()));
    } catch {
      this.dirty = true; // the directory may be gone (forgotten) or the disk full: the next flush retries
    }
  }

  /** Stop without writing (the session's files are being removed). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
  }
}

/**
 * A session whose shell is gone and whose journal is readable, nothing else
 * (G19, G20): left behind by a daemon that died (`closed: false`) or closed by
 * its owner (`closed: true`). `recovered` stays `history-only` on both, since
 * only the history remains; `closed` tells them apart.
 */
class HistoryEntry {
  readonly kind = 'history' as const;
  readonly recovered = 'history-only' as const;

  constructor(
    readonly id: string,
    readonly journal: Journal,
    readonly owner: Principal,
    readonly visibility: Visibility,
    readonly closed: boolean,
    readonly retention: SessionRetention,
    /** What the session was created with; its next life starts the same way (ux-4). */
    readonly options: Readonly<SessionCreationOptions>,
    private readonly cursors: CursorBook,
  ) {}

  get lastSeq(): number {
    return this.journal.lastSeq;
  }

  /** A Run reconstructed from the journal: its outcome is terminal (G20); `run_not_found` if the journal never held it. */
  run(runId: string): RunInfo {
    return this.journal.runs.run(runId);
  }

  listRuns(): RunInfo[] {
    return this.journal.runs.list();
  }

  /** The Run's attributed output, the same shape as `Session.runOutput`; `maxBytes` reads only the newest part. */
  runOutput(runId: string, opts: RunOutputRange = {}): RunOutput {
    return this.journal.runs.output(this.journal, runId, opts);
  }

  /** A principal's delivery cursors (G22), kept across lives and restarts; a copy. */
  cursorsOf(principal: Principal): Cursors {
    return this.cursors.get(principal);
  }

  /** Advance `read` (a tool result returned history content); persisted. */
  markRead(principal: Principal, seq: Seq): void {
    this.cursors.advance(principal, 'read', seq);
  }

  /** Advance `delivered` (a host accepted a message about this history); persisted. */
  markDelivered(principal: Principal, seq: Seq): void {
    this.cursors.advance(principal, 'delivered', seq);
  }
}

const notFound = (e: unknown) => e instanceof TermError && e.code === 'run_not_found';

class LiveEntry {
  readonly kind = 'live' as const;

  constructor(
    readonly session: Session,
    readonly cleanup: () => void,
    readonly retention: SessionRetention,
    /** What this life was started with (recorded; the next life reuses it). */
    readonly options: Readonly<SessionCreationOptions>,
  ) {}

  /** A Run of this life, or of an earlier life of the name: the journal is continuous (G1). */
  run(runId: string): RunInfo {
    try {
      return this.session.run(runId);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    return this.session.journal.runs.run(runId);
  }

  listRuns(): RunInfo[] {
    const mine = new Map(this.session.listRuns().map((r) => [r.runId, r]));
    const out = this.session.journal.runs.list().map((r) => mine.get(r.runId) ?? r);
    for (const r of mine.values()) if (!this.session.journal.runs.has(r.runId)) out.push(r);
    return out;
  }

  /** A Run of this life reads through the Session; an earlier life's through the journal (`maxBytes` applies to those). */
  runOutput(runId: string, opts: RunOutputRange = {}): RunOutput {
    try {
      return this.session.runOutput(runId, opts);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    return this.session.journal.runs.output(this.session.journal, runId, opts);
  }
}

/** What the registry keeps per name: the directory, its store, its metadata, its cursors, and the public view. */
interface Slot {
  id: string;
  dir: string;
  store: FileStore;
  meta: Meta;
  cursors: CursorBook;
  view: LiveEntry | HistoryEntry;
}

/**
 * A journal opened by recovery, before its in-flight Runs are ended; `last` is the last event the
 * dead daemon wrote. `gone`: past its retention, so its files go — once its Runs' process groups
 * have been ended with every other session's (the house's read of 2c35df8, #22).
 */
type Recovering = Omit<Slot, 'cursors' | 'view'> & { retention: SessionRetention; journal: Journal; last: JournalEvent | undefined; gone: boolean };

/** A name whose record cannot be read has no known owner: nobody may reopen it until the record is repaired or the session removed. */
const UNOWNED: Principal = 'unknown';

export class SessionRegistry {
  private readonly slots = new Map<string, Slot>();
  /** Per folded name: the tail of the chain of operations on it. */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly opts: RegistryOptions;
  private readonly root: string;
  /** One floor for every session's store: free space is a property of the filesystem, not of a session. */
  private readonly floor: DiskFloor | undefined;
  private readonly listeners = new Set<(c: RegistryChange) => void>();
  /** The data dir's lock while this registry holds it (jr2-2). */
  private dirLock: DataDirLock | undefined;
  /** Session directories recovery could not read at startup (skipped, left on disk). */
  readonly recoveryErrors: Array<{ id: string; error: string }> = [];

  onChange(l: (c: RegistryChange) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(c: RegistryChange): void {
    for (const l of this.listeners) {
      try {
        l(c);
      } catch {
        // a listener's failure is not the registry's
      }
    }
  }

  /** Throws `data_dir_locked` when another live daemon holds the data dir; nothing is read or written then. */
  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.root = path.join(opts.dataDir, 'sessions');
    this.floor = opts.diskFloorBytes ? new FreeSpaceFloor(opts.diskFloorBytes) : undefined;
    // Journals hold whatever programs printed: private to the daemon's user (G26). The
    // sessions root is ours and always 0700; the data dir only when we create it (it
    // may be a directory the user chose, whose mode is theirs).
    fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    // Before recovery writes a byte: a second daemon on this data dir stops here (G10, G20).
    this.ensureLock();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.root, 0o700);
    } catch {
      // not ours to fix
    }
    this.recover();
  }

  /** Hold the data dir's lock (again, after `closeAll` released it) before writing to the data dir. */
  private ensureLock(): void {
    if (this.opts.lock === false || this.dirLock) return;
    this.dirLock = acquireDataDirLock(this.opts.dataDir);
    // A lock whose holder is gone means the previous daemon did not drain: said in the log, not only by what recovery does next (the house's read of 59f660b, #22).
    const stale = this.dirLock.tookOver;
    if (stale) this.opts.log?.('warn', 'took over the data dir lock of a daemon that is gone (it did not drain)', { pid: stale.pid, startedAt: stale.startedAt !== undefined ? new Date(stale.startedAt).toISOString() : undefined, hostname: stale.hostname });
  }

  /** Flush every session's cursors and give up the data dir's lock. Sessions are not closed: see `closeAll`. */
  dispose(): void {
    for (const slot of this.slots.values()) {
      if (slot.view.kind === 'live') slot.cursors.merge(slot.view.session.cursorsSnapshot());
      slot.cursors.flush();
    }
    this.dirLock?.release();
    this.dirLock = undefined;
  }

  // ───────────── recovery (G20) ─────────────

  /**
   * Surface journals left by a previous daemon as history-only sessions. Each
   * journal is streamed once (run lifecycle events only); nothing holds a whole
   * journal in memory. Runs still open are ended `lost` — after the process
   * groups the dead daemon left running have been terminated, all sessions'
   * together, within about 2.5 s (jr2-4). A session past its retention is
   * removed only after that: its Runs' groups are ended like any other's.
   */
  private recover(): void {
    // One damaged directory must not keep the daemon from starting; the daemon reports these.
    const failed = (id: string, e: unknown) => this.recoveryErrors.push({ id, error: e instanceof Error ? e.message : String(e) });
    const open: Recovering[] = [];
    for (const id of fs.readdirSync(this.root)) {
      if (!SAFE_ID.test(id)) continue;
      try {
        const r = this.openForRecovery(id);
        if (r) open.push(r);
      } catch (e) {
        failed(id, e);
      }
    }
    const ended = this.endOrphans(open);
    for (const r of open) {
      try {
        this.finishRecovery(r, ended);
      } catch (e) {
        failed(r.id, e);
      }
    }
  }

  private openForRecovery(id: string): Recovering | undefined {
    const dir = path.join(this.root, id);
    if (!fs.statSync(dir).isDirectory()) return undefined;
    const meta = readMeta(dir);
    const retention = this.retentionFor(undefined, meta.retention);
    const store = new FileStore(dir, this.storeOptions(retention));
    const gone = expired(store, retention, Date.now());
    if (store.lastSeq() === undefined) {
      store.close();
      // Every file aged out already: the whole session expires (G21, G26). An empty one is left alone.
      if (gone) this.removeFiles(id, dir);
      return undefined;
    }
    // Nothing runs under this name now: a dead life's command files (command text, env captures) go (jr2-12, G26).
    if (!gone) removeLeftovers(this.opts.dataDir, id, dir);
    const last = store.tail(1)[0];
    // Past its retention too, the journal is opened: its run index names the process groups to end (the house's read of 2c35df8, #22).
    const journal = new Journal({ hot: this.hotStore(retention), cold: store, sessionId: id, log: this.journalLog(id) });
    return { id, dir, store, meta, retention, journal, last, gone };
  }

  private finishRecovery(r: Recovering, ended: Map<string, string>): void {
    const { id, dir, store, meta, retention, journal, last } = r;
    if (r.gone) {
      // Past its retention: the whole session expires (G21, G26), now that its Runs' groups are ended.
      journal.close();
      this.removeFiles(id, dir);
      return;
    }
    // Every Run in flight when the daemon died — running, starting, queued, or named only by a
    // rotation header because its admission rotated out — is `lost`, never `running` (G3, G20).
    const now = Date.now();
    const lost: string[] = [];
    for (const run of journal.runs.open()) {
      const what = ended.get(`${id}\0${run.runId}`);
      journal.append({ type: 'run.end', runId: run.runId, state: 'lost', reason: what ? `daemon-restart; ${what}` : 'daemon-restart', durationMs: Math.max(0, now - (run.startedAt ?? run.admittedAt)) });
      lost.push(run.runId);
    }
    // In the daemon's log too, not only in the journal (the house's read of 59f660b, #22).
    if (lost.length) this.opts.log?.('info', 'recovery ended Runs a previous daemon left in flight', { session: id, runs: lost });
    // A Run that had ended, leaving children in its group (`leftovers`), says in the journal what became of them.
    for (const run of journal.runs.list()) {
      const what = run.endedAt !== undefined ? ended.get(`${id}\0${run.runId}`) : undefined;
      if (what) journal.append({ type: 'note', text: `recovery: ${what}; it outlived ${run.runId}, which had ended`, principal: SYSTEM });
    }
    // Mark the restart once: a session closed on purpose, or history since an earlier restart, gains nothing.
    if (meta.closedAt === undefined && last?.type !== 'recovered') journal.append({ type: 'recovered', class: 'history-only' });
    journal.seal();
    // A record that cannot be read names no owner. The name is nobody's to reopen until the record
    // is repaired or the session removed — not the system principal's by default, which let anyone
    // acting as the system start a new life on it (the house's read of 2c35df8, #22).
    if (meta.damaged !== undefined) this.opts.log?.('warn', `session record cannot be read; nobody may reopen the session until it is repaired or removed: ${meta.damaged}`, { session: id });
    const owner = meta.damaged !== undefined ? UNOWNED : meta.owner ?? SYSTEM;
    const cursors = new CursorBook(path.join(dir, 'cursors.json'));
    const view = new HistoryEntry(id, journal, owner, meta.visibility ?? 'private', meta.closedAt !== undefined, retention, recordedOptions(meta, retention), cursors);
    this.slots.set(id, { id, dir, store, meta, cursors, view });
  }

  /**
   * The process groups a dead daemon left running (G19c: without the keeper, live processes do not
   * survive a restart) — of its Runs in flight, and of Runs that had ended leaving children in their
   * group, which the live daemon's own shutdown drain would have ended (the house's read of 2c35df8,
   * #22): SIGTERM, then SIGKILL after 2 s, bounded for every session together. Which groups are a
   * Run's is `orphanGroups`'s rule. Returns what became of each group, per `<session>\0<runId>`.
   */
  private endOrphans(open: Recovering[]): Map<string, string> {
    const out = new Map<string, string>();
    const enabled = this.opts.terminateOrphans ?? this.opts.backend.kind !== 'scripted';
    if (!enabled || process.platform === 'win32') return out;
    const candidates = open.flatMap((r) => r.journal.runs.list().filter(mayHoldGroup).map((run) => ({ key: `${r.id}\0${run.runId}`, run, lastTs: r.last?.ts })));
    if (!candidates.length) return out;
    const procs = listProcesses();
    if (!procs) return out; // nothing can tell whose a group is: leave every process alone
    const groups = orphanGroups(candidates, procs, { pid: process.pid, pgid: procs.find((p) => p.pid === process.pid)?.pgid });
    if (!groups.size) return out;
    const signal = (g: number, sig: NodeJS.Signals) => {
      try {
        process.kill(-g, sig);
      } catch {
        // gone already
      }
    };
    const waitGone = (gs: number[], ms: number) => {
      const until = Date.now() + ms;
      let left = livingGroups(gs);
      while (left.length && Date.now() < until) {
        sleepSync(50);
        left = livingGroups(left);
      }
      return left;
    };
    const all = [...groups.keys()];
    for (const g of all) signal(g, 'SIGTERM');
    const stubborn = waitGone(all, ORPHAN_TERM_MS);
    for (const g of stubborn) signal(g, 'SIGKILL');
    const survivors = new Set(waitGone(stubborn, ORPHAN_KILL_MS));
    for (const [g, keys] of groups) {
      const what = survivors.has(g) ? `process group ${g} survived SIGKILL` : `process group ${g} terminated`;
      for (const k of keys) out.set(k, what);
    }
    // The drain logs its kills; so does recovery (the house's read of 59f660b, #22).
    this.opts.log?.('warn', 'recovery ended process groups a previous daemon left running', {
      groups: all.filter((g) => !survivors.has(g)),
      survivedSigkill: survivors.size ? [...survivors] : undefined,
      sessions: [...new Set([...groups.values()].flat().map((k) => k.slice(0, k.indexOf('\0'))))],
    });
    return out;
  }

  // ───────────── creation ─────────────

  /**
   * Start a session. `session_exists` when the name is live (or being created),
   * or differs from an existing name only by case; `forbidden` when the name's
   * history belongs to another principal. Over a history entry, or a live entry
   * whose shell has exited, the owner starts a new life: same journal, seq continues.
   */
  async create(o: CreateOptions): Promise<Session> {
    this.checkId(o.id);
    return this.withLock(fold(o.id), async () => {
      const slot = this.slots.get(o.id);
      if (slot?.view.kind === 'live' && slot.view.session.state !== 'exited') throw err('session_exists', `session ${o.id} already exists`, { id: o.id });
      this.checkName(o, slot);
      return this.newLife(o, slot);
    });
  }

  /**
   * The live session, or the one being created under this name (awaited), or a
   * new one — subject to the same ownership rule as `create`. A live session is
   * returned whoever asks: the application layer authorizes attaching to it.
   */
  async ensure(o: CreateOptions): Promise<{ session: Session; created: boolean }> {
    this.checkId(o.id);
    const key = fold(o.id);
    const fast = this.slots.get(o.id);
    if (!this.locks.has(key) && fast?.view.kind === 'live' && fast.view.session.state !== 'exited') return { session: fast.view.session, created: false };
    return this.withLock(key, async () => {
      const slot = this.slots.get(o.id);
      if (slot?.view.kind === 'live') {
        const s = slot.view.session;
        // A dead shell is replaced for its owner; anyone else gets what is there.
        if (s.state !== 'exited' || !this.mayReuse(slot, o.owner)) return { session: s, created: false };
      }
      this.checkName(o, slot);
      return { session: await this.newLife(o, slot), created: true };
    });
  }

  private checkId(id: string): void {
    if (!SAFE_ID.test(id)) throw err('invalid_argument', 'session id must be 1–64 chars of [A-Za-z0-9._-], starting alphanumeric', { id });
  }

  /** Refuse a name that folds onto another one, whose record cannot be read, or whose history is someone else's (G18). */
  private checkName(o: CreateOptions, slot: Slot | undefined): void {
    if (slot) {
      if (slot.meta.damaged !== undefined) throw damagedRecord(o.id, slot.meta.damaged);
      if (!this.mayReuse(slot, o.owner)) {
        throw err('forbidden', `session ${o.id} belongs to another principal; only its owner may open it again`, { id: o.id });
      }
      return;
    }
    const key = fold(o.id);
    for (const other of this.slots.values()) {
      if (fold(other.id) === key) {
        throw err('session_exists', `session ${o.id} collides with existing session ${other.id} (names are case-insensitive)`, { id: o.id, existing: other.id });
      }
    }
  }

  private mayReuse(slot: Slot, principal: Principal): boolean {
    return principal === SYSTEM || principal === ownerOf(slot);
  }

  private async newLife(o: CreateOptions, prev: Slot | undefined): Promise<Session> {
    this.ensureLock();
    if (prev?.view.kind === 'live') {
      // Its shell has exited; what is left of it closes first, so nothing of the old life still writes (jr-10).
      await this.closeLive(prev, { graceful: false, reason: 'replaced', persist: false });
      this.emit({ type: 'closed', id: prev.id });
    }
    const id = o.id;
    const dir = prev?.dir ?? path.join(this.root, id);
    const retention = this.retentionFor(o.retention, prev?.meta.retention);
    const jo: JournalOptions = { hot: this.hotStore(retention), sessionId: id, log: this.journalLog(id) };
    let store: FileStore;
    let recorded: Meta;
    if (prev) {
      // A new life for an old name: the same journal, numbering and run index continue (G10).
      const old = journalOf(prev);
      // What the old life's ring still holds beyond the disk gets one more try (jr2-6); if the
      // disk still refuses, the new journal numbers past it and records the hole.
      old.retryCold();
      store = prev.store;
      store.setRetention(retention);
      jo.runs = old.runs;
      jo.startSeq = old.lastSeq;
      recorded = prev.meta;
    } else {
      store = new FileStore(dir, this.storeOptions(retention));
      recorded = readMeta(dir);
      // A journal this registry did not surface (recovery could not read it): its owner stands (G18),
      // and a record that cannot be read names none.
      if (store.lastSeq() !== undefined && recorded.damaged !== undefined) {
        store.close();
        throw damagedRecord(id, recorded.damaged);
      }
      if (store.lastSeq() !== undefined && o.owner !== SYSTEM && (recorded.owner ?? SYSTEM) !== o.owner) {
        store.close();
        throw err('forbidden', `session ${id} belongs to another principal; only its owner may open it again`, { id });
      }
    }
    jo.cold = store;
    const journal = new Journal(jo);
    // Requested over recorded over daemon defaults (ux-4). Another principal's leftovers are never reused.
    const reuse = recorded.owner === undefined || recorded.owner === o.owner || o.owner === SYSTEM ? recordedOptions(recorded, retention) : undefined;
    const options = this.resolveOptions(o, reuse, retention);
    const { retention: _r, ...persisted } = options;
    const meta: Meta = { owner: o.owner, visibility: options.visibility, createdAt: Date.now(), retention, options: persisted };
    const cursors = prev?.cursors ?? new CursorBook(path.join(dir, 'cursors.json'));
    let integ: ReturnType<typeof prepareIntegration> | undefined;
    let session: Session;
    try {
      writeMeta(dir, meta);
      // The integration files live in the session's own directory: a daemon that dies leaves them for
      // the next life to overwrite, not in the system's temp dir. The user's environment the
      // integration preserves (zsh's ZDOTDIR, fish's XDG variables) is the one the shell starts
      // with — the session's over the daemon's — not the daemon's own (the house's read of 2c35df8, #22).
      if (options.integration !== false) {
        integ = prepareIntegration(options.shell!, {
          dir: path.join(shellDir(dir), 'integration'),
          userEnv: configuredEnv(this.opts.daemonEnv ?? process.env, options.env ?? {}),
          ...(this.opts.noUserRc || options.userRc === false ? { noUserRc: true } : {}),
          ...(this.opts.sessionOomScoreAdj !== undefined && { oomScoreAdj: this.opts.sessionOomScoreAdj }),
        });
      }
      const so: SessionOptions = {
        id,
        owner: o.owner,
        visibility: options.visibility,
        control: options.control,
        shell: options.shell!,
        login: options.login!,
        cwd: options.cwd!,
        env: options.env ?? {},
        daemonEnv: this.opts.daemonEnv ?? process.env,
        cols: options.cols!,
        rows: options.rows!,
        backend: this.opts.backend,
        journal,
        // The shell's own files (its history, env captures) live apart from the journal's;
        // command files go to a short private directory, since each is echoed at the prompt.
        tempDir: shellDir(dir),
        commandDir: commandDir(this.opts.dataDir, id, shellDir(dir)),
        // Delivery cursors continue across lives and restarts (G22); the book persists them.
        cursors: cursors.snapshot(),
        onCursors: (p, c) => cursors.set(p, c),
      };
      if (options.shellArgs) so.shellArgs = [...options.shellArgs];
      if (integ && integ.kind !== 'none') so.integration = integ;
      if (this.opts.sessionOomScoreAdj !== undefined) so.oomScoreAdj = this.opts.sessionOomScoreAdj;
      session = await Session.start(so);
    } catch (e) {
      integ?.cleanup();
      // A start that failed is not a life: the record keeps what the last life was created with,
      // and its closedAt, so a plain reopen starts the shell the name had and the history still
      // reads as closed (the house's read of 2c35df8, #22). A name with no record keeps the attempt's.
      const kept = recorded.owner !== undefined ? recorded : meta;
      if (kept !== meta) {
        try {
          writeMeta(dir, kept);
        } catch {
          // the record in memory stands; the disk has the attempt's until the next write
        }
      }
      // The name keeps its history (and whatever the failed start journaled), readable and owned (G19).
      journal.seal();
      if (prev || journal.lastSeq > 0) {
        const view = new HistoryEntry(id, journal, kept.owner ?? o.owner, kept.visibility ?? options.visibility, kept.closedAt !== undefined, retention, recordedOptions(kept, retention), cursors);
        this.slots.set(id, { id, dir, store, meta: kept, cursors, view });
      } else {
        store.close();
      }
      throw e;
    }
    this.slots.set(id, { id, dir, store, meta, cursors, view: new LiveEntry(session, () => integ?.cleanup(), retention, options) });
    this.emit({ type: 'created', id });
    return session;
  }

  /** Requested over recorded over daemon defaults, for every creation option (ux-4). */
  private resolveOptions(o: CreateOptions, rec: SessionCreationOptions | undefined, retention: SessionRetention): SessionCreationOptions {
    const out: SessionCreationOptions = {
      shell: o.shell ?? rec?.shell ?? this.opts.defaultShell ?? process.env.SHELL ?? '/bin/bash',
      login: o.login ?? rec?.login ?? true,
      visibility: o.visibility ?? rec?.visibility ?? 'private',
      control: o.control ?? rec?.control ?? 'seat',
      cwd: o.cwd ?? rec?.cwd ?? this.opts.defaultCwd ?? process.cwd(),
      cols: o.cols ?? rec?.cols ?? 120,
      rows: o.rows ?? rec?.rows ?? 30,
      retention,
    };
    const shellArgs = o.shellArgs ?? rec?.shellArgs;
    if (shellArgs) out.shellArgs = [...shellArgs];
    const env = o.env ?? rec?.env;
    if (env) out.env = { ...env };
    const integration = o.integration ?? rec?.integration;
    if (integration !== undefined) out.integration = integration;
    const userRc = o.userRc ?? rec?.userRc;
    if (userRc !== undefined) out.userRc = userRc;
    return out;
  }

  private hotStore(retention: SessionRetention): MemoryStore {
    // The ring never retains more than the disk would: retention bounds exposure (G21, G26).
    return new MemoryStore(Math.min(this.opts.memoryBytes ?? DEFAULT_MEMORY_BYTES, retention.maxBytes ?? Infinity), retention.maxAgeMs !== undefined ? { maxAgeMs: retention.maxAgeMs } : {});
  }

  /** The daemon's log, naming the session, for what its journal has to say about its disk. */
  private journalLog(id: string): JournalOptions['log'] {
    const log = this.opts.log;
    return log ? (level, text) => log(level, text, { session: id }) : undefined;
  }

  private storeOptions(retention: Retention): FileStoreOptions {
    return this.floor ? { ...retention, floor: this.floor } : retention;
  }

  /** Requested over recorded over daemon defaults. A bad request is refused; a bad record falls back. */
  private retentionFor(requested: Retention | undefined, recorded: Retention | undefined): SessionRetention {
    const d = this.opts.retention ?? {};
    const ok = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min;
    if (requested?.maxBytes !== undefined && !ok(requested.maxBytes, MIN_DISK_BYTES)) {
      throw err('invalid_argument', `retention.maxBytes must be a number ≥ ${MIN_DISK_BYTES}`, { maxBytes: requested.maxBytes });
    }
    if (requested?.maxAgeMs !== undefined && !ok(requested.maxAgeMs, MIN_AGE_MS)) {
      throw err('invalid_argument', `retention.maxAgeMs must be a number ≥ ${MIN_AGE_MS}`, { maxAgeMs: requested.maxAgeMs });
    }
    const pick = (a: unknown, b: unknown, c: unknown, min: number) => [a, b, c].find((v): v is number => ok(v, min));
    const r: SessionRetention = {};
    const maxBytes = pick(requested?.maxBytes, recorded?.maxBytes, d.maxBytes, MIN_DISK_BYTES);
    const maxAgeMs = pick(requested?.maxAgeMs, recorded?.maxAgeMs, d.maxAgeMs, MIN_AGE_MS);
    if (maxBytes !== undefined) r.maxBytes = Math.floor(maxBytes);
    if (maxAgeMs !== undefined) r.maxAgeMs = Math.floor(maxAgeMs);
    return r;
  }

  // ───────────── lookup ─────────────

  get(id: string): AnySession | undefined {
    return this.slots.get(id)?.view;
  }

  live(id: string): Session {
    const s = this.slots.get(id)?.view;
    if (!s) throw err('session_not_found', `session ${id} not found`, { id });
    if (s.kind !== 'live') {
      const why = s.closed ? 'was closed' : 'has no shell (its daemon stopped; the history was recovered)';
      throw err('session_exited', `session ${id} ${why}; its journal is readable, and its owner can open it again, which starts a new life of the name`, { id });
    }
    return s.session;
  }

  list(): AnySession[] {
    return [...this.slots.values()].map((s) => s.view);
  }

  // ───────────── close and remove ─────────────

  /**
   * End a live session's shell and keep its journal readable as a history entry
   * (`closed: true`; G19). Closing a history entry changes nothing; `remove`
   * deletes one.
   */
  async close(id: string, opts: { graceful?: boolean; reason?: string } = {}): Promise<void> {
    return this.withLock(fold(id), async () => {
      const slot = this.slots.get(id);
      if (!slot) throw err('session_not_found', `session ${id} not found`, { id });
      if (slot.view.kind === 'history') return;
      try {
        await this.closeLive(slot, { ...opts, persist: true });
      } finally {
        this.emit({ type: 'closed', id });
      }
    });
  }

  /**
   * Close every live session (daemon shutdown). They reappear after a restart as history-only,
   * not closed. Cursors are flushed and the data dir's lock released last.
   */
  async closeAll(opts: { graceful?: boolean; reason?: string } = {}): Promise<void> {
    const keys = new Set([...this.slots.keys()].map(fold));
    for (const k of this.locks.keys()) keys.add(k);
    await Promise.all(
      [...keys].map((key) =>
        this.withLock(key, async () => {
          for (const slot of [...this.slots.values()]) {
            if (fold(slot.id) !== key || slot.view.kind !== 'live') continue;
            try {
              await this.closeLive(slot, { ...opts, persist: false });
            } catch {
              // closeLive has already turned it into history
            }
            this.emit({ type: 'closed', id: slot.id });
          }
        }).catch(() => undefined),
      ),
    );
    this.dispose();
  }

  /**
   * Enforce age retention now (G21, jr2-7): every session's journal ages out what
   * is past its `maxAgeMs` — the hot ring, and the active file too (rotated, then
   * dropped) — live or not; and each history entry whose newest event is past
   * its `maxAgeMs` is removed. The daemon calls this periodically; recovery
   * applies the same rule at startup. Returns the removed ids.
   */
  async expire(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const slot of [...this.slots.values()]) {
      const gone = slot.view.kind === 'history' && expired(slot.store, slot.view.retention, now);
      if (!gone) {
        (slot.view.kind === 'live' ? slot.view.session.journal : slot.view.journal).expire(now);
        continue;
      }
      await this.withLock(fold(slot.id), async () => {
        if (this.slots.get(slot.id) !== slot || slot.view.kind !== 'history') return; // a new life started meanwhile
        this.drop(slot, slot.view);
        removed.push(slot.id);
      });
    }
    return removed;
  }

  /** Delete a history entry and its files — the journal, and its command files under /tmp (jr2-12). The application layer checks the `destroy` verb. */
  async remove(id: string): Promise<void> {
    return this.withLock(fold(id), async () => {
      const slot = this.slots.get(id);
      if (!slot) throw err('session_not_found', `session ${id} not found`, { id });
      if (slot.view.kind === 'live') throw err('invalid_argument', `session ${id} is live; close it before removing it`, { id });
      this.drop(slot, slot.view);
    });
  }

  /** A history entry and its files go. */
  private drop(slot: Slot, view: HistoryEntry): void {
    view.journal.close();
    slot.cursors.cancel();
    this.removeFiles(slot.id, slot.dir);
    this.slots.delete(slot.id);
    this.emit({ type: 'removed', id: slot.id });
  }

  /** A name's files: its session directory and its command directory (command text, G26). */
  private removeFiles(id: string, dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    removeCommandDir(this.opts.dataDir, id);
  }

  private async closeLive(slot: Slot, o: { graceful?: boolean; reason?: string; persist: boolean }): Promise<void> {
    const live = slot.view as LiveEntry;
    const journal = live.session.journal;
    const co: CloseOptions = { graceful: o.graceful ?? true };
    if (o.reason !== undefined) co.reason = o.reason;
    try {
      await live.session.close(co);
    } finally {
      live.cleanup();
      // A Run the session could not end before its shell went is `lost`, never `running` (G3);
      // whatever it would journal later is refused by the sealed journal (jr-10).
      const now = Date.now();
      for (const r of journal.runs.open()) {
        journal.append({ type: 'run.end', runId: r.runId, state: 'lost', reason: 'session-closed', durationMs: Math.max(0, now - (r.startedAt ?? r.admittedAt)) });
      }
      journal.seal();
      slot.cursors.merge(live.session.cursorsSnapshot());
      slot.cursors.flush();
      if (o.persist) {
        slot.meta = { ...slot.meta, closedAt: Date.now() };
        try {
          writeMeta(slot.dir, slot.meta);
        } catch {
          // the history is still readable; after a restart it reads as history-only
        }
      }
      slot.view = new HistoryEntry(slot.id, journal, live.session.owner, live.session.visibility, o.persist, live.retention, live.options, slot.cursors);
    }
  }

  /** Run `fn` after every earlier operation on the same folded name; the reservation is taken synchronously. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.locks.set(key, tail);
    return prev.then(fn).finally(() => {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
  }
}

/**
 * A Run whose process group may still have members: one in flight, one that ended with children
 * left behind (`leftovers`), or one cancelled or lost, whose end says nothing about its group. Not
 * one that exited with its group empty, as its session saw: anything of that id now is a stranger's.
 */
function mayHoldGroup(run: RunInfo): boolean {
  return run.pgid !== undefined && (run.state !== 'exited' || run.leftovers === true);
}

/** A Run recovery may end a group for: its key (`<session>\0<runId>`) and the last event its dead daemon wrote. */
export interface OrphanCandidate {
  key: string;
  run: RunInfo;
  lastTs: number | undefined;
}

/**
 * Which of the candidates' process groups recovery signals, from a listing of the machine's
 * processes: per group, the keys of the Runs it belonged to. Pure, so its rules are tested without
 * a signal (the house's read of 2c35df8, #22). Never the daemon's own pid or group, and never a
 * group below 2: `kill(-1)` reaches every process the daemon may signal.
 *
 * A group is the Run's when its leader started with the Run — not before, not after: pids are
 * reused, and `ps` start times are truncated to the second — and the Run has not ended: its own
 * process was reaped before its end was written, so a leader now holds the freed pid. With the
 * leader gone, the kernel keeps a group's id while a member lives, so the members are descendants
 * of whoever led it: the Run's, when none predates the Run and none started after the Run ended;
 * for a Run still in flight, when one predates the dead daemon's last event by a second, so the
 * group is not one formed after the daemon died.
 */
export function orphanGroups(candidates: OrphanCandidate[], procs: ProcessRow[], self: { pid: number; pgid: number | undefined }): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const { key, run, lastTs } of candidates) {
    const g = run.pgid;
    if (g === undefined || g <= 1 || g === self.pid || g === self.pgid) continue;
    const members = procs.filter((p) => p.pgid === g && !p.zombie);
    if (!members.length) continue;
    const started = run.startedAt ?? run.admittedAt;
    const ended = run.endedAt;
    const leader = members.find((p) => p.pid === g);
    const sinceStart = (p: ProcessRow) => p.startMs >= started - 2000;
    const ours = leader
      ? ended === undefined && sinceStart(leader) && leader.startMs <= started + 1000
      : ended !== undefined
        ? members.every((p) => sinceStart(p) && p.startMs <= ended)
        : members.every(sinceStart) && members.some((p) => p.startMs + 1000 <= (lastTs ?? 0));
    if (ours) groups.set(g, [...(groups.get(g) ?? []), key]);
  }
  return groups;
}

function expired(store: FileStore, retention: SessionRetention, now: number): boolean {
  if (retention.maxAgeMs === undefined) return false; // no age limit: history is kept until forgotten
  const newest = store.newestTs();
  if (newest === undefined) return store.highWater() !== undefined; // every file aged out already
  return newest < now - retention.maxAgeMs;
}

function journalOf(slot: Slot): Journal {
  return slot.view.kind === 'live' ? slot.view.session.journal : slot.view.journal;
}

function ownerOf(slot: Slot): Principal {
  return slot.view.kind === 'live' ? slot.view.session.owner : slot.view.owner;
}

interface Meta {
  owner?: Principal;
  visibility?: Visibility;
  createdAt?: number;
  retention?: Retention;
  /** Set when the owner closed the session; absent while live and when a daemon stopped under it. */
  closedAt?: number;
  /** The creation options every new life reuses (ux-4); retention is recorded above. */
  options?: Omit<SessionCreationOptions, 'retention'>;
  /** In memory only: session.json is there but cannot be read (why). Nothing of the name is reopened until it is repaired or removed. */
  damaged?: string;
}

const damagedRecord = (id: string, why: string): TermError =>
  err('forbidden', `session ${id}'s record (session.json) cannot be read: ${why}; nobody may start a new life for it until the file is repaired or the session is removed`, { id });

/** The recorded options, validated (a damaged or foreign session.json falls back field by field). */
function recordedOptions(meta: Meta, retention: SessionRetention): SessionCreationOptions {
  const o = (meta.options && typeof meta.options === 'object' ? meta.options : {}) as Partial<Record<keyof SessionCreationOptions, unknown>>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const vis = [o.visibility, meta.visibility].find((v): v is Visibility => v === 'private' || v === 'shared') ?? 'private';
  const control = o.control === 'seat' || o.control === 'owner-priority' || o.control === 'open' ? o.control : 'seat';
  const out: SessionCreationOptions = { visibility: vis, control, retention };
  if (str(o.shell)) out.shell = o.shell;
  if (Array.isArray(o.shellArgs) && o.shellArgs.every((a) => typeof a === 'string')) out.shellArgs = [...(o.shellArgs as string[])];
  if (typeof o.login === 'boolean') out.login = o.login;
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    const env = Object.fromEntries(Object.entries(o.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
    out.env = env;
  }
  if (str(o.cwd)) out.cwd = o.cwd;
  if (int(o.cols, 1, 10_000)) out.cols = o.cols;
  if (int(o.rows, 1, 10_000)) out.rows = o.rows;
  if (typeof o.integration === 'boolean') out.integration = o.integration;
  if (typeof o.userRc === 'boolean') out.userRc = o.userRc;
  return out;
}

/**
 * The record beside a journal: `{}` when there is none (a directory an older build made), `damaged`
 * when there is one that cannot be read — never a guess at its owner (the house's read of 2c35df8, #22).
 */
function readMeta(dir: string): Meta {
  const file = path.join(dir, 'session.json');
  try {
    fs.chmodSync(file, 0o600); // written 0644 by an older build (G26)
  } catch {
    // absent
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { damaged: (e as Error).message };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { damaged: 'not a JSON object' };
    return parsed as Meta;
  } catch (e) {
    return { damaged: (e as Error).message };
  }
}

/** Durably, and private to the daemon's user: a crash mid-write never loses the owner (G18, G26); `env` may hold secrets. */
function writeMeta(dir: string, meta: Meta): void {
  const { damaged: _d, ...record } = meta;
  writeDurably(path.join(dir, 'session.json'), JSON.stringify(record, null, 2));
}

/**
 * Write `text` through a temp file beside `file`, synced to disk, then renamed over it, with the
 * directory synced too: after a crash of the process or the machine the file is the old one or the
 * new one, never torn or missing (the house's read of 2c35df8, #22). Owner-only (G26).
 */
function writeDurably(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const data = Buffer.from(text);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
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

/** A session's shell-side files: command files and the shell's own history (0700). */
function shellDir(dir: string): string {
  const d = path.join(dir, 'shell');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const uid = (): number | undefined => (typeof process.getuid === 'function' && process.platform !== 'win32' ? process.getuid() : undefined);

/** `/tmp/tsm-<uid>/<8 hex>` for a name: the path only, nothing created. */
function commandDirPath(dataDir: string, id: string, u: number): { base: string; dir: string } {
  const base = `/tmp/tsm-${u}`;
  return { base, dir: path.join(base, createHash('sha256').update(`${path.resolve(dataDir)}\0${id}`).digest('hex').slice(0, 8)) };
}


/**
 * A short private directory for a session's command files, `/tmp/tsm-<uid>/<8 hex>`: the
 * daemon types ` . '<dir>/tsm-cmd-N'` for every Run and the shell echoes it at the prompt,
 * so transcripts and screens stay readable with a short path. Trusted only when it is a real
 * directory owned by us and closed to others (as tmux checks its socket directory);
 * otherwise `fallback` (the session's own directory).
 */
function commandDir(dataDir: string, id: string, fallback: string): string {
  const u = uid();
  if (u === undefined) return fallback;
  const trusted = (d: string): boolean => {
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    return trustedDir(d, u);
  };
  const { base, dir } = commandDirPath(dataDir, id, u);
  return trusted(base) && trusted(dir) ? dir : fallback;
}

/** Remove a name's command directory when it is ours to remove; never creates anything (jr2-12). */
function removeCommandDir(dataDir: string, id: string): void {
  const u = uid();
  if (u === undefined) return;
  const { base, dir } = commandDirPath(dataDir, id, u);
  if (!trustedDir(base, u) || !trustedDir(dir, u)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a cleaner got there first
  }
}

/**
 * What a life that ended without its own cleanup (a daemon killed mid-Run) left on disk: its
 * command files, which hold command text, and env captures (G26). The session's own shell
 * history stays: it is the session's.
 */
function removeLeftovers(dataDir: string, id: string, dir: string): void {
  removeCommandDir(dataDir, id);
  const shell = path.join(dir, 'shell');
  let names: string[];
  try {
    names = fs.readdirSync(shell);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^tsm-(cmd|env)-/.test(n)) continue;
    try {
      fs.rmSync(path.join(shell, n), { force: true });
    } catch {
      // not ours to fix
    }
  }
}
