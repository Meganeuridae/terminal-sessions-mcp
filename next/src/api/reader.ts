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
 * - A shell Run's pages and tails (`runId`) show what the Run's own result
 *   shows: the daemon's plumbing in its range (a marker Run's typed line,
 *   marks and the prompt after its end mark, a declared shell's end mark, a
 *   cancel's probe lines) is cut by the core's cutter, and the cursors and
 *   `lines.before` are journal positions still (runKept). A read of the
 *   session shows everything, as the terminal did.
 * - `splitLine` is set whenever the page ends mid-line and the line may go on:
 *   more follows, or the range is still open (a running Run, a live session).
 * - `more` is true whenever retained events of the range remain after the page.
 * - The projection (§6) runs at the session's geometry, and a Run's at the
 *   geometry it started with. A page starts in the lasting terminal state the
 *   output before it set (a scroll region, the alternate screen, modes; looked
 *   for in up to STATE_LOOKBACK bytes of that output, and in a session's pages
 *   and tails within MAX_SCAN journal events back), so a page deep in apt's
 *   output projects as the terminal showed it. A tail that begins inside a
 *   control string reads it the same way: one opened further back than either
 *   bound is not seen, and its payload shows as text. Output of different sources
 *   (the terminal, concurrent process Runs) is interleaved by whole lines (§6
 *   rule 6), and a page holding more than one source heads each change of
 *   source with a line `[terminal]` or `[run <runId>]`.
 * - Gaps are visible (G11, G19): output lost to retention, a crash or a
 *   store failure appears in the text as a `[… N journal events missing …]`
 *   line where it was lost ("up to N" when the count is a bound: `gapNote`),
 *   and in `gap` (and `gaps`, when a page spans more than one). Every result —
 *   text or events, page or tail, a session's or a Run's — reports every hole
 *   that meets the seqs it covers, once and where the hole is, whether the gap
 *   event that records it lies in the result, past it or on another page, and
 *   `describeGap` is the one wording of why.
 * - `tail: N` gives the last N lines of the range (the session, a Run with
 *   `runId`, bounded by `since` and `until`, which `untilOffset` can place inside
 *   an event), up to `maxBytes`. N counts lines of output and notes (a hole's,
 *   a command's `$ <line>`), each a line of the text; the header lines naming
 *   sources come extra. `lines` says how many were asked for and
 *   returned: fewer returned without `truncated` means the range holds no more;
 *   `truncated` means `maxBytes`, retention, a hole among the lines shown, the
 *   scan bound or the projection's input cap cut lines (or a line's head) that
 *   were asked for. `lines.before`
 *   is where a tail of what came before ends, right where the lines shown
 *   begin, every line the text leaves out whole in it, and `lines.head` reads a
 *   first line shown without its head from its head, or, when that line began
 *   before the lines read (`lines.begunBefore`), on from where the page before
 *   ends. With more than one source, an unfinished line is shown after lines
 *   other sources wrote after it began (rule 6); when the lines asked for would
 *   leave out the line written last, the tail reaches back to it, returning more
 *   lines than asked for. As events, the tail is the newest N events whose stored lines fit
 *   `maxBytes`. `commands` heads each Run's output in a text tail with
 *   `$ <line>` where it started (the 1.x log shape the compat pack serves).
 */
import { err } from '../core/errors.js';
import type { Journal } from '../core/journal.js';
import { keptRanges, startMark, type PlumbingOf } from '../core/plumbing.js';
import { compileUserRegex, headOnlyText } from '../core/regex.js';
import type { RunOutput, RunOutputRange } from '../core/runindex.js';
import { LineScanner, type Resume, type SearchMatch } from '../core/search.js';
import { persistentState } from '../core/screen.js';
import { minusRanges } from '../core/ranges.js';
import { lineBytes } from '../core/stores.js';
import { countLines, cutTail, headAt, headIndex, indexAtByte, isIntroducer, lineCarry, lineEnds, safeCut, sequenceEnd, stripEscapes, unfinishedSequence, utf8Length, type LineCarry } from '../core/text.js';
import { interleaveCut, namingHeader, project, type ProjectChunk, type SourceInfo } from '../core/transcript.js';
import { DEFAULT_GEOMETRY, type EventOf, type GapReason, type Hole, type JournalEvent, type RunInfo, type Seq } from '../core/types.js';

/**
 * A hole in the journal (G11, G19), as a result reports it: the `gap` event's range and reason, and `exact`
 * when every seq of it was issued, so it counts the events lost; absent, the count is a bound.
 */
export type GapInfo = Hole;

