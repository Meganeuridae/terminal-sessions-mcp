/**
 * Core types: the entity model and the journal event schema.
 * See docs/redesign/DESIGN.md §4 (entities), §5 (guarantees), Appendix A (journal).
 */

export type Seq = number;

/** Who acted. Resolved at the transport; `system` is the daemon itself. */
export type Principal = string; // 'agent:<name>@<domain>' | 'human:<provider>:<id>' | 'token:<name>' | 'system'
export const SYSTEM: Principal = 'system';

export type RunTarget = 'shell' | 'process';
export type RunState = 'queued' | 'starting' | 'running' | 'exited' | 'cancelled' | 'lost';
export type RunOrigin = 'self' | 'human' | 'agent' | 'system';

/** The shell terminal's state. `tui` is `busy` with the alternate screen active. */
export type ShellState = 'starting' | 'idle' | 'busy' | 'unavailable' | 'exited';

/** Shell-integration level, VS Code's vocabulary (G5). */
export type IntegrationLevel = 'unknown' | 'rich' | 'basic' | 'none';

export type Attribution = 'exact' | 'temporal';
/**
 * How a shell Run's boundaries are observed, and so what the daemon's plumbing in its output is
 * (core/plumbing.ts cuts it): `rich` — the integration's marks, nothing in the output; `basic` —
 * end marks only, the typed line's echo opens the output; `marker` — an end marker with a nonce
 * chained on the typed line (§8.1 fallback); `inline` — a declared shell's markers (§8.1).
 */
export type RunStrategy = 'rich' | 'basic' | 'marker' | 'inline';
export type OutputStream = 'pty' | 'stdout' | 'stderr';
export type EnvBasis = 'configured' | 'snapshot';

export type ControlPolicy = 'seat' | 'owner-priority';
export type Visibility = 'private' | 'shared';
export type AttachmentRole = 'observer' | 'controller';

