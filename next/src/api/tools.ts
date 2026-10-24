/**
 * The tool table (§11): the MCP projection of the application API. Each tool
 * is one verb, its description says when to use it instead of its neighbours,
 * and each result comes in two renderings — a transcript for the model and a
 * structured envelope for scripts (G27). An envelope always conforms to the
 * tool's declared outputSchema; error results carry no envelope (the text says
 * `code: message`), which MCP permits.
 */
import { TermError } from '../core/errors.js';
import { headOnlyText } from '../core/regex.js';
import type { Seq } from '../core/types.js';
import { commitReadDelivery, type App, type Caller, type ReadResult, type RunResult, type SearchResult, type SessionSummary } from './app.js';
import { clippedText, gapsText, type GapInfo } from './reader.js';
import { COMPAT_TOOLS } from './compat.js';
import { looksLikeErrexit, looksLikeShellOpener, oneShotSshWithoutTty } from './hints.js';
import { validate, ValidationError, type Schema } from './validate.js';

export type Tier = 'core' | 'control' | 'services' | 'watch' | 'search' | 'compat';
export type Profile = 'core' | 'full' | 'compat';
export type ResultText = 'json' | 'transcript';

export interface ToolContext {
  app: App;
  caller: Caller;
  resultText: ResultText;
  /** False when this connection cannot receive notifications (plain MCP): watch and start say so (ux-7). */
  notifications?: boolean;
}

export interface ToolResult {
  text: string;
  /** The envelope; absent on error results. */
  structured?: Record<string, unknown>;
  isError?: boolean;
  /** The transport calls this once the result has been written to the connection (G28: an outcome counts as delivered only then). */
  onSent?: () => void;
}