/** Why a hole's events are gone, in a result's words: the one wording for the gap line in text and for a status line. */
export function describeGap(reason: GapReason): string {
  switch (reason) {
    case 'retention':
      return 'past retention';
    case 'torn-write':
      // A line torn as the daemon died, and, since the journal reserves its numbering, the seqs a machine crash
      // skipped above the last synced reservation: "a torn write" named only the first (the house's read of the
      // 33 commits, #22, comment 6307349700).
      return 'a crash cut the journal short';
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

/** Lines a search scanned on their head only, being longer than the pattern's match window (G11), matched or not, in the one wording of it (headOnlyText); undefined when none. */
export function clippedText(n: number | undefined): string | undefined {
  return n ? headOnlyText(n) : undefined;
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
  /**
   * Tail reads: lines of output asked for and returned (the header lines naming sources come extra).
   * Fewer returned without `truncated`: the range holds no more; more: lines of other sources reach
   * back to the line written last (see the module comment).
   * `before`: where a tail of what came before ends — pass its `until`, and its `untilOffset` when
   * present (the lines shown begin inside an event), as `until` and `untilOffset` beside the same
   * `tail`, so the two pages meet with nothing in neither and following it again pages further back;
   * absent when nothing of the range came before.
   * `cutHead`: the first line returned is missing its head (the byte cap, the input cap or the
   * window's start cut it), and `head` is a head-first read (`since`, `offset`) from where the page
   * before ends, which shows that line from its head (the house's reads of 78c4d6e and of the 38
   * commits, #22). `begunBefore`: the lines shown reach back to the start of what was read, and
   * older output precedes it, so the first line may have begun in the page before; `head` then
   * reads it on from where that page ends, which is the only read reaching the bytes between, and
   * not from its head (a reviewer's read of the fixes for #22: the head read of a line begun long
   * before the window started in its middle).
   */
  lines?: { requested: number; returned: number; cutHead?: true; begunBefore?: true; before?: { until: Seq; untilOffset?: number }; head?: { since: Seq; offset?: number } };
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
  /** Lines scanned that were longer than the pattern's match window, matched or not: searched on their head only (G11). */
  clippedLines?: number;
}

export interface ReadOptions {
  since?: Seq;
  /** With `since`: UTF-8 bytes of the output event after `since` already read (a result's `nextOffset`). */
  offset?: number;
  until?: Seq;
  /** With a text `tail` and `until`: the range ends inside the output event `until`, after this many of its UTF-8 bytes (a tail's `lines.before.untilOffset`). */
  untilOffset?: number;
  tail?: number;
  runId?: string;
  /**
   * `raw`: the output an events page holds, its data joined as written, escape codes kept, a shell Run's plumbing
   * cut as its text is (runKept), and each hole's note on a line of its own where the hole lies (rawPage). Not a
   * tool's choice: the compat pack's raw output reads by it.
   */
  as?: 'text' | 'events' | 'raw';
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

/**
 * The line a hole leaves in text (G11); the compat pack's raw tail marks its holes with it too. The count is
 * the hole's range when every seq of it was issued (`exact`), and "up to" it otherwise: numbering may have
 * resumed above a reservation, so part of the range, up to 10,000 seqs, may never have been issued, and "9997
 * journal events missing" overstated what was lost (an independent read of the fix for the house's read of
 * the 33 commits, #22, comment 6307350650). Worded by what the journal knows, not by the hole's reason: a new
 * life's hole of events every one of which was issued read "up to", and a reservation one seq ahead "1 journal
 * event" (the house's review of the 40 commits through f3750e4, PR #22, comment 6310921374, question 4). A gap
 * an earlier build wrote carries no `exact`, and is counted as a bound.
 */
export function gapNote(g: GapInfo): string {
  const n = g.to - g.from + 1;
  const count = `${n} journal event${n === 1 ? '' : 's'}`;
  return `[… ${g.exact ? count : `up to ${count}`} missing (seq ${g.from}–${g.to}: ${describeGap(g.reason)}) …]`;
}

const gapOf = (g: Gap): GapInfo => ({ from: g.from, to: g.to, reason: g.reason, ...(g.exact && { exact: true as const }) });

/**
 * A hole a read inferred (retention took it), counted exactly when the journal's history says every seq of it
 * was issued (RunIndex.countsExactly), and as a bound otherwise: a reservation's skipped seqs may have aged
 * out among the events around them.
 */
const vouched = (journal: Journal, g: GapInfo): GapInfo => (g.exact === undefined && journal.runs.countsExactly(g.from, g.to) ? { ...g, exact: true } : g);

/**
 * Add a hole to those a scan reports, as one with a reported hole of its reason that it overlaps. Before the store
 * heals, a read shows a lost stretch as a gap seated at its last seq, and the catch-up then records it at a new seq,
 * with the same range or one grown since: a search that yields between its batches met both, and reported one hole
 * twice (an independent read of the fixes for the review of f3750e4, PR #22, its question 1). Matched by range rather than by marking the read's
 * gap provisional: the recorded gap carries the stretch's range, reason and count, so any reader can tell the two
 * apart from other holes, and no event or result gains a mark.
 */
function addHole(gaps: GapInfo[], g: GapInfo): void {
  // Every entry of its reason that the hole meets merges with it: one recorded range can span several the reads
  // showed (lost-range compaction), and merged into the first alone, it left the others beside it (our read of
  // the 40 commits, PR #22).
  const meets = (h: GapInfo) => h.reason === g.reason && h.from <= g.to && g.from <= h.to;
  const same = gaps.filter(meets);
  if (!same.length) {
    gaps.push(g);
    return;
  }
  const into = same[0]!;
  for (const h of [g, ...same.slice(1)]) {
    into.from = Math.min(into.from, h.from);
    into.to = Math.max(into.to, h.to);
    if (!h.exact) delete into.exact;
  }
  for (const h of same.slice(1)) gaps.splice(gaps.indexOf(h), 1);
}

/** Report the holes a result spans: the first as `gap`, all of them as `gaps` when there are several. */
function withGapInfo<R extends { gap?: GapInfo; gaps?: GapInfo[] }>(r: R, gaps: GapInfo[]): R {
  // In seq order, as the text shows them: a result of each kind lists one page's holes alike.
  const ordered = gaps.length > 1 ? [...gaps].sort((a, b) => a.from - b.from) : gaps;
  if (ordered.length) r.gap = ordered[0]!;
  if (ordered.length > 1) r.gaps = ordered;
  return r;
}

/** Header lines for pages that hold more than one source (§6 rule 6). */
/** The header line naming a source in a page of several (§6 rule 6): no line of output, so `tail` does not count it. */
export const sourceHeader = (s: SourceInfo): string => (s.stream === 'pty' ? '[terminal]' : `[run ${s.runId ?? '?'}]`);
const label = sourceHeader;

/**
 * Whether a line of a page's text is a source's header, for a reader of the text that does not know its
 * sources (the compat pack's logs): by sourceHeader's shape. A program's line of that shape counts as a
 * header, which only shows one line more, or makes a page of what came before repeat one.
 */
export const isSourceHeader = (line: string): boolean => line === sourceHeader({ stream: 'pty' }) || /^\[run [^\s\]]+\]$/.test(line);
const sourceKey = (e: Output) => (e.stream === 'pty' ? 'pty' : `p:${e.runId ?? ''}`);
const chunkOf = (e: Output, data = e.data): ProjectChunk => ({ data, stream: e.stream, ...(e.runId !== undefined ? { runId: e.runId } : {}) });

/** A piece of a page: an output event (or its part from `start` bytes on), or a hole. */
/** `ends`: the line ends in `data` (lineEnds), read from the page's start, which lies outside every control sequence. */
/** `kept`: in a shell Run's page, the parts of `data` that are the Run's own (runKept); absent when all of it is. */
type OutPiece = { kind: 'out'; ev: Output; data: string; start: number; bytes: number; ends: number[]; kept?: Array<[number, number]> };
/** A hole's piece; `atStart`: inferred at the range's start (retention), with no event seated at `seq`. */
type GapPiece = { kind: 'gap'; seq: Seq; gap: GapInfo; atStart?: true };
type Piece = OutPiece | GapPiece;

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
const gapEvent = (g: GapInfo): Gap => ({ type: 'gap', seq: g.to, ts: Date.now(), from: g.from, to: g.to, reason: g.reason, ...(g.exact && { exact: true as const }) });

/**
 * The parts of a hole a read inferred that no recorded gap the same result reports already covers,
 * in order; empty when nothing of it is left. A recovery hole stands in the journal as a
 * `store-failed` gap event right after it, and when that event heads what is retained, the range
 * before it reads as `retention` too, so the one hole would be reported twice, first under the wrong
 * reason (the house's read of 78c4d6e, #22). A recorded range can lie inside the inferred one: a
 * store-error gap is issued after the events caught up from the ring, so once retention takes those
 * too, the inferred hole runs past the recorded range on both sides, and both pieces are kept. The
 * recorded gaps are the holes the result reports, each seated where it is, whichever page holds its
 * event (the house's read of the 38 commits, #22, comment 6274935728, items 3 and 4, and its review of
 * f3750e4..4f4c067, comment 6315636412, question 5). Each part is counted exactly where the journal's
 * history vouches for it (`vouched`).
 */
const uncovered = (journal: Journal, gap: GapInfo, recorded: Iterable<GapInfo>): GapInfo[] => minusRanges([gap], recorded).map((g) => vouched(journal, g));

/** The recorded holes among events. */
const recordedIn = (events: Iterable<JournalEvent>): GapInfo[] => [...events].filter(isGap).map(gapOf);

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
  // The hole is left whole here: each result takes from it what the recorded gaps it returns report (uncovered).
  if (o.until !== undefined) end = Math.min(end, o.until);
  /**
   * Holes have been reported through this seq. Not through the inferred one at the start: a hole the journal knows
   * there is reported, and the inferred one only for what that leaves (uncovered).
   */
  let reported = from - 1;
  /**
   * The holes placed so far, by range: a hole wider than a batch (one joined past MAX_LOST spans events) is in each
   * batch it meets, seated where that batch's cover ends, so by its seat alone a text read printed it once per batch
   * (the house's review of 4f4c067..a8b6f28, PR #22).
   */
  const placed = new Set<string>();
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
      // A batch's holes are its `gaps`, every hole that meets the seqs it covers, each seated where it is, for a
      // session's reads as for a Run's; not the gap events it holds, which may name a hole elsewhere, and miss one
      // recorded past the batch or past `until` (the house's review of f3750e4..4f4c067, PR #22, comment 6315636412,
      // question 5). Each is placed among the events once; after the last one, they reach to the range's end.
      const events: JournalEvent[] = r.events.filter((e) => !isGap(e));
      const holes = r.gaps ?? [];
      // Events gone since the walk began (retention while a search yielded) are a hole, not a seam
      // to join lines across: a gap event stands where they were (the house's read of 1cabc6a, #22).
      const inferred = !resumed ? undefined : 'truncated' in r ? retentionGap(journal, (cursor ?? 0) + 1, Math.min(end, events[0] ? events[0].seq - 1 : end)) : r.gap;
      const lost = inferred ? minusRanges([inferred], recordedIn(holes)) : [];
      events.unshift(...lost.filter((g) => g.to > reported).map((g) => gapEvent(vouched(journal, { ...g, from: Math.max(g.from, reported + 1) }))));
      const upTo = done ? end : (r.events[r.events.length - 1]?.seq ?? reported);
      for (const g of holes) {
        const range = `${g.from}-${g.to}`;
        if (g.seq > reported && g.seq <= upTo && !placed.has(range)) {
          placed.add(range);
          events.push(g);
        }
      }
      events.sort((a, b) => a.seq - b.seq);
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
  if (o.untilOffset !== undefined && (o.tail === undefined || o.until === undefined || o.as === 'events' || o.as === 'raw')) {
    throw err('invalid_argument', 'untilOffset goes with a text tail and until: pass a tail result’s lines.before.until and lines.before.untilOffset as until and untilOffset, beside tail');
  }
  if (o.as === 'raw' && o.tail !== undefined) throw err('invalid_argument', 'a raw read pages head first: pass since, not tail');
  if (o.tail !== undefined) return res(await tailRead(src, o, maxBytes, geometry, run));
  if (o.as === 'events') return res(eventsPage(src, o, maxBytes));
  if (o.as === 'raw') return res(rawPage(src, o, maxBytes, run));
  return res(await textPage(src, o, maxBytes, geometry, run));
}

// ───────────── head-first text pages ─────────────

async function textPage(src: ReadSource, o: ReadOptions, maxBytes: number, geometry: { cols: number; rows: number }, run: RunInfo | undefined): Promise<Omit<ReadResult, 'session'>> {
  const journal = src.journal;
  const w = walk(src, o);
  const start = o.since ?? 0;
  // Collect the page's candidates: output (the first from `offset` on), holes; enough input for the largest page tried.
  const pieces: Piece[] = [];
  if (w.gap) pieces.push({ kind: 'gap', seq: start, gap: w.gap, atStart: true });
  let bytes = 0;
  let examined = 0;
  let lastExamined = start;
  let exhausted = false;
  /** Per source, what its pieces left unfinished for the line-end rule (lineEnds). */
  const carries = new Map<string, LineCarry>();
  /** The head of the CSI or escape sequence that `offset` falls inside (headAt), which the page goes on from. */
  let head = '';
  // A control sequence left open where collecting would stop is collected to its end (within
  // OPEN_SEQUENCE_BYTES), so no page has to end inside it. Whether some source's output ends inside one
  // is what its line carry holds, at no cost per event: a scan of the collected output for an open
  // sequence, run again at each event that might have ended it, held the event loop for minutes on a
  // string left open across thousands of small events, each holding a BEL that ends no DCS or APC, or
  // each opening a string of its own (an independent read of the house's fixes for #22). A hole ends
  // every sequence, as it clears the carries.
  const full = () => {
    if (bytes <= maxBytes) return false;
    if (bytes > maxBytes + OPEN_SEQUENCE_BYTES) return true;
    for (const c of carries.values()) if (c.open) return false;
    return true;
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
        pieces.push({ kind: 'gap', seq: e.seq, gap: gapOf(e) });
        carries.clear(); // a hole ends every sequence
      } else if (isOutput(e)) {
        // The event after `since` is read from `offset` on.
        const from = o.since !== undefined && e.seq === o.since + 1 ? indexAtByte(e.data, o.offset ?? 0) : 0;
        const data = e.data.slice(from);
        if (!data) continue;
        const b = utf8Length(data);
        const key = sourceKey(e);
        let carry = carries.get(key);
        if (!carry) carries.set(key, (carry = lineCarry()));
        if (from > 0) {
          // A page from an offset inside a sequence a LF ran through (search reports a line that begins after
          // such a LF there) goes on inside it: the sequence's head comes before the page, in the line-end rule
          // and in the projection, so its rest applies as the emulator applied it, not as `1mB` (our read of
          // the fix for the line-end rule's two remaining cases, PR #22).
          head = headAt(e.data, from);
          if (head) carry.open = head;
        }
        pieces.push({ kind: 'out', ev: e, data, start: utf8Length(e.data.slice(0, from)), bytes: b, ends: lineEnds(data, carry) });
        bytes += b;
      }
    }
  }
  // A shell Run's page shows the Run's own output, its plumbing cut (runKept); the cursors stay the journal's.
  const of = plumbingOf(o, run);
  if (of) {
    const outs = pieces.map((q) => (q.kind === 'out' ? q : undefined));
    runKept(src, o.runId!, of, outs.map((q) => q && { ev: q.ev, from: indexAtByte(q.ev.data, q.start), data: q.data })).forEach((k, i) => {
      if (k) outs[i]!.kept = k;
    });
  }
  // Whether events of the range remain after everything collected (the scan stopped early).
  const scanCut = !exhausted;
  const rangeEnd = exhausted ? Math.max(lastExamined, w.end) : lastExamined;
  // The hole inferred at the page's start, less what the holes the journal knows there say, each part where it lies
  // among them: a recorded hole is seated where it is, inside the inferred one, and its line goes in seq order.
  const lead = pieces[0];
  if (lead?.kind === 'gap' && lead.atStart) {
    const known = pieces.flatMap((q) => (q.kind === 'gap' && !q.atStart ? [q.gap] : []));
    let k = 1;
    while (pieces[k]?.kind === 'gap' && (pieces[k] as GapPiece).seq <= lead.gap.to) k++;
    const parts: GapPiece[] = uncovered(journal, lead.gap, known).map((g) => ({ kind: 'gap', seq: g.to, gap: g, atStart: true }));
    pieces.splice(0, k, ...[...parts, ...(pieces.slice(1, k) as GapPiece[])].sort((a, b) => a.seq - b.seq));
  }

  // Fit: choose input for at most `budget` bytes, project, and take less input while
  // the text is over maxBytes (never cut the head of a head-first page: er-1, ux-1).
  const open = rangeOpen(src, o, run);
  const hold = open && !scanCut;
  // Lasting terminal state set before the page (a scroll region, the alternate screen, modes)
  // still applies to it: a page deep in apt's output keeps apt's scroll region (§6 rule 7, er-2).
  const firstOut = pieces.find((q): q is OutPiece => q.kind === 'out');
  const state = firstOut && o.since !== undefined ? stateBefore(src, o, firstOut.ev, firstOut.start) + head : '';
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
  return withGapInfo(r, chosen.gaps);
}

