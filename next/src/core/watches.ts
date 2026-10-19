/**
 * Watches (§4): standing predicates over a session's journal that emit a
 * `watch.fired` event when they fire — a pattern in the output, output going
 * quiet, or the shell becoming available. `waitFor` is the synchronous form:
 * block up to a deadline for the same predicates, without leaving a watch behind.
 *
 * Patterns match whole lines, as `search` does (see StreamMatcher): each line of
 * each stream is tested once, `^` and `$` are the line's ends (a line over 64 KiB
 * is matched in pieces of that size), and a line with no newline yet (a prompt)
 * is tested once its stream has been quiet for a moment. Every pattern compiles
 * on the linear-time engine, and a bad one is refused with invalid_argument when
 * the watch or wait is created.
 *
 * Quiet is measured on the monotonic clock. Output the manager saw arrive is
 * stamped as it arrives, so a silence measured from an earlier output is as exact
 * as one measured from arming; only output from before the manager existed takes
 * its age from the journal's wall-clock time, clamped at zero (the house's read of
 * 3eade8a, #22: a forward step of 10 s certified 5 s of silence in 1 ms).
 */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compileLinePattern, PARTIAL_QUIET_MS, StreamMatcher } from './ansi.js';
import { err } from './errors.js';
import type { Journal } from './journal.js';
import { MAX_TIMER_MS } from './probes.js';
import type { IntegrationLevel, JournalEvent, Principal, RunInfo, Seq } from './types.js';

export type WatchKind = 'pattern' | 'silence' | 'idle';

export interface WatchSpec {
  /** Regex over output lines (control sequences stripped). */
  pattern?: string;
  /** Fire each time output stops for this many ms (re-arms on the next output). */
  silenceMs?: number;
  /** Fire each time the shell becomes available after running something. */
  idle?: boolean;
  /** Only output attributed to this Run (it must exist in the session). */
  runId?: string;
  label?: string;
  /** Remove the watch after it fires once. */
  once?: boolean;
}

export interface WatchInfo {
  watchId: string;
  kind: WatchKind;
  label: string;
  owner: Principal;
  spec: WatchSpec;
  createdAt: number;
  fired: number;
  lastFiredAt?: number;
  lastMatch?: string;
}

export interface WaitResult {
  matched: boolean;
  kind: WatchKind;
  match?: string;
  line?: string;
  /** Journal position of the event that satisfied the wait. */
  seq?: Seq;
  elapsedMs: number;
  /** Why the wait ended early without a match: the session exited or closed, or the Run it names ended. */
  reason?: string;
}

export interface WatchHost {
  readonly journal: Journal;
  readonly integration: IntegrationLevel;
  waitAvailable(ms: number): Promise<boolean>;
  shellAvailable(): { ok: boolean };
  /** Set once the shell has exited (a live Session's `exit`). */
  readonly exit?: { exitCode: number | null; signal?: string } | undefined;
}

/** Minimum spacing between two firings of one pattern watch; matches in between are counted. */
const PATTERN_SPACING_MS = 1000;

/**
 * How long an armed idle watch waits on the host for availability before asking again. The shell
 * becomes available on timers that journal nothing (the typed-ahead grace, a stale edit), so the
 * journal alone would tell the watch only at the next journaled event (the house's read of 3eade8a, #22).
 */
const IDLE_RECHECK_MS = 30_000;

/** Which kind a spec asks for; validates it (exactly one kind, a pattern the engine accepts, a sane silence). */
export function kindOf(spec: WatchSpec): WatchKind {
  const kinds = [spec.pattern !== undefined && 'pattern', spec.silenceMs !== undefined && 'silence', spec.idle === true && 'idle'].filter(Boolean) as WatchKind[];
  if (kinds.length !== 1) throw err('invalid_argument', 'give exactly one of `pattern`, `silenceMs` or `idle`');
  if (spec.pattern !== undefined) {
    if (typeof spec.pattern !== 'string') throw err('invalid_argument', '`pattern` must be a string');
    compileLinePattern(spec.pattern);
  }
  // A timer past 2^31-1 ms fires at once in Node: a silence of 3e9 ms woke in a tight loop (the house's read of 3eade8a, #22).
  if (spec.silenceMs !== undefined && !(spec.silenceMs >= 100 && spec.silenceMs <= MAX_TIMER_MS)) throw err('invalid_argument', `silenceMs must be between 100 and ${MAX_TIMER_MS}`);
  if (spec.runId !== undefined && typeof spec.runId !== 'string') throw err('invalid_argument', '`runId` must be a string');
  return kinds[0]!;
}

