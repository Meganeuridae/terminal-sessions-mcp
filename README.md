# Terminal Sessions

Persistent terminal sessions for agents and humans: a daemon that keeps shells alive,
tracks observed command boundaries and outcomes, retains output in a journal you can page
through by cursor, and tells a host when something it cares about happens. When completion
evidence is lost, the outcome is reported as unknown.
Several agents and humans can share a session, with provenance on every keystroke and one
explicit controller at a time.

It speaks MCP to any MCP host and MCPL (MCP plus a live lane: channels, push events,
presence) to hosts that support it — agent-framework (connectome) and Claude Code through
`mcpl-cc-bridge`. The design, and the guarantees everything here is tested against, are in
[`docs/redesign/DESIGN.md`](docs/redesign/DESIGN.md).

## Quick start

```bash
npm install -g term-sessions-mcp     # bins: termd, tsm, tsm-shim
termd                                 # ws://127.0.0.1:3101 · GUI at http://127.0.0.1:3101/
tsm run demo 'echo hello; pwd'        # exit code = the command's; 2 while still running
```

On macOS and Linux, process Runs use `/bin/bash` to close inherited descriptors before
executing the command. Command text itself runs in `/bin/sh`.

Then connect a host (configurations in [`next/config/`](next/config/)):

- **Claude Code with `mcpl-cc-bridge`**: add the `terminal` entry from
  `next/config/mcpl-bridge.json` to your bridge config, and allow
  `mcp__plugin_mcpl-bridge_mcpl__terminal__*`. Completions, questions and watch firings wake
  the session; progress is held.
- **agent-framework**: the `mcplServers` entry from `next/config/agent-framework.recipe.json` and
  the gate policies from `next/config/agent-framework.gate.json`.
- **Any MCP host** (Cursor, Claude Desktop, Claude Code without the bridge):
  `next/config/mcp.json` — the stdio shim starts `termd` if nothing is listening, unless a
  termd launchd job or systemd user unit exists (then it is the supervisor's to start, and the
  shim waits for it) or `TSM_NO_SPAWN=1` says never to. With a supervisor unit of your own
  name, set `TSM_NO_SPAWN=1` in the shim's configuration.

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

Every result has two renderings: a readable transcript closed by one status line —
`[run r4-1a2b exited 1 in 8.2s · shell · cwd /w/app · next=4990]` — and a structured
envelope (`structuredContent`) whose `state` is the only authority on whether a command
finished. The exit is the shell's own; for a pipeline the result also carries each command's
status (`pipeStatus`), and the status line says when one before the last failed, since
`make | tee log` exits as `tee` did. The text block is the transcript when the connection asks for it
(`TSM_RESULT_TEXT=transcript` for the shim, `?resultText=transcript` on the URL; the
shipped configs set it) and the envelope as JSON otherwise — the default, for hosts whose
scripts parse tool text (agent-framework's code execution). Opt-in tiers: `terminal.control` (`signal`, `control`, `resize`,
`session_env_capture`), `terminal.services` (`start` with readiness and health probes),
`terminal.watch` (`watch`, `wait_for`), `terminal.search` (`search`). Mutating tools take an
`idempotencyKey` (a fresh UUID per operation): a retry returns the first outcome instead of
running twice, also across a daemon restart for `run` and `start`.

A result `lost` means the daemon could not observe the command's end and refuses to
guess (DESIGN G3); the reason says why. The common self-inflicted one is `shell-exited
(status N)`: the shell running the command exited under it. That happens when a command
runs `exit`, or when `set -e` is on in the session shell and a command fails. `set -e` is
for scripts. In a session shell, where every Run already reports its own exit status, it
only arms a trap: it stays on, and every later failing command ends the whole shell and the
state in it. Keep it inside the script or a subshell (`(set -e; …)`), never in the session
shell; the result of a Run that turns it on says so.

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

