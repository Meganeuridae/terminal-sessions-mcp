/**
 * Reading and searching a session's journal (§6, G11): the logic behind the
 * `read` and `search` tools, independent of who is asking. The App authorizes,
 * resolves the session and advances the caller's `read` cursor; this module
 * turns journal ranges into pages and matches.
 *
 * Reading, exactly:
 *
 * - Cursors are seq values (G11). A page that has to end inside one output
 *   event (an event larger than the page: a process Run's pipe reads are up to
 *   64 KiB) says so with `nextOffset`, the UTF-8 bytes of the event after
 *   `nextCursor` already returned; `since: nextCursor, offset: nextOffset`
 *   continues exactly there. Nothing is read twice or skipped.
 * - Head-first pages (`since`, `runId`) take whole events while their bytes fit
 *   `maxBytes`. When the budget cuts a page it ends at a line end in the second
 *   half of the budget: after a whole event that completes a line (the cursor
 *   stays a seq), else inside an event (`nextOffset`); else, for a line longer
 *   than the rest of the page, at the budget (mid-line: `splitLine`); else at
 *   an earlier line end. A cut is never inside a character, a control sequence
 *   or a CRLF: a sequence longer than a page is taken whole (a control string
 *   longer than OPEN_SEQUENCE_BYTES past the page is the one exception), and a
 *   live page that ends inside one stops before it. A hole ends any sequence
 *   open before it: nothing continues across lost events. The budget holds for
 *   the projected text: a page whose projection grows past `maxBytes` (tabs,
 *   cursor-addressed output) is taken again from less input, so the head of a
 *   page is never cut away. A page the next one continues keeps its trailing
 *   blank lines and an unfinished line's trailing spaces (§6 rule 3, `open`), so
 *   pages joined read as the whole range does, with one exception: a line longer
 *   than the rest of its page is cut mid-line, and its rest begins the next page
 *   at column 0, so a tab or cursor motion in that rest lands on a different
 *   column than it would unsplit.
 * - `splitLine` is set whenever the page ends mid-line and the line may go on:
 *   more follows, or the range is still open (a running Run, a live session).
 * - `more` is true whenever retained events of the range remain after the page.
 * - The projection (§6) runs at the session's geometry, and a Run's at the
 *   geometry it started with. A page starts in the lasting terminal state the
 *   output before it set (a scroll region, the alternate screen, modes; looked
 *   for in up to STATE_LOOKBACK bytes of that output), so a page deep in apt's
 *   output projects as the terminal showed it. Output of different sources
 *   (the terminal, concurrent process Runs) is interleaved by whole lines (§6
 *   rule 6), and a page holding more than one source heads each change of
 *   source with a line `[terminal]` or `[run <runId>]`.
 * - Gaps are visible (G11, G19): output lost to retention, a torn write or a
 *   store failure appears in the text as a `[… N journal events missing …]`
 *   line where it was lost, and in `gap` (and `gaps`, when a page spans more
 *   than one). Every result — text or events, page or tail — reports the holes
 *   it spans the same way, and `describeGap` is the one wording of why.
 * - `tail: N` gives the last N lines of the range (the session, a Run with
 *   `runId`, bounded by `since` and `until`), up to `maxBytes`. `lines` says
 *   how many were asked for and returned: fewer returned without `truncated`
 *   means the range holds no more; `truncated` means `maxBytes`, retention, the
 *   scan bound or the projection's input cap cut lines (or a line's head) that
 *   were asked for. As events, the tail is the newest N events whose stored
 *   lines fit `maxBytes`. `commands` heads each Run's output in a text tail with
 *   `$ <line>` where it started (the 1.x log shape the compat pack serves).
 */
import type { Journal } from '../core/journal.js';
import { compileUserRegex } from '../core/regex.js';
import type { RunOutput, RunOutputRange } from '../core/runindex.js';
import { LineScanner, type Resume, type SearchMatch } from '../core/search.js';
import { persistentState } from '../core/screen.js';
import { lineBytes } from '../core/stores.js';
import { countLines, cutTail, headIndex, indexAtByte, safeCut, sequenceEnd, unfinishedSequence, utf8Length } from '../core/text.js';
import { project, type ProjectChunk, type SourceInfo } from '../core/transcript.js';
import { DEFAULT_GEOMETRY, type EventOf, type GapReason, type JournalEvent, type RunInfo, type Seq } from '../core/types.js';

/** A hole in the journal (G11, G19), as a result reports it: the `gap` event's range and reason. */
export interface GapInfo {
  from: Seq;
  to: Seq;
  reason: GapReason;
}

/** Why a hole's events are gone, in a result's words: the one wording for the gap line in text and for a status line. */
export function describeGap(reason: GapReason): string {
  switch (reason) {
    case 'retention':
      return 'past retention';
    case 'torn-write':
      return 'a torn write';
    case 'store-error':
      return 'the journal store failed';
    case 'store-failed':
      return 'the journal store never took them';
    case 'keeper-overflow':
      return 'keeper overflow';
  }
}

/** The holes a result spans, for its status line or a note: the first three, each with `describeGap`'s wording; undefined when none. */
export function gapsText(r: { gap?: GapInfo; gaps?: GapInfo[] }): string | undefined {
  const one = (g: GapInfo) => `gap ${g.from}–${g.to} (${describeGap(g.reason)})`;
  if (r.gaps?.length) return `${r.gaps.length} gaps: ${r.gaps.slice(0, 3).map(one).join(', ')}${r.gaps.length > 3 ? ', …' : ''}`;
  return r.gap ? one(r.gap) : undefined;
}

/** Lines a search matched on their head only, being longer than the pattern's match window (G11); undefined when none. */
export function clippedText(n: number | undefined): string | undefined {
  if (!n) return undefined;
  return `${n} line${n === 1 ? '' : 's'} longer than the match window, searched on ${n === 1 ? 'its' : 'their'} head only`;
}

export interface ReadResult {
  session: string;
  runId?: string;
  text?: string;
  events?: JournalEvent[];
  /** The journal positions this result covers. */
  seq: [Seq, Seq];
  /** Continue with `since: nextCursor` (and `offset: nextOffset` when present); nothing is read twice or skipped. */
  nextCursor: Seq;
  /** The page ended inside the output event after nextCursor: UTF-8 bytes of it already returned. */
  nextOffset?: number;
  /** More retained events exist after nextCursor (within `until` or the Run). */
  more: boolean;
  /** Output the page spans that is not retained (the first such hole; G11). */
  gap?: GapInfo;
  /** Every hole the page spans, when there is more than one. */
  gaps?: GapInfo[];
  /** True when text was cut to fit, or lost to the scratch emulator (tail reads keep the end). */
  truncated: boolean;
  /** The page ends mid-line: the next page's first line continues this page's last one. */
  splitLine?: boolean;
  oldestSeq?: Seq;
  /** Tail reads: lines asked for and returned. Fewer returned without `truncated`: the range holds no more. */
  lines?: { requested: number; returned: number };
}

