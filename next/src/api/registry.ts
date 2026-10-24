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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionBackend } from '../backends/types.js';
import { configuredEnv } from '../core/env.js';
import { clocks } from '../core/clock.js';
import { err, TermError } from '../core/errors.js';
import { Journal, reservationHonoured, type JournalOptions } from '../core/journal.js';
import { acquireDataDirLock, groupAlive, listProcesses, sleepSync, type DataDirLock, type ProcessRow } from '../core/lock.js';
import { RunIndex, type RunOutput, type RunOutputRange } from '../core/runindex.js';
import { Session, assertPrivateSessionDir, assertTypedCommandDir, type SessionOptions } from '../core/session.js';
import { FileStore, FreeSpaceFloor, MemoryStore, syncDir, type DiskFloor, type DurableWrite, type FileStoreOptions, type Retention, writeDurably } from '../core/stores.js';
import { DEFAULT_GEOMETRY, SYSTEM, type ControlPolicy, type Cursors, type JournalEvent, type Principal, type RunInfo, type Seq, type Visibility } from '../core/types.js';
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
  /**
   * Tests only: the process listing recovery judges groups by (default: the machine's, listProcesses).
   * A spec drives the Linux rows (start ticks, boot id) or a listing that stops answering through it.
   */
  listProcesses?: () => ProcessRow[] | undefined;
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
/** The one rule for a session name: 1 to 64 characters of [A-Za-z0-9._-], starting alphanumeric; the endpoint checks it too. */
export const isSessionId = (id: string): boolean => SAFE_ID.test(id);
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
  /** This session's cursor directory could not be synced, and the log has said so: once per session for as long as the registry keeps its book (across its lives), since the file holds the cursors and rewriting changes nothing. */
  private syncWarned = false;
  /** The name's files are being removed: nothing more is written, whatever a gone life still reports. */
  private cancelled = false;

  constructor(
    private readonly file: string,
    private readonly log?: RegistryOptions['log'],
  ) {
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

  /** Merge each field from a Session's report: an earlier life can still report an older full snapshot. */
  set(principal: Principal, c: Cursors): void {
    if (this.cancelled) return;
    const cur = this.map.get(principal);
    const next = { delivered: Math.max(cur?.delivered ?? 0, c.delivered), read: Math.max(cur?.read ?? 0, c.read) };
    if (cur && cur.delivered === next.delivered && cur.read === next.read) return;
    this.map.set(principal, next);
    this.schedule();
  }

  advance(principal: Principal, field: keyof Cursors, seq: Seq): void {
    const c = this.get(principal);
    if (!(seq > c[field])) return;
    c[field] = seq;
    this.set(principal, c);
  }

  merge(all: Record<Principal, Cursors>): void {
    for (const [p, c] of Object.entries(all)) this.set(p, c);
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
      const w = writeDurably(this.file, JSON.stringify(this.snapshot()));
      // Written, but the directory could not be synced (a real fsync error): the file holds the cursors, so
      // rewriting them changes nothing — said once per session, not retried forever; cursors are advisory (comment 6274603516).
      if (!w.synced && !this.syncWarned) {
        this.syncWarned = true;
        this.log?.('warn', `cursors are written but their directory could not be synced: ${w.error?.message ?? 'unknown error'}`, { file: this.file });
      }
    } catch {
      this.dirty = true; // not written: the directory may be gone (forgotten) or the disk full, so the next flush retries
    }
  }

  /**
   * Stop without writing (the session's files are being removed), for good: a forgotten life's Session can
   * still settle a late delivery, and its book wrote the old cursors into the cursors.json a re-created name's
   * new book owns, which a restart then read for the new journal (the house's read of 4f4c067, #22).
   */
  cancel(): void {
    this.cancelled = true;
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
  /**
   * Recovery left a Run's process group unjudged (no process listing answered), or never read the name's
   * journal (it opened later, for a new life): the name's history, and with it the Run's record of its
   * group, is neither aged nor removed by `expire`, and its store takes no retention, in this life or a new
   * one and when its record is repaired, until the next recovery, which judges it when it can list
   * processes (the house's read of the 33 commits, PR #22, comment 6307350477, item 3).
   */
  awaitsJudgement?: true;
}

/**
 * A journal opened by recovery, before its in-flight Runs are ended; `last` is the store's newest whole
 * event, and `lastAliveTs` when the dead daemon was last known alive (see `lastAlive`). `gone`: past its
 * retention, so its files go — once its Runs' process groups have been ended with every other session's
 * (the house's read of 2c35df8, #22).
 */
type Recovering = Omit<Slot, 'cursors' | 'view' | 'awaitsJudgement'> & { retention: SessionRetention; journal: Journal; last: JournalEvent | undefined; lastAliveTs: number | undefined; gone: boolean };

/**
 * What recovery did with a Run's process group: `text` names it, absent when there is nothing to say (a
 * listing showed the group had no process left); `left` is true when the group was left running (a reused
 * pgid it could not tie to the Run, a group whose tied processes are gone while another holds it, or no
 * process listing to tell by); and `unjudged` when nothing judged it (no listing, before the signal or
 * after it): the Run then stays a candidate, so a later recovery that can list processes judges the group,
 * bounded by the dead daemon's last evidence.
 */
type GroupOutcome = { text?: string; left: boolean; unjudged?: true };

/** A name whose record cannot be read has no known owner: nobody may reopen it until the record is repaired or the session removed. */
const UNOWNED: Principal = 'unknown';

/**
 * The one text for a name whose shell is gone (G19, G30): why — closed by its owner, left by a daemon
 * that stopped, or a shell that exited — that its history still reads, and who starts a new life of
 * the name: the caller (`canReopen`), only its owner (false), or its owner, when the caller is not
 * known (undefined). The App and the registry both say it. The live case is reached: an entry whose
 * shell exited stays live until its owner starts a new life, and the App's `newLifeOwner` refuses
 * anyone else with this text meanwhile.
 */
