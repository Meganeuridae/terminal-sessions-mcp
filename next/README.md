# Terminal Sessions 2.0

> 2.0 lives in `next/`, beside the 1.x code this package has shipped so far. Both are in the package: `termd`, `tsm` and `tsm-relay` are 2.0; `terminal-sessions-mcp`, `session-server` and `session-cli` are 1.x. 2.0 changes none of 1.x's code. What reaches 1.x is the package manifest they share: a narrower Node range (`engines`). The design discussion is [antra-tess/terminal-sessions-mcp#11](https://github.com/antra-tess/terminal-sessions-mcp/pull/11).

Persistent shells for agents. Each session is your own login shell (bash, zsh or fish) with your startup files, kept alive by a daemon between calls, connections and host restarts. An agent types into it only by explicit calls, gets each command's exit status, duration and directory with its output, and is woken only when something needs it: a command ended that no call was waiting on, a program is waiting for input, a shell died, or a pattern it asked for appeared.

It speaks MCP to any MCP host, and MCPL to hosts that support it (agent-framework, and Claude Code through `mcpl-cc-bridge`), for the wakes.

## Quick start

```bash
npm install -g term-sessions-mcp     # bins: termd, tsm, tsm-relay
tsm open demo
tsm run demo 'echo hello; pwd'
```

Then connect a host with one of the configurations in [`next/config/`](config/): each launches `tsm-relay` over stdio. Nothing needs to be started first: the first relay or `tsm` that finds no daemon starts one.

## What an agent gets

Eight tools. Every result opens with one status line, such as `[main · command 3 · exit 0 · 1.2 s · at the prompt · /home/u/app]`: the command and how it ended, what is in front of the shell now, and the directory.

| Tool | |
|---|---|
| `open(name, cwd?, cols?, rows?)` | Opens a session. No other tool opens one, so a mistyped name is refused rather than run in a fresh shell. |
| `run(name, command, wait?, notify_on?)` | Runs one command line, only at the prompt; otherwise nothing is typed and the refusal says what is in front. Returns the status and output, or "still running" when the wait ends, and the end is reported when it comes. `notify_on` reports a pattern in its output once. |
| `send(name, text?, keys?, wait_for?, wait?)` | Types exactly the text and named keys, nothing appended, for a program waiting for input or a full-screen one. Returns the new lines, or the screen, once `wait_for` matches or output is quiet. Arrows follow the cursor-key mode the program set. |
| `look(name, until?, match?, wait?)` | What you haven't seen yet, and what is in front now; with `until: "end"`, `until: "input"` or `match`, after waiting for it. |
| `read(name, command?, lines?, match?, context?)` | Earlier output: a command's whole output by id, a range of lines, or matching lines with context. |
| `stop(name, signal?)` | Ctrl-C, then TERM, then KILL to the job in front, each step reported; never the shell itself. |
| `list()` | Each session, what is in front of it, its directory, and endings you haven't seen. |
| `close(name, force?)` | Hangs up the shell. |

- **Waits** default to 15 s and stop at 55 s, under agent-framework's 60 s deadline for a call. No call holds longer.
- **Long output** keeps its start and its end within 24,000 characters, agent-framework's inline limit for a tool result, and says how to read the rest.
- **Wakes** (MCPL, feature set `terminal.events`) carry the status line and the last 20 lines or the screen, one tag each: `terminal:ended`, `terminal:waiting`, `terminal:exited`, `terminal:match`. An ending no host took stays for `list` and `look`. Plain MCP hosts get no wakes; `look` with `until` is how they wait.
- **Scopes:** the relay's `--scope` names the sessions a host sees, so two agents' `main` are two shells.

## What it can't tell

- **A shell without the integration** gives no statuses: it counts as at its prompt once its output is quiet and it waits at the terminal (its line editor holds it, or the shell reads it itself), and a command's status is "unknown". Inside an `ssh` someone typed, what is in front is `ssh`, and what is typed there gets no statuses either. For statuses on another machine, run the relay there: `ssh box tsm-relay --scope NAME`.
- **A command typed through `send` that removes both the session's prompt hook and its prompt mark** (`PROMPT_COMMAND=; PS1="> "` in bash, `precmd_functions=(); PS1="> "` in zsh) leaves the session unable to see its prompt: it shows the shell itself running and refuses `run`. `close` the session and `open` it again. A command given to `run` gets the hooks put back after it. A command typed through `send` that removes only the prompt hook leaves the prompt seen, with that command's status unknown.
- **Waiting for input** is the kernel's evidence: on Linux, a program blocked reading this terminal. A program that waits in `poll`, such as Python's REPL or `ssh`, shows as running. macOS shows no such evidence, so there it is always "running", and the status line says it can't tell.
- **End marks** carry a chained nonce: a mark's counter is spent once used, so output that replays an old mark is refused. A program that reads the shell's own variables can print a mark with the live nonce, deliberately, and is not defended against.
- **A daemon restart ends every shell.** A host that reconnects is told no session it names is open.

## Running the daemon

One daemon per user holds every shell, on a Unix socket in a directory only you can enter: `$XDG_RUNTIME_DIR/terminal-sessions/daemon.sock`; where that variable isn't set, `/run/user/<uid>/terminal-sessions/daemon.sock` on Linux when that directory is yours alone; otherwise `/tmp/terminal-sessions-<uid>/daemon.sock`. A relay that finds none starts one: on Linux, as a transient systemd user unit where one can be started, so the daemon outlives a host whose service stops; elsewhere detached. To keep it up across crashes and logins, install `next/config/termd.service` (systemd) or `next/config/com.animalabs.termd.plist` (launchd).

`tsm daemon stop` stops it, ending every shell. `termd --session-oom-score-adj N` sets how strongly the kernel prefers a session's processes over the daemon when memory runs out (default 200; 0 leaves it alone).

## CLI

`tsm [--scope NAME] COMMAND` calls the same eight tools: `tsm run main make test --wait 30`, `tsm look main --until end`, `tsm list`. Use the agent's scope to see its sessions. Nothing `tsm` is shown counts as seen, so the agent is still told of it. `tsm --help` lists the rest.

## Development

```bash
npm run build:next && npm run test:next     # 2.0's specs
npm run acceptance:af                       # against agent-framework's host code (AGENT_FRAMEWORK=/path/to/built/checkout)
```