export interface SearchResult {
  session: string;
  /** At most `limit`, plus the matching lines the stop settled (search.ts rule 6). */
  matches: SearchMatch[];
  /** The journal range scanned. */
  scanned: [Seq, Seq];
  /** The scan stopped before the end of its range (`stoppedBy` says why): continue with `since: nextCursor` (and `offset: nextOffset`). */
  more: boolean;
  /** The scan started after the oldest retained event because of the scan bound; `since` reaches further back. */
  bounded: boolean;
  /**
   * With `more`: where to continue. A continuation scans no completed line again; a line still
   * open here that other lines completed after was matched on the part scanned, and its rest goes
   * on as a line of its own (search.ts rule 6).
   */
  nextCursor?: Seq;
  nextOffset?: number;
  /** `limit`: more matches exist; `time` or `size`: the scan's budget ran out. */
  stoppedBy?: 'limit' | 'time' | 'size';
  /** Output the scan spans that is not retained (the first such hole). */
  gap?: GapInfo;
  gaps?: GapInfo[];
  /** Lines longer than the pattern's match window: matched on their head only (G11). */
  clippedLines?: number;
}

export interface ReadOptions {
  since?: Seq;
  /** With `since`: UTF-8 bytes of the output event after `since` already read (a result's `nextOffset`). */
  offset?: number;
  until?: Seq;
  tail?: number;
  runId?: string;
  as?: 'text' | 'events';
  maxBytes?: number;
  limit?: number;
  /** Text tails: head each Run's output with `$ <line>` where it started (its run.start), as 1.x logged commands. */
  commands?: boolean;
}

export interface SearchOptions {
  pattern: string;
  flags?: string;
  context?: number;
  since?: Seq;
  /** With `since`: UTF-8 bytes of the output event after `since` already scanned (a match's or result's offset). */
  offset?: number;
  until?: Seq;
  runId?: string;
  /** Matches per call (default 50); see SearchResult.matches for the one way past it. */
  limit?: number;
}

