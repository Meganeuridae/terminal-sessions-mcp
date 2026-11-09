import { execFile, execFileSync, type ExecFileException } from 'node:child_process';
import * as fs from 'node:fs';

const LINUX = process.platform === 'linux';
/**
 * The numbers of read and readv, whose only wait is for their input, and of splice: x86-64's table, and
 * the generic table arm64, riscv64 and loong64 share. On any other architecture no read is seen, nor
 * is a 32-bit program's, whose calls are numbered from another table.
 */
const SYSCALLS: Partial<Record<string, { reads: ReadonlySet<number>; splice: number }>> = {
  x64: { reads: new Set([0, 19]), splice: 275 },
  arm64: { reads: new Set([63, 65]), splice: 76 },
  riscv64: { reads: new Set([63, 65]), splice: 76 },
  loong64: { reads: new Set([63, 65]), splice: 76 },
};
const NUMBERS = LINUX ? SYSCALLS[process.arch] : undefined;
/** Whether the kernel here shows a process blocked reading the terminal. */
export const READS_VISIBLE = NUMBERS !== undefined;
/**
 * The wait channel of a terminal read with nothing to read: n_tty_read's. splice moves its input into
 * a pipe, and waits either for input or for room in the pipe; only the wait channel tells them apart.
 * uutils' cat, which Ubuntu 26.04 ships, waits in splice.
 */
const TERMINAL_READ_WAIT = 'wait_woken';
/** A kernel built without CONFIG_PROC_CHILDREN has no children file; descendants then come from every process's parent. */
const CHILDREN_FILES = LINUX && fs.existsSync(`/proc/self/task/${process.pid}/children`);
const MAX_DESCENDANTS = 1024;
/** How long a spawned `ps` or `stty` may take where its caller is synchronous: a hung one stalls the daemon's loop this long. */
const SPAWN_TIMEOUT_MS = 500;

/**
 * A listing for `close`, which awaits its `ps`: the absolute time, on `performance.now()`'s clock, by which `ps` must answer, and
 * what to call with the reason when the listing can't be made.
 */
export interface Listing {
  deadline: number;
  failed?: (why: string) => void;
}

/** What a spawned `ps` gave, the same from either spawner. `status` is null when no exit status came: a signal ended it, its time ran out, or it never started. */
interface Spawned {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  error?: string;
}

function psSync(args: string[], timeoutMs: number): Spawned {
  try {
    return { status: 0, stdout: execFileSync('ps', args, { encoding: 'utf8', timeout: timeoutMs }), timedOut: false };
  } catch (e) {
    const x = e as { code?: string; status?: number | null; stdout?: unknown; message?: string };
    return { status: typeof x.status === 'number' ? x.status : null, stdout: typeof x.stdout === 'string' ? x.stdout : '', timedOut: x.code === 'ETIMEDOUT', error: (x.message ?? String(e)).split('\n')[0]! };
  }
}

function psAsync(args: string[], deadline: number): Promise<Spawned> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (s: Spawned): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(s);
    };
    const child = execFile('ps', args, { encoding: 'utf8' }, (e, stdout) => {
      if (!e) return settle({ status: 0, stdout, timedOut: false });
      const x = e as ExecFileException;
      settle({ status: typeof x.code === 'number' ? x.code : null, stdout: typeof stdout === 'string' ? stdout : '', timedOut: false, error: x.message.split('\n')[0]! });
    });
    // execFile's own timeout only signals the child, and its callback waits for the child to exit, which a child that outlives the
    // signal never does.
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ status: null, stdout: '', timedOut: true });
    }, Math.max(0, deadline - performance.now()));
  });
}

/** `ps`, given what's left of the listing's deadline. Nothing is started once nothing is left. */
async function psWithin(args: string[], l: Listing): Promise<Spawned & { timeoutMs: number }> {
  const timeoutMs = Math.floor(l.deadline - performance.now());
  if (timeoutMs <= 0) return { status: null, stdout: '', timedOut: true, timeoutMs: 0 };
  return { ...(await psAsync(args, l.deadline)), timeoutMs };
}

const failure = (s: Spawned, timeoutMs: number): string =>
  s.timedOut
    ? timeoutMs > 0
      ? `ps took longer than ${timeoutMs} ms`
      : 'no time was left before the deadline'
    : s.status !== null
      ? `ps exited with status ${s.status}`
      : (s.error ?? 'ps failed');

