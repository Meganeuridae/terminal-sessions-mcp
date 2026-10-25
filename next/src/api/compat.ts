/**
 * The compatibility pack (§11): the 1.x tool names and result shapes, mapped
 * onto the application API for one release so existing recipes keep working.
 * Served as the `compat` profile (in this landing the `terminal-sessions-mcp` bin
 * runs 1.x itself; only the shim, when invoked under that name, defaults to compat),
 * with `await`, `read` and `session_declare_shell` beside them; never mixed into
 * the core or full profiles. Where an old shape could not tell the truth, the
 * result adds to it: runCommand carries `runId` and `state`, launch the
 * service's status and evidence, listSessions the session's state.
 */
import { clocks } from '../core/clock.js';
import { TermError } from '../core/errors.js';
import { compileUserRegex } from '../core/regex.js';
import { ackMark, exitMark, goneMark, inlineTypedLine, nonceOf, probeAnswerMark, probeEcho, shellQuote, sourceLineEcho, startMark } from '../core/plumbing.js';
import { countLines, cutTail, utf8Length } from '../core/text.js';
import { keepLines as tailOfLines } from '../core/transcript.js';
import { DEFAULT_GEOMETRY, type JournalEvent, type Seq, type ServiceStatus } from '../core/types.js';
import { commitReadDelivery, takeReadCommit, type App, type ReadResult, type SessionSummary } from './app.js';
import { looksLikeShellOpener } from './hints.js';
import { clippedText, gapNote, gapsText, isSourceHeader } from './reader.js';
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


const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** The session's summary, when the caller may see it. */
const summaryOf = (ctx: ToolContext, session: string): SessionSummary | undefined => ctx.app.sessionList(ctx.caller).find((s) => s.id === session);

/** The most output a compat result carries (UTF-8 bytes): 1.x returned all of it; this keeps the tail beyond a bound, visibly. */
const COMPAT_OUTPUT_BYTES = 1024 * 1024;

/**
 * The commits of the App results a compat tool drew from beyond the one it answers with. Each
 * result staged its caller's read-cursor advance for delivery (App.advanceRead, G22); the tool's
 * own result carries the commit for all of them, which the transport runs once that result is
 * written. Without it a compat host's cursor stayed behind what tailLogs, launch and a paged output
 * had shown it (a review of the consolidated branch). Only the commits are kept, never the results:
 * a paged output lets its older pages' text go, and this must not hold it (the house's read of
 * 78c4d6e, #22).
 */
class Drawn {
  private readonly commits: Array<() => void> = [];
  track<T>(r: T): T {
    const commit = takeReadCommit(r);
    if (commit) this.commits.push(commit);
    return r;
  }
  /** The tool's result, carrying the commits (after `also`, when given). */
  sent(res: ToolResult, also?: () => void): ToolResult {
    const prior = res.onSent;
    res.onSent = () => {
      also?.();
      prior?.();
      for (const commit of this.commits) commit();
    };
    return res;
  }
}

/**
 * A read whose content forms the tool's answer carries its commit in `d`. An incidental
 * preview beside another answer (such as launch's bounded tail, with `d` null) uses
 * `advance: false`: reading from the journal does not mark output the caller did not explicitly
 * request. Launch also discards the start result's commit because it returns only status and a
 * bounded preview (the house's read of 78c4d6e, #22; comment 6270045466).
 */
async function readFor(ctx: ToolContext, d: Drawn | null, o: Parameters<App['read']>[1]): Promise<ReadResult> {
  if (d) return d.track(await ctx.app.read(ctx.caller, o));
  return ctx.app.read(ctx.caller, { ...o, advance: false });
}

/**
 * The marker a Run's output cut to its last COMPAT_OUTPUT_BYTES begins with: its earlier output is paged by `read`
 * with its session and runId (served in this profile), not by tailLogs, which reads the session's end. The read
 * requires its session: advised without it, the call was refused (our read of the 40 commits, PR #22).
 */
const omitted = (session: string, runId: string, text: string): string => `[… earlier output omitted: read ${callArgs({ session, runId })} pages all of it]\n${cutTail(text, COMPAT_OUTPUT_BYTES).text}`;

/**
 * A Run's whole output, paged through `read` (text, or raw events), keeping the last
 * COMPAT_OUTPUT_BYTES with a visible marker when more was cut (er-14, atc-11). The bound
 * is counted in bytes, as the reader counts, not in UTF-16 units (the house's read of 1cabc6a, #22).
 * Text and raw alike, a shell Run's pages come with the daemon's plumbing cut by the reader.
 */
