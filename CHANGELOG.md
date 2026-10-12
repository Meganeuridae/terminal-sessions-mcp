# Changelog

## Unreleased

### Fixed

- **Command completion is now detected at actual completion** 🏁 - The
  exit-code marker is chained onto the same shell line as the command
  (`echo "<<<STAR""T:<nonce>>>"; . '<tempfile>'; echo "<<<EXI""T:<nonce>:$?>>>"`)
  instead of being typed into the PTY 50ms later. This fixes the family of
  "doesn't notice the command ended / waits for the full timeout" bugs:
  - `runCommand("exit")` (or any command that kills the shell) resolved only
    at the fallback timeout; the PTY exit handler now resolves the in-flight
    command immediately with the shell's exit status (-1 if a signal killed
    it, which the session log names, as in `[Session terminated by SIGKILL]`),
    and queued commands fail fast instead of hanging.
  - Commands that read stdin (`read`, REPLs, `ssh`...) used to swallow the
    delayed marker line as *input* — burning the full timeout AND feeding a
    line of garbage into whatever was reading (picture a password prompt).
    Nothing extra is typed into the PTY anymore.
  - A command (or its output) merely *containing* marker-shaped text like
    `<<<EXIT:7>>>` resolved instantly with that bogus exit code, before the
    command even ran. Markers now carry a per-command nonce, and the marker
    string is split in the echoed command text so no echo of the typed line
    can ever match.
  - After a timeout, the stale marker from the still-running command could
    resolve the *next* command with the wrong exit code and mangled output.
    Nonces make stale markers inert (and they're stripped from output).

  A command that replaces the shell (`exec bash`) or exits a nested shell
  (`exit` sent to a `bash` an earlier command started) still prints no exit
  marker of its own and waits for its timeout.
- **Every `runCommand` command goes through the temp-file path** (not just
  multi-line ones), which also fixes single-line commands longer than the
  tty's canonical-mode line buffer (1024 bytes on macOS) being silently
  truncated, and translates the temp-file path to `/mnt/<drive>/...` form so
  sourcing works under WSL on Windows. `startService` still types its
  command. A command whose temp file can't be written (a missing or full
  temp directory) fails alone with exitCode -1 and the reason, instead of
  wedging the session; the file is created exclusively, so nothing planted
  at its name is written through or reused.
- Exec plumbing (wrapper echoes, markers) is filtered out of session logs and
  the `lines` of output events, so `tailLogs` shows `$ command`, its output
  and the shell's prompts without the wrapper text. Only this session's own
  plumbing is removed, and only its spans: output sharing a line with it
  (text without a trailing newline, a timed-out command's late tail) stays,
  marker-shaped text from anywhere else is output, and a wrapper echo
  soft-wrapped at the terminal's edge (bash 3.2 on macOS) is still
  recognized. An output event's `chunk` stays the raw terminal stream.
- **A result is bounded by its own command's execution.** The shell prints a
  start marker immediately before sourcing the command and the exit marker
  immediately after, so a result no longer picks up the next prompt or what
  a timed-out predecessor prints before this command starts (a background
  job the predecessor left running can still print into it); a command that
  never started returns no output of its own (it may still run later; its
  output then reaches the logs). A command that times out returns what it
  printed by the end of the wait.
- **A command queued behind a timed-out one still runs** once the shell
  reaches it. Each command's temp file is kept until the shell has read past
  its line (its own exit marker, a later command's start marker, or the
  shell's exit), instead of being deleted when the next command is written,
  and the server removes the files still pending when its process exits
  normally (through `process.exit`, as the daemon's SIGINT and SIGTERM
  shutdown does). A predecessor that reads stdin can take the queued line as
  its input, and interrupting it with Ctrl-C (`sendSignal` SIGINT) discards
  the lines typed in behind it; either way those commands never run.

### Changed

- **A timed-out command is left untouched.** Previously the marker machinery
  incidentally poked blocked stdin-readers with garbage input. Now a command
  that times out (exitCode -1) simply keeps running in the session, and
  commands sent meanwhile are typed in behind it: they run when it ends, or
  become its input if it reads any. Check on it with `tailLogs`, answer it
  with `sendInput`, or interrupt it with `sendSignal` (SIGINT, the default,
  sent as Ctrl-C, which also discards the commands typed in behind it; other
  signals go to the session's shell itself). The `runCommand` tool's
  `timeout` parameter documents this.
- Command bodies are sourced with `.` (POSIX) instead of the `source`
  bashism, so plain sh/dash sessions work too.
- Shell history records each command's wrapper line (its temp file sourced
  between two markers), not the command's own text.

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

