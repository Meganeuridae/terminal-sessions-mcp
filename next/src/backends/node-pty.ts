/** The in-process backend: node-pty for shells, child_process for process Runs. */
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import type { ExecutionBackend, ForegroundInfo, ProcessHandle, PtyExit, PtyHandle, SpawnProcessOptions, SpawnShellOptions } from './types.js';

const signalName = (n: number | undefined): string | undefined => {
  if (n === undefined || n === 0) return undefined;
  const names: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL', 13: 'SIGPIPE', 15: 'SIGTERM' };
  return names[n] ?? `SIG${n}`;
};

/** After the leader exits, how long to let its pipes drain before reporting the exit. */
const DRAIN_MS = 200;

/**
 * The shell's process group and the terminal's foreground group (tcgetpgrp), read
 * synchronously: `/proc/<pid>/stat` on Linux, `ps` elsewhere (about 2 ms on macOS).
 */
function readForeground(pid: number): ForegroundInfo | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // pid (comm) state ppid pgrp session tty_nr tpgid …; comm may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const shellPgid = Number(fields[2]);
      const foregroundPgid = Number(fields[5]);
      return shellPgid > 0 && foregroundPgid > 0 ? { shellPgid, foregroundPgid } : undefined;
    }
    const out = execFileSync('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/);
    const shellPgid = Number(out[0]);
    const foregroundPgid = Number(out[1]);
    return shellPgid > 0 && foregroundPgid > 0 ? { shellPgid, foregroundPgid } : undefined;
  } catch {
    return undefined;
  }
}

/** Does any process of group `pgid` remain? (EPERM: one does, under another user.) */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is process group `pgid`, whose leader (a Run's own process) has
 * exited, still the Run's? A pid alone does not identify a process: pids are reused (lock.ts),
 * and a group's id is its leader's pid. While any member of the group lives the kernel keeps
 * that pid from being reused, so a group with no process of its own id is the Run's orphans.
 * Node has already reaped the leader before its exit callback: any process now holding that
 * pid is a stranger, even one started in the same second. A zero signal checks this without
 * a synchronous process listing on every Run's end. When nothing can say, nothing is signalled.
 */
export function groupStillOurs(pgid: number, exists: (pid: number) => boolean | undefined = pidExists): boolean {
  return exists(pgid) === false;
}

function pidExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined;
  }
}

/** A process's current command line: `/proc/<pid>/cmdline` on Linux, `ps` elsewhere. */
function readCommand(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || undefined;
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

class NodePty implements PtyHandle {
  constructor(private readonly p: pty.IPty) {}
  get pid(): number {
    return this.p.pid;
  }
  write(data: string): void {
    this.p.write(data);
  }
  pause(): void {
    this.p.pause();
  }
  resume(): void {
    this.p.resume();
  }
  resize(cols: number, rows: number): void {
    this.p.resize(cols, rows);
  }
  kill(signal?: NodeJS.Signals): void {
    this.p.kill(signal);
  }
  onData(listener: (data: string) => void): () => void {
    const d = this.p.onData(listener);
    return () => d.dispose();
  }
  onExit(listener: (exit: PtyExit) => void): () => void {
    const d = this.p.onExit(({ exitCode, signal }) => {
      const e: PtyExit = { exitCode: signal ? null : exitCode };
      const s = signalName(signal);
      if (s) e.signal = s;
      listener(e);
    });
    return () => d.dispose();
  }
  foreground(): ForegroundInfo | undefined {
    return readForeground(this.p.pid);
  }
  command(): string | undefined {
    return readCommand(this.p.pid);
  }
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    if (!(pgid > 1)) return false;
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {
      return false;
    }
  }
  groupAlive(pgid: number): boolean {
    return pgid > 1 && groupAlive(pgid);
  }
}

