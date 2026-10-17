# Changelog

## Unreleased

### Fixed

- **Client no longer times out before the server** ⏱️ - `exec` without an
  explicit timeout used the generic 10s request timeout while the server's
  default command timeout is 30s: any command taking 10-30s failed
  client-side ("Request timeout: session.exec") and its result was dropped.
  Request timeouts are now derived per-method (exec: command timeout + 5s
  buffer; launch: covers the 15s pattern poll; screenshot: 30s).
- **Graceful `killSession` is actually graceful (and fast)** - it sent
  SIGINT, which an interactive bash ignores, so every graceful kill burned
  the full 3s timeout and then SIGKILLed anyway. It now sends SIGHUP (the
  "terminal went away" signal shells exit on) and polls at 50ms — an idle
  session dies in ~100ms. bash can leave a SIGHUP that lands between two
  commands unanswered until its next input, so it is sent again every 500ms
  while the shell is still there. A graceful kill now also ends the jobs the
  session's shell started in the background (`sleep 300 &`, a service
  started with `&`), since the shell passes the hangup on to them before it
  exits; 1.6.0 left them running. A job started with `nohup`, or disowned,
  ignores the hangup and keeps running.
- **Session creation waits for shell readiness**, up to 2s, instead of a
  fixed 200ms sleep, so an rc file that finishes within that no longer leaks
  startup noise into the first command's output.
- **ANSI cleaning covers the full CSI grammar** - sequences with non-letter
  final bytes (e.g. insert-character `ESC[1@`, cursor-style `ESC[2 q`) used
  to leave residue like `[1@` in cleaned output.
  Two-character escapes are stripped whole too: `ESC >`, which `less` prints
  when it exits, used to leave a stray `>` at the end of a result.
- `listSessions` (MCP) returned `pid`/`startTime` fields that never existed
  server-side (always undefined); it now returns the real fields
  (`isAlive`, `createdAt`, `lastActivity`, `logSize`).
- The MCP initialize handshake reports the real package version instead of a
  hardcoded `1.0.0`.
- Process-exit cleanup removes the sessions' temp files synchronously. The
  old async graceful path was abandoned mid-flight when the event loop
  stopped, which left the temp file behind each session's last multi-line
  command. The cleanup sends the shells no signal: when the program ends,
  the kernel hangs up each session's terminal once nothing else holds it
  open, and a shell such as bash passes the hangup on to the jobs it
  started in the background, as with 1.6.0.
- **Ctrl+C runs the standalone server's graceful shutdown.** The server class
  registered its own SIGINT handler, which exited the process before
  `start-session-server`'s graceful shutdown could run. The class now
  registers no SIGINT handler, so Ctrl+C runs the same graceful `killAll` as
  SIGTERM: the shells get the hangup, their background jobs end with them,
  and the server is down in under 200ms. A program that embeds
  `PersistentSessionServer`, directly or through `SessionAPI`, and handles
  no SIGINT itself now ends on Ctrl+C by the signal, where 1.6.0 exited with
  status 0. No `exit` listener runs then, the program's own included, so
  its sessions' temp files stay, as with 1.6.0. Handling SIGINT with
  `process.exit()` runs them.

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

