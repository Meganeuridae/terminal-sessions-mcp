/**
 * The compatibility pack (§11): the 1.x tool names and result shapes, mapped
 * onto the application API for one release so existing recipes keep working.
 * Served as the `compat` profile (the `terminal-sessions-mcp` bin's default);
 * never mixed into the core or full profiles. Every result also carries the new
 * fields that tell the truth the old shapes could not (`runId`, `state`).
 */
import { TermError } from '../core/errors.js';
import type { App } from './app.js';
import type { ToolContext, ToolDef, ToolResult } from './tools.js';

const json = (value: unknown): ToolResult => ({
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  structured: (Array.isArray(value) ? { items: value } : typeof value === 'object' && value !== null ? value : { value }) as Record<string, unknown>,
});

const raw = { type: 'boolean', description: 'If true, preserve raw ANSI escape codes in output (default: false, returns clean text)' } as const;

/** 1.x matched ready/error patterns as literal substrings (`output.includes`); several mean "any of these" (atc-8). */
const anyOf = (patterns: unknown): string | undefined => {
  if (!Array.isArray(patterns) || patterns.length === 0) return undefined;
  return patterns.map((p) => String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
};

/** Core tool names in texts that reach a compat caller, in the compat profile's words. */
const compatWords = (text: string): string => text.replace(/\bsession_close\b/g, 'killSession').replace(/\bsession_open\b/g, 'runCommand');

/** Quote a path for a POSIX shell line. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The most output a compat result carries: 1.x returned all of it; this keeps the tail beyond a bound, visibly. */
const COMPAT_OUTPUT_BYTES = 1024 * 1024;

/**
 * A Run's whole output, paged through `read` (text, or raw events), keeping the last
 * COMPAT_OUTPUT_BYTES with a visible marker when more was cut (er-14, atc-11).
 */
async function runOutput(app: App, ctx: ToolContext, session: string, runId: string, raw: boolean): Promise<string> {
  const parts: string[] = [];
  let bytes = 0;
  let cut = false;
  let since: number | undefined;
  let offset: number | undefined;
  for (let page = 0; page < 4096; page++) {
    const o: Parameters<App['read']>[1] = { session, runId, maxBytes: 256 * 1024 };
    if (since !== undefined) o.since = since;
    if (offset !== undefined) o.offset = offset;
    if (raw) {
      o.as = 'events';
      o.limit = 2000;
    }
    const r = await app.read(ctx.caller, o);
    const text = raw ? (r.events ?? []).filter((e) => e.type === 'output').map((e) => (e as { data: string }).data).join('') : (r.text ?? '') + (r.text && !r.splitLine && r.more ? '\n' : '');
    parts.push(text);
    bytes += text.length;
    while (bytes > COMPAT_OUTPUT_BYTES && parts.length > 1) {
      bytes -= parts.shift()!.length;
      cut = true;
    }
    if (!r.more || (r.nextCursor === since && r.nextOffset === offset)) break;
    since = r.nextCursor;
    offset = r.nextOffset;
  }
  const out = parts.join('');
  return cut ? `[… earlier output omitted: tailLogs {"lines": N} shows more of it]\n${out.slice(-COMPAT_OUTPUT_BYTES)}` : out;
}

async function lastLines(app: App, ctx: ToolContext, session: string, n: number, keepAnsi: boolean): Promise<string[]> {
  if (keepAnsi) {
    const r = await app.read(ctx.caller, { session, tail: Math.max(200, n * 4), as: 'events' });
    const data = (r.events ?? []).filter((e) => e.type === 'output').map((e) => (e as { data: string }).data).join('');
    return data.split(/\r?\n/).slice(-n);
  }
  const r = await app.read(ctx.caller, { session, tail: Math.max(200, n * 4), maxBytes: 1024 * 1024 });
  return (r.text ?? '').split('\n').slice(-n);
}

export const COMPAT_TOOLS: ToolDef[] = [
  {
    name: 'launch',
    tier: 'compat',
    description: 'Launch a process and optionally wait for readiness patterns in its output. Use runCommand for commands that finish on their own.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name' },
        command: { type: 'string', description: 'Command to run' },
        cwd: { type: 'string', description: 'Working directory' },
        readyPatterns: { type: 'array', items: { type: 'string' } },
        errorPatterns: { type: 'array', items: { type: 'string' } },
        raw,
      },
      required: ['name', 'command'],
    },
    async run(ctx, a) {
      const ready = anyOf(a.readyPatterns);
      const fail = anyOf(a.errorPatterns);
      const name = a.name as string;
      // 1.x launched into a fresh session in `cwd`; into an existing one, change there first (atc-22).
      const exists = ctx.app.sessionList(ctx.caller).some((s) => s.id === name && s.state !== 'exited');
      const command = exists && typeof a.cwd === 'string' ? `cd -- ${shq(a.cwd)} && ${a.command as string}` : (a.command as string);
      // Without patterns 1.x waited 2 s and said `running`: wait just past the 2 s liveness window (atc-7).
      const o: Parameters<App['start']>[1] = { session: name, command, wait: ready || fail ? 30_000 : 2_500 };
      if (a.cwd !== undefined && !exists) o.cwd = a.cwd as string;
      if (ready) o.ready = { pattern: ready };
      if (fail) o.fail = { pattern: fail };
      try {
        const r = await ctx.app.start(ctx.caller, o);
        if (r.state === 'busy') {
          const b = r.busy;
          return json({ status: 'error', logs: [`Failed to start service: session ${name} is busy${b?.runId ? ` running ${b.runId}${b.line ? ` (${b.line})` : ''}` : ''} (${b?.reason ?? 'busy'}); killSession it first, or use another name`], sessionId: name });
        }
        const status = r.service === 'ready' ? 'ready' : r.service === 'starting' || r.service === 'running' ? 'running' : 'error';
        return json({ status, logs: await lastLines(ctx.app, ctx, name, 50, a.raw === true), sessionId: name, runId: r.runId, service: r.service, evidence: r.evidence });
      } catch (e) {
        return json({ status: 'error', logs: [`Failed to start service: ${compatWords((e as Error).message)}`] });
      }
    },
  },
  {
    name: 'runCommand',
    tier: 'compat',
    description:
      'Run a command in a session (auto-creates the session if it does not exist). Calls to one session run one after another. ' +
      'Waits at most 55 s: a longer command returns state "running" with its runId — `await {"runId": …}` gets its exit code later, tailLogs shows its progress.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session name (will be created automatically if it does not exist)' },
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory (used when auto-creating a new session)' },
        timeout: { type: 'number', description: 'How long to wait in ms (default: 30000, at most 55000). Use -1 to return immediately without waiting.' },
        raw,
      },
      required: ['session', 'command'],
    },
    async run(ctx, a) {
      const timeout = typeof a.timeout === 'number' ? a.timeout : 30_000;
      // 1.x queued overlapping calls to one session (atc-10).
      const o: Parameters<App['run']>[1] = { session: a.session as string, command: a.command as string, wait: timeout < 0 ? 0 : Math.min(timeout, ctx.app.maxWaitMs), queue: true };
      if (a.cwd !== undefined) o.cwd = a.cwd as string;
      const r = await ctx.app.run(ctx.caller, o);
      if (r.state === 'busy') {
        return json({
          output: '',
          exitCode: -1,
          duration: 0,
          state: 'busy',
          busy: r.busy,
          error: `session ${r.session} is busy${r.busy?.runId ? ` running ${r.busy.runId}` : ''} (${r.busy?.reason}); try again when it is done, or use another session`,
        });
      }
      const output = r.runId ? await runOutput(ctx.app, ctx, r.session, r.runId, a.raw === true) : r.output.text;
      const res: Record<string, unknown> = { output, exitCode: r.state === 'exited' ? (r.exit ?? -1) : -1, duration: r.durationMs ?? 0, runId: r.runId, state: r.state };
      if (r.state === 'running' || r.state === 'starting' || r.state === 'queued') res.note = `still running (it was not interrupted): await {"runId": "${r.runId}"} gets its exit code; tailLogs shows its output`;
      if (r.state === 'lost' && r.reason) res.note = `outcome unknown: ${r.reason}`;
      const out = json(res);
      if (r.runId !== undefined && (r.state === 'exited' || r.state === 'cancelled' || r.state === 'lost')) out.onSent = () => ctx.app.outcomeSent(ctx.caller, r);
      return out;
    },
  },
  {
    name: 'listSessions',
    tier: 'compat',
    description: 'List all active sessions',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      return json(
        ctx.app.sessionList(ctx.caller).map((s) => ({
          id: s.id,
          pid: s.pid ?? null,
          startTime: s.createdAt ? new Date(s.createdAt).toISOString() : null,
          isAlive: s.state !== 'exited',
        })),
      );
    },
  },
  {
    name: 'tailLogs',
    tier: 'compat',
    description: 'Get recent logs from a session',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, lines: { type: 'number', description: 'How many lines (default 50, at most 10000)' }, raw },
      required: ['session'],
    },
    async run(ctx, a) {
      const asked = typeof a.lines === 'number' && a.lines > 0 ? Math.floor(a.lines) : 50;
      const lines = await lastLines(ctx.app, ctx, a.session as string, Math.min(asked, 10_000), a.raw === true);
      if (asked > 10_000) lines.unshift(`[tailLogs returns at most 10000 lines; ${asked} were asked]`);
      return json(lines);
    },
  },
  {
    name: 'sendInput',
    tier: 'compat',
    description:
      'Send input to an interactive session. Text is sent verbatim; use `keys` for special keys (Enter, Ctrl+C, arrows, ...) since raw control characters cannot pass through the JSON layer.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        input: { type: 'string', description: 'Literal text to type (can be empty when only sending keys)' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Named keys sent after the text, tmux send-keys style: Enter, Tab, Shift-Tab, Esc, Space, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12, C-a..C-z (Ctrl), M-<char> (Alt). E.g. ["Enter"] to submit in a TUI, ["C-c"] for Ctrl+C, ["Esc"] to dismiss.',
        },
        appendNewline: { type: 'boolean', description: 'Append Enter (\\r) after input. Default: true when `keys` is absent, false when `keys` is given.' },
      },
      required: ['session', 'input'],
    },
    async run(ctx, a) {
      const keys = Array.isArray(a.keys) ? (a.keys as string[]) : [];
      const newline = typeof a.appendNewline === 'boolean' ? a.appendNewline : keys.length === 0;
      try {
        await ctx.app.input(ctx.caller, { session: a.session as string, text: (a.input as string) ?? '', keys: newline ? [...keys, 'Enter'] : keys });
        return json({ success: true });
      } catch (e) {
        return json({ success: false, error: compatWords((e as Error).message) });
      }
    },
  },
  {
    name: 'sendSignal',
    tier: 'compat',
    description: 'Send a signal to a session (e.g., SIGINT for Ctrl+C)',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, signal: { type: 'string', description: 'Signal to send (default: SIGINT)' } }, required: ['session'] },
    async run(ctx, a) {
      try {
        await ctx.app.signal(ctx.caller, { session: a.session as string, signal: (a.signal as string) ?? 'SIGINT' });
        return json({ success: true });
      } catch (e) {
        return json({ success: false, error: compatWords((e as Error).message) });
      }
    },
  },
  {
    name: 'killSession',
    tier: 'compat',
    description: 'Kill a specific session',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, graceful: { type: 'boolean', description: 'If false, force kills immediately. Default true for graceful shutdown with 3s timeout' } },
      required: ['session'],
    },
    async run(ctx, a) {
      try {
        await ctx.app.sessionClose(ctx.caller, { session: a.session as string, force: a.graceful === false });
        return json({ success: true, message: a.graceful === false ? 'Session forcefully terminated' : 'Session terminated gracefully' });
      } catch (e) {
        return json({ success: false, message: compatWords((e as Error).message) });
      }
    },
  },
  {
    name: 'killAll',
    tier: 'compat',
    description: 'Kill all active sessions',
    inputSchema: { type: 'object', properties: { graceful: { type: 'boolean', description: 'If false, force kills immediately. Default true for graceful shutdown with 3s timeout' } } },
    async run(ctx, a) {
      const failed: string[] = [];
      for (const s of ctx.app.sessionList(ctx.caller)) {
        if (s.state === 'exited') continue;
        try {
          await ctx.app.sessionClose(ctx.caller, { session: s.id, force: a.graceful === false });
        } catch {
          failed.push(s.id);
        }
      }
      return json({
        success: failed.length === 0,
        message: failed.length ? `could not close: ${failed.join(', ')}` : a.graceful === false ? 'All sessions forcefully terminated' : 'All sessions terminated gracefully',
      });
    },
  },
  {
    name: 'searchLogs',
    tier: 'compat',
    description: 'Search for patterns in session logs',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to search in' },
        pattern: { type: 'string', description: 'Pattern to search for (regex supported)' },
        context: { type: 'number', description: 'Number of context lines to show (default: 3)' },
        raw,
      },
      required: ['session', 'pattern'],
    },
    async run(ctx, a) {
      const context = typeof a.context === 'number' && a.context >= 0 ? Math.floor(a.context) : 3;
      // 1.x searched case-insensitively, up to 100 matches (atc-9).
      const r = await ctx.app.search(ctx.caller, { session: a.session as string, pattern: a.pattern as string, flags: 'i', context, limit: 100 });
      return json(r.matches.map((m) => ({ lineNumber: m.lineNumber, line: m.line, context: [...m.before, m.line, ...m.after], seq: m.seq })));
    },
  },
  {
    name: 'takeScreenshot',
    tier: 'compat',
    description: "The terminal session's current screen (as text in this release; image snapshots return in a later one)",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to screenshot' },
        lines: { type: 'number' },
        outputPath: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['session'],
    },
    async run(ctx, a) {
      try {
        const s = await ctx.app.screen(ctx.caller, { session: a.session as string });
        const text = s.lines.join('\n').replace(/\n+$/, '');
        return { text, structured: { success: true, text, cols: s.cols, rows: s.rows, alt: s.alt, cursor: s.cursor } };
      } catch (e) {
        if (e instanceof TermError) return json({ success: false, error: e.message });
        throw e;
      }
    },
  },
];
