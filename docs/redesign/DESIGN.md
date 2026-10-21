# Terminal Sessions — Rearchitecture Design

**Status:** Design, draft 4 — milestones 1 and 2 built to it, reviewed twice and reconciled with what the build taught; not yet reviewed by antra
**Targets:** successor to `terminal-sessions-mcp` (npm `term-sessions-mcp` 1.6.0); MCPL SPEC.md 0.5.0-draft; agent-framework host
**Authors:** Claude Code (Fable 5.1) and a Codex agent, with Aster
**Date:** 2026-09-16; draft 4 2026-09-24
**Depends on:** MCPL SPEC §5.4 (grants), §9 (push), §10 (hooks), §14 (channels), §16 (tags), §17 (manifest); RFC-001; RFC-002
**Companion:** `draft-1-claude.md`, `draft-1-codex.md` (the two source drafts, kept verbatim); AUDIT-001 in `archipelago-design/mcpl`

**Review history.** Two drafts were written without sight of each other: Claude's
(`draft-1-claude.md`) and Codex's (`draft-1-codex.md`). Claude integrated them into this
document. They agreed on the macro shape — daemon plus thin clients, an ordered journal as
the source of truth, a headless emulator for screen state, shell integration for command
boundaries, MCPL as the lane to hosts, `@animalabs/mcpl-core` for protocol machinery, one
TypeScript package with hard internal boundaries, a compatibility adapter during migration.
Codex contributed the entity model (Session / Run / Service / Attachment), the three
execution contracts including direct process execution, service *health* as distinct from
readiness, control ownership and dimension ownership, the observer-effect finding
(screenshots resize the live PTY), backpressure and visible truncation, idempotent input,
precise recovery reporting, and the demand that guarantees be agreed before implementation
is divided. Claude contributed the concrete shell-integration and state-machine design, the
segmentation policy, the `terminal:*` tag ontology and its fit to the host's gate, the
presence injection, the channel-first delivery with dual delivery when closed, the
topology (direct MCPL over WebSocket, stdio shim, keeper backend, GUI as a client),
principals via `aid1`, multi-node addressing, and the migration specifics. Two divergences
were resolved (Appendix C): channels versus push events as the primary lane, and the
shape of the API surface. Codex's experiments 1 and 3 reproduce bugs that upstream PR #7
already fixes; experiment 2 (a service reported `running` because the *shell* was alive) is
unfixed and is addressed by §8.4. Section 5, the guarantees, is the artifact both agents
asked for as the precondition to splitting implementation. Draft 2.1, the same day, adds
§10.6 (host profiles, written after reading `mcpl-cc-bridge`, which makes a Claude Code
session an MCPL host), the primitives-not-workflows principle from antra's answer on
`code_execution`, the result shape and tool tiers in §11, `control: open` in §9, and
per-agent tokens plus the CLI in phase 1. Draft 2.2 (2026-09-17) takes Codex's cross-review
of 2.1: the separation of responsibilities between host and terminal (§1), the correction
that feature sets are descriptive and tool tiers need the host's tool policy to be real
(§11), a readable transcript plus a structured envelope with stable fields as the result
contract (§11, G27), and eight single-purpose core tools rather than six with folded
modes. It also moves the universal improvements that §10.6 had surfaced into the sections
they belong to (§10.2, §10.3, §11), and adds `UPSTREAM-CHANGES.md` for the bridge and host
changes another agent can turn into PRs. Draft 2.3 adds §11.1, tool-design rules, and a
measurement step in §16, from Claude's first-person account of using tool surfaces: the
count matters less than one verb per tool, parameters that never change a tool's meaning,
no cross-parameter defaults, and a compact core that is the real default everywhere.

Draft 3 (2026-09-17) is the pass Codex's review of 2.3 asked for. Codex accepted the
architecture and objected that several guarantees were stronger than the model supports.
Every objection was checked and all were right. **Execution targets:** a session has
exactly one terminal in the first release; a Run targets the shell or a daemon-spawned
process; interactive is no longer a Run mode — interaction is a capability of a terminal;
a process Run's environment basis is explicit (§4, §8). **Observation semantics:** raw
output, transcript and screen are three distinct products; a transcript is a documented
projection, not "what a human saw"; historical screens need emulator checkpoints and are
deferred; the current screen is the promise (§6, G10, G14). **Acknowledgement
semantics:** two cursors per principal, `delivered` and `read`, with stated meanings;
completion is suppressed only for the principal whose waiting call returned it, never on
origin; closed-channel push events follow explicit interest (§10, G22, G28). **Marks:**
`B` is prompt end and `C` is pre-execution, so a Run starts at `C`; integration has
levels; shell attribution is temporal (§7, G5, G12). **Availability:** `lost` never
advances a queue; a confirmed prompt does (G4). **Cancel** has two contracts (G29).
**Redaction** promises only what it implements (G26). **Protocol replies** are the
daemon's, and only the daemon's (G25). **Scope:** `await` on a run id is core; seams need
a second implementation only where one is real on day one; probes, watches, control
policies, historical screens and image rendering are incremental (§11, §13, §16). The
plan is reframed around Codex's first milestone under Aster's rule: increments are cut by
dependency and complexity, never by review cadence — the team is the review, milestones
are dogfooded, and a milestone lands as one bundle. `UPSTREAM-CHANGES.md` B3 and A2 are
corrected: a changed tag ontology invalidates acceptance (SPEC §17.5); it is never
recompiled automatically.

Draft 4 (2026-09-24) follows the build. Milestone 1 and milestone 2 were implemented in
`next/`; a first adversarial review found 139 defects, every one verified and fixed, and a
second review covered the merged tree. What the implementation changed in this document:
`channels/publish` records a note and never types, because hosts publish an agent's
ordinary speech (§10.1, §11.1); feature sets became one per tool tier plus separate push,
channel, annotation and presence sets, since `uses` is fail-closed (§10.5); marks are
authenticated with a per-session key and every daemon line is a sourced command file (§7,
§8.1, G6); cancel reports its steps and reaches the foreground job's group (G29); sessions
are login shells with their own history; the transcript projection's seven rules are
stated (§6); the PTY is paused for the daemon's own emulator (§6); names belong to their
owners (G30) and closed sessions stay readable (G19); the Host/Origin rules and the GUI's
principal are specified (§12); G16, G22 and G28 describe their mechanisms (idempotent
replay, the owed set under `delivered`, suppression by in-flight waiters). Implementation
notes are in §16.

---

## 1. Summary

The organizing idea: **a persistent execution environment with reliable observation and
control, exposed to hosts as a live participant.** An agent acts in a shell and stays
present to what happens there, over long horizons, alongside humans and other agents.

The current system has the right central intuition and the right macro shape, but its
model is too small for its responsibilities: a shell, a command, a service, and a request
waiting for a result all collapse into one mutable session object, and its behaviour is
carried by conventions and timing assumptions (a marker typed into the PTY, a 50 ms sleep,
regex cleaning, a browser that clicks through the GUI to take a picture). The rebuild
replaces conventions with a model and guarantees:

1. **Work has identity.** A `Session` is a persistent environment: one shell in one
   terminal. A `Run` is one execution, with its own id and lifecycle, targeting either the
   session's shell or a process the daemon spawns with pipes. A `Service` is a Run with
   readiness and health expectations. An `Attachment` is a human or agent observing or
   controlling a terminal. Interaction — typing, looking at the screen — is a capability of
   a terminal, not a kind of Run. No caller's deadline changes any of these states.
2. **Observation is a journal.** Every session has an append-only, sequence-numbered,
   typed event journal. Three products derive from it and each says what it is: raw output
   with provenance, a transcript that is a documented projection for reading and search, and
   the screen, which is emulator state. Cursors are stable; gaps and truncation are visible;
   observing never disturbs the observed.
3. **Truth comes from the shell and the daemon, not from heuristics.** Shell integration
   marks give command boundaries, exit codes and cwd for every command whoever typed it;
   process-mode runs get exit status straight from the daemon; a headless emulator gives
   the screen. The old marker mechanism survives only as a fallback.
4. **One daemon, one endpoint, an event lane.** The daemon speaks MCP+MCPL over WebSocket;
   the CLI, the GUI and a stdio shim are thin clients. Sessions are channels; a segmenter
   turns the journal into tagged messages; the host's gate decides what wakes the agent; a
   `beforeInference` injection tells the agent what changed since it last looked.
5. **Persistence is three separate promises,** made and reported separately: outliving a
   client connection; keeping history across a daemon restart; keeping live processes
   across a daemon restart (the keeper backend).

One principle runs through the tool surface: **primitives, not workflows.** The server
exposes orthogonal operations with parseable results and leaves composition — loops,
fan-out, conditional waits — to whatever the host already has for that: connectome's
`code_execution`, which injects every tool as an async function into a Python interpreter;
a Bash-shaped harness's shell, through this server's CLI; a plain MCP host's own tool
loop. The current codebase's unexposed test-scenario runner and wait-for-pattern loop are
the kind of thing that does not come back. Codex's formulation of the same line: the host
coordinates work — "run these three concurrently, filter, notify me" — and decides when a
completion deserves inference; the terminal owns the work's execution and observable
state — "this process is still running, these bytes followed cursor N, this input reached
this terminal, this process exited" — and retains the outcome so it is recoverable if the
notification is missed.

---

## 2. What the current system gets right, and what to keep

Keep: the daemon/client separation and the deployment posture built on it; real PTYs;
named sessions; interactive input with the named-key vocabulary; human access through an
xterm.js GUI; the temp-file route for multi-line input; the exec-marker hardening in
PR #7 (as the fallback strategy); the real-PTY test style.

Replace: the single mutable session object; the marker-typed-after-a-delay completion
model; line-array logs plus a separate raw buffer; regex ANSI cleaning as the text path;
"timeout ⇒ exit code −1 and the command is left running"; service liveness inferred from
shell liveness; screenshots via puppeteer through the GUI, which resize the live PTY; two
divergent client classes; the hand-rolled MCP loop; socket.io and express; a cwd that is
the initial cwd forever; four declared dependencies nothing imports.

---

## 3. Goals and non-goals

**Goals**

- **Truthful.** Every reported state is observed, never inferred from timing. Unknown is
  reported as unknown.
- **Persistent.** Sessions and runs outlive connections; history outlives the daemon;
  live processes outlive the daemon when the keeper backend is in use.
- **Live.** Output reaches hosts as tagged events with sensible segmentation, with no
  polling. TUIs arrive as screens.
- **Shared.** Several principals per session, with provenance on every input and an
  explicit controller.
- **One contract.** A typed application API with central schemas; every adapter is thin.
- **Extensible at named seams,** each with two implementations from day one.
- **Testable.** The core has no network and no PTY dependency; guarantees are encoded as
  tests against a scripted backend, and re-run against real shells.
- **Operable.** One supervised daemon per machine; loopback plus token today, `aid1`
  tomorrow; a health endpoint that reports session and run states.

**Non-goals (v1)**

- Not a multiplexer for humans (no windows, panes, layouts). tmux exists.
- Not a sandbox. Session permissions are application-layer; isolation is the OS's or a
  container's job and must exist there if it is needed.
- Not a fleet controller. Multi-machine is addressed by addressing, not federation.
- Not rollback. A journal position is evidence, never a checkpoint of side effects.
- Not forever. Retention is explicit.

---

## 4. Entity model

```
Node ─┬─ Session ─┬─ Terminal (the shell's PTY · Screen · Journal)   — exactly one, in this release
      │           ├─ Run* (target: shell | process; optional Service)
      │           ├─ Attachment* (principal, role, cursors)
      │           └─ Watch*
      └─ Principal* (agent | human | host | system; via token | aid1 | gui)
```