/**
 * What a shell Run's output holds besides its command's, from its record: the strategy, nonce and shell its
 * run.start recorded (core/plumbing.ts), for a read of that Run; undefined for a read that cuts nothing (the
 * session's, as the terminal showed it; a process Run's; a rich shell Run's, whose marks are no output). A Run
 * journaled before the recording is cut by shape, as history renders it (segmenter.ts journalRunText).
 */
function plumbingOf(o: ReadOptions, run: RunInfo | undefined): PlumbingOf | undefined {
  if (o.runId === undefined || run?.target !== 'shell' || run.strategy === 'rich') return undefined;
  return { strategy: run.strategy, nonce: run.nonce, pid: run.shellPid !== undefined ? String(run.shellPid) : undefined };
}

/** A Run's output before a stretch it is cut with: from the Run's head when that lies within this many bytes, so its typed line's echo and start mark are the cutter's. */
const CUT_HEAD = 64 * 1024;
/** A Run's output after a stretch it is cut with, at least: a mark or a struck line that a page or a tail ends inside is whole to the cutter. */
const CUT_AHEAD = 4 * 1024;

/** A piece of a Run's output to cut: event `ev`'s data from character `from` on, `data` long. */
interface CutPiece {
  ev: Output;
  from: number;
  data: string;
}

/**
 * Which characters of each piece are the Run's own, by the core's one cutter (plumbing.ts keptRanges), so a
 * shell Run's pages and tails show what its own result shows: under the marker strategy without the typed
 * line's echo, the start and end marks and the prompt the shell printed after the end, under a declared
 * shell's without its end mark, and without the lines a cancel's probe left. Read through `read {runId}`,
 * and the compat pack's runCommand with it, a Run showed all of them (our read of the house's fixes for its
 * review of f3750e4, PR #22; older than them). `pieces` holds the read's output in order, undefined at a
 * hole: each stretch between holes is cut with the Run's output around it, back to the Run's head when that
 * lies within CUT_HEAD (else as far, and as output read from after the Run's start: what the cutter takes
 * from the head of such a stretch, a line in the typed line's echo's shape, is the program's), and CUT_AHEAD
 * past it, each up to a hole. Returns, per piece, its kept ranges (character indices into its data), or
 * undefined when all of it is kept. The cut is made on the text; the read's cursors stay journal positions.
 */