/** What reading needs from a session, live or history. `runId` has been resolved to one of its Runs. */
export interface ReadSource {
  readonly id: string;
  readonly journal: Journal;
  readonly cols: number;
  /** The terminal's rows (default 30): pages project at the session's geometry (§6 rule 1, er-10). */
  readonly rows?: number;
  runOutput(runId: string, range?: RunOutputRange): RunOutput;
  /** The Run's record: its recorded geometry (RunInfo.cols/rows) and whether it has ended. */
  run?(runId: string): RunInfo | undefined;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
type Output = EventOf<'output'>;
type Gap = EventOf<'gap'>;
const isOutput = (e: JournalEvent): e is Output => e.type === 'output';
const isGap = (e: JournalEvent): e is Gap => e.type === 'gap';
const terminal = (s: RunInfo['state'] | undefined) => s === 'exited' || s === 'cancelled' || s === 'lost';

/** Events examined for one page, at most: a page of 20 000 prompt marks and notes still ends, with `more`. */
const MAX_SCAN = 20_000;
/** Events fetched per journal call. */
const BATCH = 2048;
/** How far past the page budget output is collected to reach the end of a control sequence left open. */
const OPEN_SEQUENCE_BYTES = 1024 * 1024;
/** Projections tried for one page before its text is accepted over budget. */
const FIT_ATTEMPTS = 6;

/** The line a hole leaves in text (G11). */
function gapNote(g: GapInfo): string {
  const n = g.to - g.from + 1;
  return `[… ${n} journal event${n === 1 ? '' : 's'} missing (seq ${g.from}–${g.to}: ${describeGap(g.reason)}) …]`;
}

const gapOf = (g: Gap): GapInfo => ({ from: g.from, to: g.to, reason: g.reason });

/** Report the holes a result spans: the first as `gap`, all of them as `gaps` when there are several. */
function withGapInfo<R extends { gap?: GapInfo; gaps?: GapInfo[] }>(r: R, gaps: GapInfo[]): R {
  if (gaps.length) r.gap = gaps[0]!;
  if (gaps.length > 1) r.gaps = gaps;
  return r;
}

/** Header lines for pages that hold more than one source (§6 rule 6). */
const label = (s: SourceInfo): string => (s.stream === 'pty' ? '[terminal]' : `[run ${s.runId ?? '?'}]`);
const sourceKey = (e: Output) => (e.stream === 'pty' ? 'pty' : `p:${e.runId ?? ''}`);
const chunkOf = (e: Output, data = e.data): ProjectChunk => ({ data, stream: e.stream, ...(e.runId !== undefined ? { runId: e.runId } : {}) });

/** A piece of a page: an output event (or its part from `start` bytes on), or a hole. */
type OutPiece = { kind: 'out'; ev: Output; data: string; start: number; bytes: number };
type Piece = OutPiece | { kind: 'gap'; seq: Seq; gap: GapInfo; atStart?: true };

/** The range a read or search walks: events after a cursor, in batches, up to an end. */
interface Walk {
  /** The next batch, or an empty array at the end of the range. Every hole in the range comes as a gap event, once. */
  next(): JournalEvent[];
  /** A retention hole at the start of the range. */
  gap: GapInfo | undefined;
  /** The last seq of the range (as far as it is known now). */
  end: Seq;
}

/** The hole retention leaves at the start of [from, to], by the journal's oldest retained seq (all of it when nothing is retained); undefined when none. */
function retentionGap(journal: Journal, from: Seq, to: Seq): GapInfo | undefined {
  const oldest = journal.oldestSeq;
  const hole = oldest === undefined ? to : Math.min(to, oldest - 1);
  return from <= hole ? { from, to: hole, reason: 'retention' } : undefined;
}

/** A gap event standing for a hole the journal holds no event for (a Run's range cut, or events lost since the walk began). */
const gapEvent = (g: GapInfo): Gap => ({ type: 'gap', seq: g.to, ts: Date.now(), from: g.from, to: g.to, reason: g.reason });

function walk(src: ReadSource, o: { runId?: string | undefined; since?: Seq | undefined; until?: Seq | undefined }): Walk {
  const journal = src.journal;
  let cursor = o.since;
  const fetch = () => (o.runId !== undefined ? src.runOutput(o.runId, rangeOf(cursor, o.until, { limit: BATCH })) : journal.range((cursor ?? 0) + 1, o.until, BATCH));
  const first = fetch();
  let pending: typeof first | undefined = first;
  let gap: GapInfo | undefined;
  let end = journal.lastSeq;
  // The range's first seq: after `since`, and not before a Run's first.
  let from = (o.since ?? 0) + 1;
  if ('truncated' in first) {
    // A Run's output: a hole at its start when retention took the range's first events, or all of them.
    from = Math.max(from, first.from);
    end = first.to;
    if (first.truncated) gap = retentionGap(journal, from, end);
  } else if (first.gap) gap = { ...first.gap };
  if (o.until !== undefined) end = Math.min(end, o.until);
  /** Holes have been reported through this seq. */
  let reported = gap?.to ?? from - 1;
  let done = false;
  return {
    gap,
    end,
    next() {
      if (done) return [];
      const r = pending ?? fetch();
      const resumed = pending === undefined;
      pending = undefined;
      if (!r.more || r.events.length === 0) done = true;
      const events: JournalEvent[] = [...r.events];
      // Events gone since the walk began (retention while a search yielded) are a hole, not a seam
      // to join lines across: a gap event stands where they were (the house's read of 1cabc6a, #22).
      const lost = !resumed ? undefined : 'truncated' in r ? retentionGap(journal, (cursor ?? 0) + 1, Math.min(end, events[0] ? events[0].seq - 1 : end)) : r.gap;
      if (lost && lost.to > reported) events.unshift(gapEvent({ from: Math.max(lost.from, reported + 1), to: lost.to, reason: 'retention' }));
      if ('gaps' in r && r.gaps) {
        // A Run's output is filtered to its own events: its holes come apart and are placed among
        // them, each once; after its last output they reach to the range's end.
        const upTo = done ? end : (events[events.length - 1]?.seq ?? reported);
        for (const g of r.gaps) if (g.seq > reported && g.seq <= upTo) events.push(g);
        events.sort((a, b) => a.seq - b.seq);
      }
      if (events.length) reported = Math.max(reported, done ? end : events[events.length - 1]!.seq);
      if (r.events.length) cursor = r.events[r.events.length - 1]!.seq;
      return events;
    },
  };
}

const rangeOf = (since: Seq | undefined, until: Seq | undefined, r: RunOutputRange): RunOutputRange => {
  if (since !== undefined) r.since = since;
  if (until !== undefined) r.until = until;
  return r;
};

/**
 * Read by cursor (G11). `since` pages forward, head first: each result says where
 * to continue and whether more exists, so nothing is read twice or skipped.
 * `runId` pages through one Run's output the same way. `tail` returns the last N
 * lines of output. `as: 'events'` returns journal events instead of text. The
 * module comment states the rules exactly.
 */
export async function readJournal(src: ReadSource, o: ReadOptions, defaults: { resultBytes: number }): Promise<ReadResult> {
  const journal = src.journal;
  const maxBytes = clamp(o.maxBytes ?? defaults.resultBytes, 1024, 1024 * 1024);
  const res = (fields: Omit<ReadResult, 'session'>): ReadResult => {
    const r: ReadResult = { session: src.id, ...fields };
    if (o.runId !== undefined) r.runId = o.runId;
    const oldest = journal.oldestSeq;
    if (oldest !== undefined) r.oldestSeq = oldest;
    return r;
  };
  // The Run's record: the source's (a live Session's, with its recorded geometry), else the journal's index.
  const run = o.runId !== undefined ? (src.run?.(o.runId) ?? journal.runs.get(o.runId)) : undefined;
  const geometry = { cols: run?.cols ?? src.cols, rows: run?.rows ?? src.rows ?? DEFAULT_GEOMETRY.rows };
  if (o.tail !== undefined) return res(await tailRead(src, o, maxBytes, geometry));
  if (o.as === 'events') return res(eventsPage(src, o, maxBytes));
  return res(await textPage(src, o, maxBytes, geometry, run));
}

// ───────────── head-first text pages ─────────────

async function textPage(src: ReadSource, o: ReadOptions, maxBytes: number, geometry: { cols: number; rows: number }, run: RunInfo | undefined): Promise<Omit<ReadResult, 'session'>> {
  const journal = src.journal;
  const w = walk(src, o);
  const start = o.since ?? 0;
  // Collect the page's candidates: output (the first from `offset` on), holes; enough input for the largest page tried.
  const pieces: Piece[] = [];
  const gaps: GapInfo[] = [];
  if (w.gap) {
    gaps.push(w.gap);
    pieces.push({ kind: 'gap', seq: start, gap: w.gap, atStart: true });
  }
  let bytes = 0;
  let examined = 0;
  let lastExamined = start;
  let exhausted = false;
  // A control sequence left open where collecting would stop is collected to its end (within
  // OPEN_SEQUENCE_BYTES), so no page has to end inside it. A control string (an OSC carrying a
  // clipboard) can be long: once one is found open, only an event that could end it (BEL, ST,
  // ESC) or a hole makes the check run again (the house's read of 1cabc6a, #22).
  let openString: number | undefined; // pieces checked so far, while a control string is open
  const closer = /[\x07\x1b\x9c]/;
  const full = () => {
    if (bytes <= maxBytes) return false;
    if (bytes > maxBytes + OPEN_SEQUENCE_BYTES) return true;
    if (openString !== undefined) {
      if (!pieces.slice(openString).some((q) => q.kind === 'gap' || closer.test(q.data))) {
        openString = pieces.length;
        return false;
      }
      openString = undefined;
    }
    const at = openSequence(pieces);
    if (at === undefined) return true;
    if (isControlString(pieces, at)) openString = pieces.length;
    return false;
  };
  outer: for (;;) {
    const batch = w.next();
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const e of batch) {
      if (full() || examined >= MAX_SCAN) break outer;
      examined++;
      lastExamined = e.seq;
      if (isGap(e)) {
        const g = gapOf(e);
        gaps.push(g);
        pieces.push({ kind: 'gap', seq: e.seq, gap: g });
      } else if (isOutput(e)) {
        // The event after `since` is read from `offset` on.
        const from = o.since !== undefined && e.seq === o.since + 1 ? indexAtByte(e.data, o.offset ?? 0) : 0;
        const data = e.data.slice(from);
        if (!data) continue;
        const b = utf8Length(data);
        pieces.push({ kind: 'out', ev: e, data, start: utf8Length(e.data.slice(0, from)), bytes: b });
        bytes += b;
      }
    }
  }
  // Whether events of the range remain after everything collected (the scan stopped early).
  const scanCut = !exhausted;
  const rangeEnd = exhausted ? Math.max(lastExamined, w.end) : lastExamined;