| Entity | Identity | Meaning |
|---|---|---|
| **Node** | hostname / configured name | One daemon on one machine. Sessions are addressed `{node, session}`. |
| **Session** | name, unique per node | A persistent environment: one shell in one terminal, with a journal, an owner, a visibility, an integration level, a backend, and a current controller. |
| **Terminal** | the session's, in this release | A PTY with an emulator. `screen`, `input`, `resize` and control always name a terminal and default to the session's shell terminal. The model admits Run-owned terminals later (a process Run given a tty of its own); this release has exactly one terminal per session, so nothing is ambiguous. |
| **Run** | `runId`, assigned at admission | One execution. `target: shell` writes a line into the shell terminal and occupies it until the end mark; `target: process` is spawned by the daemon with pipes, occupies nothing, and is attributed exactly. Human-typed commands detected by marks are shell Runs with `origin: human`. |
| **Service** | the Run's `runId` | A Run with a readiness probe and a health policy. Status `starting → ready | unhealthy | exited`. |
| **Attachment** | `attachmentId` | A principal observing (`observer`) or controlling (`controller`) a terminal over one connection, with two cursors: `delivered` and `read` (G22). |
| **Watch** | `watchId` | A standing predicate over a session's journal that emits a tagged event when it fires. |
| **Principal** | `agent:<name>@<domain>`, `human:<provider>:<id>`, `token:<name>`, `system` | Who acted. Resolved at the transport. |

Run states: `queued → starting → running → exited | cancelled | lost`. Session states:
`starting → idle ⇄ busy (+ tui) → exited`, where idle and busy describe the shell terminal
only — a process Run never makes a session busy.

**Interaction is not a mode.** `htop` started by `run` is a shell Run; while it runs the
terminal is in alternate-screen mode, `screen` shows it, `input` drives it, and pressing
`F10` ends the program, at which point the end mark closes the Run. A principal typing into
a terminal outside any Run is also fine. Ending an interaction implies nothing about any
program; the marks say when programs end.

---

## 5. Guarantees

These are the contract. They are what the test suite encodes, what both implementers build
to, and what agents may plan around. Numbering is stable; amend by adding, not renumbering.

### Identity and lifecycle

- **G1.** Every execution is a Run with a `runId` assigned before anything is written to a
  PTY or spawned. Every later operation on it — await, read, cancel, evidence — refers to
  it (`signal` addresses the terminal's foreground job, not a Run, §8.4; given a Run it points
  at `cancel`). Marks-detected human commands become Runs at their pre-execution mark.
- **G2.** Run state transitions are journaled. `exited` carries an exit code or a signal
  that was *observed*: from the shell's end mark for a shell Run, from the process for a
  process Run. No other source of an exit status exists.
- **G3.** No caller's deadline changes a Run's state. An `await` that returns `running` is
  a statement about the caller. The daemon never invents an exit status; when it cannot
  observe one, the Run is `lost` with a reason. A shell that exits under a Run gives
  `shell-exited (status N)` or `(SIGNAL)`, from the shell's own exit, and the result's text
  names the two usual causes (`exit`, `set -e` in the session shell); a Run whose line turns
  on `set -e` in the shell gets a hint in its result (a hint, never evidence, as §8.1's).
- **G4.** A shell Run is admitted only when the shell terminal is **available**: a prompt
  mark has been observed since the last shell Run ended and no shell Run is `starting |
  running`. Otherwise the call returns `busy` with the running Run's id, unless the caller
  asked to `queue`. A queued Run advances only when the Run ahead of it has ended *and* a
  prompt mark confirms the shell is back. After `lost`, the queue waits for a confirmed
  prompt or for a cancel; an unknown outcome never establishes availability. Process Runs
  never occupy the shell and are admitted at any time. The one exception is the caller's
  own: once the caller has **declared** that the program in front of the terminal is a shell
  (§8.1), shell Runs go to that shell, one at a time, until the Run whose program it is
  ends; the session's own shell stays busy with that Run throughout.
- **G5.** A session's shell terminal is `idle` iff a prompt mark has been observed after the
  most recent shell Run's end and no shell Run is `starting | running`. The integration
  level is known and reported: `rich` (prompt-start, prompt-end, pre-execution and
  end-with-exit marks, cwd, command line), `basic` (end marks only), `none` (fallback
  strategy). Under `basic` and `none`, only daemon-issued Runs have boundaries, and
  results say so: a Run result from the live session carries `integration`, and under `none`
  the status line reports the cwd as unknown. A Run read back from a closed session's history
  reports the directory its `run.start` recorded and omits the live integration level (the
  daemon is no longer running the shell to report it). Integration that a command removes (hooks cleared, `exec` into a new
  shell) heals at the next prompt where the shell allows it; the Run that broke it ends
  `lost`, never left `running`. An unverified replacement program is `unavailable` for
  shell Runs (including queued admission); it remains observable and accepts explicit
  input, and declaring it a shell (§8.1) is the way to run commands in it. Losing a Run
  never establishes a ready shell or drains its queue. A configured unintegrated shell's
  initial marker fallback is distinct from losing an integrated shell.

### Execution

- **G6.** Shell Runs execute in the session's persistent shell: cwd and env effects persist,
  and the exit code is the shell's `$?` for that line; when the line is a pipeline and the shell
  gives each command's status (bash, zsh, fish), the result carries them too (`pipeStatus`) and
  the status line says when a command before the last one failed, since `$?` alone is the last
  command's unless pipefail is on. Every daemon-issued line — one line
  or many — is delivered as a sourced command file (` . '<dir>/tsm-cmd-N'`), never as
  keystrokes through the line editor, so history expansion, completion, comments, syntax
  errors and continuation prompts can neither change it nor wedge the session; a line the
  shell never starts ends `lost` (`no-pre-execution-mark`). The plumbing stays out of every
  history, which is the session's own, never the user's. A declared shell (§8.1) is the
  exception to both: its Runs travel inline, so their wrappers appear in that shell's history —
  over `ssh` or `sudo -i`, the user's own — and its end marker carries `$?` alone, so its
  results have no `pipeStatus`.
- **G7.** Process Runs are spawned by the daemon with an **explicit environment basis**: the
  session's configured environment (creation-time env over the daemon's, which never includes
  the daemon's own credentials and configuration or the identity variables of the terminal
  that launched the daemon; `TERM` is the daemon's emulator's) and the shell's
  current cwd as last reported by a cwd mark, or an environment snapshot the caller
  explicitly captured earlier (§8.2). The result names the basis. The daemon never claims
  to know a shell's later `export`s or activations. Exit status is observed directly;
  stdout and stderr are journaled as separate UTF-8 text streams. Streaming decoding
  preserves split characters; invalid byte sequences become U+FFFD. Process Runs have no
  effect on the shell's state and do not occupy it.
- **G8.** Interaction is a capability of a terminal, not a kind of Run. `input` and `screen`
  work whenever the terminal exists, make no claim about Run boundaries, and ending an
  interaction implies nothing about any program.
- **G9.** A Service's `ready` is asserted only by a probe result. `unhealthy` and `exited`
  come from an observed exit of the Run or a failed probe — never from the liveness of the
  enclosing shell.
- **G29.** `cancel` has two contracts; the result names which applied and lists the `steps`
  taken. For a process Run the daemon signals the process group it owns — `SIGINT`, then
  `SIGTERM`, then `SIGKILL` on a schedule, until the whole group is gone even after its
  leader exits — and observes the exit. For a shell Run the daemon writes `^C` to the
  terminal, then `^\\`, then signals the terminal's foreground process group (`SIGTERM`,
  then `SIGKILL`) when that group is not the shell's own, and reports `cancelled` only when
  the shell confirms the job ended (its end mark, or a prompt for a line it never started);
  if the job survives every step the Run stays `running` and the escalation is explicit:
  `session_close`. A queued Run is dropped without touching the terminal. The daemon never
  signals the shell to cancel a job. Closing a session hangs up its foreground job, as
  closing a terminal does.

### Observation

- **G10.** The journal is the single source of truth: append-only, per-session monotonic
  `seq`, timestamped, typed (Appendix A). No `seq` is issued twice across a daemon crash, unless
  the disk was refusing the journal's writes when it crashed (below). Nor is one issued twice across
  a power loss, provided the disk took the journal's last reservation write. Appends are not
  synced, so a power loss can take the journal's last lines, the ones the
  disk had not yet written. The numbering survives it: before issuing a block of 10,000 seqs, the
  journal reserves the block in a synced metadata write, and it lowers the reservation to its last
  seq when it closes. After a power loss the next start numbers above every seq issued before it,
  and the seqs between the last line on disk and the reservation read as a `torn-write` gap. After
  a daemon crash on the same boot, nothing the page cache held is lost, and numbering continues
  from the last line, except where a start died after reserving above a hole it honoured and before
  the hole's gap reached the file: the next start on that boot honours the hole again. The reservation is a write to the journal's own disk, so it is best effort.
  While the disk refuses it, seqs go on being issued past the last reservation the disk took, and
  the write is retried once a second. A power loss in that window can issue some of those seqs
  again after the restart. So can a daemon crash on the same boot while the disk refuses the events
  as well as the mark that would flag the reservation failed: the reservation it leaves is not
  marked failed, a start on the same boot does not honour such a one, and numbering resumes at the
  last line on disk. Three products derive from it and each states
  what it is. **Raw output** is retained decoded UTF-8 text with provenance, a pure function of a
  range. **Transcript** is a documented line-oriented projection of a range, a pure
  function of that range and the width it is projected at, for reading and search — not a
  claim about what anyone saw. A Run's page projects at the geometry its `run.start`
  recorded, so it reads the same after a resize; a `since` page projects at the terminal's
  current width, so a resize changes how a later `since` read of earlier output wraps.
  **Screen** is emulator state at a position, a function of the whole history up to it.
  Channel messages and search results are built from raw and transcript.
- **G11.** Cursors are `seq` values. `since(seq)` returns exactly the retained events after
  `seq`. If `seq` predates retention, the response begins with a `gap` marker naming the
  oldest retained `seq`. Truncation is always visible.
- **G12.** Output events carry `runId` when attributable, and the result says on what
  basis. For a process Run attribution is **exact**: the bytes came from that process's
  pipes. For a shell Run attribution is **temporal**: output that arrived between the
  Run's pre-execution and end marks, which can include output of an earlier background
  job in the same shell.
- **G13.** An Attachment receives a snapshot at cursor N followed by the events after N,
  with no duplicates and no silent gaps. A slow Attachment never stalls the PTY; it falls
  behind retention and receives a `gap`.
- **G14.** The current screen is the session emulator's state now, read without touching
  the PTY. Historical screens at a `seq` are a later product requiring emulator
  checkpoints (§6); nothing renders a screen by replaying an isolated range, and no view
  claims to. A snapshot never resizes or writes to the live terminal. Observing does not
  change the observed.
- **G15.** Needs-input detection is heuristic, is labelled as such, and carries its evidence:
  the last line, the silence duration, the session state.

### Control and collaboration