function runKept(src: ReadSource, runId: string, of: PlumbingOf, pieces: Array<CutPiece | undefined>): Array<Array<[number, number]> | undefined> {
  const out: Array<Array<[number, number]> | undefined> = pieces.map(() => undefined);
  for (let i = 0; i < pieces.length; ) {
    if (!pieces[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < pieces.length && pieces[j]) j++;
    const stretch = pieces.slice(i, j) as CutPiece[];
    const first = stretch[0]!;
    const last = stretch[stretch.length - 1]!;
    const back = src.runOutput(runId, { until: first.ev.seq - 1, maxBytes: CUT_HEAD });
    const holeEnd = Math.max(-1, ...(back.gaps ?? []).map((g) => g.to));
    const before = back.events.filter((e): e is Output => isOutput(e) && e.seq > holeEnd).map((e) => e.data).join('') + first.ev.data.slice(0, first.from);
    let after = last.ev.data.slice(last.from + last.data.length);
    // Paged on to CUT_AHEAD, a hole or the Run's end: one page of 32 events, in output that came a few bytes at a
    // time, fell short of it, and a probe's echo split past it showed its head (our read of the 40 commits, PR #22).
    for (let since = last.ev.seq; after.length < CUT_AHEAD; ) {
      const fwd = src.runOutput(runId, { since, limit: 512 });
      const holeStart = Math.min(Number.POSITIVE_INFINITY, ...(fwd.gaps ?? []).map((g) => g.from));
      let stop = !fwd.more;
      for (const e of fwd.events) {
        if (!isOutput(e) || e.seq >= holeStart) {
          stop = true;
          break;
        }
        after += e.data;
        since = e.seq;
        if (after.length >= CUT_AHEAD) break;
      }
      if (stop || fwd.events.length === 0) break;
    }
    // Read from the Run's head unless retention, a hole or the bound cut what came before.
    const atHead = !back.truncated;
    const text = before + stretch.map((p) => p.data).join('') + after;
    // Not from its head, a marker or declared shell's Run is cut after a start mark of its own nonce (and shell pid),
    // as all its output after its head is: the cutter then strikes what the Run's own result strikes there and keeps
    // an echo-shaped line of the program's. Taking back whatever it struck ahead of its first kept range showed a
    // cancel's probe echo after a hole (our read of the 40 commits, PR #22); that stays only for a Run with no
    // recorded nonce, or a declared shell's with no recorded pid, whose answers are judged by it.
    // A stretch that holds the Run's own start mark (a hole between the typed line's echo and it) is cut at that one,
    // with nothing taken back: a mark put ahead of it was found first, and the real mark's line read as output (an
    // independent read of the fixes for the review of the 40 commits, PR #22).
    const ownMark = of.nonce !== undefined && startMark(of.nonce).test(text);
    const mark = !atHead && !ownMark && of.nonce !== undefined && (of.strategy === 'marker' || (of.strategy === 'inline' && of.pid !== undefined)) ? `<<<START:${of.nonce}:${of.pid ?? '0'}>>>\n` : '';
    let kept: Array<[number, number]>;
    if (mark) {
      kept = keptRanges(mark + text, { ...of, truncated: true }).flatMap(([a, b]): Array<[number, number]> => (b > mark.length ? [[Math.max(0, a - mark.length), b - mark.length]] : []));
    } else {
      kept = keptRanges(text, { ...of, truncated: !atHead });
      if (!atHead && !ownMark && kept.length && kept[0]![0] > 0) kept = [[0, kept[0]![1]], ...kept.slice(1)];
    }
    let at = before.length;
    stretch.forEach((p, k) => {
      const lo = at;
      at += p.data.length;
      const parts: Array<[number, number]> = [];
      for (const [a, b] of kept) if (Math.min(b, at) > Math.max(a, lo)) parts.push([Math.max(a, lo) - lo, Math.min(b, at) - lo]);
      if (parts.length !== 1 || parts[0]![0] !== 0 || parts[0]![1] !== p.data.length) out[i + k] = parts;
    });
    i = j;
  }
  return out;
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
  /** The holes the page reports, in order: the leading one less what the recorded holes taken report (uncovered), then those. */
  gaps: GapInfo[];
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
    else if (isIntroducer(c)) {
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
    // The last line end within the budget: after a whole event, or inside one. Line ends are the one
    // rule's (lineEnds): a page cut at a LF inside a window title began the next page with the title's
    // rest as text (an independent read of the fix for the house's read of the 33 commits, #22, comment
    // 6307350650).
    let boundary = k - 1;
    while (boundary >= 0 && !endsWithLine(out(boundary))) boundary--;
    let inside: Pos | undefined;
    const nl = lastEndBefore(crossing.ends, room);
    if (nl !== -1) inside = { j: k, at: nl + 1 };
    for (let i = k - 1; i > boundary && !inside; i--) {
      const n2 = lastEndBefore(out(i)?.ends ?? [], Number.POSITIVE_INFINITY);
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
      const e = isIntroducer(c0) ? sequenceEnd(fwd.text, 0) : 0;
      if (e === undefined) {
        // It does not end in what was collected: all of it, or up to the hole that ends it.
        const hole = pieces.findIndex((q, i) => i > first && q.kind === 'gap');
        end = hole === -1 ? pieces.length : hole + 1;
        cut = undefined;
      } else {
        const after = headIndex(fwd.text.slice(e), budget);
        const n3 = lastEndBefore(lineEnds(fwd.text.slice(0, e + after)), e + after);
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
    partial = { ...pc, data, bytes: utf8Length(data), ends: pc.ends.filter((e) => e < cut!.at) };
    end = cut.j;
  }
  const taken = pieces.slice(0, end);
  if (partial) taken.push(partial);
  const chunks: ProjectChunk[] = [];
  /** Per source: whether a line ended in what it took, and its data after its last line end. */
  const lastBySource = new Map<string, { ended: boolean; tail: string }>();
  const sources = new Set<string>();
  const c: Chosen = { chunks, labelled: false, inputBytes: 0, taken: end, gaps: [], midLine: false, held };
  for (const pc of taken) {
    if (pc.kind === 'gap') {
      chunks.push({ note: gapNote(pc.gap) });
      c.gaps.push(pc.gap);
      if (!pc.atStart) c.lastSeq = pc.seq;
      lastBySource.clear(); // a hole ends every line
      continue;
    }
    chunks.push(chunkOf(pc.ev, pc.kept ? pc.kept.map(([a, b]) => pc.data.slice(a, b)).join('') : pc.data));
    const key = sourceKey(pc.ev);
    sources.add(key);
    const prior = lastBySource.get(key);
    const lastEnd = pc.ends[pc.ends.length - 1];
    lastBySource.set(key, lastEnd !== undefined ? { ended: true, tail: pc.data.slice(lastEnd + 1) } : { ended: prior?.ended ?? false, tail: (prior?.tail ?? '') + pc.data });
    c.firstSeq ??= pc.ev.seq;
    c.lastSeq = pc.ev.seq;
    c.inputBytes += pc.bytes;
  }
  c.labelled = sources.size > 1;
  c.midLine = [...lastBySource.values()].some((d) => !d.ended || !onlyControls(d.tail));
  // The page ends inside an event: in the part it took, or where the first piece began (a page that took
  // nothing of the event it was continuing keeps the offset it was given).
  const rest = partial ?? (pieces[end]?.kind === 'out' && (pieces[end] as OutPiece).start > 0 ? { ...(pieces[end] as OutPiece), bytes: 0 } : undefined);
  if (rest) {
    c.nextSeq = rest.ev.seq;
    c.nextOffset = rest.start + rest.bytes;
  }
  return c;
}

/** The last line end in `ends` before index `before`; -1 when none. */
function lastEndBefore(ends: readonly number[], before: number): number {
  for (let k = ends.length - 1; k >= 0; k--) if (ends[k]! < before) return ends[k]!;
  return -1;
}

/** The piece ends with a line end. */
const endsWithLine = (pc: OutPiece | undefined): boolean => pc !== undefined && pc.ends[pc.ends.length - 1] === pc.data.length - 1;

/** `d`, what follows a line's end, holds only carriage returns and control sequences: the line has ended. */
function onlyControls(d: string): boolean {
  let i = 0;
  while (i < d.length) {
    const c = d.charCodeAt(i);
    const e = c === 0x0d ? i + 1 : isIntroducer(c) ? sequenceEnd(d, i) : undefined;
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
 * A session's look-back also stops after MAX_SCAN journal events, output or
 * not, so many small events end it before the bytes do (40,000 events of 8 bytes
 * are 320 KB): state set before them is not applied.
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
      bytes += b;
    }
  }
  const next = more ? page[page.length - 1]!.seq : Math.max(w.end, page[page.length - 1]?.seq ?? start);
  const r: Omit<ReadResult, 'session'> = { events: page, seq: [page[0]?.seq ?? start + 1, next], nextCursor: Math.min(next, journal.lastSeq), more, truncated: false };
  const recorded = recordedIn(page);
  return withGapInfo(r, [...(w.gap ? uncovered(journal, w.gap, recorded) : []), ...recorded]);
}

/**
 * A raw page: the output of the events page `o` reads, its data joined as written, and for a shell Run's read
 * the Run's own (runKept), so its raw output and its text agree on what is the Run's. The compat pack's raw
 * runCommand output ran a second cutter, over the whole Run in memory, beside the one the reader runs (an
 * independent read of the fixes for the review of f3750e4, PR #22). A hole's note (gapNote) stands on a line of its own where the
 * hole lies, as a text page shows it: the raw output joined output across a hole with nothing to say so, the
 * hole only in `gap`/`gaps`, which compat's raw path does not show (an independent read of the fixes for the review of f3750e4,
 * PR #22; older than them). A note that begins a page after the range's start takes a line end before it, as
 * what the page before ended with is not known here: at worst a blank line, never a note joined to output.
 */
function rawPage(src: ReadSource, o: ReadOptions, maxBytes: number, run: RunInfo | undefined): Omit<ReadResult, 'session'> {
  const { events = [], ...page } = eventsPage(src, o, maxBytes);
  const outs = events.map((e) => (isOutput(e) ? e : undefined));
  const of = plumbingOf(o, run);
  const kept = of ? runKept(src, o.runId!, of, outs.map((e) => e && { ev: e, from: 0, data: e.data })) : [];
  let text = '';
  const note = (g: GapInfo) => {
    text += `${(text === '' ? o.since !== undefined : !text.endsWith('\n')) ? '\n' : ''}${gapNote(g)}\n`;
  };
  // A hole the page infers at its start (retention) is reported beside its events, not among them: its note leads.
  const recorded = new Set(events.filter(isGap).map((e) => `${e.from}:${e.to}`));
  for (const g of page.gaps ?? (page.gap ? [page.gap] : [])) if (!recorded.has(`${g.from}:${g.to}`)) note(g);
  events.forEach((e, i) => {
    if (isGap(e)) note(gapOf(e));
    else if (isOutput(e)) text += kept[i]?.map(([a, b]) => e.data.slice(a, b)).join('') ?? e.data;
  });
  return { ...page, text };
}

// ───────────── tail ─────────────

async function tailRead(src: ReadSource, o: ReadOptions, maxBytes: number, geometry: { cols: number; rows: number }, run: RunInfo | undefined): Promise<Omit<ReadResult, 'session'>> {
  const journal = src.journal;
  const n = clamp(o.tail!, 1, 10_000);
  // Input with enough line ends for the last n lines, and room for a screenful of redraw (§6 rule 7).
  const need = n + 2 * geometry.rows + 1;
  // Input projected at most: never less than the result may hold, so a page of long lines is whole.
  const cap = Math.max(256 * 1024, n * 400, maxBytes);
  // A tail of what came before an earlier tail's lines ends inside the event `until`, after `untilOffset`
  // of its bytes (ReadResult.lines.before): the event is cut there, and the result continues from there.
  let clipped = false;
  const clip = (evs: JournalEvent[]): JournalEvent[] =>
    o.untilOffset === undefined
      ? evs
      : evs.flatMap((e) => {
          if (e.seq !== o.until || !isOutput(e)) return [e];
          const data = e.data.slice(0, indexAtByte(e.data, o.untilOffset!));
          if (data.length < e.data.length) clipped = true;
          return data ? [{ ...e, data }] : [];
        });
  let events: JournalEvent[];
  let end: Seq;
  /** The output events read, before `clip` cut the event `until` (a Run's window). */
  let whole: ReadonlyMap<Seq, Output> | undefined;
  /** Output of the range older than what was fetched exists, or existed and is gone. */
  let older: boolean;
  /** The range's first seq: after `since`, and not before a Run's first. */
  let rangeStart = (o.since ?? 0) + 1;
  /** The holes the window spans: retention's at the range's start when the window reaches it, then the gap events among the window's events. */
  const gaps: GapInfo[] = [];
  // The window has enough once its line ends (lineEnds, the one rule) reach `need`: a LF in a string's payload
  // ends no line, and counting it stopped the walk short, or inside the string, whose payload then showed as
  // output (the house's read of the 40 commits, #22). Raw LFs, cheap to count, bound it from above. An events tail
  // has enough once it holds the events it can return: sized by line ends, a tail of 10 over events with none
  // walked to MAX_SCAN (our read of the 40 commits, PR #22).
  const enough = (evs: JournalEvent[], raw: number, olderBefore: boolean): boolean =>
    o.as === 'events' ? evs.length >= Math.min(n, 2000) : raw >= need && windowEnds(src, o, evs, olderBefore) >= need;
  if (o.runId !== undefined) {
    let want = Math.min(cap, 64 * 1024);
    let ro: RunOutput;
    let got: JournalEvent[] = [];
    for (;;) {
      ro = src.runOutput(o.runId, rangeOf(o.since, o.until, { maxBytes: want }));
      got = clip(ro.events);
      const raw = got.reduce((a, e) => a + (isOutput(e) ? countLines(e.data) : 0), 0);
      if (!ro.older || want >= cap || enough(got, raw, true)) break;
      want = Math.min(cap, want * 4);
    }
    end = o.until !== undefined ? Math.min(ro.to, o.until) : ro.to;
    rangeStart = Math.max(rangeStart, ro.from);
    older = ro.older === true;
    whole = new Map(ro.events.filter(isOutput).map((e) => [e.seq, e]));
    events = [...got, ...(ro.gaps ?? [])].sort((a, b) => a.seq - b.seq);
    // Nothing of the range retained: the hole is the range (the house's read of 1cabc6a, #22), less what a recorded gap already says.
    const inferred = ro.truncated && ro.events.length === 0 ? retentionGap(journal, rangeStart, end) : undefined;
    if (inferred) events = [...events, ...uncovered(journal, inferred, recordedIn(events)).map(gapEvent)].sort((a, b) => a.seq - b.seq);
  } else {
    // Walk back from the end until the lines, the byte cap, the event bound, `since` or retention stops it.
    end = o.until !== undefined ? Math.min(o.until, journal.lastSeq) : journal.lastSeq;
    let cursor = end;
    let raw = 0;
    let bytes = 0;
    let examined = 0;
    const parts: JournalEvent[][] = [];
    older = false;
    /** What retention took of the range's start, when the walk reached it. */
    let inferred: GapInfo | undefined;
    /** The walk reached the range's start: the window covers the seqs from there. */
    let reached = false;
    // The window's events with its holes, every one that meets the seqs it covers, each where it is (Journal.holesIn),
    // in place of the gap events it holds, as the pages have them (the house's review of f3750e4..4f4c067, PR #22,
    // comment 6315636412, question 5): a tail with `until` inside a hole showed none of it.
    const seated = (evs: JournalEvent[], from: Seq): JournalEvent[] => {
      const holes = journal.holesIn(from, end, evs);
      const rest = evs.filter((e) => !isGap(e));
      return holes.length ? [...rest, ...holes].sort((a, b) => a.seq - b.seq) : rest;
    };
    for (;;) {
      if (o.since !== undefined && cursor <= o.since) {
        reached = true;
        break;
      }
      const fetched = journal.tail(512, cursor).filter((e) => o.since === undefined || e.seq > o.since);
      if (fetched.length === 0) {
        // The range's start: what retention took of it is a hole, all of it when nothing is retained.
        inferred = retentionGap(journal, (o.since ?? 0) + 1, cursor);
        if (inferred) older = true;
        reached = true;
        break;
      }
      const batch = clip(fetched);
      parts.push(batch);
      examined += fetched.length;
      for (const e of batch) {
        if (!isOutput(e)) continue;
        raw += countLines(e.data);
        bytes += e.data.length;
      }
      cursor = fetched[0]!.seq - 1;
      const sofar = [...parts].reverse().flat();
      // Nothing so far is never enough: a tail ending at offset 0 of the journal's first event clips its only batch
      // to nothing, and seating it read `sofar[0]` (an independent read of the fixes for the review of the 40
      // commits, PR #22).
      if (bytes >= cap || examined >= MAX_SCAN || (sofar.length > 0 && enough(seated(sofar, sofar[0]!.seq), raw, cursor > (o.since ?? 0)))) {
        older = cursor > (o.since ?? 0);
        break;
      }
    }
    const window = parts.reverse().flat();
    events = seated(window, reached ? rangeStart : (window[0]?.seq ?? end + 1));
    // Less what the window's holes already record, each part where it lies among them.
    if (inferred) events = [...events, ...uncovered(journal, inferred, recordedIn(events)).map(gapEvent)].sort((a, b) => a.seq - b.seq);
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
    // A hole among them took events that were asked for, as retention does (see the text's rule below).
    const truncated = (ev.length < n && (older || ev.length < events.length)) || ev.some(isGap);
    const r: Omit<ReadResult, 'session'> = { events: ev, seq: [ev[0]?.seq ?? end, end], nextCursor: end, more: false, truncated, lines: { requested: n, returned: ev.length } };
    return withGapInfo(r, ev.filter(isGap).map(gapOf));
  }
  const chunks: ProjectChunk[] = [];
  const sources = new Set<string>();
  /** What the text is made of, in order: output, and the notes (a hole, a command); where the lines shown begin is counted over it. */
  const items: TextItem[] = [];
  // The lasting state set before the window (a scroll region, the alternate screen) applies to it.
  const firstOut = events.find(isOutput);
  if (older && firstOut) {
    const state = stateBefore(src, o, firstOut);
    if (state) chunks.push(chunkOf(firstOut, state));
  }
  const notes = new Set<string>();
  /** The notes of holes, a subset of `notes`. */
  const holes = new Set<string>();
  /** Per source, what its last event left unfinished for the line-end rule (lineEnds); a note ends it all, as the projection's CAN does. */
  const carries = new Map<string, LineCarry>();
  // A window that begins inside a control string a source left open reads as the output did: the string goes
  // on, its payload's LFs end no line, and the projection shows none of it (openBefore). So for every source, at
  // its first output in the window, seeded just ahead of it: seeded for the first source alone, another's title
  // left open showed its payload as lines (our read of the 40 commits, PR #22). A note ahead of a source's first
  // output ends the string first. What every source left open is read in one walk (opensBefore).
  let noted = false;
  const opens = older ? opensBefore(src, o, events) : undefined;
  const seed = (e: Output, key: string) => {
    if (noted || sources.has(key)) return;
    const open = opens?.get(key);
    if (!open) return;
    chunks.push(chunkOf(e, open));
    carries.set(key, { open });
  };
  const note = (e: JournalEvent, text: string) => {
    noted = true;
    chunks.push({ note: text });
    // A command's line can hold newlines: each of its lines is a line of the text, none with a head to cut.
    // Only its first line can begin the lines shown (wholeNote; a byte cut that drops lines sets `cutHead`
    // by its own rule), so only that one is kept to tell a first line that is a note from output. Every line
    // kept, a head-cut first line of output that read like a later one (`done` under a three-line `for`)
    // lost its `cutHead` and `head` (our read of the house's fixes for its review of f3750e4, PR #22: fbadcf1).
    const lines = text.split('\n');
    notes.add(lines[0]!);
    items.push({ ev: e, lines: lines.length });
    carries.clear();
  };
  // A shell Run's tail shows the Run's own output, its plumbing cut (runKept): each event's kept parts are items
  // of their own, so where the lines shown begin is a position in the journal still.
  const of = plumbingOf(o, run);
  const ownParts = new Map<JournalEvent, Array<[number, number]> | undefined>();
  if (of) {
    const outs = events.map((e) => (isOutput(e) ? e : undefined));
    runKept(src, o.runId!, of, outs.map((e) => e && { ev: whole?.get(e.seq) ?? e, from: 0, data: e.data })).forEach((k, i) => ownParts.set(events[i]!, k));
  }
  for (const e of events) {
    if (isGap(e)) {
      gaps.push(gapOf(e));
      const line = gapNote(gapOf(e));
      holes.add(line);
      note(e, line);
    } else if (isOutput(e)) {
      const key = sourceKey(e);
      seed(e, key);
      sources.add(key);
      let carry = carries.get(key);
      if (!carry) carries.set(key, (carry = lineCarry()));
      for (const [a, b] of ownParts.get(e) ?? [[0, e.data.length]]) {
        const data = e.data.slice(a, b);
        chunks.push(chunkOf(e, data));
        const item: TextItem = { ev: e, key, data, ...interleaveCut(data, carry) };
        if (a > 0) item.skip = a;
        if ((clipped && e.seq === o.until) || b < e.data.length) item.clipped = true;
        items.push(item);
      }
    } else if (o.commands && e.type === 'run.start' && e.line !== undefined) {
      note(e, `$ ${e.line}`);
    }
  }
  const multi = sources.size > 1;
  const projectTail = async (maxLines: number): Promise<string[]> => {
    const opts: Parameters<typeof project>[1] = { cols: geometry.cols, rows: geometry.rows, maxInputBytes: cap, keep: 'tail', maxLines };
    if (multi) opts.label = label;
    const p = await project(chunks, opts);
    return p.text === '' ? [] : p.text.split('\n');
  };
  // The header lines naming the sources (§6 rule 6) are no line of output: `tail: N` counts output lines, as the
  // projection's maxLines does, and headers come extra (an independent read of the fix for the house's read of
  // the 33 commits, #22, comment 6307350650: "3 of 1 lines", and a tail of 5 across two sources showed 4).
  const headers = new Set([...sources].map((k) => sourceHeader(k === 'pty' ? { stream: 'pty' } : { stream: 'stdout', ...(k.slice(2) ? { runId: k.slice(2) } : {}) })));
  // maxBytes drops whole lines from the head, keeping at least the last `keepLines`; a line over it keeps its end.
  // The header naming the first line kept stays with it, wherever it sat, as the projection keeps it (c050928),
  // and the byte cut leaves room for it: dropped for bytes, or cut away with the head of a line longer than the
  // cap, it left that line nobody's, and counted as a line dropped ahead of it, it hid that the line had lost its
  // head (`tail: 3` over a Run's line longer than the cap read `zzz…`, unnamed, with no cutHead: our read of the
  // house's fixes for its review of f3750e4, PR #22). `kept` is then the lines after it, and `drop` counts the
  // lines of output dropped.
  const fit = (lines: string[], keepLines: number) => {
    let bytes = utf8Length(lines.join('\n'));
    const cutByBytes = bytes > maxBytes;
    let drop = 0;
    while (lines.length - drop > Math.max(1, keepLines) && bytes > maxBytes) bytes -= utf8Length(lines[drop++]!) + 1;
    // The first line of output kept: past a header just before it, which is then the one that names it.
    const first = multi && lines.length - drop > 1 && headers.has(lines[drop]!) ? drop + 1 : drop;
    const kept = lines.slice(first);
    const joined = kept.join('\n');
    // The header put first names the first line the cut text shows, which the cut decides: named for the first line
    // kept before it, a cut that dropped lines across a change of source credited the line shown to the source
    // before it (`[terminal]` over a Run's line: our read of the 40 commits, PR #22). Room is kept for the longest
    // header that could be needed: the one naming the first line kept, or one among the lines kept.
    const h0 = multi ? namingHeader(lines, first, headers) : -1;
    const room = multi ? Math.max(h0 === -1 ? 0 : utf8Length(lines[h0]!) + 1, ...kept.filter((l) => headers.has(l)).map((l) => utf8Length(l) + 1)) : 0;
    const tail = cutTail(joined, room ? Math.max(1, maxBytes - room) : maxBytes);
    const dropped = joined.slice(0, joined.length - tail.text.length);
    // The line of `lines` the cut text begins in; a header it begins with whole names what follows itself.
    const at = first + countLines(dropped);
    const atStart = dropped === '' || dropped.endsWith('\n');
    const h = !multi || (atStart && headers.has(lines[at]!)) ? -1 : namingHeader(lines, at, headers);
    const named = h === -1 ? undefined : lines[h];
    const text = named === undefined ? tail.text : `${named}\n${tail.text}`;
    return { kept, drop: outputLines(lines.slice(0, drop)), cutByBytes, tail: { cut: tail.cut, text } };
  };
  const outputLines = (kept: string[]) => (multi ? kept.filter((l) => !headers.has(l)).length : kept.length);
  let all = await projectTail(n);
  let shown = fit(all, 1);
  // Fewer lines than asked is truncation only when older output was cut (by the walk's bounds, or
  // retention). So is the head of a line asked for that lies past what was projected: past the input
  // cap, or past the start of a window that older output precedes — one line longer than the cap is
  // such a line, and comes back cut with `truncated` set (the house's read of 1cabc6a, #22).
  const inputBytes = items.reduce((a, it) => a + (it.data === undefined ? 0 : utf8Length(it.data)), 0);
  const reach = lastLinesBytes(items, n);
  const headCut = reach > cap || (older && reach >= inputBytes);
  let first = end;
  let before: Position | undefined;
  let cut: Cut | undefined;
  /** The lines shown reach back to the line written last (below). */
  let reached = false;
  if (shown.kept.length > 0 && items.length > 0) {
    const display = new Display(items, multi);
    const asked = outputLines(shown.kept);
    const at = display.wholeNote(display.shownFrom(asked));
    if (at.extra > 0) {
      all = await projectTail(asked + at.extra);
      shown = fit(all, asked + at.extra);
    }
    cut = display.cutBefore(at.at);
    if (cut && cmpCut(cut, display.end) >= 0) {
      // Every line the text leaves out must lie before where the page before ends, and that page must end
      // before this one does. Unfinished lines shown after a line another source wrote later (rule 6) can
      // leave the line written last out of the text, and then no such place exists: following `before`
      // returned this page again, or two pages in turn, and lines between were never reached (the house's
      // read of the 33 commits, #22, comment 6307350650, item 1). The text then reaches back to the line
      // written last, more lines than asked for. Dropping lines for the byte cap leaves all of them; the cut to the cap can still take
      // the head of the first, or lines whole, and `head` reads on from where the page before ends, which shows them.
      const z = display.lastWritten();
      if (z.shown > n) all = await projectTail(z.shown);
      shown = fit(all, z.lines);
      cut = display.cutBefore(z.at);
      reached = true;
    }
    // Where a tail of what came before ends: right where the lines shown begin, so that every line the text
    // leaves out is whole in it; at the window's start when they reach back to it, and nothing when that is
    // the range's start (see ReadResult.lines).
    first = cut ? seqAfter(items, cut) : items[0]!.ev.seq;
    const from = cut ? positionOf(items, cut) : { until: endBefore(items[0]!.ev) };
    if (cut || (older && from.until >= rangeStart)) before = from;
  }
  const { kept, drop, cutByBytes, tail } = shown;
  const text = tail.text;
  // The lines the text shows: a byte cut can drop lines ahead of the one it cuts.
  const returned = outputLines(text === '' ? [] : text.split('\n'));
  // A hole's line among those shown stands where lines asked for were lost: the tail is incomplete, as when
  // retention cuts its head. Without it, a tail across a stretch the disk refused said nothing of it (the house's
  // review of the 40 commits through f3750e4, PR #22, comment 6310921374).
  const truncated = cutByBytes || (returned < n && older) || headCut || (text !== '' && text.split('\n').some((l) => holes.has(l)));
  const counts: NonNullable<ReadResult['lines']> = { requested: n, returned };
  if (before) counts.before = before;
  // The first line returned is cut when the byte cap cut it, or when its head lies past what was
  // projected (and no line was dropped ahead of it, and it is no note): a line dropped for bytes alone
  // set `truncated`, and said nothing of which line was cut (the house's read of the 38 commits, #22,
  // comment 6274935728, item 1). Its head is read head-first from where the page before ends. When the
  // lines shown reach back to the window's start and older output precedes it, that is where the
  // window starts, not where the line does: the read goes on from there (`begunBefore`). So it does when
  // the byte cap cuts lines reached back to: the page before ends before the line written last, and the
  // line cut may have begun ahead of that, with its head in that page.
  if (kept.length > 0 && items.length > 0 && (tail.cut || (drop === 0 && headCut && !notes.has(kept[0]!)))) {
    const from = before ?? { until: endBefore(items[0]!.ev) };
    counts.cutHead = true;
    if ((!cut && older) || (reached && tail.cut)) counts.begunBefore = true;
    counts.head = from.untilOffset !== undefined ? { since: from.until - 1, offset: from.untilOffset } : { since: from.until };
  }
  const r: Omit<ReadResult, 'session'> = { text, seq: [first, end], nextCursor: end, more: false, truncated, lines: counts };
  if (clipped) {
    // The range ended inside the event `until`: reading on continues there.
    r.nextCursor = o.until! - 1;
    r.nextOffset = o.untilOffset!;
  }
  // The holes that meet the seqs it returns, whose lines the text shows: each sits at its own end within the range, so
  // one meets [first, end] exactly when its line lies past the cut. The window read behind the lines shown is not the
  // result's: a tail of 3 reported a hole 34 seqs before its first line, and one of 60 every hole of its window, 61
  // where it showed 8 (an independent read, PR #22; the rule of the house's review of f3750e4..4f4c067,
  // comment 6315636412, question 5). The events tail's holes are its own events already.
  return withGapInfo(r, gaps.filter((g) => g.to >= first && g.from <= end));
}

/** An event a tail's text shows as a note, which ends every sequence left open (a hole; a command, with `commands`). */
const endsSequences = (e: JournalEvent, o: ReadOptions): boolean => isGap(e) || (o.commands === true && e.type === 'run.start' && e.line !== undefined);

/**
 * What a Run's output left open where `first` begins (LineCarry's `open`: a control sequence's introducer, and after a
 * string's a last ESC that may begin its terminator), read in up to STATE_LOOKBACK bytes of its output before `first`,
 * as stateBefore reads lasting state; '' when nothing is. A hole ends any sequence open before it. A Run's look-back
 * is bounded in bytes alone; a session's is opensBefore's, which, like stateBefore's, stops after MAX_SCAN journal
 * events, so a title opened 160 KB back across 40,000 small events is not found, and the tail shows its payload as
 * text (our read of the house's fixes for its review of f3750e4, PR #22: 14884ca).
 */
function openBefore(src: ReadSource, o: ReadOptions & { runId: string }, first: Output): string {
  const key = sourceKey(first);
  const back: string[] = [];
  // A Run's holes come apart from its events (RunOutput.gaps): the look-back stops at the last one before `first`.
  // Looked for among the events, which are outputs, a title left open before a hole hid every line of a tail after
  // it (our read of the 40 commits, PR #22).
  const ro = src.runOutput(o.runId, { until: first.seq - 1, maxBytes: STATE_LOOKBACK });
  const holeEnd = Math.max(-1, ...(ro.gaps ?? []).filter((g) => g.from < first.seq).map((g) => Math.min(g.to, g.seq)));
  for (let i = ro.events.length - 1; i >= 0; i--) {
    const e = ro.events[i]!;
    if (e.seq <= holeEnd) break;
    if (isOutput(e) && sourceKey(e) === key) back.push(e.data);
  }
  const carry = lineCarry();
  lineEnds(back.reverse().join(''), carry);
  return carry.open;
}

/**
 * What each source of a tail's window left open where its first output in the window begins (openBefore), for the
 * sources whose first output comes ahead of any note; only those that left something open are in the map. A process
 * Run that starts inside the window has nothing before it and is not looked for. A session's sources are read in one
 * walk back from the window's first event, up to STATE_LOOKBACK bytes of each and MAX_SCAN events in all: a walk for
 * each source took about 10 ms apiece, and a tail of 2,000 over 1,000 two-line Runs took 17 s (an independent read of
 * the fixes for the review of the 40 commits, PR #22).
 */
function opensBefore(src: ReadSource, o: ReadOptions, evs: JournalEvent[]): Map<string, string> {
  const want = new Map<string, Output>();
  const seen = new Set<string>();
  for (const e of evs) {
    if (endsSequences(e, o)) break;
    if (e.type === 'run.admit' || e.type === 'run.start') seen.add(`p:${e.runId}`);
    else if (isOutput(e)) {
      const key = sourceKey(e);
      if (!seen.has(key)) want.set(key, e);
      seen.add(key);
    }
  }
  const opens = new Map<string, string>();
  if (o.runId !== undefined) {
    for (const [key, first] of want) {
      const open = openBefore(src, { ...o, runId: o.runId }, first);
      if (open) opens.set(key, open);
    }
    return opens;
  }
  const back = new Map<string, string[]>();
  const bytes = new Map<string, number>();
  let left = want.size;
  let cursor = (evs[0]?.seq ?? 1) - 1;
  let examined = 0;
  // A hole ends every sequence open before it: the walk stops at the last hole before the window, where the hole is,
  // not at a gap event, which may name a hole elsewhere (as a Run's look-back does, openBefore).
  const holeEnd = Math.max(0, ...src.journal.gapsWithin(1, cursor).map((g) => Math.min(g.to, cursor)));
  walk: while (left > 0 && cursor > holeEnd && examined < MAX_SCAN) {
    const batch = src.journal.tail(512, cursor);
    if (batch.length === 0) break;
    examined += batch.length;
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i]!;
      if (e.seq <= holeEnd) break walk;
      if (!isOutput(e)) continue;
      const key = sourceKey(e);
      const had = bytes.get(key) ?? 0;
      if (!want.has(key) || had >= STATE_LOOKBACK) continue;
      let parts = back.get(key);
      if (!parts) back.set(key, (parts = []));
      parts.push(e.data);
      bytes.set(key, had + e.data.length);
      if (had + e.data.length >= STATE_LOOKBACK) left--;
    }
    cursor = batch[0]!.seq - 1;
  }
  for (const key of want.keys()) {
    const carry = lineCarry();
    lineEnds((back.get(key) ?? []).reverse().join(''), carry);
    if (carry.open) opens.set(key, carry.open);
  }
  return opens;
}