/** Which matcher stream an output event belongs to: the PTY is one stream; each process pipe is its own. */
const streamKey = (ev: Extract<JournalEvent, { type: 'output' }>) => (ev.stream === 'pty' ? 'pty' : `${ev.stream}:${ev.runId ?? ''}`);

const isTerminal = (s: RunInfo['state']) => s === 'exited' || s === 'cancelled' || s === 'lost';

const exitText = (x: { exitCode: number | null; signal?: string }) => `session exited (${x.signal ? `signal ${x.signal}` : `code ${x.exitCode ?? '?'}`})`;

const endText = (r: { runId: string; state: string; exit?: number; signal?: string }) =>
  `run ${r.runId} ended (${r.state}${r.signal ? ` ${r.signal}` : r.exit !== undefined ? ` ${r.exit}` : ''})`;

type Hit = { match?: string; line?: string; seq: Seq };

/** The clock the quiet interval is measured on; a test may replace it. */
export const clocks = { monotonic: (): number => performance.now() };

/** A timer delay Node honours: never past 2^31-1 ms, never negative. */
const timerMs = (ms: number) => Math.min(MAX_TIMER_MS, Math.max(0, ms));

/** Evaluates one predicate against journal events; shared by watches and waits. */
class Predicate {
  private readonly re: RegExp | undefined;
  private readonly matchers = new Map<string, { m: StreamMatcher; seq: Seq }>();
  private silenceTimer: NodeJS.Timeout | undefined;
  /** The silence clock has been started at least once. */
  private armed = false;
  /** When the current quiet stretch began, on the monotonic clock. */
  private quietSince = 0;
  private idleArmed = false;
  private idleCheck = false;
  private idleWaiting = false;
  private runEnded = false;
  private disposed = false;

  constructor(
    readonly kind: WatchKind,
    private readonly spec: WatchSpec,
    private readonly host: WatchHost,
    private readonly fire: (hit: Hit) => void,
    /** The Run named by `runId` ended (after any trailing line was matched). */
    private readonly onRunEnd?: (ev: Extract<JournalEvent, { type: 'run.end' }>) => void,
  ) {
    if (kind === 'pattern') this.re = compileLinePattern(spec.pattern!);
  }

  /** Start (or restart) the silence clock: fire after `ms` unless output arrives; the quiet began at `since` on the monotonic clock. */
  armSilence(ms = this.spec.silenceMs!, since = clocks.monotonic()): void {
    if (this.kind !== 'silence' || this.disposed || this.runEnded) return;
    this.armed = true;
    this.quietSince = since;
    this.schedule(ms);
  }

  /** The quiet so far, on the monotonic clock. */
  private quietMs(): number {
    return Math.max(0, Math.round(clocks.monotonic() - this.quietSince));
  }

