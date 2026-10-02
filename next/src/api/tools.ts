/**
 * The tool table (§11): the MCP projection of the application API. Each tool
 * is one verb, its description says when to use it instead of its neighbours,
 * and each result comes in two renderings — a transcript for the model and a
 * structured envelope for scripts (G27). An envelope always conforms to the
 * tool's declared outputSchema; error results carry no envelope (the text says
 * `code: message`), which MCP permits.
 */
import { TermError } from '../core/errors.js';
import type { App, Caller, ReadResult, RunResult, SearchResult, SessionSummary } from './app.js';
import { COMPAT_TOOLS } from './compat.js';
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
    'Optional; use a fresh unique value (a UUID) per operation. Retrying the same call with the same key within 15 minutes returns the first ' +
    'call’s outcome instead of doing it again (for run and start: the same Run, awaited again — also after a daemon restart). A key reused ' +
    'with other arguments is refused. A `busy` outcome (nothing ran) is not remembered, so its retry can run.',
} as const satisfies Schema;
const fmt = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const env = (r: object) => r as unknown as Record<string, unknown>;

/** Every tool's text: the envelope as JSON in `json` mode (for scripts), the transcript otherwise (atc-15). */
const render = (ctx: ToolContext, transcript: string, structured: Record<string, unknown>): ToolResult => ({
  text: ctx.resultText === 'json' ? JSON.stringify(structured, null, 2) : transcript,
  structured,
});

const TERMINAL = new Set(['exited', 'cancelled', 'lost']);

/** A Run result, marked delivered (G28) once the transport has written it (mcpl-1). */
function runResult(ctx: ToolContext, r: RunResult): ToolResult {
  const res = renderRun(r, ctx.resultText);
  if (r.runId !== undefined && (TERMINAL.has(r.state) || r.service !== undefined)) res.onSent = () => ctx.app.outcomeSent(ctx.caller, r);
  return res;
}

/** Copy the defined keys of `a` that the schema names (the tools' arguments are validated first). */
function pick<T extends object>(a: Record<string, unknown>, keys: string[]): T {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
  return o as T;
}

const BUSY_NEXT: Record<string, string> = {
  running: 'await or cancel it, pass queue:true to run after it, or use another session',
  'prompt-pending': 'the shell is between commands: retry, or pass queue:true',
  'human-editing': 'a partial command line sits at the prompt: clear it with input keys:["C-u"] (needs the seat), or pass queue:true',
  starting: 'the shell is still starting: pass queue:true to run once it is ready',
  exited: 'the shell has exited: run again to start a new one',
};