/**
 * The line ends (lineEnds) a tail's window holds, each source read with its own carry and a hole ending them all;
 * when older output precedes the window, each source's first output in it, ahead of any note, starts with what that
 * source left open before it (openBefore).
 */
function windowEnds(src: ReadSource, o: ReadOptions, evs: JournalEvent[], olderBefore: boolean): number {
  const carries = new Map<string, LineCarry>();
  const opens = olderBefore ? opensBefore(src, o, evs) : undefined;
  let noted = false;
  let count = 0;
  for (const e of evs) {
    if (endsSequences(e, o)) {
      carries.clear();
      noted = true;
    } else if (isOutput(e)) {
      const key = sourceKey(e);
      let carry = carries.get(key);
      if (!carry) carries.set(key, (carry = !noted && opens?.has(key) ? { open: opens.get(key)! } : lineCarry()));
      count += lineEnds(e.data, carry).length;
    }
  }
  return count;
}

/** UTF-8 bytes from the end of the output back to where its last `n` lines begin (by line ends, lineEnds); all of it when it holds no more lines. */
function lastLinesBytes(items: TextItem[], n: number): number {
  const outs = items.filter((it) => it.data !== undefined);
  let bytes = 0;
  let seen = 0;
  for (let k = outs.length - 1; k >= 0; k--) {
    const { data, ends } = outs[k]!;
    let e = ends!.length - 1;
    // The LF that ends the last line begins no line.
    if (k === outs.length - 1 && ends![e] === data!.length - 1) e--;
    for (; e >= 0; e--) if (++seen >= n) return bytes + utf8Length(data!.slice(ends![e]! + 1));
    bytes += utf8Length(data!);
  }
  return bytes;
}

