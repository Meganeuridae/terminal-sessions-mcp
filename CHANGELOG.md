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

  A command that replaces the shell (`exec bash`) still prints no exit marker
  of its own and waits for its timeout. One that exits a shell an earlier
  command started (`exit` sent to ssh's remote shell or a nested `bash`)
  ends when that earlier command's line does, with the status that line ends
  with: ssh's, when ssh ends it, which ssh takes from the remote shell.
- **Every `runCommand` command goes through the temp-file path** (not just
  multi-line ones), which also fixes single-line commands longer than the
  tty's canonical-mode line buffer (1024 bytes on macOS) being silently
  truncated, and translates the temp-file path to `/mnt/<drive>/...` form so
  sourcing works under WSL on Windows. `startService` still types its
  command. A command whose temp file can't be written (a missing or full
  temp directory) fails alone with exitCode -1 and the reason, instead of
  wedging the session; the file is created exclusively, so nothing planted
  at its name is written through or reused.
- **Commands reach a shell an earlier command started**, such as ssh's remote
  shell, multi-line ones included (1.6.0 typed only single-line commands, so
  only those ran there). Each typed line sources the temp file only if the
  shell in front can read it, so a shell that can, such as the session's own
  or a nested one run on this machine as the same user, keeps the file, and
  long or multi-line bodies are never typed into it. A shell that can't, such
  as a remote one, sets a variable named for the command to its own pid and
  gets the body typed in, escaped for `printf '%b'` and run with `eval`, in
  the order the commands were written, commands typed in behind a timed-out
  one included. The lines typed run only in a shell where that variable
  holds its own pid: a shell that reads them without it, such as the one
  behind after an ssh connection drops, or one an earlier command started in
  front meanwhile, runs nothing, and the command is given up rather than run
  there. A body is typed in lines of at most 1,000 bytes, since a shell can
  cut a longer line short (macOS's line limit is 1,024 bytes, and escaped, a
  byte of the body can take up to five characters): a body that fits goes
  as one line, and a longer one, such as a file written with a heredoc or a
  short script, is put together in a shell variable from as many lines as
  it takes, each typed once the shell has taken the one before (it prints a
  marker for it), and each run only where the variable holds as many
  characters as the lines before it typed, so a line that reached another shell, or was
  cut or taken by something else reading the terminal, leaves a body that
  never runs rather than one with a gap; the last line runs it. Bodies go
  in one at a time, in the order the commands were written: the next
  body's first line is typed once the shell has read the one before to its
  end, so a short body can't pass a longer one that is still going in.
  A body whose line something else reading the terminal took, such as a
  program the body before it started, holds the ones behind it only until
  the shell prints a marker for a line typed after that one, which shows
  it has read past where the taken line would have been; the body is given
  up then, the log says so, and the ones behind it go on. Typing takes a
  round trip per line, which counts against the command's timeout; a body
  still going in when its timeout passes is typed to its end and then runs,
  as a timed-out command keeps running, and the next command's line waits
  until it is in (or until the body has made no progress for two seconds,
  or that command's own timeout), since a line typed into a line editor
  that is still handling a long one can leave it redrawing instead of
  reading. 1.6.0 typed a
  single-line command of any length as one line, which a shell could cut
  short. A body that would take more than 128 lines (about 100 KB of ASCII
  text; a byte at or above 0x7f, a single quote, a `!` or a control byte
  other than a newline or tab takes five characters escaped, and a newline
  or tab two, so text that is mostly made of the five-character ones reaches
  the cap near 20 KB) isn't
  typed, and the command ends with exitCode -1 and says why if it's still
  waiting, and the session log says so too, as does a command given up
  because its lines reached another shell. Such a command leaves the
  variables set in the shell that asked, where nothing reads them. The
  shell in front has to be a POSIX
  shell (sh, bash, dash, zsh, ksh); in fish or csh the typed lines don't
  parse, and a command there times out without running. The typed lines rely
  on the standard behavior of the shell's `.`, `eval`, `[`, `echo`, `printf`
  and `unset`, which they call by name. A function or alias in the shell in
  front that changes how one of them behaves is outside what the transport
  supports, since it can make a command end with a status the body didn't
  produce: a function named `eval` that returns 0 ends every command typed
  inline with 0, without running it. runCommand's description says so.
- Exec plumbing (wrapper echoes, markers) is filtered out of session logs and
  the `lines` of output events, so `tailLogs` shows `$ command`, its output
  and the shell's prompts without the wrapper text. Only this session's own
  plumbing is removed, and only its spans: output sharing a line with it
  (text without a trailing newline, a timed-out command's late tail) stays,
  marker-shaped text from anywhere else is output, and a wrapper echo
  soft-wrapped at the terminal's edge (bash 3.2 on macOS), or ending exactly
  at it (where bash 5 redraws its last character), is still recognized. A
  line typed ahead behind a busy shell is echoed as it's typed, and output
  the shell prints meanwhile can break that echo across lines; pieces of it
  then stay in the logs. An output event's `chunk` stays the raw terminal
  stream.
- **A result is bounded by its own command's execution.** The shell prints a
  start marker immediately before sourcing the command and the exit marker
  immediately after, so a result no longer picks up the next prompt or what
  a timed-out predecessor prints before this command starts (a background
  job the predecessor left running can still print into it); a command that
  never started returns no output of its own (it may still run later; its
  output then reaches the logs), and one refused before it could be typed
  returns the reason. A command that times out returns what it printed by
  the end of the wait.
- **A command queued behind a timed-out one still runs** once the shell
  reaches it. Each command's temp file is kept until the shell has read past
  its line (its own exit marker, a later command's start marker, or the
  shell's exit), instead of being deleted when the next command is written,
  and the server removes the files still pending when its process exits
  normally (through `process.exit`, as the daemon's SIGINT and SIGTERM
  shutdown does). A predecessor that reads stdin can take the queued line as
  its input, and then that command never runs. Interrupting the predecessor
  with Ctrl-C (`sendSignal` SIGINT) discards the lines typed in behind it
  under the terminal's default settings, so those never run either; in a
  session that has set `stty noflsh`, they are kept and can still run after
  it.

### Changed

- **A timed-out command is left untouched.** Previously the marker machinery
  incidentally poked blocked stdin-readers with garbage input. Now a command
  that times out (exitCode -1) simply keeps running in the session, and
  commands sent meanwhile are typed in behind it: they run when it ends, or
  become its input if it reads any, and a shell it started, such as ssh's,
  runs them. Check on it with `tailLogs`, answer it with `sendInput`, or
  interrupt it with `sendSignal` (SIGINT, the default, sent as Ctrl-C, which
  under the terminal's default settings also discards the commands typed in
  behind it, and with `stty noflsh` keeps them, so they can still run after
  it; other signals go to the session's shell itself).
  The `runCommand` tool's `timeout` parameter documents this.
- Command bodies are sourced with `.` (POSIX) instead of the `source`
  bashism, so plain sh/dash sessions work too.
- Shell history records each command's typed line (a check that the shell
  can read its temp file, which it then sources between two markers, or in a
  shell that can't, the body escaped), not the command's own text.

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