/**
 * What every process Run starts through: `/bin/bash -p -c PROCESS_LAUNCH termd-process <argv…>`.
 * It closes every descriptor above stderr before the command runs. node-pty opens each
 * session's terminal master without close-on-exec, and Node passes a child every descriptor
 * that isn't, so a process Run held the master of every session open when it started: it
 * could have written into those terminals, another principal's included, and it kept a
 * shell alive after the daemon died, since the terminal never hung up (the house's review
 * of #11, and issue #18). The descriptors are listed through /dev/fd (Linux links it to
 * /proc/self/fd); the glob is expanded, and its directory closed, before the loop runs. On
 * Linux the Run is also made a likelier victim of the out-of-memory killer than the daemon,
 * as the shells are (see oomLine). Only the daemon's constant text is on this command line: a Run given a
 * line gets its text on descriptor 3, which `/bin/sh`, exec'd by the launcher, reads whole, closes,
 * and runs with `eval` (see Session.admit; argv is then `/bin/sh`): the line is in no argv and in no file a
 * crash and a fast restart could remove, and the command's own children never see the descriptor.
 * Bash is needed only for closing arbitrary descriptor numbers (dash parses `exec 12>&-`
 * as a command named 12). Its privileged mode skips BASH_ENV and imported shell functions
 * before cleanup; the Run's line still executes in /bin/sh, with the environment it was given plus
 * what bash exports on its way (`PWD`, `SHLVL`) and without `_` (the house measured it).
 */
