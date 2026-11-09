/**
 * What a session never inherits from the daemon's environment:
 * - every TSM_* variable, the tool's own namespace, and 1.x's SESSION_SERVER_TOKEN and
 *   SESSION_SERVER_URL, the credentials of this package's other server;
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
 *   `AI_AGENT`, Cursor's and Codex's equivalents), which every session's shell would
 *   otherwise see; the launching shell's atuin state, with which a session's atuin
 *   would end the launching shell's history entries.
 * User configuration (VOLTA_HOME, ATUIN_CONFIG_DIR, NODE_OPTIONS …) is kept.
 */
const SCRUBBED_NAMES = new Set(
  `TERM_PROGRAM TERM_PROGRAM_VERSION TERM_SESSION_ID TERM_FEATURES TERMINFO TMUX TMUX_PANE STY WINDOWID WT_SESSION WT_PROFILE_ID
   INSIDE_EMACS TERMINAL_EMULATOR LC_TERMINAL LC_TERMINAL_VERSION COLORTERM VTE_VERSION TILIX_ID TERMINATOR_UUID
   INIT_CWD CLAUDECODE CLAUDE_PID CLAUDE_EFFORT CLAUDE_JOB_DIR AI_AGENT CURSOR_TRACE_ID CURSOR_AGENT
   CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED CODEX_THREAD_ID ATUIN_SESSION ATUIN_HISTORY_ID ATUIN_SHLVL ATUIN_TMUX_POPUP
   SESSION_SERVER_TOKEN SESSION_SERVER_URL`.split(/\s+/),
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
  // No prototype, so a variable named __proto__ is kept like any other.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(daemonEnv)) {
    if (v === undefined || scrubbed(k, v)) continue;
    out[k] = k === 'PATH' ? scrubPath(v, daemonEnv) : v;
  }
  return out;
}

/**
 * In bash, zsh and fish, a session's history is its own, never the user's, for history tools the
 * user's rc loads as well as for HISTFILE. A prompt hook of the user's own that writes a named
 * file (`history -a ~/.bash_history`), or sets HISTFILE back, still writes there, and a shell without the integration
 * keeps the HISTFILE it is given. atuin keeps one global database and records every line
 * typed at a prompt into it; these point its database, record store, key and sync
 * session at the session's own directory and turn its daemon and sync off (environment
 * settings override atuin's config file).
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

export function configuredEnv(daemonEnv: NodeJS.ProcessEnv, sessionEnv: Record<string, string>): Record<string, string> {
  return { ...scrubDaemonEnv(daemonEnv), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'tsm', ...sessionEnv };
}