function runStatus(r: RunResult): string {
  switch (r.state) {
    case 'exited':
      return `exited ${r.exit ?? '?'}${r.signal ? ` (${r.signal})` : ''} in ${fmt(r.durationMs ?? 0)}`;
    case 'cancelled':
      return `cancelled${r.signal ? ` by ${r.signal}` : r.exit !== undefined ? ` (exit ${r.exit})` : ''} after ${fmt(r.durationMs ?? 0)}`;
    case 'lost':
      return `outcome unknown: ${r.reason ?? 'lost'}`;
    case 'queued':
      return `queued for ${fmt(r.queuedMs ?? 0)}, not started — it runs when the shell is free; await it`;
    case 'running':
    case 'starting': {
      const w = r.waiting;
      const next =
        w?.kind === 'tui'
          ? 'a full-screen program is open: look with screen, answer with input'
          : w?.kind === 'input'
            ? `it seems to wait for input (silent ${fmt(w.silentMs ?? 0)}, last line "${w.lastLine ?? ''}"): answer with input, or cancel`
            : `it keeps running; await it, or read since=${r.output.nextCursor}`;
      return `${r.state} ${fmt(r.durationMs ?? 0)} so far — ${next}`;
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
  // Under integration none the shell's cwd is not tracked, and only daemon Runs have boundaries (G5).
  const cwd = r.integration === 'none' ? 'cwd unknown (integration none: only daemon runs have boundaries)' : `cwd ${r.cwd}`;
  const basis = r.target === 'process' && r.envBasis ? ` · env ${r.envBasis}` : '';
  const ignored = r.ignored?.length ? ` · ignored: ${r.ignored.join(', ')} (the session exists; cd in the command instead)` : '';
  const status = `[run ${r.runId ?? '—'} ${runStatus(r)}${service} · ${r.target}${basis} · ${cwd} · next=${r.output.nextCursor}${r.output.truncated ? ' · truncated' : ''}${r.created ? ' · session created' : ''}${ignored}${r.replayed ? ' · replayed' : ''}]`;
  return { text: head + status, structured };
}

export function renderRead(r: ReadResult, mode: ResultText): ToolResult {
  const structured = env(r);
  if (mode === 'json') return { text: JSON.stringify(r, null, 2), structured };
  const body = r.text !== undefined ? r.text : JSON.stringify(r.events, null, 1);
  const next = `since=${r.nextCursor}${r.nextOffset ? ` offset=${r.nextOffset}` : ''}`;
  const lines = r.lines ? ` · ${r.lines.returned} of ${r.lines.requested} lines` : '';
  const gaps = r.gaps?.length ? ` · ${r.gaps.length} gaps not retained` : r.gap ? ` · gap ${r.gap.from}–${r.gap.to} not retained` : '';
  const status = `[read ${r.session}${r.runId ? ` run ${r.runId}` : ''} seq ${r.seq[0]}–${r.seq[1]}${lines} · next: ${next}${r.more ? ` · more: read ${next}` : ''}${r.splitLine ? ' · last line continues' : ''}${gaps}${r.truncated ? ' · truncated' : ''}]`;
  return { text: (body ? body + '\n' : '') + status, structured };
}

const SERVICE_STATUS = ['starting', 'ready', 'running', 'unhealthy', 'exited', 'lost'];

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
    waiting: { type: 'object', properties: { kind: { type: 'string', enum: ['input', 'tui'] }, lastLine: { type: 'string' }, silentMs: { type: 'number' }, heuristic: { type: 'boolean' } }, required: ['kind', 'heuristic'] },
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
    gap: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' }, reason: { type: 'string' } }, required: ['from', 'to'] },
    gaps: { type: 'array', items: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' }, reason: { type: 'string' } }, required: ['from', 'to'] } },
    lines: { type: 'object', properties: { requested: { type: 'integer' }, returned: { type: 'integer' } }, required: ['requested', 'returned'] },
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
    retention: { type: 'object', properties: { maxBytes: { type: 'integer' }, maxAgeMs: { type: 'integer' } } },
    recovered: { type: 'string' },
    closed: { type: 'boolean' },
    createdAt: { type: 'number' },
    lastActivity: { type: 'number' },
    services: { type: 'array', items: { type: 'object', properties: { runId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: SERVICE_STATUS } }, required: ['runId', 'status'] } },
    watches: { type: 'integer' },
    runs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { runId: { type: 'string' }, target: { type: 'string' }, state: { type: 'string' }, principal: { type: 'string' }, line: { type: 'string' }, admittedAt: { type: 'number' } },
        required: ['runId', 'target', 'state', 'principal', 'admittedAt'],
      },
    },
  },
  required: ['id', 'owner', 'visibility', 'state', 'lastSeq'],
};

