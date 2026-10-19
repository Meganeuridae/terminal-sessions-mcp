/**
 * The compatibility pack (§11): the 1.x tool names and result shapes, mapped
 * onto the application API for one release so existing recipes keep working.
 * Served as the `compat` profile (the `terminal-sessions-mcp` bin's default),
 * with `await`, `read` and `session_declare_shell` beside them; never mixed into
 * the core or full profiles. Where an old shape could not tell the truth, the
 * result adds to it: runCommand carries `runId` and `state`, launch the
 * service's status and evidence, listSessions the session's state.
 */
import { TermError } from '../core/errors.js';
import { compileUserRegex } from '../core/regex.js';
import { countLines, cutTail, utf8Length } from '../core/text.js';
import { project, type ProjectChunk } from '../core/transcript.js';
import type { JournalEvent, Seq, ServiceStatus } from '../core/types.js';
import { commitReadDelivery, type App, type SessionSummary } from './app.js';
import { looksLikeShellOpener } from './hints.js';
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** The session's summary, when the caller may see it. */
const summaryOf = (ctx: ToolContext, session: string): SessionSummary | undefined => ctx.app.sessionList(ctx.caller).find((s) => s.id === session);

/** The most output a compat result carries (UTF-8 bytes): 1.x returned all of it; this keeps the tail beyond a bound, visibly. */
const COMPAT_OUTPUT_BYTES = 1024 * 1024;

/**
 * A Run's whole output, paged through `read` (text, or raw events), keeping the last
 * COMPAT_OUTPUT_BYTES with a visible marker when more was cut (er-14, atc-11). The bound
 * is counted in bytes, as the reader counts, not in UTF-16 units (the house's read of 1cabc6a, #22).
 */
async function runOutput(ctx: ToolContext, session: string, runId: string, raw: boolean): Promise<string> {
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
    const r = await ctx.app.read(ctx.caller, o);
    const text = raw ? (r.events ?? []).filter((e) => e.type === 'output').map((e) => (e as { data: string }).data).join('') : (r.text ?? '') + (r.text && !r.splitLine && r.more ? '\n' : '');
    parts.push(text);
    bytes += utf8Length(text);
    while (bytes > COMPAT_OUTPUT_BYTES && parts.length > 1) {
      bytes -= utf8Length(parts.shift()!);
      cut = true;
    }
    if (!r.more || (r.nextCursor === since && r.nextOffset === offset)) break;
    since = r.nextCursor;
    offset = r.nextOffset;
  }
  const out = parts.join('');
  // The Run's earlier output is paged by `read` with its runId (served in this profile), not by tailLogs, which reads the session's end.
  return cut ? `[… earlier output omitted: read {"runId": "${runId}"} pages all of it]\n${cutTail(out, COMPAT_OUTPUT_BYTES).text}` : out;
}

/**
 * The daemon's own typed line as the shell echoes it (Session.sourceLine): ` . '<dir>/tsm-cmd-N'`,
 * `command . '…'` with the chained exit echo under the marker strategy, fish's
 * `eval (__tsm_collect '…' $status)`, and the marker that strategy prints. 1.x kept these out of
 * its logs and logged `$ <command>` in their place (the house's read of 1cabc6a, #22).
 */
const PLUMBING = /(?:command )?\. '(?:[^'\n]|'\\'')*\/tsm-cmd-\d+'(?:; echo "<<<EXI""T:[0-9a-f]+:\$\?>>>")?|eval \(__tsm_collect '(?:[^'\n]|'\\'')*\/tsm-cmd-\d+' \$status\)|<<<EXIT:[0-9a-f]+:\d+>>>/g;

/** A log line without the plumbing; null when nothing else was on it (a soft wrap can leave part of a long echo). */
function withoutPlumbing(line: string): string | null {
  const kept = line.replace(PLUMBING, '');
  if (kept === line) return line;
  return kept.trim().length ? kept.trimEnd() : null;
}