export interface Groups {
  pgrp: number;
  tpgid: number;
}

/** A process's group, its terminal's foreground group (absent without a terminal), and its command line: one `ps` on macOS. */
export function info(pid: number): { pgrp: number; tpgid?: number; argv?: string } | undefined {
  try {
    if (LINUX) {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const pgrp = Number(f[2]);
      const tpgid = Number(f[5]);
      if (!(pgrp > 0)) return undefined;
      const a = argv(pid);
      return { pgrp, ...(tpgid > 0 && { tpgid }), ...(a !== undefined && { argv: a }) };
    }
    const m = /^\s*(\d+)\s+(-?\d+)\s+(.*)$/s.exec(execFileSync('ps', ['-o', 'pgid=,tpgid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }).trim());
    if (!m || !(Number(m[1]) > 0)) return undefined;
    return { pgrp: Number(m[1]), ...(Number(m[2]) > 0 && { tpgid: Number(m[2]) }), ...(m[3] && { argv: m[3] }) };
  } catch {
    return undefined;
  }
}

/** The process's own group and its terminal's foreground group; undefined without a terminal. */
export function groups(pid: number): Groups | undefined {
  const i = info(pid);
  return i?.tpgid !== undefined ? { pgrp: i.pgrp, tpgid: i.tpgid } : undefined;
}

export function argv(pid: number): string | undefined {
  try {
    if (LINUX) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || undefined;
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Linux: a process's stat fields after its name, from its state on; undefined once it's gone. */
function statOf(pid: number): string[] | undefined {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

/** Linux: a process's group from its stat, with a terminal or without one. */
function pgrpOf(pid: number): number | undefined {
  const g = Number(statOf(pid)?.[2]);
  return g > 0 ? g : undefined;
}

type Proc = { pid: number; pgrp: number };

/**
 * Every process whose controlling terminal is `pts`, which the session leader `shell` holds, with its group:
 * the shell, its jobs, disowned ones and those whose parent exited, but not a process that left with
 * `setsid`. Undefined when they can't be listed. Read it while the shell lives: once a session's leader
 * exits, the kernel takes the terminal from every process in the session.
 */
export async function onTerminal(shell: number, pts: string, l: Listing): Promise<Proc[] | undefined> {
  const fail = (why: string): undefined => void l.failed?.(`the processes on the terminal: ${why}`);
  try {
    if (LINUX) {
      const tty = statOf(shell)?.[4];
      if (tty === undefined || tty === '0') return fail("the shell's terminal couldn't be read");
      const out: Proc[] = [];
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        const f = statOf(Number(d));
        if (f?.[4] === tty && Number(f[2]) > 0) out.push({ pid: Number(d), pgrp: Number(f[2]) });
      }
      return out;
    }
    const s = await psWithin(['-t', pts.slice(pts.lastIndexOf('/') + 1), '-o', 'pid=,pgid='], l);
    if (s.status !== 0) return fail(failure(s, s.timeoutMs));
    const out: Proc[] = [];
    for (const line of s.stdout.trim().split('\n')) {
      const [p, g] = line.trim().split(/\s+/).map(Number);
      if (p! > 0 && g! > 0) out.push({ pid: p!, pgrp: g! });
    }
    return out.some((d) => d.pid === shell) ? out : fail("the shell itself wasn't among them");
  } catch (e) {
    return fail((e as Error).message.split('\n')[0]!);
  }
}

type State = { pgrp: number; state: string };

const statesArgs = (listed: Proc[]): string[] => ['-o', 'pid=,pgid=,stat=', '-p', listed.map((d) => d.pid).join(',')];

/** Linux: each of `listed` still in the group it was listed in, with its state. */
function statesHere(listed: Proc[]): State[] {
  const out: State[] = [];
  for (const d of listed) {
    const f = statOf(d.pid);
    if (f?.[0] && Number(f[2]) === d.pgrp) out.push({ pgrp: d.pgrp, state: f[0] });
  }
  return out;
}

/** The same from `ps`'s answer; undefined, with the reason, when it gave none. */
function statesFrom(s: Spawned, timeoutMs: number, listed: Proc[], fail: (why: string) => undefined): State[] | undefined {
  // ps exits 1 when every pid it was given is gone. With some gone and some left, it lists those left and exits 0.
  if (s.status !== 0 && s.status !== 1) return fail(failure(s, timeoutMs));
  const group = new Map(listed.map((d) => [d.pid, d.pgrp]));
  const out: State[] = [];
  for (const line of s.stdout.trim().split('\n')) {
    const [p, g, state] = line.trim().split(/\s+/);
    if (state && group.get(Number(p)) === Number(g)) out.push({ pgrp: Number(g), state });
  }
  return out;
}

/** Each of `listed` still in the group it was listed in, with its state; undefined when that can't be read. */
function states(listed: Proc[]): State[] | undefined {
  if (!listed.length) return [];
  try {
    return LINUX ? statesHere(listed) : statesFrom(psSync(statesArgs(listed), SPAWN_TIMEOUT_MS), SPAWN_TIMEOUT_MS, listed, () => undefined);
  } catch {
    return undefined;
  }
}

/**
 * The groups among `listed` that still hold one of its processes, alive and in the group it was listed in;
 * undefined when that can't be read. An exited process its parent hasn't reaped counts as gone: macOS
 * refuses a signal to a group of only those with EPERM.
 */
export async function held(listed: Proc[], l: Listing): Promise<Set<number> | undefined> {
  const fail = (why: string): undefined => void l.failed?.(`which listed groups still hold a process: ${why}`);
  if (!listed.length) return new Set();
  try {
    let s: State[] | undefined;
    if (LINUX) s = statesHere(listed);
    else {
      const p = await psWithin(statesArgs(listed), l);
      s = statesFrom(p, p.timeoutMs, listed, fail);
    }
    return s && new Set(s.filter((x) => !x.state.startsWith('Z')).map((x) => x.pgrp));
  } catch (e) {
    return fail((e as Error).message.split('\n')[0]!);
  }
}

/** Whether one of `listed` is stopped, as a suspend signal leaves a job; undefined when that can't be read. */
export function stopped(listed: Proc[]): boolean | undefined {
  return states(listed)?.some((x) => /^[Tt]/.test(x.state));
}

const DESCENDANTS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid='];

/** Linux: `pid`'s descendants from the children files, or from every process's parent where the kernel has none. */
function descendantsHere(pid: number, all: boolean, fail: (why: string) => undefined): Proc[] | undefined {
  const exited = (e: unknown): boolean => ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '');
  if (!CHILDREN_FILES) {
    const rows: number[][] = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
        rows.push([Number(d), Number(f[1]), Number(f[2])]);
      } catch {}
    }
    return descendantsFrom(pid, all, rows, fail);
  }
  const out: Proc[] = [];
  const todo = [pid];
  while (todo.length) {
    const p = todo.pop()!;
    let tasks: string[];
    try {
      tasks = fs.readdirSync(`/proc/${p}/task`);
    } catch (e) {
      if (p !== pid && exited(e)) continue;
      return fail(`/proc/${p}/task couldn't be read: ${(e as NodeJS.ErrnoException).code}`);
    }
    for (const t of tasks) {
      let kids: number[];
      try {
        kids = fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').split(' ').filter((x) => x.trim()).map(Number);
      } catch (e) {
        if ((p !== pid || t !== String(pid)) && exited(e)) continue;
        return fail(`/proc/${p}/task/${t}/children couldn't be read: ${(e as NodeJS.ErrnoException).code}`);
      }
      for (const k of kids) {
        const g = pgrpOf(k);
        if (g) out.push({ pid: k, pgrp: g });
        todo.push(k);
        if (!all && out.length > MAX_DESCENDANTS) return fail(`more than ${MAX_DESCENDANTS}`);
      }
    }
  }
  return out;
}

/** `pid`'s descendants from rows of pid, parent and group, as `ps -A` gives them. */
function descendantsFrom(pid: number, all: boolean, rows: number[][], fail: (why: string) => undefined): Proc[] | undefined {
  const kids = new Map<number, Proc[]>();
  let listed = false;
  for (const [p, pp, g] of rows) {
    if (p === pid) listed = true;
    if (p! > 0 && g! > 0) (kids.get(pp!) ?? kids.set(pp!, []).get(pp!)!).push({ pid: p!, pgrp: g! });
  }
  if (!listed) return fail("the shell itself wasn't listed");
  const out: Proc[] = [];
  const todo = [pid];
  while (todo.length)
    for (const k of kids.get(todo.pop()!) ?? []) {
      out.push(k);
      todo.push(k.pid);
      if (!all && out.length > MAX_DESCENDANTS) return fail(`more than ${MAX_DESCENDANTS}`);
    }
  return out;
}

const rowsOf = (text: string): number[][] => text.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));

