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
  /** Once it aborts, opening waits no longer for the first prompt, as when `waitMs` runs out. */
  signal?: AbortSignal;
  /** Linux: the shell's oom_score_adj; 0 leaves it alone. */
  oomScoreAdj?: number;
  /** Where the session writes what no caller is told, such as a directory `close` couldn't remove. */
  log?: (line: string) => void;
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
  /** The processes on the session's terminal, or with `force` the shell's descendants, couldn't be listed, or close couldn't check which listed groups still held them, in which case it signalled none: a listing failed, or the deadline left it no time. Either way, what it started may live on. */
  unlisted?: true;
  /** The shell's exit wasn't seen within a grace after its KILL, or by the deadline, as for a process in uninterruptible sleep. */
  unconfirmed?: true;
  /** The groups whose hangup, or KILL with `force`, wasn't delivered, each with the error's code, such as `EPERM`; their processes may live on. */
  unreached?: Array<{ pgid: number; signal: 'SIGHUP' | 'SIGKILL'; error: string }>;
};

/** A process group in front of the terminal. */
export interface Process {
  pgid: number;
  /** Its leader's command line as the kernel has it now. */
  argv: string;
  /** The shell itself runs it: a loop, a builtin, a function, or its startup files. false for a job, and for a program exec'd in the shell's place. */
  shell: boolean;
}

/**
 * In `prompt` and `running`: the state is a shell's given the integration with `integrate`, read from its marks alone, and this is
 * the local program it runs under, which holds the terminal (such as `ssh host`). Absent for the session's own shell.
 */
export type Within = { within?: Process };