async function runOutput(ctx: ToolContext, session: string, runId: string, raw: boolean, d: Drawn): Promise<string> {
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
      o.as = 'raw';
      o.limit = 2000;
    }
    const r = await readFor(ctx, d, o);
    const text = raw ? (r.text ?? '') : (r.text ?? '') + (r.text && !r.splitLine && r.more ? '\n' : '');
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
  return cut ? omitted(session, runId, out) : out;
}


/**
 * The daemon's own typed lines as the shell echoes them: the line that runs a Run's command file
 * (plumbing.ts sourceLineEcho, from the session's own builder, the marker strategy's chained end
 * mark included), the lines typed for a declared shell's body (inlineTypedLine), and the marks both
 * strategies print, from the core's grammar. The probe lines typed after a ^C are struck by the
 * cutter's own matcher (keptLines). 1.x kept these out of its logs and logged `$ <command>` in their
 * place (the house's read of 1cabc6a, #22). The inline strategy's body, its start mark and its
 * pieces' marks reached the logs while this held a copy of the marker strategy's shapes alone, and
 * that copy had no line for fish's marker strategy (a reviewer's read of the fixes for #22).
 */
const PLUMBING = new RegExp([sourceLineEcho(), inlineTypedLine(), startMark(), exitMark(), probeAnswerMark(), ackMark(), goneMark()].map((re) => re.source).join('|'), 'g');

/**
 * What tells the daemon's plumbing from a program's in a stretch of the session's text: the nonces
 * the Runs there recorded in their run.start, and whether a Run there predates the recording, whose
 * marks are found by shape, as the core cuts them (App.runPlumbing). A line in a mark's shape that
 * carries no Run's nonce is a program's, and stays (the house's read of 78c4d6e, #22).
 */
interface Plumbing {
  /** Each Run's nonce, with the lines its `$ <line>` heading takes in the text (its line's lines). */
  nonces: Map<string, number>;
  byShape: boolean;
}

function plumbingIn(ctx: ToolContext, session: string, from: Seq, to: Seq): Plumbing {
  const runs = ctx.app.runPlumbing(ctx.caller, { session, from, to });
  return {
    nonces: new Map(runs.flatMap((r) => (r.nonce === undefined ? [] : [[r.nonce, countLines(r.line ?? '') + 1] as const]))),
    byShape: runs.some((r) => r.nonce === undefined && r.strategy !== 'rich' && r.strategy !== 'basic'),
  };
}

/** A log line without the plumbing; null when nothing else was on it (a soft wrap can leave part of a long echo). */
function withoutPlumbing(line: string, p: Plumbing): string | null {
  // The typed line is the daemon's whatever it carries (it names the command file); a printed mark is cut by whose nonce it bears.
  const kept = line.replace(PLUMBING, (m) => {
    const nonce = nonceOf(m);
    return nonce === undefined || p.byShape || p.nonces.has(nonce) ? '' : m;
  });
  if (kept === line) return line;
  return kept.trim().length ? kept.trimEnd() : null;
}

const START = startMark();
/** Any Run's probe line echo, built once (matchAll copies it, so its lastIndex is never shared). */
const PROBE_ECHO = probeEcho();
/**
 * How far below its echo's line a probe's answer can come: on the next line, or under `set -x` after the probe's
 * own trace, two lines in bash and zsh (the pid's command substitution, then the printf) and one in fish, and four
 * in bash's restricted mode, which traces the `exec` it refuses, prints its refusal of the redirect, then traces the
 * fallback's `echo` and the printf (the house's review of bc4bc85..5d8ce0e, PR #22, by run in bash 5.2.37). A
 * search's lines end only where the output's do, never at the terminal's width.
 */
const PROBE_ANSWER_LINES = 5;

