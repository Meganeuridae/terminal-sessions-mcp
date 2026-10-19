/**
 * Shell integration (§7): injected without replacing the user's rc files.
 * bash: a `--rcfile` wrapper (bash.ts). zsh: a ZDOTDIR shim (zsh.ts). fish: a
 * vendor_conf.d snippet found through XDG_DATA_DIRS (fish.ts). Anything else: no
 * integration; the marker strategy serves daemon-issued Runs (G5).
 *
 * The private launcher writes the initial credential for its own PID, then execs
 * the shell. No user/system startup child inherits a credential in its environment.
 * Session receives the key separately and trusts only marks that carry it.
 *
 * The directory holds all three shells' files whatever the session's shell is: an
 * `exec zsh` in a bash session (or any other pair) re-integrates the new shell from
 * the same directory with the same key (ss-4).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BASH_RC } from './bash.js';
import { FISH_CONF } from './fish.js';
import { ZSH_ZLOGIN, ZSH_ZPROFILE, ZSH_ZSHENV, ZSH_ZSHRC } from './zsh.js';

export type IntegrationKind = 'bash' | 'zsh' | 'fish' | 'none';

export interface IntegrationSetup {
  kind: IntegrationKind;
  /** Arguments to pass to the shell binary. */
  args: string[];
  /** Environment additions, with no completion credentials. */
  env: Record<string, string>;
  /** Private launch script, interpreted by /bin/sh before the configured shell. */
  launcher?: string;
  key?: string;
  /** Remove any files written for this setup. */
  cleanup(): void;
}

export interface PrepareOptions {
  /** Directory to write generated files into (created). */
  dir?: string;
  /** Skip the user's rc files (tests). */
  noUserRc?: boolean;
  userEnv?: NodeJS.ProcessEnv;
  /** Linux: the shell's oom_score_adj (0 or unset: unchanged); see the daemon's --session-oom-score-adj. */
  oomScoreAdj?: number;
}

let counter = 0;

/** Write the integration files for `shellPath` and return how to spawn it. */
export function prepareIntegration(shellPath: string, opts: PrepareOptions = {}): IntegrationSetup {
  const base = path.basename(shellPath);
  const kind = base === 'bash' || base === 'zsh' || base === 'fish' ? base : 'none';
  if (kind === 'none') return { kind, args: [], env: {}, cleanup: () => undefined };
  const userEnv = opts.userEnv ?? process.env;
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `tsm-integration-${process.pid}-${++counter}-`));
  fs.mkdirSync(path.join(dir, 'fish', 'vendor_conf.d'), { recursive: true, mode: 0o700 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const key = randomBytes(16).toString('hex');
  const env: Record<string, string> = {};
  const launcher = path.join(dir, 'launch.sh');
  // No shell config, external command or exported variable sees the key. exec keeps
  // the PID, and each shell consumes only the private file for its own PID. The owner-only
  // mask covers the key file alone and the shell starts with the mask it inherited: a mask
  // left at 077 made every file a session created owner-only, which breaks shared projects
  // and served build output (an outside review's finding). On Linux the shell, and so
  // everything a session runs, can be made a likelier victim of the kernel's out-of-memory
  // killer than the daemon (a build's peak then costs that Run, not every session); raising
  // one's own oom_score_adj needs no privilege, and /proc is Linux's. The amount is the
  // daemon's setting: the preference is machine-wide, so a shared host may want none.
  const oom = opts.oomScoreAdj !== undefined && opts.oomScoreAdj > 0 ? `if [ -w /proc/self/oom_score_adj ]; then echo ${Math.min(1000, Math.floor(opts.oomScoreAdj))} > /proc/self/oom_score_adj 2>/dev/null || :; fi\n` : '';
  // The shell inherits every descriptor the daemon holds without close-on-exec — node-pty's
  // terminal masters of the sessions opened before it (the house's read of d5873f0, #22): a command
  // in it could write into another session's terminal, which also never hangs up while it is held.
  // Under bash (the backend runs the launcher with bash where there is one) the loop closes them;
  // dash cannot name a two-digit descriptor, so without bash the loop is skipped.
  const closeFds = `if [ -n "\${BASH_VERSION-}" ] && [ -d /dev/fd ]; then for __tsm_fd in /dev/fd/*; do case "\${__tsm_fd##*/}" in 0|1|2) ;; *) eval "exec \${__tsm_fd##*/}>&-" 2>/dev/null || :;; esac; done; unset __tsm_fd; fi\n`;
  fs.writeFileSync(launcher,
    closeFds +
    `__tsm_umask=$(umask); umask 077\ncommand printf '%s\\n' '${key}' > "\${0%/*}/key-$$" || exit 1\numask "$__tsm_umask"; unset __tsm_umask\n` +
    oom +
    `exec "$@"\n`, { mode: 0o600 });
  if (opts.noUserRc) env.TSM_NO_USER_RC = '1';
  const files = { 'bash-rc.sh': BASH_RC, '.zshenv': ZSH_ZSHENV, '.zprofile': ZSH_ZPROFILE, '.zshrc': ZSH_ZSHRC, '.zlogin': ZSH_ZLOGIN, 'fish/vendor_conf.d/tsm-integration.fish': FISH_CONF };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  // fish has no "skip config.fish but keep vendor snippets" flag: its config dir points at
  // an empty one for startup (the snippet restores the variable).
  const empty = path.join(dir, 'no-user-config');
  if (opts.noUserRc) fs.mkdirSync(empty, { recursive: true, mode: 0o700 });
  if (kind === 'bash') {
    env.BASH_SILENCE_DEPRECATION_WARNING = '1'; // macOS's /bin/bash banner is not command output
    return { kind, args: ['--rcfile', path.join(dir, 'bash-rc.sh')], env, key, launcher, cleanup };
  }
  if (kind === 'zsh') {
    env.ZDOTDIR = dir;
    // Only a ZDOTDIR the user actually had is carried; otherwise zsh's default ($HOME).
    if (userEnv.ZDOTDIR !== undefined) env.TSM_USER_ZDOTDIR = userEnv.ZDOTDIR;
  } else {
    const dataDirs = userEnv.XDG_DATA_DIRS;
    env.XDG_DATA_DIRS = `${dir}:${dataDirs || '/usr/local/share:/usr/share'}`;
    env.TSM_XDG_DATA_DIRS = dataDirs ?? '';
    if (opts.noUserRc) {
      env.XDG_CONFIG_HOME = empty;
      env.TSM_XDG_CONFIG_HOME = userEnv.XDG_CONFIG_HOME ?? '';
    }
  }
  return { kind, args: [], env, key, launcher, cleanup };
}
