/**
 * The typed application API (§11): every adapter — MCP/MCPL, native, CLI — is a
 * thin translation of these operations. Verbs are enforced here for every
 * adapter (G18); the seat is enforced in the core. Every operation that runs,
 * types, declares or changes something takes an optional idempotency key (G16): a
 * retry within the window gets the original outcome instead of a second execution.
 * `note` takes none: it records an annotation, and a repeated note is a repeated
 * annotation, nothing worse (the house's read of 1cabc6a, #22).
 */
import { createHash } from 'node:crypto';
import { clocks } from '../core/clock.js';
import { err, TermError } from '../core/errors.js';
import { inputBytes } from '../core/keys.js';
import type { PlumbingOf } from '../core/plumbing.js';
import { validateServiceSpec, type ServiceSpec } from '../core/probes.js';
import { journalRunText, promptLine, Segmenter, type SegmenterOptions } from '../core/segmenter.js';
import { ServiceManager, type ServiceInfo } from '../core/services.js';
import { isTerminal, serviceOutcomeKey, type Session, type SessionInfo } from '../core/session.js';
import { cutTail } from '../core/text.js';
import { DEFAULT_GEOMETRY, type Attribution, type EnvBasis, type JournalEvent, type Principal, type RunInfo, type RunTarget, type ScreenSnapshot, type Seq, type ServiceStatus, type Visibility } from '../core/types.js';
import { SYSTEM } from '../core/types.js';
import { WatchManager, type WaitResult, type WatchInfo, type WatchSpec } from '../core/watches.js';
import { guiActsFor } from './principals.js';
import { endedMessage, type AnySession, type CreateOptions, type SessionRegistry } from './registry.js';
import { readJournal, searchJournal, type ReadOptions, type ReadResult, type ReadSource, type SearchOptions, type SearchResult } from './reader.js';

export type Verb = 'observe' | 'type' | 'run' | 'signal' | 'resize' | 'destroy';

export interface AppOptions {
  registry: SessionRegistry;
  /** Default and ceiling for `wait` (ms). The ceiling sits under the host's 60 s request timeout. */
  defaultWaitMs?: number;
  maxWaitMs?: number;
  /** Cap on result text bytes; the tail is kept and the cut is visible. */
  resultBytes?: number;
  /** How long an idempotency key is remembered (G16). */
  idempotencyWindowMs?: number;
  /** Segmentation tuning (§10.2): digest cadence, settle and quiet periods. */
  segmenter?: SegmenterOptions;
}

export interface RunResult {
  /** Absent only when `state` is `busy` (nothing was admitted). */
  runId?: string;
  session: string;
  target: RunTarget;
  state: RunInfo['state'] | 'busy';
  exit?: number;
  signal?: string;
  reason?: string;
  /** A process Run that left children running in its group (RunInfo.leftovers). */
  leftovers?: boolean;
  /** A shell pipeline's statuses, one per command (RunInfo.pipeStatus). */
  pipeStatus?: number[];
  durationMs?: number;
  cwd: string;
  origin?: RunInfo['origin'];
  principal?: Principal;
  envBasis?: EnvBasis;
  attribution: Attribution;
  line?: string;
  output: { text: string; truncated: boolean; seq: [Seq, Seq]; nextCursor: Seq };
  /** Present when `state` is `busy`: what is occupying the shell, and by whom. */
  busy?: { runId?: string; reason: string; line?: string; principal?: Principal };
  /** A queued Run: how long it has waited to start. */
  queuedMs?: number;
  /** A declared shell's Run (§8.1): the kind of shell in front, and the Run whose program it is (null: what replaced the session's shell). */
  shell?: string;
  within?: string | null;
  /** The session's integration level (G5): under `none`, only daemon-issued Runs have boundaries and the cwd is not tracked. */
  integration?: string;
  /** A running Run that seems to wait for someone (G15, heuristic): a prompt-like last line after silence, or a full-screen program; carries the session state G15 asks for. */
  waiting?: { kind: 'input' | 'tui'; lastLine?: string; silentMs?: number; state: string; heuristic: true };
  /** Arguments that did not apply (e.g. `cwd` for a session that already exists). */
  ignored?: string[];
  created?: boolean;
  /** For `start`: the Service's status (§8.3). */
  service?: ServiceStatus;
  evidence?: string;
  probe?: string;
  /** The result of an earlier call with the same idempotency key (G16). */
  replayed?: boolean;
}

/**
 * The fields every look at a session starts with: the head of its summary, and all a channel
 * descriptor needs. One cheap read of the entry — no Runs, Services or Watches listed — so a
 * channel listing costs one look per session, not a walk of every Run (a review of the
 * consolidated branch of #22).
 */
export interface SessionHeader {
  id: string;
  owner: Principal;
  state: string;
  controller: Principal | null;
  cwd?: string;
  integration?: string;
  recovered?: 'continuous' | 'reattached' | 'history-only';
}

const headerOf = (i: SessionInfo): SessionHeader => ({ id: i.id, owner: i.owner, state: i.state, controller: i.controller, cwd: i.cwd, integration: i.integration });

export interface SessionSummary extends SessionHeader {
  visibility: Visibility;
  backend?: string;
  pid?: number;
  currentRun?: string | null;
  lastSeq: Seq;
  oldestSeq?: Seq;
  /** What the session keeps on disk (G21). */
  retention?: { maxBytes?: number; maxAgeMs?: number };
  closed?: boolean;
  createdAt?: number;
  lastActivity?: number;
  /** The innermost declared shell (§8.1), where shell Runs go now; absent when they go to the session's own shell. */
  declared?: { shell: string; within: string | null };
  /** The terminal's geometry (live sessions). */
  cols?: number;
  rows?: number;
  services?: Array<{ runId: string; name?: string; status: ServiceStatus; evidence?: string }>;
  /** Services that `services` left out, older than the ones listed (the house's read of the 36 commits, #22). */
  servicesOmitted?: number;
  watches?: number;
  /** Runs that have not ended (shell and process), newest last, so a lost runId can be found again; the 20 newest. */
  runs?: Array<{ runId: string; target: RunTarget; state: RunInfo['state']; principal: Principal; line?: string; admittedAt: number }>;
  /** Runs not ended that `runs` left out, older than the ones listed (the house's read of 1cabc6a, #22). */
  runsOmitted?: number;
}

export interface Caller {
  principal: Principal;
  /** Identifies the connection for attachments. */
  connectionId: string;
  /**
   * The caller reaches the daemon over a connection that can drop before a result is written: its
   * `read` cursor must advance only once the result has been delivered (G22), so output a dropped
   * connection never received is not counted read (the house's read of 1cabc6a, #22, comment
   * 6263057673). The transport sets this; a direct caller leaves it off and the cursor advances at once.
   */
  deferReadDelivery?: boolean;
}

/**
 * A result that returned content to its caller stages its `read`-cursor advance here when the
 * caller's delivery is deferred: the transport runs it from `ToolResult.onSent`, once the write
 * succeeded. Symbol-keyed and not enumerable, so it never enters the envelope or its schema, and
 * no copy of the result (a spread, an idempotency entry's compact copy) carries the closure and
 * the Session it holds (the house's read of 78c4d6e, #22).
 */
const READ_COMMIT = Symbol('readCommit');

function stageReadCommit(result: object, commit: () => void): void {
  Object.defineProperty(result, READ_COMMIT, { value: commit, configurable: true, enumerable: false, writable: true });
}

/**
 * Take a result's staged `read`-cursor commit off it, to run later: a tool that answers from
 * several App results carries their commits on its own result and keeps nothing else of them.
 * Undefined when nothing was staged.
 */
export function takeReadCommit(result: unknown): (() => void) | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const commit = (result as Record<symbol, unknown>)[READ_COMMIT];
  if (typeof commit !== 'function') return undefined;
  delete (result as Record<symbol, unknown>)[READ_COMMIT];
  return commit as () => void;
}

