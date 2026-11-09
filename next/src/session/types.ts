/**
 * The session machinery's contract with the host (daemon, tools, pushes): one live shell in a
 * terminal of its own, what is in front of it, and its transcript. A Session knows nothing of
 * connections, scopes, rendering or deadlines' defaults; the host keeps those.
 *
 * Times are milliseconds since the epoch. Line numbers count the session's transcript from 0, and a
 * line given never changes, but for one case: the cursor's line and the screen's lines below it when a
 * full-screen program starts stay live while it runs, and move to follow its last frame.
 * The bound on what is kept drops the oldest lines, and every read says how many it dropped.
 */

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'none';

export interface OpenOptions {
  /** For messages only: the host keys sessions. */
  name: string;
  /** The user's login shell, absolute. Its basename picks the integration; any other shell opens with none. */
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  /** The shell's environment. The integration adds its own variables, history isolation's among them. */
  env: Record<string, string>;
  /** A private directory (0700) to hold the session's own directory, which `close` removes. */
  parent: string;
  /** A command id never given before in this daemon's life, so a reopened name never reuses one. */
  nextCommandId: () => number;
  /** How long opening waits for the first prompt. */
  waitMs: number;
  /** Linux: the shell's oom_score_adj; 0 leaves it alone. */
  oomScoreAdj?: number;
}

/**
 * Starts the shell. Resolves at its first prompt, or when `waitMs` passes first (its `front()` then
 * says what holds it: a startup file waiting on `read`, say). Rejects with a TermError when the shell
 * cannot start: `invalid_argument` for a cwd that isn't a directory, `backend_failure` otherwise.
 */
export type OpenSession = (opts: OpenOptions) => Promise<Session>;

export interface Exit {
  code: number | null;
  signal?: string;
}

/** What `close` resolves with: the shell's exit, as the session saw it. */
export type Closed = Exit & {
  /** With `force`: the shell's descendants couldn't be listed, so only the shell was KILLed. */
  unlisted?: true;
  /** The shell's exit wasn't seen within a grace after its KILL, as for a process in uninterruptible sleep. */
  unconfirmed?: true;
  /** With `force`: the groups whose KILL wasn't delivered, each with the error's code, such as `EPERM`; their processes may live on. */
  unkilled?: Array<{ pgid: number; error: string }>;
};

/** A process group in front of the terminal. */
export interface Process {
  pgid: number;
  /** Its leader's command line as the kernel has it now. */
  argv: string;
  /** The shell itself runs it: a loop, a builtin, a function, or its startup files. false for a job, and for a program exec'd in the shell's place. */
  shell: boolean;
}

export type Front =
  | {
      state: 'prompt';
      since: number;
      /** Text sent at this prompt and not yet submitted, as far as the session knows: `run` refuses while it's there. */
      pending?: string;
    }
  | {
      state: 'running';
      since: number;
      process: Process;
      /** The command that put it there, when a start mark named one. */
      command?: number;
      /** false when the kernel won't show whether it reads the terminal (no ptrace access, or not Linux), so `waiting` can't be seen. */
      waitVisible: boolean;
      /** The shell hasn't drawn its first prompt yet: it is still running its startup files. */
      starting?: true;
    }
  | {
      /** Blocked reading this terminal, on the kernel's evidence. Programs that wait in poll (a REPL, ssh) show as `running`. */
      state: 'waiting';
      since: number;
      process: Process;
      command?: number;
      /** false: the terminal doesn't echo, as for a password. Absent when its modes couldn't be read. */
      echo?: boolean;
      /** The shell hasn't drawn its first prompt yet: a startup file is reading. */
      starting?: true;
    }
  | { state: 'exited'; since: number; exit: Exit };

export interface Ending {
  at: number;
  /** How long it ran, in ms, on the monotonic clock: a wall-clock step doesn't change it. */
  ms: number;
  /** Absent when no accepted end mark closed it: a shell without integration, a removed hook, or the shell exiting. */
  status?: number;
  /** Each part's status, given only for a pipeline of more than one part. */
  pipeline?: number[];
  /** The directory afterwards. */
  cwd?: string;
  /** `set -e` is on in the shell now. */
  errexit: boolean;
  /** Text typed ahead and still unread when the prompt came back, which the session discarded. */
  flushed?: string;
  /** How many marks shaped like the session's own, nonce and all, its output carried and were refused. Other programs' OSC 133 marks, such as fish 4's own, aren't counted. */
  refusedMarks: number;
}

