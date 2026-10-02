# Scope pass inputs (2026-09-24)

Working notes for the scope pass: every place the round-2 trim agents found that a real cut
would change what users or agents can see. Nothing here is done; each item waits for Aster's
decision. Line counts are non-blank source lines (tests in parentheses), estimated by the
agent that owns the code. "Rec." is that agent's recommendation, judged for users who don't
want to configure anything.

Size history: 1.x 3.9k lines · 2.0 before round 2: 12.9k · after round-2 fixes: 19.9k ·
after the trim pass: 18.5k source, 13.3k tests.

## Likely cuts (agent recommends cutting)

| Item | Saves | What users lose | Rec. |
|---|---|---|---|
| Human-input messages on channels (what a human typed into a REPL or prompt, pushed to agents) | ~165 (~120) | Agents with a channel open stop hearing prompt answers; Runs a human starts still report; presence says "a human typed here" | cut |
| Screen messages on channels (pushed full-screen frames) | ~75 (~50) | Pushed TUI frames; `screen` still returns one on demand | cut |
| Seat-change messages on channels | ~10 | "seat taken/released" notices | cut |
| Note rate limits beyond size | ~15 | Burst / per-second / per-minute limits (keep the 4 KiB cap and the retention share) | cut |
| Per-session retention settings (`retention` on session_open) | ~38 (~25) | Per-session history budgets; daemon-wide flags remain | cut |
| Age-based retention of active files and the memory ring | ~60 (~100) | Content older than 30 days in a still-used session stays until the byte cap; whole-session expiry stays | cut |
| Seq reservation while the disk refuses writes, across a crash | ~35 (~85) | After a disk failure plus a daemon crash, a few events may be re-seen or skipped once | cut |
| The "basic" integration level | ~20 (~10) | Nothing observable (only the test fake shell reaches it); DESIGN G5 names three levels | cut |
| `--anonymous <principal>` | ~25 | Naming the anonymous principal; loopback-open default unaffected | cut |
| `--token` on the command line | ~25 | Passing the token as a flag (it leaks via ps); TSM_TOKEN and --tokens-file remain | cut |
| Per-principal connection limit | ~15 | Fairness between several tokens; global cap, idle timeout and heartbeat remain | cut |
| Key-name "did you mean" suggestions | ~32 | Typo suggestions; the error still lists every valid key | cut |
| `transcript()` convenience wrapper | ~12 | Programmatic API only | cut |
| Head-keeping `maxInputBytes` branch | ~11 (~6) | Nothing (no caller); DESIGN §6 rule 7 wording | cut |

## Decisions with trade-offs

- **Result text: json vs transcript.** The daemon's default text is JSON, but every shipped
  config asks for transcript, so a zero-config MCP host gets the worse rendering. Options:
  one rendering (transcript text + structuredContent; ~35 lines), or at least make transcript
  the default. Rec.: single rendering, or transcript by default.
- **Measure usage log** (usage.jsonl, `tsm usage`, confusion signatures): ~505 lines incl.
  ~165 test. Middle option: keep records, drop the analyzer (~260). Rec.: keep only if the
  evaluation week in the design is actually planned; otherwise cut now.
- **Tool tiers and profiles** (core / full / compat): the compat pack stays (Aster). Whether
  core vs full should exist at all ties to Measure; ~70 lines in transport plus the tier
  machinery in tools/mcpl.
- **Sub-event read cursor** (`offset`/`nextOffset` on read and search): a simpler single
  cursor needs output journaled at line ends (latency) to keep pages whole; ~150 lines.
  Rec.: keep the current design (now property-tested live and finished).

## Recommended keeps (checked, worth their lines)

Orphan process cleanup at recovery (~85) · the /proc fallback in the lock (~25) ·
`--allow-host` and non-loopback serving (~140) · launchd/systemd configs (~150) · GUI secret
toggle (better: drive it from the session's own verdict, ~−25) · exec-watch polling (~36) ·
key-prefix hold (security) · fish integration (~310, the largest) · typeahead modelling (~75)
· seat grace period (~25) · digests (~100) · catch-up summaries (~45) · tag ontology ·
re-projection to fit maxBytes (~14) · lasting-state lookback (~45) · line interleaving and
labels (~45) · the regex pattern parser (counts over 16; git SHAs need it).

## Pending engineering notes (not scope)

- New lives should read and write cursors through the registry's shared CursorBook (today a
  snapshot; a reconnect after a new life may replay a few messages, deduped by id).
- The segmenter's cleanLine/tailBytes nearly duplicate search.ts/text.ts (~15).
- A password prompt ending in `?` (no colon) is not redacted by the session's check.
- DESIGN.md still needs the round-2 behaviour folded in (service statuses running/lost,
  per-line pattern matching, integration level dropping on exec, seat auto-take and owner
  override, keyed marks never in output, notes and recovery messages, message-id epochs,
  data-dir lock, cursor persistence, offsets). Best done after the scope pass.
- Review data: /tmp/tsm-review2/{round1,round2}-findings.json and fix/fix2 reports.