export function endedMessage(s: AnySession, canReopen: boolean | undefined): string {
  const id = s.kind === 'live' ? s.session.id : s.id;
  const owner = s.kind === 'live' ? s.session.owner : s.owner;
  const why = s.kind === 'live' ? 'has ended (its shell exited)' : s.closed ? 'was closed' : 'has no shell (its daemon stopped; the history was recovered)';
  const again = canReopen ? 'session_open starts a new shell under this name' : `${canReopen === false ? 'only ' : ''}its owner (${owner}) can start a new shell under this name`;
  return `session ${id} ${why}; its history is readable with read, and ${again}`;
}

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
  /** Names whose record was written while its directory could not be synced: said once per name, again only for a name removed and made anew (noteUnsynced). */
  private readonly recordSyncSaid = new Set<string>();
  /** Session directories recovery could not read at startup (skipped, left on disk). */
  readonly recoveryErrors: Array<{ id: string; error: string }> = [];

  /** Whether this host can open sessions and run process Runs at all (ExecutionBackend.processSupport), for /health. */
  processSupport(): { ok: true } | { ok: false; reason: string } {
    return this.opts.backend.processSupport?.() ?? { ok: true };
  }

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
    // A directory made here is in its parent durably only once that parent is synced: on a first start, a
    // power loss soon after could take sessions/ with every reservation its stores had synced. A store
    // syncs the directories it makes itself (makeDirs); the data dir, any parent of it, and sessions/ are made
    // here, before any store opens. Each directory on that path is synced into its parent at every start, not
    // only by the start that made it: a start that made some and died before this (one that lost the lock to a
    // start racing it onto a new data dir, say) left them unsynced, and nothing on disk says which they are
    // (the house's reviews of 4f4c067..a8b6f28 and a8b6f28..4860d4c, PR #22). One directory sync for each level
    // of the data dir's path, and one for sessions/. A parent this user cannot read (a root-owned /home at 0751,
    // say) cannot be opened to sync, and termd never makes one, since its own are 0700: its EACCES is passed
    // over, though the entry in it may be one termd made, which then stays unsynced without a warning.
    const dirs: string[] = [path.resolve(this.root)];
    for (let d = path.resolve(opts.dataDir); path.dirname(d) !== d; d = path.dirname(d)) dirs.unshift(d);
    let unsynced: [string, NodeJS.ErrnoException] | undefined;
    for (const d of dirs) {
      const error = syncDir(d);
      if (error && error.code !== 'EACCES') unsynced ??= [d, error];
    }
    if (unsynced) this.opts.log?.('warn', `a directory on the data dir's path could not be synced into its parent (${unsynced[0]}): ${unsynced[1].message}; a power loss soon after this start can take it, with everything under it`, { dataDir: opts.dataDir });
    this.recover();
  }

  /** Hold the data dir's lock (again, after `closeAll` released it) before writing to the data dir. */
  private ensureLock(): void {
    if (this.opts.lock === false || this.dirLock) return;
    this.dirLock = acquireDataDirLock(this.opts.dataDir);
    // A lock whose holder is gone means the previous daemon did not drain: said in the log, not only by what recovery does next (the house's read of 59f660b, #22).
    const stale = this.dirLock.tookOver;
    if (stale) this.opts.log?.('warn', 'took over the data dir lock of a daemon that is gone (it did not drain)', { pid: stale.pid, startedAt: stale.startedAt !== undefined ? new Date(stale.startedAt).toISOString() : undefined, hostname: stale.hostname });
    // Said once per take of the lock — at the start, and again only when a new life takes it back after closeAll
    // released it — since the lock itself has no log (a reviewer's read of the fixes for #22 comment 6269992150).
    // The fallback writes termd.lock under the takeover guard, so no taker judges it while it is written: no
    // window is left for an age guard to cover (the house's read of the 33 commits, PR #22, comment 6307349700).
    if (this.dirLock.noHardLinks) this.opts.log?.('warn', "the data dir's filesystem has no hard links: the lock was created by an exclusive write under its takeover guard instead of link()", { dataDir: this.opts.dataDir });
    // A real fsync error on the lock's directory (EIO): the lock is held; one that vanishes after a crash is taken anew
    // (comment 6274603516). Said once per take, as above.
    if (this.dirLock.unsynced) this.opts.log?.('warn', 'the data dir lock is taken but its directory could not be synced; a lock that vanishes after a crash is simply taken anew', { dataDir: this.opts.dataDir });
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
   * removed only after that: its Runs' groups are ended like any other's, and
   * one whose groups no process listing judged is kept until a recovery does.
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
    // A record that cannot be read names no retention to trust: none is applied, so the store prunes
    // nothing a repair (which the refusal invites) could bring back; the real retention is applied once a
    // valid record reads (rereadRecord / newLife). The house's read of the 36 commits, #22 (comment
    // 6269992150): the default pruned before finishRecovery refused the name.
    const retention = recordRefusal(id, meta) ? {} : this.retentionFor(undefined, meta.retention);
    // The store opens with no retention, whatever the record says: a store applies the retention it is
    // given at once, and pruned at open, the files that name a Run's process group went before recovery
    // judged it. The record's is applied once recovery is done with the session (finishRecovery). The
    // house's read of the 33 commits, PR #22, comment 6307350477; an independent read of the fix.
    const store = new FileStore(dir, this.storeOptions(id, {}));
    const gone = expired(store, retention, Date.now());
    // The last event the dead daemon wrote, read before the journal opens: opening a journal over a torn
    // last line (or a failed high water) appends a gap stamped with this recovery's time, and read after
    // that, `last` was the gap — so lastAliveTs and the orphan bound became the recovery's own clock,
    // which let a stranger's reused group read as a Run's (a reviewer's read of the fixes for #22
    // comment 6269992150). The store has already cut a torn tail at open, so this is the last whole event;
    // a header-only file gives undefined, and still reaches endOrphans below. The evidence itself passes
    // over what an earlier recovery wrote before it too died (see lastAlive).
    const last = store.tail(1)[0];
    const lastAliveTs = lastAlive(store);
    // The journal is opened before the store is judged empty: a file holding only a rotation header
    // has no last seq, yet the header names Runs still open, whose process groups recovery must end.
    // Age retention had dropped every file but the header-bearing one, so recovery returned here and
    // the session was removed with its processes running (the house's read of the 36 commits, #22,
    // comment 6269992150). Past its retention too, the journal is opened: its run index names the
    // process groups to end (the house's read of 2c35df8, #22).
    const journal = new Journal({ hot: this.hotStore(retention), cold: store, sessionId: id, log: this.journalLog(id) });
    if (!holdsHistory(store, journal.runs)) {
      journal.close();
      // No events, no open Runs and no reservation above them: nothing to recover. Past its retention (every
      // file aged out), the files go.
      if (gone) this.removeFiles(dir);
      return undefined;
    }
    // Nothing runs under this name now: a dead life's command files (command text, env captures) go (jr2-12,
    // G26) — from a session past its retention too, which is kept when its Runs' groups go unjudged.
    const skippedCleanup = removeLeftovers(dir);
    if (skippedCleanup) this.opts.log?.('warn', skippedCleanup, { session: id });
    return { id, dir, store, meta, retention, journal, last, lastAliveTs, gone };
  }

  private finishRecovery(r: Recovering, ended: Map<string, GroupOutcome>): void {
    const { id, dir, store, meta, retention, journal, last, lastAliveTs } = r;
    // A Run whose group no listing judged: removed, the session would leave a later recovery that can
    // list processes nothing naming the group, which the README says such a recovery judges (the
    // house's read of the 33 commits, PR #22, comment 6307350477, item 3).
    const unjudged = journal.runs.list().some((run) => ended.get(`${id}\0${run.runId}`)?.unjudged);
    if (r.gone && !unjudged) {
      // Past its retention: the whole session expires (G21, G26), now that its Runs' groups are ended.
      journal.close();
      this.removeFiles(dir);
      return;
    }
    if (r.gone) this.opts.log?.('warn', "a session past its retention is kept: no process listing answered, so its Runs' process groups are not judged; a recovery that can list processes judges them, and the session expires after that", { session: id });
    // Every Run in flight when the daemon died — running, starting, queued, or named only by a
    // rotation header because its admission rotated out — is `lost`, never `running` (G3, G20). The
    // end is marked `recoveredEnd` (its time is the recovery's), and `groupJudged` once recovery has
    // judged its group, so a later restart does not judge a reused pgid as the Run's (comment 6269992150).
    const now = Date.now();
    const lost = new Set<string>();
    for (const run of journal.runs.open()) {
      const outcome = ended.get(`${id}\0${run.runId}`);
      const ev: Parameters<Journal['append']>[0] = {
        type: 'run.end',
        runId: run.runId,
        state: 'lost',
        // A group left running is recorded in a note, not in the Run's reason: it was not the Run's to end.
        reason: outcome?.text !== undefined && !outcome.left ? `daemon-restart; ${outcome.text}` : 'daemon-restart',
        // The wall clock's estimate: no monotonic reference survives the dead daemon (RunInfo.durationMs).
        durationMs: Math.max(0, now - (run.startedAt ?? run.admittedAt)),
        recoveredEnd: true,
      };
      if (outcome && !outcome.unjudged) ev.groupJudged = true;
      // The dead daemon's last evidence, kept on the end: a recovery that could not judge the group (no
      // process listing) leaves the Run a candidate, and the next recovery must bound its group by when
      // the daemon died, not by this recovery's time (comment 6269992150, item 2).
      if (lastAliveTs !== undefined) ev.lastAliveTs = lastAliveTs;
      journal.append(ev);
      lost.add(run.runId);
    }
    // In the daemon's log too, not only in the journal (the house's read of 59f660b, #22).
    if (lost.size) this.opts.log?.('info', 'recovery ended Runs a previous daemon left in flight', { session: id, runs: [...lost] });
    // What became of each group, in the journal: a group recovery left running because it could not be
    // told from a stranger's reuse of the id (comment 6269992150); a Run that had ended before the daemon
    // died left its group behind (`leftovers`), and it outlived the Run; a Run recovery itself ended `lost`
    // just now went with its group — not "outlived …, which had ended", which the first wording said of
    // both (the house's read of cc8c909..39787b3, #22). So did a Run an earlier recovery ended lost without
    // judging its group: that end observed no exit, and its group is judged as the in-flight Run's was
    // (comment 6323055715, question 6).
    for (const run of journal.runs.list()) {
      const outcome = run.endedAt !== undefined ? ended.get(`${id}\0${run.runId}`) : undefined;
      if (!outcome) continue;
      if (outcome.text !== undefined) {
        const text = outcome.left
          ? `recovery: ${outcome.text} · ${run.runId}`
          : lost.has(run.runId)
            ? `recovery: ${outcome.text} with ${run.runId}, which recovery ended lost`
            : recoveryEnded(run)
              ? `recovery: ${outcome.text} with ${run.runId}, which an earlier recovery ended lost`
              : `recovery: ${outcome.text}; it outlived ${run.runId}, which had ended`;
        journal.append({ type: 'note', text, principal: SYSTEM });
      }
      // A Run that had ended before the daemon died (leftovers) keeps its own end: the judgement is
      // recorded as its own event, which the run index folds into groupJudged, so a later restart does
      // not judge the group again with another note and warning (a reviewer's read of the fixes for #22
      // comment 6269992150). A Run recovery ended lost just now carries it on its end.
      if (!lost.has(run.runId) && !outcome.unjudged) journal.append({ type: 'run.judged', runId: run.runId });
    }
    // Mark the restart once: a session closed on purpose, or history since an earlier restart, gains nothing.
    if (meta.closedAt === undefined && last?.type !== 'recovered') journal.append({ type: 'recovered', class: 'history-only' });
    // Its groups judged, the history is kept under its record's retention from here on; one whose groups no
    // listing judged keeps every file until a recovery does, as expire leaves it (see awaitsJudgement).
    if (!unjudged) store.setRetention(retention);
    journal.seal();
    // A record that cannot be read, or that is not there, names no owner. The name is nobody's to
    // reopen until the record is repaired or written or the session removed — not the system
    // principal's by default, which let anyone acting as the system start a new life on it (the
    // house's read of 2c35df8, #22), and with no record made its owner a stranger to it (the house's
    // read of cc8c909..39787b3, #22).
    const refusal = recordRefusal(id, meta);
    if (refusal) this.opts.log?.('warn', refusal.message, { session: id });
    const owner = refusal ? UNOWNED : meta.owner ?? SYSTEM;
    const cursors = new CursorBook(path.join(dir, 'cursors.json'), this.opts.log);
    const view = new HistoryEntry(id, journal, owner, meta.visibility ?? 'private', meta.closedAt !== undefined, retention, recordedOptions(meta, retention), cursors);
    this.slots.set(id, { id, dir, store, meta, cursors, view, ...(unjudged && { awaitsJudgement: true as const }) });
  }

  /** Whether recovery judges the process groups a dead daemon left (G19c): not over a scripted backend unless asked, and not on Windows. */
  private judgesGroups(): boolean {
    return (this.opts.terminateOrphans ?? this.opts.backend.kind !== 'scripted') && process.platform !== 'win32';
  }

  /**
   * The process groups a dead daemon left running (G19c: without the keeper, live processes do not
   * survive a restart) — of its Runs in flight, and of Runs that had ended leaving children in their
   * group, which the live daemon's own shutdown drain would have ended (the house's read of 2c35df8,
   * #22): SIGTERM, then SIGKILL after 2 s, bounded for every session together. Which groups are a
   * Run's is `orphanGroups`'s rule. Returns what became of each group, per `<session>\0<runId>`.
   */
  private endOrphans(open: Recovering[]): Map<string, GroupOutcome> {
    const out = new Map<string, GroupOutcome>();
    if (!this.judgesGroups()) return out;
    const candidates = open.flatMap((r) => r.journal.runs.list().filter(mayHoldGroup).map((run) => ({ key: `${r.id}\0${run.runId}`, run, lastTs: r.lastAliveTs })));
    if (!candidates.length) return out;
    const list = this.opts.listProcesses ?? listProcesses;
    const procs = list();
    if (!procs) return this.leaveUnlisted(candidates, out);
    const groups = orphanGroups(candidates, procs, { pid: process.pid, pgid: procs.find((p) => p.pid === process.pid)?.pgid });
    // The candidate groups with a living member that are not the Run's: left running, and recorded as such
    // (comment 6269992150) — from pgids and start times they cannot be told from a stranger's group that
    // reused the id, so leaving them is the right default, but it is no longer silent. A group the listing
    // shows without a process is judged gone, with nothing to say: unjudged, a later restart whose listing
    // showed a stranger in the pgid wrote "left running" to the history and warned (the house's read of the
    // 33 commits, PR #22, comment 6307350477, item 4).
    const leftKeys = new Map<string, number>();
    for (const { key, run } of candidates) {
      const g = run.pgid;
      if (g === undefined || groups.has(g)) continue;
      if (procs.some((p) => p.pgid === g && !p.zombie)) leftKeys.set(key, g);
      else out.set(key, { left: false });
    }
    for (const [key, g] of leftKeys) out.set(key, { text: `process group ${g} left running (it cannot be told apart from a stranger's group that reused the id)`, left: true });
    if (leftKeys.size) {
      this.opts.log?.('warn', 'recovery left process groups it could not tie to a Run (a reused pgid cannot be told from the Run\'s)', {
        groups: [...new Set(leftKeys.values())],
        sessions: [...new Set([...leftKeys.keys()].map((k) => k.slice(0, k.indexOf('\0'))))],
      });
    }
    if (!groups.size) return out;
    const signal = (g: number, sig: NodeJS.Signals) => {
      try {
        process.kill(-g, sig);
      } catch {
        // gone already
      }
    };
    // Still ours to signal: a group that holds a member recovery judged — the same process, by pid and
    // start (see heldGroups) — or one that joined while such a member lived. Not a wall-clock window
    // around the judgment, which let a stranger's group formed within its slack pass and a clock step
    // during the grace misjudge either way; and with no listing, nothing: no SIGKILL goes by pgid alone
    // (the house's read of the 38 commits, PR #22, comment 6274857431, item 4). The deadline is on the
    // monotonic clock, which a wall-clock step cannot move (comment 6269992150).
    let known = new Map([...groups.keys()].map((g) => [g, procs.filter((p) => p.pgid === g && !p.zombie)] as const));
    // The groups no listing answered for after a signal, and which signal was the last they got.
    const unchecked = new Map<number, NodeJS.Signals>();
    // The groups whose processes recovery tied to the Run are gone while the group still holds one it cannot
    // tie (a TERM trap's new process, or a stranger's in a reused id), and the last signal they got: left
    // running, not "terminated" (the house's read of the 33 commits, PR #22, comment 6307350477, item 2).
    const untied = new Map<number, NodeJS.Signals>();
    // A group set aside as untied whose last process has gone since, by the probe or by a listing taken for
    // the groups still signalled, ended during the wait: not left running (the house's read of the 33
    // commits, PR #22, comment 6307350477; an independent read of the fix).
    const settle = (now: ProcessRow[] | undefined): void => {
      for (const g of [...untied.keys()]) if (!groupAlive(g) || (now !== undefined && !now.some((p) => p.pgid === g && !p.zombie))) untied.delete(g);
    };
    const stillOurs = (gs: number[], sent: NodeJS.Signals): number[] => {
      // A signal probe first (no listing): a group with no process at all is gone.
      const alive = gs.filter(groupAlive);
      if (!alive.length) {
        settle(undefined);
        return alive;
      }
      const now = list();
      settle(now);
      if (!now) {
        for (const g of alive) unchecked.set(g, sent);
        return [];
      }
      known = heldGroups(new Map(alive.flatMap((g) => (known.has(g) ? [[g, known.get(g)!] as const] : []))), now);
      for (const g of alive) if (!known.has(g) && now.some((p) => p.pgid === g && !p.zombie)) untied.set(g, sent);
      return [...known.keys()];
    };
    const waitGone = (gs: number[], ms: number, sent: NodeJS.Signals): number[] => {
      const until = clocks.monotonic() + ms;
      let left = stillOurs(gs, sent);
      while (left.length && clocks.monotonic() < until) {
        sleepSync(50);
        left = stillOurs(left, sent);
      }
      return left;
    };
    const all = [...groups.keys()];
    for (const g of all) signal(g, 'SIGTERM');
    const stubborn = waitGone(all, ORPHAN_TERM_MS, 'SIGTERM');
    for (const g of stubborn) signal(g, 'SIGKILL');
    const survivors = new Set(waitGone(stubborn, ORPHAN_KILL_MS, 'SIGKILL'));
    for (const [g, keys] of groups) {
      const sent = unchecked.get(g);
      const strayed = untied.get(g);
      // A group no listing answered for after its signal is not known to have ended: the Run stays a
      // candidate, as with no listing at all, so a later recovery that can list processes judges the group
      // (the house's read of the 33 commits, PR #22, comment 6307350477, item 1). A group that survived
      // SIGKILL is judged: a listing tied it to the Run, and what outlives the SIGKILL is a member the kernel
      // cannot end yet (uninterruptible sleep, which the pending SIGKILL ends when it wakes) or one the daemon
      // may not signal (another user's, as a command sudo runs as root is). A later recovery could send
      // nothing more, only spend its grace on it at every restart; the end and the log say it survived.
      const outcome: GroupOutcome = survivors.has(g)
        ? { text: `process group ${g} survived SIGKILL`, left: false }
        : sent === 'SIGTERM'
          ? { text: `process group ${g} was sent SIGTERM and not SIGKILL: no process listing answered after it, so whether it ended is not known`, left: false, unjudged: true }
          : sent
            ? { text: `process group ${g} was sent SIGKILL: no process listing answered after it, so whether it ended is not known`, left: false, unjudged: true }
            : strayed
              ? { text: `process group ${g} left running: it was sent ${strayed}, and the processes recovery tied to the Run are gone, but the group still holds one recovery cannot tie to it (a new process, or a stranger's that reused the id)`, left: true }
              : { text: `process group ${g} terminated`, left: false };
      for (const k of keys) out.set(k, outcome);
    }
    // The drain logs its kills; so does recovery (the house's read of 59f660b, #22).
    this.opts.log?.('warn', 'recovery ended process groups a previous daemon left running', {
      groups: all.filter((g) => !survivors.has(g) && !unchecked.has(g) && !untied.has(g)),
      survivedSigkill: survivors.size ? [...survivors] : undefined,
      unchecked: unchecked.size ? [...unchecked.keys()] : undefined,
      leftRunning: untied.size ? [...untied.keys()] : undefined,
      sessions: [...new Set([...groups.values()].flat().map((k) => k.slice(0, k.indexOf('\0'))))],
    });
    return out;
  }

  /**
   * No process listing answered: nothing can tell whose a group is, so every process is left alone and
   * no Run is marked judged. Each candidate whose group still has a process gets a note in its history,
   * and the log says it once, in the words used for a group left for a reused pgid (comment 6269992150,
   * item 6): it returned without a word before, so a group the README says recovery "ends none" of left
   * nothing behind to say so (a reviewer's read of the fixes for #22).
   */
  private leaveUnlisted(candidates: OrphanCandidate[], out: Map<string, GroupOutcome>): Map<string, GroupOutcome> {
    const left = candidates.filter((c) => groupAlive(c.run.pgid!));
    for (const { key, run } of left) out.set(key, { text: `process group ${run.pgid} left running (no process listing answered, so whose group it is cannot be told)`, left: true, unjudged: true });
    if (left.length) {
      this.opts.log?.('warn', 'recovery left process groups it could not tie to a Run (no process listing answered, so it ended none)', {
        groups: [...new Set(left.map((c) => c.run.pgid))],
        sessions: [...new Set(left.map((c) => c.key.slice(0, c.key.indexOf('\0'))))],
      });
    }
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

  /** Refuse a name that folds onto another one, whose record names no owner, or whose history is someone else's (G18). */
  private checkName(o: CreateOptions, slot: Slot | undefined): void {
    if (slot) {
      // A record that named no owner is read again at every attempt: repaired, or written where there
      // was none, it names the owner without a restart of the daemon, as the refusal says (the house's
      // read of cc8c909..39787b3, #22).
      let refusal = recordRefusal(o.id, slot.meta);
      if (refusal) {
        this.rereadRecord(slot);
        refusal = recordRefusal(o.id, slot.meta);
      }
      if (refusal) throw refusal;
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

  /**
   * Re-read a name's record from disk when it is refused (damaged or missing), and return its current
   * view. The App calls this before judging a new life's owner, so a repaired record names the owner
   * without a restart for every caller, not only the system (the house's read of the 36 commits, #22,
   * comment 6269992150). A no-op when the record already reads, or the name is live or unknown.
   */
  rereadIfRefused(id: string): AnySession | undefined {
    const slot = this.slots.get(id);
    if (slot && recordRefusal(slot.id, slot.meta)) this.rereadRecord(slot);
    return slot?.view;
  }

  /** Read a history entry's record again; one that reads now gives the entry its owner, visibility and options. */
  private rereadRecord(slot: Slot): void {
    const meta = readMeta(slot.dir);
    slot.meta = meta;
    if (recordRefusal(slot.id, meta) || slot.view.kind !== 'history') return;
    const v = slot.view;
    // The retention is the record's now, not the default (nor the retention-off) chosen while the
    // record was unreadable, and it is applied to the store too — not only reported — so the history is
    // kept under what the record says (the house's read of the 36 commits, #22, comment 6269992150).
    const retention = this.retentionFor(undefined, meta.retention);
    // Not while recovery owes the name a judgement: pruned now, the files that name its Runs' process groups
    // would be gone before the recovery that can list processes reads them (see awaitsJudgement).
    if (!slot.awaitsJudgement) slot.store.setRetention(retention);
    slot.view = new HistoryEntry(slot.id, v.journal, meta.owner ?? SYSTEM, meta.visibility ?? 'private', meta.closedAt !== undefined, retention, recordedOptions(meta, retention), slot.cursors);
    this.opts.log?.('info', 'session record reads again; its owner may start a new life for the session', { session: slot.id, owner: slot.view.owner });
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
    // The name's record: its slot's, or, for a name with no slot (a journal recovery could not read, or none),
    // the one beside its files.
    const recorded = prev?.meta ?? readMeta(dir);
    // Another principal's leftovers are never reused.
    const reusable = recorded.owner === undefined || recorded.owner === o.owner || o.owner === SYSTEM;
    // Requested over recorded over daemon defaults (ux-4). A name with no slot took the defaults, and its new
    // record dropped the retention the old one kept its history under (our read of the house's fixes for its
    // review of f3750e4, PR #22).
    const retention = this.retentionFor(o.retention, prev || reusable ? recorded.retention : undefined);
    const jo: JournalOptions = { hot: this.hotStore(retention), sessionId: id, log: this.journalLog(id) };
    let store: FileStore;
    let journal: Journal;
    // The retention the history is kept under until this life has started: the store takes the one
    // asked for only then. Applied before the start, a reopen asking for less pruned files the
    // record still kept when its start failed, and the entry reported the retention it never got
    // (the house's read of cc8c909..39787b3, #22).
    let before: SessionRetention;
    // Recovery owes the name a judgement of its Runs' process groups (see awaitsJudgement): its store takes no
    // retention in this life either.
    let awaits = prev?.awaitsJudgement === true;
    if (prev) {
      // A new life for an old name: the same journal, numbering and run index continue (G10).
      const old = journalOf(prev);
      // What the old life's ring still holds beyond the disk gets one more try (jr2-6); if the
      // disk still refuses, the new journal numbers past it and records the hole.
      old.retryCold();
      store = prev.store;
      before = prev.view.retention;
      jo.runs = old.runs;
      jo.startSeq = old.lastSeq;
      // What it lost below the files' last seq, which only it knew of (an independent read of the fixes for the review of f3750e4, PR #22).
      jo.lost = old.unrecorded();
      jo.cold = store;
      journal = new Journal(jo);
    } else {
      before = this.retentionFor(undefined, recorded.retention);
      // The store opens with no retention, as recovery's does, and takes the record's only once the open
      // is allowed: a store applies the retention it is given at once, so a refused open pruned what a
      // repaired record would keep (the house's read of the 38 commits, PR #22, comment 6274857431, item
      // 7), and, for a record that reads, the aged files of a journal another owner's open was refused
      // (the house's read of the 33 commits, PR #22, comment 6307350477; an independent read of the fix).
      const refusal = recordRefusal(id, recorded);
      store = new FileStore(dir, this.storeOptions(id, {}));
      // A journal this registry did not surface (recovery could not read it): its owner stands (G18),
      // and a record that cannot be read, or is not there, names none. Whether it holds history is
      // recovery's rule: an event, or a Run still open that only a rotation header names — by events
      // alone, another principal took a header-only journal's open Run, and its record (the house's read
      // of the 33 commits, PR #22, comment 6307350477, item 6). It is judged from the store's index, before
      // a journal is opened over it: a journal writes when it opens (the gap for a reservation it honours)
      // and when it closes (its reservation), and a refused open wrote both into a journal it did not own
      // (an independent read of the fix). The journal then takes the index the scan built.
      const runs = new RunIndex(id).scanStore(store);
      if (holdsHistory(store, runs)) {
        if (refusal) {
          store.close();
          throw refusal;
        }
        if (o.owner !== SYSTEM && (recorded.owner ?? SYSTEM) !== o.owner) {
          store.close();
          throw err('forbidden', `session ${id} belongs to another principal; only its owner may open it again`, { id });
        }
      }
      // A journal recovery could not read had none of its Runs' process groups judged: a Run its index names
      // that may hold one (in flight when its daemon died, or one that left children) awaits a recovery that
      // can list processes, as recovery's own unjudged Runs do. Applied here, the retention pruned the files
      // naming the group before any recovery read them, and the name was not kept for one (our read of the
      // house's 2f7e9e7, PR #22).
      awaits = this.judgesGroups() && runs.list().some(mayHoldGroup);
      if (awaits) this.opts.log?.('warn', "a session recovery could not read is opened: its Runs' process groups were never judged, so its history takes no retention until a recovery that can list processes judges them", { session: id });
      // Allowed: until this life has started, the history is kept under its record's retention (with no
      // history and no record, the daemon's defaults; there is nothing to keep).
      else store.setRetention(before);
      jo.runs = runs;
      jo.cold = store;
      // The dead daemon's last evidence, read before the journal opens (and may write its gap): see recover.
      const lastAliveTs = lastAlive(store);
      journal = new Journal(jo);
      // The Runs it left in flight end here as recovery ends them: `lost`, marked as ends a recovery wrote, with
      // the dead daemon's last evidence and no judgement. Left open, this life's close ended each as one it had
      // seen end, and a later recovery took a leader still running for a stranger's reuse of its pid and left it
      // running for good (the house's review of the 77 commits through 4f4c067, PR #22).
      const now = Date.now();
      const ended: string[] = [];
      for (const run of runs.open()) {
        journal.append({
          type: 'run.end',
          runId: run.runId,
          state: 'lost',
          reason: 'daemon-restart',
          // The wall clock's estimate, as recovery's own ends carry (RunInfo.durationMs).
          durationMs: Math.max(0, now - (run.startedAt ?? run.admittedAt)),
          recoveredEnd: true,
          ...(lastAliveTs !== undefined && { lastAliveTs }),
        });
        ended.push(run.runId);
      }
      if (ended.length) this.opts.log?.('info', 'a session recovery could not read ended the Runs a previous daemon left in flight', { session: id, runs: ended });
    }
    const reuse = reusable ? recordedOptions(recorded, retention) : undefined;
    const options = this.resolveOptions(o, reuse, retention);
    const { retention: _r, ...persisted } = options;
    const meta: Meta = { owner: o.owner, visibility: options.visibility, createdAt: Date.now(), retention, options: persisted };
    const cursors = prev?.cursors ?? new CursorBook(path.join(dir, 'cursors.json'), this.opts.log);
    let integ: ReturnType<typeof prepareIntegration> | undefined;
    let session: Session;
    // A name with a record: while this life starts, the record is this life's (owner, visibility, options,
    // no closedAt) with the retention the history is kept under until then; it takes the new retention once
    // the start succeeds, and the old record goes back if it fails. Kept old until after the start, a daemon
    // that died mid-start left the old life's record — its visibility and closedAt — beside the new life's
    // journal, which recovery then read as the old life's; written whole before the start, a failed start
    // overwrote the old retention (the house's read of the 38 commits, PR #22, comment 6274857431, item 6).
    let starting: Meta | undefined;
    try {
      // A brand-new name is owned from its first byte: its record is written before the start, so a daemon
      // that dies mid-start leaves owned history, not a journal recovery refuses as owner-unknown (a
      // reviewer's read of the fixes for #22 comment 6269992150).
      if (recorded.owner === undefined) this.noteUnsynced(id, writeMeta(dir, meta));
      else {
        const { retention: _new, ...rest } = meta;
        const pending: Meta = recorded.retention !== undefined ? { ...rest, retention: recorded.retention } : rest;
        // A disk that refuses it does not keep the session from starting, as the write after the start
        // never did; the log says what a crash before the next write would leave.
        try {
          this.noteUnsynced(id, writeMeta(dir, pending));
          starting = pending;
        } catch (we) {
          this.opts.log?.('warn', `the new life's record could not be written before its start, so a crash before it is written leaves the old life's: ${we instanceof Error ? we.message : String(we)}`, { session: id });
        }
      }
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
        // The shell's own files (command text, history, env captures) live together
        // in its private per-session directory, apart from the journal.
        tempDir: shellDir(dir),
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
      // A start that failed is not a life: a name with a record gets its old record back, so the history
      // keeps the retention and the closedAt it had, on disk and in memory (the house's read of the 36
      // commits, #22, comment 6269992150). A brand-new name wrote the attempt's record before the start, so
      // whatever it journaled stays owned and reopenable.
      if (starting) {
        try {
          this.noteUnsynced(id, writeMeta(dir, recorded));
        } catch (we) {
          this.opts.log?.('warn', `a new life failed to start and the old record could not be written back: ${we instanceof Error ? we.message : String(we)}`, { session: id });
        }
      }
      const kept = recorded.owner !== undefined ? recorded : meta;
      journal.seal();
      if (prev || journal.lastSeq > 0) {
        const view = new HistoryEntry(id, journal, kept.owner ?? o.owner, kept.visibility ?? options.visibility, kept.closedAt !== undefined, before, recordedOptions(kept, before), cursors);
        this.slots.set(id, { id, dir, store, meta: kept, cursors, view, ...(awaits && { awaitsJudgement: true as const }) });
      } else {
        store.close();
      }
      throw e;
    }
    // Started: a name that had a record takes this life's retention now, and the history is kept under it
    // from here on; a brand-new name's whole record was written before the start. A failed record write is
    // logged, not swallowed; the session is live and the record is retried at its next change.
    if (recorded.owner !== undefined) {
      try {
        this.noteUnsynced(id, writeMeta(dir, meta));
      } catch (we) {
        this.opts.log?.('warn', `history is live but its record could not be written: ${we instanceof Error ? we.message : String(we)}`, { session: id });
      }
    }
    // A name recovery owes a judgement keeps every file in this life too (see awaitsJudgement): its store
    // takes the retention, age and bytes alike, from the recovery that judges its groups.
    if (!awaits) store.setRetention(retention);
    this.slots.set(id, { id, dir, store, meta, cursors, view: new LiveEntry(session, () => integ?.cleanup(), retention, options), ...(awaits && { awaitsJudgement: true as const }) });
    this.emit({ type: 'created', id });
    return session;
  }

  /**
   * A record that is written but whose directory could not be synced (a real fsync error): the record
   * stands; said in the log once per name, not at every write — as the cursors' is once per session and the
   * lock's once per take (comment 6274603516; a reviewer's read of the fixes for #22).
   */
  private noteUnsynced(id: string, w: DurableWrite): void {
    if (w.synced || this.recordSyncSaid.has(id)) return;
    this.recordSyncSaid.add(id);
    this.opts.log?.('warn', `the session record is written but its directory could not be synced: ${w.error?.message ?? 'unknown error'}`, { session: id });
  }

  /** Requested over recorded over daemon defaults, for every creation option (ux-4). */
  private resolveOptions(o: CreateOptions, rec: SessionCreationOptions | undefined, retention: SessionRetention): SessionCreationOptions {
    const out: SessionCreationOptions = {
      shell: o.shell ?? rec?.shell ?? this.opts.defaultShell ?? process.env.SHELL ?? '/bin/bash',
      login: o.login ?? rec?.login ?? true,
      visibility: o.visibility ?? rec?.visibility ?? 'private',
      control: o.control ?? rec?.control ?? 'seat',
      cwd: o.cwd ?? rec?.cwd ?? this.opts.defaultCwd ?? process.cwd(),
      cols: o.cols ?? rec?.cols ?? DEFAULT_GEOMETRY.cols,
      rows: o.rows ?? rec?.rows ?? DEFAULT_GEOMETRY.rows,
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

  private storeOptions(id: string, retention: Retention): FileStoreOptions {
    const log = this.opts.log;
    // 'info' too: what a store has to say once a refused write lands (its epoch written late) is not a warning.
    return { ...retention, ...(this.floor && { floor: this.floor }), ...(log && { log: (level: 'warn' | 'info', text: string) => log(level, text, { session: id }) }) };
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
    if (s.kind !== 'live') throw err('session_exited', endedMessage(s, undefined), { id });
    return s.session;
  }

  list(): AnySession[] {
    return [...this.slots.values()].map((s) => s.view);
  }

  /** Whether recovery owes the name a judgement of its Runs' process groups, so its store applies no retention until one judges them (see awaitsJudgement). */
  awaitsJudgement(id: string): boolean {
    return this.slots.get(id)?.awaitsJudgement === true;
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
   * applies the same rule at startup. A name whose Runs' process groups
   * recovery could not judge is left as it is. Returns the removed ids.
   */
  async expire(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const slot of [...this.slots.values()]) {
      // Kept whole, in every life of the name until the daemon restarts, and not aged either: aging would
      // drop the events that name the Run's process group, which the next recovery needs to judge it (the
      // house's read of the 33 commits, PR #22, comment 6307350477, item 3).
      if (slot.awaitsJudgement) continue;
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
    this.removeFiles(slot.dir);
    // Only once its files are gone: cancelled before a removal that then failed, the book stayed cancelled in a
    // slot that stayed, and every later life of the name wrote no cursors (the house's review of 4f4c067..a8b6f28,
    // PR #22). Nothing runs between the synchronous removal and this, so a forgotten life's late settlement is
    // still refused.
    slot.cursors.cancel();
    this.slots.delete(slot.id);
    this.recordSyncSaid.delete(slot.id);
    this.emit({ type: 'removed', id: slot.id });
  }

  /** A name's files, including private shell command text (G26). */
  private removeFiles(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
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
      // whatever it would journal later is refused by the sealed journal (jr-10). Its duration is the
      // session's measure, on the monotonic clock, as the session's own ends are (a reviewer's read of
      // the fixes for #22); only a Run the session does not hold is dated from its journaled start.
      const now = Date.now();
      for (const r of journal.runs.open()) {
        const durationMs = live.session.runDurationMs(r.runId) ?? Math.max(0, now - (r.startedAt ?? r.admittedAt));
        // With the close's own reason when it gave one (daemon-shutdown, replaced), as the session ends its own.
        journal.append({ type: 'run.end', runId: r.runId, state: 'lost', reason: o.reason ?? 'session-closed', durationMs });
      }
      journal.seal();
      slot.cursors.merge(live.session.cursorsSnapshot());
      slot.cursors.flush();
      if (o.persist) {
        slot.meta = { ...slot.meta, closedAt: Date.now() };
        try {
          this.noteUnsynced(slot.id, writeMeta(slot.dir, slot.meta));
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
  // A Run whose group a previous recovery already judged — ended or left — is not judged again:
  // its recorded end carries the recovery's clock, not evidence of when the group could form, so a
  // later restart must not read a reused pgid as the Run's (the house's read of the 36 commits, #22,
  // comment 6269992150).
  return run.pgid !== undefined && (run.state !== 'exited' || run.leftovers === true) && !run.groupJudged;
}

/** A Run recovery may end a group for: its key (`<session>\0<runId>`) and the last event its dead daemon wrote. */
export interface OrphanCandidate {
  key: string;
  run: RunInfo;
  lastTs: number | undefined;
}

/**
 * An end a recovery wrote: its time is the recovery's, which says nothing of when the Run's group could
 * form. Flagged `recoveredEnd` since comment 6269992150; an older recovery (78c4d6e) wrote the same
 * `lost` end, reason `daemon-restart`, with no flag, so that reason counts too (the house's read of the
 * 38 commits, PR #22, comment 6274857431, item 2).
 */
function recoveryEnded(e: { state: string; reason?: string | undefined; recoveredEnd?: true | undefined }): boolean {
  return e.recoveredEnd === true || (e.state === 'lost' && /^daemon-restart(;|$)/.test(e.reason ?? ''));
}

/** What a recovery writes besides its ends — the gap a journal writes when it opens, its notes and judgements, the restart mark — none of it the dead daemon's. */
function writtenByRecovery(e: JournalEvent): boolean {
  switch (e.type) {
    case 'gap':
      return e.reason === 'torn-write' || e.reason === 'store-failed';
    case 'run.judged':
    case 'recovered':
      return true;
    case 'note':
      return e.principal === SYSTEM && e.text.startsWith('recovery:');
    default:
      return false;
  }
}

/** Events read per page while looking back for the dead daemon's own newest event. */
const LAST_ALIVE_PAGE = 64;

/**
 * When the dead daemon was last known alive: the time of the newest whole event it wrote itself. A
 * recovery that died partway leaves its own events at the tail — the gap its journal wrote opening over a
 * torn line or a failed store, then one `lost` end per open Run — stamped with its own time, and taken as
 * the evidence they made the next recovery's bound that recovery's clock. They are passed over, and an
 * end a recovery wrote carries the evidence that recovery had (`lastAliveTs`), which is taken as it
 * stands (the house's read of the 38 commits, PR #22, comment 6274857431, item 5). Undefined when nothing
 * of the dead daemon's remains (a header-only file).
 */
function lastAlive(store: FileStore): number | undefined {
  for (let to: Seq | undefined; ; ) {
    const page = store.tail(LAST_ALIVE_PAGE, to);
    for (let i = page.length - 1; i >= 0; i--) {
      const e = page[i]!;
      if (e.type === 'run.end' && recoveryEnded(e)) {
        if (e.lastAliveTs !== undefined) return e.lastAliveTs;
      } else if (!writtenByRecovery(e)) {
        return e.ts;
      }
    }
    if (page.length < LAST_ALIVE_PAGE) return undefined;
    to = page[0]!.seq - 1;
  }
}

/**
 * Which of the candidates' process groups recovery signals, from a listing of the machine's
 * processes: per group, the keys of the Runs it belonged to. Pure, so its rules are tested without
 * a signal (the house's read of 2c35df8, #22). Never the daemon's own pid or group, and never a
 * group below 2: `kill(-1)` reaches every process the daemon may signal.
 *
 * A group is the Run's when its leader started with the Run — not before, not after: pids are
 * reused — and the Run has not ended: its own process was reaped before its end was written, so a
 * leader now holds the freed pid. With the leader gone, the kernel keeps a group's id while a member
 * lives, so the members are descendants of whoever led it: the Run's, when none predates the Run and
 * one started before the Run ended — a member that started later descends from one that was there, as
 * a loop's newest child does, so the whole group goes; asking every member to predate the end left
 * such a loop running (the house's read of cc8c909..39787b3, #22). For a Run still in flight, when one
 * started before the dead daemon's last event, so the group is not one formed after the daemon died.
 * An end a recovery wrote observed no exit, so the Run is judged as the in-flight Run it was: a present
 * leader by whether it started with the Run, by ticks where both are recorded and else by the wall clock
 * (the house's review of 4f4c067..a8b6f28, PR #22, comment 6323055715, question 6). With the leader gone
 * such an end bounds the group only by the evidence it recorded (`lastAliveTs`), compared as the in-flight
 * rule compares the last event; without it the group is left (comment 6274857431, item 2; comment
 * 6307350477, item 5).
 *
 * Starts are compared in ticks where the Run recorded its leader's and the listing is of the same boot
 * (Linux): no wall-clock frame, 10 ms. The ends and the last event are wall-clock records, compared with
 * each row's earliest start and its slack: "one started before the Run ended" admits a stranger's group
 * formed up to the slack after the end — about 25 ms with /proc's rows, a second with `ps`'s whole
 * seconds (macOS) — and a clock step between the record and the recovery moves the comparison by the
 * step (comment 6274857431, item 3).
 */
export function orphanGroups(candidates: OrphanCandidate[], procs: ProcessRow[], self: { pid: number; pgid: number | undefined }): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const { key, run, lastTs } of candidates) {
    const g = run.pgid;
    if (g === undefined || g <= 1 || g === self.pid || g === self.pgid) continue;
    const members = procs.filter((p) => p.pgid === g && !p.zombie);
    if (!members.length) continue;
    // Frame-free (Linux): a Run recorded the boot id at run.start; a listing taken under a different
    // one holds nothing of it, whatever the wall-clock start times say (the house's read of the 36
    // commits, #22, comment 6269992150).
    const listingBoot = members.find((p) => p.bootId !== undefined)?.bootId;
    if (run.bootId !== undefined && listingBoot !== undefined && run.bootId !== listingBoot) continue;
    const started = run.startedAt ?? run.admittedAt;
    // A recovery-written end carries the recovery's time, which is no evidence of when the group could
    // form: the bound is the dead daemon's last evidence the end recorded, and an end that recorded none
    // bounds nothing (comment 6269992150, item 2; comment 6274857431, item 2).
    const byRecovery = run.endedAt !== undefined && recoveryEnded(run);
    const ended = run.endedAt === undefined || !byRecovery ? run.endedAt : run.lastAliveTs !== undefined ? Math.min(run.endedAt, run.lastAliveTs) : undefined;
    const leader = members.find((p) => p.pid === g);
    // A row's start ticks, when they can be compared with the Run's: both recorded, under the same boot.
    const ticks = (p: ProcessRow): number | undefined => (run.startTicks !== undefined && run.bootId !== undefined && p.startTicks !== undefined && p.bootId === run.bootId ? p.startTicks : undefined);
    // Not before the Run: every member descends from its leader, so none started before the leader's tick;
    // by the wall clock, with the tolerance for a start journaled after the spawn and ps's truncation.
    const sinceStart = (p: ProcessRow): boolean => {
      const t = ticks(p);
      return t !== undefined ? t >= run.startTicks! : p.startMs >= started - 2000;
    };
    const byTicks = (l: ProcessRow): boolean => run.startTicks !== undefined && ticks(l) === run.startTicks;
    // The leader started with the Run: by ticks when both were recorded, else by the wall clock with the
    // tolerance above (macOS, or an older build).
    const leaderStartedWithRun = (l: ProcessRow): boolean => (ticks(l) !== undefined ? byTicks(l) : sinceStart(l) && l.startMs <= started + 1000);
    // Started before `t`, proven: even the row's latest possible start is.
    const before = (p: ProcessRow, t: number): boolean => p.startMs + (p.startSlackMs ?? 1000) <= t;
    // A present leader after an observed end is a reuse (the Run's process was reaped before its end was
    // written). A recovery-written end observed no exit, so its leader is judged as an in-flight Run's: one
    // that started with the Run is the Run's own process still alive, and the group is its — the recorded
    // end alone left it running at every restart (a reviewer's read of the fixes for #22 comment
    // 6269992150). By ticks where both are recorded; without them (macOS, or a Run recorded without ticks)
    // by the wall clock, as the in-flight rule judges, where ticks alone left such a leader running at
    // every later recovery (comment 6323055715, question 6).
    // With the leader gone, a member must have started before the bound: an observed end by its earliest
    // start (the window the docs state), the dead daemon's last event by its latest — and a recovery-written
    // end's bound is that same evidence, so it is compared as the in-flight rule compares it; by the
    // earliest start, a stranger's group formed within the slack of the daemon's death passed (the house's
    // read of the 33 commits, PR #22, comment 6307350477, item 5).
    const startedBefore = (p: ProcessRow, t: number): boolean => (run.endedAt !== undefined && !byRecovery ? p.startMs <= t : before(p, t));
    const ours = leader
      ? (run.endedAt === undefined || byRecovery) && leaderStartedWithRun(leader)
      : run.endedAt !== undefined
        ? ended !== undefined && members.every(sinceStart) && members.some((p) => startedBefore(p, ended))
        : lastTs !== undefined && members.every(sinceStart) && members.some((p) => startedBefore(p, lastTs));
    if (ours) groups.set(g, [...(groups.get(g) ?? []), key]);
  }
  return groups;
}

/** The same process in two listings: the same pid and start — ticks when both rows have them, else the second (`ps`'s resolution). */
function sameProcess(a: ProcessRow, b: ProcessRow): boolean {
  if (a.pid !== b.pid) return false;
  if (a.startTicks !== undefined && b.startTicks !== undefined) return a.startTicks === b.startTicks && a.bootId === b.bootId;
  return Math.floor(a.startMs / 1000) === Math.floor(b.startMs / 1000);
}

/**
 * The groups recovery is still signalling, from a new listing: each of `known`'s that holds one of the
 * members known for it — the same process, not a new one with a reused pid — mapped to its members now.
 * A pgid cannot be reused while a member lives, so a group holding a known member is the one judged,
 * and its other members (a loop's new child) join the known for the next listing; a group whose known
 * members are all gone cannot be told from a stranger's that reused the id, and is not signalled again
 * (the house's read of the 38 commits, PR #22, comment 6274857431, item 4). Pure, so its rules are tested
 * without a signal.
 */
export function heldGroups(known: Map<number, ProcessRow[]>, now: ProcessRow[]): Map<number, ProcessRow[]> {
  const out = new Map<number, ProcessRow[]>();
  for (const [g, seen] of known) {
    const members = now.filter((p) => p.pgid === g && !p.zombie);
    if (members.some((m) => seen.some((k) => sameProcess(k, m)))) out.set(g, members);
  }
  return out;
}

/**
 * Whether a session's journal holds history: an event, a Run still open that only a rotation header
 * names (age retention can leave just the header), or a reservation above the files' last seq — seqs
 * issued that a power loss may have taken, which a journal opened over the store records as a gap. One
 * rule for recovery's open and for the open of a journal recovery did not surface (the house's read of
 * the 33 commits, PR #22, comment 6307350477, item 6), judged from the store and its index alone, so the
 * fallback asks it before a journal is opened over the store (an independent read of the fix).
 */
function holdsHistory(store: FileStore, runs: RunIndex): boolean {
  const last = store.lastSeq();
  return last !== undefined || runs.open().length > 0 || (store.highWater()?.reservation?.to ?? 0) > (last ?? 0);
}

function expired(store: FileStore, retention: SessionRetention, now: number): boolean {
  if (retention.maxAgeMs === undefined) return false; // no age limit: history is kept until forgotten
  const newest = store.newestTs();
  // No event left: aged out only when retention dropped the files and left its floor. Any high water read
  // so before every store kept a reservation, which a power loss that took every line leaves behind too,
  // so such a session read as past its age (the house's read of the 33 commits, PR #22, comment
  // 6307350477; an independent read of the fix). A reservation above the floor that the journal honours
  // says seqs were issued after the files that aged out, and a power loss may have taken their lines: the
  // session is not past its age by what is missing. One the journal does not honour covers nothing
  // issued, as the journal reads it, judged against what the files account for, retention's floor, as
  // the journal's start judges it: on this boot only a block a start reserved above a hole it honoured,
  // with that hole's gap not yet in the file, still stands.
  if (newest === undefined) {
    const hw = store.highWater();
    const r = hw?.reservation;
    return hw?.floor !== undefined && !(r !== undefined && r.to > hw.floor && reservationHonoured(r, hw.floor));
  }
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
  /** In memory only: there is no session.json. Beside a journal, nothing of the name is reopened until one naming the owner is written or the session is removed. */
  missing?: true;
}

const damagedRecord = (id: string, why: string): TermError =>
  err('forbidden', `session ${id}'s record (session.json) cannot be read: ${why}; nobody may start a new life for it until the file is repaired or the session is removed`, { id });

const missingRecord = (id: string): TermError =>
  err('forbidden', `session ${id} has history but no record (session.json is missing beside its journal), so its owner is not known; nobody may start a new life for it until a record naming the owner is written there ({"owner":"<principal>","visibility":"private"}) or the session is removed`, { id });

/**
 * The refusal a record that names no owner earns a name with history: the file cannot be read, or
 * there is none (the house's read of cc8c909..39787b3, #22). Undefined when the record reads. A
 * name with no history and no record is simply new.
 */
function recordRefusal(id: string, meta: Meta): TermError | undefined {
  if (meta.damaged !== undefined) return damagedRecord(id, meta.damaged);
  if (meta.missing) return missingRecord(id);
  return undefined;
}

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
 * The record beside a journal: `missing` when there is none, `damaged` when there is one that cannot
 * be read — never a guess at its owner (the house's read of 2c35df8, #22).
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
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { damaged: (e as Error).message };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { damaged: 'not a JSON object' };
    const rec = parsed as Meta;
    // A valid JSON object that names no owner (or a non-string one) names nobody: treat it as damaged,
    // so the name is nobody's to reopen until it is repaired — not handed to the system, which `{}`
    // and an owner that is not a string both were (the house's read of the 36 commits, #22, comment
    // 6269992150). recordRefusal's own doc says a record naming no owner earns the refusal.
    if (typeof rec.owner !== 'string' || rec.owner.length === 0) return { damaged: 'the record (session.json) names no owner' };
    return rec;
  } catch (e) {
    return { damaged: (e as Error).message };
  }
}

/** Durably, and private to the daemon's user: a crash mid-write never loses the owner (G18, G26); `env` may hold secrets. */
function writeMeta(dir: string, meta: Meta): DurableWrite {
  const { damaged: _d, missing: _m, ...record } = meta;
  return writeDurably(path.join(dir, 'session.json'), JSON.stringify(record, null, 2));
}


/** A session's shell-side files: command files and the shell's own history (0700). */
function shellDir(dir: string): string {
  const d = path.join(dir, 'shell');
  assertTypedCommandDir(d);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  assertPrivateSessionDir(d);
  return d;
}

/**
 * What a life that ended without its own cleanup (a daemon killed mid-Run) left on disk: its
 * command files, which hold command text, and env captures (G26). The session's own shell
 * history stays: it is the session's.
 */
function removeLeftovers(dir: string): string | undefined {
  const shell = path.join(dir, 'shell');
  let names: string[];
  try {
    assertPrivateSessionDir(shell);
    names = fs.readdirSync(shell);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    const reason = e instanceof Error ? e.message : String(e);
    return `skipped leftover command and environment-capture file cleanup in ${shell}: ${reason}`;
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