  // Fit: choose input for at most `budget` bytes, project, and take less input while
  // the text is over maxBytes (never cut the head of a head-first page: er-1, ux-1).
  const open = rangeOpen(src, o, run);
  const hold = open && !scanCut;
  // Lasting terminal state set before the page (a scroll region, the alternate screen, modes)
  // still applies to it: a page deep in apt's output keeps apt's scroll region (§6 rule 7, er-2).
  const firstOut = pieces.find((q): q is OutPiece => q.kind === 'out');
  const state = firstOut && o.since !== undefined ? stateBefore(src, o, firstOut.ev, firstOut.start) : '';
  let budget = maxBytes;
  let chosen = choose(pieces, budget, hold);
  const continued = (c: Chosen) => open || scanCut || c.taken < pieces.length || c.nextOffset !== undefined;
  const projectChosen = (c: Chosen) => projectPage(c, geometry, maxBytes, continued(c), state, firstOut);
  let p = await projectChosen(chosen);
  for (let attempt = 1; attempt < FIT_ATTEMPTS && (p.over || p.omitted > 0) && chosen.inputBytes > 1; attempt++) {
    // Scale by what the projected part of the input produced.
    const projected = Math.max(1, chosen.inputBytes - p.omitted);
    budget = Math.max(1, Math.floor(projected * Math.min(1, maxBytes / Math.max(1, p.textBytes)) * 0.9));
    const next = choose(pieces, budget, hold);
    if (next.inputBytes >= chosen.inputBytes) break;
    chosen = next;
    p = await projectChosen(chosen);
  }

  // A page that shows nothing though it holds output (control sequences, blanks) is joined
  // with what follows it, so no page reads as empty text that stood for a line.
  const collected = pieces.reduce((a, q) => a + (q.kind === 'out' ? q.bytes : 0), 0);
  for (let grow = 0; grow < 3 && p.text === '' && chosen.inputBytes > 0 && chosen.inputBytes < collected; grow++) {
    const next = choose(pieces, Math.min(collected, chosen.inputBytes + maxBytes), hold);
    if (next.inputBytes <= chosen.inputBytes) break;
    chosen = next;
    p = await projectChosen(chosen);
  }

  // Where the page ends, and whether more follows.
  const allTaken = chosen.taken === pieces.length && chosen.nextOffset === undefined;
  let nextCursor: Seq;
  let nextOffset: number | undefined;
  if (allTaken) nextCursor = rangeEnd;
  else if (chosen.nextSeq !== undefined && chosen.nextOffset !== undefined) {
    nextCursor = chosen.nextSeq - 1;
    nextOffset = chosen.nextOffset;
  } else nextCursor = chosen.lastSeq ?? start;
  // An unfinished control sequence held back for later is not more: nothing visible waits.
  const more = scanCut || (!allTaken && !chosen.held);
  const r: Omit<ReadResult, 'session'> = {
    text: p.text,
    seq: [Math.min(chosen.firstSeq ?? start + 1, Math.max(nextCursor, chosen.lastSeq ?? nextCursor)), Math.max(nextCursor, chosen.lastSeq ?? nextCursor)],
    nextCursor: Math.min(nextCursor, journal.lastSeq),
    more,
    // Rows lost in the scratch emulator, or lines a projection still could not fit (visible, G11).
    truncated: p.lost || p.omitted > 0,
  };
  if (nextOffset !== undefined) r.nextOffset = nextOffset;
  if (chosen.midLine && (more || open)) r.splitLine = true;
  return withGapInfo(r, gaps.slice(0, chosen.gapsTaken));
}

/** True when output after the range's end may still continue its last line: a running Run, a live journal. */
function rangeOpen(src: ReadSource, o: ReadOptions, run: RunInfo | undefined): boolean {
  // A Run without a record may go on.
  return (o.until !== undefined && o.until < src.journal.lastSeq) || (!src.journal.closed && !(run && terminal(run.state)));
}

interface Chosen {
  chunks: ProjectChunk[];
  /** Holes, output and headers come from more than one source: label the sources (§6 rule 6). */
  labelled: boolean;
  inputBytes: number;
  /** Pieces taken whole. */
  taken: number;
  /** Holes among the pieces taken. */
  gapsTaken: number;
  /** The first output event taken. */
  firstSeq?: Seq;
  /** The last event taken (output or hole), or the event cut inside. */
  lastSeq?: Seq;
  /** The page ends inside event `nextSeq`, after `nextOffset` of its bytes. */
  nextSeq?: Seq;
  nextOffset?: number;
  /** The page ends mid-line (for some source). */
  midLine: boolean;
  /** The page stops before an unfinished control sequence at the range's end. */
  held: boolean;
}

/** A position in a page's pieces: piece `j`, character `at` of its data. */
interface Pos {
  j: number;
  at: number;
}

/** Pieces of one source joined, and how to map an index in the joined text back to a position (`end` past it). */
function joined(segs: Array<{ j: number; data: string }>, end: Pos): { text: string; locate(i: number): Pos } {
  return {
    text: segs.map((x) => x.data).join(''),
    locate(i: number): Pos {
      let acc = 0;
      for (const x of segs) {
        if (i <= acc + x.data.length) return { j: x.j, at: i - acc };
        acc += x.data.length;
      }
      return end;
    },
  };
}

/**
 * The data of piece `j`'s source up to `at`, with all of that source's earlier pieces back to
 * the page's start or the last hole (nothing continues across lost events; a control string can
 * be longer than any fixed lookback), and the rest of piece `j`.
 */
function sourceContext(pieces: Piece[], pos: Pos): { text: string; rest: string; locate(i: number): Pos } {
  const pc = pieces[pos.j] as OutPiece;
  const key = sourceKey(pc.ev);
  const segs: Array<{ j: number; data: string }> = [{ j: pos.j, data: pc.data.slice(0, pos.at) }];
  for (let i = pos.j - 1; i >= 0; i--) {
    const q = pieces[i]!;
    if (q.kind === 'gap') break;
    if (sourceKey(q.ev) === key) segs.unshift({ j: i, data: q.data });
  }
  return { ...joined(segs, pos), rest: pc.data.slice(pos.at) };
}

/** The data of piece `j`'s source from the start of piece `j` on, up to the next hole. */
function sourceForward(pieces: Piece[], j: number): { text: string; locate(i: number): Pos } {
  const key = sourceKey((pieces[j] as OutPiece).ev);
  const segs: Array<{ j: number; data: string }> = [];
  for (let i = j; i < pieces.length; i++) {
    const q = pieces[i]!;
    if (q.kind === 'gap') break;
    if (sourceKey(q.ev) === key) segs.push({ j: i, data: q.data });
  }
  const last = segs[segs.length - 1]!;
  return joined(segs, { j: last.j, at: last.data.length });
}

/** Whether the sequence starting at `at` is a control string (OSC, DCS, SOS, PM, APC), judged by its second byte when it is at hand. */
function isControlString(pieces: Piece[], at: Pos): boolean {
  const d = (pieces[at.j] as OutPiece).data;
  return d.charCodeAt(at.at) === 0x1b && /[\]PX^_]/.test(d[at.at + 1] ?? '');
}

