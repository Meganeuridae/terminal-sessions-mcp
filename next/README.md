# Terminal Sessions 2.0

> 2.0 lives in `next/`, beside the 1.x code this package has shipped so far. Both are in the
> package: `termd`, `tsm` and `tsm-shim` are 2.0; `terminal-sessions-mcp`, `session-server`,
> `session-gui` and `session-cli` are 1.x, whose code 2.0 does not change. The design discussion is
> [antra-tess/terminal-sessions-mcp#11](https://github.com/antra-tess/terminal-sessions-mcp/pull/11).

Persistent terminal sessions for agents and humans: a daemon that keeps shells alive,
tracks observed command boundaries and outcomes, retains output in a journal you can page
through by cursor, and tells a host when something it cares about happens. When completion
evidence is lost, the outcome is reported as unknown.
Several agents and humans can share a session, with provenance on every keystroke and one
explicit controller at a time.

It speaks MCP to any MCP host and MCPL (MCP plus a live lane: channels, push events,
presence) to hosts that support it — agent-framework (connectome) and Claude Code through
`mcpl-cc-bridge`. The design, and the guarantees everything here is tested against, are in
[`docs/redesign/DESIGN.md`](../docs/redesign/DESIGN.md).

## Quick start

```bash
npm install -g term-sessions-mcp     # bins: termd, tsm, tsm-shim
termd                                 # ws://127.0.0.1:3101 · GUI at http://127.0.0.1:3101/
tsm run demo 'echo hello; pwd'        # exit = the command's code; 124 running, 75 busy, 1 error (tsm --help lists them all)
```

termd needs bash: `/bin/bash`, or a `bash` on the daemon's PATH (NixOS). It closes the descriptors a
shell or a process Run would otherwise inherit — the terminal masters of other sessions among them —
before the child runs; a process Run's command text itself then runs in `/bin/sh`. Without bash
(Alpine's base: `apk add bash`), termd says so when it starts and refuses to open a session or run a
process Run with that message, since a shell that could write into another session's terminal is the
worse failure. It keeps serving history, the GUI and the lane meanwhile, and `/health` answers
`"status":"degraded"` with the same message as `unsupported`. The same holds for a `/dev/fd` that does
not list the process's own descriptors.

Then connect a host (configurations in [`next/config/`](config/)):

- **Claude Code with `mcpl-cc-bridge`**: add the `terminal` entry from
  `next/config/mcpl-bridge.json` to your bridge config, and allow
  `mcp__plugin_mcpl-bridge_mcpl__terminal__*`. Completions, questions and watch firings wake
  the session; progress is held.
- **agent-framework**: the `mcplServers` entry from `next/config/agent-framework.recipe.json` and
  the gate policies from `next/config/agent-framework.gate.json`.
- **Any MCP host** (Cursor, Claude Desktop, Claude Code without the bridge):
  `next/config/mcp.json` — the stdio shim starts `termd` if nothing is listening on its (plain
  `ws://`, loopback) address, unless a termd systemd user unit or launchd job manages a termd
  for that port (then it is the supervisor's to start, and the shim waits for it) or for another
  port out of the same data dir (`~/.tsm` for both by default; one termd per data dir, so give
  the shim its own `TSM_DATA_DIR` or dial the unit's port), or `TSM_NO_SPAWN=1` says never to.
  A check that does not answer, or fails (under cron or `sudo -u`, `systemctl --user` cannot
  reach the user manager without `XDG_RUNTIME_DIR`; over ssh, `launchctl` has no GUI domain to
  ask), starts nothing either: the shim says so and names `TSM_NO_SPAWN=1`. The one exception is
  macOS with no LaunchAgent plist on disk (`~/Library/LaunchAgents/com.animalabs.termd.plist` or
  the machine's): a failed `launchctl` query then counts as no supervisor, since nothing of yours
  is installed for launchd to run. With a supervisor unit of your own name, set `TSM_NO_SPAWN=1` in the shim's
  configuration. A termd the shim started that exits is reported on the shim's stderr with what
  termd said (its stderr, kept in `<data-dir>/termd.stderr.log`, where termd also says a startup
  failure found after its log opened; else the end of its log), and started again when the port
  is refused later.

## What an agent gets

Ten core tools, one verb each (DESIGN §11, §11.1):

| Tool | Use it to |
|---|---|
| `run` | run a command in a session's persistent shell (or `target: process`) and wait up to `wait` ms; a command still running comes back with its `runId` and keeps running |
| `await` | keep waiting for a `runId` |
| `read` | page through history by cursor (`since`), one command's output (`runId`), or the last lines (`tail`) |
| `screen` | see what the terminal shows now (TUIs) |
| `input` | type text and named keys, nothing appended |
| `cancel` | stop a Run: queued → dropped; process → SIGINT/TERM/KILL; shell → ^C, ^\, then the foreground job |
| `session_list`, `session_open`, `session_close` | manage sessions |
| `session_declare_shell` | declare that the foreground program is a shell, so subsequent Runs execute there |

Every successful result has two renderings: a readable transcript closed by one status line —
`[run r4-1a2b exited 1 in 8.2s · shell · cwd /w/app · next=4990]` — and a structured
envelope (`structuredContent`) whose `state` is the only authority on whether a command
finished. A failed call comes back as an error result whose text opens with the code
(`session_not_found: …`) and which carries no envelope. The exit is the shell's own; for a pipeline (the last one of a multi-line command) the
result also carries each command's status (`pipeStatus`, not in a declared shell, whose end marker
carries `$?` alone), and the status line says when one before
the last failed, since `make | tee log` exits as `tee` did; a producer that `head` stopped reading
(status 141, SIGPIPE) is not called a failure. The text block is the transcript when the connection asks for it
(`TSM_RESULT_TEXT=transcript` for the shim, `?resultText=transcript` on the URL; the
shipped configs set it) and the envelope as JSON otherwise — the default, for hosts whose
scripts parse tool text (agent-framework's code execution). The hints below — that a line
looks like it opened another shell, turned on `set -e`, or ran `ssh` without a terminal — are
part of the status line, so a host reading the JSON gets the facts (`line`, `state`, `reason`)
and no hint field. Opt-in tiers: `terminal.control` (`signal`, `control`, `resize`,
`session_env_capture`), `terminal.services` (`start` with readiness and health probes),
`terminal.watch` (`watch`, `unwatch`, `watches`, `wait_for`), `terminal.search` (`search`). Mutating tools of these
tiers take an `idempotencyKey` (a fresh UUID per operation): a retry returns the first outcome
instead of running twice, also across a daemon restart for `run` and `start`. The 1.x
compatibility tools do not take one (1.x had none) and ignore one passed to them.

The patterns of `search`, `watch`, `wait_for` and a service's readiness and failure probes match
one output line at a time, as the terminal shows it: escape sequences are gone, and a tab is the
spaces up to the next tab stop (every eight columns). So `key\tvalue` does not match a line
printed with a tab; `key\s+value` does. A line longer than the pattern's match window is matched
on its head only, and the result, or the notice, says so. 1.x's `searchLogs` matched a tab as
`\t`; the compat tool of that name reads lines as the others do.

A result `lost` means the daemon could not observe the command's end and refuses to
guess (DESIGN G3); the reason says why. The common self-inflicted one is `shell-exited
(status N)`: the shell running the command exited under it. That happens when a command
runs `exit`, or when `set -e` is on in the session shell and a command fails. `set -e` is
for scripts. In a session shell, where every Run already reports its own exit status, it
only arms a trap: it stays on, and every later failing command ends the whole shell and the
state in it. Keep it inside the script or a subshell (`(set -e; …)`), never in the session
shell; the status line of a Run that turns it on says so.

Over MCPL, each session is a channel. What concerns you arrives on its own: a Run you
started ending, a service you started turning ready or unhealthy, a watch you set firing, a
program that seems to wait for input, your session's shell exiting. Before each inference a
short presence block says what changed since you last read. A completion your own call
already returned is not repeated, and one that ended while you were disconnected arrives
when you reconnect.

Output is UTF-8 text. `raw` preserves the decoded text and its stream/provenance before
transcript formatting; invalid byte sequences become U+FFFD. Binary artifacts should be
written to files or encoded explicitly. Shell integration credentials are kept out of
ordinary child environments and observer output; they are not an isolation boundary
against code deliberately inspecting its own shell or same-user private files.

## SSH, sudo and nested shells

Use your normal OpenSSH configuration on the machine running `termd`: host aliases, keys,
`ProxyJump`, VPN routes. Authentication and host keys stay OpenSSH's business.

Run `ssh host` as a command. It stays running, and the session's shell is busy with it.
Then declare once that the program in front is a shell, and run commands as usual:

```bash
tsm run work 'ssh workbox' --wait 2000
tsm declare work
tsm run work 'cd /srv/app && git pull && ./build.sh'
tsm run work 'exit'
```

The status line of the `ssh` command itself says that it looks like it opened a shell and
points at the declaration; the kind of shell only needs naming for fish (`tsm declare work fish`).

Commands to a declared shell travel inline with start and end markers, so each one is a Run
with output and exit status, and `cd`, exports and activations persist on the remote side;
long commands go in pieces. The result says `cwd unknown` and names the declared shell.
When `ssh` exits because you asked — `exit` typed into it, or a cancel of the `ssh` Run — the
declaration ends with it and the next `run` is in the session's own shell again. When it
ends without your asking — the connection dropped, the remote shell died — the next `run` is
refused once (`busy: declared-shell-ended`) rather than run on the wrong machine: run it again
if the session's own shell is what you mean. Either way a note in the session's history says
so, and a command that was in flight ends `lost` with that reason rather than being guessed
at. The same works for `sudo -i`, `docker exec -it … bash`, a nested `bash`, and a shell
that replaced the session's own (`exec sh`, reported as `shell-unavailable`): declare it and
go on. A second hop (`ssh` from the remote) is declared again; `tsm declare work none`
takes a declaration back. A partial line someone is typing at its prompt makes a new Run
busy (`human-editing`), or queued until the line is cleared or goes stale; a line they
submitted holds the next Run (`human-submitted`) until their command is seen to end — from the
terminal's foreground where the declared shell runs on this machine (a nested shell, `sudo -i`:
once a job has been seen in front, the shell's own group in front again means done), or after
30 s of quiet where nothing can be seen (`ssh`, whose client holds the foreground throughout).
Cancel inside a
declared shell types `^C`, the end marker and then `^\`: the daemon cannot signal a job
on another machine, and says so.

For an unattended remote command, run `ssh -t host 'cmd'`, or `ssh -tt host 'cmd'` with
`--target process`. A cancel here ends the local ssh client; that is all the daemon can see,
and all `cancelled` means. With `ssh -t` in the shell, terminal cancellation sends an interrupt,
then quit (`^\`); with `ssh -tt` as a process Run, ending ssh hangs the remote command up.
A command that traps or ignores those signals — and the hangup, if the cancel goes on to end
ssh — can run on, and nothing here knows.
Without a terminal (`ssh host 'cmd'`,
or `-T`), the remote command gets neither and runs until it writes to the closed
connection; the status line of such a Run says so. The process target keeps stdout and stderr
apart under `-T` and merges them under `-tt`; ssh's exit status is the remote command's
either way (255 for a connection error). For remote work that must be stoppable and
observable, run a `termd` on the remote machine with a forwarded port: it owns the remote
process group, and across tunnel interruptions you reconnect and `await` the same Run
instead of rerunning an uncertain operation with a fresh key.

## Humans

The GUI is served by `termd` itself (`tsm gui` prints the URL, with the token when one is
configured). It attaches with a snapshot and then streams everything: who holds the seat,
who ran and typed what, each command's exit code. Take the seat to type; observers never
resize or type, and the GUI's emulator never answers terminal queries (the daemon's does).

## Running the daemon

```
termd [--host 127.0.0.1] [--port 3101] [--data-dir ~/.tsm]
      [--tokens-file F.json | --token T | --anonymous <principal>] [--allow-host name]
      [--shell /bin/zsh] [--profile core|full|compat] [--result-text json|transcript]
      [--usage-log F | --no-usage-log]
```

- **Principals.** Loopback without a token runs as `token:local-<user>`. For several
  agents, `--tokens-file` maps tokens to principals (`{"t1": "agent:linn@animalabs.ai"}`,
  mode 0600). The GUI's browser connection is the human (`human:gui:<name>`).
- **Which tools a connection gets.** `--profile` applies to plain MCP hosts only (Claude Code,
  Cursor, the stdio shim): `core` (the default: run, await, read, screen, input, cancel,
  declare_shell and the three session tools), `full` (every tier), `compat` (the 1.x names).
  An MCPL host, such as the agent framework, is not on a profile: its own grant
  (`featureSets/update`) decides its tools and deliveries, so the daemon's `--profile` changes
  nothing for it. Until the grant arrives it has the core tools and no push events, channels or
  presence. The daemon log says which it is for each connection (`initialized: …`), what the
  grant came to (`grant received: … enabled … not enabled …`), and warns when a host has sent
  no grant five seconds after initializing.
- **From 1.x.** A daemon command written for 1.x starts termd: `--headless` is accepted and
  changes nothing (the GUI is at the daemon's address), `SESSION_SERVER_HOST`,
  `SESSION_SERVER_PORT` and `SESSION_SERVER_TOKEN` are read where the `TSM_*` names are not
  set, and `--host localhost` binds 127.0.0.1, the address the shipped configs dial. The 1.x
  frontend's settings (`SESSION_SERVER_URL`, or `SESSION_SERVER_HOST` and `SESSION_SERVER_PORT`,
  and `SESSION_SERVER_TOKEN`) reach the shim the same way; the `mcp.json` row of
  [`next/config/README.md`](config/README.md) says how.
- **Permissions.** termd's own files (journals, logs, keys, the usage log) are owner-only by
  mode whatever the umask. Sessions' shells and process Runs inherit the umask termd was
  started with, so files a session creates get the usual permissions; start termd with the
  mask you want sessions to have (a supervisor's default is 022).
- **Safety.** Only loopback or `--allow-host` names are accepted as Host; a browser Origin
  other than the daemon's own is refused. A non-loopback bind needs a token. Session shells
  never inherit the daemon's credentials or the launching terminal's identity variables.
- **Persistence.** Sessions outlive connections; journals (`~/.tsm/sessions/<id>/`) outlive
  the daemon, and after a restart each old session is readable as `history-only` with its
  in-flight Runs reported `lost` (reason `daemon-restart`). Live processes surviving a restart
  needs the keeper backend (milestone 3): a stopping daemon hangs up each shell as a closing
  terminal does, so its foreground job ends with it, while a job the shell detached on purpose
  (`nohup`, `setsid`, `disown`) lives on; process Runs' groups are ended. The systemd unit sets
  `KillMode=process` so systemd signals termd alone on stop: those detached jobs survive, as they
  would when a terminal closes. `KillMode=mixed` would SIGKILL everything else left in the cgroup
  on every stop, once termd has exited, and take them. What `process` costs: a termd that does not
  exit within the unit's `TimeoutStopSec` is SIGKILLed alone, and the process Runs it had not yet
  ended keep running until the next start's recovery. That ends the groups it can tie to their
  Runs; a group it cannot tell from a stranger's that reused the id is left running, with a note
  in the session's history. With no process listing (no `/proc`, no `ps`) it ends none and says
  so, in each of those Runs' histories and once in the log; a later recovery that can list
  processes judges those groups.
- **Supervision.** `next/config/com.animalabs.termd.plist` (launchd), `next/config/termd.service`
  (systemd). SIGTERM ends sessions cleanly.
- **History on disk.** Kept whole by default; `--retention-bytes` and `--retention-days` cap it
  per session. Whatever the caps, the daemon stops writing history to disk while the data
  directory's filesystem has less than 200 MiB free (`--disk-floor-bytes`; 0 turns it off):
  commands and their results are unaffected, the recent history stays in memory, and while
  the session is live the disk is retried on a timer, idle session or not, so writing resumes
  when space returns; a session closed meanwhile gets one more try as it closes and another
  when a session of that name is next opened, and what is still unwritten then reads as a gap,
  as does what the memory ring had to drop. The daemon's log says when writes stopped and when
  they resumed, and `/health` shows a live session's `journal.coldFailed` meanwhile.
- **Limits and memory.** A session costs about five open files and, idle, about 0.3 MB in
  the daemon plus its shell (about 4 MB); a busy session holds up to 8 MiB of recent history
  in memory (`memoryBytes`) and the rest on disk. The daemon itself is about 170 MB. The
  shipped units raise the open-file limit to 65536 (launchd's default of 256 would end new
  sessions near 45), and the launcher raises it where a supervisor didn't, saying so when the
  hard limit keeps it under 65536. Everything a
  session runs is the daemon's descendant: under systemd, the unit sets `OOMPolicy=continue`
  so a build the kernel kills for memory costs that Run, not every session (the default
  stops the whole service), and on Linux the shells and process Runs start with a raised
  `oom_score_adj` (`--session-oom-score-adj`, default 200), so the kernel takes one of them
  before the daemon. That preference counts against every process on the machine, not the
  daemon alone: on a shared host, where an agent's build should not die before another
  user's work, set it lower or to 0. History on disk is kept forever unless
  `--retention-days` or `--retention-bytes` says otherwise; a long-lived deployment should
  set one.
- **Measure.** Every tool call but the GUI's own successful reads is recorded (names and hashes,
  never contents) in `~/.tsm/usage.jsonl`; `tsm usage` reports per-tool use, errors and confusion
  signatures.

## CLI

`tsm` is the tool table over the same endpoint, `--json` on every command:
`tsm run build 'npm test' --wait 20000`, `tsm await r41`, `tsm read build --since 4812`,
`tsm screen build`, `tsm input build --keys C-c`, `tsm sessions`, `tsm gui`, `tsm usage`.
After `--`, each word is one argument of the command, quoted for the session's shell, so its own
flags and odd characters arrive whole: `tsm run build -- git log --oneline -5`. Flag values take
the type of the tool's parameter; a yes/no flag stands alone (`--queue`, `--force`). Under
`--json` the result is JSON on stdout and a daemon's error is `{"error": …}` on stdout with exit 1;
`tsm`'s own refusals (a usage error, an unknown command, a connection it cannot make) are text on
stderr with exit 1, `--json` or not. `TSM_URL` and `TSM_TOKEN` point it at a daemon.

## Upgrading from 1.x

2.0 ships beside the 1.x session server, MCP bridge, GUI and CLI in this package: one daemon
(`termd`, port 3101) and thin clients (`tsm`, `tsm-shim`). The 1.x binaries
(`terminal-sessions-mcp`, `session-server`, `session-gui`, `session-cli`) are unchanged and run
1.x. When 2.0 becomes the default, `terminal-sessions-mcp` will point at the shim that serves the
1.x tool names (`runCommand`, `tailLogs`, `sendInput`, …; the entry `next/src/shim/compat.ts`, the
tools `next/src/api/compat.ts`), where `runCommand`'s result also says when a command is still
running or queued, and `session-server` at `termd`. Until then the shim serves those names with
`--profile compat` (`TSM_PROFILE=compat`). The GUI is
served by `termd` itself. Nothing reads the 1.x data, which lived only in memory.

## Development

The code is in this directory, `next/`, beside the 1.x sources (`src/`, `cli/`, `gui/`); it
moves to the repository root once 1.x is retired. `npm run test:next` builds and runs 2.0's
suite, `npm test` 1.x's; the design of record and its guarantees are in `docs/redesign/`.

