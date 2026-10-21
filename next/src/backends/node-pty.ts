/** The in-process backend: node-pty for shells, child_process for process Runs. */
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { err } from '../core/errors.js';
import { processLaunch, shellLaunch, viaBash } from '../core/launch.js';
import { parseProcStat, procStart, readProcStat, type ProcStat } from '../core/lock.js';
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
 * synchronously: `/proc/<pid>/stat` on Linux, through the one parser of that line the lock and
 * recovery use (readProcStat; a reviewer's read of the fixes for #22), `ps` elsewhere (about
 * 2 ms on macOS).
 */
function readForeground(pid: number): ForegroundInfo | undefined {
  try {
    if (process.platform === 'linux') {
      const g = readProcStat(pid);
      return g && g.pgrp > 0 && g.tpgid > 0 ? { shellPgid: g.pgrp, foregroundPgid: g.tpgid } : undefined;
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

/**
 * The terminal slave's input mode, from `stty -a`: ICANON and ECHO (readline at a prompt turns both
 * off; `read -n` turns ICANON off and leaves ECHO on, which tells it apart: the house's read of the 38
 * commits, #22 comment 6274841346, item 3). Undefined when the slave's termios cannot be read. The
 * daemon owns the slave name, so this reads it without disturbing the shell (the house's read, #22
 * comment 6264958172: a typed reinit landed in an rc's `read -p`).
 */
function inputMode(ptsName: string | undefined): { canonical: boolean; echo: boolean } | undefined {
  if (!ptsName) return undefined;
  try {
    const flag = process.platform === 'linux' ? '-F' : '-f';
    const words = new Set(execFileSync('stty', ['-a', flag, ptsName], { encoding: 'utf8', timeout: 2000 }).split(/[\s;]+/));
    const on = (name: string): boolean | undefined => (words.has(name) ? true : words.has(`-${name}`) ? false : undefined);
    const canonical = on('icanon');
    const echo = on('echo');
    return canonical === undefined || echo === undefined ? undefined : { canonical, echo };
  } catch {
    return undefined;
  }
}

/** Most processes the reader check looks at before it answers "cannot tell". */
const MAX_INSPECTED = 1024;

/**
 * Could a process other than the shell `pid` read the terminal `tty` right now? Only the terminal's
 * foreground process group can read it (anyone else gets SIGTTIN), so: true when that group is not
 * the shell's (a program took the terminal), or when a member of it other than the shell holds the
 * terminal on descriptor 0 or on one above 2 (a reader's stdin, or the /dev/tty a pager or password
 * tool opens beside a piped stdin); false when no member does; undefined when it cannot be told — no
 * process listing, a member whose descriptors cannot be read (another user's, as sudo is, or a
 * non-dumpable process of the same user), or on Linux a descendant whose stat or children cannot be
 * read (/proc mounted with hidepid), which may be a member — since unknown is not "no reader" (the
 * house's read of the 38 commits, #22 comment 6274841346, item 1, and of the 33 commits, comment
 * 6307351617, item 4). Descriptors 1 and 2 do not count: an rc's `sleep 301 &` shares the shell's
 * group, as what bash's rc starts does, with /dev/null as stdin and the terminal as its output, and held
 * the reinit at a real prompt when any child counted (item 2). The cost is a program that reads the
 * terminal only through them, as `more` behind a pipe does: it reads as no reader (PtyHandle's doc).
 * A background job started at a prompt has its own group and is not the foreground; a foreground one
 * is the foreground group, which is not the shell's, and counts.
 *
 * On Linux it reads /proc and starts no process (item 4: a pgrep per tick blocked the event loop for
 * about 50 ms under load): the shell's descendants through `task/<tid>/children`, or every process
 * when the kernel has no children files. A member that left the shell's descendants (an orphan the
 * rc double-forked) is found only by that fallback. Elsewhere one `ps` lists the terminal's
 * processes, and `lsof` reads descriptors only when a member other than the shell exists.
 */
function otherReader(pid: number, tty: string | undefined): boolean | undefined {
  if (!tty) return undefined;
  return process.platform === 'linux' ? otherReaderProc(pid, tty) : otherReaderPs(pid, tty);
}

/**
 * What the Linux reader walk reads of /proc, each call throwing as `fs` does, and whether a pid exists
 * (a zero signal). A spec drives the walk through it with the answers a /proc mounted with hidepid, or
 * a non-dumpable reader, gives (the house's read of the 33 commits, #22 comment 6307351617, items 4
 * and 7): this machine's /proc gives them only to another user's processes.
 */
export interface ProcFs {
  readdir(dir: string): string[];
  readFile(file: string): string;
  readlink(link: string): string;
  exists(pid: number): boolean | undefined;
}

const realProc: ProcFs = {
  readdir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  readlink: (link) => fs.readlinkSync(link),
  exists: pidExists,
};

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** The reader check on Linux (see otherReader), exported for its spec. */
export function otherReaderProc(pid: number, tty: string, proc: ProcFs = realProc): boolean | undefined {
  const shell = procStatOf(pid, proc);
  if (!shell || shell === 'gone') return undefined;
  if (shell.tpgid !== shell.pgrp) return true;
  const members = procGroupMembers(pid, shell.tpgid, proc);
  if (!members) return undefined;
  let unknown = false;
  for (const m of members) {
    const held = holdsForInput(m, tty, proc);
    if (held === true) return true;
    if (held === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

/**
 * `p`'s stat; 'gone' when it has exited (a zombie included); undefined when it cannot be read. ENOENT alone is not "gone":
 * /proc mounted with hidepid=2 hides another user's process that way, and only a zero signal tells the
 * two apart (ESRCH: gone; EPERM: there, and not ours to read).
 */
function procStatOf(p: number, proc: ProcFs): ProcStat | 'gone' | undefined {
  try {
    const st = parseProcStat(proc.readFile(`/proc/${p}/stat`));
    // A zombie has exited: it reads nothing, holds no descriptors, and its children went to a reaper,
    // so its children file is never read (an unreadable one made the answer unknown). Gone, as the
    // lock's listing counts it (an independent read of the fix for #22 comment 6307351617).
    return st?.state === 'Z' ? 'gone' : st;
  } catch (e) {
    return errCode(e) === 'ENOENT' && proc.exists(p) === false ? 'gone' : undefined;
  }
}

/**
 * The members of group `pgrp` other than `pid` among its descendants (every process, without children
 * files). Undefined when it cannot be told: past MAX_INSPECTED, or a process whose stat or children
 * cannot be read, which may be a member (another user's `sudo` under hidepid=1, whose directory is
 * listed and whose files are not) — unknown, not absent, as for a member whose descriptors cannot be
 * read (the house's read of the 33 commits, #22 comment 6307351617, item 4). Without children files a
 * hidepid=2 mount lists no other user's process at all: that walk cannot see them.
 */
function procGroupMembers(pid: number, pgrp: number, proc: ProcFs): number[] | undefined {
  // A process's children; [] when it has exited meanwhile; undefined when they cannot be read.
  const children = (p: number): number[] | undefined => {
    try {
      const out: number[] = [];
      for (const t of proc.readdir(`/proc/${p}/task`)) {
        for (const c of proc.readFile(`/proc/${p}/task/${t}/children`).split(' ')) if (c.trim()) out.push(Number(c));
      }
      return out;
    } catch (e) {
      return errCode(e) === 'ENOENT' && proc.exists(p) === false ? [] : undefined;
    }
  };
  const members: number[] = [];
  let candidates = children(pid);
  if (candidates === undefined) {
    // No children files (a kernel without CONFIG_PROC_CHILDREN): every process is a candidate.
    try {
      candidates = proc.readdir('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      return undefined;
    }
    if (candidates.length > MAX_INSPECTED * 8) return undefined;
    for (const c of candidates) {
      if (c === pid) continue;
      const st = procStatOf(c, proc);
      if (st === undefined) return undefined;
      if (st !== 'gone' && st.pgrp === pgrp) members.push(c);
    }
    return members;
  }
  const seen = new Set<number>();
  while (candidates.length) {
    const c = candidates.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    if (seen.size > MAX_INSPECTED) return undefined;
    const st = procStatOf(c, proc);
    if (st === undefined) return undefined;
    if (st === 'gone') continue;
    if (st.pgrp === pgrp) members.push(c);
    const kids = children(c);
    if (kids === undefined) return undefined;
    candidates.push(...kids);
  }
  return members;
}

/** Does `pid` hold `tty` (or /dev/tty) on descriptor 0 or one above 2? undefined when its descriptors cannot be read. */
function holdsForInput(pid: number, tty: string, proc: ProcFs): boolean | undefined {
  let fds: string[];
  try {
    fds = proc.readdir(`/proc/${pid}/fd`);
  } catch (e) {
    // Gone meanwhile, it reads nothing; but ENOENT alone is not "gone", as for its stat (procStatOf).
    return errCode(e) === 'ENOENT' && proc.exists(pid) === false ? false : undefined;
  }
  for (const n of fds) {
    if (n === '1' || n === '2') continue;
    let target: string;
    try {
      target = proc.readlink(`/proc/${pid}/fd/${n}`);
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue;
      return undefined;
    }
    if (target === tty || target === '/dev/tty') return true;
  }
  return false;
}

function otherReaderPs(pid: number, tty: string): boolean | undefined {
  let rows: Array<{ pid: number; pgid: number; tpgid: number }>;
  try {
    rows = execFileSync('ps', ['-t', tty.replace(/^\/dev\//, ''), '-o', 'pid=,pgid=,tpgid='], { encoding: 'utf8', timeout: 2000 })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([p = NaN, g = NaN, t = NaN]) => ({ pid: p, pgid: g, tpgid: t }));
  } catch {
    return undefined;
  }
  const shell = rows.find((r) => r.pid === pid);
  if (!shell || !(shell.tpgid > 0)) return undefined;
  if (shell.tpgid !== shell.pgid) return true;
  const members = rows.filter((r) => r.pid !== pid && r.pgid === shell.tpgid).map((r) => r.pid);
  if (members.length === 0) return false;
  if (members.length > MAX_INSPECTED) return undefined;
  let out: string;
  try {
    out = execFileSync('lsof', ['-a', '-p', members.join(','), '-d', '0-255', '-F', 'pfn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // lsof exits 1 when it lists nothing for some pid; what it did list is still on stdout.
    const x = e as NodeJS.ErrnoException & { status?: number | null; stdout?: string };
    if (x.status !== 1 || typeof x.stdout !== 'string') return undefined;
    out = x.stdout;
  }
  const listed = new Set<number>();
  let fd = '';
  for (const line of out.split('\n')) {
    const tag = line[0];
    const v = line.slice(1);
    if (tag === 'p') listed.add(Number(v));
    else if (tag === 'f') fd = v;
    else if (tag === 'n' && fd !== '1' && fd !== '2' && /^\d+$/.test(fd) && (v === tty || v === '/dev/tty')) return true;
  }
  // A member lsof listed nothing for is gone (ESRCH: it reads nothing) or not ours to inspect.
  for (const m of members) if (!listed.has(m) && pidExists(m) !== false) return undefined;
  return false;
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
  inputMode(): { canonical: boolean; echo: boolean } | undefined {
    return inputMode((this.p as { ptsName?: string }).ptsName);
  }
  otherReader(): boolean | undefined {
    return otherReader(this.p.pid, (this.p as { ptsName?: string }).ptsName);
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
 * Can `cmd` be executed — as the kernel will resolve it (a relative path against the cwd's real
 * directory, not the symlink's parent) and with its interpreter present? The reason otherwise, in
 * the shape of a spawn error (the house's read of d5873f0: a path the launcher cannot exec got the
 * launcher's exit 127, which a command that ran could also return).
 */
function executable(cmd: string, PATH: string | undefined, cwd: string): { ok: true } | { ok: false; error: string } {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    // the cwd as given
  }
  const check = (file: string): string | undefined => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return 'ENOENT';
    }
    if (!st.isFile()) return 'EACCES';
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      return 'EACCES';
    }
    // A script whose interpreter is missing cannot be executed either (ENOENT from execve).
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(256);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      const line = head.subarray(0, n).toString('utf8').split('\n', 1)[0] ?? '';
      if (line.startsWith('#!')) {
        const interp = line.slice(2).trim().split(/\s+/)[0];
        if (interp && !fs.existsSync(interp)) return `ENOENT (its interpreter ${interp} is missing)`;
      }
    } finally {
      fs.closeSync(fd);
    }
    return undefined;
  };
  if (cmd.includes('/')) {
    const e = check(path.resolve(real, cmd));
    return e ? { ok: false, error: `${e.split(' ')[0]} spawn ${cmd} ${e}` } : { ok: true };
  }
  for (const d of (PATH ?? '/usr/bin:/bin').split(':')) {
    const file = path.resolve(real, d === '' ? '.' : d, cmd);
    const e = check(file);
    if (e === undefined) return { ok: true };
    if (e.startsWith('ENOENT (')) return { ok: false, error: `ENOENT spawn ${cmd} ${e}` };
  }
  return { ok: false, error: `ENOENT spawn ${cmd} ENOENT` };
}

/** A process that never started: its handle reports the spawn error and nothing else (core-15: no exit, no signal). */
function failedSpawn(error: string): ProcessHandle {
  const exitL = new Set<(e: PtyExit) => void>();
  queueMicrotask(() => exitL.forEach((l) => l({ exitCode: null, spawnError: error })));
  return {
    pid: -1,
    pgid: -1,
    onStdout: () => () => undefined,
    onStderr: () => () => undefined,
    onExit: (l) => (exitL.add(l), () => exitL.delete(l)),
    kill: () => undefined,
    groupAlive: () => false,
  };
}

/**
 * Where process Runs find bash (see processLaunch): `/bin/bash`, else the first `bash` on the
 * daemon's PATH (NixOS has one there and none in /bin). Alpine's base has neither: `apk add bash`.
 */
export function findBash(PATH: string | undefined = process.env.PATH, standard = '/bin/bash'): string | undefined {
  const ok = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (ok(standard)) return standard;
  for (const d of (PATH ?? '').split(':')) if (d !== '' && ok(path.resolve(d, 'bash'))) return path.resolve(d, 'bash'); // resolved now, not against each Run's cwd
  return undefined;
}

/** What every refusal for a missing requirement ends with: only the host's operator can act on it (the house's read of the 38 commits, #22 comment 6274841346, item 7). */
const OPERATOR = 'only the host’s operator can fix this, and termd checks once at startup, so report it rather than retrying';

export class NodePtyBackend implements ExecutionBackend {
  readonly kind = 'node-pty';
  /** The bash process Runs launch through; undefined where this host has none (process Runs are then refused, not lost). */
  private readonly bash: string | undefined;
  /** Where children list their descriptors (see closeFdsLine); a spec points it at a missing or static directory. */
  private readonly fdDir: string;
  private support: { ok: true } | { ok: false; reason: string } | undefined;

  constructor(opts: { bash?: string | null; fdDir?: string } = {}) {
    this.bash = opts.bash === undefined ? findBash() : (opts.bash ?? undefined);
    this.fdDir = opts.fdDir ?? '/dev/fd';
  }

  /**
   * One requirement for both shells and process Runs, checked once (the house's review of #11 and
   * read of #22 comment 6269901528): without bash, or without a /dev/fd that lists the process's own
   * descriptors, a child could not close the terminal masters node-pty leaves open to it, so a shell
   * could write into another session's terminal and a process Run could not be isolated. Refused
   * here, with the reason, rather than opened unsafely or ended `lost` one Run at a time. The reason
   * names the host's operator as the one who can act: a caller told to install bash took it as its
   * own step (the house's read of the 38 commits, #22 comment 6274841346, item 7).
   */
  processSupport(): { ok: true } | { ok: false; reason: string } {
    return (this.support ??= this.checkSupport());
  }

  private checkSupport(): { ok: true } | { ok: false; reason: string } {
    const refuse = (what: string) => ({ ok: false as const, reason: `termd cannot open a session or run a process Run on this host: ${what}; ${OPERATOR}` });
    if (!this.bash) return refuse('it has no bash (/bin/bash, or a bash on termd’s PATH), which termd needs to close the other sessions’ terminals a child would inherit — the operator installs bash (Alpine: apk add bash) and restarts termd');
    // The listing must be this process's own: a descriptor opened now is listed, as itself. A listing
    // that holds 0, 1 and 2 whatever is open passed the old check, and the launcher's loop then closed
    // nothing above 2 (the house's read of the 38 commits, #22 comment 6274841346, item 6). The
    // descriptor is the directory itself, so its entry resolves back to the directory only in a real
    // listing; a static one's entry is some other file.
    const fix = 'the operator mounts /dev/fd (on Linux, /proc, which /dev/fd points into) and restarts termd';
    let fd: number;
    try {
      fd = fs.openSync(this.fdDir, 'r');
    } catch {
      return refuse(`it has no ${this.fdDir}, which termd needs to list the descriptors a child would inherit and close them before it runs — ${fix}`);
    }
    try {
      const entry = path.join(this.fdDir, String(fd));
      const listed = fs.readdirSync(this.fdDir).includes(String(fd));
      const opened = fs.fstatSync(fd);
      const shown = listed ? fs.statSync(entry) : undefined;
      if (!shown || shown.dev !== opened.dev || shown.ino !== opened.ino) return refuse(`its ${this.fdDir} does not list the process’s own descriptors (one termd opened is not there as itself), so the ones a child would inherit could not be closed before it runs — ${fix}`);
    } catch {
      return refuse(`its ${this.fdDir} could not be read to list the descriptors a child would inherit — ${fix}`);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  }

  spawnShell(opts: SpawnShellOptions): PtyHandle {
    // Refused here as spawnProcess refuses, so no shell starts without the loop that closes the
    // terminal masters of the sessions opened before this one, which node-pty leaves open to every
    // child (the house's read of d5873f0). The /bin/sh branches this replaces could not run once the
    // Session refused first (the house's read of the 38 commits, #22 comment 6274841346, item 8).
    const support = this.processSupport();
    if (!support.ok) throw err('unsupported', support.reason);
    const bash = this.bash!;
    // The launcher runs under bash (`-p`: no BASH_ENV, no imported functions). A shell without
    // integration has no launcher: the constant text of shellLaunch closes the same descriptors and
    // raises its oom_score_adj (the house's read of 2c35df8, #22), then execs the shell, which keeps
    // its pid.
    const launcher = opts.bootstrap?.launcher;
    const through: [string, string[]] = launcher ? [bash, ['-p', launcher, opts.shell, ...opts.args]] : viaBash(bash, shellLaunch(opts.oomScoreAdj ?? 0), 'termd-shell', [opts.shell, ...opts.args]);
    const p = pty.spawn(through[0], through[1], {
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
    // instead of hanging (core-12). The command starts through processLaunch (above),
    // whose exec keeps the pid, so the group leader is the command itself. A command
    // that cannot be found or run is spawned directly, so the failure is a spawn error,
    // not the launcher's exit 127 (core-15: nothing ran, no signal was observed).
    // A line's text goes to the child on descriptor 3, which the launcher shell keeps, reads
    // whole and closes before running the text (see processLaunch).
    const support = this.processSupport();
    if (!support.ok) throw err('unsupported', support.reason);
    const bash = this.bash!;
    const script = opts.line !== undefined && cmd === '/bin/sh' && args.length === 0 ? `${opts.line}\n` : undefined;
    if (script === undefined) {
      // A command the kernel could not execute is never spawned at all: the handle reports the
      // spawn error (nothing ran), where the launcher's exec would have given an exit 127 that a
      // command which ran could also return (core-15; the house's read of d5873f0).
      const can = executable(cmd, opts.env.PATH, opts.cwd);
      if (!can.ok) return failedSpawn(can.error);
    }
    const launched = script !== undefined ? viaBash(bash, processLaunch(true, opts.oomScoreAdj ?? 0), 'termd-process', []) : viaBash(bash, processLaunch(false, opts.oomScoreAdj ?? 0), 'termd-process', [cmd, ...args]);
    const child = spawnChild(launched[0], launched[1], { cwd: opts.cwd, env: opts.env, stdio: script !== undefined ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: true });
    const outL = new Set<(d: string) => void>();
    const errL = new Set<(d: string) => void>();
    const exitL = new Set<(e: PtyExit) => void>();
    const pgid = child.pid;
    // The leader's frame-free start (Linux), read now that its pid is known, through the reader recovery
    // and the lock use, so run.start records what orphanGroups will compare (comment 6269992150, item 4).
    const start = child.pid !== undefined ? procStart(child.pid) : undefined;
    let fired = false;
    let spawned = false;
    let leaderExited = false;
    const fire = (e: PtyExit) => {
      if (fired) return;
      fired = true;
      exitL.forEach((l) => l(e));
    };
    child.on('spawn', () => (spawned = true));
    // Before anything touches the streams: out of descriptors (EMFILE, ENFILE) Node returns a
    // child with no stdio and emits the error on the next tick (the house's read of d5873f0).
    // A spawn failure is not an exit: nothing ran, and no signal was observed (core-15).
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (spawned) return;
      fire({ exitCode: null, spawnError: e.code ? `${e.code} ${e.message}` : e.message });
    });
    if (script !== undefined) {
      const feed = child.stdio[3] as NodeJS.WritableStream | null | undefined;
      feed?.on('error', () => undefined); // the shell may exit before reading it all
      feed?.end(script);
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    // The journal stores UTF-8 text, not arbitrary binary streams. Node's streaming
    // decoder preserves split characters and replaces invalid sequences with U+FFFD.
    stdout?.setEncoding('utf8');
    stderr?.setEncoding('utf8');
    stdout?.on('data', (d: string) => outL.forEach((l) => l(d)));
    stderr?.on('data', (d: string) => errL.forEach((l) => l(d)));
    // Report the exit once the pipes are drained, so the Run's last output lands
    // before its end; a group member that keeps the pipes open only delays it by
    // DRAIN_MS.
    let open = (stdout ? 1 : 0) + (stderr ? 1 : 0);
    let pendingExit: PtyExit | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const settle = () => {
      if (pendingExit && open === 0) {
        if (drainTimer) clearTimeout(drainTimer);
        fire(pendingExit);
      }
    };
    stdout?.on('end', () => (open--, settle()));
    stderr?.on('end', () => (open--, settle()));
    child.on('exit', (code, signal) => {
      leaderExited = true;
      pendingExit = signal ? { exitCode: null, signal } : { exitCode: code };
      drainTimer = setTimeout(() => fire(pendingExit!), DRAIN_MS);
      drainTimer.unref();
      settle();
    });
    // Once the Run's group has been seen empty after its leader exited, or its number seen held by a
    // stranger, nothing is signalled again (a latch: the number could go to a new group of a
    // stranger whose own leader exits — the house's read of d5873f0).
    let gone = false;
    const ours = (): boolean => {
      if (pgid === undefined || gone) return false;
      if (!leaderExited) return true;
      if (!groupAlive(pgid) || !groupStillOurs(pgid)) {
        gone = true;
        return false;
      }
      return true;
    };
    return {
      get pid() {
        return child.pid ?? -1;
      },
      get pgid() {
        return pgid ?? -1;
      },
      ...(start && { startTicks: start.startTicks, bootId: start.bootId }),
      onStdout: (l) => (outL.add(l), () => outL.delete(l)),
      onStderr: (l) => (errL.add(l), () => errL.delete(l)),
      onExit: (l) => (exitL.add(l), () => exitL.delete(l)),
      kill(signal) {
        // The group, not the leader: members survive a leader that exited (tg-12). Once the
        // leader has exited, only a group that is still the Run's is signalled (see groupStillOurs).
        if (!ours()) return;
        try {
          process.kill(-pgid!, signal);
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
      groupAlive: () => ours() && groupAlive(pgid!),
    };
  }
}