- **G16.** Every mutating operation — input, run, start, cancel, signal, resize, open,
  close, watch, unwatch, control, env capture — carries a principal and may carry an
  idempotency key (at most 200 characters; a UUID per operation). A retry with the same key
  within the window (15 minutes) returns the first call's outcome, success or failure, and
  never executes twice; a retried `run` or `start` is the same Run, awaited again, also
  after a daemon restart (the key's identity is journaled on `run.admit`) and after the
  session was forgotten (the first outcome is returned). A key reused for a different tool
  or with different arguments is refused, also after a restart: the journaled identity keeps
  the key apart from the tool and the arguments' fingerprint. A call that admitted nothing (`busy`) is not
  remembered, so its retry can run. The memory is bounded per principal and in total, oldest
  evicted first. A client never blindly resends input after an ambiguous outcome.
- **G17.** A session has at most one controller at a time. Observers may not type, signal,
  resize or destroy, with two exceptions that need no seat: a principal may `cancel` a Run it
  started, and the owner may `session_close` its own session. The controller is visible in
  session state and to every Attachment. Handoff is explicit (`release`, `take`, owner
  override). Terminal dimensions are set by the controller only; observers scale their own view.
- **G18.** Permission verbs are `observe | type | run | signal | resize | destroy`, enforced
  in the application layer for every adapter. MCPL grants govern the host's access to the
  server; they do not replace terminal-side authorization.

### Persistence and recovery

- **G19.** Three promises, reported separately: (a) sessions and Runs outlive any client
  connection; (b) journals and metadata survive a daemon restart; (c) live processes
  survive a daemon restart only under the keeper backend: without it, a stopping daemon
  hangs up each shell as a closing terminal does, so the shell and its foreground job end
  while a job the shell detached on purpose (`nohup`, `setsid`, `disown`) lives on, and
  process Runs' groups are ended. A live entry's summary names its backend, cwd and
  integration, a live entry whose shell has exited included; a history entry (closed, or
  recovered with no shell to reattach) reports `closed` or its recovery class in their place.
  A disk that refuses writes never takes the daemon or a session down: the ring carries
  on, the failure is reported (`/health`, journal stats), and the file store catches up
  from the ring when writes succeed again; a torn last line is cut on open, never
  reissued, and marked by a `gap`. Closing a session keeps its history readable (`read`,
  `await` on its Runs) until retention or an explicit `forget` removes it.
- **G20.** After a daemon restart every session whose shell was alive at the restart
  reports `recovered: continuous | reattached | history-only` (one closed before it reports
  `closed`, not a recovery class), and every Run that was running is reported `exited` if its
  end was observed, otherwise `lost` with reason `daemon-restart`. Never `running` by
  assumption.
- **G21.** Nothing is deleted by default: history stays on disk until its session is
  forgotten. Limits are opt-in — daemon-wide (`--retention-bytes`, `--retention-days`) or
  per session (bytes and age) — and are recorded with the session and reported by
  `session_list` and `/health`; an absent limit is no limit. The in-memory ring (8 MiB) is a
  cache, not retention. The oldest retained `seq` is queryable (`oldestSeq`).
- **G30.** A session name belongs to its owner. After its shell ends — closed, or
  recovered after a restart — only the owner (or the daemon) may start a new life under
  the name, which continues the same journal and `seq` numbering, so earlier Runs stay
  reachable by id (the newest 100,000 Runs of a name: the run index is bounded in memory, and
  output of a Run it forgot stays readable by cursor); anyone else is refused, so no principal can take over a name to read
  another's history. The owner's GUI (`human:gui:<owner>`, §12) acts for the owner here.
  Names are unique regardless of case, and concurrent opens of one name make one shell;
  a caller that raced another principal's creation is authorized against the session that
  resulted, and a name the caller cannot observe is reported as taken, not as a verb
  refused. A new life started while the daemon that set them runs keeps the name's watches:
  they live in the daemon's memory, not in the journal, so a life recovered after a restart
  starts with none, until watch persistence exists.

### Delivery to hosts

- **G22.** Delivery is tracked per `(principal, session)` with two cursors whose meanings
  are fixed. `delivered`: the highest `seq` the host accepted, from a `channels/incoming`
  result or a `push/event` response. `read`: the highest `seq` whose content a tool result
  *delivered* to that principal (`run`, `await`, `read`, `screen`) — advanced when the result
  is written to the connection, not when the method computes it, so a call orphaned by a
  dropped connection counts nothing read. Presence says "new since
  your last read" from `read`; catch-up after reconnect resumes from `delivered`, and
  `delivered` never advances past a lifecycle message still owed to that principal (a
  completion settles a moment after its `run.end`, so a later event can be accepted first).
  Refusals and transport errors retain that debt and retry with the same message id;
  elapsed time is not acceptance. A catch-up summary pins the cursor before its oldest
  covered event until accepted, then settles the individual debts it represents.
  Cursors are keyed by principal, so they survive connection replacement. Delivery is
  at-least-once; duplicates are detectable by `seq` and `messageId`.
- **G23.** Tags describe and never authorize. Treatment is the host's. Suggested treatment
  is advisory and requires acceptance.
- **G24.** The server never declares `rollback`. A journal position is evidence, not a
  checkpoint of shell side effects.
- **G28.** A Run's completion message goes to every interested principal except one whose
  synchronous call (`run`, `await` or `start`) returned that final outcome — returned
  meaning the result was written to that principal's connection, so a call orphaned by a
  dropped connection suppresses nothing; origin alone never suppresses it. An agent whose `run` returned `running` is told when the Run ends. For a
  closed channel, push events go only to principals with **explicit interest**: Runs they
  started, Watches they set, sessions they own. Closing a channel is never a subscription
  to a shared session's whole lifecycle.

### Results

- **G27.** Every successful tool result carries a structured envelope whose `state` field is
  the only authority on whether a Run completed; the readable text is derived from the same
  result and never has to be parsed to learn it. A failed call is an `isError` result whose
  text opens with the error code and which carries no envelope (MCP carries a tool failure in
  the result); only the compat pack answers in 1.x's `{success: false}` shape.

### Safety

- **G25.** The daemon writes to a PTY only: the exec line of a shell Run; integration setup
  at session start; resize; input a principal asked for; and the terminal-protocol replies
  a program requested (cursor position report, device attributes, and the like). The
  daemon's emulator is the **sole** responder to such queries; an attached GUI's emulator
  never answers, so attaching a second viewer never creates a second responder.
- **G26.** Input marked `sensitive` is journaled as a redacted placeholder, and transport
  credentials are never logged or journaled. No promise is made about what programs print
  — a program may echo a secret — and retention (G21) bounds that exposure. This is the
  whole of the redaction promise.

---

## 6. The journal and its products

Two stores behind one interface: an in-memory ring bounded by bytes (default 8 MiB per
session) and an append-only file per session under the data dir with rotation. The file
store is on by default; it is what makes G19(b) and G20 true. A chronicle-backed store is a
natural later option — append-only records with causation — but the daemon must not depend
on chronicle.

Three products, each with a stated meaning (G10):

| Product | What it is | Pure function of |
|---|---|---|
| **raw** `(from, to)` | Retained decoded UTF-8 text with provenance: `seq`, timestamp, `runId` when attributable, stream. Binary preservation is not promised. | the range |
| **transcript** `(from, to)` | A documented line-oriented projection (the seven rules below). Cursor motion relative to content *outside* the range is lost — Codex's check: after `ABCDE`, the range `\rXY` shows `XYCDE` on a real terminal and `XY` in a transcript. Good for reading and search; never presented as a screen. | the range |
| **screen** `()` | The session emulator's state now: `{cols, rows, alt, cursor, lines, title, seq}`. | the whole history |

Derived views: `run(runId)` (state, exit, duration, basis of attribution, and raw or
transcript over the attributed output), `commands(filter)` (structured history of shell
Runs including human-typed ones), `tail(n)` / `since(seq)` / `until(seq)` (paging by cursor,
G11), `search(re, window)` (over transcript, returning `seq` anchors with context).

**Historical screens** — `screen(seq)` — are a later product: the emulator is checkpointed
(serialized) periodically, on resize and on alternate-screen transitions, and a historical
screen is a checkpoint plus replay of the events after it, resizes included. Achievable, and
substantially more work than a reliable current screen; deferred until a workflow needs it
(§16).

**The transcript projection, exactly** (as built and tested, `core/transcript.ts`):

1. *Geometry.* The range is fed to a scratch emulator of the caller's width (a Run projects
   at the width it started with); resizes inside the range are not replayed.
2. *Resolution.* CR, BS and cursor motion within the range resolve as a terminal resolves
   them; control sequences produce no text; motion relative to content outside the range
   is lost.
3. *Lines.* Logical lines: soft-wrapped rows are joined, so the text contains no newline the
   program did not write; trailing whitespace is trimmed at the end of a logical line,
   never at a wrap point.
4. *Nothing printed is lost to full-display redraws.* Content erased by `clear` (ED 2, ED 0
   from home, RIS) or scrollback clears (ED 3) is kept before the erase.
5. *Full-screen programs.* The normal screen's content is kept; when the program leaves,
   its final frame follows; a range ending inside a program ends with its current frame.
   Intermediate frames are not kept.
6. *Streams.* Process stdout/stderr come from pipes: a bare LF projects as CRLF; a change of
   source starts on a fresh line.
7. *Budgets, all visible.* `maxInputBytes` keeps the head or tail (never splitting a
   character, preferring a line boundary) and reports `omittedInputBytes`; `maxLines`
   caps logical lines; any omission sets `truncated`.

**Backpressure.** The journal is the bounded buffer. Attachments read by cursor; one that
falls behind retention gets a `gap` (G13), and a native subscriber whose socket fills up is
paused and resumed from its cursor rather than buffered in the daemon. The PTY is never
paused for a slow observer. It is paused when the daemon's *own* emulator falls behind
(high and low watermarks on its backlog), because the screen must stay correct; past a hard
backlog cap the oldest queued output is reduced to the sequences that change lasting
terminal state, and snapshots then report it (`droppedUnits`). The journal writer's own
failures are the G19 path above.

**Output flooding.** A Run that emits faster than retention can hold is still correct:
its result reports `truncated: true` with the retained `seq` range, and the file store
keeps what the ring could not.

---

## 7. Shell integration and the state machine

At session start the daemon injects integration for the detected shell without replacing
the user's rc files — bash via a wrapper rcfile that sources the user's (emulating a login
shell, as sessions are login shells by default), zsh via a `ZDOTDIR` shim that honours a
`ZDOTDIR` set in the user's `.zshenv`, fish via a `vendor_conf.d` snippet that runs before
`config.fish` — the techniques VS Code, WezTerm, Kitty and Ghostty use. The marks, with
their real meanings: `OSC 133 ; A` **prompt start**; `B` **prompt end** — the user may now
be typing or editing, nothing is executing; `C` **pre-execution** — the line was accepted
and is about to run, and the VS Code `633;E` extension carries its text; `D ; <exit>`
**execution finished**; `633;P;Cwd=<path>` the cwd at every prompt. A Run therefore starts
at `C`, not `B`: a human sitting at a prompt editing a command is not a Run.

**Marks are authenticated.** Every mark the integration emits carries a per-session key as
its last parameter (`133;D;0;k=<key>`). A private launcher writes a mode-0600 file for its
own PID, then execs the configured shell. Its startup shim reads the key into an
unexported variable; even children of earlier startup files never inherit it.
Shell replacement uses another mode-0600 handoff file in the private
integration directory, read by the replacement shell using its own PID and removed after
consumption; a textual `exec` hint never exports completion authority. Zsh emits prompt-end
from its line editor hook, so even an exported PS1 carries no credential. Only keyed marks are marks: unkeyed or wrongly keyed `133`/`633`
sequences — from program output, a nested or remote shell, or another terminal's
integration loaded by the user's rc (Ghostty, iTerm2, VS Code) — and every `OSC 7` are
ordinary output. Output without the key cannot end a Run, fake an exit code or move the cwd.
This protects against ambient output and credential inheritance, not deliberate inspection
of the same shell's variables, private files or memory by code running as the daemon's user.
A keyed hello (`633;P;TsmHello`) goes out before the main user rc runs (fish user `conf.d`
files can run earlier), so an observed handshake keeps a slow rc from being mistaken for
a shell without integration. Hooks heal themselves when a
command reassigns `PROMPT_COMMAND`, replaces the DEBUG trap or clears zsh's hook arrays, and
they chain a user's own DEBUG trap and bash-preexec rather than replace them; they are safe
under `set -u` and `set -e`.

Integration has **levels**, as VS Code's does, and the session reports its level (G5):
`rich` when `A`/`B`/`C`/`D`, cwd and command line all arrive; `basic` when only end marks
with exit codes do; `none` when no mark arrives within a grace period, in which case the
marker strategy (§8.1) serves daemon-issued Runs and only those have boundaries.

```
starting ──► idle ◄──────────────► busy ──► exited
              ▲                      │
              └── prompt (A) ◄───────┘      busy + alt-screen ⇒ tui
starting/busy ── unverified replacement ──► unavailable ──► exited
```

The state describes the shell terminal only and is derived from marks, the emulator's
alternate-screen flag, and PTY exit — never from timers. `idle` requires an observed prompt
(G4, G5), which is what lets a queue advance safely and what the presence line reports.
`unavailable` needs evidence too: the shell process's own command line changed (an `exec`
the integration announced, or one during startup) and no handshake followed within the
startup cap. A timer alone never makes a terminal ready, and nothing but a new shell leaves
`unavailable`: shell Runs are refused (queued ones wait, or are cancelled), while `input`
and `screen` keep working on whatever program is in front.

---

## 8. Execution targets

### 8.1 Shell target