export type Front =
  | ({
      state: 'prompt';
      since: number;
      /** Text sent at this prompt and not yet submitted, as far as the session knows: `run` refuses while it's there. */
      pending?: string;
    } & Within)
  | ({
      state: 'running';
      since: number;
      /** With `within`, that program: the kernel sees nothing past it. */
      process: Process;
      /** The command that put it there, when a start mark named one. */
      command?: number;
      /** false when the kernel won't show whether it reads the terminal (no ptrace access, or not Linux), so `waiting` can't be seen; always false with `within`. */
      waitVisible: boolean;
      /** The shell hasn't drawn its first prompt yet: it is still running its startup files. */
      starting?: true;
    } & Within)
  | {
      /** Blocked reading this terminal, on the kernel's evidence. Programs that wait in poll (a REPL, ssh) show as `running`, and so does everything past a `within`. */
      state: 'waiting';
      since: number;
      process: Process;
      command?: number;
      /** false: the terminal doesn't echo, as for a password. Absent when its modes couldn't be read. */
      echo?: boolean;
      /** The shell hasn't drawn its first prompt yet: a startup file is reading. */
      starting?: true;
    }
  | {
      /** The terminal couldn't be read, so whether the shell is at its prompt isn't known. A prompt the marks show stays `prompt`. */
      state: 'unknown';
      since: number;
      command?: number;
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
  /**
   * A signal `stop` sent stopped the job rather than ending it: the shell took the terminal back and reported `status` as for
   * an end (128 and the signal's number in bash and zsh, 0 in fish). `jobs` lists it, and `run fg` or `run bg` continues it.
   */
  stopped?: true;
  /**
   * The session stopped following it, and whether it ended isn't known. `by` names the program the shell it ran in was reached
   * through. `ended`: that program has no process left, or the session's shell exited. `left`: it left the terminal, as when
   * it's suspended. `back`: it ran in a far shell, and that far shell is at its prompt again, which shows nothing about how it
   * went. A far command can run on after its carrier is gone.
   */
  unfollowed?: { by: string; how: 'ended' | 'left' | 'back' };
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

/**
 * The events a call took, each emitted `taken` because this call was to give it: handed back untaken by a host that doesn't deliver the call's result, so it becomes a report and a wake.
 * Every call that took one occurrence holds the same object, and `takers` counts those calls, so a host can hand an occurrence back only when none of them delivered it.
 */
export type Took = Array<Extract<SessionEvent, { kind: 'ended' | 'waiting' | 'exited' }> & { takers: number }>;

export type RunOutcome =
  /**
   * Not at a prompt, text pending at it, or the shell exited: `front` says which. Nothing was typed.
   * `tooLong`: a shell given the integration with `integrate` gets the text on one typed line, and this one, `typed` characters,
   * is longer than `max`. Printable ASCII types as itself, but for `'`, `\` and `!`; every other byte types as a five-character escape.
   */
  | { kind: 'refused'; front: Front; took: Took; tooLong?: { typed: number; max: number } }
  | { kind: 'ended'; command: Command; front: Front; took: Took }
  | { kind: 'running'; command: Command; front: Front; took: Took };

export interface SendOutcome {
  /** false when nothing was sent: the shell had exited (`by: 'exited'`), a prompt whose end mark came wasn't drawn within the wait (`by: 'timeout'`), the call's signal aborted it (`by: 'cancelled'`), `close` began while it waited (`by: 'closed'`), or `paste` was asked for while the program in front hadn't turned bracketed paste on (`by: 'paste_off'`). */
  sent: boolean;
  /** From the line the cursor was on when the text went in. */
  lines: Lines;
  /** While the alternate screen is active. */
  screen?: Screen;
  front: Front;
  /** Commands that ended during the call. */
  ended: Command[];
  matched?: Match;
  /** Why it returned: `until` matched, output went quiet, the shell exited, the wait ran out, or the call's signal aborted it; or, with nothing sent, `paste` was asked while the program in front had bracketed paste off. */
  by: 'match' | 'quiet' | 'exited' | 'timeout' | 'cancelled' | 'closed' | 'paste_off';
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
  /** The prompt came back with the job stopped, not ended: its group holds a stopped process. `jobs` lists it, and `run fg` or `run bg` continues it. */
  stopped?: true;
}

export interface StopOutcome {
  steps: StopStep[];
  front: Front;
  /** The shell itself runs what's in front, a program exec'd in the shell's place does, or a job outlived KILL: only `close` ends it. */
  next?: 'close';
  /** `abort` aborted it: no step after the one under way was taken. */
  cancelled?: true;
  /** A shell given the integration is in front (`front.within`): C-c is the only step, and a `signal` isn't sent, since it would reach that local program, not the far job. */
  within?: true;
}

export type IntegrateOutcome =
  /**
   * The shell in front answered the probe and drew a prompt with the hooks: `front` is that prompt, with `within`. `printed` is what
   * the shell printed while it took them, a line each, from the last typed line's run to its first end mark; with nothing printed, it's absent.
   */
  | { kind: 'integrated'; shell: 'bash' | 'zsh' | 'fish'; version: string; printed?: string[]; front: Front }
  /**
   * Nothing was typed: a shell with the integration is at its prompt, drawn or not (the session's own, or one given it before), the
   * shell exited, or the call was cancelled first. `sent`: a line was sent at that prompt and hasn't started yet, so what is in front
   * may be a question, such as a password, that anything typed would answer. `canonical`: this terminal is in canonical mode, so
   * what is in front reads whole lines itself, such as a password or a yes/no question that ssh, su or sudo asks on this machine, or a
   * shell without a line editor. The line editors of bash, zsh and fish hold it out of that mode at their prompts. A program that holds
   * this terminal raw, such as a connected ssh, hides its far side: a question there can't be seen, and the probe line would answer
   * it. `unread`: this terminal's modes couldn't be read, so whether what is in front reads whole lines itself isn't known.
   * `integrating`: another `integrate` call on this session is still typing.
   */
  | { kind: 'refused'; sent?: true; canonical?: true; unread?: true; integrating?: true; front: Front }
  /** A shell answered the probe that has no hooks here (sh, dash, ash, and others). Nothing more was typed. `shell` is its `$0`, when it gave one. */
  | { kind: 'unsupported'; shell?: string; front: Front }
  /**
   * The call stopped before the step it names was complete, and nothing more is typed. `probe`: the probe line was typed and no
   * shell answered. `hooks`: the hooks go in pieces, each typed once the one before has run, and they weren't all typed, or the
   * last was and no prompt with them was drawn yet. Only the last puts them to use: if it was typed and a prompt is drawn later,
   * the shell has the integration from then on. `exited`: the session's shell exited, or what the probe or the hooks were typed into
   * ended, and a shell below it came back to its prompt.
   */
  | { kind: 'incomplete'; step: 'probe' | 'hooks'; by: 'timeout' | 'cancelled' | 'exited' | 'closed'; front: Front };

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
  /** The directory as of the last accepted end mark, else the one it opened in: a shell's given the integration while it's in front. */
  cwd(): string;
  /** The command running now, and the last that ended. */
  current(): Command | undefined;
  last(): Command | undefined;
  command(id: number): Command | undefined;
  /** Lines `from` up to `to`, or through the cursor's line when `to` is absent. The live nonce never shows in them. */
  lines(from: number, to?: number): Lines;
  screen(): Screen;

  /** Only at a prompt with nothing pending; otherwise refused with nothing typed. At a prompt whose end mark came but which isn't drawn yet, it first waits, within `waitMs`, for the mark at the prompt's end, as `send` does. In `run`, `send` and `wait`, an aborted `signal` ends the call's wait at once: `run` is refused if nothing was typed yet, and `send` and `wait` return `by: 'cancelled'`. */
  run(text: string, opts: { waitMs: number; take?: boolean; signal?: AbortSignal }): Promise<RunOutcome>;
  /** Exactly `text`, then the named `keys`, nothing appended, in one write. At a prompt whose end mark came but which isn't drawn yet, it first waits, within `waitMs`, for the mark at the prompt's end, so the line editor gets the bytes rather than the terminal or a prompt hook, and sends nothing if the wait runs out. Then, from all output parsed so far, it encodes the keys by the cursor-key mode the program set, and with `paste` frames `text` as a bracketed paste, or sends nothing if the program has that mode off. Returns when `until` matches from the cursor's line on, or (without `until`) when output is quiet for `quietMs`, default 300. */
  send(text: string, opts: { waitMs: number; keys?: readonly string[]; paste?: boolean; until?: RegExp; quietMs?: number; take?: boolean; signal?: AbortSignal }): Promise<SendOutcome>;
  /** `match` looks from line `from` on, so lines already there count. */
  wait(until: Until, opts: { waitMs: number; from: number; take?: boolean; signal?: AbortSignal }): Promise<WaitOutcome>;
  /**
   * Without `signal`, in steps: C-c, typed to the terminal, so it reaches whatever is in front, a shell's own loop included; then TERM,
   * then KILL, each with a grace and each only to the job's group while it is still the shell's. With `signal`, any the platform has,
   * that one step. A suspend signal (TSTP, STOP, TTIN, TTOU) stops the job: the prompt comes back, and the step and the command's
   * ending say `stopped`. A signal the job ignores or handles leaves it running, and the step's front says so once its grace runs
   * out. At a prompt nothing is in front, so CONT reaches no stopped job: `run fg` or `run bg` continues one.
   */
  stop(signal?: NodeJS.Signals, opts?: { abort?: AbortSignal }): Promise<StopOutcome>;
  /**
   * Gives the shell now in front the integration, typed, so that `run` types there and its marks give the front, statuses and
   * the directory until it exits; then the shell it was typed from is in front again. It types a probe line, then that shell's hooks,
   * into whatever holds the terminal, so it's for a shell at its prompt. Refused at the prompt of a shell with the integration, from
   * its end mark on, while a line sent there hasn't started, and while the terminal is in canonical mode. If what it types into ends
   * before the hooks are all typed, it stops.
   */
  integrate(opts: { waitMs: number; signal?: AbortSignal }): Promise<IntegrateOutcome>;
  /**
   * Lists the processes on the session's terminal first. Then it hangs up the shell, again every 500 ms while it is there, and KILLs
   * it if it is still there after a grace. Once the shell is gone, it hangs up each listed group, and continues each group the hangup
   * reached. A process that left the terminal with setsid isn't listed, so it lives on. With `force`, at once KILLs every listed group
   * and every group the shell started, then the shell. Resolves with the exit, at once if it had exited.
   * Every step spends from `deadline`, an absolute time on `performance.now()`'s clock: a listing gets what's left less the graces
   * still ahead of it, the graces end at it, and the last check gets what's left. The session's directory is removed by then if it
   * can be; otherwise `close` resolves at the deadline and the removal finishes after it, logged if it fails.
   */
  close(opts: { force?: boolean; deadline: number }): Promise<Closed>;

  /** A one-shot pattern watch from line `from` on; its id names the `match` event. Given `command`, its match in that command's output is emitted before the command's `ended`; other watches search a slice at a time. */
  watch(pattern: RegExp, from: number, command?: number): number;
  unwatch(id: number): void;
  onEvent(listener: (event: SessionEvent) => void): () => void;
}
