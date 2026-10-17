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
- **`session-cli` runs with `node`** - its shebang named `ts-node`, a dev
  dependency, so the installed command failed with "No such file or
  directory" wherever `ts-node` wasn't on the PATH. It runs on Node
  versions that can `require` an ES module: from 20.19 on Node 20, from
  22.12 on Node 22, and on 23 and 24. On older ones it still stops: it
  loads the ESM-only `strip-ansi` 7 with `require`, which predates this
  change.
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
  until it is in (or until no line of the body has been typed for two
  seconds while it waits, or that command's own timeout), since a line
  typed into a line editor
  that is still handling a long one can leave it redrawing instead of
  reading. 1.6.0 typed a
  single-line command of any length as one line, which a shell could cut
  short. A body that would take more than 128 lines (about 100 KB of ASCII
  text; a byte at or above 0x7f, a single quote, a `!` or a control byte
  other than a newline or tab takes five characters escaped, and a newline,
  tab or backslash two, so text that is mostly made of the five-character ones reaches
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
  under the terminal's default settings, so those never run either; the
  SIGINT entry below says what becomes of them under `stty noflsh`.

### Changed

- **A timed-out command is left untouched.** Previously the marker machinery
  incidentally poked blocked stdin-readers with garbage input. Now a command
  that times out (exitCode -1) simply keeps running in the session, and
  commands sent meanwhile are typed in behind it: they run when it ends, or
  become its input if it reads any, and a shell it started, such as ssh's,
  runs them. Check on it with `tailLogs`, answer it with `sendInput` once it
  has started (see below), or
  interrupt it with `sendSignal` (SIGINT, the default, sent as Ctrl-C, which
  under the terminal's default settings also discards the commands typed in
  behind it, as the SIGINT entry below says; other signals go to the
  session's shell itself).
  The `runCommand` tool's `timeout` parameter documents this.
- **`sendInput` refuses input while a command is on its way in.** A command
  for a shell that can't read the temp file starts only once its body has
  been typed in (see above), and that shell would read input sent before then
  as part of its own command lines. So `sendInput` sends nothing and throws
  from the moment a command's line is typed, or held behind a body still
  going in, until its start marker comes, it ends or it's given up, and while
  a body goes in. A Ctrl-C sent alone, as the `C-c` key, isn't refused (see
  the next entry). The refusal also lapses after two seconds in which the
  server has typed no line and read no marker, as when a program took the
  command's line, which doesn't mean the command has started. With a shell
  that reads the temp file and waits at its prompt, the refusal lasts the
  probe line's round trip, so a `sendInput` sent straight after `runCommand`
  with a timeout of -1 can be refused where 1.6.0 sent it: send it again in a
  moment.
- **A SIGINT gives up a command still being typed in.** Before its Ctrl-C,
  `sendSignal` with SIGINT gives up the commands on their way in that can't
  have started, since a body's last line is what runs it: a body still being
  typed in, the bodies waiting their turn, and a probe line held behind them,
  which is then never typed. Over a link, a Ctrl-C typed between two of a
  body's lines reaches the shell at its prompt and takes nothing with it, so
  the rest of the body would be typed and run. The session log gives each
  one's reason, `[command not run: interrupted before its body was all typed
  in]`, or `[command not run: interrupted before its line was typed]` for a
  probe line still held, and a caller still waiting gets -1 with it, whatever
  `stty noflsh` says. A Ctrl-C sent alone with `sendInput`, as the `C-c` key
  or a terminal's Ctrl+C keystroke, does the same, and like `sendSignal`'s it
  isn't refused while a command goes in; input that holds a ^C among other
  characters does it too, once input is accepted. Every other command whose
  line is typed and that hasn't started is marked: if its no-file marker
  comes, it is given up there rather than its body typed. Of the others, one
  whose shell had already read its line is running, and the Ctrl-C reaches it
  as any running command. One whose line was still waiting loses it to the
  Ctrl-C, never answers, and its caller gets its timeout's -1, unless `stty
  noflsh` keeps the line: then the line is read after the Ctrl-C as any line
  typed ahead is. Its command is then given up at its no-file marker if its
  shell can't read the temp file, and otherwise can still run, its caller
  getting the result or its timeout's -1, whichever comes first. A body typed
  in whole may be running, and is left to the Ctrl-C. Commands waiting in the
  server's queue have no line typed and aren't given up: each goes in after
  the Ctrl-C in its turn, as any queued command does.
- Command bodies are sourced with `.` (POSIX) instead of the `source`
  bashism, so plain sh/dash sessions work too.
- Shell history records each command's typed line (a check that the shell
  can read its temp file, which it then sources between two markers, or in a
  shell that can't, the body escaped), not the command's own text.

## v1.6.1 - 2026-10-17

### Changed

- **Host and Origin checks at both ports**, as in 2.0. The session API and the
  web GUI now check every HTTP request and WebSocket / socket.io handshake
  before the token:
  - a request carrying an `Origin` is served only from the GUI's own page
    (same origin as the request's Host) or from an origin listed with
    `--allow-origin`;
  - without a token, a request is served only when its Host is `localhost`,
    `127.0.0.1`, `[::1]` (any port on a loopback bind, so port forwards keep
    working), the bind address, or a name listed with `--allow-host`. With a
    token, the token remains the gate and Host is not checked.
- A token-less server bound to a non-loopback address (`--host 0.0.0.0`) no
  longer serves requests addressed by other names (a LAN or tailnet IP, a
  hostname). Use `--token` (recommended) or list the name with `--allow-host`.
- The GUI's socket.io server no longer sends permissive CORS headers.
- Request URLs are parsed against a fixed base; token comparison is
  constant-time.

### Added

- `--allow-host` / `SESSION_SERVER_ALLOW_HOSTS` and `--allow-origin` /
  `SESSION_SERVER_ALLOW_ORIGINS` (comma-separated, flags repeatable).

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