/**
 * A mid-line cut where the rest of the line shows nothing (blanks, carriage
 * returns, control sequences) moves past the line's end: the line stays whole,
 * so its trailing whitespace trims as it would unsplit (§6 rule 3).
 */
function throughLineEnd(pieces: Piece[], pos: Pos): Pos {
  if (pieces[pos.j]?.kind !== 'out') return pos;
  const fwd = sourceForward(pieces, pos.j);
  const d = fwd.text;
  const limit = Math.min(d.length, pos.at + 64 * 1024);
  let i = pos.at;
  while (i < limit) {
    const c = d.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0d) i++;
    else if (c === 0x1b || c === 0x9b) {
      const e = sequenceEnd(d, i);
      if (e === undefined) return pos;
      i = e;
    } else break;
  }
  return d[i] === '\n' ? fwd.locate(i + 1) : pos;
}

/**
 * Where a control sequence left open at the end of the pieces starts, in whichever source left
 * it open (the earliest when several did); undefined when none is. A hole at the end ends them
 * all (the house's read of ed4ecac, #22).
 */
function openSequence(pieces: Piece[]): Pos | undefined {
  let found: Pos | undefined;
  const seen = new Set<string>();
  for (let j = pieces.length - 1; j >= 0; j--) {
    const q = pieces[j]!;
    if (q.kind === 'gap') break;
    const key = sourceKey(q.ev);
    if (seen.has(key)) continue;
    seen.add(key);
    const ctx = sourceContext(pieces, { j, at: q.data.length });
    const e = unfinishedSequence(ctx.text, Number.POSITIVE_INFINITY);
    if (e >= ctx.text.length) continue;
    const at = ctx.locate(e);
    if (!found || at.j < found.j || (at.j === found.j && at.at < found.at)) found = at;
  }
  return found;
}

/** The nearest point at or before `pos` where the page can end without splitting a control sequence, a character or a CRLF (§6). */
function safeBefore(pieces: Piece[], pos: Pos): Pos {
  const ctx = sourceContext(pieces, pos);
  return ctx.locate(safeCut(ctx.text + ctx.rest, ctx.text.length, Number.POSITIVE_INFINITY));
}

/**
 * The page for an input budget (see the module comment): whole pieces while they
 * fit. When the budget cuts the page it ends, in order of preference, at a line
 * end in the second half of the budget (after a whole event that completes a
 * line, so the cursor stays a seq; else inside an event); else at the budget, at
 * a safe point (a line longer than the rest of the page: mid-line); else at any
 * line end. When everything fits and the range may go on (`hold`), a control
 * sequence left unfinished at the end waits for the next page, where its end is.
 */
function choose(pieces: Piece[], budget: number, hold: boolean): Chosen {
  const out = (i: number) => (pieces[i]?.kind === 'out' ? (pieces[i] as OutPiece) : undefined);
  let used = 0;
  let k = 0;
  const before: number[] = []; // bytes of output before each piece
  for (; k < pieces.length; k++) {
    before[k] = used;
    const pc = out(k);
    if (!pc) continue;
    if (used + pc.bytes > budget) break;
    used += pc.bytes;
  }
  let end = k;
  let cut: Pos | undefined;
  let held = false;
  if (k < pieces.length) {
    const crossing = out(k)!;
    const room = headIndex(crossing.data, budget - used);
    // The last line end within the budget: after a whole event, or inside one.
    let boundary = k - 1;
    while (boundary >= 0 && !out(boundary)?.data.endsWith('\n')) boundary--;
    let inside: Pos | undefined;
    const nl = room > 0 ? crossing.data.lastIndexOf('\n', room - 1) : -1;
    if (nl !== -1) inside = { j: k, at: nl + 1 };
    for (let i = k - 1; i > boundary && !inside; i--) {
      const d = out(i)?.data;
      const n2 = d === undefined ? -1 : d.lastIndexOf('\n');
      if (n2 !== -1) inside = { j: i, at: n2 + 1 };
    }
    const bytesAt = (p: Pos) => before[p.j]! + utf8Length(out(p.j)!.data.slice(0, p.at));
    const boundaryBytes = boundary >= 0 ? before[boundary]! + out(boundary)!.bytes : -1;
    if (boundary >= 0 && boundaryBytes >= budget / 2) end = boundary + 1;
    else if (inside && bytesAt(inside) >= budget / 2) cut = inside;
    else {
      // A line longer than the rest of the page: cut it at the budget, safely.
      const safe = throughLineEnd(pieces, safeBefore(pieces, { j: k, at: room }));
      if (safe.at > 0 || safe.j < k) cut = safe;
      else if (inside) cut = inside;
      else if (boundary >= 0) end = boundary + 1;
      else cut = safe; // the page starts with a control sequence longer than it: below
    }
    if (cut === undefined && end === boundary + 1) while (end < pieces.length && pieces[end]!.kind === 'gap') end++;
    // Every page makes progress. One that would end before its first output starts with a
    // control sequence longer than the page: it takes that sequence whole, then its line to
    // the line end or the budget, so no page starts inside a sequence and none is only one.
    const first = pieces.findIndex((q) => q.kind === 'out');
    if (first !== -1 && (cut ? cut.j < first || (cut.j === first && cut.at === 0) : end <= first)) {
      const fwd = sourceForward(pieces, first);
      const c0 = fwd.text.charCodeAt(0);
      const e = c0 === 0x1b || c0 === 0x9b ? sequenceEnd(fwd.text, 0) : 0;
      if (e === undefined) {
        // It does not end in what was collected: all of it, or up to the hole that ends it.
        const hole = pieces.findIndex((q, i) => i > first && q.kind === 'gap');
        end = hole === -1 ? pieces.length : hole + 1;
        cut = undefined;
      } else {
        const after = headIndex(fwd.text.slice(e), budget);
        const n3 = fwd.text.lastIndexOf('\n', e + after - 1);
        const at = n3 >= e ? n3 + 1 : Math.max(e + 1, e + safeCut(fwd.text.slice(e), after));
        cut = throughLineEnd(pieces, fwd.locate(Math.min(at, fwd.text.length)));
      }
    }
  } else if (hold) {
    // Only the sequence waits when it is in the last output; an earlier source's open sequence defers
    // visible output after it too, which is `more`.
    cut = openSequence(pieces);
    held = cut !== undefined && !pieces.some((q, i) => i > cut!.j && q.kind === 'out');
  }
  if (cut && cut.at >= (out(cut.j)?.data.length ?? 0)) {
    // A cut at the end of a piece is the end of that piece.
    end = cut.j + 1;
    cut = undefined;
  } else if (cut && cut.at === 0) {
    end = cut.j;
    cut = undefined;
  }
  let partial: OutPiece | undefined;
  if (cut) {
    const pc = out(cut.j)!;
    const data = pc.data.slice(0, cut.at);
    partial = { ...pc, data, bytes: utf8Length(data) };
    end = cut.j;
  }
  const taken = pieces.slice(0, end);
  if (partial) taken.push(partial);
  const chunks: ProjectChunk[] = [];
  /** Per source: its data from the last piece that holds a LF on. */
  const lastBySource = new Map<string, string>();
  const sources = new Set<string>();
  const c: Chosen = { chunks, labelled: false, inputBytes: 0, taken: end, gapsTaken: 0, midLine: false, held };
  for (const pc of taken) {
    if (pc.kind === 'gap') {
      chunks.push({ note: gapNote(pc.gap) });
      c.gapsTaken++;
      if (!pc.atStart) c.lastSeq = pc.seq;
      lastBySource.clear(); // a hole ends every line
      continue;
    }
    chunks.push(chunkOf(pc.ev, pc.data));
    const key = sourceKey(pc.ev);
    sources.add(key);
    const prior = lastBySource.get(key);
    lastBySource.set(key, prior === undefined || pc.data.includes('\n') ? pc.data : prior + pc.data);
    c.firstSeq ??= pc.ev.seq;
    c.lastSeq = pc.ev.seq;
    c.inputBytes += pc.bytes;
  }
  c.labelled = sources.size > 1;
  c.midLine = [...lastBySource.values()].some((d) => !endsLine(d));
  // The page ends inside an event: in the part it took, or where the first piece began (a page that took
  // nothing of the event it was continuing keeps the offset it was given).
  const rest = partial ?? (pieces[end]?.kind === 'out' && (pieces[end] as OutPiece).start > 0 ? { ...(pieces[end] as OutPiece), bytes: 0 } : undefined);
  if (rest) {
    c.nextSeq = rest.ev.seq;
    c.nextOffset = rest.start + rest.bytes;
  }
  return c;
}

