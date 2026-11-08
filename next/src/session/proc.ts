import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const LINUX = process.platform === 'linux';
/**
 * The numbers of read and readv, whose only wait is for their input, and of splice: x86-64's table, and
 * the generic table arm64, riscv64 and loong64 share. On any other architecture no read is seen.
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

export interface Groups {
  pgrp: number;
  tpgid: number;
}

/** The process's own group and its terminal's foreground group. */
export function groups(pid: number): Groups | undefined {
  try {
    if (LINUX) {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const g = { pgrp: Number(f[2]), tpgid: Number(f[5]) };
      return g.pgrp > 0 && g.tpgid > 0 ? g : undefined;
    }
    const [pgrp, tpgid] = execFileSync('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/).map(Number);
    return pgrp! > 0 && tpgid! > 0 ? { pgrp: pgrp!, tpgid: tpgid! } : undefined;
  } catch {
    return undefined;
  }
}

export function argv(pid: number): string | undefined {
  try {
    if (LINUX) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || undefined;
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

type Proc = { pid: number; pgrp: number };

/** Every descendant of `pid` with its group; undefined when they can't be listed. */
export function descendants(pid: number): Proc[] | undefined {
  try {
    if (CHILDREN_FILES) {
      const out: Proc[] = [];
      const todo = [pid];
      while (todo.length) {
        const p = todo.pop()!;
        let kids: number[];
        try {
          kids = fs.readdirSync(`/proc/${p}/task`).flatMap((t) => fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').split(' ').filter((x) => x.trim()).map(Number));
        } catch {
          continue;
        }
        for (const k of kids) {
          const g = groups(k);
          if (g) out.push({ pid: k, pgrp: g.pgrp });
          todo.push(k);
          if (out.length > MAX_DESCENDANTS) return undefined;
        }
      }
      return out;
    }
    const kids = new Map<number, Proc[]>();
    const add = (p: number, pp: number, g: number): void => {
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
    } else for (const [p, pp, g] of execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))) add(p!, pp!, g!);
    const out: Proc[] = [];
    const todo = [pid];
    while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) out.push(k), todo.push(k.pid);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Linux: is `pid` blocked reading the terminal `pts`? undefined where the kernel won't say: not
 * Linux, an architecture without a known syscall table, or no ptrace access to the process (Yama's
 * ptrace_scope, another user's process).
 */
export function readsTerminal(pid: number, pts: string): boolean | undefined {
  if (!NUMBERS) return undefined;
  let sc: string[];
  try {
    sc = fs.readFileSync(`/proc/${pid}/syscall`, 'utf8').trim().split(' ');
  } catch {
    return undefined;
  }
  if (sc[0] === 'running') return false;
  const call = Number(sc[0]);
  if (!NUMBERS.reads.has(call) && call !== NUMBERS.splice) return false;
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/${Number.parseInt(sc[1] ?? '', 16)}`);
    if (link !== pts && link !== '/dev/tty') return false;
    if (call !== NUMBERS.splice) return true;
    const wait = fs.readFileSync(`/proc/${pid}/wchan`, 'utf8').trim();
    return wait === '0' || wait === '' ? undefined : wait === TERMINAL_READ_WAIT;
  } catch {
    return undefined;
  }
}

/** The terminal's line discipline: canonical input and echo. */
export function modes(pts: string): { canonical: boolean; echo: boolean } | undefined {
  try {
    const words = new Set(execFileSync('stty', ['-a', LINUX ? '-F' : '-f', pts], { encoding: 'utf8', timeout: 2000 }).split(/[\s;]+/));
    const on = (w: string) => (words.has(w) ? true : words.has(`-${w}`) ? false : undefined);
    const canonical = on('icanon');
    const echo = on('echo');
    return canonical === undefined || echo === undefined ? undefined : { canonical, echo };
  } catch {
    return undefined;
  }
}

export function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Sends `signal` to process group `pgid`; false when nothing received it. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!(pgid > 1)) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}