/** Log lines with the plumbing removed; a line that held nothing else is dropped. */
const withoutPlumbingLines = (lines: string[]): string[] =>
  lines.flatMap((l) => {
    const k = withoutPlumbing(l);
    return k === null ? [] : [k];
  });


/** The most output the compat tail reads back for its lines: the last 1 MiB. */
const TAIL_BYTES = 1024 * 1024;

/**
 * The session's last events, oldest first: enough output for `n` lines and a screenful of redraw,
 * paged backwards by `until`, within TAIL_BYTES. `cut` names the oldest event read when older
 * output exists beyond the bound. (A line count, where the reader's event tail counted events —
 * the house's read of 1cabc6a, #22.)
 */
async function tailEvents(ctx: ToolContext, session: string, n: number, rows: number): Promise<{ events: JournalEvent[]; cut?: Seq }> {
  const pages: JournalEvent[][] = [];
  let until: Seq | undefined;
  let lineEnds = 0;
  let bytes = 0;
  for (let page = 0; page < 64; page++) {
    const o: Parameters<App['read']>[1] = { session, tail: 2000, as: 'events' };
    if (until !== undefined) o.until = until;
    const r = await ctx.app.read(ctx.caller, o);
    const ev = r.events ?? [];
    if (ev.length === 0) break;
    pages.push(ev);
    for (const e of ev) {
      if (e.type !== 'output') continue;
      lineEnds += countLines(e.data);
      bytes += utf8Length(e.data);
    }
    const first = ev[0]!.seq;
    const older = r.oldestSeq !== undefined && first > r.oldestSeq;
    if (!older || lineEnds >= n + 2 * rows + 1) break;
    if (bytes >= TAIL_BYTES) return { events: pages.reverse().flat(), cut: first };
    until = first - 1;
  }
  return { events: pages.reverse().flat() };
}

/**
 * The last `n` lines of a session as 1.x logged them: `$ <command>` where each Run started,
 * the shell's plumbing removed, the rest projected as the terminal showed it (or raw, with its
 * escape codes, when asked).
 */
async function tailLines(ctx: ToolContext, session: string, n: number, raw: boolean): Promise<{ lines: string[]; cut?: Seq }> {
  const s = summaryOf(ctx, session);
  const cols = s?.cols ?? 120;
  const rows = s?.rows ?? 30;
  const { events, cut } = await tailEvents(ctx, session, n, rows);
  const res = (lines: string[]) => (cut !== undefined ? { lines: lines.slice(-n), cut } : { lines: lines.slice(-n) });
  if (raw) {
    let text = '';
    for (const e of events) {
      if (e.type === 'output') text += e.data;
      else if (e.type === 'run.start' && e.line !== undefined) text += `${text === '' || text.endsWith('\n') ? '' : '\n'}$ ${e.line}\n`;
    }
    return res(withoutPlumbingLines(text.split(/\r?\n/)));
  }
  const chunks: ProjectChunk[] = [];
  for (const e of events) {
    if (e.type === 'output') chunks.push({ data: e.data, stream: e.stream, ...(e.runId !== undefined ? { runId: e.runId } : {}) });
    else if (e.type === 'run.start' && e.line !== undefined) chunks.push({ note: `$ ${e.line}` });
  }
  // Lines the plumbing filter removes (about one per Run) come out of the slack above n.
  const p = await project(chunks, { cols, rows, keep: 'tail', maxLines: Math.min(2 * n + 50, 20_000), maxInputBytes: TAIL_BYTES });
  return res(withoutPlumbingLines(p.text === '' ? [] : p.text.split('\n')));
}

/** 1.x's launch statuses from a service's. */
const launchStatus = (s: ServiceStatus | undefined): 'ready' | 'running' | 'error' => (s === 'ready' ? 'ready' : s === 'starting' || s === 'running' ? 'running' : 'error');