/** Journal events without the fields the journal assigns (`seq`, `ts`). Appendix A. */
export type EventInput =
  | { type: 'output'; data: string; runId?: string; stream: OutputStream; attribution?: Attribution }
  | { type: 'input'; data: string; principal: Principal; kind: 'text' | 'keys' | 'paste' | 'protocol-reply'; sensitive?: true; runId?: string }
  /** `shell`/`within`: a Run declared for the shell in front of the terminal (§8.1): the kind of shell, and the Run whose program it is (null: what replaced the session's shell). */
  | { type: 'run.admit'; runId: string; target: RunTarget; line?: string; argv?: string[]; principal: Principal; origin: RunOrigin; queued: boolean; idem?: string; shell?: string; within?: string | null }
  | { type: 'run.start'; runId: string; cwd: string; line?: string; envBasis?: EnvBasis; cols?: number; rows?: number; pid?: number; pgid?: number; startTicks?: number; bootId?: string; strategy?: RunStrategy; nonce?: string; shellPid?: number }
  | { type: 'run.end'; runId: string; state: 'exited' | 'cancelled' | 'lost'; exit?: number; signal?: string; reason?: string; durationMs: number; leftovers?: true; pipeStatus?: number[]; recoveredEnd?: true; groupJudged?: true; lastAliveTs?: number; shellPid?: number }
  /** Recovery judged this Run's process group (ended it or left it) after the Run had already ended: the run index folds it into groupJudged, so no later restart judges it again. */
  | { type: 'run.judged'; runId: string }
  | { type: 'prompt'; cwd: string; phase: 'start' | 'end' }
  | { type: 'cwd'; path: string }
  | { type: 'env.snapshot'; count: number; vars?: Record<string, string> }
  | { type: 'screen.mode'; alt: boolean }
  | { type: 'title'; text: string }
  | { type: 'resize'; cols: number; rows: number; principal: Principal }
  | { type: 'signal'; signal: string; principal: Principal; runId?: string }
  | { type: 'control'; controller: Principal | null; by: Principal; how: 'take' | 'release' | 'override' | 'auto' }
  | { type: 'attach'; attachmentId: string; principal: Principal; role: AttachmentRole }
  | { type: 'detach'; attachmentId: string; principal: Principal }
  | { type: 'integration'; level: IntegrationLevel }
  /**
   * A range of seqs that is gone (G11, Appendix A): `retention`, `keeper-overflow`, `torn-write` (a crash cut
   * the last line, or a power loss took the lines the disk had not yet written, G10), `store-error` (the ring dropped events the disk had refused), `store-failed` (the disk still
   * refused them when the journal sealed, or the daemon died first); their seqs are never reissued (G10).
   * `exact`: every seq of the range was issued, so it counts the events lost (what the ring dropped, the life
   * before this one's unwritten events, a torn line's one, a jump a start finds in the files after a stop while the
   * disk refused). A jump is a bound when the failed mark says a hole whose count is a bound was among the
   * unrecorded (Reservation.failedBound), since it can hold a hole an earlier start opened above a reservation,
   * whose gap the ring dropped too; under an earlier build's failed mark, which says nothing of it, a jump is still
   * counted as issued. Absent, the count is a bound: a reservation the journal numbered above may have skipped seqs
   * never issued, and a gap an earlier build wrote says nothing (the house's review of the 40 commits through
   * f3750e4, PR #22, comment 6310921374, question 4, and of 4f4c067..a8b6f28, comment 6323055715, question 5).
   */
  | { type: 'gap'; from: Seq; to: Seq; reason: 'retention' | 'keeper-overflow' | 'torn-write' | 'store-error' | 'store-failed'; exact?: true }
  | { type: 'recovered'; class: 'continuous' | 'reattached' | 'history-only' }
  /** `reason` names why the daemon ended the shell (e.g. 'daemon-shutdown'); absent when the shell ended on its own. */
  | { type: 'session.exit'; code: number | null; signal?: string; reason?: string }
  | { type: 'note'; text: string; principal: Principal; channel?: string }
  /** A Service's status changed (§8.3); `principal` started it. */
  | { type: 'service'; runId: string; status: ServiceStatus; probe: string; principal: Principal; name?: string; evidence?: string; exit?: number }
  /**
   * A Watch fired (§4); `principal` set it; `at` is the event that satisfied it, for a pattern the event that completed
   * the line, or for a line a flush completed (a Run's end, the session's exit, a hole, a partial line left quiet) the
   * event its last output came in. A pattern's `cursor` and `offset` say where the line began, as search's match
   * does: read `since=cursor`, `offset`, to read it whole, its head in earlier events included.
   */
  /** `clipped`: the line was longer than the pattern's match window and matched on its head. */
  | { type: 'watch.fired'; watchId: string; label: string; kind: 'pattern' | 'silence' | 'idle'; principal: Principal; at: Seq; match?: string; line?: string; cursor?: Seq; offset?: number; clipped?: boolean; stream?: 'stdout' | 'stderr'; mixed?: boolean; suppressed?: number }
  /**
   * A running Run may be waiting for input (G15: a heuristic, journaled with its evidence) —
   * the last line, how long output has been silent, the session state — so catch-up and
   * presence see it after the moment passed (m2-18). Journaled by the segmenter.
   */
  | { type: 'run.waiting'; runId: string; lastLine: string; silentMs: number; state: string };

/**
 * A Service's status (§8.3). `ready` only from a readiness probe (G9); `running`
 * when no readiness probe was given and the Run stayed alive through the liveness
 * window; `lost` when the Run's end was not observed (its process may still be
 * alive, G3), as opposed to `exited`, an observed end.
 */
export type ServiceStatus = 'starting' | 'ready' | 'running' | 'unhealthy' | 'exited' | 'lost';

export type JournalEvent = EventInput & { seq: Seq; ts: number };
export type EventType = JournalEvent['type'];
export type EventOf<T extends EventType> = Extract<JournalEvent, { type: T }>;
/** Why a range of the journal is gone: the `gap` event's reasons, the one list every report of a hole draws on. */
export type GapReason = EventOf<'gap'>['reason'];
/** A hole as a read reports it: the `gap` event's range, reason and count. */
export type Hole = Pick<EventOf<'gap'>, 'from' | 'to' | 'reason' | 'exact'>;

/** The terminal size a session, a transcript or a history read gets when nothing recorded one. */
export const DEFAULT_GEOMETRY = { cols: 120, rows: 30 } as const;