  private schedule(ms: number): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      const quiet = this.quietMs();
      if (quiet < this.spec.silenceMs!) {
        // A timer can wake a millisecond early: the elapsed quiet time is the predicate's evidence.
        this.schedule(this.spec.silenceMs! - quiet);
        return;
      }
      this.fire({ match: `no output for ${quiet}ms`, seq: this.host.journal.lastSeq });
    }, timerMs(ms));
  }

  feed(ev: JournalEvent): void {
    if (this.disposed) return;
    switch (this.kind) {
      case 'pattern':
        if (ev.type === 'output') {
          if (this.spec.runId !== undefined && ev.runId !== this.spec.runId) return;
          const s = this.matcher(streamKey(ev));
          s.seq = ev.seq;
          for (const hit of s.m.feed(ev.data)) this.fire({ match: hit.match, line: hit.line.trim(), seq: ev.seq });
        } else if (ev.type === 'run.end') {
          if (ev.runId === this.spec.runId) {
            // The Run's streams are over: its unterminated last line is complete.
            this.flush();
            this.onRunEnd?.(ev);
          } else {
            // Another Run's pipes are over too: their last line is complete now, not after the
            // partial delay, and their matchers are not kept for the rest of the watch's life.
            this.endStreams(`stdout:${ev.runId}`, `stderr:${ev.runId}`);
          }
        } else if (ev.type === 'session.exit') {
          this.flush();
        }
        return;
      case 'silence':
        if (ev.type === 'output' && (this.spec.runId === undefined || ev.runId === this.spec.runId)) this.armSilence(this.spec.silenceMs, clocks.monotonic());
        else if (ev.type === 'run.end' && ev.runId === this.spec.runId && !this.runEnded) {
          // Output of this Run has stopped for good: fire once and stop the clock.
          if (this.silenceTimer) clearTimeout(this.silenceTimer);
          this.silenceTimer = undefined;
          this.runEnded = true;
          const quiet = this.armed ? ` no output for ${this.quietMs()}ms` : ' no output';
          this.fire({ match: `${endText(ev)};${quiet}`, seq: ev.seq });
          this.onRunEnd?.(ev);
        }
        return;
      case 'idle':
        // Only the shell's own Runs make it busy or idle (m2-11): a process Run's end says
        // nothing about the shell. Under basic/none an unknown outcome never establishes
        // availability (G4); under rich the prompt after it does.
        if (ev.type === 'run.end' && this.host.journal.runs.get(ev.runId)?.target === 'shell' && (ev.state !== 'lost' || this.host.integration === 'rich')) this.idleArmed = true;
        if (this.idleArmed) this.checkIdle();
        return;
    }
  }

  /**
   * The session updates its state after journaling the event that changed it, so availability is
   * read a moment later. While it is not available, the host is asked to say when it becomes so,
   * since that can happen on a timer that journals nothing.
   */
  private checkIdle(): void {
    if (this.idleCheck) return;
    this.idleCheck = true;
    queueMicrotask(() => {
      this.idleCheck = false;
      if (this.disposed || !this.idleArmed) return;
      if (this.host.shellAvailable().ok) {
        this.idleArmed = false;
        this.fire({ seq: this.host.journal.lastSeq, match: 'shell available' });
        return;
      }
      if (this.idleWaiting) return;
      this.idleWaiting = true;
      void this.host.waitAvailable(IDLE_RECHECK_MS).then(
        () => {
          this.idleWaiting = false;
          if (this.idleArmed) this.checkIdle();
        },
        () => {
          this.idleWaiting = false;
        },
      );
    });
  }

  /** Complete every stream's unterminated line now (its stream ended). */
  flush(): void {
    for (const s of this.matchers.values()) for (const hit of s.m.flush()) this.fire({ match: hit.match, line: hit.line.trim(), seq: s.seq });
  }

  /** Complete one stream's unterminated line now, if it has one waiting (the stream has been quiet long enough). */
  flushStream(key: string): void {
    const s = this.matchers.get(key);
    if (s) for (const hit of s.m.flush()) this.fire({ match: hit.match, line: hit.line.trim(), seq: s.seq });
  }

  /** These streams are over: complete their last lines and forget their matchers. */
  private endStreams(...keys: string[]): void {
    for (const key of keys) {
      const s = this.matchers.get(key);
      if (!s) continue;
      this.flushStream(key);
      s.m.dispose();
      this.matchers.delete(key);
    }
  }

  private matcher(key: string): { m: StreamMatcher; seq: Seq } {
    let s = this.matchers.get(key);
    if (!s) {
      const entry: { m: StreamMatcher; seq: Seq } = { m: undefined as never, seq: 0 };
      entry.m = new StreamMatcher(this.re!, {
        onPartial: (hit) => {
          if (!this.disposed) this.fire({ match: hit.match, line: hit.line.trim(), seq: entry.seq });
        },
      });
      this.matchers.set(key, (s = entry));
    }
    return s;
  }

  dispose(): void {
    this.disposed = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    for (const s of this.matchers.values()) s.m.dispose();
  }
}