/** The service's status from the session summary, looked at every 200 ms until it leaves `running`/`starting` or the deadline passes. */
async function pollService(ctx: ToolContext, session: string, runId: string, deadline: number): Promise<{ status: ServiceStatus; evidence?: string } | undefined> {
  let last: { status: ServiceStatus; evidence?: string } | undefined;
  while (Date.now() < deadline) {
    await sleep(200);
    const svc = summaryOf(ctx, session)?.services?.find((v) => v.runId === runId);
    if (!svc) return last;
    last = svc;
    if (svc.status !== 'running' && svc.status !== 'starting') return svc;
  }
  return last;
}

/**
 * The Run occupying the session's own shell, when its line reads like one that opened another
 * shell and none is declared (a hint, never evidence, §8.1): a command queued behind it would
 * run in the session's own shell once it ends, where 1.x typed it into the shell in front
 * (the house's read of 1cabc6a, #22).
 */
function shellOpenerInFront(s: SessionSummary | undefined): { runId: string; line?: string } | undefined {
  if (!s || s.declared || s.state === 'exited') return undefined;
  const front = s.runs?.find((r) => r.runId === s.currentRun);
  return front && front.target === 'shell' && front.state === 'running' && looksLikeShellOpener(front.line) ? front : undefined;
}

/** What to do about a busy session, in this profile's words (the core's BUSY_NEXT says the same with its own tool names). */
const BUSY_NEXT: Record<string, string> = {
  exited: "the session's shell has exited: runCommand again starts a new one",
  'shell-unavailable':
    "the session's shell was replaced by a program without integration: if that program is a shell, declare it with session_declare_shell and call runCommand again; sendInput and takeScreenshot work regardless, or use another session",
  'declared-shell-ended':
    'the declared shell (ssh, sudo -i, a nested shell) ended without your asking — the connection dropped, or that shell died — so this command would have run in the shell underneath, not where you meant it: call runCommand again if the session’s own shell is what you mean, or run the opener and declare again',
};

const SCREEN_TEXT_ONLY = 'this release returns the screen as text, not an image: no file was written';

