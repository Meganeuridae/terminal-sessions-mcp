# Upstream changes the terminal redesign asks of the bridge and the host

**Status:** Proposal backlog; A1 landed in agent-framework through [#262](https://github.com/anima-research/agent-framework/pull/262) (merged 2026-10-18), which superseded our draft [#181](https://github.com/anima-research/agent-framework/pull/181) (closed) — in a wrapper shape, not the bare object proposed below: see "Landed" under A1. B3 and A2 corrected after Codex's review (acceptance is invalidated by an ontology change, never recompiled); A5 and A6 added 2026-09-23 from the milestone-1 review, which exercised both hosts' real code against termd
**Date:** 2026-09-17, amended 2026-09-24
**Companion:** `DESIGN.md` draft 4 (§10.6 host profiles, §11 result shape and tiers)
**Audience:** an agent writing the PRs. Every claim below carries a `file:line` anchor as of
the checkouts on 2026-09-17; re-verify lines before editing, they drift.

Two repositories. The bridge is Bun + TypeScript, vendors `mcpl-core`, tests with
`bun run test/smoke.ts` against `test/toy-server.ts`. The host is agent-framework,
TypeScript, tests under `test/`. Each item is independent unless noted; sizes are
S (an hour), M (a day). Nothing here blocks the terminal server's phase 1; B1–B4 and A1
are what phase 2 wants in place.

---

## mcpl-cc-bridge

Repo: `github.com/anima-research/mcpl-cc-bridge`, source under `bridge/`, plugin at `plugins/mcpl-bridge`, version
0.2.6 (`.claude-plugin/plugin.json`).

### B1 — Glob matching in wake rules (S)

**Why.** Wake rules are AND-sets of exact tag strings, so a rule cannot name a faceted tag
family such as `terminal:watch=*` or `terminal:exit=*`. (termd's service statuses became
distinct classes — `terminal:service-ready` and so on — because the manifest's identifier
charset excludes `=` in `suggestedTreatment`, so only watch labels and exit kinds remain
faceted; termd emits the bare `terminal:watch` beside the facet in the meantime.) agent-framework's gate already
matches tags with `*` globs (`agent-framework/src/gate/types.ts`, `tagsAny/tagsAll/tagsNone`
doc comment). Parity removes the need for producers to emit a bare tag beside every facet.

**Where.** `src/wake.ts` — `WakeGate.decide()`:

```ts
const matches = (rule: WakeRule) => rule.length > 0 && rule.every(t => tags.has(t))
```

**Change.** A rule element containing `*` is a pattern: `*` matches any run of characters
(same semantics as `agent-framework/src/mcpl/tool-policy.ts` `compilePattern`, which the
host's gate also uses for tags). Compile once per rule at construction; exact strings keep
the fast path. Config validation (`src/config.ts:125-135`) is unchanged, rule elements are
already strings.

**Tests.** `test/smoke.ts`, wake-policy section: `["terminal:watch=*"]` matches
`terminal:watch=dev-errors`; `["chat:from-*", "chat:reply"]` matches a bot reply;
`["terminal:*"]` does not match `chat:dm`. README "Wake policy": one sentence on globs.

### B2 — Pass scalar message metadata through to the channel block (S)

**Why.** A Claude Code session sees a channel delivery as a `<channel …>` block whose
attributes are the delivery's `meta`. Today only chat-shaped fields survive, so a terminal
server's `runId`, `exit`, `nextCursor`, `state` must be stuffed into the text to be usable.

**Where.** `src/mcpl-host.ts`:
- `channels/incoming` handler, `meta:` object (≈ lines 456–464): `channel_id`,
  `message_id`, `thread_id`, `author`, `author_id`, `ts`, `tags` only.
- `push/event` handler, `meta:` object (≈ lines 400–413): fixed `origin` fields only.
- `main.ts` `deliverToSession` (≈ lines 305–318) already forwards every meta key after
  sanitizing to `[a-zA-Z0-9_]` and dropping empties, so the change is confined to
  `mcpl-host.ts`.

**Change.** After the fixed fields, copy every member of `m.metadata` (incoming) and
`p.origin` (push) whose value is a string, number or boolean, and whose key is not already
set and not reserved (`server`, `kind`, `held`, `tags`), stringified, key sanitized as
`main.ts` does, capped at 32 extra keys and 240 characters per value. Objects and arrays are
skipped, not serialized. `IncomingDelivery.meta` (`src/mcpl-host.ts:47-52`) keeps its type.

**Tests.** `test/smoke.ts`: an incoming message with `metadata: { runId: "r41", exit: 1,
nested: {x:1} }` yields attributes `runId="r41" exit="1"` and no `nested`. README
"Opening channels" paragraph on origin passthrough: extend to metadata.

### B3 — `wake: "suggested"`: accept a server's declared treatment (M)

**Why.** RFC-001 §5.2 and SPEC §16.5: a producer's `suggestedTreatment` is inspectable
configuration applied only on explicit acceptance. The bridge has the acceptance point
(per-server `wake` config) but no way to say "accept this server's suggestions". Without
it every new server needs a hand-written rule set or a preset baked into the bridge.

**Where.**
- `src/config.ts:16` imports `WakeConfig`; validation at `:125-135` allows `"all"`,
  `"chat"`, or an object. Add the literal `"suggested"`.
- `src/wake.ts` `resolveWakePolicy()` / `WakeGate` — the policy is fixed at construction
  (`main.ts makeHandle`, `new WakeGate(serverCfg.wake)`), before the handshake that carries
  the ontology.
- `src/mcpl-host.ts` handshake (≈ lines 276–315): `normalizeFeatureSets(mcpl.featureSets)`
  gives the declared feature sets; each may carry `tagOntology` with `suggestedTreatment:
  TreatmentRule[]` (types in `src/vendor/mcpl-core/tags.ts:15` `TagBehavior`, `:24`
  `TreatmentRule`, `:59` `TagOntology`). Manifest re-fetch at `:591`.

**Change.**
1. `WakeGate.setPolicy(policy)` so the gate can be (re)configured after handshake.
2. In the handle, after feature sets are known, when `cfg.wake === "suggested"`: collect
   `suggestedTreatment` rules from every declared feature set in declaration order and
   compile to a `WakePolicy`: a rule whose behavior is `immediate` becomes a `wake` entry;
   any other behavior becomes a `hold` entry. `tagsAll` → one AND-set; `tagsAny` → one
   AND-set per tag; a rule with both `tagsAll` and `tagsAny` cannot be compiled to AND-sets
   without weakening it (a `tagsAny` tag would then match alone, against mcpl-core 0.3.0's
   "only if ALL"), so skip such a rule and log it, as for `tagsNone`; termd's own rules use
   `tagsAny` only. `tagsNone` is not expressible in the bridge's rule form — skip the rule
   and log it. Precedence approximation: the bridge checks all `wake` rules before all
   `hold` rules, not first-match over the producer's order; document this.
3. **Acceptance is pinned to a manifest revision and is invalidated by change** — SPEC
   §17.5 and §16.5: a changed `tagOntology` invalidates prior acceptance rather than
   inheriting standing. So: record the revision the rules were compiled from; on a
   `mcpl/manifestChanged` whose domains include `tagOntology`, or a re-fetched manifest
   whose `tagOntology` differs, **drop** the compiled rules, fall back to a configured
   `fallback` policy (default `"all"`, i.e. wake on everything — the safe direction is
   more wakes, not fewer), and surface `wake=suggested (acceptance invalidated by rev …;
   re-accept)` in `mcpl_status`. Re-acceptance is an operator act: either
   `wake: { suggested: "sha256:…" }` pinning the new revision in config, or a bare
   `"suggested"` that accepts the ontology current at first connect and records that
   revision in the bridge's state file, so later reconnects do not silently re-accept a
   changed one. Never recompile automatically.
4. `mcpl_status` line shows `wake=suggested (N rules from rev …)`.

**Tests.** `test/toy-server.ts` declares a feature set with a `suggestedTreatment` list;
smoke asserts a delivery tagged per an `immediate` rule wakes and one per a `throttle` rule
is held; a manifest change with a new ontology **drops** the rules, the gate falls back to
the fallback policy, and `mcpl_status` reports the invalidation; re-pinning the revision
in config restores them.

**Note.** This is the mechanism the design recommends over a per-server `"terminal"`
preset. If B3 is declined, the fallback is a `"terminal"` preset beside `CHAT_PRESET` in
`src/wake.ts` with the rules listed in `DESIGN.md` §10.6.

### B4 — Collapse superseded held deliveries (S)

**Why.** A terminal server sends in-flight progress digests carrying
`metadata.supersedes = <previous messageId>`. Held for a long turn, they should fold to
one line, not accumulate toward `holdCap`.

**Where.** `src/wake.ts` — `WakeGate.hold()` pushes unconditionally; `renderHeldLine()`.

**Change.** In `hold()`, if `d.meta.supersedes` equals a held entry's `meta.message_id`,
replace that entry in place (same position, new `heldAt`). Requires B2 so `supersedes`
reaches `meta`. Eviction accounting unchanged.

**Tests.** Three digests with a supersedes chain, held → `flush()` renders one line.

### B5 — Per-server held-line length (S, optional)

`renderHeldLine()` trims text to 300 characters. Add `heldLineChars?: number` to the
per-server wake object (`src/config.ts` validation, `src/wake.ts` `WakePolicy`), default
300. Terminal digests are designed to fit 300, so this is convenience, not a requirement.

### B6 — Housekeeping: vendored `mcpl-core` (S)

README notes `src/vendor/mcpl-core/` is vendored because npm `@animalabs/mcpl-core@0.2.2`
was stale. npm now has 0.3.0 (checked 2026-09-16), which the reference servers depend on.
Re-sync the vendored copy from `mcpl-core-ts/src`
or switch to the package. Not required by the terminal work; it is where the
`TreatmentRule` types for B3 come from, so do it first if B3 is taken.

---

## agent-framework

Repo: `github.com/anima-research/agent-framework`.

### A1 — `code_execution` hands scripts `structuredContent` when a tool provides it (S–M)

**Landed (2026-10-18).** agent-framework #262 carries A1, with a shape of its own: for a tool that returns structured content, the string a script's tool function gets is a JSON object `{"content": [...], "structuredContent": ..., "isError": false}`, with `"error"` added when `isError` is true; a reference to a payload appears in `content` as `{"type", "refId", "savedTo"}` (`savedTo` the workspace path, or null); a structured result over 5 MB is saved to the workspace and the string becomes `{"isError", "oversized": {"chars", "savedTo"}}`; a result that cannot be serialized reaches the script as an error that names the tool. Scripts therefore read `json.loads(text)["structuredContent"]` for termd's envelope rather than the bare object. Our #181 is closed; its scripts and tests are not needed. The paragraph below is the history of the earlier draft.

**Implementation (2026-09-24).** Draft [agent-framework #181](https://github.com/anima-research/agent-framework/pull/181), commit `cccb0f2`, implements this against main `359cbc5`, independently of the earlier lifecycle PR #155. Both dispatch paths preserve the envelope; Python gets JSON, direct model calls retain readable content, and legacy results retain their existing serialization. The existing cap is 5,000,000 characters; structured overflow reports an explicit error rather than incomplete JSON. Full suite: 956 passed / 4 skipped / 0 failed (baseline 954 / 4 / 0). Both new tests fail on baseline. Real termd → framework → Python acceptance and the existing host lifecycle acceptance pass. No deployed host or live LLM was exercised. The proposal below is retained as context for reviewing and continuing the implementation; any collaborator may do so.

**Why.** Scripts receive "the same text the tool would have returned" and are told to
`json.loads` it (`src/code-execution/tool-definition.ts:22-28`). MCP 2025-06-18 lets a tool
return `structuredContent` alongside human-readable `content`. The terminal server will
return a readable transcript as `content` and a structured envelope as `structuredContent`
(`DESIGN.md` §11, G27). Without this change, a transcript text is a regression for scripts;
with it, the model reads prose and the script reads JSON, each in its natural form.

**Where.**
- `src/framework.ts:8175` `handleScriptToolCall()` — returns
  `toolResultDataToHistoryString(result.data, 5_000_000)` (≈ `:8213`), where `result` is
  the tool-result event from `dispatchScriptToolCall()`.
- The tool-result event type carries `data` (content blocks). Confirm whether
  `structuredContent` from an MCPL `tools/call` response survives into that event:
  `grep -rn structuredContent src/` returned nothing in `src/code-execution/`; check
  `src/mcpl/server-connection.ts` `callTool` result handling and the tool-result event
  shape in `src/types/`.

**Change.**
1. Thread `structuredContent` (when present on the `tools/call` result) through the
   tool-result event as an optional field.
2. In `handleScriptToolCall()`, if it is present, return `JSON.stringify(structuredContent)`
   to the script; otherwise the current text. Keep the 5 MB cap.
3. Update the `code_execution` description: "tools that provide structured results return
   them as JSON; others return their text."

**Tests.** `test/code-execution.test.ts`: a fake tool returning both `content` and
`structuredContent`; the script's `json.loads` sees the structure; a tool without
`structuredContent` is unchanged.

**Risk.** Only tools that start emitting `structuredContent` change what scripts see; the
terminal server is the first. Scripts that parsed a tool's rendered text keep working for
every other tool.

### A2 — Accept a server's `suggestedTreatment` on explicit recipe opt-in (M, policy call)

**Why.** Parity with B3 so one server declaration serves both hosts. `src/mcpl/tags.ts:7-8`
states the framework deliberately reads no `suggestedTreatment`; that is the correct
default. The proposal adds acceptance, not auto-application.

**Where.** Gate policies: `src/gate/types.ts` (`GatePolicy`, `GatePolicyMatch` with
`tagsAny/tagsAll/tagsNone`), `src/gate/event-gate.ts` (hot-reloaded `gate.json`). Server
registration and manifest handling: `src/mcpl/server-connection.ts` (manifest fetch at
≈ `:615`), feature-set registration (`registerMcplServerFeatures`).

**Change.** A per-server recipe field, e.g. `acceptSuggestedTreatment: true` on the
`mcplServers` entry. When set, compile the server's `suggestedTreatment` rules into gate
policies scoped to that server (`source: <serverId>`), mapping `immediate` → `always`,
`throttle` → `{ rate_limit }` or `{ debounce }`, `mute` → `defer`; append them **after** the
recipe's own policies so consumer rules win (§16.5 precedence); attribute each with the
server id and manifest revision. When the manifest's `tagOntology` domain changes, the
acceptance is **invalidated** (§17.5): drop the compiled policies, emit the §17.6
`ontology-acceptance-invalidated` impact with disposition `decision-needed`, and do not
recompile — re-acceptance is a recipe edit, ideally pinning the revision
(`acceptSuggestedTreatment: "sha256:…"`). Surface accepted policies in the gate's
introspection so they are attributable and revocable.

**Tests.** A server declaring rules; opt-in on → events treated per rules; opt-in off →
unchanged; manifest change → policies dropped and the invalidation receipt emitted; a
re-pinned revision → restored.

**Note.** This needs antra's policy call: the framework's stance is that hosts author their
own rules. The design works without A2 — recipes carry a recommended `gate.json` snippet
for terminal tags — so A2 is convenience, not a dependency.

### A3 — Honour `supersedes` on channel messages (S, optional)

`src/mcpl/channel-registry.ts:675 handleIncoming()` admits each message independently.
When `metadata.supersedes` names an earlier message id from the same channel that is still
in the pending/recent window, mark the earlier one superseded so context compilation can
drop or collapse it. Low priority; digests are already few.

### A5 — Deduplicate push events per server, not globally (S)

**Why.** `src/mcpl/push-handler.ts` (≈ line 227) keeps one 1000-entry dedup set of
`eventId`s for every MCPL server, and answers a repeat `{accepted: false, reason:
'duplicate'}`. Two servers whose ids coincide — two terminal daemons on two nodes with a
session of the same name, or one daemon whose data dir was reset — lose each other's
notifications silently. SPEC §9.4 asks hosts to deduplicate by `eventId`; it does not say
across servers.

**Change.** Key the set by `serverId + '\0' + eventId`. termd already node-qualifies its ids
(`<node>/<session>~<epoch>:<kind>:<seq>`), so this is defence in depth.

**Tests.** Two fake servers push the same `eventId`; both are accepted.

### A6 — Speech routing into non-conversational channels (M, policy call)

**Why.** `ChannelRegistry.routeSpeech` publishes every text-only turn to the turn's locus —
the channel that woke the agent — and opens a closed locus by delivery
(`opened-by-delivery`), which makes it durably desired-open. A terminal completion is a
wake whose locus is `terminal:<session>`, so the agent's ordinary reply ("The build
passed") is published there, and the channel stays open afterwards, so every progress digest
and screen of that session flows into context from then on. termd now records such speech as
a note (never typed; see DESIGN §10.1), so nothing unsafe happens — found in review as
mcpl-1, where the old publish-as-typing executed the prose — but the channel opening is still
a surprise, and the note is noise.

**Change.** Let a channel descriptor opt out of speech routing, e.g.
`metadata.speech: 'none'` (or a recipe field `routeSpeech: false` on the `mcplServers`
entry), so a text-only turn woken by such a channel goes to the conversation's default
destination and does not open the channel. termd sets it on every terminal channel's
descriptor (`metadata.speech: 'none'`).

**Tests.** A wake from a `speech: 'none'` channel followed by a text-only turn: nothing is
published there and its desired state stays closed.

### A4 — No change: tool tiers via tool policy (note)

`src/mcpl/tool-policy.ts` applies `enabledTools` / `disabledTools` with `*` wildcards at
both listing and dispatch. A recipe that wants the terminal's core tier lists the ten
core tool names, or disables `start,watch*,wait_for,unwatch,signal,control,resize,session_env_capture,search` — simpler still, it enables the `terminal.core` feature set. The server
additionally filters `tools/list` by enabled feature sets, as discord-mcpl does; the host's
policy remains authoritative. Document the snippet in the terminal server's README when
phase 2 lands.

---

## Later, not now

- **connectome-host recipes**: when the terminal server's MCPL surface ships (phase 2),
  the `shell` entry moves from `mcpServers` to `mcplServers` with the grant and
  `openChannels` from `DESIGN.md` §10.6. Documentation change in
  `connectome-host/docs/DEV-ENVIRONMENT.md` and `docs/AGENT-ONBOARDING.md`.
- **Bridge presence per tool call**: Claude Code fires hooks per user turn, so
  `beforeInference` runs once per turn. A `PostToolUse` refresh could approximate
  per-inference presence but would fan out on every tool call. Not proposed; tool results
  carry state within a turn.
