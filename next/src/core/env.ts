/** Environment basis for shells and process Runs (§8.2, G7) and its hygiene (G26). */

export interface EnvSnapshot {
  vars: Record<string, string>;
  seq: number;
  capturedAt: number;
}

/** Parse `env -0` output. */
export function parseEnvNul(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const entry of text.split('\0')) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    vars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return vars;
}

/**
 * What a session never inherits from the daemon's environment (G7, G26, ux-8):
 * - the daemon's own configuration and credentials: TSM_TOKEN, TSM_TOKENS_FILE, TSM_URL and
 *   every other TSM_* the daemon, the shim or the CLI reads;
 * - the identity of the terminal that launched the daemon. The session's terminal is the
 *   daemon's emulator, not that one: inheriting these makes the user's rc load the launching
 *   terminal's own shell integration (Ghostty, iTerm2, kitty, VS Code …; VTE's vte.sh appends
 *   to an array PROMPT_COMMAND on bash >= 5.1, ss-9), and `TMUX` would make a `tmux` in a
 *   session drive the user's tmux server;
 * - the state of whatever launched the daemon, which breaks or leaks in a session shell:
 *   Volta's `_VOLTA_TOOL_RECURSION` makes every Volta shim pass straight through, so
 *   per-project node pinning stops working; npm/npx lifecycle, config and working directory
 *   (`npm_*`, `INIT_CWD`); the launching agent host's session identity (Claude Code's
 *   `CLAUDECODE`, `CLAUDE_CODE_*` — which include a messaging token — `CLAUDE_PID`,
 *   `AI_AGENT`, Cursor's and Codex's equivalents), which every principal of every session
 *   would otherwise see; the launching shell's atuin state, with which a session's atuin
 *   would end the launching shell's history entries.
 * User configuration (VOLTA_HOME, ATUIN_CONFIG_DIR, NODE_OPTIONS …) is kept.
 */
const SCRUBBED_NAMES = new Set(
  `TERM_PROGRAM TERM_PROGRAM_VERSION TERM_SESSION_ID TERM_FEATURES TERMINFO TMUX TMUX_PANE STY WINDOWID WT_SESSION WT_PROFILE_ID
   INSIDE_EMACS TERMINAL_EMULATOR LC_TERMINAL LC_TERMINAL_VERSION COLORTERM VTE_VERSION TILIX_ID TERMINATOR_UUID
   INIT_CWD CLAUDECODE CLAUDE_PID CLAUDE_EFFORT CLAUDE_JOB_DIR AI_AGENT CURSOR_TRACE_ID CURSOR_AGENT
   CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED CODEX_THREAD_ID ATUIN_SESSION ATUIN_HISTORY_ID ATUIN_SHLVL ATUIN_TMUX_POPUP`.split(/\s+/),
);
const SCRUBBED_PREFIXES = ['TSM_', 'GHOSTTY_', 'ITERM_', 'KITTY_', 'VSCODE_', 'WEZTERM_', 'ALACRITTY_', 'KONSOLE_', 'ZELLIJ', 'WARP_', '_VOLTA_', 'npm_', 'CLAUDE_CODE_'];

function scrubbed(name: string, value: string): boolean {
  if (SCRUBBED_NAMES.has(name) || SCRUBBED_PREFIXES.some((p) => name.startsWith(p))) return true;
  // An agent host disables interactive editors for its own tool shells; in a session
  // terminal `git commit` would silently abort with an empty message.
  return name === 'GIT_EDITOR' && (value === 'true' || value === ':');
}

/**
 * PATH entries a launcher prepended: Volta's pinned node image (`<VOLTA_HOME>/tools/image/…`,
 * which would shadow the Volta shims and their per-project pinning) and npm's
 * `node_modules/.bin` chain (only when the daemon was started through npm or npx).
 */
function scrubPath(value: string, env: NodeJS.ProcessEnv): string {
  const volta = env.VOLTA_HOME ? `${env.VOLTA_HOME.replace(/\/+$/, '')}/tools/image/` : undefined;
  const npm = env.npm_execpath !== undefined || env.npm_lifecycle_event !== undefined || env.npm_command !== undefined;
  const keep = value.split(':').filter((p) => {
    if (p.includes('/.volta/tools/image/') || (volta !== undefined && p.startsWith(volta))) return false;
    if (npm && (/\/node_modules\/\.bin\/?$/.test(p) || /\/node-gyp-bin\/?$/.test(p))) return false;
    return true;
  });
  return keep.join(':');
}

/** The daemon's environment minus its own credentials, the launching terminal's identity and its launcher's state. */
export function scrubDaemonEnv(daemonEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(daemonEnv)) {
    if (v === undefined || scrubbed(k, v)) continue;
    out[k] = k === 'PATH' ? scrubPath(v, daemonEnv) : v;
  }
  return out;
}

/**
 * G6: a session's history is its own, never the user's — for history tools the user's rc
 * loads as well as for HISTFILE. atuin keeps one global database and records every line
 * typed at a prompt into it; these point its database, record store, key and sync
 * session at the session's own directory and turn its daemon and sync off (environment
 * settings override atuin's config file). Its key bindings are handed back to the
 * shell's own history by the integration (shell/*.ts). Given for the shell only; a
 * creation-time env that names any of them wins.
 */
export function historyIsolationEnv(dir: string): Record<string, string> {
  return {
    ATUIN_DB_PATH: `${dir}/history.db`,
    ATUIN_RECORD_STORE_PATH: `${dir}/records.db`,
    ATUIN_KEY_PATH: `${dir}/key`,
    ATUIN_SESSION_PATH: `${dir}/session`,
    ATUIN_META__DB_PATH: `${dir}/meta.db`,
    ATUIN_DAEMON__ENABLED: 'false',
    ATUIN_DAEMON__AUTOSTART: 'false',
    ATUIN_AUTO_SYNC: 'false',
  };
}

/**
 * The configured basis (G7): the daemon's environment, scrubbed, with the session
 * terminal's identity (the daemon's headless xterm), under the session's creation-time env
 * (which still wins — a session may deliberately be given a TSM_URL or a TERM).
 */
export function configuredEnv(daemonEnv: NodeJS.ProcessEnv, sessionEnv: Record<string, string>): Record<string, string> {
  return { ...scrubDaemonEnv(daemonEnv), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'tsm', ...sessionEnv };
}

/**
 * Drop credentials in the tool's namespace from a captured environment before it is
 * journaled (G26): the transport token (TSM_TOKEN, and any TSM_*_TOKEN/KEY/SECRET/PASSWORD)
 * and the session's mark key. The user's rc may export them in the shell (for the CLI).
 */
export function redactSnapshot(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (!/^TSM_(?:.*_)?(?:TOKEN|KEY|SECRET|PASSWORD)$/.test(k)) out[k] = v;
  return out;
}

/**
 * A setting read from the daemon's own environment: set to something, or absent. An empty
 * variable is unset, not a value (the house's read of 59f660b, #22): `TSM_DATA_DIR=""` must not
 * become a data directory named "", in termd, in the shim that starts it, or in the CLI.
 */
export const setting = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[name] || undefined;