The result of the `ssh` command itself says that it looks like it opened a shell and points
at the declaration; the kind of shell only needs naming for fish (`tsm declare work fish`).

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
busy (`human-editing`), or queued until the line is cleared or goes stale. Cancel inside a
declared shell types `^C`, the end marker and then `^\\`: the daemon cannot signal a job
on another machine, and says so.

For an unattended remote command, run `ssh -t host 'cmd'`, or `ssh -tt host 'cmd'` with
`--target process`. A cancel here ends the local ssh client; that is all the daemon can see,
and all `cancelled` means. With `ssh -t` in the shell, terminal cancellation sends an interrupt,
then quit (`^\\`); with `ssh -tt` as a process Run, ending ssh hangs the remote command up.
A command that traps or ignores those signals can run on, and nothing here knows.
Without a terminal (`ssh host 'cmd'`,
or `-T`), the remote command gets neither and runs until it writes to the closed
connection; the result of such a Run says so. The process target keeps stdout and stderr
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
  frontend's settings reach the shim the same way (`tsm-shim --help`).
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
  needs the keeper backend (milestone 3).
- **Supervision.** `next/config/com.animalabs.termd.plist` (launchd), `next/config/termd.service`
  (systemd). SIGTERM ends sessions cleanly.
- **History on disk.** Kept whole by default; `--retention-bytes` and `--retention-days` cap it
  per session. Whatever the caps, the daemon stops writing history to disk while the data
  directory's filesystem has less than 200 MiB free (`--disk-floor-bytes`; 0 turns it off):
  commands and their results are unaffected, the recent history stays in memory, writing resumes
  when space returns, and what the memory ring had to drop meanwhile reads as a gap.
- **Limits and memory.** A session costs about five open files and, idle, about 0.3 MB in
  the daemon plus its shell (about 4 MB); a busy session holds up to 8 MiB of recent history
  in memory (`memoryBytes`) and the rest on disk. The daemon itself is about 170 MB. The
  shipped units raise the open-file limit to 65536 (launchd's default of 256 would end new
  sessions near 45), and the launcher raises it where a supervisor didn't. Everything a
  session runs is the daemon's descendant: under systemd, the unit sets `OOMPolicy=continue`
  so a build the kernel kills for memory costs that Run, not every session (the default
  stops the whole service), and on Linux the shells and process Runs start with a raised
  `oom_score_adj` (`--session-oom-score-adj`, default 200), so the kernel takes one of them
  before the daemon. That preference counts against every process on the machine, not the
  daemon alone: on a shared host, where an agent's build should not die before another
  user's work, set it lower or to 0. History on disk is kept forever unless
  `--retention-days` or `--retention-bytes` says otherwise; a long-lived deployment should
  set one.
- **Measure.** Every tool call is recorded (names and hashes, never contents) in
  `~/.tsm/usage.jsonl`; `tsm usage` reports per-tool use, errors and confusion signatures.

## CLI

`tsm` is the tool table over the same endpoint, `--json` on every command:
`tsm run build 'npm test' --wait 20000`, `tsm await r41`, `tsm read build --since 4812`,
`tsm screen build`, `tsm input build --keys C-c`, `tsm sessions`, `tsm gui`, `tsm usage`.
`TSM_URL` and `TSM_TOKEN` point it at a daemon.

## Upgrading from 1.x

2.0 replaces the 1.x session server, MCP bridge, GUI and CLI with one daemon (`termd`, port
3101) and thin clients. The old binary names still work: `terminal-sessions-mcp` is the stdio
shim and serves the 1.x tool names (`runCommand`, `tailLogs`, `sendInput`, …) for one release,
with results that also say whether a command is still running; `session-server` starts
`termd`. The GUI is served by `termd` itself. Nothing reads the 1.x data, which lived only in
memory.

## Development

The code is in [`next/`](next/README.md) (the 2.0 tree; it moves to the repository root once
1.x is retired). `npm test` builds and runs every suite; the design of record and its
guarantees are in `docs/redesign/`.

