/**
 * Watches (§4): standing predicates over a session's journal that emit a
 * `watch.fired` event when they fire — a pattern in the output, output going
 * quiet, or the shell becoming available. `waitFor` is the synchronous form:
 * block up to a deadline for the same predicates, without leaving a watch behind.
 *
 * Patterns match whole lines, as `search` does (see StreamMatcher): each line of
 * each source is tested once, `^` and `$` are the line's ends, and a line with no
 * newline yet (a prompt) is tested once its source has been quiet for a moment.
 * The sources are the transcript's (§6 rule 6): the pty, and each process Run's
 * stdout and stderr together, so `abc` on stdout then `def` and a LF on stderr is
 * the line `abcdef`, as the transcript and the digests show it; a hit on a Run's
 * line names the pipe its first character came from (`stream`), and says `mixed`
 * when the line holds output from both (the house's review of f3750e4..4f4c067,
 * #22, comment 6315636412, question 4).
 * A line is read as it displays (`cleanLine`: backspaces, erases and in-line
 * cursor moves applied), with one difference from search: a lone carriage return
 * ends a *frame* here, tested as a line of its own, so a progress bar matches as
 * it moves, where search reads only the line's last state. A line is matched on
 * its head: within the pattern's match window, and within the first 64 KiB of a
 * longer line (the rest is dropped); such a hit says `clipped` (the house's read
 * of 78c4d6e, #22: a longer line was matched in pieces, so `^` matched mid-line).
 * Every pattern compiles on the linear-time engine, and a bad one is refused
 * with invalid_argument when the watch or wait is created.
 *
 * Quiet is measured on the monotonic clock. The newest output of each stream of each Run, and
 * of the session outside Runs, is stamped as it arrives and kept while the Run lives, then for
 * the newest 1,024 ended Runs. Every age a wait takes is of such an output (a Run's last output,
 * the session's last output, a stream's partial line), so a silence measured from earlier output
 * is as exact as one measured from arming, however much other Runs print meanwhile; only output
 * from before the manager existed, or the last output of an older ended Run, takes its age from
 * the journal's wall-clock time, clamped at zero (the house's read of 3eade8a, #22: a forward
 * step of 10 s certified 5 s of silence in 1 ms; of the 38 commits after 78c4d6e: a Run's other
 * stream and an ended Run's last output were aged on the wall clock; and of the 33 commits after
 * 94ac8c0, comment 6307351806: a stamp for every event, the newest 8,192 kept, let a quiet live
 * Run's stamp go once other Runs printed 8,192 events, and cost about 1.6 µs per event).
 *
 * A silence watch or wait on a live Run measures from the Run's last output, and one on a Run that
 * has printed nothing arms on its first (m2-12). A live Run with no stamp, whose output the journal
 * cannot give either (retention or a hole cut its read, or the read failed), was admitted before this
 * manager began: anything it printed since would carry a stamp, so it has been quiet at least since
 * the manager began, and the watch or wait arms from there. It armed only on the Run's next output,
 * so a Run that printed before a restart and was quiet since was never reported quiet (the house's
 * review of a8b6f28..4860d4c, #22, comment 6341260318, question 3). One whose newest retained output
 * has a hole after it, which may have held later output, is measured from the manager's start too:
 * aged from that output, its silence fired early (the house's read of 4860d4c..bc4bc85, #22). The
 * cost, accepted: such a Run that never printed fires as quiet since the manager began when
 * retention or a hole took other events from its range, or its read failed; and one whose newest
 * retained output has a hole after it is said to be quiet since the manager began, which may be less
 * than it has been. A Run admitted under this manager with no stamp printed nothing, and arms on its
 * first output.
 */
import { randomBytes } from 'node:crypto';
import { compileLinePattern, PARTIAL_QUIET_MS, StreamMatcher, type LineMatch } from './ansi.js';
import { clocks, MAX_TIMER_MS, timerMs } from './clock.js';
import { err } from './errors.js';
import type { Journal } from './journal.js';
import type { EventOf, IntegrationLevel, JournalEvent, OutputStream, Principal, RunInfo, Seq } from './types.js';

export type WatchKind = 'pattern' | 'silence' | 'idle';