/** Is `cmd` a file that may be executed, by path or on `PATH`? */
function executable(cmd: string, PATH: string | undefined, cwd: string): boolean {
  const ok = (p: string) => {
    try {
      const file = path.resolve(cwd, p);
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) return ok(cmd);
  return (PATH ?? '/usr/bin:/bin').split(':').some((d) => ok(path.join(d, cmd)));
}

/**
 * The launcher's text; with `readsLine`, descriptor 3 carries the Run's own text: the launcher
 * keeps it through the close loop and execs `/bin/sh`, which reads it, closes it and runs the text
 * (see spawnProcess).
 */
export function processLaunch(readsLine: boolean, oomScoreAdj = 0): string {
  const readLine = [
    '__tsm_line=; while IFS= read -r __tsm_l; do __tsm_line="$__tsm_line$__tsm_l',
    '"; done <&3; __tsm_line="$__tsm_line$__tsm_l"',
    'exec 3<&-',
    'eval "unset __tsm_l __tsm_line; $__tsm_line"',
  ].join('\n');
  return [
    `if [ -d /dev/fd ]; then for f in /dev/fd/*; do case "\${f##*/}" in ${readsLine ? '0|1|2|3' : '0|1|2'}) ;; *) eval "exec \${f##*/}>&-" 2>/dev/null || :;; esac; done; fi`,
    ...oomLine(oomScoreAdj),
    ...(readsLine
      // Read the descriptor itself: Linux cannot reopen Node's socket as /dev/fd/3.
      // Only this constant reader is in argv; its eval removes both temporary variables.
      ? [`exec /bin/sh -c '${readLine.replaceAll("'", "'\\''")}' termd-process`]
      : ['exec "$@"']),
  ].join('\n');
}

/**
 * The line that raises a session process's oom_score_adj on Linux (no /proc elsewhere): the
 * kernel then takes it before the daemon, whose death would lose every session. The preference
 * is machine-wide, not relative to the daemon alone — a raised build is taken before other
 * users' processes too — so the amount is the daemon's `--session-oom-score-adj` (default 200),
 * and 0 writes nothing.
 */
export function oomLine(oomScoreAdj: number): string[] {
  const n = Math.max(0, Math.min(1000, Math.floor(oomScoreAdj)));
  return n > 0 ? [`if [ -w /proc/self/oom_score_adj ]; then echo ${n} > /proc/self/oom_score_adj 2>/dev/null || :; fi`] : [];
}

export class NodePtyBackend implements ExecutionBackend {
  readonly kind = 'node-pty';

  spawnShell(opts: SpawnShellOptions): PtyHandle {
    const launcher = opts.bootstrap?.launcher;
    const p = pty.spawn(launcher ? '/bin/sh' : opts.shell, launcher ? [launcher, opts.shell, ...opts.args] : opts.args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
    });
    return new NodePty(p);
  }

  spawnProcess(opts: SpawnProcessOptions): ProcessHandle {
    const [cmd, ...args] = opts.argv;
    if (!cmd) throw new Error('spawnProcess: empty argv');
    // detached: own process group, so cancel can signal the group (G29). stdin is
    // /dev/null: no verb writes to a process Run's stdin, so a reader sees EOF
    // instead of hanging (core-12). The command starts through PROCESS_LAUNCH (below),
    // whose exec keeps the pid, so the group leader is the command itself. A command
    // that cannot be found or run is spawned directly, so the failure is a spawn error,
    // not the launcher's exit 127 (core-15: nothing ran, no signal was observed).
    // A line's text goes to the child on descriptor 3, which the launcher shell keeps, reads
    // whole and closes before running the text (see processLaunch).
    const script = opts.line !== undefined && cmd === '/bin/sh' && args.length === 0 ? `${opts.line}\n` : undefined;
    const launched =
      script !== undefined
        ? (['/bin/bash', ['--noprofile', '--norc', '-p', '-c', processLaunch(true, opts.oomScoreAdj ?? 0), 'termd-process']] as const)
        : executable(cmd, opts.env.PATH, opts.cwd)
          ? (['/bin/bash', ['--noprofile', '--norc', '-p', '-c', processLaunch(false, opts.oomScoreAdj ?? 0), 'termd-process', cmd, ...args]] as const)
          : ([cmd, args] as const);
    const child = spawnChild(launched[0], [...launched[1]], { cwd: opts.cwd, env: opts.env, stdio: script !== undefined ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: true });
    if (script !== undefined) {
      const feed = child.stdio[3] as NodeJS.WritableStream | null;
      feed?.on('error', () => undefined); // the shell may exit before reading it all
      feed?.end(script);
    }
    // (Both streams are piped above; the conditional stdio array widens their types.)
    const stdout = child.stdout!;
    const stderr = child.stderr!;
    // The journal stores UTF-8 text, not arbitrary binary streams. Node's streaming
    // decoder preserves split characters and replaces invalid sequences with U+FFFD.
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    const outL = new Set<(d: string) => void>();
    const errL = new Set<(d: string) => void>();
    const exitL = new Set<(e: PtyExit) => void>();
    stdout.on('data', (d: string) => outL.forEach((l) => l(d)));
    stderr.on('data', (d: string) => errL.forEach((l) => l(d)));
    const pgid = child.pid;
    let fired = false;
    let spawned = false;
    let leaderExited = false;
    const fire = (e: PtyExit) => {
      if (fired) return;
      fired = true;
      exitL.forEach((l) => l(e));
    };
    child.on('spawn', () => (spawned = true));
    // Report the exit once the pipes are drained, so the Run's last output lands
    // before its end; a group member that keeps the pipes open only delays it by
    // DRAIN_MS.
    let open = 2;
    let pendingExit: PtyExit | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const settle = () => {
      if (pendingExit && open === 0) {
        if (drainTimer) clearTimeout(drainTimer);
        fire(pendingExit);
      }
    };
    stdout.on('end', () => (open--, settle()));
    stderr.on('end', () => (open--, settle()));
    child.on('exit', (code, signal) => {
      leaderExited = true;
      pendingExit = signal ? { exitCode: null, signal } : { exitCode: code };
      drainTimer = setTimeout(() => fire(pendingExit!), DRAIN_MS);
      drainTimer.unref();
      settle();
    });
    // A spawn failure is not an exit: nothing ran, and no signal was observed (core-15).
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (spawned) return;
      fire({ exitCode: null, spawnError: e.code ? `${e.code} ${e.message}` : e.message });
    });
    return {
      get pid() {
        return child.pid ?? -1;
      },
      get pgid() {
        return pgid ?? -1;
      },
      onStdout: (l) => (outL.add(l), () => outL.delete(l)),
      onStderr: (l) => (errL.add(l), () => errL.delete(l)),
      onExit: (l) => (exitL.add(l), () => exitL.delete(l)),
      kill(signal) {
        if (pgid === undefined) return;
        // The group, not the leader: members survive a leader that exited (tg-12). Once the
        // leader has exited, only a group that is still the Run's is signalled (see groupStillOurs).
        if (leaderExited && !groupStillOurs(pgid)) return;
        try {
          process.kill(-pgid, signal);
        } catch {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill(signal);
            } catch {
              // already gone
            }
          }
        }
      },
      groupAlive: () => pgid !== undefined && groupAlive(pgid) && (!leaderExited || groupStillOurs(pgid)),
    };
  }
}
