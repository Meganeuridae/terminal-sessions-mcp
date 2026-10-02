# Shipped configurations

Every host gets the compact tool core by default (DESIGN §11): `terminal.core` plus the
lane's non-tool sets. No entry adds a tool tier; add `terminal.control`, `terminal.services`,
`terminal.watch` or `terminal.search` when a workflow needs their tools.

| File | For |
|---|---|
| `mcpl-bridge.json` | Claude Code through `mcpl-cc-bridge`: merge the `terminal` entry into your bridge config (`$CLAUDE_PROJECT_DIR/.mcpl-bridge.json` or `~/.claude/mcpl-bridge/config.json`). Enables `terminal.core`, `terminal.live`, `terminal.presence`, `terminal.channels` and `terminal.annotate`: completions, lost Runs, needs-input, session exits and service changes wake the session; digests, screens and seat changes are held; each session is a registered channel, so `mcpl_open terminal:<session>` follows everything in it and `mcpl_send` leaves a note there (never typing). Watch firings wake too once you add `terminal.watch` (its tools set the watches). To hold a session's channel open across restarts, list it in `openChannels`. Allow the tools with one permission entry: `mcp__plugin_mcpl-bridge_mcpl__terminal__*`. |
| `agent-framework.recipe.json` + `agent-framework.gate.json` | connectome agents: the `mcplServers` entry for a recipe (`${TSM_TOKEN}` is interpolated) and the policies to merge into the agent's `_config/gate.json`, above its broad defer rules (first match wins). Enables `terminal.core`, `terminal.live`, `terminal.presence` and `terminal.annotate`: agent-framework routes an agent's reply to the session that woke it, and `terminal.annotate` records that reply as a note on the session (shown in the GUI, never typed) instead of failing it with `-32017`. Add `terminal.channels` for sessions as channels that stream everything while open. |
| `mcp.json` | Plain MCP hosts (Cursor, Claude Desktop, Claude Code without the bridge) through the stdio shim. `TSM_PROFILE=compat` (or `--profile compat` in `args`) gives the 1.x tool names for one release; the 1.x bin name `terminal-sessions-mcp` does so by itself. 1.x settings (`SESSION_SERVER_URL`, or `SESSION_SERVER_HOST`/`SESSION_SERVER_PORT`, and `SESSION_SERVER_TOKEN`) still work when the `TSM_*` ones are unset; a daemon is never started for an address they name, so a 1.x config that pointed at another machine never runs its commands on this one. 2.0's termd listens on 3101, 1.x's server on 3100. |
| `com.animalabs.termd.plist`, `termd.service`, `termd-launch.sh` | Supervising the daemon with launchd or systemd. Both run `termd-launch.sh`, which finds node where Homebrew, Volta or nvm put it (a supervisor's PATH has none of them), puts those directories on PATH for process Runs, starts in `$HOME` and keeps its files owner-only; on macOS it logs to `~/Library/Logs/termd/termd.log`. Replace the `PACKAGE` (and in the plist `YOU`) placeholders. |

Tokens: loopback without a token runs as `token:local-<user>`. For several agents, give each
its own principal with `--tokens-file` (JSON `{ "<token>": "agent:<name>@<domain>" }`,
mode 0600) and put the token in `TSM_TOKEN` for each host. A shim that finds no daemon starts
one without any credential (loopback-open) whatever its own `TSM_TOKEN` is: a daemon that
needs tokens is started by its supervisor, with its tokens file.