/** A Run as exposed by the core (G1–G3). */
export interface RunInfo {
  runId: string;
  sessionId: string;
  target: RunTarget;
  origin: RunOrigin;
  principal: Principal;
  state: RunState;
  line?: string;
  argv?: string[];
  cwd?: string;
  envBasis?: EnvBasis;
  admittedAt: number;
  startedAt?: number;
  endedAt?: number;
  /**
   * An ended Run's duration, from its run.end: the session measured it on the monotonic clock, so
   * it is the one duration every reader reports, never `endedAt - startedAt`, which a wall-clock step
   * makes negative (a reviewer's read of the fixes for #22). A Run in flight has none: its elapsed
   * time so far is Session.runDurationMs. An end a recovery wrote (`recoveredEnd`) is the one exception:
   * no monotonic reference survives the daemon that measured the Run, so its duration is the wall clock's
   * estimate from the Run's journaled start, which a clock step can skew (the house's review of
   * 4f4c067..a8b6f28, PR #22).
   */
  durationMs?: number;
  exit?: number;
  signal?: string;
  reason?: string;
  /** Journal positions: admission, start (pre-execution mark or spawn), end. */
  seq: { admit: Seq; start?: Seq; end?: Seq };
  attribution: Attribution;
  /** The terminal geometry the Run started at: its transcript is projected at this width (§6). */
  cols?: number;
  rows?: number;
  /** The admitting call's idempotency identity (G16): opaque, set by the application layer, journaled so it survives a restart. */
  idem?: string;
  /**
   * How the Run's boundaries were observed, from its run.start: history cuts the plumbing the
   * output holds exactly as the live transcript does. Absent for a Run journaled before this was
   * recorded: its history is cut by shape (the house's read of 39787b3, #22).
   */
  strategy?: RunStrategy;
  /** The nonce in a `marker` or `inline` Run's marks, from its run.start (a live `inline` Run's from its launch): what its plumbing is cut by. For the readers of history: an events read returns the run.start as journaled, nonce included; the App's rendered results (run, await, a text read) never carry it. */
  nonce?: string;
  /**
   * An `inline` Run's shell, the one that printed its start marker, or a `marker` Run's, the session's shell
   * or the one its start mark named, from its run.start, or its run.end when the start mark bound another:
   * only that shell's probe answer ends the Run, so history judges answers by it as the live transcript does.
   * A recovery-written end cannot know the bound pid, and run.start's stands. The App's rendered results never
   * carry it.
   * The marker's chunk is journaled before the Run starts, outside its output, so history cannot
   * read the pid from the text (the house's read of the 38 commits, #22, comment 6274773484).
   */
  shellPid?: number;
  /** A declared shell Run (§8.1): the caller's name for the shell in front (`bash`, `sh`, `fish`…). */
  shell?: string;
  /** With `shell`: the Run whose program is that shell (`ssh host`, `sudo -i`…), or null for the program that replaced the session's shell. */
  within?: string | null;
  /** A process Run's pid and process group, from its run.start: recovery terminates a group a dead daemon left behind (G19c). */
  pid?: number;
  pgid?: number;
  /**
   * The leader's start time in clock ticks after boot, and the boot id, from its run.start on Linux:
   * recovery compares these frame-free, since a wall-clock step moves ps/proc start times under it
   * (the house's read of the 36 commits, #22, comment 6269992150). Absent on macOS, and on a build
   * that did not record them: recovery falls back to the wall clock there.
   */
  startTicks?: number;
  bootId?: string;
  /** This Run's end was written by recovery (a lost end): its time is the recovery's, not evidence of when the Run's group could form. */
  recoveredEnd?: true;
  /** Recovery has judged this Run's process group (ended it or left it): a later restart does not judge it again. */
  groupJudged?: true;
  /**
   * For a recovery-written end: the last journal time the daemon that ran the Run was known alive (its
   * last event before it died). The Run's group could not have formed after it, so a later recovery
   * bounds the group by this, never by the recovery's own time (comment 6269992150, item 2).
   */
  lastAliveTs?: number;
  /**
   * A process Run whose process group still had members when its own process exited (a child it
   * left in the background): they run on, their output is journaled without the Run's id, and
   * `cancel` on the Run or closing the session ends them (the house's review of #11, shell tools 5).
   */
  leftovers?: boolean;
  /**
   * A shell Run's pipeline, one status per command, when the line was a pipeline and the shell
   * gave them (bash, zsh, fish); `exit` is the last one unless pipefail is on. Absent for a single
   * command and under the marker strategy (the house's review of #11, shell tools 3).
   */
  pipeStatus?: number[];
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  alt: boolean;
  cursor: { x: number; y: number };
  lines: string[];
  title: string;
  /** The journal position the snapshot reflects: every event ≤ seq has been applied. */
  seq: Seq;
  /** Output units the emulator dropped under pressure since the session started (§6); absent when none. */
  droppedUnits?: number;
}

export interface Cursors {
  delivered: Seq;
  read: Seq;
}