interface WatchRecord extends WatchInfo {
  predicate: Predicate;
  pending?: NodeJS.Timeout | undefined;
  /** The latest hit held back by the spacing, and how many were held (m2-20). */
  held?: Hit | undefined;
  heldCount: number;
  /** The last firing on the monotonic clock, which the spacing is measured on (`lastFiredAt` is the wall clock, for the record). */
  lastFiredMono?: number | undefined;
}

/** The newest output the manager saw arrive, on the monotonic clock: by Run, and overall under `*`. */
interface Stamp {
  seq: Seq;
  at: number;
}

export class WatchManager {
  private readonly watches = new Map<string, WatchRecord>();
  private readonly off: () => void;
  private counter = 0;
  /** Waits in flight, so closing the session ends them at once (m2-24). */
  private readonly waits = new Set<(reason: string) => void>();
  private readonly stamps = new Map<string, Stamp>();

  constructor(private readonly host: WatchHost) {
    this.off = host.journal.subscribe((ev) => {
      if (ev.type === 'watch.fired') return;
      if (ev.type === 'output') {
        const stamp = { seq: ev.seq, at: clocks.monotonic() };
        this.stamps.set('*', stamp);
        if (ev.runId !== undefined) this.stamps.set(ev.runId, stamp);
      } else if (ev.type === 'run.end') this.stamps.delete(ev.runId);
      for (const w of [...this.watches.values()]) w.predicate.feed(ev);
    });
  }

  /** How long ago an output event arrived: exact when it was stamped on arrival, else the journal's wall-clock age, clamped at zero. */
  private ageOf(ev: JournalEvent): number {
    const s = this.stamps.get(ev.type === 'output' && ev.runId !== undefined ? ev.runId : '*');
    if (s?.seq === ev.seq) return Math.max(0, clocks.monotonic() - s.at);
    const any = this.stamps.get('*');
    if (any?.seq === ev.seq) return Math.max(0, clocks.monotonic() - any.at);
    return Math.max(0, Date.now() - ev.ts);
  }

  add(spec: WatchSpec, owner: Principal): WatchInfo {
    const kind = kindOf(spec);
    const run = spec.runId !== undefined && kind !== 'idle' ? this.requireRun(spec.runId) : undefined;
    if (run && isTerminal(run.state)) throw err('invalid_argument', `${endText(run)}: a watch on it would never fire; read its output with read {runId}`, { runId: run.runId });
    const watchId = `w${++this.counter}-${randomBytes(2).toString('hex')}`;
    const label = spec.label ?? (kind === 'pattern' ? spec.pattern! : kind === 'silence' ? `silence ${spec.silenceMs}ms` : 'idle');
    const rec: WatchRecord = { watchId, kind, label, owner, spec: { ...spec }, createdAt: Date.now(), fired: 0, heldCount: 0, predicate: undefined as never };
    rec.predicate = new Predicate(kind, spec, this.host, (hit) => this.onHit(rec, hit));
    this.watches.set(watchId, rec);
    if (kind === 'silence') {
      if (!run) rec.predicate.armSilence();
      else {
        // Quiet is measured from the Run's last output; a Run that has printed nothing yet arms on its first (m2-12).
        const last = this.lastRunOutput(run.runId);
        if (last) {
          const age = this.ageOf(last);
          rec.predicate.armSilence(spec.silenceMs! - age, clocks.monotonic() - age);
        }
      }
    }
    return this.publicInfo(rec);
  }

  remove(watchId: string): boolean {
    const w = this.watches.get(watchId);
    if (!w) return false;
    w.predicate.dispose();
    if (w.pending) clearTimeout(w.pending);
    this.watches.delete(watchId);
    return true;
  }

  get(watchId: string): WatchInfo | undefined {
    const w = this.watches.get(watchId);
    return w ? this.publicInfo(w) : undefined;
  }

