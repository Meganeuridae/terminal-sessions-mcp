# Terminal Sessions — Rearchitecture Proposal

**Status:** Proposal, draft 1 — not yet reviewed
**Targets:** successor to `terminal-sessions-mcp` (npm `term-sessions-mcp` 1.6.0); MCPL SPEC.md 0.5.0-draft; agent-framework host
**Authors:** Claude Code (Fable 5.1), with Aster
**Date:** 2026-09-16
**Depends on:** MCPL SPEC §5.4 (grants), §9 (push), §10 (hooks), §14 (channels), §16 (tags), §17 (manifest); RFC-001; RFC-002
**Companion:** AUDIT-001 (spec vs. implementations); the review of the current codebase and its open PRs (2026-09-16, in the terminal-sessions-mcp clone's local `CLAUDE.md`)

**Review history.** None yet. Written independently, before seeing the Codex designs Aster
collected, so the two can be compared rather than merged prematurely. antra's brief, relayed
by Aster: terminal sessions is the oldest part of the stack and needs to be rearchitected
from the ground up to be more extensible, better built, and suited to high-capability
workflows.

---

## 1. Summary

A terminal server for agents is a **presence substrate**: the agent acts in a shell and
stays present to what happens there, over long horizons, alongside humans and other agents.
The current system was extracted from a testing harness and is shaped by three habits that
work against that: it is *polling-shaped* (`tailLogs`), *scraping-shaped* (an exit marker
typed into the PTY, regex cleaning of escape codes), and *fragile* (the daemon is the only
thing keeping every shell alive, so an upgrade kills every agent's session).

This proposal makes three moves:

1. **A journal, not a log.** Every session has an append-only, sequence-numbered, typed
   event journal — output bytes, input with provenance, command boundaries, exit codes, cwd
   changes, screen-mode changes, signals, exit. Everything an agent or human reads is a
   *view* over the journal. Nothing is scraped after the fact.
2. **Truth from the shell, not from heuristics.** Shell integration marks (the OSC 133
   convention terminals already use, plus OSC 7 for cwd) give command boundaries and exit
   codes for *every* command regardless of who typed it, and a real session state machine
   (idle / running / TUI / exited). A headless terminal emulator gives the *screen* as text.
   The marker mechanism survives only as a fallback for shells without integration.
3. **One daemon, one protocol, an event lane.** The daemon speaks MCP+MCPL directly over
   WebSocket; the CLI, the GUI and a stdio shim are thin clients of it. Sessions are MCPL
   channels. Output reaches hosts as *segmented, tagged messages* — a finished command, a
   batch of streaming output, a TUI screen, a watch firing — and the host's gate decides
   what wakes the agent. A `beforeInference` injection keeps a one-line status board of the
   agent's terminals in front of it every turn.

Durability across daemon restarts comes from a pluggable backend: an optional per-session
keeper process holds the PTY so the daemon can be upgraded without killing shells.

---

## 2. What the current system gets right, and what to keep

The macro shape is correct and is retained: a long-lived daemon owns the PTYs; clients are
thin; the daemon already emits a real event stream (output, command start/finish, input,
signal, exit) with subscription fan-out. The named-keys vocabulary (`keys: ["C-c"]`), the
temp-file route for multi-line input (issue #3), and the exec-marker hardening in PR #7
are all sound and carry over as pieces.

What does not carry over: the hand-rolled MCP loop; the socket.io+express GUI server;
puppeteer screenshots via the daemon's own GUI; two divergent client classes; line-array
logs plus a separate raw buffer; regex ANSI cleaning as the primary text path; a session
model whose cwd is the *initial* cwd forever; "timeout means the command is left running
and you get exit code −1".

---

## 3. Goals and non-goals

**Goals**

- **Persistent.** Sessions survive host restarts (already true), agent restarts, and daemon
  upgrades (new, via the keeper backend).
- **Truthful.** Command boundaries, exit codes, cwd and busy/idle state are known for every
  command, whoever typed it.
- **Live.** Output reaches hosts as tagged events with sensible segmentation. TUIs are
  delivered as screens, not escape soup. Nothing requires polling.
- **Shared.** Several principals (agents, humans, other hosts) can act in one session with
  provenance on every input, and ownership rules that keep them from surprising each other.
- **One protocol.** MCP+MCPL is the only API. Everything else is a client.
- **Extensible at named seams.** Backends (where a shell runs), shells (integration
  scripts), segmenters and tag emitters, journal stores, renderers, tool packs.
- **Testable.** The core has no network and no PTY dependency; a scripted backend replays
  recorded transcripts for deterministic tests. Real-PTY tests run per shell.
- **Operable.** One supervised daemon per machine, loopback + token today, `aid1` tomorrow,
  a health endpoint that reports session states.

**Non-goals (v1)**

- Not a terminal multiplexer for humans (no windows/panes/layouts). tmux exists.
- Not a sandbox. Access control is per-session ownership, not isolation.
- Not a fleet controller. Multi-machine is addressed by addressing, not by federation.
- Not a recorder of *everything forever*. The journal has retention.

---

## 4. Conceptual model

### 4.1 Node, session, terminal

- A **node** is one daemon on one machine. Sessions are addressed as `{ node, session }`;
  the channel id is `terminal:<session>` with `node` in the descriptor `address`, following
  the org's `<surface>:<…>` convention.
- A **session** is a named shell with a lifecycle, an owner, a visibility, and exactly one
  **terminal**: a PTY, a headless emulator (the screen), and a journal.
- Sessions are created explicitly (`session_open`) or implicitly by `run` on an unknown
  name; the result says `created: true` so the agent knows.

### 4.2 The journal and its views

The journal is the source of truth. Events are typed, timestamped, and carry a monotonic
`seq` (Appendix A). Two stores, same interface: an in-memory ring bounded by bytes
(default 8 MiB per session) and an append-only file per session under the data dir, with
rotation. A chronicle-backed store is a natural later option — the shape is already
"append-only records with causation" — but the daemon must not depend on chronicle.

Views are pure functions over a journal range and are what tools and channels deliver:

| View | What it answers |
|---|---|
| `text(from, to)` | Clean text for a byte range, produced by *replaying* the range through a fresh headless emulator sized like the session — carriage-return overwrites, cursor motion and colour all resolve the way a human would have seen them. Replaces regex ANSI cleaning. |
| `commands(filter)` | Structured history: `{cmdId, line, cwd, startedAt, exit, durationMs, origin, seq:[c,d]}`. |
| `screen()` | The live emulator buffer: `{cols, rows, alt, cursor, lines, title}`. |
| `tail(n)` / `since(seq)` | Paging with cursors, so an agent never re-reads what it has seen. |
| `search(re, window)` | Over rendered text, returning `seq` anchors, not line numbers. |

### 4.3 Marks: shell integration

At session start the daemon injects shell integration for the detected shell without
replacing the user's rc files (bash via a wrapper rcfile that sources the user's; zsh via a
`ZDOTDIR` shim; fish via events — the technique VS Code, WezTerm and Kitty use). The
integration emits:

- `OSC 133 ; A` prompt start, `B` command start, `C` output start, `D ; <exit>` command end
- `OSC 7 ; file://host/path` on every prompt (cwd)
- the command line text on `B` (the VS Code `633;E` extension), so the journal records
  *what* a human typed, not only that they typed

The journal parser turns these into `command.start`, `command.end`, `prompt` and `cwd`
events. If no `A` mark arrives within a grace period, the session is flagged
`integration: none` and the fallback exec strategy (§9) is used; state is then known only
for commands the daemon itself issued.

### 4.4 Session state machine

```
starting ──► idle ◄──────────────► running ──► exited
              ▲                       │
              └── prompt (D or A) ◄───┘   running + alt-screen ⇒ "tui"
```

State is derived from marks, the emulator's alternate-screen flag, and PTY exit. It is what
makes `run` safe: a `run` against a `running` session returns `status: "busy"` with the
running command's id instead of silently queueing behind it (opt-in `queue: true` keeps the
old behaviour). It is also what `beforeInference` reports (§5.4).

### 4.5 Principals and ownership

Every connection resolves to a principal at the transport: a named token today, an `aid1`
identity (`agent:<name>@<domain>`, `human:discord:<id>`) when archipelago-home lands. GUI
users are principals too. Every `input`, `signal`, `run` and `resize` journal event carries
its principal. Sessions have an `owner` and `visibility: private | shared`: anyone who can
see a session can read it; only the owner, or anyone when shared, can act in it. This is
deliberately minimal; it is provenance and a guard rail, not an ACL system.

### 4.6 Watches

A watch is a standing predicate over one session's journal that produces a tagged event
when it fires: `pattern` (regex over rendered text), `silence` (no output for N s),
`exit` (a command or the session ends), `idle` (shell returned to prompt). Watches live in
the daemon, not in the MCPL layer, so they work for any client and survive host reconnects.
`once` watches self-remove.

---

## 5. The host lane (MCPL)

### 5.1 Channels

Each session is a bidirectional channel. Descriptor:

```jsonc
{ "id": "terminal:build", "type": "terminal", "label": "build (node: mbp)",
  "direction": "bidirectional",
  "address": { "node": "mbp", "session": "build" },
  "metadata": { "owner": "agent:linn@animalabs.ai", "state": "running", "cwd": "/w/app" },
  "initiallyOpen": false,
  "capabilities": { "history": { "maxMessages": 500, "supportsBeforeMessage": true } } }
```

Registered on connect (`channels/register`, itemised results honoured), added and removed
with `channels/changed` as sessions come and go. `channels/open` returns the recent journal
rendered as messages (backscroll ≤ 500, the host's clamp). `channels/publish` types into the
session: text plus optional `metadata.keys` using the existing named-key vocabulary, Enter
appended by default. Open/close is host-owned; the daemon keeps a per-connection delivered
watermark for catch-up after reconnect, the pattern discord-mcpl and portal-mcpl use.

### 5.2 Segmentation: from bytes to messages

A **segmenter** turns journal events into channel messages. It is a pluggable module with
one default policy:

| Segment | When | Content | Tags |
|---|---|---|---|
| command | `command.end` | header `$ <line> → exit N (1.2s, cwd)` + rendered output, capped (16 KiB) with `seq` range for `read` | `terminal:command-finished`, `terminal:exit=ok\|nonzero\|signal`, `terminal:origin=self\|human\|agent\|system` |
| output | while running, every 1 s or 4 KiB | rendered delta | `terminal:output`, `terminal:running` |
| screen | in alt-screen, 500 ms after the last change | full screen text | `terminal:screen` |
| idle | prompt returned without a tracked command (e.g. after `^C`) | one line | `terminal:idle` |
| needs-input | running, silent ≥ 5 s, last line unterminated and prompt-like | last lines | `terminal:needs-input` (heuristic, says so) |
| watch | a watch fires | matched text / silence notice | `terminal:watch=<label>`, `terminal:silence`, `terminal:pattern` |
| lifecycle | session exit | exit code | `terminal:session-exited` |
| human input | a human principal typed | the input line | `terminal:human-input`, `chat:from-human` |

`metadata` on every message is structured: `{ node, session, state, cwd, cmdId?, exit?,
seq: [from, to] }`. Messages are batched per `channels/incoming` request within the
segmenter's window; closed channels get `push/event` with a *flat* `origin` including
`mcplChannelId`, per the host's routing requirement.

### 5.3 Tag ontology

Declared on the `terminal.live` feature set, `open: true`. `terminal:*` is the producer
namespace; only sender-facet `chat:*` core tags are reused (`chat:from-human`,
`chat:from-agent`, `chat:from-self`) so portable "from a human" rules work. No terminal
event claims `chat:addressed`; whether a finished command deserves the agent's attention is
the consumer's rule, per RFC-001.

Suggested treatment (advisory, requires acceptance):

```jsonc
[ { "tagsAny": ["terminal:needs-input", "terminal:watch=*", "terminal:session-exited"], "behavior": "immediate" },
  { "tagsAny": ["terminal:command-finished"], "behavior": "immediate" },
  { "tagsAny": ["terminal:screen"], "behavior": "throttle" },
  { "tagsAny": ["terminal:output"], "behavior": "throttle" } ]
```

### 5.4 Presence injection

`context/beforeInference` → one `beforeUser` injection, namespace `terminal`, for the
connection's open channels, under ~10 lines:

```
[terminal] build: running `npm test` 34s, cwd /w/app, 2.1 KiB unread since seq 4812
[terminal] shell: idle, cwd /w/app, last: `git status` → 0
[terminal] htop: tui (alternate screen), 3 screens unread
```

No `observe`; the server never reads the user's message. This is the "present while
acting" primitive: the agent knows the state of its terminals every turn without a tool
call. Gated on `contextHooks.beforeInference.inject.beforeUser`, which the host grants
separately from `system`.

### 5.5 Feature sets

| Feature set | `uses` |
|---|---|
| `terminal.sessions` | `tools`, `channels.register`, `channels.lifecycle` |
| `terminal.exec` | `tools` |
| `terminal.observe` | `tools` |
| `terminal.live` | `channels.incoming`, `channels.publish`, `pushEvents`, `channels.acknowledge` |
| `terminal.watch` | `tools`, `channels.incoming`, `pushEvents` |
| `terminal.presence` | `contextHooks.beforeInference.inject.beforeUser` |

`uses` is exhaustive and fail-closed (SPEC §6.4). `featureSets/update` is answered as a
Request with a degradation receipt; nothing is delivered before the initial policy arrives
(discord-mcpl documents the outage that rule prevents). The manifest carries a §17.2
revision computed by `@animalabs/mcpl-core`.

---

## 6. Tools

All tools take `session` (name) and return structured results; output text is capped with
a `seq` range for paging. `wait` values are bounded below the host's 60 s request timeout,
which is what turns "timeout" from a failure into an ordinary "still running".

| Tool | Purpose | Result |
|---|---|---|
| `session_list` | sessions with state, cwd, owner, last command | `[{…}]` |
| `session_open` | create or attach: `cwd`, `shell`, `env`, `visibility` | `{created, state}` |
| `session_close` | graceful (SIGHUP) or force | |
| `run` | write a command line; `wait` ms (default 20 000) for completion | `{status: completed\|running\|busy, cmdId, exit?, durationMs?, cwd, output:{text, truncated, seq}}` |
| `start` | `run` that returns on a ready/error pattern or after `wait`; process keeps running | `{status: ready\|error\|running, cmdId}` |
| `wait` | block up to `wait` ms for `{cmdId}` \| `{idle}` \| `{pattern}` \| `{silenceMs}` | same shape as `run` |
| `input` | text + `keys` (bracketed paste for multi-line where supported) | |
| `signal` | `SIGINT` as `^C`, others via the PTY | |
| `read` | journal: `tail`, `since`, `until`, `as: text\|commands\|events`, `maxBytes` | `{items, seq:[from,to], more}` |
| `screen` | live screen text, cursor, dims, alt flag, title | |
| `search` | regex over rendered text with `seq` anchors and context | |
| `watch` / `unwatch` / `watches` | §4.6 | |
| `resize` | cols/rows | |
| `snapshot` | optional: render the screen to SVG/PNG from the emulator buffer (no browser) | image block |

A compatibility pack (`runCommand`, `tailLogs`, `searchLogs`, `sendInput`, `sendSignal`,
`listSessions`, `killSession`, `launch`) is provided for one release so existing recipes
keep working; it maps onto the tools above and is deleted in the release after.

---

## 7. Process topology

```
 agent-framework hosts            Cursor / Claude Desktop / Claude Code        humans
   │ MCPL over wss (?token / aid1)     │ stdio                                 │ https
   │                                    ▼                                       ▼
   │                          terminal-sessions-mcp (shim: stdio ↔ ws proxy)  browser GUI
   ▼                                    │                                       │
┌──────────────────────────────── termd — one per node ────────────────────────────────┐
│ transport/  ws server (JSON-RPC 2.0: MCP + MCPL + terminal/* client methods), static GUI│
│ api/        tools · channels · presence hook · tags · manifest · compat pack          │
│ policy/     principals · session ownership · per-connection watermarks               │
│ core/       Session FSM · Journal + views · Screen (emulator) · Marks · Exec · Watches │
│             Segmenter                                                                  │
│ backends/   pty (node-pty, in-process) · keeper (durable, unix socket) · scripted      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **termd** is the daemon: supervised by launchd/systemd as today, loopback + token by
  default, `aid1` when available. It serves the GUI's static files itself; the GUI is a
  browser client speaking the same WebSocket JSON-RPC. socket.io and express go away.
- **The shim** is a pure proxy for stdio-only hosts. It has no logic.
- **The keeper** is an optional per-session process (spawned detached) that holds the PTY
  master and exposes it over a unix socket with a tiny frame protocol (bytes, resize,
  signal, exit). The daemon connects on start and reconnects after a restart; the keeper
  buffers output during the gap (bounded). Journals are the daemon's and are persisted to
  the file store, so a restart loses nothing but the buffer beyond the bound. Windows uses
  the in-process backend only.
- **`terminal/*` client methods** (subscribe to raw journal events and screen diffs) exist
  for the GUI and CLI. Hosts never see them. They are the one non-MCP part of the surface,
  kept deliberately small.
- **Multi-node**: a recipe lists one terminal server per node; descriptors carry
  `address.node`. Federation is out of scope.

---

## 8. Internal architecture and seams

One npm package, four bins, strict internal layering enforced by directory and by tests
that fail on cross-layer imports:

```
src/core/        Session, Journal, JournalStore (memory, file), views, Screen, Marks,
                 ExecStrategy (integrated, marker), Watches, Segmenter, Principal types
src/backends/    PtyBackend interface; node-pty; keeper client; scripted (tests)
src/shell/       integration scripts for bash, zsh, fish (+ PowerShell later); detection
src/api/         tool registry + JSON schemas, channel manager, presence hook, tags,
                 manifest, compat pack — built on @animalabs/mcpl-core
src/transport/   ws server, auth, static GUI hosting
src/shim/        stdio ↔ ws
src/cli/         thin client
gui/             static app (xterm.js) as a client
```

Extension seams are interfaces with at least two implementations from day one, which is the
only reliable way to keep a seam honest: `PtyBackend` (pty, keeper, scripted),
`JournalStore` (memory, file), `ExecStrategy` (integrated, marker), `Segmenter` (default,
test), `Renderer` (text, svg). `core/` imports nothing from `api/` or `transport/`.

Dependencies: `node-pty` (native, unavoidable), `@xterm/headless` (pure JS emulator, 6.x),
`@animalabs/mcpl-core` (zero-dep), `ws`. No express, socket.io, puppeteer, MCP SDK, or
xterm npm packages that the GUI does not even load.

---

## 9. Exec strategies and input

- **Integrated** (default when marks are present): wait for `idle`; write the line
  (bracketed paste for multi-line on shells that support it, otherwise the temp-file
  `. '<file>'` route); correlate the next `B…D` marks to this `cmdId`; the result's output
  is `text(C, D)` and its exit is `D`'s payload. Human-typed commands go through the same
  correlation and get `origin: human`.
- **Marker** (fallback): PR #7's mechanism unchanged — temp file plus
  `; echo "<<<EXI""T:<nonce>:$?>>>"` on the same line, resolved by nonce, with the buffer
  cut at the marker so nothing after it leaks into the result.
- Both produce identical structured results. Session metadata says which is in effect.
- `input` is verbatim; `keys` use the existing vocabulary. Bracketed paste is used for
  multi-line text when the shell advertises it, which is what fixes issue #3 properly on
  modern shells; macOS bash 3.2 keeps the temp-file route.

---

## 10. Rendering

The headless emulator is the single text-cleaning mechanism: the live screen comes from the
session's emulator; historical text comes from replaying a journal range through a scratch
emulator. Alternate-screen entry and exit are journal events, so TUIs are recognised, not
guessed. `snapshot` renders the buffer grid to SVG (cells, colours, cursor) and optionally
to PNG via a small optional dependency — no browser, no GUI round trip, no sleeps.

---

## 11. Quality bar

- TypeScript strict, ESM, Node ≥ 20. No `any` at boundaries; tool inputs validated against
  their JSON schemas before dispatch; errors are typed with codes and reach the host as
  JSON-RPC errors, never as `{success:false}`.
- Structured logs (JSON lines) with `session`, `principal`, `cmdId`. `/health` reports per-
  session state and backend. Graceful drain on shutdown; with the keeper, no drain is needed.
- Tests in three layers: core against the scripted backend (fast, deterministic, replaying
  recorded transcripts including TUI sessions); real-PTY matrix per shell in CI (macOS bash
  3.2, bash 5, zsh, fish, dash) covering integration detection, exec, multi-line, cwd, exit
  codes, shell death, stdin readers, marker-shaped output; MCPL conformance against the
  `mcpl/conformance` vectors and a host-shaped harness for the channel lifecycle.

---

## 12. Migration

0. **Close the old line.** Land PRs #7, #8, #9; publish 1.7.0. Nothing in the new design
   depends on them, but they stop the bleeding for deployed agents.
1. **New core behind old names.** Journal, emulator, marks, state machine, both exec
   strategies, watches; the compat tool pack; same ports and recipe config, so it is a
   drop-in for the stdio frontends. Verified by the same real-PTY tests plus the new ones.
2. **The lane.** MCPL channels, segmenter, tags, presence hook, manifest revision; GUI as a
   client; puppeteer removed. agent-framework recipes switch the `shell` entry to
   `mcplServers`. Old tool names deprecated.
3. **Durability and identity.** Keeper backend; `aid1` principals and ownership; multi-node
   addressing. Compat pack removed.

Also worth doing at step 0: move the repository under `anima-research` (DEV-ENVIRONMENT.md
notes it is still under a personal org).

---

## 13. Alternatives considered

- **tmux control mode as the backend.** Gives durability, panes, and structured output for
  free, and is a strong choice. Rejected for the core because it locks the abstraction to
  tmux's model and process, complicates Windows, and puts a second event vocabulary between
  the shell and the journal. It fits well as a *third* `PtyBackend` later.
- **Keep polling tools only, no MCPL.** Simpler, but it is the thing antra's brief names as
  unsuited to high-capability workflows: the agent burns turns asking "done yet?".
- **Put the terminal inside the host as a module.** Loses sharing across hosts and humans
  and loses durability across host restarts, which is the product's original reason to
  exist.
- **Keep regex ANSI cleaning.** Cheaper, but it cannot resolve cursor motion or the
  alternate screen, which is exactly the output agents most need help with.
- **Stream raw bytes to the host and let the model cope.** The host would spill every
  chatty build to a workspace file and wake on nothing useful.

---

## 14. Open decisions

1. **Direct MCPL over WebSocket as the primary transport**, with the stdio shim secondary
   (recommended), versus keeping the per-agent stdio frontend as the main path.
2. **Keeper in phase 1 or phase 3.** It is the biggest operational win and the most
   platform-specific code.
3. **Journal durability.** Memory-only for v1, or file-backed from the start (recommended:
   file-backed, it is small and it is what makes the keeper worth having).
4. **A reserved activity-stream tag vocabulary.** `chat:*` is for messaging. Terminals,
   workspace watchers, and future robotics servers all emit "something happened, here is
   how it ended" events. Whether `terminal:*` stays producer-local or seeds a second reserved
   core (`act:*`) is an RFC-001 question for antra.
5. **`snapshot` at all.** Text screens cover most of the value; image rendering is cheap
   without a browser but is still a feature to maintain.
6. **Windows scope.** ConPTY works via node-pty; PowerShell 7 with PSReadLine emits OSC 133
   in Windows Terminal, so integration is plausible. Proposed: in-process backend only,
   best effort, phase 3.

---

## Appendix A: journal event schema

```ts
type JournalEvent =
  | { seq; ts; type: 'output';        data: string }                          // raw bytes as UTF-8
  | { seq; ts; type: 'input';         data: string; principal; kind: 'text'|'keys'|'paste'; cmdId? }
  | { seq; ts; type: 'command.start'; cmdId; line?: string; cwd; principal? }   // B mark or exec
  | { seq; ts; type: 'command.output';cmdId }                                  // C mark
  | { seq; ts; type: 'command.end';   cmdId; exit: number|null; signal?; durationMs }
  | { seq; ts; type: 'prompt';        cwd }                                    // A mark
  | { seq; ts; type: 'cwd';           path }                                   // OSC 7
  | { seq; ts; type: 'screen.mode';   alt: boolean }                           // alternate screen
  | { seq; ts; type: 'title';         text }                                   // OSC 0/2
  | { seq; ts; type: 'resize';        cols; rows; principal }
  | { seq; ts; type: 'signal';        signal; principal }
  | { seq; ts; type: 'watch.fired';   watchId; label?; kind; match? }
  | { seq; ts; type: 'session.exit';  code: number|null; signal? }
  | { seq; ts; type: 'note';          text; principal }                        // annotations
```

## Appendix B: four flows

**Synchronous run.** `run{session:"shell", command:"npm test", wait:20000}` → daemon waits
for idle, writes the line, correlates marks. Completes in 8 s → `{status:"completed",
exit:1, output:{text:…, truncated:false, seq:[4801,4990]}}`. The channel also emits one
`command` message tagged `terminal:command-finished terminal:exit=nonzero
terminal:origin=self`; the host's rule for self-origin finished commands is typically
`skip` because the tool result already carried it.

**Start and forget.** `start{session:"dev", command:"npm run dev", ready:["listening on"]}`
→ `{status:"ready", cmdId:"c17"}` after 3 s. Output keeps flowing as `terminal:output`
messages the gate throttles. A `watch{pattern:"ERROR|EADDRINUSE", label:"dev-errors"}`
later fires as `terminal:watch=dev-errors`, which wakes the agent.

**A human intervenes.** A human opens the GUI and types `git stash` into `shell`. The
journal records `input` with `principal: human:discord:…`, the marks give
`command.start/end`, and the host receives a `command` message tagged
`terminal:origin=human chat:from-human`. Next turn, the presence line reads
`last: git stash → 0 (human)`.

**A TUI.** `run{command:"htop", wait:2000}` → `{status:"running"}`; `screen.mode alt:true`
is journaled; the segmenter switches to `terminal:screen` snapshots on quiet. `screen{}`
returns the grid as text with the cursor; `input{keys:["F10"]}` exits; `screen.mode
alt:false` then `command.end`.