/** Advance a deferred caller's `read` cursor now that its result was delivered (no-op if nothing was staged). */
export function commitReadDelivery(result: unknown): void {
  takeReadCommit(result)?.();
}

/** The journal event whose service status a start result rendered, for `outcomeSent`; off the result, so no copy or envelope carries it. */
const statusSeqOf = new WeakMap<object, Seq>();

interface Extras {
  services: ServiceManager;
  watches: WatchManager;
  segmenter?: Segmenter;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The longest idempotency key accepted (a UUID fits with room to spare). */
const MAX_KEY_LENGTH = 200;

/** A stable digest of a call's arguments: what makes two calls with one key "the same operation" (G16). */
function argsDigest(args: object): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  const { wait: _w, idempotencyKey: _k, ...rest } = args as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify(norm(rest))).digest('hex').slice(0, 16);
}

interface IdemEntry {
  principal: Principal;
  tool: string;
  digest: string;
  /** When the entry was made, on the monotonic clock: the window is measured there, so a wall-clock step neither expires a young key nor keeps an old one. */
  mono: number;
  value: Promise<unknown>;
}

/** The journaled form of a keyed admission: the key's identity (principal and key), the tool and
 * the arguments' fingerprint, kept apart so recovery can refuse a conflicting reuse (G16). */
function idemIdentity(idem: string): { key: string; tool: string; digest: string } | undefined {
  const m = /^([a-f0-9]{24}):([^:]+):([a-f0-9]{16})$/.exec(idem);
  return m ? { key: m[1]!, tool: m[2]!, digest: m[3]! } : undefined;
}

/**
 * Per-principal memory of idempotency keys (G16). A replay returns the original outcome,
 * success or failure; a key reused for another tool or other arguments is refused. Nothing
 * is kept for a call that admitted nothing (`busy`), so its retry can run — except the one
 * refusal that exists to be seen (see `remembered`). Bounded: keys are
 * at most 200 characters, a principal holds at most `perPrincipal` keys and the daemon
 * `total`, the oldest evicted first, and outcomes are stored compactly. Keys of `run` and
 * `start` also reach the journal (`run.admit.idem`), so a retry after a restart finds its Run.
 */
class Idempotency {
  private readonly entries = new Map<string, IdemEntry>();
  private readonly counts = new Map<Principal, number>();

  constructor(
    readonly windowMs: number,
    private readonly recoverIdentity: (key: string) => { tool: string; digest: string } | undefined,
    private readonly perPrincipal = 1024,
    private readonly total = 16_384,
  ) {}

  async run<T>(
    principal: Principal,
    key: string | undefined,
    tool: string,
    args: object,
    fn: (idem: string | undefined) => Promise<T>,
    replay: (prev: T) => Promise<T>,
    opts: { keep?: (v: T) => boolean; compact?: (v: T) => T; recover?: (idem: string) => T | undefined } = {},
  ): Promise<T> {
    if (key === undefined) return fn(undefined);
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw err('invalid_argument', `idempotencyKey must be 1–${MAX_KEY_LENGTH} characters (a UUID is ideal)`);
    const now = clocks.monotonic();
    this.sweep(now);
    const k = `${principal}\u0000${key}`;
    const digest = argsDigest(args);
    const identity = createHash('sha256').update(k).digest('hex').slice(0, 24);
    const prev = this.entries.get(k);
    const prior = prev ?? this.recoverIdentity(identity);
    if (prior) {
      if (prior.tool !== tool) throw err('invalid_argument', `idempotencyKey ${key} was used for ${prior.tool}, not ${tool}; use a new key for a new operation`, { idempotencyKey: key });
      if (prior.digest !== digest) throw err('invalid_argument', `idempotencyKey ${key} was used for a ${tool} call with other arguments; use a new key (a UUID) for each operation`, { idempotencyKey: key });
    }
    if (prev) {
      return replay((await prev.value) as T);
    }
    const idem = `${identity}:${tool}:${digest}`;
    const recovered = opts.recover?.(idem);
    if (recovered !== undefined) {
      this.put(k, { principal, tool, digest, mono: now, value: Promise.resolve(recovered) });
      return replay(recovered);
    }
    const value = fn(idem);
    const entry: IdemEntry = { principal, tool, digest, mono: now, value };
    this.put(k, entry);
    value.then(
      (v) => {
        if (this.entries.get(k) !== entry) return;
        if (opts.keep && !opts.keep(v)) this.drop(k, entry);
        else if (opts.compact) entry.value = Promise.resolve(opts.compact(v));
      },
      () => undefined, // a failure is replayed as it was (G16)
    );
    return value;
  }

  private put(k: string, e: IdemEntry): void {
    const n = this.counts.get(e.principal) ?? 0;
    if (n >= this.perPrincipal) {
      for (const [key, v] of this.entries) {
        if (v.principal !== e.principal) continue;
        this.drop(key, v);
        break;
      }
    }
    if (this.entries.size >= this.total) {
      const [key, v] = this.entries.entries().next().value as [string, IdemEntry];
      this.drop(key, v);
    }
    this.entries.set(k, e);
    this.counts.set(e.principal, (this.counts.get(e.principal) ?? 0) + 1);
  }

  private drop(k: string, e: IdemEntry): void {
    if (!this.entries.delete(k)) return;
    const n = (this.counts.get(e.principal) ?? 1) - 1;
    if (n > 0) this.counts.set(e.principal, n);
    else this.counts.delete(e.principal);
  }

  /**
   * Entries are in insertion (time) order: expire from the oldest until one is inside the window, on the
   * monotonic clock (the house's read of the 38 commits, #22, comment 6274935728, item 7). A key only a
   * restart's journal knows (recoverIdentity, App.recoverRun) has the journal's wall-clock stamp alone, and
   * is aged on the wall clock, as the Run's own age is (App.runAgeMs).
   */
  private sweep(now: number): void {
    for (const [k, v] of this.entries) {
      if (now - v.mono <= this.windowMs) break;
      this.drop(k, v);
    }
  }
}

/**
 * A RunResult without its output text: what an idempotency entry keeps (the replay awaits the Run
 * again). It carries no staged read commit either: the spread leaves it, since it is not
 * enumerable, and it is dropped here as well so the entry can never hold a Session through it
 * (the house's read of 78c4d6e, #22).
 */
const compactRun = (r: RunResult): RunResult => {
  const c: RunResult = { ...r, output: { ...r.output, text: '' } };
  takeReadCommit(c);
  return c;
};
/**
 * A busy outcome admitted nothing, so the key forgets it and the retry can run — except the once-only
 * refusal `declared-shell-ended` (§8.1), which fails closed because the declared shell the line may have
 * been meant for is gone: a retry that lost the first answer must get that refusal again, not a Run in
 * the local shell (the house's read of 1cabc6a, #22). A new key says "local is what I mean".
 */
const remembered = (r: RunResult) => r.state !== 'busy' || r.busy?.reason === 'declared-shell-ended';

export class App {
  readonly registry: SessionRegistry;
  readonly defaultWaitMs: number;
  readonly maxWaitMs: number;
  readonly resultBytes: number;
  private readonly idem: Idempotency;
  private readonly extrasBySession = new Map<Session, Extras>();
  private readonly segmenterOptions: SegmenterOptions;
  private recoveredIdem: Map<string, { session: string; run: RunInfo }> | undefined;
  private readonly recoveredKeys = new Map<string, { tool: string; digest: string; at: number }>();
  /** Names whose shell ended and whose new life is being started: the old life's watches, as they stand when it closes (m2-14). */
  private readonly carried = new Map<string, WatchInfo[]>();