export interface ToolDef {
  name: string;
  tier: Tier;
  description: string;
  inputSchema: Schema;
  outputSchema?: Schema;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const session = { type: 'string', description: 'Session name.' } as const satisfies Schema;
const idempotencyKey = {
  type: 'string',
  minLength: 1,
  description:
    'Optional; use a fresh unique value (a UUID) per operation. An ordinary call retried with its retained key within 15 minutes returns the first ' +
    'outcome instead of running again. A run or start re-awaits the same Run while its journal admission remains indexed; its state may have changed, including after a daemon restart. ' +
    'The in-memory cache keeps the newest 1,024 keys per caller and 16,384 in all, so other keys may be forgotten sooner. A key reused for another tool or with other arguments is refused while its identity remains retained. ' +
    'A `busy` outcome (nothing ran) is not remembered, so its retry can run — except `busy: declared-shell-ended`, which the retry gets ' +
    'again: use a new key once you mean the session’s own shell.',
} as const satisfies Schema;
const fmt = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const env = (r: object) => r as unknown as Record<string, unknown>;

/** Every tool's text: the envelope as JSON in `json` mode (for scripts), the transcript otherwise (atc-15). */
const render = (ctx: ToolContext, transcript: string, structured: Record<string, unknown>): ToolResult => ({
  text: ctx.resultText === 'json' ? JSON.stringify(structured, null, 2) : transcript,
  structured,
});

const TERMINAL = new Set(['exited', 'cancelled', 'lost']);

/** A Run result, marked delivered (G28) and its read cursor advanced (G22) once the transport has written it (mcpl-1; the house's read of 1cabc6a, #22). */
function runResult(ctx: ToolContext, r: RunResult): ToolResult {
  const res = renderRun(r, ctx.resultText);
  const outcome = r.runId !== undefined && (TERMINAL.has(r.state) || r.service !== undefined);
  res.onSent = () => {
    if (outcome) ctx.app.outcomeSent(ctx.caller, r);
    commitReadDelivery(r);
  };
  return res;
}

/** Copy the defined keys of `a` that the schema names (the tools' arguments are validated first). */
function pick<T extends object>(a: Record<string, unknown>, keys: string[]): T {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
  return o as T;
}

const BUSY_NEXT: Record<string, string> = {
  running:
    'await or cancel it, pass queue:true to run after it, or — when the program it started is a shell (ssh, sudo -i, docker exec, a nested shell) — ' +
    'declare that with session_declare_shell and run again: commands then go to that shell. Or use another session',
  'prompt-pending': 'the shell is between commands: retry, or pass queue:true',
  'cancel-unanswered':
    "a cancel's ^C drew no mark from the shell, and no prompt has shown it back since: pass queue:true to run once one does; if none comes, " +
    'read `screen` to see what holds the terminal, then send it input (Enter at a prompt, or the answer a program reading there waits for), or close the session',
  'shell-unavailable':
    "the session's shell was replaced by a program without integration: if that program is a shell, declare it with session_declare_shell (sh, bash, zsh, fish…) and run again; " +
    'input and screen work regardless; or open a new session',
  'declared-shell-ended':
    'the declared shell (ssh, sudo -i, a nested shell) ended without your asking — the connection dropped, or that shell died — so this command would have run in the shell underneath, not where you meant it: ' +
    'run it again if the session’s own shell is what you mean (with a new idempotencyKey, if you used one: a retry with the same key gets this refusal again), or run the opener and declare again',
  'human-editing': 'a partial command line sits at the prompt: clear it with input keys:["C-u"] (needs the seat), or pass queue:true',
  'human-submitted':
    'a command someone typed at this prompt by hand was submitted and may still be running (no end mark comes for a hand-typed command): read `screen` to see; ' +
    'pass queue:true to run once the prompt is back — seen from the terminal where the shell runs on this machine, otherwise assumed after 30 s of quiet',
  starting: 'the shell is still starting: pass queue:true to run once it is ready',
  exited: 'the shell has exited: run again to start a new one',
};

const SET_E_NOTE = 'set -e belongs inside scripts and subshells, not in a session shell, where it makes every later failing command end the whole shell';

function runStatus(r: RunResult): string {
  switch (r.state) {
    case 'exited': {
      // A hint, never evidence: the line turned on set -e in the shell it ran in, where it stays on.
      const armed = r.target === 'shell' && looksLikeErrexit(r.line) ? ` — this turned on set -e in the shell itself, where it stays on: the next failing command ends the whole shell and the command running then ends lost; ${SET_E_NOTE}. set +e turns it off` : '';
      const left = r.leftovers ? ` — it left processes running in its group (a child put in the background): they run on, their output is journaled without this Run's id; cancel ${r.runId ?? 'this Run'} ends them, as does closing the session` : '';
      // A failure earlier in the pipeline (shell tools 3): the exit alone would read as success.
      // 141 is SIGPIPE: the producer ended because the next command stopped reading, which is how
      // `… | head` normally ends, so it is not a failure when the last command exited 0 (the
      // house's read of e1d2b8b).
      const ps = r.pipeStatus ?? [];
      const last = ps[ps.length - 1];
      const failed = ps.length > 1 ? ps.slice(0, -1).filter((x) => x !== 0 && !(x === 141 && last === 0)) : [];
      const sigpipe = failed.includes(141) ? ' (141: ended by SIGPIPE when the next command stopped reading)' : '';
      const pipe = failed.length ? ` — pipeline statuses ${ps.join(' | ')}: a command before the last one failed${sigpipe}${r.exit === last && r.exit === 0 ? '; the exit is the last command’s (pipefail is off)' : ''}` : '';
      return `exited ${r.exit ?? '?'}${r.signal ? ` (${r.signal})` : ''} in ${fmt(r.durationMs ?? 0)}${pipe}${armed}${left}`;
    }
    case 'cancelled': {
      const host = oneShotSshWithoutTty(r.line);
      const remote = host !== undefined ? ` — this ended the local ssh client only; the command on ${host} had no terminal there (no -t), so nothing reached it and it may still be running; ssh -t in the shell lets terminal interrupts reach it, while ending ssh -tt as a process Run hangs it up; a termd on that host would own the remote work` : '';
      return `cancelled${r.signal ? ` by ${r.signal}` : r.exit !== undefined ? ` (exit ${r.exit})` : ''} after ${fmt(r.durationMs ?? 0)}${remote}`;
    }
    case 'lost': {
      const reason = r.reason ?? 'lost';
      const shellWent = reason.startsWith('shell-exited')
        ? ` — the shell running this command exited under it, so its end was never seen; that happens when a command runs exit, or when set -e is on in the shell and a command fails (${SET_E_NOTE})`
        : reason === 'line-not-whole'
          ? ' — a line typed for the declared shell reached it changed or cut (text already at its prompt, or something else reading the terminal), so the command never ran; look at the screen, clear the prompt, and run it again'
          : '';
      return `outcome unknown: ${reason}${shellWent}`;
    }
    case 'queued':
      return `queued for ${fmt(r.queuedMs ?? 0)}, not started — it runs when the shell is free; await it`;
    case 'running':
    case 'starting': {
      if (r.state === 'starting' && r.shell !== undefined) {
        return `typed into the declared ${r.shell} shell, no start marker yet — if the program in front is not a ${r.shell} shell at its prompt, cancel it; else await it`;
      }
      const w = r.waiting;
      const next =
        w?.kind === 'tui'
          ? 'a full-screen program is open: look with screen, answer with input'
          : w?.kind === 'input'
            ? `it seems to wait for input (silent ${fmt(w.silentMs ?? 0)}, last line "${w.lastLine ?? ''}"): answer with input, or cancel`
            : `it keeps running; await it, or read since=${r.output.nextCursor}`;
      // A hint, never evidence (§8.1): the line reads like one that opens another shell.
      const opened = r.target === 'shell' && r.shell === undefined && looksLikeShellOpener(r.line) ? ' — if it opened a shell (it looks like it did), declare that with session_declare_shell and run your commands in it' : '';
      const host = oneShotSshWithoutTty(r.line);
      const remote = host !== undefined ? ` — a cancel would end the local ssh client, not the command on ${host}, which has no terminal there without -t; ssh -t in the shell lets terminal interrupts reach it, while ending ssh -tt as a process Run hangs it up; the daemon can only confirm that ssh ended` : '';
      return `${r.state} ${fmt(r.durationMs ?? 0)} so far — ${next}${opened}${remote}`;
    }
    case 'busy': {
      const b = r.busy;
      const who = b?.runId ? ` ${b.runId}${b.principal ? ` by ${b.principal}` : ''}${b.line ? ` (${b.line})` : ''}` : '';
      return `busy: ${b?.reason ?? 'unknown'}${who} — nothing was run; ${BUSY_NEXT[b?.reason ?? ''] ?? 'retry later, or pass queue:true'}`;
    }
  }
}

export function renderRun(r: RunResult, mode: ResultText): ToolResult {
  const structured = env(r);
  if (mode === 'json') return { text: JSON.stringify(r, null, 2), structured };
  const head = r.state === 'busy' ? '' : r.output.text ? r.output.text + '\n' : '';
  const service = r.service ? ` · service ${r.service}${r.evidence ? ` (${r.evidence})` : ''}` : '';
  // Under integration none the shell's cwd is not tracked, and only daemon Runs have boundaries (G5);
  // a declared shell (§8.1) has no marks at all: the daemon knows its Runs' boundaries and nothing else.
  const where = r.shell !== undefined ? ` · in the declared ${r.shell} shell${r.within ? ` (${r.within})` : ' that replaced the session’s shell'}` : '';
  const cwd =
    r.shell !== undefined ? 'cwd unknown (declared shell)' : r.integration === 'none' ? 'cwd unknown (integration none: only daemon runs have boundaries)' : `cwd ${r.cwd}`;
  const basis = r.target === 'process' && r.envBasis ? ` · env ${r.envBasis}` : '';
  const ignored = r.ignored?.length ? ` · ignored: ${r.ignored.join(', ')} (the session exists; cd in the command instead)` : '';
  const status = `[run ${r.runId ?? '—'} ${runStatus(r)}${service} · ${r.target}${where}${basis} · ${cwd} · next=${r.output.nextCursor}${r.output.truncated ? ' · truncated' : ''}${r.created ? ' · session created' : ''}${ignored}${r.replayed ? ' · replayed' : ''}]`;
  return { text: head + status, structured };
}

/**
 * A read's result as text: the page, then a status line whose advice names every argument the read
 * it advises needs. `asked` is the request's range (`since`, `until`), which the result does not echo:
 * a Run's page or tail read on, or back, without its Run read the session, and an earlier page without
 * the request's `since` left its range (a reviewer's read of the fixes for #22).
 */
export function renderRead(r: ReadResult, mode: ResultText, asked: { since?: Seq | undefined; until?: Seq | undefined } = {}): ToolResult {
  const structured = env(r);
  if (mode === 'json') return { text: JSON.stringify(r, null, 2), structured };
  const body = r.text !== undefined ? r.text : JSON.stringify(r.events, null, 1);
  const next = `since=${r.nextCursor}${r.nextOffset ? ` offset=${r.nextOffset}` : ''}`;
  // Both counts are output lines, or for an events tail events (our read of the 40 commits, PR #22); more lines
  // than asked for reach back to the line written last (ReadResult.lines).
  const unit = r.events !== undefined ? 'events' : 'lines';
  const back = r.lines && r.lines.returned > r.lines.requested ? ', back to the line written last' : '';
  const lines = r.lines ? ` · ${r.lines.returned} of ${r.lines.requested} ${unit}${back}${tailMarks(r.lines, r.runId, asked.since)}` : '';
  const more = r.more ? ` · more: read ${next}${argWords({ until: asked.until, runId: r.runId })}` : '';
  const status = `[read ${r.session}${r.runId ? ` run ${r.runId}` : ''} seq ${r.seq[0]}–${r.seq[1]}${lines} · next: ${next}${more}${r.splitLine ? ' · last line continues' : ''}${gapsBit(r)}${r.truncated ? ' · truncated' : ''}]`;
  return { text: (body ? body + '\n' : '') + status, structured };
}

/** ` key=value` for each argument given, in order. */
const argWords = (o: Record<string, string | number | undefined>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}=${v}`)
    .join('');

/**
 * A tail's marks on the status line: the first line cut at its head and the read that shows it from
 * there (or, begun before this page, on from where the page before ends), and the read of what came
 * before, each with every argument it needs, the tail's Run and its `since` included, so following it
 * twice gets further back each time (the house's reads of 78c4d6e and of the 38 commits, #22; a
 * reviewer's read of the fixes for #22).
 */
function tailMarks(l: NonNullable<ReadResult['lines']>, runId: string | undefined, since: Seq | undefined): string {
  const from = l.begunBefore ? ', begun before this page; on from where the earlier page ends' : '; from its head';
  const head = l.cutHead ? ` (the first cut at its head${l.head ? `${from}: read${argWords({ since: l.head.since, offset: l.head.offset, runId })}` : ''})` : '';
  const before = l.before ? ` · earlier: read${argWords({ tail: l.requested, until: l.before.until, untilOffset: l.before.untilOffset, since, runId })}` : '';
  return head + before;
}

/** The holes a read or a search spanned, as a status-line item (the reader words them). */
const gapsBit = (r: { gap?: GapInfo; gaps?: GapInfo[] }): string => item(gapsText(r));
/** A process Run's line, as a hit names it: the pipe that wrote its first character that showed, and `mixed` when both wrote characters to it that showed (search and watches read the two as one source); '' for the terminal's. */
const pipeOf = (h: { stream?: string; mixed?: boolean }): string => (h.stream ? `${h.stream}${h.mixed ? ' · mixed' : ''}` : '');
const item = (text: string | undefined): string => (text ? ` · ${text}` : '');

export function renderSearch(r: SearchResult, mode: ResultText): ToolResult {
  const structured = env(r);
  if (mode === 'json') return { text: JSON.stringify(r, null, 2), structured };
  const at = (c: number, o?: number) => `since=${c}${o ? ` offset=${o}` : ''}`;
  const body = r.matches.map((m) => [...m.before.map((l) => `  ${l}`), `> ${m.line}   [${m.stream ? `${pipeOf(m)} · ` : ''}read ${at(m.cursor, m.offset)}]`, ...m.after.map((l) => `  ${l}`)].join('\n')).join('\n--\n');
  const more = r.more ? ` · more (${r.stoppedBy ?? 'limit'}): search ${at(r.nextCursor ?? r.scanned[1], r.nextOffset)}` : '';
  // What the scan did not see, as the envelope says it and as read's status line does: the holes it
  // spanned, and the lines longer than the match window, searched on their head only; without
  // these, `(no matches)` read as a whole answer (the house's read of 1cabc6a, #22).
  const status = `[search ${r.session} · ${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}${more} · scanned seq ${r.scanned[0]}–${r.scanned[1]}${r.bounded ? ' · older history not scanned: pass since' : ''}${gapsBit(r)}${item(clippedText(r.clippedLines))}]`;
  return { text: `${body || '(no matches)'}\n${status}`, structured };
}

const SERVICE_STATUS = ['starting', 'ready', 'running', 'unhealthy', 'exited', 'lost'];

/** A hole a result spans (reader.ts GapInfo): the `gap` event's range and reason. */
const GAP: Schema = {
  type: 'object',
  properties: { from: { type: 'integer' }, to: { type: 'integer' }, reason: { type: 'string', enum: ['retention', 'keeper-overflow', 'torn-write', 'store-error', 'store-failed'] }, exact: { type: 'boolean', description: 'true: every seq from `from` to `to` was issued, so the range counts the events lost; absent: the count is a bound (up to that many), since numbering may have skipped seqs never issued' } },
  required: ['from', 'to', 'reason'],
};

const RUN_OUTPUT: Schema = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    session: { type: 'string' },
    target: { type: 'string', enum: ['shell', 'process'] },
    state: { type: 'string', enum: ['queued', 'starting', 'running', 'exited', 'cancelled', 'lost', 'busy'] },
    exit: { type: 'integer' },
    signal: { type: 'string' },
    reason: { type: 'string' },
    durationMs: { type: 'number' },
    cwd: { type: 'string' },
    origin: { type: 'string', enum: ['self', 'human', 'agent', 'system'] },
    principal: { type: 'string' },
    envBasis: { type: 'string', enum: ['configured', 'snapshot'] },
    attribution: { type: 'string', enum: ['exact', 'temporal'] },
    line: { type: 'string', description: 'The command line, cut at 200 characters (the journal keeps all of it).' },
    output: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        seq: { type: 'array', items: { type: 'integer' } },
        nextCursor: { type: 'integer' },
      },
      required: ['text', 'truncated', 'seq', 'nextCursor'],
    },
    busy: { type: 'object', properties: { runId: { type: 'string' }, reason: { type: 'string' }, line: { type: 'string' }, principal: { type: 'string' } }, required: ['reason'] },
    queuedMs: { type: 'number' },
    integration: { type: 'string' },
    shell: { type: 'string', description: 'A declared shell’s Run: the kind of shell in front (bash, sh, zsh, fish…).' },
    within: { description: 'With shell: the runId whose program is that shell, or null for the program that replaced the session’s shell.' },
    waiting: { type: 'object', properties: { kind: { type: 'string', enum: ['input', 'tui'] }, lastLine: { type: 'string' }, silentMs: { type: 'number' }, state: { type: 'string' }, heuristic: { type: 'boolean' } }, required: ['kind', 'state', 'heuristic'] },
    ignored: { type: 'array', items: { type: 'string' } },
    created: { type: 'boolean' },
    service: { type: 'string', enum: SERVICE_STATUS },
    evidence: { type: 'string' },
    probe: { type: 'string' },
    replayed: { type: 'boolean' },
  },
  required: ['session', 'target', 'state', 'cwd', 'attribution', 'output'],
};

const READ_OUTPUT: Schema = {
  type: 'object',
  properties: {
    session: { type: 'string' },
    runId: { type: 'string' },
    text: { type: 'string' },
    events: { type: 'array', items: { type: 'object' } },
    seq: { type: 'array', items: { type: 'integer' } },
    nextCursor: { type: 'integer' },
    nextOffset: { type: 'integer', description: 'The page ended inside the event after nextCursor: continue with since=nextCursor, offset=nextOffset.' },
    more: { type: 'boolean' },
    gap: GAP,
    gaps: { type: 'array', items: GAP },
    lines: {
      type: 'object',
      properties: {
        requested: { type: 'integer', description: 'Lines asked for (tail): of output, or a hole’s note. With as: events, events.' },
        returned: { type: 'integer', description: 'Lines returned, as requested counts them: of output, or a hole’s note (the [terminal] and [run …] header lines come extra). Fewer than requested without truncated: the range holds no more. More: with several sources, the lines reach back to the line written last. With as: events, the events returned.' },
        cutHead: { type: 'boolean' },
        begunBefore: { type: 'boolean', description: 'With cutHead: the first line may have begun before the lines read, in the page before; head then reads it on from where that page ends, not from its head.' },
        before: { type: 'object', description: 'Where what came before ends: pass its until as until, and its untilOffset, when given (the lines begin inside an event), as untilOffset, beside the same tail.', properties: { until: { type: 'integer' }, untilOffset: { type: 'integer' } }, required: ['until'] },
        head: { type: 'object', description: 'With cutHead: a head-first read (since, offset) from where the page before ends, which shows the first line from its head (with begunBefore, on from there).', properties: { since: { type: 'integer' }, offset: { type: 'integer' } }, required: ['since'] },
      },
      required: ['requested', 'returned'],
    },
    truncated: { type: 'boolean' },
    splitLine: { type: 'boolean' },
    oldestSeq: { type: 'integer' },
  },
  required: ['session', 'seq', 'nextCursor', 'more', 'truncated'],
};

const SCREEN_OUTPUT: Schema = {
  type: 'object',
  properties: {
    cols: { type: 'integer' },
    rows: { type: 'integer' },
    alt: { type: 'boolean' },
    cursor: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
    lines: { type: 'array', items: { type: 'string' } },
    title: { type: 'string' },
    seq: { type: 'integer' },
    droppedUnits: { type: 'integer', description: 'Output the emulator dropped under backlog: the screen is approximate.' },
  },
  required: ['cols', 'rows', 'alt', 'cursor', 'lines', 'seq'],
};

const CANCEL_OUTPUT: Schema = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    state: { type: 'string', enum: ['queued', 'starting', 'running', 'exited', 'cancelled', 'lost'] },
    contract: { type: 'string', enum: ['shell', 'process'] },
    steps: { type: 'array', items: { type: 'string' } },
    escalation: { type: 'string' },
  },
  required: ['runId', 'state', 'contract'],
};

const SUMMARY: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    owner: { type: 'string' },
    visibility: { type: 'string', enum: ['private', 'shared'] },
    state: { type: 'string' },
    controller: { description: 'principal holding the seat, or null' },
    cwd: { type: 'string' },
    integration: { type: 'string' },
    backend: { type: 'string' },
    pid: { type: 'integer' },
    currentRun: { description: 'runId occupying the shell, or null' },
    lastSeq: { type: 'integer' },
    oldestSeq: { type: 'integer' },
    retention: { type: 'object', description: 'What the session keeps on disk: the retention its store applies now.', properties: { maxBytes: { type: 'integer' }, maxAgeMs: { type: 'integer' } } },
    pendingRetention: {
      type: 'object',
      description: "The retention this session will apply, held for now: after a restart the daemon could not yet tell whether this session's earlier commands are still running, so it keeps every file, past this cap too, until a later start can tell. Nothing is lost meanwhile, and it applies by itself then.",
      properties: { maxBytes: { type: 'integer' }, maxAgeMs: { type: 'integer' } },
    },
    recovered: { type: 'string' },
    closed: { type: 'boolean' },
    createdAt: { type: 'number' },
    lastActivity: { type: 'number' },
    declared: { type: 'object', description: 'The innermost declared shell, where run goes now: its kind and the runId whose program it is (null: it replaced the session’s shell).', properties: { shell: { type: 'string' }, within: { description: 'runId, or null' } }, required: ['shell', 'within'] },
    cols: { type: 'integer' },
    rows: { type: 'integer' },
    services: { type: 'array', items: { type: 'object', properties: { runId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: SERVICE_STATUS }, evidence: { type: 'string' } }, required: ['runId', 'status'] } },
    watches: { type: 'integer' },
    runs: {
      type: 'array',
      description: 'The Runs that have not ended, the 20 newest.',
      items: {
        type: 'object',
        properties: { runId: { type: 'string' }, target: { type: 'string' }, state: { type: 'string' }, principal: { type: 'string' }, line: { type: 'string' }, admittedAt: { type: 'number' } },
        required: ['runId', 'target', 'state', 'principal', 'admittedAt'],
      },
    },
    runsOmitted: { type: 'integer', description: 'Runs that have not ended beyond the 20 listed in runs.' },
    servicesOmitted: { type: 'integer', description: 'Services beyond the 20 listed in services.' },
  },
  required: ['id', 'owner', 'visibility', 'state', 'lastSeq'],
};

/** A hit's pipe and whether both pipes wrote to its line (search and watches read a process Run's stdout and stderr as one source). */
const STREAM: Schema = { type: 'string', enum: ['stdout', 'stderr'], description: "A process Run's line: the pipe that wrote its first character that showed, kept though a later backspace or cursor move wrote over it." };
const MIXED: Schema = { type: 'boolean', description: "Both of the Run's pipes wrote characters to the line that showed when written, whether or not they still show." };

const WAIT_OUTPUT: Schema = {
  type: 'object',
  properties: {
    session: { type: 'string' },
    matched: { type: 'boolean' },
    kind: { type: 'string', enum: ['pattern', 'silence', 'idle'] },
    match: { type: 'string' },
    line: { type: 'string' },
    clipped: { type: 'boolean', description: 'The line was longer than the match window and matched on its head only; `line` is that head.' },
    stream: STREAM,
    mixed: MIXED,
    seq: { type: 'integer', description: 'The event that satisfied the wait: for a pattern, the one that completed the line, or for a line a flush completed (its Run ended, the session exited, a hole, a partial line left quiet) the one its last output came in. For silence, the last output the quiet is measured from when it had lasted long enough already, a Run\'s end when it ended, else the journal\'s last event; absent when the quiet had lasted long enough already with no output to name: a Run whose earlier output is gone, its quiet counted from when this daemon began watching its session.' },
    cursor: { type: 'integer', description: "A pattern's line: pass as read `since` (with `offset`) to read from its start, as a search match's cursor." },
    offset: { type: 'integer' },
    elapsedMs: { type: 'number' },
    nextCursor: { type: 'integer' },
    reason: { type: 'string', description: 'Why the wait ended early without a match (the session exited, the Run ended).' },
  },
  required: ['session', 'matched', 'kind', 'elapsedMs', 'nextCursor'],
};

const SEARCH_OUTPUT: Schema = {
  type: 'object',
  properties: {
    session: { type: 'string' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          seq: { type: 'integer' },
          cursor: { type: 'integer', description: 'Pass as read `since` (with `offset`) to read from the matching line.' },
          offset: { type: 'integer' },
          clipped: { type: 'boolean' },
          stream: STREAM,
          mixed: MIXED,
          lineNumber: { type: 'integer' },
          line: { type: 'string' },
          before: { type: 'array', items: { type: 'string' } },
          after: { type: 'array', items: { type: 'string' } },
        },
        required: ['seq', 'lineNumber', 'line', 'before', 'after'],
      },
    },
    scanned: { type: 'array', items: { type: 'integer' } },
    more: { type: 'boolean' },
    bounded: { type: 'boolean' },
    nextCursor: { type: 'integer' },
    nextOffset: { type: 'integer' },
    stoppedBy: { type: 'string', enum: ['limit', 'time', 'size'] },
    clippedLines: { type: 'integer' },
    gap: GAP,
    gaps: { type: 'array', items: GAP },
  },
  required: ['session', 'matches', 'scanned', 'more', 'bounded'],
};

const WATCH_OUTPUT: Schema = {
  type: 'object',
  properties: {
    watchId: { type: 'string' },
    kind: { type: 'string', enum: ['pattern', 'silence', 'idle'] },
    label: { type: 'string' },
    owner: { type: 'string' },
    spec: { type: 'object' },
    createdAt: { type: 'number' },
    fired: { type: 'integer' },
    lastFiredAt: { type: 'number' },
    lastMatch: { type: 'string' },
  },
  required: ['watchId', 'kind', 'label', 'owner', 'fired'],
};

const summaryLine = (s: SessionSummary) => {
  const others = (s.runs ?? []).filter((r) => r.runId !== s.currentRun);
  const omitted = s.runsOmitted ? ` (+${s.runsOmitted} older not listed)` : '';
  const runs = others.length ? ` · runs ${others.map((r) => `${r.runId} ${r.state}${r.target === 'process' ? ' (process)' : ''}${r.line ? ` "${r.line}"` : ''}`).join(', ')}${omitted}` : '';
  return `${s.id}: ${s.state}${s.recovered ? ` (${s.recovered})` : s.closed ? ' (closed)' : ''} · owner ${s.owner} · seat ${s.controller ?? 'free'}${s.cwd ? ` · cwd ${s.cwd}` : ''}${s.currentRun ? ` · running ${s.currentRun}` : ''}${runs}${s.services?.length ? ` · services ${s.services.map((v) => `${v.name ?? v.runId}=${v.status}`).join(', ')}${s.servicesOmitted ? ` (+${s.servicesOmitted} older not listed)` : ''}` : ''}${s.watches ? ` · ${s.watches} watch${s.watches > 1 ? 'es' : ''}` : ''} · seq ${s.lastSeq}`;
};

const TCP: Schema = { type: 'object', properties: { port: { type: 'integer', minimum: 1, maximum: 65535 }, host: { type: 'string' } }, required: ['port'], additionalProperties: false };

export const TOOLS: ToolDef[] = [
  {
    name: 'run',
    tier: 'core',
    description:
      'Run a command in a session and wait up to `wait` ms for it to end. The default `shell` target runs it in the ' +
      "session's persistent shell, so `cd`, `export` and activations persist across runs (and `exit` ends the session's shell); " +
      'the `process` target spawns it directly with an exact exit status and separate stderr, in the shell’s cwd, but none of its exports. ' +
      'Returns the output and one status line. If the command is still running when the wait ends you get its runId ' +
      'and `state: running` — it keeps running; use `await` to keep waiting or `read` to fetch what it printed. ' +
      'If another command is occupying the shell you get `state: busy` and nothing runs (pass `queue: true` to run after it). ' +
      'When that command opened another shell — `ssh host`, `sudo -i`, `docker exec -it … bash`, a nested `bash` — declare it once with `session_declare_shell`; ' +
      'from then on `run` goes to that shell (output, exit status, `cd`/exports persisting there; results say `cwd unknown` and name the declared shell) until the command ends. ' +
      'A running command that seems to wait for input, or a full-screen program, is flagged in the result (`waiting`). Creates the session if it does not exist. ' +
      'Use `input` to type into a program that is already running, `screen` to see a full-screen program. ' +
      'Do not `set -e` in the session shell (keep it inside scripts and subshells): it stays on there, and the next failing command ends the whole shell, so the command running then ends `lost: shell-exited`. Every Run reports its own exit status anyway.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        command: { type: 'string', minLength: 1, description: 'The command line (multi-line allowed).' },
        target: { type: 'string', enum: ['shell', 'process'], description: 'shell (default) or process.' },
        wait: { type: 'integer', minimum: 0, maximum: 55000, description: 'Milliseconds to wait for completion (default 20000, max 55000).' },
        queue: { type: 'boolean', description: 'If the shell is busy, queue behind the running command instead of returning busy.' },
        cwd: { type: 'string', description: 'Working directory, used only when this call creates the session; on an existing session the result lists it as ignored (cd in the command instead).' },
        envBasis: { type: 'string', enum: ['configured', 'snapshot'], description: 'process target only: the configured env (default) or the last session_env_capture snapshot.' },
        idempotencyKey,
      },
      required: ['session', 'command'],
      additionalProperties: false,
    },
    outputSchema: RUN_OUTPUT,
    async run(ctx, a) {
      return runResult(ctx, await ctx.app.run(ctx.caller, pick(a, ['session', 'command', 'target', 'wait', 'queue', 'cwd', 'envBasis', 'idempotencyKey'])));
    },
  },
  {
    name: 'session_declare_shell',
    tier: 'core',
    description:
      'Say that the program in front of the session’s terminal is a shell — the remote end of `ssh host`, a `sudo -i`, `docker exec -it … bash`, a nested shell, ' +
      'or a shell that replaced the session’s own (`reason: shell-unavailable`). From then on `run` goes to that shell: the command travels inline with start and end ' +
      'markers, so you get its output and exit status, and `cd`/exports persist there; results say `cwd unknown` and name the declared shell. The declaration ends by itself ' +
      'when the command that opened the shell ends (ssh exits), and a note in the session says so: after your own `exit` or a cancel of that command, the next `run` is in the session’s own shell again; ' +
      'after an end you did not ask for (the connection dropped), the next `run` is refused once (`busy: declared-shell-ended`), so a command meant for the remote does not run locally — run it again if local is what you mean. ' +
      'Declare again inside a second hop (an `ssh` run from a declared shell); `shell: "none"` takes the last declaration back. Needs the seat, like `run`.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        shell: {
          type: 'string',
          description:
            'Optional: the kind of shell in front. sh (the default), bash, zsh, dash and ksh are all the same to the daemon; name fish, which is typed differently. ' +
            'none takes the last declaration back.',
        },
        within: { type: 'string', description: 'Optional: the runId whose program is that shell. Default: the innermost running Run (what holds the terminal now).' },
        idempotencyKey,
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        shell: { description: 'The declared shell commands go to now, or null for the session’s own shell.' },
        within: { description: 'The runId whose program it is; null for the program that replaced the session’s shell.' },
        depth: { type: 'integer', description: 'How many declarations are stacked (a second hop is 2).' },
        line: { type: 'string', description: 'The command line of that Run.' },
        replayed: { type: 'boolean' },
      },
      required: ['session', 'shell', 'within', 'depth'],
    },
    async run(ctx, a) {
      const r = await ctx.app.declareShell(ctx.caller, pick(a, ['session', 'shell', 'within', 'idempotencyKey']));
      const where = r.shell === null ? 'the session’s own shell' : `the declared ${r.shell} shell${r.within ? ` in front (${r.within}${r.line ? ` ${r.line}` : ''}), until ${r.within} ends` : ' that replaced the session’s shell'}`;
      return render(ctx, `[declared: run in ${r.session} now goes to ${where}${r.depth > 1 ? ` · depth ${r.depth}` : ''}${r.replayed ? ' · replayed' : ''}]`, env(r));
    },
  },
  {
    name: 'await',
    tier: 'core',
    description:
      'Wait up to `wait` ms for a Run to end, and return its result and output. Use after `run` or `start` returned a runId ' +
      'that is still running. Nothing about the Run changes if the wait ends first — call again, or `cancel` it. ' +
      'Works for Runs that already ended, including in sessions whose shell has since exited.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, session: { ...session, description: 'Optional: the session the Run belongs to.' }, wait: { type: 'integer', minimum: 0, maximum: 55000 } },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: RUN_OUTPUT,
    async run(ctx, a) {
      return runResult(ctx, await ctx.app.awaitRun(ctx.caller, pick(a, ['session', 'runId', 'wait'])));
    },
  },
  {
    name: 'read',
    tier: 'core',
    description:
      "Read a session's history as text (default) or as journal events. `since: N` pages forward from a cursor — the " +
      'result says `more` and gives the next cursor, so nothing is read twice or skipped. `runId` pages through one ' +
      "command's full output the same way. `tail: N` gives the last N lines (also of one Run with `runId`; with `as: events`, the last N events); for what came before, pass its " +
      '`lines.before.until` as `until`, and its `lines.before.untilOffset`, when given, as `untilOffset`, with the same tail. Every result carries `nextCursor`; ' +
      'when a page ends inside a large output event it also carries `nextOffset` — pass both back (`since`, `offset`). ' +
      'Use `screen` for what the terminal shows right now; use `search` to find a pattern in history.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        since: { type: 'integer', minimum: 0, description: 'Page forward from this cursor (exclusive).' },
        offset: { type: 'integer', minimum: 0, description: 'With since: continue inside the event after since (a result’s nextOffset).' },
        until: { type: 'integer', minimum: 0, description: 'Stop at this cursor (inclusive).' },
        untilOffset: { type: 'integer', minimum: 0, description: 'With tail and until: stop inside the event at until, after this many of its bytes (a tail result’s lines.before.untilOffset).' },
        tail: { type: 'integer', minimum: 1, maximum: 10000, description: 'The last N lines: of output, or the note a hole leaves; the [terminal] and [run …] lines naming sources come extra. With as: events, the last N events.' },
        runId: { type: 'string', description: "One Run's output, paged from its start (combine with since)." },
        as: { type: 'string', enum: ['text', 'events'] },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 1048576, description: 'Page size in bytes (default 16384).' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'events only: page size in events (default 200).' },
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: READ_OUTPUT,
    async run(ctx, a) {
      const o = pick<Parameters<App['read']>[1]>(a, ['session', 'since', 'offset', 'until', 'untilOffset', 'tail', 'runId', 'as', 'maxBytes', 'limit']);
      if (o.since === undefined && o.tail === undefined && o.runId === undefined) o.tail = 50;
      const r = await ctx.app.read(ctx.caller, o);
      const res = renderRead(r, ctx.resultText, o);
      // The read cursor advances after a successful socket write without requiring remote receipt (G22).
      res.onSent = () => commitReadDelivery(r);
      return res;
    },
  },
  {
    name: 'screen',
    tier: 'core',
    description:
      "The terminal's current screen as lines, with the cursor position and whether a full-screen program (TUI) is active. " +
      'Use it for interactive programs and to see exactly what a human at the terminal sees; use `read` for scrollback.',
    inputSchema: { type: 'object', properties: { session }, required: ['session'], additionalProperties: false },
    outputSchema: SCREEN_OUTPUT,
    async run(ctx, a) {
      const s = await ctx.app.screen(ctx.caller, { session: a.session as string });
      const structured = env(s);
      // The read cursor advances after a successful socket write without requiring remote receipt (G22).
      const onSent = () => commitReadDelivery(s);
      if (ctx.resultText === 'json') return { text: JSON.stringify(s, null, 2), structured, onSent };
      const status = `[screen ${a.session as string} ${s.cols}x${s.rows}${s.alt ? ' · full-screen program' : ''} · cursor ${s.cursor.x},${s.cursor.y} · seq ${s.seq}${s.title ? ` · title "${s.title}"` : ''}${s.droppedUnits ? ` · approximate: ${s.droppedUnits} output units dropped under backlog` : ''}]`;
      return { text: s.lines.join('\n').replace(/\n+$/, '') + '\n' + status, structured, onSent };
    },
  },
  {
    name: 'input',
    tier: 'core',
    description:
      'Type into the terminal exactly the given `text` and/or named `keys`; nothing is appended, so send `keys: ["Enter"]` ' +
      'to submit a line. Keys: Enter, Tab, S-Tab, Esc, Space, Backspace, Delete, Insert, Up/Down/Left/Right, Home, End, ' +
      'PageUp/PageDown, F1–F12; C-a..C-z, C-\\, C-], C-@, C-^, C-_ (Ctrl); M-<char> (Alt); and C-/M-/S- on the arrows, ' +
      'Home/End, Insert/Delete, PageUp/PageDown and F-keys (C-Left, S-Up, C-S-F5). Arrows follow the program’s cursor-key ' +
      'mode automatically. Requires the controller seat. ' +
      'Use `run` to execute a command line; use `input` for prompts, REPLs and TUIs. `sensitive: true` journals the entry redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        text: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        sensitive: { type: 'boolean' },
        idempotencyKey,
      },
      required: ['session'],
      additionalProperties: false,
    },
    async run(ctx, a) {
      const r = await ctx.app.input(ctx.caller, pick(a, ['session', 'text', 'keys', 'sensitive', 'idempotencyKey']));
      return render(ctx, `[input sent · seq ${r.seq}${r.replayed ? ' · replayed, not sent again' : ''}]`, env({ ok: true, ...r }));
    },
  },
  {
    name: 'cancel',
    tier: 'core',
    description:
      'Cancel a Run. A queued Run is dropped. A process Run is signalled SIGINT, then SIGTERM, then SIGKILL, and its exit is ' +
      'observed. A shell Run gets ^C, then ^\\, then SIGTERM and SIGKILL to its foreground job (never the shell); the result ' +
      'says `cancelled` only when the shell confirmed the job ended, and names the escalation (`session_close`) if it survived. ' +
      'A Run in a declared shell (ssh and the like) gets ^C, the end marker, ^\\ — no signals, its job may be on another machine — and the escalation names the enclosing Run to cancel. ' +
      'Cancelling a one-shot ssh only confirms the local client stopped. With ssh -t in the shell, terminal interrupts reach the remote job; with ssh -tt as a process Run, ending ssh hangs it up. The remote job may ignore these signals; a remote termd can observe and cancel that job directly.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, session: { ...session, description: 'Optional: the session the Run belongs to.' }, idempotencyKey },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: CANCEL_OUTPUT,
    async run(ctx, a) {
      const c = (await ctx.app.cancel(ctx.caller, pick(a, ['session', 'runId', 'idempotencyKey']))) as { runId: string; state: string; contract: string; steps?: string[]; escalation?: string; replayed?: boolean };
      const text = `[cancel ${c.runId} → ${c.state} (${c.contract} contract${c.steps?.length ? `: ${c.steps.join(', ')}` : ''})${c.escalation ? ` · escalation: ${c.escalation}` : ''}${c.replayed ? ' · replayed' : ''}]`;
      return render(ctx, text, env(c));
    },
  },
  {
    name: 'session_list',
    tier: 'core',
    description: 'List the sessions you can see, with state (idle, busy, tui, exited), controller, cwd, the Runs that have not ended (shell and process), services and last cursor.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { sessions: { type: 'array', items: SUMMARY } }, required: ['sessions'] },
    async run(ctx) {
      const list = ctx.app.sessionList(ctx.caller);
      return render(ctx, list.length ? list.map(summaryLine).join('\n') : '(no sessions)', env({ sessions: list }));
    },
  },
  {
    name: 'session_open',
    tier: 'core',
    description:
      'Create a session — a persistent login shell in its own terminal — or attach to one that exists (options then do not ' +
      'apply and are listed as ignored). The owner takes the controller seat automatically when it is free; `role: controller` asks for the seat ' +
      '(granted when free, or to the owner under owner-priority), `role: observer` only watches. ' +
      '`visibility: shared` lets other principals observe and, per `control` policy, act; `control` is seat (default), ' +
      'owner-priority, or open (shared principals may `run` when idle). Reopening a session whose shell ended starts a new shell; history continues.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        cwd: { type: 'string' },
        shell: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables (string values).' },
        retention: {
          type: 'object',
          properties: { maxBytes: { type: 'integer', minimum: 16384 }, maxAgeMs: { type: 'integer', minimum: 1000 } },
          additionalProperties: false,
          description: 'Limits on the history kept on disk. Default: the daemon’s, which keeps everything unless it was started with limits.',
        },
        visibility: { type: 'string', enum: ['private', 'shared'] },
        control: { type: 'string', enum: ['seat', 'owner-priority', 'open'] },
        cols: { type: 'integer', minimum: 20, maximum: 500 },
        rows: { type: 'integer', minimum: 5, maximum: 200 },
        role: { type: 'string', enum: ['observer', 'controller'], description: 'Ask for the seat (controller) or only watch (observer); default: the seat when you own the session and it is free.' },
        idempotencyKey,
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { created: { type: 'boolean' }, info: SUMMARY, role: { type: 'string', enum: ['observer', 'controller'] }, ignored: { type: 'array', items: { type: 'string' } }, replayed: { type: 'boolean' } },
      required: ['created', 'info', 'role'],
    },
    async run(ctx, a) {
      const o = pick<Parameters<App['sessionOpen']>[1]>(a, ['cwd', 'shell', 'env', 'visibility', 'control', 'cols', 'rows', 'retention', 'role', 'idempotencyKey']);
      o.id = a.session as string;
      const r = await ctx.app.sessionOpen(ctx.caller, o);
      const seat = r.role === 'controller' ? 'you hold the seat' : `you observe (seat: ${r.info.controller ?? 'free'})`;
      const text = `[session ${r.info.id} ${r.created ? 'created' : 'attached'} · ${r.info.state} · ${seat}${r.info.integration ? ` · integration ${r.info.integration}` : ''} · cwd ${r.info.cwd ?? '?'}${r.ignored ? ` · ignored: ${r.ignored.join(', ')}` : ''}${r.replayed ? ' · replayed' : ''}]`;
      return render(ctx, text, env(r));
    },
  },
  {
    name: 'session_close',
    tier: 'core',
    description:
      "End a session's shell: SIGHUP to the shell and its foreground job (a job that ignores it gets SIGTERM, then SIGKILL), then SIGKILL to the shell after a timeout (or immediately with `force`). Its history stays readable " +
      '(read, await) unless `forget: true`, which also deletes it.',
    inputSchema: { type: 'object', properties: { session, force: { type: 'boolean' }, forget: { type: 'boolean' }, idempotencyKey }, required: ['session'], additionalProperties: false },
    async run(ctx, a) {
      const r = await ctx.app.sessionClose(ctx.caller, pick(a, ['session', 'force', 'forget', 'idempotencyKey']));
      return render(ctx, `[session ${a.session as string} closed${r.forgotten ? ' and forgotten' : ' · history stays readable'}${r.replayed ? ' · replayed' : ''}]`, env({ ok: true, ...r }));
    },
  },
  {
    name: 'signal',
    tier: 'control',
    description:
      'Send a signal to the foreground job: SIGINT as ^C, SIGTSTP as ^Z, SIGQUIT as ^\\; other signals (SIGTERM, SIGKILL, SIGHUP, SIGUSR1…) ' +
      'go to the foreground process group, never to the shell itself (use session_close for that). Prefer `cancel` for a Run you started.',
    inputSchema: { type: 'object', properties: { session, signal: { type: 'string' }, idempotencyKey }, required: ['session'], additionalProperties: false },
    async run(ctx, a) {
      const r = await ctx.app.signal(ctx.caller, pick(a, ['session', 'signal', 'idempotencyKey']));
      return render(ctx, `[signal ${(a.signal as string | undefined) ?? 'SIGINT'} sent${r.replayed ? ' · replayed, not sent again' : ''}]`, env({ ...r }));
    },
  },
  {
    name: 'control',
    tier: 'control',
    description:
      'Take or release the controller seat of a session, or ask who holds it. Only the seat holder may type, signal or resize; a free seat is taken ' +
      'automatically by whoever acts first. The session owner can always take the seat over.',
    inputSchema: { type: 'object', properties: { session, action: { type: 'string', enum: ['take', 'release', 'status'] }, idempotencyKey }, required: ['session', 'action'], additionalProperties: false },
    async run(ctx, a) {
      const r = await ctx.app.control(ctx.caller, pick(a, ['session', 'action', 'idempotencyKey']));
      return render(ctx, `[seat: ${r.controller ?? 'free'}${r.replayed ? ' · replayed' : ''}]`, env(r));
    },
  },
  {
    name: 'resize',
    tier: 'control',
    description: 'Resize the terminal (controller only). Observers scale their own view instead.',
    inputSchema: {
      type: 'object',
      properties: { session, cols: { type: 'integer', minimum: 20, maximum: 500 }, rows: { type: 'integer', minimum: 5, maximum: 200 }, idempotencyKey },
      required: ['session', 'cols', 'rows'],
      additionalProperties: false,
    },
    async run(ctx, a) {
      const r = await ctx.app.resize(ctx.caller, pick(a, ['session', 'cols', 'rows', 'idempotencyKey']));
      return render(ctx, `[resized to ${a.cols as number}x${a.rows as number}${r.replayed ? ' · replayed' : ''}]`, env({ ...r }));
    },
  },
  {
    name: 'session_env_capture',
    tier: 'control',
    description: "Snapshot the shell's current environment (runs `env -0` in it) so later process-target Runs can use `envBasis: snapshot` and see the shell's exports and activations.",
    inputSchema: { type: 'object', properties: { session, idempotencyKey }, required: ['session'], additionalProperties: false },
    async run(ctx, a) {
      const r = await ctx.app.envCapture(ctx.caller, pick(a, ['session', 'idempotencyKey']));
      return render(ctx, `[environment captured · ${r.count} variables · seq ${r.seq}${r.replayed ? ' · replayed' : ''}]`, env(r));
    },
  },
  {
    name: 'start',
    tier: 'services',
    description:
      'Start a long-running command as a Service and wait up to `wait` ms for it to become ready: `ready.pattern` (a regex over its output), ' +
      '`ready.tcp` (a port that must accept connections) and `ready.exitWithinMs` (must not exit that soon) must all pass. `fail.pattern` marks it ' +
      'unhealthy until a ready line matches again; `health.tcp` is re-checked after readiness. Status: starting; ready (its probes passed); running ' +
      '(no readiness condition was given and it stayed up 2 s — readiness unknown); unhealthy; exited (its end was observed); lost (its end was not ' +
      'observed; the process may still run). Patterns match per output line (`^`/`$` are line ends). Use a dedicated ' +
      'session per service (a shell-target service occupies its shell). Status changes arrive as notifications on MCPL connections; on ' +
      'plain MCP, check session_list or use wait_for. `await` returns when it exits.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        command: { type: 'string', minLength: 1 },
        name: { type: 'string', description: 'A label for status lines.' },
        target: { type: 'string', enum: ['shell', 'process'] },
        ready: {
          type: 'object',
          properties: { pattern: { type: 'string' }, tcp: TCP, exitWithinMs: { type: 'integer', minimum: 1 }, timeoutMs: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
        fail: { type: 'object', properties: { pattern: { type: 'string' } }, additionalProperties: false },
        health: { type: 'object', properties: { tcp: TCP, intervalMs: { type: 'integer', minimum: 250 } }, additionalProperties: false },
        wait: { type: 'integer', minimum: 0, maximum: 55000 },
        cwd: { type: 'string', description: 'Working directory, used only when this call creates the session.' },
        envBasis: { type: 'string', enum: ['configured', 'snapshot'], description: 'process target only: the configured env (default) or the last session_env_capture snapshot.' },
        idempotencyKey,
      },
      required: ['session', 'command'],
      additionalProperties: false,
    },
    outputSchema: RUN_OUTPUT,
    async run(ctx, a) {
      return runResult(ctx, await ctx.app.start(ctx.caller, pick(a, ['session', 'command', 'name', 'target', 'ready', 'fail', 'health', 'wait', 'cwd', 'envBasis', 'idempotencyKey'])));
    },
  },
  {
    name: 'watch',
    tier: 'watch',
    description:
      'Set a standing watch on a session that notifies you when it fires: `pattern` (a regex matched per output line as the terminal shows it, a tab as the spaces to the next tab stop — `^`/`$` are line ends, and a ' +
      'prompt with no newline counts after 0.5 s of quiet), `silenceMs` (output stopped for ' +
      'that long), or `idle` (the shell became free after running something). Give exactly one. `label` names it in notifications; `once` removes ' +
      'it after the first firing. A process Run\'s stdout and stderr are one source, as `read` shows them: a line can hold both, and a firing names ' +
      'the pipe that wrote its line\'s first character that showed and says when both pipes wrote characters to it that showed. ' +
      'Notifications need an MCPL connection; on plain MCP a watch only counts its firings (see `watches`) — use ' +
      '`wait_for` to block on the same conditions instead.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        pattern: { type: 'string' },
        silenceMs: { type: 'integer', minimum: 100 },
        idle: { type: 'boolean' },
        runId: { type: 'string', description: 'Only output from this Run.' },
        label: { type: 'string' },
        once: { type: 'boolean' },
        idempotencyKey,
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: WATCH_OUTPUT,
    async run(ctx, a) {
      const w = await ctx.app.watch(ctx.caller, pick(a, ['session', 'pattern', 'silenceMs', 'idle', 'runId', 'label', 'once', 'idempotencyKey']));
      const note = ctx.notifications === false ? ' — this connection cannot receive notifications: poll `watches` or use `wait_for`' : '';
      return render(ctx, `[watch ${w.watchId} "${w.label}" armed (${w.kind})${note}${w.replayed ? ' · replayed' : ''}]`, env(w));
    },
  },
  {
    name: 'unwatch',
    tier: 'watch',
    description: 'Remove a watch you set (or any watch on a session you own).',
    inputSchema: { type: 'object', properties: { session, watchId: { type: 'string' }, idempotencyKey }, required: ['session', 'watchId'], additionalProperties: false },
    async run(ctx, a) {
      const r = await ctx.app.unwatch(ctx.caller, pick(a, ['session', 'watchId', 'idempotencyKey']));
      return render(ctx, `[watch ${a.watchId as string} ${r.removed ? 'removed' : 'not found'}${r.replayed ? ' · replayed' : ''}]`, env(r));
    },
  },
  {
    name: 'watches',
    tier: 'watch',
    description: 'List the watches armed on a session, with how often each has fired.',
    inputSchema: { type: 'object', properties: { session }, required: ['session'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { watches: { type: 'array', items: WATCH_OUTPUT } }, required: ['watches'] },
    async run(ctx, a) {
      const list = ctx.app.watches(ctx.caller, { session: a.session as string });
      const text = list.length ? list.map((w) => `${w.watchId}: "${w.label}" (${w.kind}) by ${w.owner} · fired ${w.fired}×`).join('\n') : '(no watches)';
      return render(ctx, text, env({ watches: list }));
    },
  },
  {
    name: 'wait_for',
    tier: 'watch',
    description:
      'Block up to `wait` ms until a session shows `pattern` in its output, goes quiet for `silenceMs`, or becomes `idle`. With `since`, output ' +
      'already printed after that cursor counts, so a line printed before the call is not missed. Patterns match per output line, as the terminal shows it: ' +
      'a tab is the spaces up to the next tab stop, so match it with ` +` or `\\s+`, not `\\t`. A process Run\'s stdout and stderr are one source, as ' +
      '`read` shows them: a line can hold both, and a match names the pipe that wrote its first character that showed (`stream`) and says `mixed` when both ' +
      'pipes wrote characters to it that showed. Returns ' +
      'matched: false when the wait ends first, and at once with a `reason` when it can no longer be met (the shell exited, the Run ended). ' +
      '`nextCursor` is the position of the match (or the journal’s end when nothing matched): pass it as the next wait’s `since` to go on from there.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        pattern: { type: 'string' },
        silenceMs: { type: 'integer', minimum: 100 },
        idle: { type: 'boolean' },
        runId: { type: 'string' },
        since: { type: 'integer', minimum: 0 },
        wait: { type: 'integer', minimum: 0, maximum: 55000 },
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: WAIT_OUTPUT,
    async run(ctx, a) {
      const r = await ctx.app.waitFor(ctx.caller, pick(a, ['session', 'pattern', 'silenceMs', 'idle', 'runId', 'since', 'wait']));
      // A match on a clipped line is said in the text, in the words search's status and the watch notice use (headOnlyText); only `--json` showed `clipped` (the house's read of the 38 commits, #22 comment 6274806357).
      const clipped = r.clipped ? ` · ${headOnlyText()}` : '';
      const from = r.cursor !== undefined ? ` · read since=${r.cursor}${r.offset ? ` offset=${r.offset}` : ''}` : '';
      const text = r.matched ? `[${r.kind} matched after ${fmt(r.elapsedMs)}${r.line ? `: ${r.line}` : r.match ? `: ${r.match}` : ''}${item(pipeOf(r))}${r.seq !== undefined ? ` · seq ${r.seq}` : ''}${from}${clipped}]` : `[no ${r.kind} match${r.reason ? ` · ${r.reason}` : ` within ${fmt(r.elapsedMs)}`} · next=${r.nextCursor}]`;
      return render(ctx, text, env(r));
    },
  },
  {
    name: 'search',
    tier: 'search',
    description:
      "Search a session's output history with a regex, line by line: each match comes with lines of context and a `cursor`, plus an `offset` when the line " +
      'lies inside a long output event — `read since=<cursor> offset=<offset>` reads on from the matching line (each match’s own `[read …]` hint spells it out). ' +
      'Patterns run on a linear-time engine: no back-references or lookahead. A line reads as the terminal shows it: a tab is the spaces up to the next ' +
      'tab stop, so match it with ` +` or `\\s+`, not `\\t`. A process Run\'s stdout and stderr are one source, as `read` shows them: a line can hold ' +
      'both, and a match names the pipe that wrote its first character that showed (`stream`) and says `mixed` when both pipes wrote characters to it that ' +
      'showed. Without `since`, the recent past is ' +
      'scanned and the result says if older history was left out, as it says what it skipped (gaps, over-long lines). Use `read` to page through output.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        pattern: { type: 'string' },
        flags: { type: 'string', description: 'Regex flags, e.g. "i".' },
        context: { type: 'integer', minimum: 0, maximum: 20 },
        since: { type: 'integer', minimum: 0 },
        offset: { type: 'integer', minimum: 0, description: 'With since: continue inside the event after since (a result’s nextOffset).' },
        until: { type: 'integer', minimum: 0 },
        runId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Matches per call (default 50); a matching line open since the scan started is reported even past it.' },
      },
      required: ['session', 'pattern'],
      additionalProperties: false,
    },
    outputSchema: SEARCH_OUTPUT,
    async run(ctx, a) {
      return renderSearch(await ctx.app.search(ctx.caller, pick(a, ['session', 'pattern', 'flags', 'context', 'since', 'offset', 'until', 'runId', 'limit'])), ctx.resultText);
    },
  },
  ...COMPAT_TOOLS,
];

export const CORE_TOOLS = TOOLS.filter((t) => t.tier === 'core').map((t) => t.name);

/** Plain MCP profiles: `core` (the default), `full` (every tier), `compat` (the 1.x names plus await, read and session_declare_shell, one release). */
export function toolsFor(profile: Profile): ToolDef[] {
  // compat also serves `await` and `read`: its results hand out runIds, and these are how to follow them (ux-14).
  // compat also serves session_declare_shell: 1.x typed commands into whatever shell was in front (ssh, sudo -i, a nested
  // shell), and runCommand can only send them there once the caller has declared it (the house's read of 1cabc6a, #22).
  if (profile === 'compat') return TOOLS.filter((t) => t.tier === 'compat' || t.name === 'await' || t.name === 'read' || t.name === 'session_declare_shell');
  if (profile === 'full') return TOOLS.filter((t) => t.tier !== 'compat');
  return TOOLS.filter((t) => t.tier === 'core');
}

/** Validate and run a tool; errors become `isError` results whose text carries the code. */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext, available: ToolDef[] = toolsFor('full')): Promise<ToolResult> {
  const tool = available.find((t) => t.name === name);
  if (!tool) return { text: `unknown_tool: ${name} is not available on this connection`, isError: true };
  try {
    validate(args ?? {}, tool.inputSchema);
    return await tool.run(ctx, args ?? {});
  } catch (e) {
    if (e instanceof ValidationError) return { text: `invalid_argument: ${e.message}`, isError: true };
    if (e instanceof TermError) return { text: `${e.code}: ${e.message}`, isError: true };
    const msg = e instanceof Error ? e.message : String(e);
    return { text: `internal: ${msg}`, isError: true };
  }
}