/**
 * A piece of a tail's text in journal order: an output event's data (`key` its source; `ends` its line
 * ends, and `through` where the projection's interleave cuts it: interleaveCut), or a note (a hole, a
 * command). `clipped`: the data ends before the event does (the range ends inside it: `untilOffset`; or a shell
 * Run's plumbing follows it in the event). `skip`: the data begins that many characters into the event (the
 * plumbing before it is cut).
 * `lines`: a note's lines in the text (a command's line can hold newlines).
 */
interface TextItem {
  ev: JournalEvent;
  key?: string;
  data?: string;
  ends?: number[];
  through?: number;
  clipped?: true;
  skip?: number;
  lines?: number;
}

/** A point in a tail's items: after item `i`'s first `c` characters of data (a note's `c` is 1: the note itself). */
interface Cut {
  i: number;
  c: number;
}

const cmpCut = (a: Cut, b: Cut): number => a.i - b.i || a.c - b.c;
const maxCut = (a: Cut | undefined, b: Cut | undefined): Cut | undefined => (!a ? b : !b ? a : cmpCut(a, b) >= 0 ? a : b);

/** The `until` (and `untilOffset`) of a page that ends at `cut`. */
function positionOf(items: TextItem[], cut: Cut): Position {
  const it = items[cut.i]!;
  if (it.data === undefined || (cut.c >= it.data.length && !it.clipped)) return { until: it.ev.seq };
  const skipped = it.skip ? utf8Length((it.ev as Output).data.slice(0, it.skip)) : 0;
  return { until: it.ev.seq, untilOffset: skipped + utf8Length(it.data.slice(0, cut.c)) };
}