  constructor(opts: AppOptions) {
    this.segmenterOptions = opts.segmenter ?? {};
    this.registry = opts.registry;
    this.defaultWaitMs = opts.defaultWaitMs ?? 20_000;
    this.maxWaitMs = opts.maxWaitMs ?? 55_000;
    this.resultBytes = opts.resultBytes ?? 16 * 1024;
    this.idem = new Idempotency(opts.idempotencyWindowMs ?? 15 * 60_000, (key) => {
      this.indexRecoveredIdem();
      const hit = this.recoveredKeys.get(key);
      return hit && Date.now() - hit.at <= this.idem.windowMs ? hit : undefined;
    });
    this.registry.onChange((c) => {
      if (c.type === 'created') return;
      for (const [s, x] of this.extrasBySession) {
        if (s.id !== c.id) continue;
        // A new life is starting under this name (liveSession): its watches move over as they stand at this
        // moment, so an unwatch answered during the reopen stays done (the house's read of 1cabc6a, #22).
        if (this.carried.has(c.id)) this.carried.set(c.id, x.watches.list());
        x.segmenter?.dispose();
        x.services.dispose();
        x.watches.dispose();
        this.extrasBySession.delete(s);
      }
    });
  }

  // ───────────── per-session extras: services, watches, the segmenter ─────────────

  extras(session: Session): Extras {
    let x = this.extrasBySession.get(session);
    if (!x) {
      x = { services: new ServiceManager(session), watches: new WatchManager(session) };
      this.extrasBySession.set(session, x);
    }
    return x;
  }

  /** The session's segmenter (§10.2), shared by every connection's lane. */
  segmenter(session: Session): Segmenter {
    const x = this.extras(session);
    if (!x.segmenter) x.segmenter = new Segmenter(session, this.segmenterOptions);
    return x.segmenter;
  }

  // ───────────── verbs (G18) ─────────────

  can(principal: Principal, s: AnySession, verb: Verb): boolean {
    if (principal === SYSTEM) return true;
    const owner = s.kind === 'live' ? s.session.owner : s.owner;
    const visibility = s.kind === 'live' ? s.session.visibility : s.visibility;
    // The GUI of a token's own principal (`human:gui:<owner>`) acts for that owner (§12).
    if (principal === owner || guiActsFor(principal, owner)) return true;
    if (visibility !== 'shared') return false;
    if (verb === 'observe') return true;
    if (verb === 'destroy') return false;
    // type/run/signal/resize on a shared session: allowed here; the seat decides in the core.
    return s.kind === 'live';
  }

  private authorize(principal: Principal, s: AnySession, verb: Verb): void {
    if (!this.can(principal, s, verb)) {
      const id = s.kind === 'live' ? s.session.id : s.id;
      throw err('forbidden', `${principal} may not ${verb} session ${id}`, { verb, session: id });
    }
  }

  private find(caller: Caller, id: string, verb: Verb): AnySession {
    const s = this.registry.get(id);
    if (!s) throw err('session_not_found', `session ${id} not found: session_list shows the sessions you can see; run or session_open creates one by this name`, { session: id });
    this.authorize(caller.principal, s, verb);
    return s;
  }

  private liveFor(caller: Caller, id: string, verb: Verb): Session {
    const s = this.find(caller, id, verb);
    // Only the owner starts a new life (G30): an observer is not sent to a tool that refuses them (the house's read of 1cabc6a, #22).
    if (s.kind !== 'live') throw err('session_exited', endedMessage(s, this.can(caller.principal, s, 'run')), { session: id });
    return s.session;
  }

  /** The owner's own GUI human acts with the owner's seat and cancel rights (§12, tsg-13). */
  private seat(caller: Caller, session: Session): { asOwner?: boolean } {
    return guiActsFor(caller.principal, session.owner) ? { asOwner: true } : {};
  }

  private ensureAttached(caller: Caller, session: Session): void {
    if (!session.listAttachments().some((a) => a.principal === caller.principal && a.connectionId === caller.connectionId)) {
      session.attach(caller.principal, caller.connectionId);
    }
  }

  /**
   * Find a Run by id across the sessions the caller may observe, history included. A runId is a per-session
   * counter with a short random suffix, so two sessions can hold the same id: an id alone that matches in
   * more than one session is refused, naming them, rather than reaching whichever comes first (the house's
   * read of 1cabc6a, #22).
   */
  private findRun(caller: Caller, runId: string, inSession?: string): { s: AnySession; run: RunInfo } {
    const candidates = inSession !== undefined ? [this.find(caller, inSession, 'observe')] : this.registry.list().filter((s) => this.can(caller.principal, s, 'observe'));
    const found: Array<{ s: AnySession; run: RunInfo }> = [];
    for (const s of candidates) {
      try {
        found.push({ s, run: s.run(runId) });
      } catch (e) {
        if (!(e instanceof TermError && e.code === 'run_not_found')) throw e;
      }
    }
    if (found.length > 1) {
      const names = found.map((f) => sessionId(f.s));
      throw err('invalid_argument', `run ${runId} exists in more than one session (${names.join(', ')}): pass session to say which`, { runId, sessions: names });
    }
    if (found.length === 1) return found[0]!;
    const where = inSession !== undefined ? ` in session ${inSession}` : '';
    throw err('run_not_found', `run ${runId} not found${where}: the id comes from a run or start result; session_list shows the Runs that have not ended, and a forgotten session's Runs are gone with it`, { runId });
  }

  // ───────────── sessions ─────────────

  /** The head of a session's summary (see SessionHeader): what a channel listing and a descriptor show, read cheaply. */
  summaryHeader(s: AnySession): SessionHeader {
    if (s.kind === 'live') return headerOf(s.session.info());
    const out: SessionHeader = { id: s.id, owner: s.owner, state: 'exited', controller: null };
    if (!s.closed) out.recovered = s.recovered;
    return out;
  }

  /** What a session looks like from outside (session_list, session_open): the header, then everything else of an entry. */
  summary(s: AnySession): SessionSummary {
    if (s.kind === 'live') {
      const i = s.session.info();
      const out: SessionSummary = {
        ...headerOf(i),
        visibility: i.visibility,
        backend: i.backend,
        pid: i.pid,
        currentRun: i.currentRun,
        lastSeq: i.lastSeq,
        createdAt: i.createdAt,
        lastActivity: i.lastActivity,
        cols: i.cols,
        rows: i.rows,
      };
      if (i.declared) out.declared = i.declared;
      const oldest = s.session.journal.oldestSeq;
      if (oldest !== undefined) out.oldestSeq = oldest;
      out.retention = { ...s.retention };
      const x = this.extrasBySession.get(s.session);
      if (x) {
        // The list is bounded like `runs`: a life that starts many services does not grow this without
        // limit (the house's read of the 36 commits, #22). The newest few are shown, the rest counted.
        const allServices = x.services.list();
        const services = allServices.slice(-20).map((v) => ({ runId: v.runId, status: v.status, ...(v.name !== undefined ? { name: v.name } : {}), ...(v.evidence !== undefined ? { evidence: v.evidence } : {}) }));
        if (services.length) out.services = services;
        if (allServices.length > services.length) out.servicesOmitted = allServices.length - services.length;
        const w = x.watches.list().length;
        if (w) out.watches = w;
      }
      const open = s.session.listRuns().filter((r) => !isTerminal(r.state));
      const runs = open.slice(-20).map((r) => ({ runId: r.runId, target: r.target, state: r.state, principal: r.principal, admittedAt: r.admittedAt, ...(r.line !== undefined ? { line: head(r.line) } : {}) }));
      if (runs.length) out.runs = runs;
      // The list is bounded; what it leaves out is counted, not dropped in silence (the house's read of 1cabc6a, #22).
      if (open.length > runs.length) out.runsOmitted = open.length - runs.length;
      return out;
    }
    const out: SessionSummary = { ...this.summaryHeader(s), visibility: s.visibility, lastSeq: s.journal.lastSeq };
    if (s.closed) out.closed = true;
    out.retention = { ...s.retention };
    const oldest = s.journal.oldestSeq;
    if (oldest !== undefined) out.oldestSeq = oldest;
    return out;
  }

