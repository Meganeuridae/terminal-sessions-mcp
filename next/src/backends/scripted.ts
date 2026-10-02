/**
 * The scripted backend: fake shells and processes a test drives byte by byte.
 * Nothing here touches the OS; it is what makes the guarantee suite deterministic.
 */
import type { ExecutionBackend, ForegroundInfo, ProcessHandle, PtyExit, PtyHandle, SpawnProcessOptions, SpawnShellOptions } from './types.js';

let nextPid = 40_000;

export class ScriptedPty implements PtyHandle {
  readonly pid = nextPid++;
  readonly writes: string[] = [];
  readonly kills: string[] = [];
  /** Signals sent to process groups on this terminal: [pgid, signal]. */
  readonly groupKills: Array<[number, string]> = [];
  /**
   * The terminal's foreground group as the test scripts it: `undefined` models a
   * backend that cannot observe it; `pid` (the default) means no job is running.
   */
  foregroundPgid: number | undefined;
  /** The shell process's command line as the test scripts it (a test changes it to model an exec). */
  commandLine: string | undefined;
  /** Called when a group is signalled (a test can end the job it models). */
  onGroupSignal?: (pgid: number, signal: NodeJS.Signals) => void;
  /** Process groups on this terminal the test says are alive (a job that survived its hangup). */
  readonly liveGroups = new Set<number>();
  private dataL = new Set<(d: string) => void>();
  private exitL = new Set<(e: PtyExit) => void>();
  private writeL = new Set<(d: string) => void>();
  exited = false;

  constructor(readonly opts: SpawnShellOptions) {
    this.foregroundPgid = this.pid;
    this.commandLine = [opts.shell, ...opts.args].join(' ');
  }

  // -- PtyHandle (what the session calls) --
  write(data: string): void {
    this.writes.push(data);
    for (const l of this.writeL) l(data);
  }
  resize(): void {}
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.kills.push(signal);
  }
  onData(listener: (data: string) => void): () => void {
    this.dataL.add(listener);
    return () => this.dataL.delete(listener);
  }
  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitL.add(listener);
    return () => this.exitL.delete(listener);
  }
  foreground(): ForegroundInfo | undefined {
    return this.foregroundPgid === undefined ? undefined : { shellPgid: this.pid, foregroundPgid: this.foregroundPgid };
  }
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    this.groupKills.push([pgid, signal]);
    this.onGroupSignal?.(pgid, signal);
    return true;
  }
  command(): string | undefined {
    return this.commandLine;
  }
  groupAlive(pgid: number): boolean {
    return this.liveGroups.has(pgid);
  }

  // -- test controls --
  /** Emit output as if the shell produced it. */
  emit(data: string): void {
    if (this.exited) throw new Error('emit after exit');
    for (const l of this.dataL) l(data);
  }
  /** End the shell. */
  exit(exit: PtyExit = { exitCode: 0 }): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitL) l(exit);
  }
  /** Observe what the session writes. */
  onWrite(listener: (data: string) => void): () => void {
    this.writeL.add(listener);
    return () => this.writeL.delete(listener);
  }
  get written(): string {
    return this.writes.join('');
  }
}

export class ScriptedProcess implements ProcessHandle {
  readonly pid = nextPid++;
  readonly pgid = this.pid;
  readonly kills: NodeJS.Signals[] = [];
  exited = false;
  /** Whether the process group still has members; defaults to "while the leader runs". */
  groupMembers: number | undefined;
  private outL = new Set<(d: string) => void>();
  private errL = new Set<(d: string) => void>();
  private exitL = new Set<(e: PtyExit) => void>();

  constructor(readonly opts: SpawnProcessOptions) {}

  onStdout(l: (d: string) => void): () => void {
    this.outL.add(l);
    return () => this.outL.delete(l);
  }
  onStderr(l: (d: string) => void): () => void {
    this.errL.add(l);
    return () => this.errL.delete(l);
  }
  onExit(l: (e: PtyExit) => void): () => void {
    this.exitL.add(l);
    return () => this.exitL.delete(l);
  }
  kill(signal: NodeJS.Signals): void {
    this.kills.push(signal);
  }
  groupAlive(): boolean {
    return this.groupMembers === undefined ? !this.exited : this.groupMembers > 0;
  }

  emitStdout(d: string): void {
    for (const l of this.outL) l(d);
  }
  emitStderr(d: string): void {
    for (const l of this.errL) l(d);
  }
  exit(exit: PtyExit = { exitCode: 0 }): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitL) l(exit);
  }
}

export class ScriptedBackend implements ExecutionBackend {
  readonly kind = 'scripted';
  readonly ptys: ScriptedPty[] = [];
  readonly processes: ScriptedProcess[] = [];
  /** Hooks a test installs to script behaviour at spawn time. */
  onSpawnShell?: (pty: ScriptedPty) => void;
  onSpawnProcess?: (proc: ScriptedProcess) => void;

  spawnShell(opts: SpawnShellOptions): PtyHandle {
    const p = new ScriptedPty(opts);
    this.ptys.push(p);
    // Let the session wire its listeners before the script starts emitting.
    queueMicrotask(() => this.onSpawnShell?.(p));
    return p;
  }

  spawnProcess(opts: SpawnProcessOptions): ProcessHandle {
    const p = new ScriptedProcess(opts);
    this.processes.push(p);
    queueMicrotask(() => this.onSpawnProcess?.(p));
    return p;
  }
}