export interface WatchSpec {
  /** Regex over output lines as they display (control sequences gone, overwrites applied; see the module comment). */
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
  /** The line was longer than the pattern's match window and matched on its head only (the house's read of the 36 commits, #22). */
  clipped?: boolean;
  /** A process Run's line: the pipe its first character came from. */
  stream?: 'stdout' | 'stderr';
  /** The line holds output from both of the Run's pipes. */
  mixed?: boolean;
  /**
   * Journal position of the event that satisfied the wait: for a pattern, the event that completed the line, or for a
   * line a flush completed (a Run's end, the session's exit, a hole, a partial line left quiet) the event its last
   * output came in. For silence: the last output the quiet is measured from when it had lasted long enough already,
   * the journal's last event when the quiet ran its length during the wait, and the Run's end for an ended Run. A live
   * Run's quiet counted from the watch manager's start that had lasted long enough already names no output, and has
   * none: the journal's last event was another source's. One that runs its length during the wait names the journal's
   * last event, as any silence that ends during a wait does.
   */
  seq?: Seq;
  /**
   * A pattern's line: where it began, as search's match names its line, so `read since=<cursor> offset=<offset>`
   * reads from the line's start, though earlier events than `seq` hold its head (the house's review of
   * 4f4c067..a8b6f28, #22, comment 6323055715, question 2).
   */
  cursor?: Seq;
  /** UTF-8 bytes into the first output event after `cursor` where the line begins; absent when 0. */
  offset?: number;
  elapsedMs: number;
  /** Why the wait ended early without a match: the session exited or closed, or the Run it names ended. */
  reason?: string;
}