/**
 * Every descendant of `pid` with its group, a descendant that left the terminal (`setsid`) included;
 * undefined when they can't be listed, or, unless `all`, past 1024 of them. A descendant or thread
 * gone while they're listed is left out; any other failure to read one leaves the list unknown.
 */
export function descendants(pid: number, all = false): Proc[] | undefined {
  const fail = (): undefined => undefined;
  try {
    if (LINUX) return descendantsHere(pid, all, fail);
    const s = psSync(DESCENDANTS_ARGS, SPAWN_TIMEOUT_MS);
    return s.status === 0 ? descendantsFrom(pid, all, rowsOf(s.stdout), fail) : undefined;
  } catch {
    return undefined;
  }
}

/** Every descendant of `pid`, as `descendants` with `all` gives them, for `close`, which awaits `ps`. */
export async function allDescendants(pid: number, l: Listing): Promise<Proc[] | undefined> {
  const fail = (why: string): undefined => void l.failed?.(`the shell's descendants: ${why}`);
  try {
    if (LINUX) return descendantsHere(pid, true, fail);
    const s = await psWithin(DESCENDANTS_ARGS, l);
    return s.status === 0 ? descendantsFrom(pid, true, rowsOf(s.stdout), fail) : fail(failure(s, s.timeoutMs));
  } catch (e) {
    return fail((e as Error).message.split('\n')[0]!);
  }
}