export const COMPAT_TOOLS: ToolDef[] = [
  {
    name: 'launch',
    tier: 'compat',
    description:
      'Launch a process and optionally wait for readiness patterns in its output. Use runCommand for commands that finish on their own. ' +
      'With errorPatterns only, the output is watched 15 s for them (status "error" when one appears); with neither, status "running" after 2 s alive.',
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
      const began = Date.now();
      // 1.x launched into a fresh session in `cwd`; into an existing one, change there first (atc-22). The command
      // goes in a group of its own, so a `&` or `;` in it cannot split it from the cd and run in the old directory;
      // the newline before the closing brace keeps a trailing `&` or comment from taking it (the house's read of 1cabc6a, #22).
      const exists = summaryOf(ctx, name)?.state !== undefined && summaryOf(ctx, name)?.state !== 'exited';
      const command = exists && typeof a.cwd === 'string' ? `cd -- ${shq(a.cwd)} && {\n${a.command as string}\n}` : (a.command as string);
      // Without patterns 1.x waited 2 s and said `running`: wait just past the 2 s liveness window (atc-7).
      const o: Parameters<App['start']>[1] = { session: name, command, name, wait: ready || fail ? 30_000 : 2_500 };
      if (a.cwd !== undefined && !exists) o.cwd = a.cwd as string;
      if (ready) o.ready = { pattern: ready };
      if (fail) o.fail = { pattern: fail };
      try {
        const r = await ctx.app.start(ctx.caller, o);
        if (r.state === 'busy') {
          const b = r.busy;
          return json({ status: 'error', logs: [`Failed to start service: session ${name} is busy${b?.runId ? ` running ${b.runId}${b.line ? ` (${b.line})` : ''}` : ''} (${b?.reason ?? 'busy'}); killSession it first, or use another name`], sessionId: name });
        }
        let service = r.service;
        let evidence = r.evidence;
        if (fail && !ready && r.runId !== undefined && launchStatus(service) === 'running') {
          // A fail probe alone is no readiness probe, so the service settles at `running` after the liveness
          // window; 1.x went on watching the output for the error patterns, 15 s in all, and answered
          // `error` when one appeared (the house's read of 1cabc6a, #22).
          const later = await pollService(ctx, name, r.runId, began + 15_000);
          if (later) {
            service = later.status;
            evidence = later.evidence;
          }
        }
        const res: Record<string, unknown> = { status: launchStatus(service), logs: (await tailLines(ctx, name, 50, a.raw === true)).lines, sessionId: name, runId: r.runId, service };
        if (evidence !== undefined) res.evidence = evidence;
        return json(res);
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
      'Waits at most 55 s: a longer command returns state "running" with its runId — `await {"runId": …}` gets its exit code later, tailLogs shows its progress. ' +
      'When a command opened another shell — `ssh host`, `sudo -i`, `docker exec -it … bash`, a nested `bash` — declare it once with session_declare_shell {"session": …}: ' +
      'runCommand then goes to that shell (output and exit code as usual) until that command ends. Without the declaration, a command is not queued behind one that looks like it opened a shell: the result says so and nothing runs.',
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
      const session = a.session as string;
      const timeout = typeof a.timeout === 'number' ? a.timeout : 30_000;
      // 1.x queued overlapping calls to one session (atc-10): the next command was typed in behind the running one, so one
      // sent while `ssh host` ran reached the remote shell. A Run queued here runs in the session's own shell once the
      // running command ends; when that command reads like one that opened a shell, nothing is queued and the result says
      // to declare it (the house's read of 1cabc6a, #22).
      const opener = shellOpenerInFront(summaryOf(ctx, session));
      const o: Parameters<App['run']>[1] = { session, command: a.command as string, wait: timeout < 0 ? 0 : Math.min(timeout, ctx.app.maxWaitMs), queue: opener === undefined };
      if (a.cwd !== undefined) o.cwd = a.cwd as string;
      const r = await ctx.app.run(ctx.caller, o);
      if (r.state === 'busy') {
        const b = r.busy;
        const error = opener
          ? `session ${session} is running ${opener.runId} (${opener.line ?? ''}), which looks like a command that opened another shell; nothing was run, since a command queued behind it would run in the session's own shell once it ends, not in that one. ` +
            `If it is a shell (ssh, sudo -i, a nested shell), declare it once with session_declare_shell {"session": "${session}"} and call runCommand again: commands then go to that shell, with their output and exit code. ` +
            `To run after it ends instead, await {"runId": "${opener.runId}"} first.`
          : `session ${r.session} is busy${b?.runId ? ` running ${b.runId}` : ''} (${b?.reason ?? 'busy'}); nothing was run: ${BUSY_NEXT[b?.reason ?? ''] ?? 'try again when it is done, or use another session'}`;
        return json({ output: '', exitCode: -1, duration: 0, state: 'busy', busy: r.busy, error });
      }
      const output = r.runId ? await runOutput(ctx, r.session, r.runId, a.raw === true) : r.output.text;
      const res: Record<string, unknown> = { output, exitCode: r.state === 'exited' ? (r.exit ?? -1) : -1, duration: r.durationMs ?? 0, runId: r.runId, state: r.state };
      if (r.shell !== undefined) {
        res.shell = r.shell;
        res.within = r.within ?? null;
      }
      if (r.state === 'running' || r.state === 'starting') {
        // A hint, never evidence (§8.1): the line reads like one that opens another shell.
        const opened = r.shell === undefined && looksLikeShellOpener(r.line) ? `. If it opened a shell (it looks like it did), declare that with session_declare_shell {"session": "${r.session}"} before the next runCommand: commands then go to that shell instead of waiting behind it` : '';
        res.note = `still running (it was not interrupted): await {"runId": "${r.runId}"} gets its exit code; tailLogs shows its output${opened}`;
      }
      if (r.state === 'queued') res.note = `queued behind the running command: it runs in the session's own shell when that ends; await {"runId": "${r.runId}"} gets its exit code`;
      if (r.state === 'lost' && r.reason) res.note = `outcome unknown: ${r.reason}`;
      const out = json(res);
      out.onSent = () => {
        if (r.runId !== undefined && (r.state === 'exited' || r.state === 'cancelled' || r.state === 'lost')) ctx.app.outcomeSent(ctx.caller, r);
        commitReadDelivery(r);
      };
      return out;
    },
  },
  {
    name: 'listSessions',
    tier: 'compat',
    description: 'List all sessions: id, name (the service name when launched), isAlive, createdAt, lastActivity, logSize (retained journal events), state, and the service status when it has one.',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      // 1.x's shape (its own comment says pid and startTime never existed server-side) — the house's read of 1cabc6a, #22.
      return json(
        ctx.app.sessionList(ctx.caller).map((s) => {
          const svc = s.services?.[s.services.length - 1];
          const o: Record<string, unknown> = {
            id: s.id,
            name: svc?.name ?? s.id,
            isAlive: s.state !== 'exited',
            createdAt: iso(s.createdAt),
            lastActivity: iso(s.lastActivity),
            logSize: s.oldestSeq !== undefined ? s.lastSeq - s.oldestSeq + 1 : s.lastSeq,
            state: s.state,
          };
          if (svc) o.service = svc.status;
          return o;
        }),
      );
    },
  },
  {
    name: 'tailLogs',
    tier: 'compat',
    description: 'Get recent logs from a session: its last lines, with `$ <command>` where each command was issued. Earlier output of one command: read {"runId": …}.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, lines: { type: 'number', description: 'How many lines (default 50, at most 10000)' }, raw },
      required: ['session'],
    },
    async run(ctx, a) {
      const session = a.session as string;
      const asked = typeof a.lines === 'number' && a.lines > 0 ? Math.floor(a.lines) : 50;
      const n = Math.min(asked, 10_000);
      const { lines, cut } = await tailLines(ctx, session, n, a.raw === true);
      if (cut !== undefined) lines.unshift(`[earlier output not shown: these lines come from the last 1 MiB; read {"session": "${session}", "tail": ${n}, "until": ${cut - 1}} shows what came before]`);
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
    description: 'Kill a specific session and forget it: it leaves listSessions, and its logs go with it (as in 1.x).',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, graceful: { type: 'boolean', description: 'If false, force kills immediately. Default true for graceful shutdown with 3s timeout' } },
      required: ['session'],
    },
    async run(ctx, a) {
      try {
        // 1.x deleted the session; a kept history entry made a kill-until-empty loop endless (the house's read of 1cabc6a, #22).
        await ctx.app.sessionClose(ctx.caller, { session: a.session as string, force: a.graceful === false, forget: true });
        return json({ success: true, message: a.graceful === false ? 'Session forcefully terminated' : 'Session terminated gracefully' });
      } catch (e) {
        return json({ success: false, message: compatWords((e as Error).message) });
      }
    },
  },
  {
    name: 'killAll',
    tier: 'compat',
    description: 'Kill all sessions and forget them (as in 1.x: listSessions is empty afterwards).',
    inputSchema: { type: 'object', properties: { graceful: { type: 'boolean', description: 'If false, force kills immediately. Default true for graceful shutdown with 3s timeout' } } },
    async run(ctx, a) {
      // All at once, as 1.x did: one graceful close may take its 3 s (the house's read of 1cabc6a, #22).
      const ids = ctx.app.sessionList(ctx.caller).map((s) => s.id);
      const results = await Promise.allSettled(ids.map((id) => ctx.app.sessionClose(ctx.caller, { session: id, force: a.graceful === false, forget: true })));
      const failed = ids.filter((_, i) => results[i]!.status === 'rejected');
      return json({
        success: failed.length === 0,
        message: failed.length ? `could not close: ${failed.join(', ')}` : a.graceful === false ? 'All sessions forcefully terminated' : 'All sessions terminated gracefully',
      });
    },
  },
  {
    name: 'searchLogs',
    tier: 'compat',
    description: 'Search for patterns in session logs (the last 50,000 journal events; a trailing note says when older output or more matches exist).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to search in' },
        pattern: { type: 'string', description: 'Pattern to search for (regex supported)' },
        context: { type: 'number', description: 'Number of context lines to show (default: 3)' },
        raw: { type: 'boolean', description: 'Ignored: matched lines are always clean text here' },
      },
      required: ['session', 'pattern'],
    },
    async run(ctx, a) {
      const session = a.session as string;
      const context = typeof a.context === 'number' && a.context >= 0 ? Math.floor(a.context) : 3;
      // 1.x searched case-insensitively, up to 100 matches (atc-9).
      const r = await ctx.app.search(ctx.caller, { session, pattern: a.pattern as string, flags: 'i', context, limit: 100 });
      const re = compileUserRegex(a.pattern as string, 'i');
      const out: Array<Record<string, unknown>> = [];
      for (const m of r.matches) {
        // A match inside the daemon's own plumbing is not one 1.x would have shown (the house's read of 1cabc6a, #22):
        // the line is kept when what remains of it still matches.
        const line = withoutPlumbing(m.line);
        if (line === null || (line !== m.line && !re.test(line))) continue;
        out.push({ lineNumber: m.lineNumber, line, context: withoutPlumbingLines([...m.before, m.line, ...m.after]), seq: m.seq });
      }
      const notes: string[] = [];
      if (r.bounded) notes.push(`older output was not searched (the search covers the last 50,000 journal events); read {"session": "${session}", "tail": 200, "until": ${r.scanned[0] - 1}} shows what came before`);
      if (r.more) notes.push(`more matches exist (stopped by ${r.stoppedBy ?? 'the 100-match limit'})`);
      if (notes.length) out.push({ note: notes.join('; ') });
      return json(out);
    },
  },
  {
    name: 'takeScreenshot',
    tier: 'compat',
    description: `The terminal session's current screen as text (${SCREEN_TEXT_ONLY}; image snapshots return in a later release). outputPath is refused, width and height are ignored.`,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to screenshot' },
        lines: { type: 'number' },
        outputPath: { type: 'string', description: 'Refused in this release: no image file is written' },
        width: { type: 'number', description: 'Ignored' },
        height: { type: 'number', description: 'Ignored' },
      },
      required: ['session'],
    },
    async run(ctx, a) {
      try {
        const s = await ctx.app.screen(ctx.caller, { session: a.session as string });
        const text = s.lines.join('\n').replace(/\n+$/, '');
        const structured = { success: true, text, cols: s.cols, rows: s.rows, alt: s.alt, cursor: s.cursor };
        // 1.x wrote a PNG there; a `success: true` without the file would be a lie (the house's read of 1cabc6a, #22).
        if (typeof a.outputPath === 'string') return json({ success: false, error: `outputPath ${a.outputPath}: ${SCREEN_TEXT_ONLY}; call again without outputPath for the text`, text });
        // In json mode the text is the envelope, as for every other tool (the house's read of 1cabc6a, #22).
        // The read cursor advances once this reaches the caller (G22; the house's read of 1cabc6a, #22).
        return { text: ctx.resultText === 'json' ? JSON.stringify(structured, null, 2) : text, structured, onSent: () => commitReadDelivery(s) };
      } catch (e) {
        if (e instanceof TermError) return json({ success: false, error: e.message });
        throw e;
      }
    },
  },
];