const WAIT_OUTPUT: Schema = {
  type: 'object',
  properties: {
    session: { type: 'string' },
    matched: { type: 'boolean' },
    kind: { type: 'string', enum: ['pattern', 'silence', 'idle'] },
    match: { type: 'string' },
    line: { type: 'string' },
    seq: { type: 'integer' },
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
    gap: { type: 'object' },
    gaps: { type: 'array', items: { type: 'object' } },
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
  const runs = others.length ? ` · runs ${others.map((r) => `${r.runId} ${r.state}${r.target === 'process' ? ' (process)' : ''}${r.line ? ` "${r.line}"` : ''}`).join(', ')}` : '';
  return `${s.id}: ${s.state}${s.recovered ? ` (${s.recovered})` : s.closed ? ' (closed)' : ''} · owner ${s.owner} · seat ${s.controller ?? 'free'}${s.cwd ? ` · cwd ${s.cwd}` : ''}${s.currentRun ? ` · running ${s.currentRun}` : ''}${runs}${s.services?.length ? ` · services ${s.services.map((v) => `${v.name ?? v.runId}=${v.status}`).join(', ')}` : ''}${s.watches ? ` · ${s.watches} watch${s.watches > 1 ? 'es' : ''}` : ''} · seq ${s.lastSeq}`;
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
      'A running command that seems to wait for input, or a full-screen program, is flagged in the result (`waiting`). Creates the session if it does not exist. ' +
      'Use `input` to type into a program that is already running, `screen` to see a full-screen program.',
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
      "command's full output the same way. `tail: N` gives the last N lines (also of one Run with `runId`). Every result carries `nextCursor`; " +
      'when a page ends inside a large output event it also carries `nextOffset` — pass both back (`since`, `offset`). ' +
      'Use `screen` for what the terminal shows right now; use `search` to find a pattern in history.',
    inputSchema: {
      type: 'object',
      properties: {
        session,
        since: { type: 'integer', minimum: 0, description: 'Page forward from this cursor (exclusive).' },
        offset: { type: 'integer', minimum: 0, description: 'With since: continue inside the event after since (a result’s nextOffset).' },
        until: { type: 'integer', minimum: 0, description: 'Stop at this cursor (inclusive).' },
        tail: { type: 'integer', minimum: 1, maximum: 10000, description: 'The last N lines of output.' },
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
      const o = pick<Parameters<App['read']>[1]>(a, ['session', 'since', 'offset', 'until', 'tail', 'runId', 'as', 'maxBytes', 'limit']);
      if (o.since === undefined && o.tail === undefined && o.runId === undefined) o.tail = 50;
      return renderRead(await ctx.app.read(ctx.caller, o), ctx.resultText);
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
      if (ctx.resultText === 'json') return { text: JSON.stringify(s, null, 2), structured };
      const status = `[screen ${a.session as string} ${s.cols}x${s.rows}${s.alt ? ' · full-screen program' : ''} · cursor ${s.cursor.x},${s.cursor.y} · seq ${s.seq}${s.title ? ` · title "${s.title}"` : ''}${s.droppedUnits ? ` · approximate: ${s.droppedUnits} output units dropped under backlog` : ''}]`;
      return { text: s.lines.join('\n').replace(/\n+$/, '') + '\n' + status, structured };
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
      'says `cancelled` only when the shell confirmed the job ended, and names the escalation (`session_close`) if it survived.',
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
          description: 'Limits on the history kept on disk (G21). Default: the daemon’s, which keeps everything unless it was started with limits.',
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
      'Set a standing watch on a session that notifies you when it fires: `pattern` (a regex matched per output line — `^`/`$` are line ends, and a ' +
      'prompt with no newline counts after 0.5 s of quiet), `silenceMs` (output stopped for ' +
      'that long), or `idle` (the shell became free after running something). Give exactly one. `label` names it in notifications; `once` removes ' +
      'it after the first firing. Notifications need an MCPL connection; on plain MCP a watch only counts its firings (see `watches`) — use ' +
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
      'already printed after that cursor counts, so a line printed before the call is not missed. Patterns match per output line. Returns ' +
      'matched: false when the wait ends first, and at once with a `reason` when it can no longer be met (the shell exited, the Run ended).',
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
      const text = r.matched ? `[${r.kind} matched after ${fmt(r.elapsedMs)}${r.line ? `: ${r.line}` : r.match ? `: ${r.match}` : ''} · seq ${r.seq ?? '?'}]` : `[no ${r.kind} match${r.reason ? ` · ${r.reason}` : ` within ${fmt(r.elapsedMs)}`} · next=${r.nextCursor}]`;
      return render(ctx, text, env(r));
    },
  },
  {
    name: 'search',
    tier: 'search',
    description:
      "Search a session's output history with a regex, line by line: each match comes with lines of context and a `cursor` — `read since=<cursor>` " +
      'reads on from the matching line. Patterns run on a linear-time engine: no back-references or lookahead. Without `since`, the recent past is ' +
      'scanned and the result says if older history was left out. Use `read` to page through output.',
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
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['session', 'pattern'],
      additionalProperties: false,
    },
    outputSchema: SEARCH_OUTPUT,
    async run(ctx, a) {
      const r: SearchResult = await ctx.app.search(ctx.caller, pick(a, ['session', 'pattern', 'flags', 'context', 'since', 'offset', 'until', 'runId', 'limit']));
      const at = (c: number, o?: number) => `since=${c}${o ? ` offset=${o}` : ''}`;
      const body = r.matches.map((m) => [...m.before.map((l) => `  ${l}`), `> ${m.line}   [read ${at(m.cursor, m.offset)}]`, ...m.after.map((l) => `  ${l}`)].join('\n')).join('\n--\n');
      const more = r.more ? ` · more (${r.stoppedBy ?? 'limit'}): search ${at(r.nextCursor ?? r.scanned[1], r.nextOffset)}` : '';
      return render(ctx, `${body || '(no matches)'}\n[search ${r.session} · ${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}${more} · scanned seq ${r.scanned[0]}–${r.scanned[1]}${r.bounded ? ' · older history not scanned: pass since' : ''}]`, env(r));
    },
  },
  ...COMPAT_TOOLS,
];

export const CORE_TOOLS = TOOLS.filter((t) => t.tier === 'core').map((t) => t.name);

/** Plain MCP profiles: `core` (the default), `full` (every tier), `compat` (the 1.x names plus await and read, one release). */
export function toolsFor(profile: Profile): ToolDef[] {
  // compat also serves `await` and `read`: its results hand out runIds, and these are how to follow them (ux-14).
  if (profile === 'compat') return TOOLS.filter((t) => t.tier === 'compat' || t.name === 'await' || t.name === 'read');
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
