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
  /** Private shell bootstrap; the credential is backend configuration, never child env. */
  bootstrap?: { launcher: string; key: string };
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
  cwd: string;
  env: Record<string, string>;
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