/**
 * Linux: is `pid` blocked reading the terminal `pts`, in any of its threads? undefined where the kernel
 * won't say for any thread and none is seen reading: not Linux, an architecture without a known
 * syscall table, or no ptrace access to the process (Yama's ptrace_scope, another user's process).
 */
export function readsTerminal(pid: number, pts: string): boolean | undefined {
  if (!NUMBERS) return undefined;
  let tasks: string[];
  try {
    tasks = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return undefined;
  }
  let unknown = false;
  for (const t of tasks) {
    const r = threadReads(pid, `/proc/${pid}/task/${t}`, pts);
    if (r) return true;
    if (r === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

function threadReads(pid: number, task: string, pts: string): boolean | undefined {
  let sc: string[];
  try {
    sc = fs.readFileSync(`${task}/syscall`, 'utf8').trim().split(' ');
  } catch {
    return undefined;
  }
  if (sc[0] === 'running') return false;
  const call = Number(sc[0]);
  if (!NUMBERS!.reads.has(call) && call !== NUMBERS!.splice) return false;
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/${Number.parseInt(sc[1] ?? '', 16)}`);
    if (link !== pts && link !== '/dev/tty') return false;
    if (call !== NUMBERS!.splice) return true;
    const wait = fs.readFileSync(`${task}/wchan`, 'utf8').trim();
    return wait === '0' || wait === '' ? undefined : wait === TERMINAL_READ_WAIT;
  } catch {
    return undefined;
  }
}

/** The terminal's line discipline: canonical input and echo. */
export function modes(pts: string): { canonical: boolean; echo: boolean } | undefined {
  try {
    const words = new Set(execFileSync('stty', ['-a', LINUX ? '-F' : '-f', pts], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }).split(/[\s;]+/));
    const on = (w: string) => (words.has(w) ? true : words.has(`-${w}`) ? false : undefined);
    const canonical = on('icanon');
    const echo = on('echo');
    return canonical === undefined || echo === undefined ? undefined : { canonical, echo };
  } catch {
    return undefined;
  }
}

/** Sends `signal` to process group `pgid`. Returns nothing once it's delivered, else the error's code, such as `EPERM`. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): string | undefined {
  if (!(pgid > 1)) return 'EINVAL';
  try {
    process.kill(-pgid, signal);
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? 'unknown';
  }
}
