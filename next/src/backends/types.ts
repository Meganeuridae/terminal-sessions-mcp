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
   * Does the shell have a child process right now (the house's read, #22 comment 6269901528)? A
   * pager, an editor, tmux or a password tool the rc started is one, and the daemon never types a
   * reinit while a child is reading. A builtin `read` has no child, so this does not catch it.
   * Undefined when it cannot be read; the caller then falls back to the terminal mode.
   */
  hasChild?(): boolean | undefined;
  /**
   * Is the terminal's input line discipline canonical right now (the house's read, #22 comment
   * 6269901528)? `false` is non-canonical: readline at a bash prompt, but also `read -e`, `read -n`,
   * a pager, an editor and a raw-mode password tool — non-canonical does not mean readline. `true`
   * is canonical: a plain `read`/`read -p`, and a `bash --noediting` prompt, which cannot be told
   * apart from each other. Undefined when it cannot be read (no pts name, or `stty` failed). Used to
   * decide whether a typed reinit is safe after `exec bash` (#22); the gate types only when `false`
   * and the shell has no child.
   */
  canonicalInput?(): boolean | undefined;
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