/** `d` has ended its last line: after its last LF come only carriage returns and control sequences. */
function endsLine(d: string): boolean {
  let i = d.lastIndexOf('\n') + 1;
  if (i === 0) return false;
  while (i < d.length) {
    const c = d.charCodeAt(i);
    const e = c === 0x0d ? i + 1 : c === 0x1b || c === 0x9b ? sequenceEnd(d, i) : undefined;
    if (e === undefined) return false;
    i = e;
  }
  return true;
}

async function projectPage(chosen: Chosen, geometry: { cols: number; rows: number }, maxBytes: number, continued: boolean, state = '', first?: OutPiece) {
  // maxLines never binds before the byte budget does: every line costs at least its LF.
  const opts: Parameters<typeof project>[1] = { cols: geometry.cols, rows: geometry.rows, keep: 'head', maxLines: maxBytes + 2 };
  if (chosen.labelled) opts.label = label;
  // A page the next one continues keeps its trailing blank lines and an unfinished line's spaces (§6 rule 3).
  if (continued) opts.open = true;
  // The state goes in as the first source's output, so it starts no source of its own.
  const chunks = state && first ? [chunkOf(first.ev, state), ...chosen.chunks] : chosen.chunks;
  const p = await project(chunks, opts);
  const textBytes = utf8Length(p.text);
  // `omittedInputBytes` can only come from maxLines here: the text is over budget by then.
  return { text: p.text, textBytes, over: textBytes > maxBytes, omitted: p.omittedInputBytes, lost: p.truncated && p.omittedInputBytes === 0 };
}

/** Output bytes looked back over for the lasting state a page starts in. */
const STATE_LOOKBACK = 1024 * 1024;

/**
 * The lasting terminal state (`persistentState`, screen.ts) set by the view's
 * output before the page: `first`'s bytes before `start`, and up to
 * STATE_LOOKBACK bytes of output before it — the Run's own for a Run's pages.
 */
function stateBefore(src: ReadSource, o: ReadOptions, first: Output, start = 0): string {
  const parts: string[] = [];
  let bytes = 0;
  if (start > 0) {
    const head = first.data.slice(0, indexAtByte(first.data, start)).slice(-STATE_LOOKBACK);
    parts.push(head);
    bytes += head.length;
  }
  if (o.runId !== undefined) {
    if (bytes >= STATE_LOOKBACK) return persistentState(parts[0]!);
    const ro = src.runOutput(o.runId, { until: first.seq - 1, maxBytes: STATE_LOOKBACK - bytes });
    for (let i = ro.events.length - 1; i >= 0; i--) {
      const e = ro.events[i]!;
      if (isOutput(e)) parts.push(e.data);
    }
  } else {
    let cursor = first.seq - 1;
    let examined = 0;
    // Bounded in events as well as bytes: a stretch of marks and notes with no output ends the look-back.
    while (bytes < STATE_LOOKBACK && cursor > 0 && examined < MAX_SCAN) {
      const batch = src.journal.tail(512, cursor);
      if (batch.length === 0) break;
      examined += batch.length;
      for (let i = batch.length - 1; i >= 0 && bytes < STATE_LOOKBACK; i--) {
        const e = batch[i]!;
        if (!isOutput(e)) continue;
        parts.push(e.data);
        bytes += e.data.length;
      }
      cursor = batch[0]!.seq - 1;
    }
  }
  // Oldest first, reduced as one text: a sequence split across two events (apt's scroll region) is
  // whole again (the house's read of 1cabc6a, #22); a reset makes what precedes it moot.
  return persistentState(parts.reverse().join(''));
}

// ───────────── events pages ─────────────

function eventsPage(src: ReadSource, o: ReadOptions, maxBytes: number): Omit<ReadResult, 'session'> {
  const journal = src.journal;
  const limit = clamp(o.limit ?? 200, 1, 2000);
  const w = walk(src, o);
  const start = o.since ?? 0;
  const page: JournalEvent[] = [];
  const gaps: GapInfo[] = w.gap ? [w.gap] : [];
  let bytes = 0;
  let more = false;
  outer: for (;;) {
    const batch = w.next();
    if (batch.length === 0) break;
    for (const e of batch) {
      // `maxBytes` is the page size: the events as the store writes them, at least one of them.
      const b = lineBytes(e);
      if (page.length >= limit || (page.length > 0 && bytes + b > maxBytes)) {
        more = true;
        break outer;
      }
      page.push(e);
      if (isGap(e)) gaps.push(gapOf(e));
      bytes += b;
    }
  }
  const next = more ? page[page.length - 1]!.seq : Math.max(w.end, page[page.length - 1]?.seq ?? start);
  const r: Omit<ReadResult, 'session'> = { events: page, seq: [page[0]?.seq ?? start + 1, next], nextCursor: Math.min(next, journal.lastSeq), more, truncated: false };
  return withGapInfo(r, gaps);
}