  list(): WatchInfo[] {
    return [...this.watches.values()].map((w) => this.publicInfo(w));
  }

  private publicInfo(w: WatchRecord): WatchInfo {
    const { predicate: _p, pending: _t, held: _h, heldCount: _c, lastFiredMono: _m, ...info } = w;
    return { ...info, spec: { ...info.spec } };
  }

  /** The Run named by a spec, from the session's run index; run_not_found when this session never had it. */
  private requireRun(runId: string): RunInfo {
    const run = this.host.journal.runs.get(runId);
    if (!run) throw err('run_not_found', `run ${runId} not found in this session`, { runId });
    return run;
  }

  private lastRunOutput(runId: string): JournalEvent | undefined {
    try {
      return this.host.journal.runs.output(this.host.journal, runId, { maxBytes: 1 }).events.at(-1);
    } catch {
      return undefined;
    }
  }

  private onHit(w: WatchRecord, hit: Hit): void {
    if (!this.watches.has(w.watchId)) return;
    const now = clocks.monotonic();
    if (w.kind === 'pattern' && w.lastFiredMono !== undefined && now - w.lastFiredMono < PATTERN_SPACING_MS) {
      // Coalesce a burst: one trailing firing carries the latest match; "+N more" counts the others held (m2-20).
      w.held = hit;
      w.heldCount++;
      if (!w.pending) {
        w.pending = setTimeout(() => {
          w.pending = undefined;
          const latest = w.held;
          const others = w.heldCount - 1;
          w.held = undefined;
          w.heldCount = 0;
          if (latest) this.emit(w, latest, others);
        }, timerMs(PATTERN_SPACING_MS - (now - w.lastFiredMono)));
      }
      return;
    }
    if (w.pending) {
      // The spacing has passed with hits still held: this hit is the latest of them and goes out
      // now with their count, instead of before them (the house's read of 3eade8a, #22).
      clearTimeout(w.pending);
      w.pending = undefined;
      const others = w.heldCount;
      w.held = undefined;
      w.heldCount = 0;
      this.emit(w, hit, others);
      return;
    }
    this.emit(w, hit, 0);
  }

  private emit(w: WatchRecord, hit: Hit, more: number): void {
    if (!this.watches.has(w.watchId)) return;
    w.fired++;
    w.lastFiredAt = Date.now();
    w.lastFiredMono = clocks.monotonic();
    if (hit.match !== undefined) w.lastMatch = hit.match;
    const ev: Parameters<Journal['append']>[0] = { type: 'watch.fired', watchId: w.watchId, label: w.label, kind: w.kind, principal: w.owner, at: hit.seq };
    if (hit.match !== undefined) ev.match = hit.match;
    if (hit.line !== undefined) ev.line = hit.line;
    if (more > 0) ev.suppressed = more;
    this.host.journal.append(ev);
    if (w.spec.once) this.remove(w.watchId);
  }