/**
 * The lines a probe line's echo spans, by index in `lines`, each with the length of its head that stays: found by
 * the cutter's own matcher (plumbing.ts probeEcho), a redraw's breaks included, a break inside the nonce among
 * them, whatever nonce the typed line carries, as any typed line is the daemon's, and struck as cutPlumbing strikes
 * them. A probe a shell answered goes with its lines whole, the shell's prompt on its first with it; one nothing
 * answered goes from its own start (and the space before it), and the head of its first line stays, since a program
 * read it after whatever it had printed there: struck whole, a program's `Continue? [y/N] ` went with it, which the
 * cutter keeps (an independent read of the fixes for the review of the 40 commits, PR #22). A head of 0 is the line
 * struck whole. An answer counts when it is in `lines`: until the text read holds it (not yet in the journal, or past
 * a page's bound), the echo's head stays, and a later read that holds it strikes the line whole; a caller judging one
 * line passes the lines after it too (searchLogs).
 */
function probeLines(lines: string[]): Map<number, number> {
  const struck = new Map<number, number>();
  const text = lines.join('\n');
  if (!text.includes('<')) return struck;
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const echoes = [...text.matchAll(PROBE_ECHO)];
  echoes.forEach((m, k) => {
    const first = lineAt(m.index);
    // Answered: the probe's answer, with its nonce when the echo shows it whole, before the next echo.
    const nonce = /PRO(?:""|'')BE:([^:>"\s]+)/.exec(m[0])?.[1];
    const answered = text.slice(m.index + m[0].length, echoes[k + 1]?.index ?? text.length).includes(`<<<PROBE:${nonce ?? ''}`);
    const col = m.index - starts[first]!;
    const head = answered ? 0 : col > 0 && lines[first]![col - 1] === ' ' ? col - 1 : col;
    for (let i = first; i <= lineAt(m.index + m[0].length - 1); i++) struck.set(i, Math.min(struck.get(i) ?? Number.POSITIVE_INFINITY, i === first ? head : 0));
  });
  return struck;
}

/**
 * Log lines with the plumbing removed, each with its index in `lines`; a line that held nothing else
 * is dropped, and so are the lines a probe's echo spans, but for an unanswered probe's first line, whose head before
 * the echo stays (probeLines). A start mark cut takes its
 * line's end with it: the Run starts at the mark (run.start follows it), so the `$ <command>` heading
 * the reader puts there comes before the mark's line ends, and that end showed as an empty line
 * under the heading, which takes as many lines as the Run's line holds: one was assumed, and under a
 * command of two lines the empty line stayed (our read of the house's fixes for its review of
 * f3750e4, PR #22: e8a8d52).
 */
function keptLines(lines: string[], p: Plumbing): Array<[string, number]> {
  const kept: Array<[string, number]> = [];
  const probes = probeLines(lines);
  let markEnd = -1;
  lines.forEach((whole, i) => {
    const head = probes.get(i);
    if (i === markEnd || head === 0) return;
    const l = head === undefined ? whole : whole.slice(0, head);
    const k = withoutPlumbing(l, p);
    if (k !== null) kept.push([k, i]);
    else if (lines[i + 1]?.startsWith('$ ')) {
      const mark = START.exec(l);
      const after = i + 1 + (p.nonces.get(nonceOf(mark?.[0] ?? '') ?? '') ?? 1);
      if (mark && /^\s*$/.test(lines[after] ?? '-')) markEnd = after;
    }
  });
  return kept;
}

/** Log lines with the plumbing removed (keptLines). */
const withoutPlumbingLines = (lines: string[], p: Plumbing): string[] => keptLines(lines, p).map(([l]) => l);

/**
 * The last `n` of `lines` without the plumbing, and the index in `lines` of the first one kept. In a
 * text tail (`headers`), `n` counts lines of output, as the reader's tail does: the lines naming
 * sources come extra (isSourceHeader), with the one naming the first line's source. Counted among
 * them, a tail of 6 across two sources showed 3 lines of output, and the page of what came before,
 * read for the lines from the first kept on, was asked for the headers too, so it reached back that
 * many more lines of output and those between were in neither page (an independent read of the fix
 * for the house's read of the 33 commits, #22, comment 6307350650). The lines are taken by the
 * projection's own rule (transcript.ts keepLines), so the header naming the first line's source is the
 * nearest one before it, wherever it sits, as the reader's tail has it since c050928: kept only when it
 * sat just before, a tail of 2 over a Run's `a1` to `a3` then the pty's `p2` began with `a3`, unnamed
 * (our read of the house's fixes for its review of f3750e4, PR #22). `first` is then the first line
 * after the header, the lines between them being shown in neither.
 */
function keepLines(lines: string[], n: number, p: Plumbing, headers = false): { lines: string[]; first?: number } {
  const kept = keptLines(lines, p);
  const texts = kept.map(([l]) => l);
  const last = tailOfLines(texts, n, 'tail', new Set(headers ? texts.filter(isSourceHeader) : [])) ?? texts;
  if (!last.length) return { lines: [] };
  // A header taken from further back is followed by the end of `kept`; one just before the cut is part of it.
  const from = kept.length - last.length + (last[0] === texts[kept.length - last.length] ? 0 : 1);
  return { lines: last, first: kept[from]![1] };
}

/** Lines of `lines` from `from` on that a text tail counts: all but the lines naming sources. */
const outputLinesFrom = (lines: string[], from: number): number => lines.slice(from).filter((l) => !isSourceHeader(l)).length;

/** The most output the compat tail reads back for its lines: the last 1 MiB. */
const TAIL_BYTES = 1024 * 1024;
/** Pages of events a raw tail reads back at most (each the reader's 2,000 events or TAIL_BYTES). */
const TAIL_PAGES = 64;
/** The most lines a tail returns, and the most it asks the reader for. */
const TAIL_MAX = 10_000;

/**
 * The session's last events for a raw tail, oldest first: output with `need` line ends, paged
 * backwards by `until`, each page within the reader's byte cap, within TAIL_BYTES in all. `cut`
 * names the oldest event read when older output exists beyond a bound: the bytes, or the pages;
 * `older` says whether retained output precedes what was read. (A line count, where the reader's
 * event tail counts events — the house's read of 1cabc6a, #22.)
 */
async function tailEvents(ctx: ToolContext, session: string, need: number, d: Drawn | null): Promise<{ events: JournalEvent[]; cut?: Seq; older: boolean }> {
  const pages: JournalEvent[][] = [];
  let until: Seq | undefined;
  let lineEnds = 0;
  let bytes = 0;
  let older = false;
  for (let page = 0; page < TAIL_PAGES; page++) {
    const o: Parameters<App['read']>[1] = { session, tail: 2000, as: 'events', maxBytes: TAIL_BYTES };
    if (until !== undefined) o.until = until;
    const r = await readFor(ctx, d, o);
    const ev = r.events ?? [];
    if (ev.length === 0) break;
    pages.push(ev);
    for (const e of ev) {
      if (e.type !== 'output') continue;
      lineEnds += countLines(e.data);
      bytes += utf8Length(e.data);
    }
    const first = ev[0]!.seq;
    older = r.oldestSeq !== undefined && first > r.oldestSeq;
    if (!older || lineEnds >= need) break;
    if (bytes >= TAIL_BYTES || page === TAIL_PAGES - 1) return { events: pages.reverse().flat(), cut: first, older };
    until = first - 1;
  }
  return { events: pages.reverse().flat(), older };
}

/**
 * The raw tail's text from its events: output as it was, `$ <line>` where a Run started, and a
 * hole's note where one is, as the clean tail has it (the house's read of 78c4d6e, #22), with where
 * in the text each event begins.
 */
function rawText(events: JournalEvent[]): { text: string; starts: Array<{ seq: Seq; at: number }> } {
  let text = '';
  const starts: Array<{ seq: Seq; at: number }> = [];
  const ownLine = () => (text === '' || text.endsWith('\n') ? '' : '\n');
  for (const e of events) {
    starts.push({ seq: e.seq, at: text.length });
    if (e.type === 'output') text += e.data;
    else if (e.type === 'run.start' && e.line !== undefined) text += `${ownLine()}$ ${e.line}\n`;
    else if (e.type === 'gap') text += `${ownLine()}${gapNote(e)}\n`;
  }
  return { text, starts };
}

/** Where each of `text.split(/\r?\n/)`'s lines begins in `text`. */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (const m of text.matchAll(/\r?\n/g)) offsets.push(m.index + m[0].length);
  return offsets;
}

/**
 * Where a tail was cut. `before` is where a read of what came before ends: right where the first
 * line shown begins (inside its event when it begins there), so the two pages meet with nothing in
 * neither. `cutHead` says the first line shown is missing its head, and `head` is a head-first read
 * that shows it from its head, or, `begunBefore` (the reader's), on from where the page before ends,
 * whose end is the line's earlier part; without `head`, the page before ends with that earlier part
 * (a raw tail's first line begun before what was read). The house's reads of 78c4d6e and of the 38
 * commits, #22.
 */
interface TailCut {
  before: { until: Seq; untilOffset?: number };
  cutHead: boolean;
  begunBefore?: boolean;
  head?: { since: Seq; offset?: number };
  why: string;
}

/** A tail of `n` clean lines asks the reader for more: the plumbing filter removes about one line per Run. */
const tailAsked = (n: number) => Math.min(2 * n + 50, TAIL_MAX);

/**
 * The last `n` lines of a session as 1.x logged them: `$ <command>` where each Run started,
 * the daemon's plumbing removed, the rest projected as the terminal showed it — a `read` of the
 * tail with `commands`, so the cap, the holes and `truncated` are the reader's — or raw, with
 * its escape codes, from the session's last events. The plumbing removed can leave fewer than `n`:
 * then more is read, up to the cap, and a shortfall at the cap is said rather than passed off as
 * all there is (the house's read of 78c4d6e, #22).
 */
async function tailLines(ctx: ToolContext, session: string, n: number, raw: boolean, d: Drawn | null): Promise<{ lines: string[]; cut?: TailCut }> {
  return raw ? rawTail(ctx, session, n, d) : textTail(ctx, session, n, d);
}

async function textTail(ctx: ToolContext, session: string, n: number, d: Drawn | null): Promise<{ lines: string[]; cut?: TailCut }> {
  for (let asked = tailAsked(n); ; asked = Math.min(asked * 2, TAIL_MAX)) {
    const r = await readFor(ctx, d, { session, tail: asked, commands: true, maxBytes: TAIL_BYTES });
    const all = r.text ? r.text.split('\n') : [];
    const kept = keepLines(all, n, plumbingIn(ctx, session, r.seq[0], r.seq[1]), true);
    const short = kept.lines.filter((l) => !isSourceHeader(l)).length < n;
    const full = (r.lines?.returned ?? 0) >= asked;
    // The reader gave every line asked for and the plumbing took too many of them: ask for more.
    if (short && full && !r.truncated && asked < TAIL_MAX) continue;
    // The reader says where what came before its first line ends, and whether that line is whole. When the
    // lines kept begin later (the plumbing took lines ahead of them, or more were read than are shown), the
    // same range is read again from the first line kept on, so the page before ends where that line begins,
    // not at the first line read (the lines between were in neither page; the house's read of the 38
    // commits, #22, comment 6274935728). When that read reaches back to the line written last (more lines
    // than it asked for: ReadResult.lines), its page before ends before that line, so its lines are the ones
    // shown: the line written last was in neither tailLogs nor the page it advised.
    const cut = async (why: string): Promise<{ lines: string[]; cut: TailCut }> => {
      const want = kept.first ? outputLinesFrom(all, kept.first) : 0;
      const from = !kept.first ? r : await readFor(ctx, d, { session, tail: want, until: r.seq[1], commands: true, maxBytes: TAIL_BYTES });
      const c: TailCut = { before: from.lines?.before ?? { until: from.seq[0] - 1 }, cutHead: from.lines?.cutHead === true, why };
      if (from.lines?.head) c.head = from.lines.head;
      if (from.lines?.begunBefore) c.begunBefore = true;
      const reached = from !== r && (from.lines?.returned ?? 0) > want;
      return { lines: reached ? withoutPlumbingLines(from.text ? from.text.split('\n') : [], plumbingIn(ctx, session, from.seq[0], from.seq[1])) : kept.lines, cut: c };
    };
    if (r.truncated) return cut(gapsText(r) ?? 'the tail reached a bound, or a line longer than it');
    if (short && full) return cut(`the daemon's own lines took the rest of the ${asked} lines read`);
    return { lines: kept.lines };
  }
}

async function rawTail(ctx: ToolContext, session: string, n: number, d: Drawn | null): Promise<{ lines: string[]; cut?: TailCut }> {
  // Enough output for the lines and a screenful of redraw (the reader's own rule for a tail).
  const rows = summaryOf(ctx, session)?.rows ?? DEFAULT_GEOMETRY.rows;
  for (let need = n + 2 * rows + 1; ; need = Math.min(need * 2, 2 * TAIL_MAX)) {
    const { events, cut, older } = await tailEvents(ctx, session, need, d);
    if (events.length === 0) return { lines: [] };
    const { text, starts } = rawText(events);
    const kept = keepLines(text.split(/\r?\n/), n, plumbingIn(ctx, session, events[0]!.seq, events[events.length - 1]!.seq));
    const short = kept.lines.length < n;
    if (short && cut === undefined && older && need < 2 * TAIL_MAX) continue;
    if (kept.first === undefined) return { lines: kept.lines };
    // The event the first line shown begins in, and whether at its start. The first event read may
    // itself begin inside a line when older output precedes it: that line's head was not read.
    const at = lineOffsets(text)[kept.first]!;
    let k = starts.length - 1;
    while (k > 0 && starts[k]!.at > at) k--;
    const shown = starts[k]!;
    const ev = events[k]!;
    const cutHead = k === 0 && at === 0 && older && ev.type === 'output';
    // The page before ends right where the first line shown begins: inside its event, or before it. A first
    // line begun before what was read is cut there too, so the page before ends with its head.
    const inside = ev.type === 'output' && at > shown.at ? utf8Length(ev.data.slice(0, at - shown.at)) : 0;
    const tailCut = (why: string): TailCut => ({ before: inside > 0 ? { until: shown.seq, untilOffset: inside } : { until: shown.seq - 1 }, cutHead, why });
    if (cut !== undefined) return { lines: kept.lines, cut: tailCut('the raw tail reached its byte or page bound') };
    if (short && older) return { lines: kept.lines, cut: tailCut("the daemon's own lines took the rest of what was read") };
    if (cutHead) return { lines: kept.lines, cut: tailCut('the first line begins before what was read') };
    return { lines: kept.lines };
  }
}

/** A tool call's arguments as the notes write them: `{"session": "s", "tail": 5}`. */
const callArgs = (o: Record<string, string | number>): string => `{${Object.entries(o).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ')}}`;

/**
 * The tail's lines as tailLogs answers them, for launch too: the cut said first, and the first line
 * marked when it is shown without its head. The advice names the page before this one, which ends
 * where the first line shown begins, and for a first line without its head the head-first read that
 * shows it from its head: a page of the default size may still cut a line longer than it, so the
 * read promises the line's head, not the whole line (the house's reads of 78c4d6e and of the 38
 * commits, #22, comment 6274935728, item 6). A first line begun before what was read has its head in
 * the page before, and the head-first read goes on from where that page ends (a reviewer's read of
 * the fixes for #22: the note promised the line's head and the read showed its middle).
 */
async function tailLogLines(ctx: ToolContext, session: string, n: number, raw: boolean, d: Drawn | null): Promise<string[]> {
  const { lines, cut } = await tailLines(ctx, session, n, raw, d);
  if (cut === undefined) return lines;
  // The mark goes on the first line of output, after the header naming its source when a text tail has one.
  const at = raw ? 0 : lines.findIndex((l) => !isSourceHeader(l));
  if (cut.cutHead && at >= 0 && at < lines.length) lines[at] = `…${lines[at]}`;
  // A line begun before what was read goes on from the page before, whose end is that line's earlier part:
  // its head when the line is shorter than that page, else more of its middle.
  const earlier = ', ending with the earlier part of the first line below';
  const head = cut.head
    ? cut.begunBefore
      ? `${earlier}; read ${callArgs({ session, ...cut.head })} shows that line on from where that page ends`
      : `; read ${callArgs({ session, ...cut.head })} shows the first line below from its head`
    : cut.cutHead
      ? earlier
      : '';
  lines.unshift(`[earlier output not shown (${cut.why}); read ${callArgs({ session, tail: n, ...cut.before })} shows what came before${head}]`);
  return lines;
}

/** 1.x's launch statuses from a service's. */
const launchStatus = (s: ServiceStatus | undefined): 'ready' | 'running' | 'error' => (s === 'ready' ? 'ready' : s === 'starting' || s === 'running' ? 'running' : 'error');

/**
 * The service's status from the session summary, looked at every 200 ms until it leaves
 * `running`/`starting` or the deadline passes. The deadline is on the monotonic clock, as the
 * watches and the segmenter measure: a wall-clock step neither ends the watch at once nor stretches
 * it (the house's correction 6270946953, #22). Date.now stays for the timestamps that are reported.
 */
async function pollService(ctx: ToolContext, session: string, runId: string, deadline: number): Promise<{ status: ServiceStatus; evidence?: string } | undefined> {
  let last: { status: ServiceStatus; evidence?: string } | undefined;
  while (clocks.monotonic() < deadline) {
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
  'cancel-unanswered':
    "a cancel's ^C drew no mark from the shell, and no prompt has shown it back since: if none comes, takeScreenshot shows what holds the terminal; " +
    'then sendInput (Enter at a prompt, or the answer a program reading there waits for), or killSession',
  'shell-unavailable':
    "the session's shell was replaced by a program without integration: if that program is a shell, declare it with session_declare_shell and call runCommand again; sendInput and takeScreenshot work regardless, or use another session",
  'declared-shell-ended':
    'the declared shell (ssh, sudo -i, a nested shell) ended without your asking — the connection dropped, or that shell died — so this command would have run in the shell underneath, not where you meant it: call runCommand again if the session’s own shell is what you mean, or run the opener and declare again',
};

const SCREEN_TEXT_ONLY = 'this release returns the screen as text, not an image: no file was written';

/**
 * Whether a pattern holds a tab: the character itself, or an escape for it (`\t`, `\x09`, `\u0009`,
 * `\cI`; patterns compile without the u flag) that no backslash before it escapes in turn.
 */
const holdsTab = (pattern: string): boolean => pattern.includes('\t') || /(?:^|[^\\])(?:\\\\)*\\(?:t|x09|u0009|c[iI])/.test(pattern);

const TAB_NOTE = 'the pattern holds a tab, and lines read as the terminal shows them, where a tab is the spaces up to the next tab stop: use \\s+ to match it';

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
      // Only ever compared with the monotonic deadline below, never with a wall-clock time.
      const began = clocks.monotonic();
      // 1.x launched into a fresh session in `cwd`; into an existing one, change there first (atc-22). The command
      // goes in a group of its own, so a `&` or `;` in it cannot split it from the cd and run in the old directory;
      // the newline before the closing brace keeps a trailing `&` or comment from taking it (the house's read of 1cabc6a, #22).
      const existing = summaryOf(ctx, name);
      const exists = existing !== undefined && existing.state !== 'exited';
      const command = exists && typeof a.cwd === 'string' ? `cd -- ${shellQuote(a.cwd)} && {\n${a.command as string}\n}` : (a.command as string);
      // Without patterns 1.x waited 2 s and said `running`: wait just past the 2 s liveness window (atc-7).
      const o: Parameters<App['start']>[1] = { session: name, command, name, wait: ready || fail ? 30_000 : 2_500 };
      if (a.cwd !== undefined && !exists) o.cwd = a.cwd as string;
      if (ready) o.ready = { pattern: ready };
      if (fail) o.fail = { pattern: fail };
      try {
        // Launch discards the App.start result. Stage its read commit even for a direct caller,
        // then discard it; otherwise App.start would advance read before launch can decide.
        const r = await ctx.app.start({ ...ctx.caller, deferReadDelivery: true }, o);
        takeReadCommit(r);
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
        // The bounded logs are a preview and move no read cursor (readFor); say when they were cut.
        const res: Record<string, unknown> = { status: launchStatus(service), logs: await tailLogLines(ctx, name, 50, a.raw === true, null), sessionId: name, runId: r.runId, service };
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
      const d = new Drawn();
      const r = d.track(await ctx.app.run(ctx.caller, o));
      if (r.state === 'busy') {
        const b = r.busy;
        const error = opener
          ? `session ${session} is running ${opener.runId} (${opener.line ?? ''}), which looks like a command that opened another shell; nothing was run, since a command queued behind it would run in the session's own shell once it ends, not in that one. ` +
            `If it is a shell (ssh, sudo -i, a nested shell), declare it once with session_declare_shell {"session": "${session}"} and call runCommand again: commands then go to that shell, with their output and exit code. ` +
            `To run after it ends instead, await {"runId": "${opener.runId}"} first.`
          : `session ${r.session} is busy${b?.runId ? ` running ${b.runId}` : ''} (${b?.reason ?? 'busy'}); nothing was run: ${BUSY_NEXT[b?.reason ?? ''] ?? 'try again when it is done, or use another session'}`;
        return json({ output: '', exitCode: -1, duration: 0, state: 'busy', busy: r.busy, error });
      }
      const output = r.runId ? await runOutput(ctx, r.session, r.runId, a.raw === true, d) : r.output.text;
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
      return d.sent(json(res), () => {
        if (r.runId !== undefined && (r.state === 'exited' || r.state === 'cancelled' || r.state === 'lost')) ctx.app.outcomeSent(ctx.caller, r);
      });
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
    description: 'Get recent logs from a session: its last lines, with `$ <command>` where each command was issued. Earlier output of one command: read {"session": …, "runId": …}.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, lines: { type: 'number', description: 'How many lines (default 50, at most 10000)' }, raw },
      required: ['session'],
    },
    async run(ctx, a) {
      const session = a.session as string;
      const asked = typeof a.lines === 'number' && a.lines > 0 ? Math.floor(a.lines) : 50;
      const n = Math.min(asked, TAIL_MAX);
      const d = new Drawn();
      const lines = await tailLogLines(ctx, session, n, a.raw === true, d);
      if (asked > TAIL_MAX) lines.unshift(`[tailLogs returns at most ${TAIL_MAX} lines; ${asked} were asked]`);
      return d.sent(json(lines));
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
    description:
      'Search for patterns in session logs (the last 50,000 journal events; a trailing note says when older output or more matches exist). ' +
      'Lines read as the terminal shows them: a tab is the spaces up to the next tab stop, so a pattern with \\t does not match it; use \\s+.',
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
      // 1.x searched case-insensitively, up to 100 matches (atc-9). The scan takes PROBE_ANSWER_LINES of context past
      // what's asked: a hit's line judged alone kept an answered probe's prompt as a hit, where tailLogs strikes it (an
      // independent read of the fixes for the review of 4f4c067..a8b6f28, PR #22), and so did a line of context when
      // the probe's own `set -x` trace stood between its echo and its answer (the house's review of 4860d4c..bc4bc85).
      const r = await ctx.app.search(ctx.caller, { session, pattern: a.pattern as string, flags: 'i', context: context + PROBE_ANSWER_LINES, limit: 100 });
      const re = compileUserRegex(a.pattern as string, 'i');
      const out: Array<Record<string, unknown>> = [];
      // The plumbing of the Runs the scan covered, by their nonces (a program line in a mark's shape is shown).
      const p = plumbingIn(ctx, session, r.scanned[0], r.scanned[1]);
      for (const m of r.matches) {
        // A match inside the daemon's own plumbing is not one 1.x would have shown (the house's read of 1cabc6a, #22):
        // the line is kept when what remains of it still matches.
        // The lines around the hit judged together, then cut back to the context asked for.
        const at = m.before.length;
        const near = keptLines([...m.before, m.line, ...m.after], p);
        const line = near.find(([, i]) => i === at)?.[0] ?? null;
        if (line === null || (line !== m.line && !re.test(line))) continue;
        out.push({ lineNumber: m.lineNumber, line, context: near.filter(([, i]) => Math.abs(i - at) <= context).map(([l]) => l), seq: m.seq });
      }
      const notes: string[] = [];
      if (r.bounded) notes.push(`older output was not searched (the search covers the last 50,000 journal events); read {"session": "${session}", "tail": 200, "until": ${r.scanned[0] - 1}} shows what came before`);
      if (r.more) notes.push(`more matches exist (stopped by ${r.stoppedBy ?? 'the 100-match limit'})`);
      // What the scan did not see, in the core search's words (tools.ts renderSearch): holes it spanned, lines searched on their head only.
      const gaps = gapsText(r);
      if (gaps) notes.push(`output is missing where the search looked: ${gaps}`);
      const clipped = clippedText(r.clippedLines);
      if (clipped) notes.push(clipped);
      // 1.x matched the raw logged lines, tabs included; lines here read as the terminal shows them, so a
      // pattern with a tab finds nothing and an empty list read as absence (the house's read of the 33
      // commits, #22, comment 6307350650, item 6, and its answer to our third question).
      if (holdsTab(a.pattern as string)) notes.push(TAB_NOTE);
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
      // 1.x wrote a PNG there; a `success: true` without the file would be a lie (the house's read of 1cabc6a, #22). The
      // refusal carries no screen, as its text says, so no screen is read for it and no cursor moves (the house's read of 78c4d6e, #22).
      if (typeof a.outputPath === 'string') return json({ success: false, error: `outputPath ${a.outputPath}: ${SCREEN_TEXT_ONLY}; call again without outputPath for the text` });
      try {
        const s = await ctx.app.screen(ctx.caller, { session: a.session as string });
        const text = s.lines.join('\n').replace(/\n+$/, '');
        const structured = { success: true, text, cols: s.cols, rows: s.rows, alt: s.alt, cursor: s.cursor };
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