// ───────────── tail ─────────────

async function tailRead(src: ReadSource, o: ReadOptions, maxBytes: number, geometry: { cols: number; rows: number }): Promise<Omit<ReadResult, 'session'>> {
  const journal = src.journal;
  const n = clamp(o.tail!, 1, 10_000);
  // Input with enough line ends for the last n lines, and room for a screenful of redraw (§6 rule 7).
  const need = n + 2 * geometry.rows + 1;
  // Input projected at most: never less than the result may hold, so a page of long lines is whole.
  const cap = Math.max(256 * 1024, n * 400, maxBytes);
  let events: JournalEvent[];
  let end: Seq;
  /** Output of the range older than what was fetched exists, or existed and is gone. */
  let older: boolean;
  /** The holes the window spans: retention's at the range's start when the window reaches it, then the gap events among the window's events. */
  const gaps: GapInfo[] = [];
  if (o.runId !== undefined) {
    let want = Math.min(cap, 64 * 1024);
    let ro: RunOutput;
    for (;;) {
      ro = src.runOutput(o.runId, rangeOf(o.since, o.until, { maxBytes: want }));
      const lineEnds = ro.events.reduce((a, e) => a + (isOutput(e) ? countLines(e.data) : 0), 0);
      if (lineEnds >= need || !ro.truncated || want >= cap) break;
      want = Math.min(cap, want * 4);
    }
    end = o.until !== undefined ? Math.min(ro.to, o.until) : ro.to;
    older = ro.truncated;
    events = [...ro.events, ...(ro.gaps ?? [])].sort((a, b) => a.seq - b.seq);
    // Nothing of the range retained: the hole is the range (the house's read of 1cabc6a, #22).
    const lost = ro.truncated && ro.events.length === 0 ? retentionGap(journal, Math.max(ro.from, (o.since ?? 0) + 1), end) : undefined;
    if (lost) events.unshift(gapEvent(lost));
  } else {
    // Walk back from the end until the lines, the byte cap, the event bound, `since` or retention stops it.
    end = o.until !== undefined ? Math.min(o.until, journal.lastSeq) : journal.lastSeq;
    let cursor = end;
    let lineEnds = 0;
    let bytes = 0;
    let examined = 0;
    const parts: JournalEvent[][] = [];
    older = false;
    for (;;) {
      if (o.since !== undefined && cursor <= o.since) break;
      const batch = journal.tail(512, cursor).filter((e) => o.since === undefined || e.seq > o.since);
      if (batch.length === 0) {
        // The range's start: what retention took of it is a hole, all of it when nothing is retained.
        const lost = retentionGap(journal, (o.since ?? 0) + 1, cursor);
        if (lost) {
          older = true;
          parts.push([gapEvent(lost)]);
        }
        break;
      }
      parts.push(batch);
      examined += batch.length;
      for (const e of batch) {
        if (!isOutput(e)) continue;
        lineEnds += countLines(e.data);
        bytes += e.data.length;
      }
      cursor = batch[0]!.seq - 1;
      if (lineEnds >= need || bytes >= cap || examined >= MAX_SCAN) {
        older = cursor > (o.since ?? 0);
        break;
      }
    }
    events = parts.reverse().flat();
  }
  if (o.as === 'events') {
    // The newest events whose stored lines fit `maxBytes` (at least one), at most n and 2,000; fewer
    // than asked is a cut unless the range holds no more (the house's read of 1cabc6a, #22).
    const ev: JournalEvent[] = [];
    let bytes = 0;
    for (let i = events.length - 1; i >= 0 && ev.length < Math.min(n, 2000); i--) {
      const b = lineBytes(events[i]!);
      if (ev.length > 0 && bytes + b > maxBytes) break;
      ev.push(events[i]!);
      bytes += b;
    }
    ev.reverse();
    const r: Omit<ReadResult, 'session'> = { events: ev, seq: [ev[0]?.seq ?? end, end], nextCursor: end, more: false, truncated: ev.length < n && (older || ev.length < events.length), lines: { requested: n, returned: ev.length } };
    return withGapInfo(r, ev.filter(isGap).map(gapOf));
  }
  const chunks: ProjectChunk[] = [];
  const sources = new Set<string>();
  const outs: Output[] = [];
  // The lasting state set before the window (a scroll region, the alternate screen) applies to it.
  const firstOut = events.find(isOutput);
  if (older && firstOut) {
    const state = stateBefore(src, o, firstOut);
    if (state) chunks.push(chunkOf(firstOut, state));
  }
  for (const e of events) {
    if (isGap(e)) {
      gaps.push(gapOf(e));
      chunks.push({ note: gapNote(gapOf(e)) });
    } else if (isOutput(e)) {
      outs.push(e);
      sources.add(sourceKey(e));
      chunks.push(chunkOf(e));
    } else if (o.commands && e.type === 'run.start' && e.line !== undefined) {
      chunks.push({ note: `$ ${e.line}` });
    }
  }
  const opts: Parameters<typeof project>[1] = { cols: geometry.cols, rows: geometry.rows, maxInputBytes: cap, keep: 'tail', maxLines: n };
  if (sources.size > 1) opts.label = label;
  const p = await project(chunks, opts);
  // maxBytes drops whole lines from the head; a single line over it keeps its end.
  let bytes = utf8Length(p.text);
  const cutByBytes = bytes > maxBytes;
  let drop = 0;
  const lines = p.text === '' ? [] : p.text.split('\n');
  while (lines.length - drop > 1 && bytes > maxBytes) bytes -= utf8Length(lines[drop++]!) + 1;
  const kept = lines.slice(drop);
  const text = cutTail(kept.join('\n'), maxBytes).text;
  // Fewer lines than asked is truncation only when older output was cut (by the walk's bounds, or
  // retention). So is the head of a line asked for that lies past what was projected: past the input
  // cap, or past the start of a window that older output precedes — one line longer than the cap is
  // such a line, and comes back cut with `truncated` set (the house's read of 1cabc6a, #22).
  const inputBytes = outs.reduce((a, e) => a + utf8Length(e.data), 0);
  const reach = lastLinesBytes(outs, n);
  const headCut = reach > cap || (older && reach >= inputBytes);
  const truncated = cutByBytes || (kept.length < n && older) || headCut;
  return withGapInfo<Omit<ReadResult, 'session'>>({ text, seq: [firstEventOf(outs, kept.length) ?? end, end], nextCursor: end, more: false, truncated, lines: { requested: n, returned: kept.length } }, gaps);
}

