# Terminal Sessions 2.0

> 2.0 lives in `next/`, beside the 1.x code this package has shipped so far. Both are in the package: `termd`, `tsm` and `tsm-relay` are 2.0; `terminal-sessions-mcp`, `session-server` and `session-cli` are 1.x. 2.0 changes none of 1.x's code. What reaches 1.x is the package they share: a narrower Node range (`engines`), `npm run build` and `npm test` building 2.0 too, and 2.0's two dependencies installing with it. The design discussion is [antra-tess/terminal-sessions-mcp#11](https://github.com/antra-tess/terminal-sessions-mcp/pull/11).

Persistent shells for agents. Each session is your own login shell (bash, zsh or fish) with your startup files, kept alive by a daemon between calls, connections and host restarts. An agent types into it only by explicit calls, gets the exit status, duration and directory of each command `run` types in an integrated shell, with its output, and is woken only when something needs it: a command ended that no call was waiting on, a program is waiting for input, a shell died, or a pattern it asked for appeared.

It speaks MCP to any MCP host, and MCPL to hosts that support it (agent-framework, and Claude Code through `mcpl-cc-bridge`), for the wakes.

## Quick start

```bash
npm install -g term-sessions-mcp     # bins: termd, tsm, tsm-relay
tsm open demo
tsm run demo 'echo hello; pwd'
```

Then connect a host with one of the configurations in [`next/config/`](config/): each launches `tsm-relay` over stdio. Nothing needs to be started first: the first relay or `tsm` that finds no daemon starts one.

## What an agent gets

Eight tools. Every result about a session opens with its status line, such as `[main · command 3 · exit 0 · 1.2 s · at the prompt · /home/u/app]`: the command and how it ended, what is in front of the shell now, and the directory.

| Tool | |
|---|---|
| `open(name, cwd?, cols?, rows?)` | Opens a session. No other tool opens one, so a mistyped name is refused rather than run in a fresh shell. |
| `run(name, command, wait?, notify_on?)` | Runs one command line, only at the prompt; otherwise nothing is typed and the refusal says what is in front. Returns the status and output, or "still running" when the wait ends; on a host that takes wakes, the end is reported when it comes. `notify_on` reports a pattern in its output once: in the result if the command has ended, otherwise as it appears. |
| `send(name, text?, keys?, wait_for?, wait?)` | Types exactly the text and named keys, nothing appended, for a program waiting for input or a full-screen one. Returns the new lines, or the screen, once `wait_for` matches or output is quiet. Arrows follow the cursor-key mode the program set. |
| `look(name, until?, match?, wait?)` | What you haven't seen yet, and what is in front now; with `until: "end"`, `until: "input"` or `match`, after waiting for it. `until: "end"` also returns when a program in front waits for input, since it won't end until answered. |
| `read(name, command?, lines?, match?, context?)` | Earlier output: a command's output by id, a range of lines, or matching lines with context, cut like every result, so long output is read in ranges. |
| `stop(name, signal?)` | Ctrl-C typed to the terminal, so it reaches whatever is in front, a shell's own loop included; then TERM, then KILL to the job in front, each step reported. TERM and KILL never go to the shell. |
| `list()` | Each session, what is in front of it, its directory, and reports you haven't seen. |
| `close(name, force?)` | Hangs up the shell. |

- **Waits** default to 15 s and stop at 55 s, under agent-framework's 60 s deadline for a call. No call holds longer.
- **Long output** keeps its start and its end within 24,000 characters, agent-framework's inline limit for a tool result, and says how to read more: `read` gives a command's output or a range of lines, cut the same way. A single line longer than that is cut in its middle.
- **A full-screen program's screen** fits one result whole when each cell is one UTF-16 unit; wider text (emoji, combining marks) loses top rows, and the result says how many.
- **Wakes** (MCPL, feature set `terminal.events`) carry the status line and the last 20 lines or the screen, one tag each: `terminal:ended`, `terminal:waiting`, `terminal:exited`, `terminal:match`; a match's wake carries its matched line instead. A report no host took stays for `list` and `look`. Plain MCP hosts get no wakes; `look` with `until` is how they wait.
- **Scopes:** the relay's `--scope` names the sessions a host sees, so two agents' `main` are two shells. Two hosts given the same scope share its sessions and their wakes: a wake is pushed to each host not still answering an earlier one, and to a busy one later only if no host has taken it by then.
- **Environment:** every session's shell starts from the daemon's environment, minus the launching terminal's identity, the launcher's state and this package's own variables, and it is the same for every scope. When the shipped unit or launch agent runs the daemon, or a relay starts it as a transient systemd unit, that is the user manager's or launchd's environment, not the relay's; when a relay or `tsm` starts it detached, it is the environment of whichever started it. The shell's startup files run on top of it. Scopes keep sessions apart, not credentials: they are one user's shells.

## What it can't tell

- **A shell without the integration** gives no statuses: it counts as at its prompt once its output is quiet and it waits at the terminal (its line editor holds it, or the shell reads it itself), and a command's status is "unknown". Inside an `ssh` someone typed, what is in front is `ssh`, and what is typed there gets no statuses either. For statuses on another machine, run the relay there: `ssh box tsm-relay --scope NAME`.
- **A command typed through `send` that removes both the session's prompt hook and its prompt mark** (`unset PROMPT_COMMAND; PS1="> "` in bash, `precmd_functions=(); PS1="> "` in zsh) leaves the session unable to see its prompt: it shows the shell itself running and refuses `run`. `close` the session and `open` it again. A command given to `run` in bash or zsh gets the hooks put back after it. A command typed through `send` that removes only the prompt hook leaves the prompt seen, with that command's status unknown.
- **Waiting for input** is the kernel's evidence: on Linux, a program blocked reading this terminal. A program that waits in `poll`, such as Python's REPL or `ssh`, shows as running. macOS shows no such evidence, so there it is always "running", and the status line says it can't tell.
- **End marks** carry a chained nonce: a mark's counter is spent once used, so output that replays an old mark is refused. A program that reads the shell's own variables can print a mark with the live nonce, deliberately, and is not defended against.
- **A daemon restart ends every shell.** A host that reconnects is told no session it names is open.
- **In zsh, a heredoc left without its terminator** in a command given to `run` takes the session's own lines after it as its body: they print, or go into the file the heredoc writes, and the hooks aren't put back after that command.
- **In bash, while a command given to `run` runs,** its RETURN trap is the session's, which keeps the pipeline's statuses. `trap -p RETURN` shows it there, and the shell's own trap comes back afterwards.

## Running the daemon

One daemon per user holds every shell, on a Unix socket in a directory only you can enter: `$XDG_RUNTIME_DIR/terminal-sessions/daemon.sock`; where that variable isn't set, `/run/user/<uid>/terminal-sessions/daemon.sock` on Linux when that directory is yours alone; otherwise `/tmp/terminal-sessions-<uid>/daemon.sock`. A relay that finds none starts one: on Linux, as a transient systemd user unit where one can be started, so the daemon outlives a host whose service stops; elsewhere, or where `systemd-run` fails, detached, in the starter's control group, with its output in `daemon.log` beside the socket. To keep it up across crashes and logins, install `next/config/termd.service` (systemd) or `next/config/com.animalabs.termd.plist` (launchd).

`tsm daemon stop` stops it, ending every shell, and returns once its socket no longer answers. Under the shipped launch agent, launchd starts it again (`KeepAlive`); `launchctl bootout gui/$(id -u)/com.animalabs.termd` stops it for good. `termd --session-oom-score-adj N` sets how strongly the kernel prefers a session's processes over the daemon when memory runs out (default 200; 0 leaves it alone).

## CLI

`tsm [--scope NAME] COMMAND` calls the same eight tools: `tsm run main make test --wait 30`, `tsm look main --until end`, `tsm list`. `run`'s command is one argument as typed (`tsm run main 'make test | tee log'`), or several words, each quoted for the shell; put `--` before words that start with `--`. Use the agent's scope to see its sessions. Nothing `tsm` is shown counts as seen, so the agent is still told of it. `tsm --help` lists the rest.

## Development

```bash
npm run build:next && npm run test:next     # 2.0's specs
npm run acceptance:af                       # against agent-framework's host code (AGENT_FRAMEWORK=/path/to/built/checkout)
```