export interface Command {
  id: number;
  /** The line as `run` gave it; for a line typed with `send`, only where the shell reports it (zsh, fish). */
  text?: string;
  /** Its output's first line. */
  from: number;
  /** One past its output's last line, once it ended. */
  to?: number;
  startedAt: number;
  end?: Ending;
}

export interface Lines {
  from: number;
  /** One past the last line given. */
  to: number;
  lines: string[];
  /** Lines before `from` that were asked for and are no longer kept. */
  dropped: number;
  /** How many of the last lines are still on the live screen and may yet change. */
  live: number;
}

export interface Screen {
  rows: string[];
  cursor: { row: number; col: number };
  alt: boolean;
  title: string;
}

export interface Match {
  /** The transcript's line; on the alternate screen, the line the screen stands at. */
  line: number;
  text: string;
  /** The line is longer than the pattern's match window, so only its head was matched. */
  clipped?: true;
  /** Matched on the alternate screen, at this row. */
  row?: number;
}

/** The events a call took, each emitted `taken` because this call was to give it: handed back untaken by a host that doesn't deliver the call's result, so it becomes a report and a wake. */
export type Took = Array<Extract<SessionEvent, { kind: 'ended' | 'waiting' | 'exited' }>>;

export type RunOutcome =
  /** Not at a prompt, text pending at it, or the shell exited: `front` says which. Nothing was typed. */
  | { kind: 'refused'; front: Front; took: Took }
  | { kind: 'ended'; command: Command; front: Front; took: Took }
  | { kind: 'running'; command: Command; front: Front; took: Took };

export interface SendOutcome {
  /** false when nothing was sent: the shell had exited (`by: 'exited'`), a prompt whose end mark came wasn't drawn within the wait (`by: 'timeout'`), the call's signal aborted it (`by: 'cancelled'`), or `close` began while it waited (`by: 'closed'`). */
  sent: boolean;
  /** From the line the cursor was on when the text went in. */
  lines: Lines;
  /** While the alternate screen is active. */
  screen?: Screen;
  front: Front;
  /** Commands that ended during the call. */
  ended: Command[];
  matched?: Match;
  /** Why it returned: `until` matched, output went quiet, the shell exited, the wait ran out, or the call's signal aborted it. */
  by: 'match' | 'quiet' | 'exited' | 'timeout' | 'cancelled' | 'closed';
  /** With `until`, lines longer than the pattern's match window that were searched on their head only. */
  clipped?: number;
  /** With `until` and no match, the lines and alternate-screen rows the search hadn't reached when the call returned. */
  unsearched?: number;
  /** With `unsearched`, the first line the search hadn't reached; the lines from it on, then any alternate-screen rows, are the ones counted. */
  unsearchedFrom?: number;
  took: Took;
}

export type Until = { kind: 'end' } | { kind: 'input' } | { kind: 'match'; pattern: RegExp };

export interface WaitOutcome {
  /** `end`: the front is at a prompt, at once when it already was; `input`: the front is `waiting`, which ends a wait for `end` too, since a command waiting for input won't end until it's answered. */
  by: 'end' | 'input' | 'match' | 'exited' | 'timeout' | 'cancelled' | 'closed';
  front: Front;
  ended: Command[];
  matched?: Match;
  /** For a match, lines longer than the pattern's match window that were searched on their head only. */
  clipped?: number;
  /** For a match that wasn't found, the lines and alternate-screen rows the search hadn't reached when the call returned. */
  unsearched?: number;
  /** With `unsearched`, the first line the search hadn't reached; the lines from it on, then any alternate-screen rows, are the ones counted. */
  unsearchedFrom?: number;
  took: Took;
}

export interface StopStep {
  /** `C-c` is typed to the terminal; a signal goes to the foreground job's group, never the shell's. */
  sent: 'C-c' | NodeJS.Signals;
  to?: Process;
  /** The signal wasn't delivered: the error's code, such as `EPERM`. `stop` goes no further. */
  refused?: string;
  /** The signal wasn't sent: the shell's descendants couldn't be listed, so the job's group couldn't be confirmed as still the shell's. `stop` goes no further. */
  withheld?: true;
  /** The front once the step settled or its grace ran out. */
  front: Front;
}