Wait for the shell terminal to be available (G4); write the command to a file and type
` . '<dir>/tsm-cmd-N'` (G6); correlate the `C` whose command line is that one, and the
following `D`, to this `runId`; the result's output is the transcript and raw decoded text between
`C` and `D`, attributed temporally (G12); the exit is `D`'s payload. The command directory is
a short private `/tmp/tsm-<uid>/<hash>` (checked to be ours and closed to others, falling
back to the session's own directory), because the typed line is echoed at the prompt and
shows in transcripts and screens. A partial line a human abandoned in the editor goes stale
after 30 s and is cleared before the daemon's line. Cwd and environment effects persist;
this is the target for `cd`, `export`, virtualenv activation, shell functions, and any
program that needs a terminal. A human typing at the prompt produces the same marks and the
same Run, with `origin: human`.

*Fallback strategy* (`integration: none`): PR #7's mechanism — the command file plus
`; echo "<<<EXI""T:<nonce>:$?>>>"` on the same line, resolved by nonce, buffer cut at the
marker (`$status` under fish). A `^C` that aborts the marker's echo is followed, once the
shell's own group holds the terminal again, by the marker alone as a probe, so a cancelled
marker Run still ends. The command file's first line prints `<<<START:<nonce>:<pid>>>>`,
keeping the shell's status for the body, and the Run's output is cut at that mark, so
whatever the shell printed before it ran the file (the typed line's echo, a still-starting
shell's banner and second echo) goes, and a line in the echo's shape after it is the
program's; a file that never ran prints no mark, and its echo is cut by the echo rule. The
extra first line means a shell's own error messages name a line of the body one later than
written. dash and bash trace none of that line under `set -x`; zsh and fish write their
traces of it to their own stderr, after the mark. Both strategies produce identical result
shapes.

*Declared shell* (inline strategy). After `ssh host`, `sudo -i`, `docker exec -it … bash`, a
nested shell, or an `exec` into a shell without our integration, the program in front of the
terminal is a shell the daemon has no marks from — and often no filesystem in common with.
The caller declares it once (`session_declare_shell`; the kind is named only when it matters —
fish is typed differently, every POSIX shell the same); from then on shell Runs go to it. The
result of a Run whose line reads like `ssh`, `sudo -i` or a nested shell says so as a hint,
never as evidence. The text travels on the typed line itself:
bytes outside a small safe set go as `printf '%b'` octal escapes, so the line holds nothing a
line editor expands or completes; a body longer than one line (900 bytes) goes in pieces,
each acknowledged by the shell before the next is typed; the last line prints a start marker,
runs the text with `eval` in that shell (so `cd` and exports persist there) and prints the end
marker with the status. Markers carry the Run's nonce and are split in the typed text, so an
echo never matches. Output is attributed to the innermost running Run, and a start or end
marker cuts the read it arrives in, so a Run's output begins and ends exactly at its markers.
A Run is `starting` until its start marker arrives: when the program in front is not a shell,
nothing starts and the result says so. Cancel does what a person at the keyboard could — `^C`,
the end marker typed alone, `^\` — never a signal to the local foreground group (that is the
`ssh`), and names the enclosing Run as the escalation. The declaration ends by itself when the
Run whose program the shell is ends: its Runs in flight end `lost` (`enclosing-run-ended`),
queued ones too, and a note is journaled. When the caller asked for that end — an explicit
`exit` or `logout` Run is executing, or the caller cancelled the enclosing Run — shell
Runs go to the session's own shell (or to the declaration below) at once. Otherwise the end is
unexpected (a dropped connection, a remote shell that died; an end the daemon cannot attribute
to the caller counts as unexpected) and the daemon fails closed: the next shell Run is refused
once (`declared-shell-ended`, naming the enclosing Run), since a line meant for that shell
would otherwise run in the one underneath; the Run after it goes there (settled with the
reviewers of #11, 2026-10-18). One Run at a time per declared shell; a second hop is declared
again (the innermost running Run is its program); `none` takes a declaration back. Results of
declared Runs carry `shell` and `within` and report the cwd as unknown. G4 holds at a declared
prompt too: a partial line someone typed there makes a declared Run busy (`human-editing`) or
queued, a submitted one holds it (`human-submitted`) until the person's command is seen to end —
by the terminal's foreground process group where the declared shell runs on this terminal (a
nested shell, `sudo -i`: a group other than the shell's own in front means not yet, however long,
and the shell's own group in front again means done — but only once a different group has been seen
there, which is what shows the declared shell's jobs run on this terminal at all). Where a client
such as `ssh` holds the foreground throughout, its group reads the same as the shell's own and
nothing can be seen, so the hold ends only after the stale period (30 s) of quiet.

### 8.2 Process target

The daemon spawns `argv` (or `sh -c line`) itself, with pipes. Exit status is observed;
stdout and stderr are decoded UTF-8 and separate; attribution is exact; the shell is never
occupied. The **environment basis** is explicit (G7): by default the session's configured
environment and the shell's last-reported cwd; optionally a snapshot captured earlier by
`session_env_capture`, which runs `env -0` as a shell Run when the shell is available and
stores the result with its `seq`. The result names the basis, so an agent that activated a
virtualenv in the shell and then ran tests as a process Run learns why the tests did not see
it. Process target is the right choice for "run the tests, tell me the exit code"; shell
target is for anything that must inherit the shell's state or needs a terminal. A process
Run of its own tty — colour, progress bars, an interactive program without occupying the
shell — is a later addition (§16), because it introduces a second terminal per session and
every terminal-addressed operation would have to name it.

### 8.3 Services

`start` creates a Run on either target and attaches a Service: a readiness probe and a
health policy. First release probes: `pattern` (regex on the Run's output), `tcp` (port
accepts), `exit-within` (must *not* exit within N ms). `http` and `command` probes arrive
when something needs them. Health is re-evaluated on a schedule and on the Run's exit; an
exit is always observed as an exit (G9). A service whose process is `false` reports
`exited` with code 1 at its end mark, not `running` because bash is alive.

### 8.4 Cancel

Two contracts, per G29. A process Run is the daemon's child: signal its process group on a
schedule and observe the exit. A shell Run is the shell's foreground job: the daemon types
`^C`, then `^\\`, then signals the terminal's foreground process group when it is not the
shell's own, and waits for the shell to confirm each time. If the job survives, the Run
stays `running` and the explicit escalation is `session_close`. The daemon never signals a
shell to cancel a job in it; that decision is the caller's. `signal` follows the same rule:
`SIGINT`, `SIGTSTP` and `SIGQUIT` are typed as control characters, any other signal goes to
the foreground job's group, and signalling the shell itself is refused (that is
`session_close`).

---

## 9. Attachments and control

An Attachment is created when a principal opens a session over a connection: observers by
default; the **owner's** connection takes the seat automatically when it is free, so the
core flow — open, run, input — never needs a `control` call; other principals take the
seat on request when it is free, per policy. Each Attachment carries the principal's two
cursors (G22).
Observers see everything, including who the controller is and what they type (with
provenance), and may not act (G17). Terminal dimensions belong to the controller; the GUI
and the snapshot renderer scale or reflow their own view rather than resizing the PTY —
the observer effect Codex found is designed out (G14).

Handoff: `release` (controller gives up the seat), `take` (a waiting principal takes a free
seat), owner override, and a session-level policy. A connection that closes on purpose (a
finished CLI call, a host shutting down) gives up the seat at once; one that drops keeps it
reserved for its principal for 30 seconds, so a reconnect gets it back and nobody else can
grab it in between. The policies: `seat` (one controller, explicit
handoff), `owner-priority` (the owner may take at any time), or `open` (any shared
principal may `run` whenever the shell is idle without taking the seat; the seat is still
required for raw input and resize). `open` is how two agents alternating on a build shell
should feel: shell-mode runs are already serialized by the idle rule (G4), so the seat only
needs to guard what the idle rule cannot. Every control change is a journal event.

Visibility: `private` (owner and system only) or `shared` (any authenticated principal may
attach as observer, and may take control per policy). This is deliberately minimal — a guard
rail with provenance, not an ACL system — and it is enforced in the application layer for
every adapter (G18).

---

## 10. The host lane (MCPL)

### 10.1 Channels first, push events when closed

Each session is a bidirectional channel `terminal:<session>` with `address: {node,
session}`. This fits what the host already does with channels: host-owned open/close with
durable desired state, backscroll on open, tune-out routing, and per-channel conversation
binding. `publish` records what the agent said on the channel as a **note** in the journal —
visible to humans in the GUI and to other observers — and never types into the terminal:
hosts route an agent's ordinary speech to the channel that woke it, so publish-as-typing
executes prose (found in review, reproduced against agent-framework: the reply "Build
finished. A sensible follow-up would be: touch …" ran, and the loop it started did not
stop). Typing is `input` or `run`, always explicit (G25). Codex's
draft reserved channels for conversational surfaces and used push events for lifecycle;
the org's servers (discord-mcpl, portal-mcpl) resolve this with **dual delivery**, and so
does this design: while a channel is open, everything flows as `channels/incoming`; while
it is closed, lifecycle-class events (run exited, service ready or unhealthy, session
exited, watch fired, needs-input) are delivered as `push/event` with a flat `origin` that
includes `mcplChannelId`, and ambient output is not delivered at all. The agent chooses its
attention by opening and closing channels; the host's gate chooses wake by tags.

Descriptor:

```jsonc
{ "id": "terminal:build", "type": "terminal", "label": "build (node: mbp)",
  "direction": "bidirectional",
  "address": { "node": "mbp", "session": "build" },
  "metadata": { "node": "mbp", "speech": "none",
                "owner": "agent:linn@animalabs.ai", "controller": "agent:linn@animalabs.ai",
                "state": "idle", "cwd": "/w/app", "integration": "rich" },
  "initiallyOpen": false,
  "capabilities": { "history": { "maxMessages": 500, "supportsBeforeMessage": true } } }
```

`state` is the session's (`starting | idle | busy | unavailable | exited`, or `tui` while a
full-screen program holds the terminal) and `integration` its level (`rich | basic | none`,
G5). A live entry whose shell has exited still carries its cwd and integration with
`state: exited`; a history entry (closed, or recovered with no shell) carries `state: exited`
and its recovery class instead of them.

`channels/open` returns history only when the host asks (`history.limit`, ≤ 500),
rebuilt by the same segmenter as live messages and stamped with event times, and attaches
the connection's principal — the owner takes a free seat (§9), everyone else observes.
`channels/publish` appends a `note` event with the principal's provenance and answers
`{delivered, messageId}`; it needs only the `observe` verb. Channel descriptors carry
`metadata.speech: 'none'`, asking hosts not to route ordinary replies here at all
(`UPSTREAM-CHANGES.md` A6). Catch-up after reconnect resumes from the principal's
`delivered` cursor (G22): lifecycle messages owed since then are replayed with their
original ids. While a channel is closed, push
events are routed by **explicit interest** — Runs the principal started, Watches it set,
sessions it owns — never by "everything that happened in a shared session" (G28).

### 10.2 Segmentation

A `Segmenter` turns journal events into messages. One default policy, replaceable:

| Segment | Trigger | Content | Tags |
|---|---|---|---|
| run | `run.end` | ``[terminal] <s>: `<line>` → exit N in 1.2s · run <id> · read since=<seq>`` + the output's tail (4 KiB) | `terminal:run-finished` or `terminal:run-lost`, `terminal:exit=ok\|nonzero\|signal` (at most one: a lost Run, a cancellation without a signal and an end mark without a status carry none), `terminal:target=shell\|process`, and per recipient `terminal:origin=self\|human\|agent\|system` with the matching `chat:from-*` |
| service | a Service's status changes (`starting` is journaled, not a message) | status line with the probe's evidence | `terminal:service-<status>`: `-ready`, `-running`, `-unhealthy`, `-exited`, `-lost` |
| output | while a Run runs, at most once per cadence (default 10 s) per Run — two Runs running at once give two digests per cadence | digest: elapsed, bytes since the agent last read, the tail; `metadata.supersedes` names the previous digest | `terminal:output`, `terminal:running` |
| screen | in alt-screen: the first 500 ms after the last change (at most 1 s after the first), then at most once per cadence (default 10 s) when the screen changed | full screen text; `metadata.supersedes` names the previous screen | `terminal:screen` |
| needs-input | running, silent ≥ 5 s, last line unterminated and prompt-like | last lines + evidence | `terminal:needs-input` |
| watch | a watch fires | matched line / notice, burst-coalesced (≥ 1 s apart, `+N more`) | `terminal:watch=<label>`, `terminal:watch`, and `terminal:pattern`, `terminal:silence` or `terminal:idle` |
| control | controller changes | one line | `terminal:control` |
| lifecycle | session exit / recovery | code or recovery class | `terminal:session-exited`, `terminal:recovered=<class>` |
| human input | a human typed a line into a *program* (Enter, or 2 s quiet) | the line (`[redacted]` if sensitive) | `terminal:human-input`, `chat:from-human` — a line that starts a Run is not repeated: the Run's end is the message |

Every message's text opens with one self-describing line — session, run, exit, duration,
and the cursor that fetches more — because in some hosts the text is all a model sees, and
a held or summarized rendering keeps only its first few hundred characters. Every
message's `metadata` is structured: `{node, session, state, cwd, controller, kind, seq,
runId?, exit?, outputFrom?, outputTo?, nextCursor?, supersedes?}`, where `seq` is the journal
event the message reports — what the `delivered` cursor advances to. A catch-up summary
(`terminal:missed`) adds `count`, `from` and `to` for the messages it did not replay, and
`kinds`, their count by kind, on channel delivery only: a push event's origin carries scalars
alone, so a pushed summary names the kinds in its text. When ranges were gone it adds `lostFrom`
and `lostTo`: two scalars, for the same reason, spanning from the first gone range's start to
the last one's end, so seqs delivered between two ranges lie inside the span; the text names
each range. Message and event
ids are node-qualified (`<node>/<session>~<epoch>:<kind>:<seq>`, a digest's with `~<runId>`
and a screen's with its ordinal after the kind; the epoch is the journal's, so a forgotten name's new journal never reuses an
id), so two daemons never collide in a host's dedup window. A history boundary
(`beforeMessageId`) must be one of these ids; any other form is refused, not read as no
boundary. The idle segment of draft 3 is dropped: a prompt without a Run is not
news, and presence already says a session is idle. Digests exist because a delta
stream is wrong for every host: deferred events still enter context in agent-framework,
so a 1 s cadence would land about 180 messages during a three-minute build. Hosts that
honour `supersedes` collapse digests to one line; hosts that do not still see a handful.
Messages are batched per `channels/incoming` request within the segmenter's window. A
`run` message is withheld from a principal whose synchronous `run` or `await` was waiting
on that Run when it ended — the lane checks the session's in-flight waiters inside the
journal listener for `run.end`, and then holds the message for up to two seconds for the
call to return its result; a result that takes longer than that to build may be preceded by
its message — and from one whose later `await` already returned it; it is delivered to everyone
else, including that principal if its call had returned `running` (G28).

### 10.3 Tag ontology

Declared on `terminal.live`, `open: true`. `terminal:*` is the producer namespace; the only
reused core tags are the sender facet (`chat:from-human`, `chat:from-agent`,
`chat:from-self`) so portable "from a human" rules work. No terminal event claims
`chat:addressed`; whether a finished run deserves attention is the consumer's rule (G23).
Facets use the RFC-001 `key=value` form (`terminal:exit=nonzero`, `terminal:watch=<label>`)
and hosts match them with globs; bare tags name distinct event classes
(`terminal:run-finished`, `terminal:needs-input`), never a duplicate of a facet.

```jsonc
"suggestedTreatment": [
  { "tagsAny": ["terminal:needs-input", "terminal:watch", "terminal:session-exited", "terminal:recovered",
                "terminal:service-unhealthy", "terminal:service-exited", "terminal:service-lost"], "behavior": "immediate" },
  { "tagsAny": ["terminal:run-finished", "terminal:run-lost", "terminal:service-ready", "terminal:service-running",
                "terminal:human-input", "terminal:missed"], "behavior": "immediate" },
  { "tagsAny": ["terminal:output", "terminal:screen", "terminal:control", "terminal:note"], "behavior": "throttle" } ]
```

The five service classes are the statuses a Service reports after `starting` (§10.2):
`ready`, `running`, `unhealthy`, `exited`, `lost`; the shipped bridge configuration wakes on
every one of them.

The manifest digest (§17.2) admits only `[A-Za-z0-9._:*-]` in declared identifiers, so a
keyed value cannot appear in `suggestedTreatment`; that is why service statuses are distinct
bare classes, and why every faceted family also has a bare class a rule can name.
`terminal:origin` and the `chat:from-*` sender tag are computed per recipient: `self` is
the reader's own Run, which is what lets a host hold its own completions or break a loop.

### 10.4 Presence injection: what changed since you last looked

`context/beforeInference` → one `beforeUser` injection, namespace `terminal`, bounded to
about ten lines, covering the connection's open channels. It is a *delta*, keyed on the
principal's `read` cursor (G22), not only a status board, and its wording is exact:
"since your last read" means since the last tool result that returned this session's
content to this principal:

```
[terminal] build: running `npm test` 34s (cwd /w/app) · 2.1 KiB new since your last read (seq 4812)
[terminal] shell: idle · since your last read: `git stash` → 0 by human:discord:8841
[terminal] dev: service ready (listening on :3000) · watch dev-errors armed
[terminal] htop: tui · 3 screens new
```

No `observe`; the server never reads the user's message. Gated on
`contextHooks.beforeInference.inject.beforeUser`.

### 10.5 Feature sets

| Feature set | `uses` | Carries |
|---|---|---|
| `terminal.core` | `tools` | the ten core tools (§11, `session_declare_shell` among them) |
| `terminal.control` | `tools` | `signal`, `control`, `resize`, `session_env_capture` |
| `terminal.services` | `tools` | `start` |
| `terminal.watch` | `tools` | `watch`, `unwatch`, `watches`, `wait_for` |
| `terminal.search` | `tools` | `search` |
| `terminal.live` | `pushEvents` | lifecycle push events by explicit interest; declares the tag ontology |
| `terminal.channels` | `channels.register`, `channels.lifecycle`, `channels.incoming` | sessions as channels; while open, everything flows on them |
| `terminal.annotate` | `channels.publish` | publish records a note |
| `terminal.presence` | `contextHooks.beforeInference.inject.beforeUser` | the presence delta (§10.4) |

Tool tiers need only `tools`, so a tools-only grant still has the whole core, and push
delivery depends only on `pushEvents`, so a grant without channel capabilities still hears
its completions. Delivery checks both the capability and the enabled set.

`uses` is exhaustive and fail-closed (SPEC §6.4). `featureSets/update` is answered as a
Request with a degradation receipt; nothing is delivered before the initial policy arrives,
channel registration goes out only after the receipt is on the wire (and is retried while a
host still refuses it with `-32002`), and a malformed policy fails closed to an empty grant.
No feature set declares `rollback` (G24). The manifest carries a §17.2 revision computed by
`@animalabs/mcpl-core`.

### 10.6 Host profiles

The same server serves three kinds of host. Nothing in the core changes between them;
what changes is which affordances carry the weight.

**connectome (agent-framework).** The full lane: channels, the gate, presence. Agents
compose primitives with `code_execution` — every tool is an async Python function
returning the tool's text, parsed with `json.loads`, fanned out with `asyncio.gather` —
and a background script with `wake_agent` is an alternative to a daemon watch for
conditions the agent wants to express in code. Daemon watches stay for cost (no
interpreter) and for hosts without scripts; health probes stay in the daemon because
monitoring must not depend on an agent's interpreter being alive. The MCPL hop times out
at 60 s even inside a script, so `wait` keeps its 55 s ceiling.

**Claude Code via `mcpl-cc-bridge`.** The bridge is a plugin that makes a Claude Code
session a full MCPL host: it proxies our tools as `terminal__<tool>`, delivers
`channels/incoming` and `push/event` as `<channel source="mcpl">` blocks that start a
turn, routes wake on tags with per-server rules that are AND-sets of exact tag strings
(`wake` rules first, then `hold`, default wake), folds held deliveries into the next turn
as a `<held>` block of one trimmed line each (300 characters, cap 50 per server, evictions
counted), fans `UserPromptSubmit` out to `context/beforeInference` and returns injections as
`<mcpl-context>` additional context, and offers `mcpl_open` / `mcpl_close` / `mcpl_send`
(text-only publish). Hooks fire per user turn, not per inner inference. Consequences for
this server:

- **The message text is the payload.** Only a few `origin` fields survive as metadata, so
  every channel message opens with a self-describing line — session, run, exit, duration,
  and the `read since=<seq>` that fetches more — and stays short enough to survive the
  300-character held rendering.
- **Faceted tags need glob matching.** A bridge rule today matches exact strings, so a rule
  cannot name `terminal:watch=*`. The right fix is in the bridge — glob matching in wake
  rules, which agent-framework's gate already has — not doubled tags on the wire. Until it
  lands, the server can emit the bare class (`terminal:watch`) beside the faceted tag as a
  documented interim.
- **Ambient-class messages are digests, not deltas.** While a run is in progress it
  sends at most one progress message per cadence (default 10 s) — elapsed, bytes
  since the agent last read, the tail — carrying `metadata.supersedes` naming the previous
  one; two Runs in progress in one session are two digest chains. This is not bridge-specific: draft 2's 1 s delta stream would have landed roughly
  180 messages in any host's context during a three-minute build, since deferred events
  still enter context in agent-framework. The bridge merely made it visible. Hosts that
  honour `supersedes` can collapse the digests to one line; hosts that do not still see a
  handful rather than hundreds.
- **Ship the bridge configuration.** A documented `.mcpl-bridge.json` entry: the grant
  (`tools`, `pushEvents`, `channels.{register,lifecycle,incoming,publish}`,
  `contextHooks.beforeInference.inject.beforeUser`, no `observe`), `openChannels` for the
  agent's own sessions, a wake policy that wakes on `terminal:run-finished`,
  `terminal:run-lost`, `terminal:needs-input`, `terminal:watch`, `terminal:session-exited`
  and the `terminal:service-*` classes and holds `terminal:output`, `terminal:screen` and
  `terminal:control` (shipped as `next/config/mcpl-bridge.json`), and the
  permissions allowlist — one wildcard entry covers every proxied tool, which is one reason
  the tool names share a prefix — so `terminal__run` and `terminal__input` do not stall
  behind prompts.
  Proposed upstream: a `"terminal"` wake preset in the bridge beside `"chat"`.
- **`input` is how anything is typed.** `mcpl_send` (publish) records a note (§10.1); keys,
  lines and sensitive input go through the proxied `input` tool, and commands through `run`.
- **What the bridge gives Claude Code that it lacks natively:** being woken when a
  background process in a persistent, shared terminal finishes; seeing what a human typed
  there; a status line for its terminals at the top of every turn.

Neither the bridge nor the host is immutable, so the affordances above split into what the
server does regardless and what is better fixed upstream. **Proposed bridge changes**
(each small): glob matching in wake rules; pass all scalar `metadata` fields of a channel
message through as block attributes, not only the chat-shaped `origin` fields; a
`wake: "suggested"` option that accepts a server's declared `suggestedTreatment` as that
server's policy, which is RFC-001 §5.2's explicit acceptance and removes the need for
per-server presets; collapse held lines that a later `supersedes`. **Proposed host
change** (agent-framework): `code_execution` hands a script `structuredContent` when a
tool result carries it, so scripts parse the structure while the model reads the
transcript; the same `suggestedTreatment` acceptance could sit in recipe gate config.

**Plain MCP (Cursor, Claude Desktop, Claude Code without the bridge) via the stdio shim.**
No lane. `run` / `await` / `read` carry the workflow, `--profile core` keeps the surface
small, and the CLI (§11) is how a Bash-shaped harness composes: a script that starts runs
across sessions, pages `read` by cursor, and loops on `await` is the `code_execution`
equivalent for a harness whose only programmable surface is a shell.

---

## 11. The application API and the tools

The **typed application API** is the internal contract: services `Sessions`, `Runs`,
`Attachments`, `Journal`, `Watches`, `Control`, each operation with a schema for its
params, result and errors, and each event typed. Adapters (§12) are thin translations of
it. Tests exercise it directly. Tool names below are the MCP projection.

| Tool | Purpose | Result |
|---|---|---|
| `session_list` | sessions with state, cwd, owner, controller, integration, backend, services, watches, retention | `{sessions: […]}` |
| `session_open` | create or attach: `cwd`, `shell`, `env`, `visibility`, `control`; the owner takes the free seat; reopening a name whose shell ended starts a new shell (owner only), history continuing | `{created, info, role, ignored?}` |
| `session_close` | graceful (SIGHUP) or `force`; history stays readable unless `forget` | `{closed, forgotten}` |
| `run` | `target: shell \| process` (default shell); `wait` ms (default 20 000, max 55 000); `queue` | `{runId?, state: exited\|running\|…\|busy, exit?, signal?, durationMs?, cwd, output: {text, truncated, seq, nextCursor}, busy?}` |
| `start` | a Run with a Service: `ready: {pattern, tcp, exitWithinMs, timeoutMs}`, `fail: {pattern}`, `health: {tcp, intervalMs}`, `wait` | `run`'s shape plus `{service, probe, evidence}` |
| `await` | block ≤ `wait` ms for a Run to end: `{runId}` (session optional); works for Runs of ended sessions | same shape as `run` |
| `cancel` | cancel a Run under the contract for its target (G29): `{runId}` | `{state, contract, steps, escalation?}` |
| `input` | `text` and/or `keys`, sent exactly as given with nothing appended; `sensitive` flag; requires the controller seat | `{seq}` |
| `signal` | `SIGINT`/`SIGTSTP`/`SIGQUIT` typed as control characters; other signals to the foreground process group, never the shell | |
| `control` | `take` \| `release` \| `status` | `{controller}` |
| `read` | `since` pages forward head first, `runId` pages one Run's output, `tail` gives the last N lines; `until`, `as: text\|events`, `maxBytes`, `limit` | `{text\|events, seq: [from, to], nextCursor, more, gap?, truncated, oldestSeq}` |
| `screen` | the terminal's current screen | `{cols, rows, alt, cursor, lines, title, seq}` |
| `search` | regex over output lines with `seq` anchors and context; without `since`, a bounded recent window it reports | `{matches, scanned, more, bounded}` |
| `watch` / `unwatch` / `watches` | a standing `pattern`, `silenceMs` or `idle` predicate (§4); fires as a lifecycle message to its owner | `{watchId, kind, label, …}` |
| `wait_for` | block ≤ `wait` ms for `pattern` (with `since`, output already printed counts), `silenceMs` or `idle` | `{matched, kind, match?, line?, seq?, elapsedMs, nextCursor}` |
| `session_env_capture` | snapshot the shell's environment for later process Runs (§8.2) | `{seq, count}` |
| `resize` | cols/rows; controller only | |
| `snapshot` | later: render the current screen to SVG/PNG from the emulator buffer | image block |

`wait` values sit below the host's 60 s request timeout, which is what turns a timeout into
an ordinary `running` (G3). Every mutating tool of the core, control, services, watch and
search tiers accepts an `idempotencyKey` (G16); the compat pack does not — it reproduces the
1.x tools, which had no such key, and ignores one passed to it.

**Result shape.** Every successful tool returns one result in two renderings. The **text** is a
readable transcript for the model — the command's output as a human would see it, closed by
one fixed-format status line such as `[run r41 exited 1 in 8.2s · next=4990]`. The
**structured envelope** is `structuredContent`, conforming to the tool's `outputSchema` where
it declares one (`run`, `await`, `start`, `read`, `screen`, `cancel`, `session_list`,
`session_open`, `search`, `watch`, `watches`, `wait_for`); the other tools return a documented
envelope without a published schema. Stable fields a script can rely on: `runId`, `state`,
`exit`, `durationMs`, `nextCursor`, `truncated`, `output`, in camelCase like the rest of the
MCPL wire. A failed call is an `isError` result that carries no envelope (G27). A script must never have to parse prose to tell `exited` from `running`; the
envelope's `state` is the only authority on completion (G27). Until a host's script runner
prefers `structuredContent` — agent-framework's `code_execution` hands scripts the text
today, see `UPSTREAM-CHANGES.md` — a per-connection `resultText: transcript | json` setting
defaults to `json`, which is what the current tool emits, and hosts opt into `transcript`
in their server entry.

**Tiers.** The default surface is ten single-purpose tools — `run`, `await`, `read`,
`screen`, `input`, `cancel`, `session_list`, `session_open`, `session_close` and
`session_declare_shell` — judged by
Codex's test: does the core complete common workflows on its own? Start, wait, read, look,
type, stop, declare a shell in front, and manage sessions do; that is why `await` on a run id is core and the
pattern, idle and silence waits are not. The core maps onto what a Claude already knows from
Claude Code's `Bash`, background tasks and terminal pane, and onto Codex's `exec_command` /
`write_stdin` pair unbundled. Ten plain tools beat six with folded modes. Everything else
is opt-in progressive disclosure: `terminal.control` (`signal`, `control`, `resize`,
`session_env_capture`), `terminal.services` (`start`), `terminal.watch` (`watch`, `unwatch`,
`watches`, `wait_for`), `terminal.search` (`search`), and later `terminal.snapshot`. The mechanism is two-layered, because
feature sets are descriptive bundles and not authorization (SPEC §6): the server filters
`tools/list` by the feature sets the host enabled, as discord-mcpl does with its
`featureSetForTool` map, and the host enforces its own tool policy at listing and dispatch —
agent-framework's `enabledTools` / `disabledTools` on the server entry, the bridge's
`enableFeatureSets`. The core is the default in every host, not a documented option: the
shipped recipe (`next/config/agent-framework.recipe.json`) enables `terminal.core`,
`terminal.live` and `terminal.presence` and nothing else; the bridge entry
(`next/config/mcpl-bridge.json`) adds `terminal.channels` and `terminal.annotate`, which
its `mcpl_open` and `mcpl_send` use; and plain MCP starts in `--profile core`
(`full` adds every tier; `compat` serves the 1.x names instead). Names are
short verbs in `snake_case`, the org's convention.

**CLI.** `tsm` is a thin client over the same application API with `--json` on every
command, so a harness whose programmable surface is a shell composes the server in scripts:
`tsm run build 'npm test' --wait 20s --json`, `tsm read build --since 4812`, `tsm await
r41`. It is not a second surface; it is the tool table with a different transport.

### 11.1 Tool design rules

What makes a surface natural to a model is not its size. Claude Code's `Bash` works
because its name is the verb the model is already thinking, its parameters are orthogonal
knobs on that one intent, and its result reads like a terminal. The current server's
`sendInput`, whose Enter default flips depending on whether `keys` is present, is the
opposite: a mode that changes meaning, learned wrong once and over-specified forever. So:

1. **One verb per tool.** A tool's name is an intent a model already has: run, read, see
   the screen, type, cancel. Distinct intents are distinct tools; nothing is folded behind
   an `action` parameter.
2. **Parameters scale a tool; they never re-mean it.** `wait`, `cwd`, `maxBytes`, `mode`
   change how much or where; they do not turn `run` into `await` or `input` into `read`.
3. **No cross-parameter defaults.** A default never depends on whether another parameter
   was given. `input` sends exactly what it is handed and appends nothing; Enter is
   `keys: ["Enter"]`. There is no implicit Enter anywhere: draft 3 made `channels/publish`
   the one exception, and review showed hosts publish an agent's prose (§10.1).
4. **Every description says when to use it instead of its neighbours.** `screen` is what
   the terminal shows now; `read` is the journal by cursor or run; `search` is a regex over
   history. Descriptions are the manual the model actually reads, and they are part of
   this design, not an afterthought.
5. **Results are transcripts with a fixed status line** (§11, G27). A model should be able
   to glance at the bottom line and know what happened.
6. **Names are allowlistable with one wildcard.** Through the bridge every tool shares one
   prefix, so a Claude Code user writes one permission entry, as they do for `Bash`.
7. **The compact core is the default everywhere,** and the count is an empirical question
   the journal can answer (§16, Measure).

A compatibility pack (`runCommand`, `tailLogs`, `searchLogs`, `sendInput`, `sendSignal`,
`listSessions`, `killSession`, `killAll`, `launch`, `takeScreenshot`) maps onto the above for one
release so existing recipes keep working, and is removed in the release after.

---

## 12. Topology and transport

```
 agent-framework hosts            Cursor / Claude Desktop / Claude Code        humans
   │ MCPL over wss (?token / aid1)     │ stdio                                 │ https
   │                                    ▼                                       ▼
   │                          terminal-sessions-mcp (shim: stdio ↔ ws proxy)  browser GUI
   ▼                                    │                                       │
┌──────────────────────────────── termd — one per node ────────────────────────────────┐
│ transport/  ws server: JSON-RPC 2.0 with two method families —                       │
│             MCP+MCPL (tools, channels, hooks, manifest) · terminal/* (attach, cursor  │
│             subscribe, screen diffs, control) · static GUI hosting · /health         │
│ api/        typed application API · schemas · adapters (mcp/mcpl, native, compat)    │
│ policy/     principals · verbs · control seats · per-principal cursors               │
│ core/       Session FSM · Run lifecycle · Journal + views · Screen · Marks · Watches  │
│             Segmenter · Probes                                                        │
│ backends/   pty (node-pty, in-process) · keeper (durable, unix socket) · scripted     │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **termd**: supervised by launchd/systemd as today (units in `next/config/`); loopback plus
  token by default, `aid1` when available. A connection names itself in its URL's query:
  `token` (or an `Authorization: Bearer` header), `profile` (plain MCP only: `core | full |
  compat`), `resultText` (`json | transcript`, §11), `connection` (a label for logs and usage
  records; the daemon generates the identity), and `client=cli`, which the `tsm` CLI sends so
  usage records count it with the GUI as the native family rather than as an agent surface.
  Serves the GUI's static files; the GUI is a
  client of the `terminal/*` family over the same WebSocket. socket.io and express go away.
  Every HTTP request and upgrade must name an allowed Host (loopback names, the bind
  address, `--allow-host`; non-loopback binds require both a credential and
  `--allow-host`), which stops DNS rebinding; an `Origin` is accepted only when it is
  same-origin with that Host — the daemon's own GUI — which stops cross-site WebSocket
  hijacking; and a same-origin browser connection is the GUI's human, principal
  `human:gui:<token principal>`. Nothing a client sends can take the daemon down: frames
  are classified before use and capped (4 MiB), requests in flight per connection and
  connections per daemon are bounded, and connection identities are generated by the
  daemon, so no client can detach another's attachments by reusing a label.
- **The shim**: a pure stdio ↔ WebSocket proxy with no logic, for stdio-only hosts.
- **The keeper**: an optional per-session process, spawned detached, holding the PTY
  master and exposing it over a unix socket with a small frame protocol (bytes, resize,
  signal, exit). The daemon connects on start and reconnects after a restart; the keeper
  buffers output during the gap (bounded, so the journal shows a `gap` if it overflows).
  Journals are the daemon's and are file-backed, so a restart under the keeper is
  `recovered: continuous`; without it, `history-only` (G20).
- **Native methods** exist for the GUI and CLI and are the one non-MCP part of the
  surface, kept small: attach with a cursor, stream journal events and screen diffs, take
  or release control.
- **Multi-node**: a recipe lists one terminal server per node; descriptors carry
  `address.node`. Federation is out of scope.

---

## 13. Internal architecture and seams

One npm package; 2.0's three bins (`termd`, `tsm`, `tsm-shim`) beside 1.x's four until the
swap (§16); hard internal layering enforced by directory and by a test that fails on
cross-layer imports (`next/spec/layering.spec.ts`, type-only imports included: a top-level
module — `daemon.ts`, `index.ts` — wires the layers and is above them all, so nothing below
may import it, and `core/` takes `backends/types` alone from `backends/`, never a backend):

```
src/core/        Session, Run, Service, Journal, JournalStore, views, Screen, Marks,
                 ExecStrategy, Probe, Watches, Segmenter, Principal, Control
src/backends/    ExecutionBackend: node-pty; keeper client; scripted (tests)
src/shell/       integration scripts for bash, zsh, fish (PowerShell later); detection
src/api/         application API + schemas; adapters: mcp/mcpl (on @animalabs/mcpl-core),
                 native, compat
src/transport/   ws server, auth, static hosting, /health
src/shim/        stdio ↔ ws
src/cli/         thin client
gui/             static app (xterm.js) as a native client
```

Seams. A second implementation is required only where one is real on day one; elsewhere a
seam is a module behind an interface, not an extension framework, and it earns a second
implementation with a second use:

| Seam | This release | Later, when a use exists |
|---|---|---|
| `ExecutionBackend` | node-pty in-process; scripted (the deterministic test backend) | keeper; tmux control mode; ssh; container |
| `JournalStore` | memory ring; append file | chronicle |
| `ExecStrategy` | integrated (marks); marker (fallback) | |
| `ReadinessProbe` | pattern; tcp; exit-within, as plain modules | http; command |
| `Segmenter` | one module | a second policy, if traces want one |
| `Renderer` | text | svg, png |
| `ProtocolAdapter` | mcp/mcpl over ws; native ws; stdio shim | compat pack at swap-in (§16) |

`core/` imports nothing from `api/` or `transport/`. Dependencies — the packages `next/src`
imports: `node-pty` (native, unavoidable), `@xterm/headless` (pure JS, 6.x) with
`@xterm/addon-serialize` (the screen's serializer, `core/screen.ts`), `@animalabs/mcpl-core`
(zero-dep) and `ws`. Nothing else: the validation of §15 is hand-written (`api/validate.ts`),
not a schema package.

---

## 14. Rendering

The session's headless emulator is the source of the current screen and the sole responder
to terminal queries (G25). Transcripts come from a scratch emulator fed one range, with the
projection semantics of §6 stated in the tool description. Alternate-screen entry and exit
are journal events, so TUIs are recognised, not guessed. Image snapshots of the current
screen — SVG from the buffer grid, PNG via a small optional dependency — are a later
addition; nothing about them touches the live PTY.

---

## 15. Quality bar

- TypeScript strict, ESM, Node ≥ 20.19 (`engines` says `>=20.19.0 <21 || >=22.12.0 <25.0.0`: 20.19 is the
  earliest Node 20 that loads the package's dependencies, Node 18 has reached its end of
  life, and 21 and 22 before 22.12 are left out because the 1.x session-cli cannot run on them). No `any` at boundaries. Every operation validated
  against its schema before dispatch. Errors are typed with codes. A tool's failure reaches
  hosts as MCP carries one: an `isError` result whose text opens with the code
  (`session_not_found: …`) and carries no envelope; a protocol failure is a JSON-RPC error.
  Only the compat pack answers in 1.x's `{success: false}` shape, for its one release.
  Regex support is capability-checked: Node 20's linear engine refuses lookbehind, and
  misorders some nullable bounded repetitions. Such patterns receive an explicit error
  on that engine instead of a wrong match or an automatic switch to backtracking.
- Structured logs (JSON lines) with `session`, `principal`, `runId`; client strings are
  length-limited and JSON-encoded, tokens never appear. `/health` reports per-session
  state, backend, integration, controller, the current Run, journal stats (bytes, retention,
  a failed store) and the emulator's backlog, plus connections by kind; on a host without bash
  or a `/dev/fd` of the process's own, `status` is `degraded` and `unsupported` carries the
  reason sessions and process Runs are refused. Graceful drain on
  shutdown ends in-flight Runs `lost` with reason `daemon-shutdown`, ends every process
  group a process Run started, and hangs up each shell as a closing terminal does: the shell
  and its foreground job end, while a job the shell detached on purpose (`nohup`, `setsid`,
  `disown`) lives on, as G19(c) says — which is why the systemd unit stops termd with
  `KillMode=process` rather than killing its whole cgroup. None of this is needed under the
  keeper.
- Tests in three layers, and the guarantees are the test plan:
  1. **Core against the scripted backend** — fast, deterministic, replaying recorded PTY
     transcripts including TUI sessions and floods. G1–G30 each have at least one test
     named for them.
  2. **Real-PTY matrix per shell in CI** — macOS bash 3.2, bash 5, zsh, fish, dash:
     integration detection, both exec strategies, multi-line, cwd, exit codes, shell
     death, stdin readers, marker-shaped output, cancel escalation, daemon restart with
     the file store.
  3. **Protocol** — MCPL conformance against the `mcpl/conformance` vectors, a host-shaped
     harness for channel lifecycle, dual delivery and catch-up, and the compat pack against
     the old tool contracts.

---

## 16. Plan

**How increments are cut.** By dependency and by complexity — never by review cadence. The
team is the review: milestones are dogfooded by the agents that will use them, and a
milestone lands as one bundle rather than a drawn-out series. Something is deferred only
when it would add complexity the first milestone does not need, or when a decision should
be made on evidence the first milestone will produce. Each deferral below says which.

**Implementation status (2026-09-24; landing shape 2026-10-19).** Milestones 1 and 2 are
built in `next/`, and the package ships them beside the 1.x code rather than in its place
(PR #22): `package.json` points the 1.x names (`terminal-sessions-mcp`, `session-server`,
`session-gui`, `session-cli`) at the 1.x code, unchanged, and adds `termd`, `tsm` and
`tsm-shim` for 2.0; the 1.x server keeps ports 3100 and 3200, `termd` listens on 3101.
Making 2.0 the default — `terminal-sessions-mcp` becoming the stdio shim serving the compat
pack, `session-server` starting `termd`, the 1.x code retired — is a later release, antra's
call as the maintainer; until then the shim serves the 1.x tool names with
`--profile compat`. Milestone 1's exit criterion passes: the acceptance sentence runs against
agent-framework's real host code and against mcpl-cc-bridge's host classes
(`next/acceptance/`), and the suite (285 tests then; 717 at #22's `dbf3efc`: scripted, real
bash 3.2 / zsh / sh / dash / fish, end to end over the endpoint, a headless browser for the
GUI, daemon restarts) passes.
Milestone 2's contents are in: the compat pack, services with pattern/tcp/alive probes,
watches and `wait_for`, digests with `supersedes`, screens, needs-input, presence, the GUI
as a native client, socket.io/express/puppeteer gone from the runtime, tiers and profiles,
Measure (`usage.jsonl`, `tsm usage`) and shipped configurations (`next/config/`). Not done
here: switching agent-framework recipes to `mcplServers` (their repository) and a week of
Measure traces from real use, which need deployment. Facts the build taught, folded in
above: an interactive bash defers SIGHUP while printing its prompt, so readiness is the
prompt-end mark and close retries; a Run's end mark precedes the prompt that confirms
availability (`prompt-pending`); bash 3.2 does not pass its SIGHUP on to a job started from
a sourced file, so closing a session hangs up the foreground job itself; a line typed
through the editor is changed by history expansion and completion, so every daemon line is
a command file; hosts publish an agent's replies to the channel that woke it; a user's rc
can load another terminal's shell integration (Ghostty), hence keyed marks; the manifest
digest forbids `=` in declared identifiers, hence bare tag classes for statuses; a
`/tmp` directory can vanish under a cleaner, hence the command directory's fallback.

**Review round (2026-10-13).** An external review of the draft PR tried combinations of
failures rather than single edge cases, and found five places where a heuristic had become
authoritative evidence or a contract was not upheld through a failure: a replaced shell was
declared `idle` and the queue drained into the replacement (G4); the exec handoff exported
the mark key to every child of a line containing the word `exec`, so a child could forge a
completion; a refused completion notification stopped pinning `delivered` (G22); after a
restart, a key reused with other arguments executed (G16); process output was promised
byte-exact but decoded. All five are fixed above with the reviewer's reproducers as tests:
the `unavailable` state (§7), the private key file and launcher (§7, "Marks are
authenticated"), retried deliveries with the same message id (G22), the journaled key
identity (G16), and the narrower output promise (G7, G10, §8.2). The same round decided and
built the declared shell (§8.1, §18 item 8): after `ssh host`, or after an `exec` into a
shell without our integration, the caller declares the program in front a shell once, and
plain Runs go to it, inline, until the Run that opened it ends.

**Milestone 0 — close the old line.** Land upstream PRs #7, #8, #9; publish 1.7.0; move
the repository under `anima-research`. Nothing below depends on these, but they stop the
bleeding for deployed agents.

**Milestone 1 — the central promise, across a real host boundary.** Codex's sentence is
the acceptance test:

> Start work, receive a run id, stop waiting, disconnect, reconnect, recover retained
> output, observe the correct outcome, and receive a useful completion notification through
> a real MCPL host — while another client observes without interfering.

Contents: entity model and application API; journal with both stores; emulator and the
current screen; marks with levels and the state machine; shell and process Runs with both
exec strategies and explicit environment basis; Attachments with `delivered` and `read`
cursors; owner auto-seat; both cancel contracts; recovery reporting; native WebSocket
family; the MCPL adapter in its smallest real form — channels with dual delivery,
`run-finished` and `session-exited` messages, outcome-delivered suppression, explicit-
interest routing, manifest revision; the stdio shim; the CLI; a per-agent token map so
principals are real before `aid1`. Exit criteria: the sentence above passes against
agent-framework and against Claude Code through the bridge; the G1–G30 suite passes on the
scripted backend and on the real-PTY matrix, including timeout, cancel on both targets,
shell exit, interactive input, simultaneous clients, output flooding, and restart with the
file store. Dogfooded on a second port beside the deployed daemon.

Deferred from milestone 1, with reasons: services and probes (their own contract; §8.3);
watches and `wait_for` (a second event source; cheap, but not needed for the sentence);
in-flight digests and the presence injection (both depend on the `read` cursor semantics
being right in practice first — evidence); the GUI as a native client (the old GUI still
works against the 1.x server, which ships beside 2.0 — the compat pack serves the 1.x *tool
names* to MCP hosts, not the 1.x GUI's own `session.create`/`exec`/`output`/`search`
WebSocket protocol, which termd does not speak); tiers and profiles (evidence from Measure
decides the boundary).

**Milestone 2 — swap-in.** Everything that makes milestone 1 pleasant and lets it replace
the deployed daemon: the compat pack under the old tool names; services and the three
first-release probes; watches and `wait_for`; digests with `supersedes`; the presence delta;
the GUI as a native client whose emulator does not answer queries; puppeteer, express and
socket.io removed; tiers and profiles; **Measure** instrumentation; shipped recipe and
bridge configurations. agent-framework recipes switch the `shell` entry to `mcplServers`.

**Measure, before fixing the defaults.** "Current workflows seem functional" is weak
evidence: models route around friction silently — a harness that resets the working
directory after every command gets absolute paths, not complaints, and a timeout that may
mean "still running" gets a reflexive `tailLogs` and a re-run. The daemon sees every call,
so milestone 2 instruments it: per-tool and per-host usage and error rates, and confusion
signatures — `read` immediately after a `run` whose `wait` was too short, `input` sent twice
within a second, `screen` polled in a loop, `cancel` after a `busy`. Run the compat profile
and the full profile side by side on the same agents for a week and let the traces decide
the tier boundary, the default `wait`, and the digest cadence.

**Milestone 3 — durability, identity, depth.** Keeper backend; `aid1` principals;
multi-node addressing; historical screens via emulator checkpoints; image snapshots;
Run-owned terminals (a process Run with its own tty, which is what makes every
terminal-addressed operation take a terminal argument); `http` and `command` probes;
control policies beyond `seat` and `owner-priority`; Windows best effort; compat pack
removed. Each of these is deferred for complexity, not for pacing.

**Ownership.** Codex proposed agreeing the guarantees, then dividing implementation.
Section 5 is that agreement. A natural split once it is accepted: one agent owns `core/` +
`backends/` + the guarantee suite; the other owns `api/` + `transport/` + `shell/` + the
protocol tests; the application API schema is the shared artifact both build to. Milestone
1 is one bundle from both.

---

## 17. Alternatives considered

- **tmux control mode as the backend.** Durability, panes and structured output for free.
  Rejected for the core because it binds the model to tmux's process and vocabulary,
  complicates Windows, and puts a second event grammar between the shell and the journal.
  It is a good *third* `ExecutionBackend`.
- **Polling tools only, no MCPL.** Simpler, and precisely what the brief names as unsuited
  to high-capability workflows.
- **The terminal inside the host as a module.** Loses sharing across hosts and humans and
  loses persistence across host restarts — the product's original reason to exist.
- **Regex ANSI cleaning.** Cannot resolve cursor motion or the alternate screen, which is
  the output agents most need help with.
- **Push events as the primary lane, channels only for conversation.** Codex's draft.
  Rejected in favour of channels with dual delivery because the host's attention, backscroll,
  tune-out and per-channel binding machinery all key on channels, and the org's servers
  already use exactly this pattern (Appendix C).
- **Streaming raw bytes to the host.** The host would spill every chatty build to a file and
  wake on nothing useful.

---

## 18. Open decisions for antra

1. **Direct MCPL over WebSocket as primary**, stdio shim secondary (recommended), versus
   keeping the per-agent stdio frontend as the main path.
2. **Keeper in milestone 1 or 3.** The biggest operational win and the most platform-specific
   code. Recommended: milestone 3, with the backend seam and file-backed journals in milestone 1 so
   it slots in without churn.
3. **A reserved activity-stream tag vocabulary.** `chat:*` is for messaging. Terminals,
   workspace watchers and future robotics servers all emit "something happened, here is how
   it ended". Whether `terminal:*` stays producer-local or seeds a second reserved core is
   an RFC-001 question.
4. **Process mode as the default for `run`.** It gives exact guarantees; shell mode gives
   persistence. Recommended: `run` defaults to shell mode for continuity with agents'
   habits, with `target: "process"` one word away, and the tool description saying when to use
   which.
5. **`snapshot` at all.** Text screens cover most of the value.
6. **Windows scope.** Recommended: in-process backend only, best effort, milestone 3.
7. **Run-owned terminals at all.** A process Run with its own tty is the one feature that
   turns "a session has a terminal" into "a session has terminals". Milestone 3 assumes
   yes; the alternative is that anything needing a tty is a shell Run, forever, which is
   simpler and may be enough.
8. **A declared shell.** Decided 2026-10-13: declare once (§8.1). After `ssh host`, or after
   an `exec` into a shell without our integration, the program in front is a shell the caller
   knows about but the daemon has no evidence for; the caller's declaration is that evidence,
   and plain Runs flow to the shell until the Run that opened it ends. The alternative
   considered was naming the shell on every `run`, which refuses rather than runs locally
   when a connection drops, at the cost of a field on every remote command. Comfort won; the
   drop is made visible instead (the opening Run's `run.end`, the Run in flight ending
   `lost`, a journaled note). Without a declaration, refusal while busy stays the default. A
   `termd` on the remote machine with a forwarded port remains the way to keep full
   semantics across tunnel interruptions.

---

## Appendix A: journal event schema

The schema of record is `EventInput` in `next/src/core/types.ts`; this appendix mirrors it,
field for field, with the comments that say what each field is for.

```ts
type JournalEvent =
  | { seq; ts; type: 'output';      data: string; runId?; stream: 'pty'|'stdout'|'stderr'; attribution?: 'exact'|'temporal' }
  | { seq; ts; type: 'input';       data: string; principal; kind: 'text'|'keys'|'paste'|'protocol-reply'; sensitive?: true; runId? }  // sensitive: data is '[redacted]'
  | { seq; ts; type: 'run.admit';   runId; target: 'shell'|'process'; line?|argv?; principal; origin: 'self'|'human'|'agent'|'system'; queued: boolean; idem?; shell?; within?: string|null }  // idem: key identity (G16); shell/within: a declared shell's Run (§8.1)
  | { seq; ts; type: 'run.start';   runId; cwd; line?; envBasis?: 'configured'|'snapshot'; cols?; rows?; pid?; pgid?; startTicks?; bootId?; strategy?: 'rich'|'basic'|'marker'|'inline'; nonce?; shellPid? }
                                    // C mark, or spawn. cols/rows: the geometry the transcript is projected at (§6); pid/pgid: a process Run's group, ended by recovery (G19c);
                                    // startTicks/bootId: the leader's /proc start time in clock ticks and the boot id, so recovery judges its group without a clock frame (Linux);
                                    // strategy/nonce: how the Run's boundaries were observed and the nonce in its marks, so history cuts its plumbing as the live transcript did (§8.1)
                                    // shellPid: the shell an inline Run's start marker named, the one whose probe answer ends the Run, for history to judge answers by (§8.1)
  | { seq; ts; type: 'run.end';     runId; state: 'exited'|'cancelled'|'lost'; exit?; signal?; reason?; durationMs; leftovers?: true; pipeStatus?: number[]; recoveredEnd?: true; groupJudged?: true; lastAliveTs? }
                                    // leftovers: a process Run's group had members when its process exited; pipeStatus: a pipeline's statuses, one per command (§8.1);
                                    // recoveredEnd: recovery wrote this end; groupJudged: recovery ended or left its group; lastAliveTs: the dead daemon's last journal time, which bounds the group a later recovery may take for the Run's
  | { seq; ts; type: 'run.judged';  runId }                                                     // recovery judged this Run's group (ended or left it) after the Run had ended: folds into groupJudged, so no later restart judges it again
  | { seq; ts; type: 'run.waiting'; runId; lastLine; silentMs; state }                        // G15's input-wanted heuristic, journaled with its evidence
  | { seq; ts; type: 'service';     runId; status: 'starting'|'ready'|'running'|'unhealthy'|'exited'|'lost'; probe; principal; name?; evidence?; exit? }  // §8.3; principal started it
  | { seq; ts; type: 'prompt';      cwd; phase: 'start'|'end' }                              // A and B marks
  | { seq; ts; type: 'cwd';         path }                                                    // OSC 7
  | { seq; ts; type: 'env.snapshot';count: number; vars?: Record<string,string> }             // session_env_capture journals the count; vars only in journals written before that
  | { seq; ts; type: 'screen.mode'; alt: boolean }
  | { seq; ts; type: 'title';       text }
  | { seq; ts; type: 'resize';      cols; rows; principal }
  | { seq; ts; type: 'signal';      signal; principal; runId? }
  | { seq; ts; type: 'control';     controller: principal|null; by: principal; how: 'take'|'release'|'override'|'auto' }
  | { seq; ts; type: 'attach';      attachmentId; principal; role: 'observer'|'controller' }
  | { seq; ts; type: 'detach';      attachmentId; principal }
  | { seq; ts; type: 'integration'; level: 'unknown'|'rich'|'basic'|'none' }                  // G5
  | { seq; ts; type: 'watch.fired'; watchId; label; kind: 'pattern'|'silence'|'idle'; principal; at: seq; match?; line?; clipped?: boolean; suppressed?: number }
  | { seq; ts; type: 'gap';         from: seq; to: seq; reason: 'retention'|'keeper-overflow'|'torn-write'|'store-error'|'store-failed'; exact?: true }  // G11; the last three are G19's disk path; torn-write is also what a power loss took (G10)
                                    // exact: every seq of the range was issued, so it counts the events lost; absent (and in a gap an earlier build wrote), the count is a bound, since numbering may have resumed above a reservation's never-issued seqs
  | { seq; ts; type: 'checkpoint';  screen: serialized }                                      // milestone 3; not in types.ts yet
  | { seq; ts; type: 'recovered';   class: 'continuous'|'reattached'|'history-only' }
  | { seq; ts; type: 'session.exit';code: number|null; signal?; reason? }                     // reason: why the daemon ended the shell (daemon-shutdown); absent when it ended on its own
  | { seq; ts; type: 'note';        text; principal; channel? };                              // channel: the MCPL channel an annotation came through
```

## Appendix B: five flows

**Synchronous run.** `run{session:"shell", command:"npm test", wait:20000}` → admitted as
`r41` (G1); the shell is available so it starts; marks correlate; completes in 8 s →
`{runId:"r41", state:"exited", exit:1, output:{text, truncated:false, seq:[4801,4990],
nextCursor:4990}}`. The completion message is withheld from this principal because its
`run` returned the outcome (G28), and sent to any other principal with interest in the
session. The `read` cursor advances to 4990.

**Long run, caller moves on.** `run{command:"npm run build", wait:20000}` → after 20 s
`{runId:"r42", state:"running"}` (G3). The agent works elsewhere. Three minutes later the
build exits 0; because the waiting call returned `running`, the completion message *is*
delivered (G28) — on the channel if open, as a push event if closed, since this principal
started the Run. The presence line reads `build: `npm run build` → 0 (3m12s)`.
`read{runId:"r42"}` returns the attributed output (G12).

**Start and forget.** `start{command:"npm run dev", ready:{pattern:"listening on"}}` →
`{runId:"r17", state:"running", service:"ready"}` after 3 s. Output flows as throttled digests.
`watch{pattern:"ERROR|EADDRINUSE", label:"dev-errors"}` later fires as
`terminal:watch=dev-errors`, which wakes the agent. When the dev server dies, the Service
reports `exited` from the observed end mark (G9), not `running` because bash is alive.

**A human intervenes.** A human opens the GUI, takes the seat (`control` event journaled),
types `git stash`. The `C` mark creates Run `r43` with `origin: human`; the host receives a
`run` message tagged `terminal:origin=human chat:from-human`. Had the agent issued a `run`
while `r43` was executing, it would have received `busy` with `r43` (G4). The human releases
the seat; the next prompt mark makes the shell available; the agent's `run` proceeds, and
the presence line says `since your last read: git stash → 0 by human:discord:8841`.

**A TUI.** `run{command:"htop", wait:2000}` → `{runId:"r44", state:"running"}`;
`screen.mode alt:true` journaled; the segmenter switches to screen digests on quiet.
`screen{}` returns the grid with the cursor at a `seq`; `input{keys:["F10"]}` drives the
program; htop exits, `screen.mode alt:false`, and the `D` mark closes `r44` with its exit
code. Nothing about the interaction itself started or ended a Run (G8).

## Appendix C: provenance ledger

| Topic | Claude draft 1 | Codex draft 1 | Resolution |
|---|---|---|---|
| Organizing idea | presence substrate | persistent execution environment with reliable observation and control | Merged (§1) |
| Daemon + thin clients | yes | yes | Agreed |
| Journal as source of truth | yes, with views | ordered output with cursors, snapshot-then-events | Agreed; Codex's snapshot+events and gap visibility become G11, G13 |
| Headless emulator | yes, replay for clean text | evaluate server-side xterm; render from fixed snapshot | Agreed; fixed-position rendering becomes G14 |
| Shell integration | concrete OSC 133/7 design, fallback, state machine | "study VS Code's" | Claude's design (§7) |
| Entity model | session + cmdId + watches | Session / Run / Service / Attachment | Codex's model adopted (§4); runs unified across daemon-issued and human-typed |
| Execution contracts | shell only | shell / process / interactive | Codex's three modes adopted in draft 2; interactive dropped in draft 3 on Codex's own review — interaction is a terminal capability (§8, G8) |
| Service health | ready patterns | readiness *and* health; exit observed directly | Codex's adopted; probes as a seam (§8.4, G9) |
| Control | private/shared visibility | controller seat, handoff, dimension ownership, verbs | Codex's adopted (§9, G16–G18); visibility retained |
| Observer effect | not noticed | screenshots/GUI resize the live PTY | Codex's finding; designed out (G14) |
| Backpressure | flooding tests only | bounded buffering, visible truncation, xterm flow control | Codex's adopted (§6, G13) |
| Idempotent input | no | no blind resend | Codex's adopted (G16) |
| Recovery reporting | keeper + file store | three promises, report survived/exited/unobservable | Merged (G19, G20) |
| Host lane | channels for everything, tags, segmenter, presence board | push events for lifecycle, channels for conversation, context hook as delta | Channels first with dual delivery (§10.1); Codex's delta idea adopted into the presence injection (§10.4) |
| Tags / gate fit | `terminal:*` ontology, suggested treatment | "host decides" | Claude's design (§10.3) |
| Topology | direct MCPL over ws, shim, keeper, GUI as client | typed API + adapters, unspecified transport | Merged: typed application API (§11) with adapters over one endpoint (§12) |
| Seams | backend, store, strategy, segmenter, renderer | backend, store, probe, renderer, protocol adapter | Union (§13) |
| Rollback | not addressed | must never be declared | Adopted (G24) |
| Plan | phases, compat first | vertical slice with guarantee tests first | Merged (§16) |
| Guarantees before dividing work | implicit | explicit precondition | Adopted; §5 is the draft |
| Bug experiments | reviewed PRs #7/#8/#9 | three experiments on main | Experiments 1 and 3 are fixed by PR #7; experiment 2 is real and addressed by §8.4 |
| Host affordances: Claude Code via `mcpl-cc-bridge`, plain MCP, CLI for composition, result shape, tiers | — | — | Added in draft 2.1 after reading the bridge (§10.6, §11) |
| Codex cross-review of 2.1: host/terminal separation, feature sets are not authorization, transcript + structured envelope, single-purpose core tools | — | second message | Adopted in draft 2.2 (§1, §11, G27) |
| Tool-design rules and measurement step | Claude, first-person, after the 2.2 discussion | — | Draft 2.3 (§11.1, §16 Measure) |
| Codex review of 2.3: execution targets, observation products, acknowledgement cursors, marks semantics, availability after `lost`, cancel contracts, redaction scope, protocol replies, `await` in core, seams relaxed, milestone-1 sentence | — | third message | Draft 3 throughout; plan reframed under Aster's rule on increments |