export interface WatchHost {
  /** The session's name, which a read this manager advises names. */
  readonly id: string;
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

/** Which matcher an output event belongs to: the transcript's source (§6 rule 6), the PTY or a process Run's two pipes together. */
const sourceKey = (ev: EventOf<'output'>) => (ev.stream === 'pty' ? 'pty' : `p:${ev.runId ?? ''}`);

/**
 * A matcher's hit as the predicate fires it; `clipped`, `stream` and `mixed` travel only when set (the house's read of
 * ed4ecac, #22: the flag was produced and dropped).
 */
const hitOf = (hit: LineMatch, seq: Seq): Hit => {
  const h: Hit = { match: hit.match, line: hit.line.trim(), seq };
  if (hit.clipped) h.clipped = true;
  if (hit.from === 'stdout' || hit.from === 'stderr') h.stream = hit.from;
  if (hit.mixed) h.mixed = true;
  if (hit.begun) {
    h.cursor = hit.begun.at - 1;
    if (hit.begun.offset > 0) h.offset = hit.begun.offset;
  }
  return h;
};

const isTerminal = (s: RunInfo['state']) => s === 'exited' || s === 'cancelled' || s === 'lost';

const exitText = (x: { exitCode: number | null; signal?: string }) => `session exited (${x.signal ? `signal ${x.signal}` : `code ${x.exitCode ?? '?'}`})`;

const endText = (r: { runId: string; state: string; exit?: number; signal?: string }) =>
  `run ${r.runId} ended (${r.state}${r.signal ? ` ${r.signal}` : r.exit !== undefined ? ` ${r.exit}` : ''})`;

/**
 * What a predicate fires with: the match and its line, where in the journal (`seq` the event that completed the line,
 * or for a line a flush completed the event its last output came in; `cursor` and `offset` where it began, as
 * search's match names it), whether the line was matched on its head only (longer than the pattern's match window),
 * and for a process Run's line its first character's pipe and whether it holds both.
 */
type Hit = { match?: string; line?: string; seq: Seq; cursor?: Seq; offset?: number; clipped?: boolean; stream?: 'stdout' | 'stderr'; mixed?: boolean };

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
    private readonly onRunEnd?: (ev: EventOf<'run.end'>) => void,
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
          const s = this.matcher(sourceKey(ev));
          s.seq = ev.seq;
          for (const hit of s.m.feed(ev.data, ev.stream, ev.seq)) this.fire(hitOf(hit, ev.seq));
        } else if (ev.type === 'run.end') {
          if (ev.runId === this.spec.runId) {
            // The Run's streams are over: its unterminated last line is complete.
            this.flush();
            this.onRunEnd?.(ev);
          } else {
            // Another Run's pipes are over too: their last line is complete now, not after the
            // partial delay, and their matchers are not kept for the rest of the watch's life.
            this.endStreams(`p:${ev.runId}`);
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
        // An exited shell is never available again: the watch stands down (a wait on the host
        // answered at once, and a recheck on each answer spun the event loop).
        if (ev.type === 'session.exit') {
          this.idleArmed = false;
          return;
        }
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
      if (this.host.exit !== undefined) {
        this.idleArmed = false;
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

  /**
   * A hole in the output read: every source's unterminated line is complete, and each starts afresh. A source
   * is what `sourceKey` keys a matcher by, the PTY or a process Run's two pipes together, so its line may hold
   * both pipes' output (the house's read of f3750e4..4f4c067 over our fixes, #22).
   */
  restartLines(): void {
    this.flush();
    for (const s of this.matchers.values()) s.m.dispose();
    this.matchers.clear();
  }

  /** Complete every source's unterminated line now (its output ended). */
  flush(): void {
    for (const s of this.matchers.values()) for (const hit of s.m.flush()) this.fire(hitOf(hit, s.seq));
  }

  /** Complete one source's unterminated line now, if it has one waiting (the source has been quiet long enough). */
  flushStream(key: string): void {
    const s = this.matchers.get(key);
    if (s) for (const hit of s.m.flush()) this.fire(hitOf(hit, s.seq));
  }

  /** These sources are over: complete their last lines and forget their matchers. */
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
          if (!this.disposed) this.fire(hitOf(hit, entry.seq));
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

/** When a stream's newest output arrived, on the monotonic clock. */
interface Stamp {
  seq: Seq;
  at: number;
}
/** The newest output of each stream of one Run, or of the session outside Runs. */
type Newest = Partial<Record<OutputStream, Stamp>>;
/**
 * One Run's newest output and its age, or what can be said where there is none (WatchManager.newestRunOutput):
 * `unread` when the journal's read of it was cut, by a hole after its newest retained output too, or failed, so it may
 * have printed what the read cannot give.
 */
type RunNewest = { seq?: Seq; age?: number; none?: string; unread?: true };

/**
 * How many ended Runs keep their last output's stamp, for a silence wait answering for one: the newest
 * 1,024, about the 1,000 a session keeps in memory (MAX_ENDED_RUNS; it keeps more while a process Run's
 * group lives on, or someone waits on a Run). An older one's last output is aged on the wall clock (clock.ts).
 */
const ENDED_STAMPED = 1024;

export class WatchManager {
  private readonly watches = new Map<string, WatchRecord>();
  private readonly off: () => void;
  private counter = 0;
  /** Waits in flight, so closing the session ends them at once (m2-24). */
  private readonly waits = new Set<(reason: string) => void>();
  /** Each live Run's newest output by stream, the session's outside Runs under '': held until the Run's end, however much other Runs print. */
  private readonly live = new Map<string, Newest>();
  /** The same for the newest ENDED_STAMPED ended Runs, moved here at each Run's end. */
  private readonly ended = new Map<string, Newest>();
  /** When this manager began, on the monotonic clock, and the journal's last seq then: every output after it is stamped. */
  private readonly began: { at: number; seq: Seq };

  constructor(private readonly host: WatchHost) {
    this.began = { at: clocks.monotonic(), seq: host.journal.lastSeq };
    this.off = host.journal.subscribe((ev) => {
      if (ev.type === 'watch.fired') return;
      if (ev.type === 'output') this.stamp(ev);
      else if (ev.type === 'run.end') this.retire(ev.runId);
      for (const w of [...this.watches.values()]) w.predicate.feed(ev);
    });
  }

  /**
   * One clock read and one lookup per output event, the stream's stamp updated in place: each stream
   * of each Run is stamped, not only a Run's newest output, since a process Run's other stream is aged
   * too, by a wait replaying a quiet partial line (the house's read of the 38 commits, #22).
   */
  private stamp(ev: EventOf<'output'>): void {
    const key = ev.runId ?? '';
    let newest = this.live.get(key) ?? this.ended.get(key);
    if (!newest) this.live.set(key, (newest = {}));
    const at = clocks.monotonic();
    const s = newest[ev.stream];
    if (s) {
      s.seq = ev.seq;
      s.at = at;
    } else newest[ev.stream] = { seq: ev.seq, at };
  }

  /** A Run's end moves its stamps among the ended Runs', where a silence wait answering for it finds its last output's. */
  private retire(runId: string): void {
    const newest = this.live.get(runId);
    if (!newest) return;
    this.live.delete(runId);
    this.ended.set(runId, newest);
    if (this.ended.size > ENDED_STAMPED) this.ended.delete(this.ended.keys().next().value!);
  }

  /**
   * How long ago an output event arrived: exact when it is its stream's newest, as every output a wait
   * ages is, else (from before the manager existed, or an older ended Run's) the journal's wall-clock
   * age, clamped at zero.
   */
  private ageOf(ev: JournalEvent): number {
    if (ev.type === 'output') {
      const key = ev.runId ?? '';
      const s = (this.live.get(key) ?? this.ended.get(key))?.[ev.stream];
      if (s?.seq === ev.seq) return Math.max(0, Math.round(clocks.monotonic() - s.at));
    }
    return Math.max(0, Date.now() - ev.ts);
  }

  /** `keep`: a watch moving to a new life of its session keeps its id and creation time, so the id its caller holds stays valid (the house's read of 1cabc6a, #22). */
  add(spec: WatchSpec, owner: Principal, keep?: { watchId: string; createdAt: number }): WatchInfo {
    const kind = kindOf(spec);
    const run = spec.runId !== undefined && kind !== 'idle' ? this.requireRun(spec.runId) : undefined;
    if (run && isTerminal(run.state)) throw err('invalid_argument', `${endText(run)}: a watch on it would never fire; read its output with read {"session": ${JSON.stringify(this.host.id)}, "runId": ${JSON.stringify(run.runId)}}`, { runId: run.runId });
    if (keep) this.counter = Math.max(this.counter, Number(/^w(\d+)-/.exec(keep.watchId)?.[1] ?? 0));
    const watchId = keep?.watchId ?? `w${++this.counter}-${randomBytes(2).toString('hex')}`;
    const label = spec.label ?? (kind === 'pattern' ? spec.pattern! : kind === 'silence' ? `silence ${spec.silenceMs}ms` : 'idle');
    const rec: WatchRecord = { watchId, kind, label, owner, spec: { ...spec }, createdAt: keep?.createdAt ?? Date.now(), fired: 0, heldCount: 0, predicate: undefined as never };
    rec.predicate = new Predicate(kind, spec, this.host, (hit) => this.onHit(rec, hit));
    this.watches.set(watchId, rec);
    if (kind === 'silence') {
      if (!run) rec.predicate.armSilence();
      else {
        // Quiet is measured from the Run's last output; a Run that has printed nothing yet arms on its first (m2-12).
        const age = this.quietOf(run, this.newestRunOutput(run.runId)).age;
        if (age !== undefined) rec.predicate.armSilence(spec.silenceMs! - age, clocks.monotonic() - age);
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

  /**
   * A Run's newest output, or, where there is none to age, what can be said of it: `no output` only when the
   * Run's whole range was read, `no output retained` when retention or a hole took part of it, and that the
   * read failed when it did. Read as `no output`, a Run whose output had aged out, or could not be read, was
   * said to have printed nothing (the house's read of the 40 commits over our fixes, #22). Its newest output comes
   * marked `unread` when a hole follows it in the Run's range (the house's read of 4860d4c..bc4bc85, #22).
   */
  private lastRunOutput(runId: string): { last?: JournalEvent; none?: string; unread?: true } {
    try {
      const out = this.host.journal.runs.output(this.host.journal, runId, { maxBytes: 1 });
      const last = out.events.at(-1);
      // A hole after the newest retained output may have held later output: the read can't say how long the Run
      // has been quiet, only that it printed then (the house's read of 4860d4c..bc4bc85, #22).
      if (last) return out.gaps?.some((g) => g.to > last.seq) ? { last, unread: true } : { last };
      return out.truncated ? { none: 'no output retained', unread: true } : { none: 'no output' };
    } catch {
      return { none: 'its output could not be read', unread: true };
    }
  }

  /**
   * How long ago a Run last printed, with that output's seq: from this manager's own stamp of its newest
   * output when it has one, which retention or a hole cannot take, else from the journal's last retained
   * output (from before the manager existed, or an ended Run past the newest ENDED_STAMPED). Read from the
   * journal first, a live Run whose newest output was gone never armed its silence, and an older event was
   * aged on the wall clock, its stream's stamp being the newer one's (the house's read of f3750e4..4f4c067
   * over our fixes, #22).
   */
  private newestRunOutput(runId: string): RunNewest {
    let stamp: Stamp | undefined;
    for (const s of Object.values(this.live.get(runId) ?? this.ended.get(runId) ?? {})) if (s && (!stamp || s.seq > stamp.seq)) stamp = s;
    if (stamp) return { seq: stamp.seq, age: Math.max(0, Math.round(clocks.monotonic() - stamp.at)) };
    const read = this.lastRunOutput(runId);
    return read.last ? { seq: read.last.seq, age: this.ageOf(read.last), ...(read.unread ? { unread: true as const } : {}) } : read;
  }

  /**
   * How long a live Run has been quiet, for a silence watch or wait to arm with: its newest output's age; or, with no
   * stamp and no output the journal can give, or a hole after the newest it gives, admitted before this manager began,
   * the time since the manager began (see the module comment); or none, when it has printed nothing: it arms on its
   * first output (m2-12).
   */
  private quietOf(run: RunInfo, newest: RunNewest): { seq?: Seq; age?: number } {
    if (!newest.unread || run.seq.admit > this.began.seq) return newest;
    return { age: Math.max(0, Math.round(clocks.monotonic() - this.began.at)) };
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
    if (hit.cursor !== undefined) ev.cursor = hit.cursor;
    if (hit.offset !== undefined) ev.offset = hit.offset;
    if (hit.clipped) ev.clipped = true;
    if (hit.stream !== undefined) ev.stream = hit.stream;
    if (hit.mixed) ev.mixed = true;
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
          if (hit.cursor !== undefined) r.cursor = hit.cursor;
          if (hit.offset !== undefined) r.offset = hit.offset;
          if (hit.clipped) r.clipped = true;
          if (hit.stream !== undefined) r.stream = hit.stream;
          if (hit.mixed) r.mixed = true;
          finish(result(r));
        },
        (ev) => abort(endText(ev)),
      );
      this.waits.add(abort);
      if (kind === 'pattern') {
        if (since !== undefined) {
          // Output already printed after `since` counts, read to the end. Across a hole in what was
          // retained (seqs missing between two events, whatever made it: retention, a store failure, a
          // torn write) the lines start afresh, as search's do (`lineEnds`): a line, or a string, open
          // before the hole took what followed it (the house's review of the 40 commits through f3750e4,
          // #22, comment 6310921374). The live feed below needs none: it saw every event a gap names.
          // A stretch still lost reads as a gap seated in its own hole, at its last seq, so a stretch of one
          // seq makes no jump: the gap itself starts the lines afresh. A gap recorded later sits after its
          // hole, which showed as a jump where it lay, and splits nothing (the house's read of the 40
          // commits over our fixes, #22). A page also lists every hole that meets its seqs (`gaps`), each
          // seated at the hole's last seq it covers wherever its gap was recorded: the lines start afresh
          // past each, so a hole whose gap lies elsewhere, or that runs past the page's last event, joins
          // nothing across it either (the house's review of f3750e4..4f4c067, #22, comment 6315636412).
          const lastBy = new Map<string, JournalEvent>();
          let prev = since;
          for (const page of this.host.journal.pages(since)) {
            const holes = (page.gaps ?? []).map((g) => g.seq).sort((a, b) => a - b);
            let h = 0;
            for (const ev of page.events) {
              let hole = ev.seq > prev + 1 || (ev.type === 'gap' && ev.seq <= ev.to);
              for (; h < holes.length && holes[h]! < ev.seq; h++) hole = true;
              if (hole) predicate.restartLines();
              prev = ev.seq;
              if (done) return;
              predicate.feed(ev);
              if (done) return;
              if (ev.type === 'output') lastBy.set(sourceKey(ev), ev);
            }
            if (h < holes.length) predicate.restartLines();
            if (done) return;
          }
          // A source whose replayed last line has no newline and has been quiet for the partial
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
        const sessionLast = run ? undefined : lastOutput(this.host.journal);
        const newest: RunNewest = run ? this.newestRunOutput(run.runId) : sessionLast ? { seq: sessionLast.seq, age: this.ageOf(sessionLast) } : {};
        if (cur && isTerminal(cur.state)) {
          // A Run that printed nothing has no output to age, and says so as a watch on it does: its quiet was
          // taken from the journal's wall-clock end, so a clock step put any figure there (the house's read
          // of the 40 commits, #22). One whose output is gone, or could not be read, says that instead.
          const quiet = newest.age !== undefined ? ` no output for ${newest.age}ms` : ` ${newest.none ?? 'no output'}`;
          return finish(result({ matched: true, match: `${endText(cur)};${quiet}`, seq: cur.seq.end ?? this.host.journal.lastSeq }));
        }
        // The session's quiet is from its last output, or from now; a live Run's is quietOf's.
        const quiet = run ? this.quietOf(run, newest) : { ...newest, age: newest.age ?? 0 };
        const age = quiet.age;
        if (age !== undefined && age >= spec.silenceMs!) return finish(result({ matched: true, match: `no output for ${age}ms`, ...(quiet.seq !== undefined ? { seq: quiet.seq } : {}) }));
        // A Run that has printed nothing yet starts the clock at its first output (or its end answers).
        if (age !== undefined) predicate.armSilence(spec.silenceMs! - age, clocks.monotonic() - age);
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