export interface StopOutcome {
  steps: StopStep[];
  front: Front;
  /** The shell itself runs what's in front, a program exec'd in the shell's place does, or a job outlived KILL: only `close` ends it. */
  next?: 'close';
  /** `abort` aborted it: no step after the one under way was taken. */
  cancelled?: true;
}

/**
 * Events, each emitted once. `taken` is true when a call's outcome already gave it (`run`, `send` or
 * `wait` on this session, unless the call passed `take: false` or its `signal` aborted it first), so the host can skip the wake;
 * that call's outcome lists it in `took`.
 * `waiting` fires on each entry into that state, noticed within about a quarter second, and input
 * sent while something is in front starts a new one; a `match`
 * watch fires once and is gone. A shell that exits mid-command emits that command's `ended`, with no
 * status, before `exited`.
 */
export type SessionEvent =
  | { kind: 'ended'; command: Command; taken: boolean }
  | { kind: 'waiting'; front: Extract<Front, { state: 'waiting' }>; taken: boolean }
  | { kind: 'match'; watch: number; match: Match }
  | { kind: 'exited'; exit: Exit; taken: boolean };

export interface Session {
  readonly name: string;
  readonly pid: number;
  readonly kind: ShellKind;
  readonly openedAt: number;

  /** What is in front now, read from the kernel at the call. */
  front(): Front;
  /** The directory as of the last accepted end mark, else the one it opened in. */
  cwd(): string;
  /** The command running now, and the last that ended. */
  current(): Command | undefined;
  last(): Command | undefined;
  command(id: number): Command | undefined;
  /** Lines `from` up to `to`, or through the cursor's line when `to` is absent. The live nonce never shows in them. */
  lines(from: number, to?: number): Lines;
  screen(): Screen;
  /** For keys' `inputBytes`: arrows follow the cursor-key mode the program set. */
  keyOptions(): { appCursor: boolean };

  /** Only at a prompt with nothing pending; otherwise refused with nothing typed. At a prompt whose end mark came but which isn't drawn yet, it first waits, within `waitMs`, for the mark at the prompt's end, as `send` does. In `run`, `send` and `wait`, an aborted `signal` ends the call's wait at once: `run` is refused if nothing was typed yet, and `send` and `wait` return `by: 'cancelled'`. */
  run(text: string, opts: { waitMs: number; take?: boolean; signal?: AbortSignal }): Promise<RunOutcome>;
  /** Exactly these bytes, nothing appended. At a prompt whose end mark came but which isn't drawn yet, it first waits, within `waitMs`, for the mark at the prompt's end, so the line editor gets the bytes rather than the terminal or a prompt hook, and sends nothing if the wait runs out. Returns when `until` matches from the cursor's line on, or (without `until`) when output is quiet for `quietMs`, default 300. */
  send(bytes: string, opts: { waitMs: number; until?: RegExp; quietMs?: number; take?: boolean; signal?: AbortSignal }): Promise<SendOutcome>;
  /** `match` looks from line `from` on, so lines already there count. */
  wait(until: Until, opts: { waitMs: number; from: number; take?: boolean; signal?: AbortSignal }): Promise<WaitOutcome>;
  /** Without `signal`, in steps: C-c, typed to the terminal, so it reaches whatever is in front, a shell's own loop included; then TERM, then KILL, each with a grace and each only to the job's group while it is still the shell's. With `signal`, that one step. */
  stop(signal?: NodeJS.Signals, opts?: { abort?: AbortSignal }): Promise<StopOutcome>;
  /** Hangs up the shell, again every 500 ms while it is there, then after a grace KILLs the shell alone, so the kernel hangs up the job in front as a closing terminal does, and a job detached on purpose lives on. With `force`, at once KILLs every process group the shell started, then the shell. Resolves with the exit, at once if it had exited. */
  close(opts?: { force?: boolean }): Promise<Closed>;

  /** A one-shot pattern watch from line `from` on; its id names the `match` event. Given `command`, its match in that command's output is emitted before the command's `ended`; other watches search a slice at a time. */
  watch(pattern: RegExp, from: number, command?: number): number;
  unwatch(id: number): void;
  onEvent(listener: (event: SessionEvent) => void): () => void;
}