/** The first event at or after `cut`. */
const seqAfter = (items: TextItem[], cut: Cut): Seq => {
  const it = items[cut.i]!;
  return it.data !== undefined && cut.c < it.data.length ? it.ev.seq : (items[cut.i + 1]?.ev.seq ?? it.ev.seq);
};

/** Whether an unfinished line counts as a line of a tail's text: with one source, only with something in it (`blankCounts`: spaces too, as before a note); with several, any. */
function shows(frag: string, blankCounts: boolean, multi: boolean): boolean {
  if (multi) return frag.length > 0;
  const text = stripEscapes(frag).text;
  return blankCounts ? text.length > 0 : /\S/.test(text);
}

/** Whether the cursor is at column 0 after the LF at `data[nl]`: a CR before it, past blank lines, says so; anything else printed leaves it further on. `before` is the line's text from earlier events; `start` the column at its start. */
function col0After(data: string, nl: number, before: string | undefined, start: boolean): boolean {
  let k = nl - 1;
  while (k >= 0 && data[k] === '\n') k--;
  if (k >= 0) return data[k] === '\r';
  return before ? before.endsWith('\r') : start;
}

/**
 * Lines of a tail's text as the projection orders them (§6 rule 6), one unit per line or per event's
 * lines: `lines` in the text (a header's included), `shown` of them output, and where a page of what came
 * before must end to hold the unit's first `k` lines whole (`item`'s k-th line end, or `at`; none for a header).
 * `note`: a note's lines, which no page ends inside (wholeNote).
 */
