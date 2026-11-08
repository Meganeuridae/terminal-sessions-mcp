import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const LINUX = process.platform === 'linux';
/**
 * The calls a process blocks in to read a descriptor, by number, each with the field of
 * /proc/PID/syscall that names the descriptor: read, readv, sendfile (its input) and splice (its
 * input). uutils' cat, which Ubuntu 26.04 ships, waits in splice.
 */
const READS: ReadonlyMap<number, number> =
  process.arch === 'arm64'
    ? new Map([[63, 1], [65, 1], [71, 2], [76, 1]])
    : new Map([[0, 1], [19, 1], [40, 2], [275, 1]]);
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

/** Every descendant of `pid` with its group; undefined when they can't be listed. */
export function descendants(pid: number): Array<{ pid: number; pgrp: number }> | undefined {
  try {
    if (LINUX) {
      const out: Array<{ pid: number; pgrp: number }> = [];
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
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map<number, Array<{ pid: number; pgrp: number }>>();
    for (const [p, pp, g] of rows) if (p && pp !== undefined && g) (kids.get(pp) ?? kids.set(pp, []).get(pp)!).push({ pid: p, pgrp: g });
    const out: Array<{ pid: number; pgrp: number }> = [];
    const todo = [pid];
    while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) out.push(k), todo.push(k.pid);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Linux: is `pid` blocked reading the terminal `pts`? undefined where the kernel won't say:
 * not Linux, or no ptrace access to the process (Yama's ptrace_scope, another user's process).
 */
export function readsTerminal(pid: number, pts: string): boolean | undefined {
  if (!LINUX) return undefined;
  let sc: string[];
  try {
    sc = fs.readFileSync(`/proc/${pid}/syscall`, 'utf8').trim().split(' ');
  } catch {
    return undefined;
  }
  if (sc[0] === 'running') return false;
  const field = READS.get(Number(sc[0]));
  if (field === undefined) return false;
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/${Number.parseInt(sc[field] ?? '', 16)}`);
    return link === pts || link === '/dev/tty';
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

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