  sessionList(caller: Caller): SessionSummary[] {
    return this.registry
      .list()
      .filter((s) => this.can(caller.principal, s, 'observe'))
      .map((s) => this.summary(s));
  }

  async sessionOpen(
    caller: Caller,
    o: Omit<CreateOptions, 'owner'> & { role?: 'observer' | 'controller'; idempotencyKey?: string },
  ): Promise<{ created: boolean; info: SessionSummary; role: 'observer' | 'controller'; ignored?: string[]; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'session_open',
      o,
      async () => {
        const { idempotencyKey: _k, role: _r, id, ...create } = o;
        const { session, created } = await this.liveSession(caller, id, 'observe', create);
        // `role: controller` asks for the seat. attach grants a free seat; the owner (and its GUI, like `run`)
        // also takes a held seat over, under owner-priority or from a dropped holder — the same rule `run` uses,
        // which attach alone did not apply (the house's read of 1cabc6a, #22). Anyone else is refused (not_controller).
        const att = session.attach(caller.principal, caller.connectionId, o.role === 'controller' ? 'auto' : (o.role ?? 'auto'));
        let role = att.role;
        if (o.role === 'controller' && role !== 'controller') {
          session.takeControl(caller.principal, this.seat(caller, session));
          role = 'controller';
        }
        const res: { created: boolean; info: SessionSummary; role: 'observer' | 'controller'; ignored?: string[] } = { created, info: this.summary(this.entry(session)), role };
        const ignored = created ? [] : CREATION_OPTIONS.filter((k) => create[k] !== undefined);
        if (ignored.length) res.ignored = ignored;
        return res;
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  async sessionClose(caller: Caller, o: { session: string; force?: boolean; forget?: boolean; idempotencyKey?: string }): Promise<{ closed: boolean; forgotten: boolean; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'session_close',
      o,
      async () => {
        this.find(caller, o.session, 'destroy');
        // Always through the registry, under the name's lock: a reopen in flight lands first and is closed
        // too, so `closed: true` is true when it is said (the house's read of 1cabc6a, #22). A history
        // entry closes to nothing.
        await this.registry.close(o.session, { graceful: !o.force });
        if (o.forget) await this.registry.remove(o.session);
        return { closed: true, forgotten: o.forget === true };
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  /**
   * A connection went away. Closed on purpose (`clean`: a CLI call that finished, a host that
   * shut down), it gives up a held seat at once; dropped, it keeps the seat through the grace
   * so a reconnect gets it back (§9).
   */
  detachConnection(connectionId: string, opts: { clean?: boolean } = {}): void {
    for (const s of this.registry.list()) {
      if (s.kind !== 'live') continue;
      for (const a of s.session.listAttachments()) if (a.connectionId === connectionId) s.session.detach(a.attachmentId, { keepSeat: !opts.clean });
    }
  }

  // ───────────── runs ─────────────

  /**
   * The live session a call names: the running one (authorized for `verb`), or a new one — created, or a
   * new life of an ended shell for its owner (G30), which keeps the name's watches (m2-14). A call that
   * raced another's creation of the name is authorized against what resulted (jr2-1).
   */
  private async liveSession(caller: Caller, id: string, verb: Verb, create: Omit<CreateOptions, 'id' | 'owner'> = {}): Promise<{ session: Session; created: boolean }> {
    const existing = this.registry.get(id);
    if (existing?.kind === 'live' && existing.session.exit === undefined) {
      this.authorizeName(caller, existing, verb);
      return { session: existing.session, created: false };
    }
    // The watches of a shell that ended move to the new life (m2-14) as they stand when the old life
    // closes (the registry listener in the constructor fills `carried` then), with their ids, so an
    // unwatch answered meanwhile stays done and the ids callers hold stay valid (the house's read of 1cabc6a, #22).
    const carrying = existing?.kind === 'live' && !this.carried.has(id);
    if (carrying) this.carried.set(id, []);
    let r: { session: Session; created: boolean };
    let carried: WatchInfo[] = [];
    try {
      r = await this.registry.ensure({ ...create, id, owner: this.newLifeOwner(caller, existing, id) });
    } finally {
      if (carrying) {
        carried = this.carried.get(id) ?? [];
        this.carried.delete(id);
      }
    }
    if (!r.created) this.authorizeName(caller, this.entry(r.session), verb);
    for (const w of r.created ? carried : []) {
      try {
        this.extras(r.session).watches.add(w.spec, w.owner, { watchId: w.watchId, createdAt: w.createdAt });
      } catch {
        // a spec that no longer compiles is dropped; its owner sees it missing from `watches`
      }
    }
    return r;
  }

  /**
   * Authorize a call that names a session it may also create (run, start, session_open). A name the
   * caller cannot even observe belongs to someone else: say so, instead of naming a verb (ux-9).
   */
  private authorizeName(caller: Caller, s: AnySession, verb: Verb): void {
    if (this.can(caller.principal, s, verb)) return;
    const id = sessionId(s);
    if (!this.can(caller.principal, s, 'observe')) throw err('session_exists', `the name ${id} belongs to another principal; choose another name`, { session: id });
    this.authorize(caller.principal, s, verb);
  }

  /**
   * Who owns a new life of a name whose shell ended (G30): its recorded owner, when the caller is that
   * owner or its GUI (§12); refused for anyone else, with the reason.
   */
  private newLifeOwner(caller: Caller, existing: AnySession | undefined, id: string): Principal {
    if (!existing || caller.principal === SYSTEM) return caller.principal;
    // A recovered session whose record was repaired names its owner once re-read. Ask the registry to
    // re-read a refused (damaged or missing) record before judging, so the refusal's promise — it names
    // the owner without a restart — holds for every caller, not only the system, which reached the
    // registry's own re-read first (the house's read of the 36 commits, #22, comment 6269992150).
    const current = existing.kind === 'history' ? this.registry.rereadIfRefused(id) ?? existing : existing;
    const owner = current.kind === 'live' ? current.session.owner : current.owner;
    if (caller.principal === owner || guiActsFor(caller.principal, owner)) return owner;
    if (!this.can(caller.principal, current, 'observe')) throw err('session_exists', `the name ${id} belongs to another principal; choose another name`, { session: id });
    throw err('forbidden', endedMessage(current, false), { session: id, owner });
  }

  private busyResult(session: Session, target: RunTarget, reason: string, occupant: RunInfo | null | undefined, created: boolean): RunResult {
    const last = session.journal.lastSeq;
    const busy: NonNullable<RunResult['busy']> = { reason };
    if (occupant) {
      busy.runId = occupant.runId;
      busy.principal = occupant.principal;
      if (occupant.line !== undefined) busy.line = head(occupant.line, 80);
    }
    const res: RunResult = {
      session: session.id,
      target,
      state: 'busy',
      cwd: session.cwd,
      attribution: target === 'process' ? 'exact' : 'temporal',
      output: { text: '', truncated: false, seq: [last, last], nextCursor: last },
      busy,
      integration: session.integration,
    };
    if (created) res.created = true;
    return res;
  }

  async run(
    caller: Caller,
    o: { session: string; command: string; target?: RunTarget; wait?: number; queue?: boolean; cwd?: string; envBasis?: EnvBasis; idempotencyKey?: string },
  ): Promise<RunResult> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'run',
      o,
      async (idem) => {
        const { session, created } = await this.liveSession(caller, o.session, 'run', o.cwd !== undefined ? { cwd: o.cwd } : {});
        this.ensureAttached(caller, session);
        const target = o.target ?? 'shell';
        const admitOpts: Parameters<Session['admitWhenAvailable']>[0] = { target, line: o.command, principal: caller.principal };
        if (o.queue) admitOpts.queue = true;
        if (o.envBasis) admitOpts.envBasis = o.envBasis;
        if (idem !== undefined) admitOpts.idem = idem;
        Object.assign(admitOpts, this.seat(caller, session));
        const a = await session.admitWhenAvailable(admitOpts);
        if (!a.admitted) return this.busyResult(session, target, a.reason, a.busy, created);
        const result = await this.finishRun(caller, this.entry(session), a.run.runId, o.wait);
        if (created) result.created = true;
        else if (o.cwd !== undefined && o.cwd !== session.cwd) result.ignored = ['cwd'];
        return result;
      },
      (prev) => this.replayRun(caller, prev, o.wait),
      { keep: remembered, compact: compactRun, recover: (idem) => this.recoverRun(idem) },
    );
  }

  /**
   * Declare the program in front of a session's terminal a shell (§8.1), or take the last
   * declaration back with `none`. Shell Runs then go to it until the Run whose program it is ends.
   * Keyed like the other operations: a retried `none` must not take a second declaration back.
   */
  async declareShell(
    caller: Caller,
    o: { session: string; shell?: string; within?: string; idempotencyKey?: string },
  ): Promise<{ session: string; shell: string | null; within: string | null; depth: number; line?: string; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'session_declare_shell',
      o,
      async () => {
        // A declaration names what is in front of an existing terminal: a name with no live session has
        // nothing to declare, and a refusal must not leave a shell it started (the house's read of 1cabc6a, #22).
        const session = this.liveFor(caller, o.session, 'run');
        this.ensureAttached(caller, session);
        const r = session.declareShell({ principal: caller.principal, ...(o.shell !== undefined && { shell: o.shell }), ...(o.within !== undefined && { within: o.within }), ...this.seat(caller, session) });
        const res: { session: string; shell: string | null; within: string | null; depth: number; line?: string } = { session: session.id, ...r };
        const line = r.within ? session.run(r.within).line : undefined;
        if (line !== undefined) res.line = head(line, 80);
        return res;
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  /**
   * A keyed Run admitted before a restart (G16): its admission journaled the key's identity, so a
   * retry finds it instead of executing again. The index is built once, from what recovery loaded.
   */
  private indexRecoveredIdem(): void {
    if (!this.recoveredIdem) {
      this.recoveredIdem = new Map();
      const since = Date.now() - this.idem.windowMs;
      for (const s of this.registry.list()) {
        for (const r of s.listRuns()) {
          if (r.idem === undefined || r.admittedAt < since) continue;
          this.recoveredIdem.set(r.idem, { session: sessionId(s), run: r });
          const identity = idemIdentity(r.idem);
          if (identity && r.admittedAt > (this.recoveredKeys.get(identity.key)?.at ?? -Infinity)) {
            this.recoveredKeys.set(identity.key, { tool: identity.tool, digest: identity.digest, at: r.admittedAt });
          }
        }
      }
    }
  }

  private recoverRun(idem: string): RunResult | undefined {
    this.indexRecoveredIdem();
    const hit = this.recoveredIdem!.get(idem);
    if (!hit || this.runAgeMs(hit.session, hit.run) > this.idem.windowMs) return undefined;
    const r = hit.run;
    const last = r.seq.end ?? r.seq.admit;
    return { runId: r.runId, session: hit.session, target: r.target, state: r.state, cwd: r.cwd ?? '', attribution: r.attribution, output: { text: '', truncated: false, seq: [r.seq.admit, last], nextCursor: last } };
  }

  /** The Run's age for a window this daemon life measures: monotonic when this life admitted it, else the wall clock's, the only stamp a recovered Run has (a reviewer's read of the fixes for #22 comment 6270045466). */
  private runAgeMs(sessionId: string, run: RunInfo): number {
    const s = this.registry.get(sessionId);
    return (s?.kind === 'live' ? s.session.runAgeMs(run.runId) : undefined) ?? Date.now() - run.admittedAt;
  }

  /** A retried `run` or `start` (G16): the same Run, awaited again — never a second execution. */
  private async replayRun(caller: Caller, prev: RunResult, wait: number | undefined): Promise<RunResult> {
    if (prev.runId === undefined) return { ...prev, replayed: true };
    let again: RunResult;
    try {
      again = await this.awaitRun(caller, { session: prev.session, runId: prev.runId, ...(wait !== undefined ? { wait } : {}) });
    } catch (e) {
      // The session was forgotten since: the first outcome is all there is (atc-21), and its text went with
      // the session — the empty text is a cut, and says so (the house's read of 1cabc6a, #22).
      if (e instanceof TermError && (e.code === 'session_not_found' || e.code === 'run_not_found')) return { ...prev, replayed: true, output: { ...prev.output, truncated: true } };
      throw e;
    }
    const res: RunResult = { ...again, replayed: true };
    if (prev.created) res.created = true;
    return res;
  }

  async awaitRun(caller: Caller, o: { session?: string; runId: string; wait?: number }): Promise<RunResult> {
    const { s } = this.findRun(caller, o.runId, o.session);
    return this.finishRun(caller, s, o.runId, o.wait);
  }

  /** The registry entry of a live Session. */
  private entry(session: Session): AnySession {
    const e = this.registry.get(session.id);
    if (!e || e.kind !== 'live' || e.session !== session) throw err('session_not_found', `session ${session.id} is gone`, { session: session.id });
    return e;
  }

  /**
   * A result returned content to the caller: advance its `read` cursor (G22). When the caller's
   * delivery is deferred (a connection that can drop), stage the advance on the result for the
   * transport to run once the write succeeded; otherwise advance now (the house's read of 1cabc6a,
   * #22). The commit finds the session by name when it runs (see markRead), and decides where the
   * cursor lands then, not when the result is staged (see advanceReadAfterRun).
   */
  private advanceRead<T extends object>(result: T, caller: Caller, commit: () => void): T {
    if (caller.deferReadDelivery) stageReadCommit(result, commit);
    else commit();
    return result;
  }

  /** Stage the caller's `read`-cursor advance to `to` for a result that showed the session's output as a whole (a page, a tail, the screen). */
  private advanceReadTo<T extends object>(result: T, caller: Caller, id: string, to: Seq): T {
    return this.advanceRead(result, caller, () => {
      const now = this.registry.get(id);
      if (now) this.markRead(now, caller.principal, to);
    });
  }

  /** The live Session a Run belongs to, if it is a Run of the session's current shell. */
  private liveRunner(s: AnySession, runId: string): Session | undefined {
    if (s.kind !== 'live') return undefined;
    try {
      s.session.run(runId);
      return s.session;
    } catch {
      return undefined;
    }
  }

  private async finishRun(caller: Caller, s: AnySession, runId: string, wait: number | undefined): Promise<RunResult> {
    const session = this.liveRunner(s, runId);
    const id = sessionId(s);
    let run: RunInfo;
    if (session) {
      const ms = clamp(wait ?? this.defaultWaitMs, 0, this.maxWaitMs);
      // Waiting with our principal lets the lane withhold this Run's completion from us (G28).
      run = await session.awaitRun(runId, ms, caller.principal);
      // Let the prompt that follows an end mark land, so `cwd` is current and the caller's next run does not race it.
      // (A declared shell's Run has no prompt the daemon can see, and its enclosing Run keeps the shell busy.)
      if (isTerminal(run.state) && run.target === 'shell' && run.shell === undefined) await session.waitAvailable(500);
    } else {
      // A Run of an ended shell (history, or an earlier life of this name): its recorded outcome.
      run = s.run(runId);
    }
    const out = await this.runText(s, run, session);
    const res: RunResult = {
      runId: run.runId,
      session: id,
      target: run.target,
      state: run.state,
      // A declared shell's cwd is not tracked (§8.1): the result says so rather than naming the session's.
      cwd: run.shell !== undefined ? '' : (run.cwd ?? session?.cwd ?? ''),
      origin: run.origin,
      principal: run.principal,
      attribution: run.attribution,
      output: out,
    };
    if (session && isTerminal(run.state) && run.target === 'shell' && run.shell === undefined) res.cwd = session.cwd;
    if (run.exit !== undefined) res.exit = run.exit;
    if (run.signal) res.signal = run.signal;
    if (run.reason) res.reason = run.reason;
    if (run.leftovers) res.leftovers = true;
    if (run.pipeStatus) res.pipeStatus = [...run.pipeStatus];
    if (run.startedAt !== undefined) res.durationMs = (run.endedAt ?? Date.now()) - run.startedAt;
    else if (run.state === 'queued') res.queuedMs = Date.now() - run.admittedAt;
    if (run.envBasis) res.envBasis = run.envBasis;
    if (run.line !== undefined) res.line = head(run.line, 200);
    if (run.shell !== undefined) res.shell = run.shell;
    if (run.within !== undefined) res.within = run.within;
    if (session) {
      res.integration = session.integration;
      const waiting = this.waitingEvidence(session, run);
      if (waiting) res.waiting = waiting;
    }
    // This result showed the Run's output: the caller's read cursor moves by the one rule (G22), for a
    // Run of an earlier life or of history as for one of the live shell, so presence stops reporting
    // what the caller has seen and keeps reporting what it has not (the house's read of 1cabc6a, #22).
    // The outcome counts as delivered (G28) only once the transport wrote it: see outcomeSent.
    return this.advanceReadAfterRun(res, caller, s, run.runId, out.nextCursor);
  }

  /**
   * Stage the caller's `read`-cursor advance for a result that showed one Run's output (run, await,
   * start, read with a runId), on a live session or history: where it lands is readCursorAfterRun's
   * rule, applied when the commit runs. Decided when the result was staged, two results outstanding
   * at once would each freeze a target below the other's unread output, and the cursor would stay
   * behind after both were delivered (the house's read of 78c4d6e, #22).
   */
  private advanceReadAfterRun<T extends object>(result: T, caller: Caller, s: AnySession, runId: string, to: Seq): T {
    const id = sessionId(s);
    return this.advanceRead(result, caller, () => {
      const now = this.registry.get(id);
      if (now) this.markRead(now, caller.principal, this.readCursorAfterRun(now, caller.principal, runId, to));
    });
  }

  /**
   * Advance a principal's read cursor on `s`, the entry the name has when the commit runs (its
   * callers look it up then, once): a staged commit can run after the entry it read was closed and
   * the name reopened, and the old life's Session would then hand the book that life's cursors
   * whole, behind the new life's (the house's read of 78c4d6e, #22). The journal is continuous
   * across lives (G1), so the position means the same on the new life; a live session takes no
   * cursor past its journal, history takes it as given, and neither moves a cursor back.
   */
  private markRead(s: AnySession, principal: Principal, at: Seq): void {
    if (s.kind === 'live') {
      if (at <= s.session.journal.lastSeq) s.session.markRead(principal, at);
    } else s.markRead(principal, at);
  }

  /**
   * Where a result that showed one Run's output leaves the caller's `read` cursor: at `to`, unless
   * output of another Run lies unread between the cursor and `to` (its result not returned to the
   * caller, its output not read since): then just before that output, so presence keeps reporting
   * it (the house's read of 1cabc6a, #22: a later Run's result hid an earlier Run's unread output).
   */
  private readCursorAfterRun(s: AnySession, principal: Principal, runId: string, to: Seq): Seq {
    const read = (s.kind === 'live' ? s.session : s).cursorsOf(principal).read;
    let at = to;
    for (const r of s.listRuns()) {
      if (r.runId === runId || (r.seq.end !== undefined && r.seq.end <= read) || (r.seq.start ?? r.seq.admit) > at) continue;
      if (s.kind === 'live' && s.session.outcomeDeliveredTo(r.runId, principal)) continue;
      const first = s.runOutput(r.runId, { since: read, until: at, limit: 1 }).events[0];
      if (first) at = first.seq - 1;
    }
    return at;
  }

  /**
   * The transport wrote a result carrying this Run's outcome to the caller (ToolResult.onSent):
   * from now on the lane withholds the completion from them (G28). Before this, a call orphaned by
   * a dropped connection would have swallowed the completion (mcpl-1).
   */
  outcomeSent(caller: Caller, r: { session: string; runId?: string; state: string; service?: string }): void {
    if (r.runId === undefined) return;
    const s = this.registry.get(r.session);
    if (s?.kind !== 'live') return;
    try {
      s.session.run(r.runId);
    } catch {
      return; // a Run of an earlier life: its completion was settled in that life
    }
    if (isTerminal(r.state as RunInfo['state'])) s.session.markOutcomeDelivered(r.runId, caller.principal);
    // A start result carried this service status: the lane does not announce that status event again
    // (mcpl-13) — the very event the result rendered, named by its seq, never the status as it stands
    // at the write: a ready, unhealthy, ready flap before the write would mark the later ready, which
    // the result never carried, and the recovery would go unannounced (the house's read of 2f357bd
    // and of 78c4d6e, #22). A status that moved on before the write is announced as usual.
    if (r.service !== undefined && r.service !== 'starting') {
      const seq = statusSeqOf.get(r);
      if (seq !== undefined) s.session.markOutcomeDelivered(serviceOutcomeKey(r.runId, r.service, seq), caller.principal);
    }
  }

  /**
   * Evidence that a running shell Run waits for someone (G15, heuristic, for plain MCP where the lane's
   * needs-input message never arrives): a full-screen program, or a prompt-like last line after silence.
   */
  private waitingEvidence(session: Session, run: RunInfo): RunResult['waiting'] | undefined {
    if (run.state !== 'running' || run.target !== 'shell') return undefined;
    // G15 carries the session state alongside the line and the silence (the house's read of 1cabc6a, #22).
    if (session.screen.alt) return { kind: 'tui', state: session.state, heuristic: true };
    const recent = session.journal.tail(64);
    let lastOut: JournalEvent | undefined;
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i]!;
      if (e.type === 'output' || e.type === 'input') {
        lastOut = e;
        break;
      }
    }
    const silentMs = Date.now() - (lastOut?.ts ?? run.startedAt ?? Date.now());
    if (silentMs < 3000) return undefined;
    const line = promptLine(session.snapshot());
    if (line === undefined) return undefined;
    return { kind: 'input', lastLine: head(line, 200), silentMs, state: session.state, heuristic: true };
  }

  /** The Run's output as result text: the tail, capped, with the cut visible and the route to all of it. */
  private async runText(s: AnySession, run: RunInfo, session?: Session): Promise<RunResult['output']> {
    let text: string;
    let from: Seq;
    let to: Seq;
    let truncated = false;
    if (session) {
      const t = await session.runTranscript(run.runId);
      text = t.text;
      from = t.seq[0];
      to = t.seq[1];
      truncated = t.truncated;
    } else {
      // History is rendered by the one renderer the segmenter uses too: the plumbing a Run left in
      // the journal is cut by the strategy and nonce its run.start recorded, by shape only for a Run
      // journaled before they were (the house's read of 1cabc6a and of 39787b3, #22), at the size
      // the Run recorded, else the session's.
      const o = s.runOutput(run.runId, { maxBytes: HISTORY_INPUT_BYTES });
      const t = await journalRunText(o, { ...geometryOf(s), maxInputBytes: HISTORY_INPUT_BYTES }, run);
      text = t.text;
      from = t.seq[0];
      to = t.seq[1];
      truncated = t.truncated;
    }
    const cut = cutTail(text, this.resultBytes);
    if (cut.cut) text = `[… earlier output omitted · read runId=${run.runId} pages through all of it]\n${cut.text}`;
    return { text, truncated: truncated || cut.cut, seq: [from, to], nextCursor: to };
  }

  async cancel(caller: Caller, o: { session?: string; runId: string; idempotencyKey?: string }) {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'cancel',
      o,
      async () => {
        const { s, run } = this.findRun(caller, o.runId, o.session);
        const runner = this.liveRunner(s, o.runId);
        this.authorize(caller.principal, s, 'signal');
        // A Run of an ended shell (history, or an earlier life of this name): its recorded outcome (jr2-13).
        if (!runner) return { runId: o.runId, state: run.state, contract: run.target, steps: [] as string[] };
        return runner.cancel(o.runId, caller.principal, this.seat(caller, runner));
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  // ───────────── services (§8.3) ─────────────

  async start(
    caller: Caller,
    o: { session: string; command: string; target?: RunTarget; name?: string; wait?: number; cwd?: string; envBasis?: EnvBasis; idempotencyKey?: string } & ServiceSpec,
  ): Promise<RunResult> {
    validateServiceSpec(o);
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'start',
      o,
      async (idem) => {
        const { session, created } = await this.liveSession(caller, o.session, 'run', o.cwd !== undefined ? { cwd: o.cwd } : {});
        this.ensureAttached(caller, session);
        const target = o.target ?? 'shell';
        const admitOpts: Parameters<Session['admitWhenAvailable']>[0] = { target, line: o.command, principal: caller.principal };
        if (o.envBasis) admitOpts.envBasis = o.envBasis;
        if (idem !== undefined) admitOpts.idem = idem;
        Object.assign(admitOpts, this.seat(caller, session));
        const a = await session.admitWhenAvailable(admitOpts);
        if (!a.admitted) return this.busyResult(session, target, a.reason, a.busy, created);
        const spec: ServiceSpec = {};
        if (o.ready) spec.ready = o.ready;
        if (o.fail) spec.fail = o.fail;
        if (o.health) spec.health = o.health;
        const monitor = this.extras(session).services.watch(a.run.runId, spec, caller.principal, o.name);
        const res = await this.serviceResult(caller, session, a.run.runId, await this.settled(monitor, o.wait));
        if (created) res.created = true;
        else if (o.cwd !== undefined && o.cwd !== session.cwd) res.ignored = ['cwd'];
        return res;
      },
      async (prev) => {
        if (prev.runId === undefined) return { ...prev, replayed: true };
        const s = this.registry.get(prev.session);
        const monitor = s?.kind === 'live' ? this.extras(s.session).services.get(prev.runId) : undefined;
        if (!s || s.kind !== 'live' || !monitor) return this.replayRun(caller, prev, o.wait);
        // The result itself, not a copy: the status event it rendered rides with it for outcomeSent.
        const res = await this.serviceResult(caller, s.session, prev.runId, await this.settled(monitor, o.wait));
        res.replayed = true;
        // The first call created the session: its replay says so too, as a replayed run does (the house's read of 1cabc6a, #22).
        if (prev.created) res.created = true;
        return res;
      },
      { keep: remembered, compact: compactRun, recover: (idem) => this.recoverRun(idem) },
    );
  }

  /**
   * The service's status once it has settled or the wait is up. The status as it stands then, not as it
   * was when the waiter woke: a ready line wakes it in the middle of an output chunk, and a fail line
   * later in the same chunk is matched before this continuation runs (the house's read of 1cabc6a, #22).
   */
  private async settled(monitor: { waitSettled(ms: number): Promise<ServiceInfo>; info(): ServiceInfo }, wait: number | undefined): Promise<ServiceInfo> {
    await monitor.waitSettled(clamp(wait ?? this.defaultWaitMs, 0, this.maxWaitMs));
    return monitor.info();
  }

  private async serviceResult(caller: Caller, session: Session, runId: string, info: ServiceInfo): Promise<RunResult> {
    const run = session.run(runId);
    const out = await this.runText(this.entry(session), run, session);
    const res: RunResult = {
      runId,
      session: session.id,
      target: run.target,
      state: run.state,
      // A declared shell's cwd is not tracked (§8.1), for a service as for a run (the house's read of 1cabc6a, #22).
      cwd: run.shell !== undefined ? '' : session.cwd,
      origin: run.origin,
      principal: run.principal,
      attribution: run.attribution,
      output: out,
      service: info.status,
      probe: info.probe,
    };
    if (info.evidence !== undefined) res.evidence = info.evidence;
    if (run.exit !== undefined) res.exit = run.exit;
    if (run.signal) res.signal = run.signal;
    if (run.reason) res.reason = run.reason;
    if (run.leftovers) res.leftovers = true;
    if (run.pipeStatus) res.pipeStatus = [...run.pipeStatus];
    if (run.startedAt !== undefined) res.durationMs = (run.endedAt ?? Date.now()) - run.startedAt;
    if (run.envBasis) res.envBasis = run.envBasis;
    if (run.shell !== undefined) res.shell = run.shell;
    if (run.within !== undefined) res.within = run.within;
    if (run.line !== undefined) res.line = head(run.line, 200);
    res.integration = session.integration;
    if (info.seq !== undefined) statusSeqOf.set(res, info.seq);
    // The one rule for a result that showed a Run's output (G22): another Run's unread output stays
    // unread, for a start as for a run or an await (the house's read of 78c4d6e, #22).
    return this.advanceReadAfterRun(res, caller, this.entry(session), runId, out.nextCursor);
  }

  // ───────────── watches (§4) ─────────────

  watch(caller: Caller, o: { session: string; idempotencyKey?: string } & WatchSpec): Promise<WatchInfo & { replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'watch',
      o,
      async () => {
        const session = this.liveFor(caller, o.session, 'observe');
        const { session: _s, idempotencyKey: _k, ...spec } = o;
        return this.extras(session).watches.add(spec, caller.principal);
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  unwatch(caller: Caller, o: { session: string; watchId: string; idempotencyKey?: string }): Promise<{ removed: boolean; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'unwatch',
      o,
      async () => {
        const session = this.liveFor(caller, o.session, 'observe');
        const w = this.extras(session).watches.get(o.watchId);
        if (!w) return { removed: false };
        if (w.owner !== caller.principal && session.owner !== caller.principal && caller.principal !== SYSTEM) {
          throw err('forbidden', `watch ${o.watchId} belongs to ${w.owner}`, { watchId: o.watchId });
        }
        return { removed: this.extras(session).watches.remove(o.watchId) };
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  watches(caller: Caller, o: { session: string }): WatchInfo[] {
    const session = this.liveFor(caller, o.session, 'observe');
    return this.extrasBySession.get(session)?.watches.list() ?? [];
  }

  async waitFor(caller: Caller, o: { session: string; wait?: number; since?: Seq } & WatchSpec): Promise<WaitResult & { session: string; nextCursor: Seq }> {
    const session = this.liveFor(caller, o.session, 'observe');
    const { session: _s, wait, since, ...spec } = o;
    const r = await this.extras(session).watches.waitFor(spec, clamp(wait ?? this.defaultWaitMs, 0, this.maxWaitMs), since);
    // Continue after the event that satisfied the wait, not after whatever the journal holds by now: a
    // line printed after the match is still ahead of the next wait's `since` (the house's read of 1cabc6a, #22).
    return { ...r, session: session.id, nextCursor: r.matched && r.seq !== undefined ? r.seq : session.journal.lastSeq };
  }

  // ───────────── terminal capabilities ─────────────

  input(caller: Caller, o: { session: string; text?: string; keys?: string[]; sensitive?: boolean; idempotencyKey?: string }): Promise<{ seq: Seq; replayed?: boolean }> {
    if (!o.text && !o.keys?.length) return Promise.reject(err('invalid_argument', 'input needs `text` or `keys`'));
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'input',
      o,
      async () => {
        const session = this.liveFor(caller, o.session, 'type');
        this.ensureAttached(caller, session);
        const data = inputBytes(o.text, o.keys, { appCursor: session.screen.applicationCursorKeys });
        const io: Parameters<Session['input']>[1] = { principal: caller.principal, kind: o.keys?.length ? 'keys' : 'text' };
        if (o.sensitive) io.sensitive = true;
        Object.assign(io, this.seat(caller, session));
        session.input(data, io);
        return { seq: session.journal.lastSeq };
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  signal(caller: Caller, o: { session: string; signal?: string; idempotencyKey?: string }): Promise<{ ok: true; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'signal',
      o,
      async () => {
        const session = this.liveFor(caller, o.session, 'signal');
        session.signal(o.signal ?? 'SIGINT', caller.principal, this.seat(caller, session));
        return { ok: true as const };
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  resize(caller: Caller, o: { session: string; cols: number; rows: number; idempotencyKey?: string }): Promise<{ ok: true; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'resize',
      o,
      async () => {
        const session = this.liveFor(caller, o.session, 'resize');
        session.resize(o.cols, o.rows, caller.principal, this.seat(caller, session));
        return { ok: true as const };
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  async screen(caller: Caller, o: { session: string }): Promise<ScreenSnapshot> {
    const session = this.liveFor(caller, o.session, 'observe');
    await session.screen.settled();
    const snap = session.snapshot();
    return this.advanceReadTo(snap, caller, session.id, snap.seq);
  }

  async control(caller: Caller, o: { session: string; action: 'take' | 'release' | 'status'; idempotencyKey?: string }): Promise<{ controller: Principal | null; replayed?: boolean }> {
    const act = async () => {
      const session = this.liveFor(caller, o.session, 'observe');
      if (o.action === 'take') {
        this.ensureAttached(caller, session);
        session.takeControl(caller.principal, this.seat(caller, session));
      } else if (o.action === 'release') session.releaseControl(caller.principal);
      return { controller: session.currentController };
    };
    if (o.action === 'status') return act();
    return this.idem.run(caller.principal, o.idempotencyKey, 'control', o, act, async (prev) => ({ ...prev, replayed: true }));
  }

  async envCapture(caller: Caller, o: { session: string; idempotencyKey?: string }): Promise<{ seq: Seq; count: number; replayed?: boolean }> {
    return this.idem.run(
      caller.principal,
      o.idempotencyKey,
      'session_env_capture',
      o,
      async () => {
        const session = this.liveFor(caller, o.session, 'run');
        const snap = await session.captureEnv(caller.principal, undefined, this.seat(caller, session));
        return { seq: snap.seq, count: Object.keys(snap.vars).length };
      },
      async (prev) => ({ ...prev, replayed: true }),
    );
  }

  // ───────────── the journal ─────────────

  /**
   * Read by cursor (G11); see `readJournal`. Advances the caller's `read` cursor (G22) unless
   * `advance: false`: a read for output a tool shows beside its answer without being asked for
   * (the compat launch's tail) counts as nothing read (a reviewer's read of the fixes for comment
   * 6270045466, #22). The tools never pass it.
   */
  async read(caller: Caller, o: { session: string; advance?: boolean } & ReadOptions): Promise<ReadResult> {
    const s = this.find(caller, o.session, 'observe');
    const { session: _, advance, ...opts } = o;
    if (o.runId !== undefined) opts.runId = this.findRun(caller, o.runId, sessionId(s)).run.runId;
    const r = await readJournal(readSource(s), opts, { resultBytes: this.resultBytes });
    if (advance === false) return r;
    // A page of one Run leaves other Runs' unread output unread (see readCursorAfterRun); a page of the session reads to its cursor.
    if (opts.runId !== undefined) return this.advanceReadAfterRun(r, caller, s, opts.runId, r.nextCursor);
    return this.advanceReadTo(r, caller, sessionId(s), r.nextCursor);
  }

  /**
   * How the daemon's plumbing is told from a program's in the session's output between `from` and
   * `to` (observe): the strategy and nonce each Run there recorded in its run.start, for a reader of
   * the session's text as a whole, which no Run renderer cuts for (the compat pack's logs). A Run's
   * own text is cut by the renderers; a Run journaled before the recording has neither, and its
   * marks are found by shape (the house's read of 78c4d6e, #22).
   */
  runPlumbing(caller: Caller, o: { session: string; from: Seq; to: Seq }): Array<Pick<PlumbingOf, 'strategy' | 'nonce'>> {
    const s = this.find(caller, o.session, 'observe');
    const out: Array<Pick<PlumbingOf, 'strategy' | 'nonce'>> = [];
    for (const r of s.listRuns()) {
      if ((r.seq.end ?? Number.POSITIVE_INFINITY) < o.from || r.seq.admit > o.to) continue;
      // Only a shell Run prints marks; a process Run records no strategy, and reading its absence as "journaled
      // before the recording" would cut program lines by shape whenever one is in the window.
      if (r.target !== 'shell') continue;
      // Nor does a shell Run that has not started: it gets its strategy and nonce at its start, so a queued one
      // would read as journaled before the recording, and while it waited every mark-shaped line, a program's
      // included, would be cut (the house's read of the 38 commits, #22, comment 6274935728, item 5).
      if (r.seq.start === undefined) continue;
      const p: Pick<PlumbingOf, 'strategy' | 'nonce'> = {};
      if (r.strategy !== undefined) p.strategy = r.strategy;
      if (r.nonce !== undefined) p.nonce = r.nonce;
      out.push(p);
    }
    return out;
  }

  /** Regex over output lines with seq anchors and context (§11 `search`). */
  async search(caller: Caller, o: { session: string } & SearchOptions): Promise<SearchResult> {
    const s = this.find(caller, o.session, 'observe');
    const { session: _, ...opts } = o;
    if (o.runId !== undefined) opts.runId = this.findRun(caller, o.runId, sessionId(s)).run.runId;
    return searchJournal(readSource(s), opts);
  }

  /** Record a channel annotation (§10.1): what an agent said on a session's channel, visible to observers, never typed. */
  note(caller: Caller, o: { session: string; text: string; channel?: string }): { seq: Seq } {
    const session = this.liveFor(caller, o.session, 'observe');
    const ev: Parameters<Session['journal']['append']>[0] = { type: 'note', text: o.text, principal: caller.principal };
    if (o.channel !== undefined) ev.channel = o.channel;
    return { seq: session.journal.append(ev).seq };
  }
}

export type { ReadResult, SearchResult } from './reader.js';

const sessionId = (s: AnySession): string => (s.kind === 'live' ? s.session.id : s.id);

/** Options that apply only when a call creates the session: listed as ignored otherwise. */
const CREATION_OPTIONS = ['cwd', 'shell', 'shellArgs', 'env', 'visibility', 'control', 'cols', 'rows', 'retention', 'login', 'integration', 'userRc'] as const;

/** A command line shortened for results and lists: the journal keeps the whole of it (ux-19). */
function head(line: string, max = 120): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…(${Buffer.byteLength(line)} bytes)`;
}


/** How much of a Run's newest output a result rendered from history reads. */
const HISTORY_INPUT_BYTES = 1024 * 1024;

/**
 * The geometry a session's pages project at (§6 rule 1): a live session's screen; for history, what the
 * session recorded at creation (a resize during its life is not kept there; a Run's pages use the
 * Run's own recorded geometry) — the house's read of 1cabc6a, #22.
 */
function geometryOf(s: AnySession): { cols: number; rows: number } {
  if (s.kind === 'live') return { cols: s.session.screen.cols, rows: s.session.screen.rows };
  return { cols: s.options.cols ?? DEFAULT_GEOMETRY.cols, rows: s.options.rows ?? DEFAULT_GEOMETRY.rows };
}


function readSource(s: AnySession): ReadSource {
  const geometry = geometryOf(s);
  return {
    id: sessionId(s),
    journal: s.kind === 'live' ? s.session.journal : s.journal,
    cols: geometry.cols,
    rows: geometry.rows,
    run: (runId) => {
      try {
        return s.run(runId);
      } catch {
        return undefined;
      }
    },
    runOutput: (runId, range) => s.runOutput(runId, range),
  };
}

