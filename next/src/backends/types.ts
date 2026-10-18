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
  /** Stop reading the PTY (the writer blocks once the kernel buffer fills) — flow control for the daemon's own emulator (§6). */
  pause?(): void;
  resume?(): void;
}

export interface SpawnProcessOptions {
  argv: string[];
  /**
   * The line the Run was given, when it was one. Its text reaches the child on descriptor 3
   * (argv is then `/bin/sh /dev/fd/3`): never on a command line, where a `pkill -f` in the line
   * itself would find it, and never in a file, which a daemon recovering after a crash within
   * milliseconds of the spawn could remove before the shell had opened it.
   */
  line?: string;
  cwd: string;
  env: Record<string, string>;
  /** Linux: raise the Run's oom_score_adj by this much (0: leave it), so the kernel takes it before the daemon. */
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
}