  /**
   * Block up to `ms` for a predicate. With `since`, retained output after that
   * cursor is checked first, so a pattern printed before the call is not missed.
   * A wait that can no longer be satisfied — the session exited or closed, or
   * the Run it names ended — returns at once with `reason` (m2-24).
   */
  waitFor(spec: WatchSpec, ms: number, since?: Seq): Promise<WaitResult> {
    const kind = kindOf(spec);
    const run = spec.runId !== undefined && kind !== 'idle' ? this.requireRun(spec.runId) : undefined;
    const started = clocks.monotonic();
    const result = (r: Omit<WaitResult, 'elapsedMs' | 'kind'>): WaitResult => ({ ...r, kind, elapsedMs: Math.max(0, Math.round(clocks.monotonic() - started)) });
    const exited = () => (this.host.exit !== undefined ? exitText(this.host.exit) : undefined);

    if (kind === 'idle') {
      if (this.host.shellAvailable().ok) return Promise.resolve(result({ matched: true, match: 'shell available', seq: this.host.journal.lastSeq }));
      const gone = exited();
      if (gone) return Promise.resolve(result({ matched: false, reason: gone }));
      return this.host.waitAvailable(timerMs(ms)).then((ok) => {
        if (ok) return result({ matched: true, match: 'shell available', seq: this.host.journal.lastSeq });
        const why = exited();
        return result(why ? { matched: false, reason: why } : { matched: false });
      });
    }

    return new Promise((resolve) => {
      let done = false;
      let off: () => void = () => undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (r: WaitResult) => {
        if (done) return;
        done = true;
        off();
        predicate.dispose();
        this.waits.delete(abort);
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      const abort = (reason: string) => finish(result({ matched: false, reason }));
      const predicate = new Predicate(
        kind,
        spec,
        this.host,
        (hit) => {
          const r: Omit<WaitResult, 'elapsedMs' | 'kind'> = { matched: true, seq: hit.seq };
          if (hit.match !== undefined) r.match = hit.match;
          if (hit.line !== undefined) r.line = hit.line;
          finish(result(r));
        },
        (ev) => abort(endText(ev)),
      );
      this.waits.add(abort);
      if (kind === 'pattern') {
        if (since !== undefined) {
          // Page by page to the end: a read that stops at a hole left by a cold-store failure says
          // `more`, and what follows the hole is still to be checked (the house's read of 3eade8a, #22).
          const lastBy = new Map<string, JournalEvent>();
          let cursor = since;
          for (;;) {
            const page = this.host.journal.since(cursor);
            for (const ev of page.events) {
              predicate.feed(ev);
              if (done) return;
              if (ev.type === 'output') lastBy.set(streamKey(ev), ev);
            }
            if (!page.more || !page.events.length) break;
            cursor = page.nextCursor;
          }
          // A stream whose replayed last line has no newline and has been quiet for the partial
          // delay already (a prompt sitting there) is matched now, not after the delay restarts.
          for (const [key, ev] of lastBy) {
            if (this.ageOf(ev) >= PARTIAL_QUIET_MS) predicate.flushStream(key);
            if (done) return;
          }
        }
        // Nothing more can arrive for a Run that has ended, or from a shell that exited.
        const now = run ? this.host.journal.runs.get(run.runId) : undefined;
        if (now && isTerminal(now.state)) {
          predicate.flush();
          return abort(endText(now));
        }
        const gone = exited();
        if (gone) {
          predicate.flush();
          return abort(gone);
        }
      } else {
        // silence: how long has it already been quiet? Never "forever" (m2-12).
        const gone = run ? undefined : exited();
        if (gone) return abort(gone);
        const cur = run && (this.host.journal.runs.get(run.runId) ?? run);
        const last = run ? this.lastRunOutput(run.runId) : lastOutput(this.host.journal);
        if (cur && isTerminal(cur.state)) {
          const quiet = last ? this.ageOf(last) : Math.max(0, Date.now() - (cur.endedAt ?? Date.now()));
          return finish(result({ matched: true, match: `${endText(cur)}; no output for ${quiet}ms`, seq: cur.seq.end ?? this.host.journal.lastSeq }));
        }
        const age = last ? this.ageOf(last) : 0;
        if (last && age >= spec.silenceMs!) return finish(result({ matched: true, match: `no output for ${age}ms`, seq: last.seq }));
        // A Run that has printed nothing yet starts the clock at its first output (or its end answers).
        if (last || !run) predicate.armSilence(spec.silenceMs! - age, clocks.monotonic() - age);
      }
      off = this.host.journal.subscribe((ev) => {
        predicate.feed(ev);
        if (!done && ev.type === 'session.exit') abort(exitText({ exitCode: ev.code, ...(ev.signal ? { signal: ev.signal } : {}) }));
      });
      timer = setTimeout(() => finish(result({ matched: false })), timerMs(ms));
    });
  }

  dispose(): void {
    this.off();
    for (const id of [...this.watches.keys()]) this.remove(id);
    for (const abort of [...this.waits]) abort('session closed');
  }
}

/** The newest output event among the last 2000 events, if any. */
function lastOutput(journal: Journal): JournalEvent | undefined {
  const recent = journal.tail(2000);
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i]!;
    if (e.type === 'output') return e;
  }
  return undefined;
}
