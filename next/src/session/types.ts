/**
 * The session machinery's contract with the host (daemon, tools, pushes): one live shell in a
 * terminal of its own, what is in front of it, and its transcript. A Session knows nothing of
 * connections, scopes, rendering or deadlines' defaults; the host keeps those.
 *
 * Times are milliseconds since the epoch. Line numbers count the session's transcript from 0 and
 * never change once given; the bound on what is kept drops the oldest lines, and every read says
 * how many it dropped.
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

/** A process group in front of the terminal. */
export interface Process {
  pgid: number;
  /** Its leader's command line as the kernel has it now. */
  argv: string;
  /** The shell's own group: a loop, a builtin, a function, or its startup files. */
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
    }
  | {
      /** Blocked reading this terminal, on the kernel's evidence. Programs that wait in poll (a REPL, ssh) show as `running`. */
      state: 'waiting';
      since: number;
      process: Process;
      command?: number;
      /** false: the terminal doesn't echo, as for a password. */
      echo: boolean;
    }
  | { state: 'exited'; since: number; exit: Exit };

export interface Ending {
  at: number;
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
  line: number;
  text: string;
}

export type RunOutcome =
  /** Not at a prompt, text pending at it, or the shell exited: `front` says which. Nothing was typed. */
  | { kind: 'refused'; front: Front }
  | { kind: 'ended'; command: Command; front: Front }
  | { kind: 'running'; command: Command; front: Front };

export interface SendOutcome {
  /** false when the shell had exited, and nothing was sent. */
  sent: boolean;
  /** From the line the cursor was on when the text went in. */
  lines: Lines;
  /** While the alternate screen is active. */
  screen?: Screen;
  front: Front;
  /** Commands that ended during the call. */
  ended: Command[];
  matched?: Match;
  /** Why it returned: `until` matched, output went quiet, the shell exited, or the wait ran out. */
  by: 'match' | 'quiet' | 'exited' | 'timeout';
}

export type Until = { kind: 'end' } | { kind: 'input' } | { kind: 'match'; pattern: RegExp };

export interface WaitOutcome {
  /** `end`: the front is at a prompt, at once when it already was; `input`: the front is `waiting`. */
  by: 'end' | 'input' | 'match' | 'exited' | 'timeout';
  front: Front;
  ended: Command[];
  matched?: Match;
}

export interface StopStep {
  /** `C-c` is typed to the terminal; a signal goes to the foreground job's group, never the shell's. */
  sent: 'C-c' | NodeJS.Signals;
  to?: Process;
  /** The front once the step settled or its grace ran out. */
  front: Front;
}

export interface StopOutcome {
  steps: StopStep[];
  front: Front;
  /** The shell itself runs what's in front, or a job outlived KILL: only `close` ends it. */
  next?: 'close';
}

/**
 * Events, each emitted once. `taken` is true when a call's outcome already gave it (`run`, `send` or
 * `wait` on this session, unless the call passed `take: false`), so the host can skip the wake.
 * `waiting` fires on each entry into that state, noticed within about a quarter second; a `match`
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

  /** Only at a prompt with nothing pending; otherwise refused with nothing typed. */
  run(text: string, opts: { waitMs: number; take?: boolean }): Promise<RunOutcome>;
  /** Exactly these bytes, nothing appended. At a prompt whose end mark came but which isn't drawn yet, it first waits, within `waitMs`, for the drawn prompt, so the line editor gets the bytes rather than the terminal. Returns when `until` matches from the cursor's line on, or (without `until`) when output is quiet for `quietMs`, default 300. */
  send(bytes: string, opts: { waitMs: number; until?: RegExp; quietMs?: number; take?: boolean }): Promise<SendOutcome>;
  /** `match` looks from line `from` on, so lines already there count. */
  wait(until: Until, opts: { waitMs: number; from: number; take?: boolean }): Promise<WaitOutcome>;
  /** Without `signal`, in steps: C-c, then TERM, then KILL, each with a grace. With it, that one step. */
  stop(signal?: NodeJS.Signals): Promise<StopOutcome>;
  /** Hangs up the shell, then KILL after a grace, or at once with `force`. Resolves with the exit, at once if it had exited. */
  close(opts?: { force?: boolean }): Promise<Exit>;

  /** A one-shot pattern watch from line `from` on; its id names the `match` event. */
  watch(pattern: RegExp, from: number): number;
  unwatch(id: number): void;
  onEvent(listener: (event: SessionEvent) => void): () => void;
}
