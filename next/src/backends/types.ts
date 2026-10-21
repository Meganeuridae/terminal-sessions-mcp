/**
 * Execution backends (§13): where a shell and a process actually run.
 * Two implementations from day one: node-pty in-process, and a scripted backend
 * that makes the core deterministic under test.
 */

export interface SpawnShellOptions {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /**
   * The integration's mark key, out of band: never part of the child's environment. With a
   * `launcher`, the backend starts it (`/bin/sh launcher shell args…`) and it writes the key to
   * a private file for the shell's PID before exec'ing the shell.
   */
  bootstrap?: { key: string; launcher?: string };
  /**
   * Linux: the shell's oom_score_adj (0 or unset: unchanged); see the daemon's --session-oom-score-adj.
   * An integration's launcher sets it itself; the backend sets it for a shell started without one.
   */
  oomScoreAdj?: number;
}

export interface PtyExit {
  exitCode: number | null;
  signal?: string;
  /** The process never ran: the spawn itself failed (ENOENT, EACCES, a missing cwd). */
  spawnError?: string;
}

/** The terminal's process groups (tcgetpgrp): which job is in the foreground. */
export interface ForegroundInfo {
  /** The shell's own process group. */
  shellPgid: number;
  /** The terminal's foreground process group; equal to `shellPgid` when no job runs. */
  foregroundPgid: number;
}

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Signal the shell process itself (not its foreground job). */
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: PtyExit) => void): () => void;
  /** The terminal's foreground job, when the backend can observe it; undefined otherwise. */
  foreground?(): ForegroundInfo | undefined;
  /** Signal a process group on this terminal. Returns whether the signal was delivered. */
  signalGroup?(pgid: number, signal: NodeJS.Signals): boolean;
  /** Does any process of this group remain (e.g. a job that survived its hangup)? */
  groupAlive?(pgid: number): boolean;
  /** The shell process's current command line (it changes when the process execs); undefined if unknown. */
  command?(): string | undefined;
  /**
   * Could a process other than the shell read the terminal right now? Only the terminal's foreground
   * process group can: true when that group is not the shell's, or when a member of it other than the
   * shell holds the terminal on its input (descriptor 0) or on a descriptor above 2 (the /dev/tty a
   * pager or password tool opens); false when none does. A program bash's rc started is one: it runs
   * in the shell's own process group. (By run, an interactive bash 5.2.37 whose rc printed `$-` and
   * the pgids of programs it started showed monitor mode on, and a program started in the foreground
   * or with `&` had the shell's pid as its pgid; zsh's and fish's rcs weren't run.) The gate types no
   * reinit while it finds such a reader, within the limits below. bash's rc's `sleep 301 &` shares the
   * group too but has /dev/null as its input and does not count. A job started at a prompt has its own
   * group: in the background it is not the foreground and does not count; in the foreground that group
   * is not the shell's, and it does (the house's read of the 38 commits, #22 comment 6274841346, item
   * 2; the house's review of 4f4c067..a8b6f28). A builtin `read` is the shell itself:
   * inputMode tells `read -n` apart. Undefined when it cannot be told; the gate then does not type
   * (item 1: unknown is not "no reader").
   *
   * The limits: on Linux, a member of the shell's group that left its descendants (an orphan an rc
   * double-forked) is found only when the kernel has no children files, so it answers false where `ps
   * -t` elsewhere finds it (the house's review of 4f4c067..a8b6f28); and a program that reads the
   * terminal only through descriptor 1 or 2, as util-linux's `more` behind a pipe does (stdin the
   * pipe: its read_user_input reads keys with read(STDERR_FILENO), "Keep the read() reading from
   * stderr", text-utils/more.c at v2.41.5), looks like the rc's background job and answers false (the
   * house's read of the 33 commits, #22 comment 6307351617, item 3). A reinit typed into it draws no
   * hello, and the gate then gives up keeping the key, with the recovery line in its note.
   */
  otherReader?(): boolean | undefined;
  /**
   * The terminal's input line discipline right now: ICANON and ECHO (the house's read, #22 comment
   * 6269901528, and of the 38 commits, comment 6274841346, item 3). Readline at a bash prompt turns
   * both off; `read -n` turns ICANON off and leaves ECHO on; `read -p` and a `bash --noediting` prompt
   * leave both on and cannot be told apart; `read -e`, `read -s -n` and a raw-mode program turn both
   * off, like readline. Undefined when it cannot be read (no pts name, or `stty` failed). The gate
   * after `exec bash` types a reinit only with both off and no other reader, as a cancel types its empty
   * line: a `read -e` in the shell itself passes both, and is the gates' limit (Session's whyNotEditor).
   */
  inputMode?(): { canonical: boolean; echo: boolean } | undefined;
  /** Stop reading the PTY (the writer blocks once the kernel buffer fills) — flow control for the daemon's own emulator (§6). */
  pause?(): void;
  resume?(): void;
}

export interface SpawnProcessOptions {
  argv: string[];
  /**
   * The line the Run was given, when it was one. Its text reaches the child on descriptor 3,
   * which the launcher shell reads and runs (argv is then `/bin/sh`): never on a command line,
   * where a `pkill -f` in the line itself would find it, and never in a file, which a daemon
   * recovering after a crash within milliseconds of the spawn could remove before the shell had
   * opened it.
   */
  line?: string;
  cwd: string;
  env: Record<string, string>;
  /** Linux: the Run's oom_score_adj is set to this value (0: left alone), so the kernel takes it before the daemon. */
  oomScoreAdj?: number;
}

export interface ProcessHandle {
  readonly pid: number;
  /** The process group the daemon owns (the leader's pid for a detached spawn), recorded on run.start (jr2-4). */
  readonly pgid?: number;
  /**
   * The leader's frame-free start on Linux — clock ticks after boot, and the boot id they count from —
   * read when the leader is known and recorded on run.start, so recovery can judge the group across a
   * wall-clock step (the house's read of the 36 commits, #22, comment 6269992150, item 4). Absent off
   * Linux and for a backend whose pids are not real processes.
   */
  readonly startTicks?: number;
  readonly bootId?: string;
  onStdout(listener: (data: string) => void): () => void;
  onStderr(listener: (data: string) => void): () => void;
  /** The leader's exit (or `spawnError` when it never started). */
  onExit(listener: (exit: PtyExit) => void): () => void;
  /** Signal the process group the daemon owns (G29) — even after the leader exited. */
  kill(signal: NodeJS.Signals): void;
  /** Does any process of the group remain? (Members outlive a leader that exited.) */
  groupAlive?(): boolean;
}

export interface ExecutionBackend {
  readonly kind: string;
  spawnShell(opts: SpawnShellOptions): PtyHandle;
  spawnProcess(opts: SpawnProcessOptions): ProcessHandle;
  /**
   * Can this host run the daemon's children safely at all (the house's read of #11 and comment
   * 6269901528)? One check, consulted for both shells and process Runs: without bash, or without
   * /dev/fd to list descriptors by, a child could not close the terminal masters it inherits, so a
   * shell could write into another session's terminal and a process Run could not be isolated.
   * Absent: yes.
   */
  processSupport?(): { ok: true } | { ok: false; reason: string };
}