interface Unit {
  lines: number;
  shown: number;
  at?: Cut;
  item?: TextItem;
  i?: number;
  note?: true;
}

const unitCut = (u: Unit, k: number): Cut | undefined => (u.item ? { i: u.i!, c: u.item.ends![k - 1]! + 1 } : u.at);
const lastCut = (u: Unit): Cut | undefined => unitCut(u, u.lines);

/**
 * The display a tail's text is cut from, to find where the lines shown begin (`before`). It follows the
 * projection (§6 rule 6): an event's lines go out where the projection cuts it (interleaveCut, the one
 * answer for both), with what its source held before them;
 * an unfinished line is held until its source ends it, and the held ones follow, in the order they began,
 * before a note and at the end; each change of source is headed when the page holds several, and starts on
 * a fresh line, where a LF that left the cursor short of column 0 leaves a blank line (a pty without its
 * CRs). A line ends at a LF outside a control string (lineEnds); a note is a line of its own.
 *
 * The lines shown are the text's last ones, and a page of what came before ends after the last byte of
 * every line the text leaves out, so each of those is whole in it (cutBefore); a shown line begun before
 * that point shows its head again there. Every doubt counts as a line (a fragment that may show nothing,
 * trailing blank lines the projection drops, a LF that may have left the cursor at column 0), which only
 * makes that page repeat a line, never skip one. A full-screen frame, which makes lines of no LF (rule 5),
 * is the one exception.
 */
class Display {
  readonly units: Unit[] = [];
  /** `prefix[u]`: the greatest cut of units before `u`. */
  private readonly prefix: Array<Cut | undefined> = [undefined];
  /** The end of the items: the last byte written. */
  readonly end: Cut;

  constructor(items: TextItem[], multi: boolean) {
    const units = this.units;
    const held = new Map<string, { data: string; at: Cut }>();
    let last: string | undefined;
    let lineEnded = false;
    let col0 = true;
    let lf: Cut | undefined;
    const segment = (key: string, source: boolean) => {
      if (key === last) return;
      if (last !== undefined && lineEnded && !col0) units.push({ lines: 1, shown: 1, at: lf! });
      if (multi && source) units.push({ lines: 1, shown: 0 });
      last = key;
    };
    const flush = (blankCounts: boolean) => {
      for (const [key, h] of held) {
        segment(key, true);
        const visible = shows(h.data, blankCounts, multi);
        units.push({ lines: 1, shown: visible ? 1 : 0, at: h.at });
        // A fragment that shows nothing (a title left open) leaves the cursor where the line before it ended.
        if (visible) {
          lineEnded = false;
          col0 = h.data.endsWith('\r');
        }
      }
      held.clear();
    };
    items.forEach((it, i) => {
      if (it.data === undefined) {
        flush(true);
        segment(`n:${i}`, false);
        // A note is as many lines as it shows, and the lines shown never begin inside it (wholeNote; a note longer
        // than the byte cap is the limit there).
        const k = it.lines ?? 1;
        units.push({ lines: k, shown: k, at: { i, c: 1 }, note: true });
        lineEnded = col0 = true;
        lf = { i, c: 1 };
        return;
      }
      const key = it.key!;
      const h = held.get(key);
      const nl = it.through! - 1;
      if (nl === -1) {
        if (h) {
          h.data += it.data;
          h.at = { i, c: it.data.length };
        } else held.set(key, { data: it.data, at: { i, c: it.data.length } });
        return;
      }
      const start = last === key ? col0 : true;
      segment(key, true);
      const ends = it.ends!;
      units.push({ lines: ends.length, shown: ends.length, item: it, i });
      lineEnded = true;
      lf = { i, c: nl + 1 };
      // A pipe's LF is a CRLF (rule 6).
      col0 = key !== 'pty' || col0After(it.data, nl, h?.data, start);
      held.delete(key);
      if (nl + 1 < it.data.length) held.set(key, { data: it.data.slice(nl + 1), at: { i, c: it.data.length } });
    });
    flush(false);
    for (const u of units) this.prefix.push(maxCut(this.prefix[this.prefix.length - 1], lastCut(u)));
    const lastItem = items[items.length - 1]!;
    this.end = { i: items.length - 1, c: lastItem.data?.length ?? 1 };
  }

  /** Where the last `count` lines of output begin: unit `u`, past its first `keep` lines. */
  shownFrom(count: number): { u: number; keep: number } {
    let need = count;
    if (need <= 0) return { u: this.units.length, keep: 0 };
    for (let u = this.units.length - 1; u >= 0; u--) {
      const x = this.units[u]!;
      if (x.shown >= need) return { u, keep: x.lines - need };
      need -= x.shown;
    }
    return { u: 0, keep: 0 };
  }

  /**
   * `at` moved to the start of a note it falls inside, and the note's lines that adds to the text (`extra`): a note
   * has no place inside it for a page to end, so the lines shown begin at its first line, more than asked for, as a
   * reach-back's do. Ending a page of what came before after the note showed its last lines again and again, and
   * ending it before the note left its first lines in neither page. The one limit: a note whose lines together are
   * longer than `maxBytes` loses its first ones to the cut, and no read shows them, since a head-first page shows
   * no command notes.
   */
  wholeNote(at: { u: number; keep: number }): { at: { u: number; keep: number }; extra: number } {
    const x = this.units[at.u];
    return x?.note && at.keep > 0 ? { at: { u: at.u, keep: 0 }, extra: at.keep } : { at, extra: 0 };
  }

  /** Where a page holding every line before `at` whole ends; undefined when none comes before. */
  cutBefore(at: { u: number; keep: number }): Cut | undefined {
    return maxCut(this.prefix[at.u], at.keep > 0 ? unitCut(this.units[at.u]!, at.keep) : undefined);
  }

  /** Where the line written last begins in the display, and the text's lines from there to the end: all of them (`lines`), and those of output (`shown`). */
  lastWritten(): { at: { u: number; keep: number }; lines: number; shown: number } {
    let u = this.units.findIndex((x) => {
      const c = lastCut(x);
      return c !== undefined && cmpCut(c, this.end) === 0;
    });
    if (u === -1) u = this.units.length - 1;
    // The last of a unit's lines; a note's all of them (wholeNote).
    const x = this.units[u]!;
    const keep = x.note ? 0 : x.lines - 1;
    let lines = x.note ? x.lines : 1;
    let shown = x.note ? x.shown : 1;
    for (let v = u + 1; v < this.units.length; v++) {
      lines += this.units[v]!.lines;
      shown += this.units[v]!.shown;
    }
    return { at: { u, keep }, lines, shown };
  }
}

/**
 * The `until` of what came before an event's text. Before a hole's note, that is before the hole itself
 * when nothing lies between it and its gap event: a page ending inside the hole would show it again.
 */
const endBefore = (e: JournalEvent): Seq => (isGap(e) && e.to >= e.seq - 1 ? e.from - 1 : e.seq - 1);

/** A position in a range's output: the end of event `until`, or inside output event `until` after `untilOffset` of its UTF-8 bytes. */
interface Position {
  until: Seq;
  untilOffset?: number;
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
  /** The recorded holes scanned. */
  const gaps: GapInfo[] = [];
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
      if (isGap(e)) addHole(gaps, gapOf(e));
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
  withGapInfo(r, [...(w.gap ? uncovered(journal, w.gap, gaps) : []), ...gaps]);
  if (scanner.clippedLines > 0) r.clippedLines = scanner.clippedLines;
  return r;
}
