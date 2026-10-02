# Changelog

## Unreleased — 2.0, the rearchitecture

A new implementation, built to `docs/redesign/DESIGN.md` and its guarantees (G1–G30), replaces
the 1.x session server, MCP bridge, GUI and CLI. It lives in `next/`.

### Added

- **One daemon, `termd`** (port 3101): sessions as persistent login shells with an append-only
  journal per session (memory ring plus files, explicit retention), a headless emulator for the
  current screen, and one WebSocket endpoint speaking MCP, MCPL and a native family. `tsm` (CLI,
  `--json` everywhere) and `tsm-shim` (stdio MCP) are thin clients; the GUI is served by `termd`.
- **Runs with identity**: every command has a `runId` from admission; shell and process
  targets; exit codes from shell-integration marks (bash, zsh, fish; keyed so nested shells,
  programs and other terminals' integrations cannot spoof them) or from the process itself; a
  command still running when `wait` ends keeps running and can be awaited; nothing invents an
  exit status (`lost` with a reason instead).
- **Tools**: nine core tools (`run`, `await`, `read`, `screen`, `input`, `cancel`,
  `session_list`, `session_open`, `session_close`) with transcript text plus a structured
  envelope; opt-in tiers for control, services with readiness and health probes, watches and
  `wait_for`, and `search`. Idempotency keys on every mutating tool.
- **MCPL**: sessions as channels with dual delivery, completions and service/watch events as
  push events to the principals they concern, catch-up after reconnect, a per-turn presence
  line, a tag ontology with suggested treatment. Verified against agent-framework's and
  mcpl-cc-bridge's real host code (`next/acceptance/`).
- **Sharing**: several principals per session (per-agent tokens), one controller seat,
  provenance on every input, observers that cannot act, private and shared sessions.
- **Measure**: every tool call recorded (names and hashes only) to `usage.jsonl`; `tsm usage`
  reports use, errors and confusion signatures.
- Shipped host and supervisor configurations in `next/config/`.

### Changed

- `terminal-sessions-mcp` is now the stdio shim; with the compat profile it serves the 1.x
  tool names (`runCommand`, `tailLogs`, `searchLogs`, `sendInput`, `sendSignal`, `listSessions`,
  `killSession`, `killAll`, `launch`, `takeScreenshot`) for one release, and their results also
  say whether a command is still running. `session-server` starts `termd`.
- Node 20 or later.

### Removed

- The 1.x server, GUI (socket.io, express), puppeteer screenshots (the screen is text now;
  images return later), the old CLI and `session-gui`, and dependencies nothing imports.

## v1.6.0 - 2026-07-11

### Added

- **Named keys for `sendInput`** ⌨️ - New `keys` parameter, tmux `send-keys`
  style, so agents can drive TUIs (codex, vim, htop, ...): `Enter`, `Tab`,
  `Shift-Tab`, `Esc`, `Space`, `Backspace`, `Delete`, arrows, `Home`/`End`,
  `PageUp`/`PageDown`, `F1`-`F12`, `C-a`..`C-z` (Ctrl), `M-<char>` (Alt/Meta).
  Raw control characters cannot pass through the MCP JSON tool layer, so named
  keys are the supported way to send them. Unknown key names return an error
  listing the valid vocabulary.
- Unit tests for key decoding and input assembly (`npm test`, zero-dependency
  `node --test`).

### Changed

- **`appendNewline` now appends `\r` (CR) instead of `\n` (LF)** - CR is what
  a real Enter key sends; canonical-mode shells are unaffected (`icrnl` maps
  CR to NL) and raw-mode TUIs now actually submit. If you were relying on a
  literal trailing LF byte reaching a raw-mode program, pass
  `appendNewline: false` and include `\n` in `input` yourself.
- `appendNewline` defaults to **false** when `keys` is provided (the caller
  controls the exact bytes); pass `true` explicitly to add Enter after keys.
- `sendInput` failures now include the error message instead of a bare
  `success: false`.

### Notes

- Already-running MCP bridge processes must be restarted to expose the new
  `keys` parameter - an old bridge silently drops it (and reports success).

## v1.2.0 - 2024-11-09

### Added

- **Direct Keyboard Input** ⌨️ - Type directly in the terminal, all keys forwarded to PTY
  - Arrow keys (←↑↓→)
  - Modifier keys (Ctrl, Alt, Shift)
  - Tab completion
  - All special characters
  - Real terminal experience in the browser
- **Signal Controls** - Practical buttons for process management
  - ^C button (SIGINT) - Interrupt processes
  - ^Z button (SIGTSTP) - Suspend processes
  - TERM button (SIGTERM) - Terminate gracefully
  - Replaces less useful screenshot button
- **Web GUI** 🎨 - Beautiful web interface for terminal session management
  - xterm.js-based terminal rendering with full TUI support
  - Dashboard showing all active sessions
  - Live Socket.IO updates
  - Interactive command input
  - Screenshot button to capture rendered terminal
  - GitHub dark theme UI
  - Accessible at http://localhost:3200
- **Proper TUI Support** - All terminal control sequences work correctly:
  - Cursor positioning (`\033[row;colH`)
  - Screen clearing (`\033[2J`)
  - All ANSI colors and formatting
  - Box drawing characters
  - Progress bars with proper positioning
- **Live Event Streaming** - RobustSessionClient now emits WebSocket events
- Binary command: `session-gui` for starting web interface

### Fixed

- Screenshots now properly render TUI control sequences (via web GUI's xterm.js)
- Event forwarding from session server → GUI server → browser clients

## v1.1.0 - 2024-11-09

### Added

- **Terminal Screenshots** 📸 - Capture visual terminal output including:
  - ANSI colors and formatting
  - TUIs (terminal user interfaces)
  - Progress bars and spinners
  - ASCII/ANSI art
  - Colorized log output
- Returns base64 or saves to file
- Configurable resolution and line count
- New MCP tool: `takeScreenshot`
- Dependencies: `ansi-to-html`, `puppeteer`

### Changed

- **Infinite reconnection** - RobustSessionClient now retries indefinitely instead of giving up after 5 attempts
- Reconnection delay caps at 5 seconds (was 30 seconds)
- Handles server restarts gracefully without manual intervention

## v1.0.0 - 2024-11-09

### Initial Release

Extracted from `connectome-ts` as a standalone, generally-useful package.

### Features

- **Persistent Terminal Sessions** - Real PTY-based shell sessions that maintain state
- **Smart Service Management** - Intelligent startup detection with ready/error patterns
- **Log Search** - Regex-based log search with context lines
- **MCP Integration** - Full Model Context Protocol support for AI assistants
- **WebSocket API** - Real-time bidirectional communication
- **Interactive Support** - Send input and signals to running processes
- **Robust Client** - Automatic reconnection with exponential backoff
- **CLI Tools** - Command-line interface for manual session management

### Components

- `PersistentSessionServer` - Core PTY session management
- `SessionAPI` - WebSocket API server
- `RobustSessionClient` - WebSocket client with auto-reconnection
- `ConnectomeTestingMCP` - MCP integration layer
- `session-cli` - Command-line tool

### Migration from connectome-ts

Files moved from `connectome-ts/src/testing/`:
- `session-server-v3.ts` → `src/server/session-server-v3.ts`
- `websocket-api.ts` → `src/server/websocket-api.ts`
- `start-session-server.ts` → `src/server/start-session-server.ts`
- `mcp-server.ts` → `src/mcp/mcp-server.ts`
- `mcp-stdio-server.ts` → `src/mcp/mcp-stdio-server.ts`
- `websocket-client.ts` → `src/client/websocket-client.ts`
- `session-cli.ts` → `cli/session-cli.ts`

All import paths updated to reflect new structure.

