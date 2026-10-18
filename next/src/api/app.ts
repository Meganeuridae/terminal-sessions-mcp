/**
 * The typed application API (§11): every adapter — MCP/MCPL, native, CLI — is a
 * thin translation of these operations. Verbs are enforced here for every
 * adapter (G18); the seat is enforced in the core. Every mutating operation
 * takes an optional idempotency key (G16): a retry within the window gets the
 * original outcome instead of a second execution.
 */
import { createHash } from 'node:crypto';
import { err, TermError } from '../core/errors.js';
import { inputBytes } from '../core/keys.js';
import { validateServiceSpec, type ServiceSpec } from '../core/probes.js';
import { promptLine, Segmenter, type SegmenterOptions } from '../core/segmenter.js';
import { ServiceManager, type ServiceInfo } from '../core/services.js';
import { isTerminal, type Session } from '../core/session.js';
import { cutTail } from '../core/text.js';
import { project } from '../core/transcript.js';
import type { Attribution, EnvBasis, JournalEvent, Principal, RunInfo, RunTarget, ScreenSnapshot, Seq, ServiceStatus, Visibility } from '../core/types.js';
import { SYSTEM } from '../core/types.js';
import { WatchManager, type WaitResult, type WatchInfo, type WatchSpec } from '../core/watches.js';
import { guiActsFor } from './principals.js';
import type { AnySession, CreateOptions, SessionRegistry } from './registry.js';
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
  /** A running Run that seems to wait for someone (G15, heuristic): a prompt-like last line after silence, or a full-screen program. */
  waiting?: { kind: 'input' | 'tui'; lastLine?: string; silentMs?: number; heuristic: true };
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

export interface SessionSummary {
  id: string;
  owner: Principal;
  visibility: Visibility;
  state: string;
  controller: Principal | null;
  cwd?: string;
  integration?: string;
  backend?: string;
  pid?: number;
  currentRun?: string | null;
  lastSeq: Seq;
  oldestSeq?: Seq;
  /** What the session keeps on disk (G21). */
  retention?: { maxBytes?: number; maxAgeMs?: number };
  recovered?: 'continuous' | 'reattached' | 'history-only';
  closed?: boolean;
  createdAt?: number;
  lastActivity?: number;
  services?: Array<{ runId: string; name?: string; status: ServiceStatus }>;
  watches?: number;
  /** Runs that have not ended (shell and process), newest last, so a lost runId can be found again. */
  runs?: Array<{ runId: string; target: RunTarget; state: RunInfo['state']; principal: Principal; line?: string; admittedAt: number }>;
}

export interface Caller {
  principal: Principal;
  /** Identifies the connection for attachments. */
  connectionId: string;
}

interface Extras {
  services: ServiceManager;
  watches: WatchManager;
  segmenter?: Segmenter;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
type Output = Extract<JournalEvent, { type: 'output' }>;
const isOutput = (e: JournalEvent): e is Output => e.type === 'output';

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
  at: number;
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
 * is kept for a call that admitted nothing (`busy`), so its retry can run. Bounded: keys are
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
    const now = Date.now();
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
      this.put(k, { principal, tool, digest, at: now, value: Promise.resolve(recovered) });
      return replay(recovered);
    }
    const value = fn(idem);
    const entry: IdemEntry = { principal, tool, digest, at: now, value };
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

  /** Entries are in insertion (time) order: expire from the oldest until one is inside the window. */
  private sweep(now: number): void {
    for (const [k, v] of this.entries) {
      if (now - v.at <= this.windowMs) break;
      this.drop(k, v);
    }
  }
}

