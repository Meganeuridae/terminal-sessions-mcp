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

Then connect a host (configurations in [`next/config/`](next/config/)):

- **Claude Code with `mcpl-cc-bridge`**: add the `terminal` entry from
  `next/config/mcpl-bridge.json` to your bridge config, and allow
  `mcp__plugin_mcpl-bridge_mcpl__terminal__*`. Completions, questions and watch firings wake
  the session; progress is held.
- **agent-framework**: the `mcplServers` entry from `next/config/agent-framework.recipe.json` and
  the gate policies from `next/config/agent-framework.gate.json`.
- **Any MCP host** (Cursor, Claude Desktop, Claude Code without the bridge):
  `next/config/mcp.json` — the stdio shim starts `termd` if nothing is listening.

## What an agent gets

Nine core tools, one verb each (DESIGN §11, §11.1):

| Tool | Use it to |
|---|---|
| `run` | run a command in a session's persistent shell (or `target: process`) and wait up to `wait` ms; a command still running comes back with its `runId` and keeps running |
| `await` | keep waiting for a `runId` |
| `read` | page through history by cursor (`since`), one command's output (`runId`), or the last lines (`tail`) |
| `screen` | see what the terminal shows now (TUIs) |
| `input` | type text and named keys, nothing appended |
| `cancel` | stop a Run: queued → dropped; process → SIGINT/TERM/KILL; shell → ^C, ^\, then the foreground job |
| `session_list`, `session_open`, `session_close` | manage sessions |

Every result has two renderings: a readable transcript closed by one status line —
`[run r4-1a2b exited 1 in 8.2s · shell · cwd /w/app · next=4990]` — and a structured
envelope (`structuredContent`) whose `state` is the only authority on whether a command
finished. The text block is the transcript when the connection asks for it
(`TSM_RESULT_TEXT=transcript` for the shim, `?resultText=transcript` on the URL; the
shipped configs set it) and the envelope as JSON otherwise — the default, for hosts whose
scripts parse tool text (agent-framework's code execution). Opt-in tiers: `terminal.control` (`signal`, `control`, `resize`,
`session_env_capture`), `terminal.services` (`start` with readiness and health probes),
`terminal.watch` (`watch`, `wait_for`), `terminal.search` (`search`). Mutating tools take an
`idempotencyKey` (a fresh UUID per operation): a retry returns the first outcome instead of
running twice, also across a daemon restart for `run` and `start`.

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
When `ssh` exits — the remote `exit`, or a dropped connection — the declaration ends with it:
the next `run` is in the session's own shell again, a note in the session's history says
so, and a command that was in flight ends `lost` with that reason rather than being guessed
at. The same works for `sudo -i`, `docker exec -it … bash`, a nested `bash`, and a shell
that replaced the session's own (`exec sh`, reported as `shell-unavailable`): declare it and
go on. A second hop (`ssh` from the remote) is declared again; `tsm declare work none`
takes a declaration back. Cancel inside a declared shell types `^C` and the end marker and
nothing more: the daemon cannot signal a job on another machine, and says so.

For an unattended remote command, run `ssh -T host 'cmd'` with `--target process`: separate
stdout and stderr, and ssh's exit status (the remote command's, or 255 for a connection
error). A `termd` on the remote machine with a forwarded port keeps full semantics across
tunnel interruptions: reconnect and `await` the same Run instead of rerunning an uncertain
operation with a fresh key.

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
- **Safety.** Only loopback or `--allow-host` names are accepted as Host; a browser Origin
  other than the daemon's own is refused. A non-loopback bind needs a token. Session shells
  never inherit the daemon's credentials or the launching terminal's identity variables.
- **Persistence.** Sessions outlive connections; journals (`~/.tsm/sessions/<id>/`) outlive
  the daemon, and after a restart each old session is readable as `history-only` with its
  in-flight Runs reported `lost` (reason `daemon-restart`). Live processes surviving a restart
  needs the keeper backend (milestone 3).
- **Supervision.** `next/config/com.animalabs.termd.plist` (launchd), `next/config/termd.service`
  (systemd). SIGTERM ends sessions cleanly.
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

