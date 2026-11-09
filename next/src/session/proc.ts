import { execFileSync } from 'node:child_process';
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
/** How long a spawned `ps` or `stty` may take: a hung one stalls the daemon's loop this long. */
const SPAWN_TIMEOUT_MS = 500;

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

/** Linux: a process's group from its stat, with a terminal or without one. */
function pgrpOf(pid: number): number | undefined {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const g = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[2]);
    return g > 0 ? g : undefined;
  } catch {
    return undefined;
  }
}

type Proc = { pid: number; pgrp: number };

/**
 * Every descendant of `pid` with its group, a descendant that left the terminal (`setsid`) included;
 * undefined when they can't be listed, or, unless `all`, past 1024 of them. A descendant or thread
 * gone while they're listed is left out; any other failure to read one leaves the list unknown.
 */
export function descendants(pid: number, all = false): Proc[] | undefined {
  const exited = (e: unknown): boolean => ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '');
  try {
    if (CHILDREN_FILES) {
      const out: Proc[] = [];
      const todo = [pid];
      while (todo.length) {
        const p = todo.pop()!;
        let tasks: string[];
        try {
          tasks = fs.readdirSync(`/proc/${p}/task`);
        } catch (e) {
          if (p !== pid && exited(e)) continue;
          return undefined;
        }
        for (const t of tasks) {
          let kids: number[];
          try {
            kids = fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').split(' ').filter((x) => x.trim()).map(Number);
          } catch (e) {
            if ((p !== pid || t !== String(pid)) && exited(e)) continue;
            return undefined;
          }
          for (const k of kids) {
            const g = pgrpOf(k);
            if (g) out.push({ pid: k, pgrp: g });
            todo.push(k);
            if (!all && out.length > MAX_DESCENDANTS) return undefined;
          }
        }
      }
      return out;
    }
    const kids = new Map<number, Proc[]>();
    let listed = false;
    const add = (p: number, pp: number, g: number): void => {
      if (p === pid) listed = true;
      if (p > 0 && g > 0) (kids.get(pp) ?? kids.set(pp, []).get(pp)!).push({ pid: p, pgrp: g });
    };
    if (LINUX) {
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
          add(Number(d), Number(f[1]), Number(f[2]));
        } catch {}
      }
    } else for (const [p, pp, g] of execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))) add(p!, pp!, g!);
    if (!listed) return undefined;
    const out: Proc[] = [];
    const todo = [pid];
    while (todo.length)
      for (const k of kids.get(todo.pop()!) ?? []) {
        out.push(k);
        todo.push(k.pid);
        if (!all && out.length > MAX_DESCENDANTS) return undefined;
      }
    return out;
  } catch {
    return undefined;
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