/** A RunResult without its output text: what an idempotency entry keeps (the replay awaits the Run again). */
const compactRun = (r: RunResult): RunResult => ({ ...r, output: { ...r.output, text: '' } });
const admitted = (r: RunResult) => r.state !== 'busy';

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
    if (!s) throw err('session_not_found', `session ${id} not found`, { session: id });
    this.authorize(caller.principal, s, verb);
    return s;
  }

  private liveFor(caller: Caller, id: string, verb: Verb): Session {
    const s = this.find(caller, id, verb);
    if (s.kind !== 'live') throw err('session_exited', `session ${id} has ended; its history is readable with read, and session_open starts a new shell under this name`, { session: id });
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

  /** Find a Run by id across the sessions the caller may observe (runIds are unique per daemon). */
  private findRun(caller: Caller, runId: string, sessionId?: string): { s: AnySession; run: RunInfo } {
    const candidates = sessionId !== undefined ? [this.find(caller, sessionId, 'observe')] : this.registry.list().filter((s) => this.can(caller.principal, s, 'observe'));
    for (const s of candidates) {
      try {
        return { s, run: s.run(runId) };
      } catch (e) {
        if (!(e instanceof TermError && e.code === 'run_not_found')) throw e;
      }
    }
    throw err('run_not_found', `run ${runId} not found${sessionId !== undefined ? ` in session ${sessionId}` : ''}`, { runId });
  }

  // ───────────── sessions ─────────────

  private summary(s: AnySession): SessionSummary {
    if (s.kind === 'live') {
      const i = s.session.info();
      const out: SessionSummary = {
        id: i.id,
        owner: i.owner,
        visibility: i.visibility,
        state: i.state,
        controller: i.controller,
        cwd: i.cwd,
        integration: i.integration,
        backend: i.backend,
        pid: i.pid,
        currentRun: i.currentRun,
        lastSeq: i.lastSeq,
        createdAt: i.createdAt,
        lastActivity: i.lastActivity,
      };
      const oldest = s.session.journal.oldestSeq;
      if (oldest !== undefined) out.oldestSeq = oldest;
      out.retention = { ...s.retention };
      const x = this.extrasBySession.get(s.session);
      if (x) {
        const services = x.services.list().map((v) => ({ runId: v.runId, status: v.status, ...(v.name !== undefined ? { name: v.name } : {}) }));
        if (services.length) out.services = services;
        const w = x.watches.list().length;
        if (w) out.watches = w;
      }
      const runs = s.session
        .listRuns()
        .filter((r) => !isTerminal(r.state))
        .slice(-20)
        .map((r) => ({ runId: r.runId, target: r.target, state: r.state, principal: r.principal, admittedAt: r.admittedAt, ...(r.line !== undefined ? { line: head(r.line) } : {}) }));
      if (runs.length) out.runs = runs;
      return out;
    }
    const out: SessionSummary = { id: s.id, owner: s.owner, visibility: s.visibility, state: 'exited', controller: null, lastSeq: s.journal.lastSeq };
    if (s.closed) out.closed = true;
    else out.recovered = s.recovered;
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
        const att = session.attach(caller.principal, caller.connectionId, o.role ?? 'auto');
        const res: { created: boolean; info: SessionSummary; role: 'observer' | 'controller'; ignored?: string[] } = { created, info: this.summary(this.entry(session)), role: att.role };
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
        const s = this.find(caller, o.session, 'destroy');
        if (s.kind === 'live') await this.registry.close(o.session, { graceful: !o.force });
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
    const carried = existing?.kind === 'live' ? (this.extrasBySession.get(existing.session)?.watches.list() ?? []) : [];
    const r = await this.registry.ensure({ ...create, id, owner: this.newLifeOwner(caller, existing, id) });
    if (!r.created) this.authorizeName(caller, this.entry(r.session), verb);
    for (const w of r.created ? carried : []) {
      try {
        this.extras(r.session).watches.add(w.spec, w.owner);
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
    const owner = existing.kind === 'live' ? existing.session.owner : existing.owner;
    if (caller.principal === owner || guiActsFor(caller.principal, owner)) return owner;
    if (!this.can(caller.principal, existing, 'observe')) throw err('session_exists', `the name ${id} belongs to another principal; choose another name`, { session: id });
    throw err('forbidden', `session ${id} has ended; only its owner (${owner}) may start it again (G30) — its history stays readable with read`, { session: id, owner });
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
      { keep: admitted, compact: compactRun, recover: (idem) => this.recoverRun(idem) },
    );
  }

  /**
   * Declare the program in front of a session's terminal a shell (§8.1), or take the last
   * declaration back with `none`. Shell Runs then go to it until the Run whose program it is ends.
   */
  async declareShell(caller: Caller, o: { session: string; shell?: string; within?: string }): Promise<{ session: string; shell: string | null; within: string | null; depth: number; line?: string }> {
    const { session } = await this.liveSession(caller, o.session, 'run', {});
    this.ensureAttached(caller, session);
    const r = session.declareShell({ principal: caller.principal, ...(o.shell !== undefined && { shell: o.shell }), ...(o.within !== undefined && { within: o.within }), ...this.seat(caller, session) });
    const res: { session: string; shell: string | null; within: string | null; depth: number; line?: string } = { session: session.id, ...r };
    const line = r.within ? session.run(r.within).line : undefined;
    if (line !== undefined) res.line = head(line, 80);
    return res;
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
    if (!hit || Date.now() - hit.run.admittedAt > this.idem.windowMs) return undefined;
    const r = hit.run;
    const last = r.seq.end ?? r.seq.admit;
    return { runId: r.runId, session: hit.session, target: r.target, state: r.state, cwd: r.cwd ?? '', attribution: r.attribution, output: { text: '', truncated: false, seq: [r.seq.admit, last], nextCursor: last } };
  }

  /** A retried `run` or `start` (G16): the same Run, awaited again — never a second execution. */
  private async replayRun(caller: Caller, prev: RunResult, wait: number | undefined): Promise<RunResult> {
    if (prev.runId === undefined) return { ...prev, replayed: true };
    let again: RunResult;
    try {
      again = await this.awaitRun(caller, { session: prev.session, runId: prev.runId, ...(wait !== undefined ? { wait } : {}) });
    } catch (e) {
      // The session was forgotten since: the first outcome is all there is (atc-21).
      if (e instanceof TermError && (e.code === 'session_not_found' || e.code === 'run_not_found')) return { ...prev, replayed: true };
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
      session.markRead(caller.principal, out.nextCursor);
      // The outcome counts as delivered (G28) only once the transport wrote it: see outcomeSent.
    }
    return res;
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
    // A start result carried this service status: the lane does not announce it again (mcpl-13).
    if (r.service !== undefined && r.service !== 'starting') s.session.markOutcomeDelivered(`${r.runId}:service=${r.service}`, caller.principal);
  }

  /**
   * Evidence that a running shell Run waits for someone (G15, heuristic, for plain MCP where the lane's
   * needs-input message never arrives): a full-screen program, or a prompt-like last line after silence.
   */
  private waitingEvidence(session: Session, run: RunInfo): RunResult['waiting'] | undefined {
    if (run.state !== 'running' || run.target !== 'shell') return undefined;
    if (session.screen.alt) return { kind: 'tui', heuristic: true };
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
    return { kind: 'input', lastLine: head(line, 200), silentMs, heuristic: true };
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
      const o = s.runOutput(run.runId, { maxBytes: 1024 * 1024 });
      const p = await project(
        o.events.filter(isOutput).map((e) => ({ data: e.data, stream: e.stream, ...(e.runId !== undefined ? { runId: e.runId } : {}) })),
        { cols: run.cols ?? 120, rows: run.rows ?? 30, maxInputBytes: 1024 * 1024, keep: 'tail' },
      );
      text = p.text;
      from = o.from;
      to = o.to;
      truncated = o.truncated || p.truncated;
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
        const info = await monitor.waitSettled(clamp(o.wait ?? this.defaultWaitMs, 0, this.maxWaitMs));
        const res = await this.serviceResult(caller, session, a.run.runId, info);
        if (created) res.created = true;
        else if (o.cwd !== undefined && o.cwd !== session.cwd) res.ignored = ['cwd'];
        return res;
      },
      async (prev) => {
        if (prev.runId === undefined) return { ...prev, replayed: true };
        const s = this.registry.get(prev.session);
        const monitor = s?.kind === 'live' ? this.extras(s.session).services.get(prev.runId) : undefined;
        if (!s || s.kind !== 'live' || !monitor) return this.replayRun(caller, prev, o.wait);
        const info = await monitor.waitSettled(clamp(o.wait ?? this.defaultWaitMs, 0, this.maxWaitMs));
        return { ...(await this.serviceResult(caller, s.session, prev.runId, info)), replayed: true };
      },
      { keep: admitted, compact: compactRun, recover: (idem) => this.recoverRun(idem) },
    );
  }

  private async serviceResult(caller: Caller, session: Session, runId: string, info: ServiceInfo): Promise<RunResult> {
    const run = session.run(runId);
    const out = await this.runText(this.entry(session), run, session);
    const res: RunResult = {
      runId,
      session: session.id,
      target: run.target,
      state: run.state,
      cwd: session.cwd,
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
    if (run.startedAt !== undefined) res.durationMs = (run.endedAt ?? Date.now()) - run.startedAt;
    if (run.envBasis) res.envBasis = run.envBasis;
    if (run.shell !== undefined) res.shell = run.shell;
    if (run.within !== undefined) res.within = run.within;
    if (run.line !== undefined) res.line = head(run.line, 200);
    res.integration = session.integration;
    session.markRead(caller.principal, out.nextCursor);
    return res;
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
    return { ...r, session: session.id, nextCursor: session.journal.lastSeq };
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
    session.markRead(caller.principal, snap.seq);
    return snap;
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

  /** Read by cursor (G11); see `readJournal`. Advances the caller's `read` cursor on a live session. */
  async read(caller: Caller, o: { session: string } & ReadOptions): Promise<ReadResult> {
    const s = this.find(caller, o.session, 'observe');
    const { session: _, ...opts } = o;
    if (o.runId !== undefined) opts.runId = this.findRun(caller, o.runId, sessionId(s)).run.runId;
    const r = await readJournal(readSource(s), opts, { resultBytes: this.resultBytes });
    if (s.kind === 'live' && r.nextCursor <= s.session.journal.lastSeq) s.session.markRead(caller.principal, r.nextCursor);
    else if (s.kind === 'history') s.markRead(caller.principal, r.nextCursor);
    return r;
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
const CREATION_OPTIONS = ['cwd', 'shell', 'env', 'visibility', 'control', 'cols', 'rows', 'retention', 'login'] as const;

/** A command line shortened for results and lists: the journal keeps the whole of it (ux-19). */
function head(line: string, max = 120): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…(${Buffer.byteLength(line)} bytes)`;
}


function readSource(s: AnySession): ReadSource {
  return {
    id: sessionId(s),
    journal: s.kind === 'live' ? s.session.journal : s.journal,
    cols: s.kind === 'live' ? s.session.screen.cols : 120,
    rows: s.kind === 'live' ? s.session.screen.rows : 30,
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

