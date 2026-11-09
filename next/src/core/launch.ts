import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/**
 * The line that closes every descriptor above the ones in `keep` (a `case` pattern such as
 * `0|1|2`) before a child runs. node-pty opens each session's terminal master without
 * close-on-exec, and Node passes a child every descriptor that isn't, so a child held the master of
 * every session open when it started: it could have written into those terminals, and it kept a
 * shell alive after the daemon died, since the terminal never hung up. The descriptors are
 * listed through /dev/fd (Linux links it to /proc/self/fd); the glob is expanded, and its directory
 * closed, before the loop runs. Only bash can name an arbitrary descriptor in `exec N>&-` (dash
 * reads `exec 12>&-` as a command named 12), so the loop runs only under bash, a /bin/sh that is bash
 * included (macOS's: bash sets BASH_VERSION when run as sh), and the same text is a no-op under one
 * that isn't, such as dash.
 */
export function closeFdsLine(keep: string): string {
  return `if [ -n "\${BASH_VERSION-}" ] && [ -d /dev/fd ]; then for __tsm_fd in /dev/fd/*; do case "\${__tsm_fd##*/}" in ${keep}) ;; *) eval "exec \${__tsm_fd##*/}>&-" 2>/dev/null || :;; esac; done; unset __tsm_fd; fi`;
}

/**
 * The line that raises a session process's oom_score_adj on Linux (no /proc elsewhere): the
 * kernel then takes it before the daemon, whose death would lose every session. The preference
 * is machine-wide, not relative to the daemon alone: a raised build is taken before other
 * users' processes too. So the amount is the daemon's `--session-oom-score-adj` (default 200),
 * and 0 writes nothing.
 */
export function oomLine(oomScoreAdj: number): string[] {
  const n = Math.max(0, Math.min(1000, Math.floor(oomScoreAdj)));
  return n > 0 ? [`if [ -w /proc/self/oom_score_adj ]; then echo ${n} > /proc/self/oom_score_adj 2>/dev/null || :; fi`] : [];
}

/**
 * What a shell without an integration launcher starts through, where bash is present: the
 * inherited descriptors closed and the oom preference raised, as the integration's launcher does,
 * then `exec` of the shell and its arguments (it keeps the pid).
 */
export function shellLaunch(oomScoreAdj: number): string {
  return [closeFdsLine('0|1|2'), ...oomLine(oomScoreAdj), 'exec "$@"'].join('\n');
}

export function loginShell(candidates: ReadonlyArray<string | null | undefined>): string {
  for (const c of candidates) {
    if (c && path.isAbsolute(c) && !REFUSING.has(path.basename(c)) && executableFile(c)) return c;
  }
  return '/bin/sh';
}

const REFUSING = new Set(['nologin', 'false']);

function executableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The argv that runs `text` under bash with no startup files and in privileged mode, named `name`, with `args` as its positional parameters. */
export function viaBash(bash: string, text: string, name: string, args: readonly string[]): [string, string[]] {
  return [bash, ['--noprofile', '--norc', '-p', '-c', text, name, ...args]];
}

export const shellQuote = (s: string): string =>
  /^[A-Za-z0-9_./:,+@%-]+$/.test(s) ? s : s === '' ? "''" : s.split(/(['\\])/).map((p) => (p === "'" || p === '\\' ? `\\${p}` : p ? `'${p}'` : '')).join('');

/**
 * On macOS, node-pty starts every shell through the spawn-helper beside the native module it loaded, which `require`
 * keeps in its cache. Some of node-pty's releases ship that helper without its execute bit.
 */
export function unrunnableHelper(ptyDir: string, platform: string = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  const addon = Object.keys(createRequire(import.meta.url).cache).find((f) => f.startsWith(ptyDir + path.sep) && path.basename(f) === 'pty.node');
  if (addon === undefined) return undefined;
  const helper = path.join(path.dirname(addon), 'spawn-helper');
  try {
    fs.accessSync(helper, fs.constants.X_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EACCES' && fs.existsSync(helper)) return helper;
  }
  return undefined;
}