/** UTF-8 bytes from the end of the output back to where its last `n` lines begin (by raw line ends); all of it when it holds no more lines. */
function lastLinesBytes(outs: Output[], n: number): number {
  let bytes = 0;
  let seen = 0;
  for (let k = outs.length - 1; k >= 0; k--) {
    const d = outs[k]!.data;
    // The LF that ends the last line begins no line.
    let i = d.length;
    if (k === outs.length - 1 && d.endsWith('\n')) i--;
    for (;;) {
      const nl = d.lastIndexOf('\n', i - 1);
      if (nl === -1) break;
      if (++seen >= n) return bytes + utf8Length(d.slice(nl + 1));
      i = nl;
    }
    bytes += utf8Length(d);
  }
  return bytes;
}

/**
 * The seq of the first output event whose bytes reach the last `lines` lines, by
 * the raw line ends (an estimate the projection can only narrow: it never makes a
 * line out of no LF, except a full-screen frame).
 */
function firstEventOf(outs: Output[], lines: number): Seq | undefined {
  if (outs.length === 0 || lines === 0) return outs[outs.length - 1]?.seq;
  let seen = 0;
  for (let k = outs.length - 1; k >= 0; k--) {
    const d = outs[k]!.data;
    // The unterminated last line counts as one; each LF before a line's start closes the previous one.
    let i = d.length;
    if (k === outs.length - 1 && d.endsWith('\n')) i--;
    for (;;) {
      const nl = d.lastIndexOf('\n', i - 1);
      if (nl === -1) break;
      if (++seen >= lines) return nl + 1 < d.length ? outs[k]!.seq : (outs[k + 1]?.seq ?? outs[k]!.seq);
      i = nl;
    }
  }
  return outs[0]!.seq;
}

// ───────────── search ─────────────

/** How much one search call may do before it stops and says where to continue. */
export interface SearchLimits {
  /** Wall time (default 2 s). */
  ms: number;
  /** Output bytes scanned (default 64 MiB). */
  bytes: number;
  /** Events examined (default 500 000). */
  events: number;
}

export const SEARCH_LIMITS: SearchLimits = { ms: 2000, bytes: 64 * 1024 * 1024, events: 500_000 };
/** Without a cursor, the recent past scanned: this many events. */
const SEARCH_WINDOW = 50_000;
/** Scanning yields to the event loop this often, so a search never stalls the daemon. */
const SLICE_MS = 16;

const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Regex over output lines with seq anchors and context (§11 `search`). Lines are
 * built as `core/search.ts` states; the scan pages through the range, yields to
 * the event loop as it goes, and stops on `limit` or a time or size budget,
 * saying where to continue (`more`, `nextCursor`, `nextOffset`). Every match
 * carries `cursor` (and `offset`): read `since: cursor, offset` starts at its line.
 */
export async function searchJournal(src: ReadSource, o: SearchOptions, limits: Partial<SearchLimits> = {}): Promise<SearchResult> {
  const journal = src.journal;
  const lim: SearchLimits = { ...SEARCH_LIMITS, ...limits };
  const re = compileUserRegex(o.pattern, o.flags ?? '');
  let since = o.since;
  let bounded = false;
  if (since === undefined && o.runId === undefined) {
    // Without a cursor, scan the recent past: a bounded window, reported as such.
    const oldest = journal.oldestSeq ?? 1;
    const end = o.until !== undefined ? Math.min(o.until, journal.lastSeq) : journal.lastSeq;
    const windowStart = Math.max(oldest, end - SEARCH_WINDOW + 1);
    bounded = oldest < windowStart;
    since = windowStart - 1;
  }
  const w = walk(src, { runId: o.runId, since, until: o.until });
  const scanner = new LineScanner(re, o);
  const gaps: GapInfo[] = w.gap ? [w.gap] : [];
  const started = performance.now();
  let slice = started;
  let firstSeq: Seq | undefined;
  let lastSeq: Seq | undefined;
  let bytes = 0;
  let events = 0;
  let stoppedBy: SearchResult['stoppedBy'];
  outer: for (;;) {
    const batch = w.next();
    if (batch.length === 0) break;
    for (const e of batch) {
      // A budget stops the scan only after it has made progress, so continuing always gets further.
      if (events > 0 && (bytes >= lim.bytes || events >= lim.events)) {
        stoppedBy = 'size';
        break outer;
      }
      if (events > 0 && performance.now() - started > lim.ms) {
        stoppedBy = 'time';
        break outer;
      }
      if (isGap(e)) gaps.push(gapOf(e));
      scanner.feed(e, since !== undefined && e.seq === since + 1 ? (o.offset ?? 0) : 0);
      firstSeq ??= e.seq;
      lastSeq = e.seq;
      events++;
      if (isOutput(e)) bytes += utf8Length(e.data);
      if (scanner.full) {
        stoppedBy = 'limit';
        break outer;
      }
      if (performance.now() - slice > SLICE_MS) {
        await yieldTurn();
        slice = performance.now();
      }
    }
  }
  let resume: Resume | undefined;
  if (stoppedBy === undefined) scanner.flush(lastSeq ?? w.end);
  // The match past the limit may have come in the loop (the scan then went on only for the last
  // matches' after-context, and may have met a budget doing so) or from the flush, in an unfinished
  // last line: either way the scan stops at that match, with more (the house's reads of ed4ecac and
  // 1cabc6a, #22).
  if (scanner.limited) stoppedBy = 'limit';
  if (stoppedBy !== undefined) {
    // Lines open since the scan began, or with other lines completed after them, are matched now
    // (search.ts rule 6); then the scan continues at the earliest point where nothing is lost or
    // scanned twice: a line cut at the very end, or the match past the limit. Both lie past the
    // start, so continuing always gets further.
    const last = lastSeq ?? since ?? 0;
    scanner.settle(last);
    const candidates = [scanner.pending(), scanner.stop].filter((x): x is Resume => x !== undefined);
    resume = candidates.sort((a, b) => a.cursor - b.cursor || a.offset - b.offset)[0] ?? { cursor: last, offset: 0 };
  }
  const from = firstSeq ?? (since ?? 0) + 1;
  const to = stoppedBy === undefined ? Math.max(lastSeq ?? w.end, w.end) : (lastSeq ?? from);
  const r: SearchResult = { session: src.id, matches: scanner.matches, scanned: [Math.min(from, to), to], more: stoppedBy !== undefined, bounded };
  if (resume) {
    r.nextCursor = resume.cursor;
    if (resume.offset > 0) r.nextOffset = resume.offset;
  }
  if (stoppedBy) r.stoppedBy = stoppedBy;
  withGapInfo(r, gaps);
  if (scanner.clippedLines > 0) r.clippedLines = scanner.clippedLines;
  return r;
}
