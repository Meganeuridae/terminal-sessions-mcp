/**
 * Transcript: a documented line-oriented projection of a range of output (§6, G10).
 *
 * `project(chunks, opts)` is a pure function of the chunks and the options. Its
 * semantics, exactly:
 *
 * 1. Geometry. The bytes are fed to a scratch emulator, seeded empty, of
 *    `opts.cols` × `opts.rows` (default 30 rows). The caller supplies the width;
 *    a Run is projected at the width it started with, and a history range at the
 *    width the caller passes, whatever the terminal's size was while the range
 *    was written. Resizes inside the range are not replayed.
 * 2. Resolution. Carriage returns, backspaces and cursor motion within the range
 *    resolve as a terminal resolves them; control sequences produce no text.
 *    Motion relative to content outside the range is lost: after `ABCDE`, the
 *    range `\rXY` reads `XY` here and `XYCDE` on a real terminal.
 * 3. Lines. A line is a logical line: rows the terminal soft-wrapped are joined,
 *    so the output contains no newline the program did not write (wide output,
 *    JSON, URLs survive whole). Trailing whitespace is trimmed at the end of each
 *    logical line, never at a wrap point. Every row up to the last non-empty one
 *    is reported, wherever the cursor ended; trailing blank lines are dropped.
 *    When `open` says a next range continues this one (a page), the blank lines
 *    the range ended with are kept (every line begun up to the cursor's row), and
 *    an unfinished last line keeps its trailing whitespace, so the pages joined
 *    read as the whole range does, with two exceptions. A line the range ends
 *    returned over (below) is a line of its own on that page, where the whole
 *    range would have let the next text overwrite it, so a run of `\rL<n>`
 *    overwrites cut into pages shows one line per page where the range shows
 *    one. And a range that ends inside a line leaves the rest of it to the next
 *    range, which begins it at column 0: a tab, a backspace or cursor motion at
 *    the end or in that rest lands on a different column than in the whole
 *    range, and cursor motion past the line's last character keeps no
 *    whitespace. The cursor's row is begun when something was
 *    written on it; a row it was moved onto without a write (an erase of the
 *    display left it there, a cursor motion took it there) is no line yet. The
 *    projection says how its last line stands for the next range (`lastLine`):
 *    unfinished, with the cursor on it past its start, so what the next range
 *    writes first goes on with it; or returned over, the cursor at its start,
 *    so the next range's text writes over it, unless a LF ends it first.
 * 4. Nothing printed is lost to redraws of the whole display. Before an erase of
 *    the whole display (`ED 2`, `ED 0` from the home position, their DECSED
 *    forms, or `RIS`) its content is kept, and the projection continues on the
 *    top row of a blank display (the cursor keeps its column); text removed by
 *    clearing the scrollback (`ED 3`) is kept too. So `clear` in the middle of a
 *    range does not hide what came before it. Partial erases (erase line, erase
 *    below or above the cursor) are in-range redraws and resolve.
 * 5. Full-screen programs. When a program enters the alternate screen, the
 *    normal screen's content is kept, except the line the cursor is on, which
 *    stays in place. When the program leaves, its final frame (the alternate
 *    screen's rows, trailing blank rows dropped) follows the kept content, and
 *    the projection continues on the line the cursor was on when the program
 *    started: that line, and whatever is written after the program ends, come
 *    after the frame. (When that line is the top row with no scrollback, the rows
 *    below it stay in place too, so they also come after the frame.) A range that
 *    ends inside a full-screen program ends with the program's current frame.
 *    Intermediate frames are not kept. A range that begins inside a full-screen
 *    program projects its drawing as it lands on the blank scratch display.
 * 6. Streams. Chunks are `pty` output unless they say otherwise. `stdout` and
 *    `stderr` chunks come from pipes, which have no terminal driver: a bare LF is
 *    projected as CRLF (a tty's ONLCR), so lines start at column 0, and CR, BS
 *    and escapes in pipe output still resolve. A source is the pty, or one
 *    process Run's pipes (`runId`; stdout and stderr together). Sources are
 *    interleaved by whole lines: each source's unfinished line is held until
 *    that source ends it (a LF outside a control string, `lineEnds` in
 *    text.ts: the one line-end rule), so lines of different sources never mix
 *    (two concurrent Runs, or a Run and the shell); the held ends of lines
 *    follow at the end of the range (or before a note), in the order they
 *    began. When the source changes, the next source starts on a fresh line,
 *    under a header line when `label` gives one. Where that line end, a note,
 *    a header or another source's output scrolls a scroll region that doesn't
 *    start at row 1, the projection's region runs ahead of the terminal's, and
 *    the projection is `truncated` and `lost` when, at the range's end, a row
 *    the terminal alone still shows is gone from it (Projector.regionScroll).
 *    A `note` chunk is a line of its
 *    own (a reader's `[… events missing …]` marker), never part of any source;
 *    a `hole` chunk stands where output was lost (`runChunks`), and the
 *    projection starts afresh there as at a note, with no line of its own, so
 *    no line and no control sequence open before it takes what follows. A LF
 *    that a CSI executes inside it ends a line (`lineEnds`), so the interleave
 *    can cut a source inside that CSI: the source's next output then begins with
 *    the CSI's head, as its own parser would still hold it, so the CSI's rest
 *    reads as the CSI, not as text (the house's review of the 40 commits through
 *    f3750e4, #22, comment 6310921374: `A ESC [ 3 LF`, a Run's `r1`, then `1mB`
 *    read `1mB`).
 * 7. Budgets, all visible (G11). `maxInputBytes` caps the UTF-8 bytes projected:
 *    the head or tail (`keep`, default `tail`) is kept, cut on a line boundary
 *    when one lies in the half of the budget nearest the cut and never inside a
 *    character, and `omittedInputBytes` says how much was not projected.
 *    `maxLines` (default 50 000) caps the logical lines of output returned,
 *    keeping the head or tail; the header lines naming sources (rule 6) come
 *    extra. When keeping the tail, input older than the last
 *    `maxLines + 2·rows` line ends is not projected (it cannot contribute to the
 *    last `maxLines` lines of line-oriented output) and counts as omitted; a
 *    full-screen program's time on the alternate screen counts as `rows + 1`
 *    lines there, however many newlines it wrote, since only its final frame
 *    projects (rule 5), and the cut never lands inside it. When keeping the
 *    head, projection stops once `maxLines` lines are complete and the rest
 *    counts as omitted, with the input of the lines it dropped (`droppedInput`):
 *    what was fed past the `maxLines`-th line end when the lines are one per
 *    line end, and otherwise their share of what was fed, an estimate.
 *    Any omission or dropped line sets `truncated`. Input
 *    omitted from the head still applies the lasting terminal state it set
 *    (modes, the scroll region, character sets: `persistentState` in screen.ts),
 *    so the tail of apt-style output projects as the terminal shows it.
 *
 * Good for reading and search; never presented as a screen (G14).
 *
 * Cost: the emulator is fed in batches sized so that no row can scroll out of
 * its small scrollback before it is read, and so that no control sequence is
 * split; rows are moved into the projection as they scroll, so memory is
 * bounded by the kept text, not by the range, and time is linear in the
 * projected bytes. With `maxInputBytes`, the chunks are cut to the budget as
 * they are gathered (what is dropped leaves only its lasting state behind), so
 * a range far larger than the budget costs the budget; with `maxLines` alone,
 * the range is gathered whole before the newline count cuts it.
 */
import xterm from '@xterm/headless';
import type { IBuffer, Terminal as TerminalType } from '@xterm/headless';
import { persistentState } from './screen.js';
import { DEFAULT_GEOMETRY } from './types.js';
import { executedIn, headIndex, isIntroducer, lineCarry, lineEnds, sequenceEnd, tailStart, unfinishedSequence, utf8Length, type LineCarry } from './text.js';

const { Terminal } = xterm;

export type ProjectChunk = string | { data: string; stream?: 'pty' | 'stdout' | 'stderr'; runId?: string } | { note: string } | { hole: true };

/** A source of output (rule 6): the pty, or a process Run's pipes (`stdout` stands for both). */
export interface SourceInfo {
  stream: 'pty' | 'stdout';
  runId?: string;
}

export interface ProjectOptions {
  cols: number;
  rows?: number;
  /** Logical lines returned at most (default 50 000). */
  maxLines?: number;
  /** UTF-8 bytes of input projected at most (default: all). */
  maxInputBytes?: number;
  /** Which end survives a budget (default `tail`). */
  keep?: 'head' | 'tail';
  /** A header line for a source, placed where the output changes to it (rule 6); undefined for none. */
  label?: (source: SourceInfo) => string | undefined;
  /** A next range continues this one: its trailing blank lines are kept, and an unfinished last line keeps its trailing whitespace (rule 3). */
  open?: boolean;
  /**
   * Lasting terminal state the output before the range set (`persistentState`: the scroll region, modes, character
   * sets), applied ahead of the first chunk as no source's output (rule 7; Projector.owner).
   */
  state?: string;
}

export interface Projection {
  text: string;
  /** True when any input was omitted or any line dropped (G11). */
  truncated: boolean;
  /**
   * UTF-8 bytes of input not projected. A head kept to `maxLines` adds the input of the lines it dropped (rule 7,
   * `droppedInput`): exact when the lines made are one per line end, otherwise their share of what was fed, an estimate.
   */
  omittedInputBytes: number;
  /** Input omitted or lines dropped: what a cut left out, which another page or tail shows. `truncated` counts it. */
  cut?: true;
  /**
   * Rows the projection lost after projecting them: scrolled out of its scratch scrollback unread, or gone from a
   * scroll region where the terminal alone still shows them, scrolled out ahead of it by what the program did not
   * write (rule 6, Projector.regionScroll). `truncated` counts them too; unlike what a cut omits or drops, no other
   * page or tail of this range shows them. A read that ends before they were lost shows them, and a raw read has
   * their bytes.
   */
  lost?: true;
  /**
   * With `open`, how the last line stands for the range that continues this one (rule 3): `unfinished`, the cursor
   * on it past its start, so the next range's first output goes on with it; `returned`, the cursor taken back to its
   * start (a CR), so the next range's first text writes over it, unless it is the LF of a CRLF, which ends it. Absent
   * when the next range begins a line of its own: the cursor stands on a row nothing was written on (after a line
   * end, an erase of the display, a cursor motion), or above the last line, or the head's cut of lines dropped the
   * line it stands on. The reader's `splitLine` is read from it (the house's review of 4860d4c..bc4bc85, PR #22,
   * comment 6357989601: by the stream's line ends, a page whose last line an erase had ended said it went on).
   */
  lastLine?: 'unfinished' | 'returned';
}

export interface TranscriptOptions {
  cols?: number;
  rows?: number;
  /** Upper bound on returned lines (the tail is kept). */
  maxLines?: number;
}

/** Rows of scrollback in the scratch emulator; each batch may add at most this many. */
const SCRATCH_SCROLLBACK = 4096;
/** Largest batch in UTF-16 units, so the event loop is yielded to regularly; one control sequence longer than this is still fed whole. */
const MAX_BATCH = 512 * 1024;
const DEFAULT_MAX_LINES = 50_000;

interface Segment {
  /** `pty`, `p:<runId>` for a process Run's pipes, or `n:<i>` for a note or a header. */
  key: string;
  pipe: boolean;
  data: string;
  /** UTF-8 bytes of `data`. */
  bytes: number;
  /** A header line naming a source (rule 6): no line of output, so `maxLines` does not count it. */
  header?: true;
  /** A header's whole line, which a cut inside it leaves `data` short of. */
  whole?: string;
  /** The header that names this segment's source, emitted just before it. */
  named?: Segment;
  /**
   * The head of a CSI the data begins inside (rule 6: the interleave cut its source at a LF the CSI
   * executed), fed just before the data and counted as no input.
   */
  head?: string;
  /** UTF-16 units at the start of `data` that are no input: the head, once it is put before the data to be fed. */
  lead?: number;
}

/**
 * `x`'s data from `at` on. A head it began inside (Segment.head) goes once the cut passes the end of that
 * CSI, where the data no longer begins inside it.
 */
function cutFront(x: { data: string; head?: string }, at: number): void {
  if (x.head !== undefined && at > 0) {
    const e = sequenceEnd(x.head + x.data, 0);
    if (e !== undefined && at >= e - x.head.length) delete x.head;
  }
  x.data = x.data.slice(at);
}

/**
 * A tail cut of `x`'s data to `max` bytes, made on its head and data together, since data that begins inside a CSI
 * is read on from that CSI's head (rule 6): where in the data it lands (tailStart: past the CSI when it would land
 * inside it), and what it drops, with the head, so the lasting state the dropped part set is replayed. Made on the data
 * alone, a cut inside the CSI's rest kept the head before a later part of it, a different control, and dropped a part
 * that set nothing: a tail of 6 or 7 bytes of `ESC [ CR LF`, a Run's line, `4hXY CR Z` showed `ZY`, where the
 * insert mode `ESC [ 4 h` set shows `ZXY` (our review of the 40 commits through 4f4c067, PR #22).
 */
function tailCut(x: { data: string; head?: string }, max: number): { at: number; gone: string } {
  const head = x.head ?? '';
  const at = Math.max(0, tailStart(head + x.data, max) - head.length);
  return { at, gone: head + x.data.slice(0, at) };
}

/**
 * Where the interleave (rule 6) cuts a source's data: its lines go out through `through`, the index
 * after its last line end (0 when it ends none), and the rest is held until the source ends the line.
 * `ends` are its line ends by the one rule (`lineEnds`, with the source's `carry`), so a LF inside a
 * window title splits nothing: an event cut there let a header land inside the title, and the title's
 * rest showed as text (an independent read of the fix for the house's read of the 33 commits, #22,
 * comment 6307350650). One answer for the projection and for where a tail's lines begin (the reader's
 * Display). A LF that a CSI executes is a line end too, and `head` is that CSI's head when the last end
 * is one: what the data after `through` begins inside (rule 6).
 */
export function interleaveCut(data: string, carry: LineCarry): { ends: number[]; through: number; head?: string } {
  const heads = new Map<number, string>();
  const ends = lineEnds(data, carry, Number.POSITIVE_INFINITY, false, heads);
  const last = ends[ends.length - 1];
  const head = last === undefined ? undefined : heads.get(last);
  return head === undefined ? { ends, through: last === undefined ? 0 : last + 1 } : { ends, through: last! + 1, head };
}

/**
 * Marks for a hole in the text a cutter reads whole (runChunks): a CAN, which ends a control sequence open
 * before it to the grammar every reader shares, then a noncharacter, which no program prints as text; the
 * first whose pair the output does not hold is used.
 */
const HOLE_MARKS = Array.from({ length: 32 }, (_, k) => `\x18${String.fromCharCode(0xfdd0 + k)}`);

/**
 * A Run's output events as chunks for `project`, with a `hole` (rule 6) between two of them wherever one of
 * `gaps` says output was lost there: after it the Run's lines and control sequences start afresh, as
 * search's do after a hole, where a line, or a string, left open before it took what followed (the house's
 * review of the 40 commits through f3750e4, #22, comment 6310921374). `cut`, given for a shell Run's pty
 * output, reads that output as one text (the plumbing cutter finds the Run's marks at its two ends); the
 * holes are marked in it (HOLE_MARKS) and the cut text is split there.
 */
export function runChunks(events: ReadonlyArray<{ seq: number; data: string; stream: 'pty' | 'stdout' | 'stderr' }>, gaps: ReadonlyArray<{ from: number; to: number }> = [], cut?: (raw: string) => string): ProjectChunk[] {
  const first = events[0]?.seq ?? 0;
  const last = events[events.length - 1]?.seq ?? 0;
  const within = gaps.filter((g) => g.from < last && g.to > first);
  /** k: a hole lies between events k - 1 and k. */
  const holes = new Set<number>();
  for (let k = 1; k < events.length && within.length; k++) {
    const a = events[k - 1]!.seq;
    const b = events[k]!.seq;
    if (within.some((g) => g.from < b && g.to > a)) holes.add(k);
  }
  const out: ProjectChunk[] = [];
  if (!cut) {
    events.forEach((e, k) => {
      if (holes.has(k)) out.push({ hole: true });
      out.push({ data: e.data, stream: e.stream });
    });
    return out;
  }
  const all = holes.size ? events.map((e) => e.data).join('') : '';
  const mark = holes.size ? HOLE_MARKS.find((m) => !all.includes(m)) : undefined;
  const text = cut(events.map((e, k) => (mark !== undefined && holes.has(k) ? mark : '') + e.data).join(''));
  (mark === undefined ? [text] : text.split(mark)).forEach((piece, k) => {
    if (k > 0) out.push({ hole: true });
    if (piece) out.push({ data: piece, stream: 'pty' });
  });
  return out;
}

/** The byte budget applied while the chunks are gathered (rule 7, Cost): what it dropped, and the lasting state of a dropped head. */
interface Budget {
  max: number;
  keep: 'head' | 'tail';
  omitted: number;
  state: string;
}

/** Numeric value of a CSI parameter (sub-parameters take their first value). */
const num = (p: number | number[] | undefined): number => (Array.isArray(p) ? (p[0] ?? 0) : (p ?? 0));
const ALT_MODES = new Set([47, 1047, 1049]);

/** The text kept so far, as logical lines; the last may still be continued by a wrapped row. */
class Lines {
  readonly lines: string[] = [];
  private open = false;
  dropped = false;

  constructor(private readonly keep: 'head' | 'tail', private readonly maxLines: number) {}

  /** Append a row; a wrapped row continues the open line. */
  row(text: string, wrapped: boolean): void {
    if (wrapped && this.open && this.lines.length > 0) {
      this.lines[this.lines.length - 1] += text;
    } else {
      this.close();
      this.lines.push(text);
      if (this.keep === 'tail' && this.lines.length > 2 * this.maxLines + 1024) {
        this.lines.splice(0, this.lines.length - this.maxLines - 1);
        this.dropped = true;
      }
    }
    this.open = true;
  }

  /** End the open line: nothing continues it. Trailing whitespace goes here, never at a wrap point. */
  close(): void {
    if (!this.open) return;
    const i = this.lines.length - 1;
    this.lines[i] = this.lines[i]!.replace(/\s+$/, '');
    this.open = false;
  }
}

/** The text of row `y` of `b`'s screen, trailing blanks trimmed. */
const rowText = (b: IBuffer, y: number): string => b.getLine(b.baseY + y)?.translateToString(true) ?? '';

/** The xterm internals the projector reads and hooks (margins, scrolls, a row's wrap); each use is skipped if they change. */
interface Core {
  _bufferService?: { scroll?: (...args: unknown[]) => void };
  /** The active buffer, and the normal one among both. */
  buffer?: { ybase?: unknown; scrollTop?: unknown; scrollBottom?: unknown; lines?: { get?(i: number): { isWrapped: boolean } | undefined } };
  buffers?: { normal?: unknown };
}

class Projector {
  readonly term: TerminalType;
  readonly out: Lines;
  /**
   * Rows may have been lost unread: scrolled out of the scratch scrollback (a batch outran its bound), or taken from a
   * scroll region by what the program did not write (hookScroll, boundary).
   */
  lost = false;
  /** How the last line stands for a next range (Projection.lastLine), once `finish` has run with `open`. */
  lastLine: 'unfinished' | 'returned' | undefined;
  private readonly capacity: number;
  /** The source being fed (a segment's key); undefined while the projection writes its own: a boundary's line end, a note, a header. */
  private source: string | undefined;
  /**
   * The source whose output set the scroll margins: the program, whose scrolls of its region are the terminal's.
   * Undefined while no source is known to have set them: margins the replayed state set (`ProjectOptions.state`, a
   * dropped head's lasting state) came from no source fed, so no source's scroll of them is reported, only the
   * projection's own. Fed as the first source's output, replayed margins were that source's: a Run's lines scrolling
   * the pty's rows away reported nothing, and the pty's own scrolls read as lost (the house's review of
   * 4860d4c..bc4bc85, PR #22, comment 6357989601).
   */
  private owner: string | undefined;
  /**
   * Rows of the screen (0-based) the projection alone holds: each begun by a line end the program did not write (a
   * boundary's, a note's, a header's, another source's), which the terminal has no row for. They move up with the
   * region's scrolls (regionScroll) and leave it as any row does.
   */
  private owed = new Set<number>();
  /**
   * Rows of the region the program left empty and something else wrote on, from their start (a Run's first line, a
   * note, on the blank row after the program's line end): the terminal has the row, blank, so what it holds here is not
   * the program's, and its going says nothing. Each keeps the text the batch that began it left there (undefined while
   * that batch is fed). One holding other text when it goes was written on since, by the program as on the terminal's
   * row (or by a later batch that went on writing there, which then reports a loss that isn't one), and goes as any row
   * with text does. Read as blank whatever it held, a Run's line on the empty row, then the program's cursor set onto
   * it and its own line written there, then a Run's lines that scrolled it out, lost the program's line unreported (the
   * house's review of bc4bc85..5d8ce0e, PR #22, I38). They move with the region's scrolls as `owed` does.
   */
  private blank = new Map<number, string | undefined>();
  /**
   * Such line ends that moved the cursor down inside the region without a scroll: each puts the projection's cursor a
   * row ahead of the terminal's, so the program's next scroll of the region is one the terminal does not make.
   */
  private pending = 0;
  /**
   * `pending` when the program last saved its cursor (DECSC, SCOSC, mode 1048): the projection saved its cursor that many
   * rows below the terminal's, so restoring both puts it that far ahead again (onCursorRestore). Counted from that save,
   * whatever moved the cursors since; a settle starts it afresh with the rest of the account.
   */
  private savedPending = 0;
  /** The cursor-motion handlers, while a row is pending or a saved cursor carries one (watchCursor). */
  private cursorWatch: Array<{ dispose(): void }> | undefined;
  /**
   * Rows the projection scrolled out of the region ahead of the terminal, oldest first: whether each held text. The
   * terminal still shows them (at its region's top), and the projection lacks them, until the terminal's own scrolls take
   * them too, one for each row the program itself scrolls out (regionScroll).
   */
  private ahead: boolean[] = [];
  /** Scrolls of a region not from row 1 so far (feedBatch counts the ones a batch makes). */
  private scrolls = 0;
  /** Bumped by settle: a batch fed across one adds nothing (feedBatch). */
  private generation = 0;

  constructor(readonly cols: number, readonly rows: number, keep: 'head' | 'tail', maxLines: number) {
    this.term = new Terminal({ cols, rows, scrollback: SCRATCH_SCROLLBACK, allowProposedApi: true });
    this.capacity = rows + SCRATCH_SCROLLBACK;
    this.out = new Lines(keep, maxLines);
    const p = this.term.parser;
    p.registerCsiHandler({ final: 'J' }, (params) => this.onErase(num(params[0])));
    p.registerCsiHandler({ prefix: '?', final: 'J' }, (params) => this.onErase(num(params[0])));
    p.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this.onAltEnter(params));
    p.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this.onAltExit(params));
    p.registerEscHandler({ final: 'c' }, () => this.onReset());
    p.registerCsiHandler({ final: 'r' }, (params) => this.onMargins(params));
    this.hookScroll();
  }

  /**
   * The cursor-motion handlers (onCursorMove, onCursorSet, and the saved cursor's onCursorSave and onCursorRestore) are
   * registered only while a row is pending or a saved cursor carries one, and go when neither does: registered
   * throughout, they cost every cursor move of every projection (9% over 200,000 lines each set by CUP), for a case that
   * needs a line end the program did not write inside a region not from row 1. A save made while they're away carries
   * nothing pending, which is what `savedPending` then holds.
   */
  private watchCursor(): void {
    const watch = this.pending > 0 || this.savedPending > 0;
    if (watch && !this.cursorWatch) {
      const p = this.term.parser;
      this.cursorWatch = [
        ...['A', 'B', 'E', 'F'].map((final) => p.registerCsiHandler({ final }, (params) => this.onCursorMove(final === 'A' || final === 'F' ? -(num(params[0]) || 1) : num(params[0]) || 1))),
        p.registerCsiHandler({ final: 'e' }, (params) => this.onCursorMove(num(params[0]) || 1, 'screen')),
        ...['H', 'f', 'd'].map((final) => p.registerCsiHandler({ final }, () => this.onCursorSet())),
        p.registerCsiHandler({ final: 's' }, () => this.onCursorSave()),
        p.registerEscHandler({ final: '7' }, () => this.onCursorSave()),
        p.registerCsiHandler({ final: 'u' }, () => this.onCursorRestore()),
        p.registerEscHandler({ final: '8' }, () => this.onCursorRestore()),
      ];
    } else if (!watch && this.cursorWatch) {
      for (const h of this.cursorWatch) h.dispose();
      this.cursorWatch = undefined;
    }
  }

  /** What is fed next comes from `source` (a segment's key), or from the projection itself (undefined). */
  feeding(source: string | undefined): void {
    this.source = source;
  }

  /** What is being fed is not the program's: the projection's own writes, and, once a source set the margins, another source's. */
  private get others(): boolean {
    return this.owner === undefined ? this.source === undefined : this.source !== this.owner;
  }

  /**
   * DECSTBM: whose output set the margins. Margins it changes settle what the region's rows said (settle); the margins
   * already in force, set again, restore no row, so the account's rows stay. But a DECSTBM xterm takes homes the cursor
   * (setScrollRegion), the projection's and that of the terminal of the source that sent it, which owns the margins
   * from then on, so no row is pending between them: kept, the program's next scroll after a hole's line end and its
   * margins set again was read as the projection's alone, and reported a row both screens let go (the house's review
   * of bc4bc85..5d8ce0e, PR #22, I22). The margins it sets are read as xterm's setScrollRegion reads them: a bottom
   * left out, 0 or past the last row is the last row, and one not below the top sets nothing, so it leaves the account
   * and the owner as they were.
   */
  private onMargins(params: (number | number[])[]): boolean {
    const top = num(params[0]) || 1;
    let bottom = params.length < 2 ? 0 : num(params[1]);
    if (bottom === 0 || bottom > this.rows) bottom = this.rows;
    if (bottom <= top) return false;
    const now = this.margins();
    if (top - 1 !== now.top || bottom - 1 !== now.bottom) this.settle();
    else {
      this.pending = 0;
      this.watchCursor();
    }
    this.owner = this.source;
    return false;
  }

  /**
   * Decide what the region's rows say and start the account afresh: a row the terminal alone still shows is gone from
   * the projection when one it scrolled out ahead of the terminal held text (`ahead`). At the range's end, and where
   * the terminal's screen and the projection's part: the margins changed, the screen erased or reset, or the alternate
   * screen entered over a normal screen the projection rebuilt (onAltEnter), after which such a row never comes back
   * the way the program's own scrolls bring the two screens together again.
   */
  private settle(): void {
    if (this.ahead.includes(true)) this.lost = true;
    this.ahead = [];
    this.owed.clear();
    this.blank.clear();
    this.pending = 0;
    this.savedPending = 0;
    this.watchCursor();
    this.generation++;
  }

  /**
   * Watch the scrolls xterm makes of a scroll region through BufferService.scroll: a line end at the region's last row,
   * a line wrapping there, IND, NEL. SU, SD, IL, DL and RI move a region's rows without it, and aren't watched: a row
   * one of them takes isn't reported, whoever sent it, the program's own while a row is owed included (the house's
   * review of 4860d4c..bc4bc85, PR #22, comment 6357989601). On the normal screen a region not starting at row 1
   * keeps no scrollback, and its top row goes: what that says is regionScroll's. After any scroll of such a region
   * its new top row joins no row above the region, which it was wrapped from only inside it: a note's tail read glued
   * onto the row above (an independent read of the fixes for #22). xterm internals: skipped, and nothing reported, if
   * they change.
   */
  private hookScroll(): void {
    const core = (this.term as unknown as { _core?: Core })._core;
    const service = core?._bufferService;
    const scroll = service?.scroll;
    if (!core || !service || typeof scroll !== 'function') return;
    service.scroll = (...args: unknown[]) => {
      // Read on every line end that scrolls: a region of the normal screen only, from xterm's buffer directly.
      const buf = core.buffer;
      const top = buf !== undefined && buf === core.buffers?.normal && typeof buf.scrollTop === 'number' ? buf.scrollTop : 0;
      if (top > 0) this.regionScroll(top, typeof buf?.scrollBottom === 'number' ? buf.scrollBottom : this.rows - 1);
      scroll.apply(service, args);
      const line = top > 0 && typeof buf?.ybase === 'number' ? buf.lines?.get?.(buf.ybase + top) : undefined;
      if (line) line.isWrapped = false;
    };
  }

  /**
   * A scroll of a region not from row 1 is about to take its top row. The margins stay as the program set them, since
   * resetting them would change how its later output scrolls (the house's review of a8b6f28..4860d4c, PR #22, comment
   * 6341260318), so the account is kept of how the projection's region differs from the terminal's, and what the rows
   * say is decided where they leave the screen and at the range's end (settle). A scroll the program did not make (a
   * boundary's line end, a note's, a header's, another source's: `others`), or that the terminal does not make with it
   * (`pending`), puts the projection a scroll ahead: the row it takes is one the terminal keeps (`ahead`), unless the
   * projection alone held it (`owed`). The program's own scroll is the terminal's too: its top row goes from both, the
   * terminal's being the oldest row the projection took ahead of it. So a row is lost only while the terminal shows it
   * and the projection does not: set at the program's own scroll that took text while a row was owed, `lost` stayed
   * although, once the program had scrolled on, the two screens were the same again (margins 3–6, a blank top row, a
   * hole's line end, then five of the program's lines: after two the projection lacked `r4`, after five neither showed
   * it, and `lost` was true: the house's review of 4860d4c..bc4bc85, PR #22, comment 6357989601). A row the program
   * puts back by moving the cursor onto it is beyond the account: a program that redraws its region by absolute moves
   * can still report a loss that isn't there.
   */
  private regionScroll(top: number, bottom: number): void {
    this.scrolls++;
    const others = this.others;
    if (!this.owed.delete(top)) {
      const left = this.blank.get(top);
      const blank = this.blank.delete(top);
      // The program's own scroll with nothing ahead takes the same row from both screens: nothing to read.
      if (others || this.pending > 0 || this.ahead.length > 0) {
        const text = rowText(this.term.buffer.normal, top);
        this.ahead.push(text !== '' && !(blank && (left === undefined || left === text)));
      }
    }
    // The rows move up one; the new bottom row is the projection's alone when the program did not begin it.
    if (this.owed.size) this.owed = new Set([...this.owed].map((r) => r - 1));
    if (this.blank.size) this.blank = new Map([...this.blank].map(([r, left]) => [r - 1, left]));
    if (others) this.owed.add(bottom);
    else if (this.pending > 0) {
      this.pending--;
      this.watchCursor();
    } else this.ahead.shift();
  }

  /**
   * CUU, CUD, CNL, CPL, VPR: the program's own cursor moved `dy` rows while its cursor runs ahead of the terminal's
   * (`pending`): both move alike, and meet where a margin or the screen's edge stops one of them (cursorAfter).
   * VPR passes the bottom margin, where CUD stops at it, and stops at the screen's edge alone (`stop`): by a run of
   * xterm 6.0.0, `CSI 9 e` from the third row of a region 3–6 lands on the tenth row, `CSI 9 B` on the sixth.
   * Unwatched, a VPR that met the terminal's cursor at the screen's edge left a row pending, and the program's next
   * scrolls reported a loss where nothing went (the house's review of bc4bc85..5d8ce0e, PR #22, I62).
   */
  private onCursorMove(dy: number, stop: 'margin' | 'screen' = 'margin'): boolean {
    if (this.pending > 0 && !this.others && this.term.buffer.active.type === 'normal') {
      const y = this.term.buffer.active.cursorY;
      this.pending = Math.max(0, this.cursorAfter(y, dy, stop) - this.cursorAfter(y - this.pending, dy, stop));
      this.watchCursor();
    }
    return false;
  }

  /**
   * CUP, HVP, VPA: the program's own cursor set to a row, where the terminal's cursor then is too, so no row between
   * the two is pending (`pending`). What it writes there lands on the same row of both screens, which stays the
   * projection's alone when it was (`owed`): a hole's blank row owed, then `CSI 6;1 H`, `X` and four lines, ends with
   * the two screens the same, the row with `X` being the one the hole's line end began.
   */
  private onCursorSet(): boolean {
    if (!this.others && this.term.buffer.active.type === 'normal') {
      this.pending = 0;
      this.watchCursor();
    }
    return false;
  }

  /** DECSC, SCOSC, mode 1048: the program saves its cursor, the projection's that many rows below the terminal's (`savedPending`). */
  private onCursorSave(): boolean {
    if (!this.others && this.term.buffer.active.type === 'normal') {
      this.savedPending = this.pending;
      this.watchCursor();
    }
    return false;
  }

  /**
   * DECRC, SCORC, mode 1048: the program restores its saved cursor, and each screen's goes back to where it was saved,
   * the projection's as far ahead of the terminal's as it was then (`savedPending`): a hole's line end, then a cursor
   * saved and at once restored, which moves neither, left the projection's region a scroll ahead as before, where
   * taking the restore for a set to one row lost that, and the row it took went unreported (the house's review of
   * bc4bc85..5d8ce0e, PR #22, I3).
   */
  private onCursorRestore(): boolean {
    if (!this.others && this.term.buffer.active.type === 'normal') {
      this.pending = this.savedPending;
      this.watchCursor();
    }
    return false;
  }

  /**
   * Where xterm's CUU or CUD takes the cursor from row `y` by `dy`: it stops at the margin on its side when it is within
   * it, else at the screen's edge. With `stop` 'screen', as VPR, at the screen's edge alone.
   */
  private cursorAfter(y: number, dy: number, stop: 'margin' | 'screen' = 'margin'): number {
    if (stop === 'screen') return Math.min(Math.max(y + dy, 0), this.rows - 1);
    const { top, bottom } = this.margins();
    if (dy > 0) return Math.min(y + dy, y <= bottom ? bottom : this.rows - 1);
    return Math.max(y + dy, y >= top ? top : 0);
  }

  /**
   * Feed a batch of a segment's data, and when it is not the program's (`others`), account for the rows it added to a
   * region not from row 1 besides the scrolls regionScroll saw: each row the cursor moved down to inside the region
   * is the projection's alone (`owed`), and puts the program's next scroll ahead of the terminal's (`pending`): a
   * note longer than a row, a Run's lines, a header on the region's last row. One that begins on an empty row of the
   * region the program's line end left (no boundary line end was needed) writes on the terminal's blank row (`blank`).
   * Nothing is added across a settle, or when the batch set the margins and so became the program's.
   */
  async feedBatch(data: string): Promise<void> {
    const b = this.term.buffer.active;
    const before = this.others && b.type === 'normal' ? { y: b.cursorY, scrolls: this.scrolls, generation: this.generation, ...this.margins() } : undefined;
    if (before && before.top > 0 && before.y >= before.top && before.y <= before.bottom && b.cursorX === 0 && !this.owed.has(before.y) && rowText(b, before.y) === '') this.blank.set(before.y, undefined);
    await this.feed(data);
    // What this batch left on the blank row it began (`blank`).
    for (const [r, left] of this.blank) if (left === undefined) this.blank.set(r, rowText(this.term.buffer.normal, r));
    const after = this.term.buffer.active;
    if (!before || before.top === 0 || before.generation !== this.generation || !this.others || after.type !== 'normal') return;
    const { top, bottom } = this.margins();
    if (top !== before.top || bottom !== before.bottom || before.y > bottom) return;
    const scrolls = this.scrolls - before.scrolls;
    const to = Math.min(after.cursorY, bottom);
    this.pending += Math.max(0, to - before.y);
    this.watchCursor();
    for (let r = Math.max(top, before.y + 1 - scrolls); r <= to; r++) this.owed.add(r);
  }

  /**
   * Parse `data`. xterm 6 parses a write synchronously when it follows user
   * input, so the scratch emulator announces an (empty) input first: no timer
   * per batch.
   */
  feed(data: string): Promise<void> {
    this.term.input('', true);
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /** After each batch: note possible loss, then move scrolled rows into the output. */
  async afterBatch(): Promise<void> {
    const n = this.term.buffer.normal;
    if (n.length >= this.capacity) this.lost = true;
    if (this.term.buffer.active.type !== 'normal' || n.baseY === 0) return;
    // ED 3 clears the scrollback; its handler moves the rows into the output first.
    // xterm keeps a saved cursor (DECSC, SCOSC, mode 1049) as an absolute row and
    // does not move it when ED 3 removes the rows above: a DECRC after this ED 3
    // would land that many rows too low (apt's status line: every later line
    // overwrote the bottom row). No program sent this ED 3, so the saved row moves
    // with the rows it was counted from (er-2).
    const removed = n.length - this.rows;
    await this.feed('\x1b[3J');
    this.rebaseSavedCursor(removed);
  }

  /** Move the saved cursor up by the rows removed above it (xterm internals; skipped if they change). */
  private rebaseSavedCursor(removed: number): void {
    const saved = (this.term as unknown as { _core?: { buffers?: { normal?: { savedY?: unknown } } } })._core?.buffers?.normal;
    if (saved && typeof saved.savedY === 'number' && removed > 0) saved.savedY = Math.max(0, saved.savedY - removed);
  }

  /**
   * Drop the normal buffer's rows above the cursor's, which becomes the top row.
   * The saved cursor moves with it, as after ED 3: a DECRC after a clear would
   * otherwise land on the row it was saved on counted from the dropped top (the
   * house's read of ed4ecac, #22: `cleared`, eight blank lines, `RESTORED`, where
   * a terminal writes RESTORED over cleared).
   */
  private clearToCursorRow(): void {
    const n = this.term.buffer.normal;
    const removed = n.baseY + n.cursorY;
    this.term.clear();
    this.rebaseSavedCursor(removed);
  }

  /**
   * What takes the cursor to a fresh line for what a segment boundary puts next (rule 6): past the last row at or
   * below the cursor that holds text, or none when the cursor stands at the start of an empty row with nothing
   * below it. A line a CR went back over is begun: `progress 50%`, a CR, a hole, then `done` read `doneress 50%`,
   * and a note after such a line wrote over it (the house's review of f3750e4..4f4c067, #22, comment
   * 6315636412). And rows below the cursor are written: after a cursor up, as a multi-line progress display
   * leaves it mid-redraw, one line end took the next segment onto the row below, and it wrote over that row's
   * text (`line1`, then `Xine2`: a reviewer's read of the fixes for #22). A full-screen program's frame is rows
   * below the cursor too: on the alternate screen, which keeps no scrollback, the line end past its last row
   * scrolls the frame's top row away, where before the next segment wrote over the row below the cursor. Neither
   * keeps the frame whole, neither is reported (the projection isn't `truncated`, and no input is omitted), and
   * only the program's own repaint of the whole frame brings the row back (a reviewer's read of the fixes for #22).
   * `row` is the row the line end is given on: a cursor down stops at the bottom margin from within the region or above it.
   */
  private freshLine(): { line: string; row: number } {
    const b = this.term.buffer.active;
    let last = -1;
    for (let y = b.cursorY; y < this.term.rows; y++) if (rowText(b, y) !== '') last = y;
    if (last === -1) return { line: b.cursorX > 0 ? '\r\n' : '', row: b.cursorY };
    const { bottom } = this.margins();
    return { line: `${last > b.cursorY ? `\x1b[${last - b.cursorY}B` : ''}\r\n`, row: b.cursorY <= bottom ? Math.min(last, bottom) : last };
  }

  /**
   * End a segment before the next one (rule 6): cancel what it left open and take the cursor to a fresh line (freshLine),
   * as the projection's own output: a scroll region its line end scrolls is watched as any other (hookScroll). Margins
   * from row 1, as apt's progress bar sets them, scroll into the scrollback and lose nothing. Below the region, on the
   * screen's last row, the line end moves nothing, so the next segment begins on that row's text, which is reported.
   * At or above a region not from row 1, each row the cursor moves down puts the program's next scroll ahead of the
   * terminal's (`pending`), and the row the line end begins, when it does not scroll, is the projection's alone
   * (`owed`); the rows a cursor down passes hold the program's text (regionScroll).
   */
  async boundary(): Promise<void> {
    const { line, row } = this.freshLine();
    const b = this.term.buffer.active;
    if (line !== '' && b.type === 'normal') {
      const { top, bottom } = this.margins();
      if (row === this.rows - 1 && row !== bottom && rowText(b, row) !== '') this.lost = true;
      else if (top > 0 && row <= bottom) {
        this.pending += row - b.cursorY + (row < bottom ? 1 : 0);
        this.watchCursor();
        if (row < bottom && row + 1 >= top) this.owed.add(row + 1);
      }
    }
    this.feeding(undefined);
    await this.feed(`\x18${line}`);
  }

  /** The active buffer's scroll margins, 0-based (xterm internals; the whole screen if they change). */
  private margins(): { top: number; bottom: number } {
    const buf = (this.term as unknown as { _core?: Core })._core?.buffer;
    return typeof buf?.scrollTop === 'number' && typeof buf.scrollBottom === 'number' ? { top: buf.scrollTop, bottom: buf.scrollBottom } : { top: 0, bottom: this.rows - 1 };
  }

  /** Rows the next batch may add before the scratch scrollback could drop an unread row. */
  get budget(): number {
    return Math.max(1, SCRATCH_SCROLLBACK - 1 - this.term.buffer.normal.baseY);
  }

  /** The final text: kept lines, then the normal buffer, then the frame if a full-screen program is still up. */
  finish(open = false): string[] {
    this.settle();
    const n = this.term.buffer.normal;
    const alt = this.term.buffer.active.type === 'alternate';
    let last = lastNonEmpty(n);
    if (open && !alt) {
      // A range that a next range continues keeps what the next one builds on: the blank lines it ended with (every
      // line it began, up to the cursor's), and an unfinished last line with its trailing whitespace (rule 3). The
      // cursor's row is begun when something was written on it (xterm keeps written blanks as content, so written
      // indentation is a begun line); a row the cursor was only moved onto is not: after a whole-display erase the
      // cursor keeps its column on a blank row, and that row counted as a begun, unfinished line, so a page ending
      // there said its last line went on (the house's review of 4860d4c..bc4bc85, PR #22, comment 6357989601). How
      // the last line stands for the next range is kept for the caller (`lastLine`).
      const row = n.baseY + n.cursorY;
      if (rowText(n, n.cursorY) !== '') {
        if (row >= last) this.lastLine = n.cursorX > 0 ? 'unfinished' : 'returned';
        last = Math.max(last, row);
      } else last = Math.max(last, row - 1);
    }
    this.rowsOut(n, 0, last + 1);
    if (alt) this.frameOut(this.term.buffer.alternate);
    if (this.lastLine !== 'unfinished') this.out.close();
    const lines = this.out.lines;
    if (!open) while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  dispose(): void {
    this.term.dispose();
  }

  private rowsOut(buf: IBuffer, from: number, to: number): void {
    for (let y = from; y < to; y++) {
      const line = buf.getLine(y);
      if (line) this.out.row(flat(line.translateToString(true)), line.isWrapped);
    }
  }

  private frameOut(buf: IBuffer): void {
    this.out.close();
    const last = lastNonEmpty(buf, buf.baseY);
    this.rowsOut(buf, buf.baseY, last + 1);
    this.out.close();
  }

  /** Erase in display: keep what a whole-display erase is about to remove (rule 4). */
  private onErase(mode: number): boolean {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return false;
    if (mode === 3) {
      this.rowsOut(buf, 0, buf.baseY);
      return false;
    }
    if (mode === 2 || (mode === 0 && buf.cursorX === 0 && buf.cursorY === 0)) {
      this.rowsOut(buf, 0, lastNonEmpty(buf) + 1);
      this.out.close();
      // Drop the kept rows; the cursor's row moves to the top and the erase blanks it.
      this.clearToCursorRow();
      // The terminal's screen is blank now too: what its region showed that the projection lacked is decided on the
      // rows kept, and the program's own next scroll that takes a row takes one the terminal loses as well.
      this.settle();
    }
    return false;
  }

  /** Entering the alternate screen: keep the content above the cursor (rule 5). Mode 1048 saves the cursor alone (onCursorSave). */
  private onAltEnter(params: (number | number[])[]): boolean {
    if (params.some((p) => num(p) === 1048)) this.onCursorSave();
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal' || !params.some((p) => ALT_MODES.has(num(p)))) return false;
    // clear() keeps the cursor's row and does nothing when it is already the top row.
    if (buf.baseY === 0 && buf.cursorY === 0) return false;
    const cursorRow = buf.baseY + buf.cursorY;
    const last = lastNonEmpty(buf);
    this.rowsOut(buf, 0, cursorRow);
    if (last > cursorRow) {
      this.out.close();
      this.rowsOut(buf, cursorRow + 1, last + 1);
      this.out.close();
    }
    this.clearToCursorRow();
    // The projection's normal screen is rebuilt from the cursor's row, while the terminal's stays as it was under the
    // alternate screen: the account's rows no longer match it, and what the region showed is decided on the rows kept
    // here (settle), as at a full erase. Kept, it read later scrolls against moved rows: a hole that owed a row, then
    // the alternate screen and six of the program's lines, reported a loss where nothing went (the house's review of
    // bc4bc85..5d8ce0e, PR #22, I4).
    this.settle();
    return false;
  }

  /** Leaving the alternate screen: keep its final frame (rule 5). Mode 1048 restores the cursor alone (onCursorRestore). */
  private onAltExit(params: (number | number[])[]): boolean {
    if (params.some((p) => num(p) === 1048)) this.onCursorRestore();
    const buf = this.term.buffer.active;
    if (buf.type !== 'alternate' || !params.some((p) => ALT_MODES.has(num(p)))) return false;
    this.frameOut(buf);
    return false;
  }

  /** RIS clears both buffers: keep them first (rule 4), and decide what the region's rows said (settle). */
  private onReset(): boolean {
    const n = this.term.buffer.normal;
    this.rowsOut(n, 0, lastNonEmpty(n) + 1);
    this.out.close();
    if (this.term.buffer.active.type === 'alternate') this.frameOut(this.term.buffer.alternate);
    this.settle();
    return false;
  }
}

/**
 * xterm builds a row's text one cell at a time, a rope of about `cols` pieces
 * (~3.5 KB for 120 columns). A regex pass flattens it in place, so a kept row
 * costs its characters: this is what bounds memory for long ranges.
 */
const FLATTEN = /$/;
function flat(s: string): string {
  FLATTEN.test(s);
  return s;
}

/** Index of the last row at or after `from` with visible content, or `from - 1`. */
function lastNonEmpty(buf: IBuffer, from = 0): number {
  for (let y = buf.length - 1; y >= from; y--) {
    const line = buf.getLine(y);
    if (line && line.translateToString(true).trim() !== '') return y;
  }
  return from - 1;
}

/**
 * End of the next batch of `data` from `from`: the longest prefix whose worst-case
 * row count fits `budget`, ending at a safe point (after a newline, before or
 * after a control sequence) so the scrollback-clearing ED 3 between batches never
 * lands inside a sequence. A sequence is taken whole, its payload counted as no
 * cells, and one that straddles MAX_BATCH extends the batch to its end; one that
 * never ends in `data` ends the batch before it, or is the rest of the data (the
 * house's read of ed4ecac, #22: a batch cut inside a long OSC let the ED 3 end it,
 * and the rest of its payload printed). Rows are bounded by line feeds (LF, VT,
 * FF, IND, NEL), two per sequence (it can reposition the cursor to force a wrap),
 * and printed cells over the width. The line feeds a CSI executes inside it count
 * too, so the batch ends before it when they would not fit (the house's review of
 * the 40 commits through f3750e4, #22, comment 6310921374: a batch cut inside such
 * a CSI, its LF read as ending it, and the ED 3 showed the CSI's rest as text); one
 * CSI holding more of them than the scratch scrollback, which only a malformed one
 * does, is fed whole, and rows it scrolls past unread are lost, visibly (`lost`).
 */
function batchEnd(data: string, from: number, budget: number, cols: number): number {
  let feeds = 0;
  let escapes = 0;
  let cells = 0;
  let safe = from;
  const limit = Math.min(data.length, from + MAX_BATCH);
  let i = from;
  while (i < limit) {
    const c = data.charCodeAt(i);
    let next = i + 1;
    if (isIntroducer(c)) {
      const e = sequenceEnd(data, i);
      if (e === undefined) return i > from ? i : data.length;
      if (i > from) safe = i;
      escapes++;
      // The line feeds a CSI executes inside it move the cursor down as any do.
      for (const k of executedIn(data, i, e)) if (data.charCodeAt(k) >= 0x0a && data.charCodeAt(k) <= 0x0c) feeds++;
      next = e;
    } else if (c === 0x0a || c === 0x0b || c === 0x0c || c === 0x84 || c === 0x85) {
      feeds++;
    } else if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0)) {
      cells += c >= 0x1100 ? 2 : 1;
      // A surrogate pair is one character: never split.
      if ((c & 0xfc00) === 0xd800 && (data.charCodeAt(i + 1) & 0xfc00) === 0xdc00) next = i + 2;
    }
    if (feeds + 2 * escapes + Math.ceil(cells / cols) + 1 > budget) {
      if (safe > from) return safe;
      // No safe point: printable text can be split anywhere between characters; at least one unit goes.
      return i > from ? i : next;
    }
    if (c === 0x0a || isIntroducer(c)) safe = next;
    i = next;
  }
  // At the cap, not inside a sequence (a straddling one moved `i` past it) and not inside a pair.
  return i < data.length && (data.charCodeAt(i) & 0xfc00) === 0xdc00 && i - 1 > from ? i - 1 : i;
}

const pipeToTty = (s: string): string => s.replace(/\n/g, '\r\n');

/**
 * Merge chunks into runs of one source, interleaved by whole lines (rule 6):
 * each source's data is emitted through its last line end (interleaveCut), and
 * the rest is held until that source ends the line. Held ends are emitted, in the order they began,
 * before a note and at the end. A header segment precedes each change of source
 * when `label` gives one.
 *
 * With a `budget`, what cannot survive `cutInput` is dropped as it arrives, so
 * the memory held is the budget's, not the range's (the house's read of
 * ed4ecac, #22: 400 MiB of chunks under a 1 KiB budget peaked at 808 MiB): when
 * the tail is kept, a whole emitted segment goes once the segments after it
 * hold the budget, and a segment or a held line is cut to its last budget's
 * worth (not inside a sequence) once it holds twice that; when the head is kept,
 * everything after the budget is full goes. A dropped head leaves its lasting state in
 * `budget.state`, as `cutInput`'s does. The exact cut is still `cutInput`'s. A tail cut that
 * moves past the start of a control sequence still unfinished (an OSC 52 longer than the budget,
 * its end in a later chunk) drops the rest of that sequence too as it arrives, up to its end, so
 * the projection reads as it does with the whole sequence in one chunk: the cut dropped the
 * introducer, and the payload after it showed as text (the house's read of the 33 commits, #22,
 * comment 6307351104).
 */
function segments(chunks: Iterable<ProjectChunk>, label: ProjectOptions['label'], budget?: Budget): Segment[] {
  const out: Segment[] = [];
  let outBytes = 0;
  /** Each source's unfinished line; `head` that of a CSI it begins inside (Segment.head). */
  const held = new Map<string, { info: SourceInfo; pipe: boolean; data: string; bytes: number; full: boolean; head?: string }>();
  /**
   * A source whose next line begins inside a CSI none of whose rest has come yet: the head it begins with.
   * Held only once that rest comes, so the held ends keep the order the reader's Display gives them.
   */
  const pending = new Map<string, string>();
  /** A hole came since the last segment: the next one starts afresh, never joined to the one before. */
  let fresh = false;
  /** Per source, what its data left unfinished for the line-end rule; a note ends it all, as its CAN does. */
  const carries = new Map<string, LineCarry>();
  let notes = 0;
  const drop = (data: string, bytes: number) => {
    budget!.omitted += bytes;
    if (budget!.keep === 'tail') budget!.state = persistentState(budget!.state + persistentState(data));
  };
  /**
   * Sources whose sequence still open a tail cut moved past: the rest of it goes as it arrives. What
   * the sequence is comes from the source's line-end carry, the one record of what its data left
   * unfinished, which a note ends as it ends the carry: a cut's open sequence kept dropping a source's
   * output after a hole (an independent read of the fix for the house's read of the 33 commits, #22,
   * comment 6307350650: `head `, a 12 KB OSC 52, a note and two lines showed only the note).
   */
  const dropping = new Set<string>();
  /** Note the sequence a tail cut of `data` at `cut` moved past, if it is unfinished. */
  const leaveOpen = (key: string, data: string, cut: number) => {
    if (unfinishedSequence(data, Number.POSITIVE_INFINITY) < cut) dropping.add(key);
  };
  /**
   * `data` without the rest of the sequence a cut left open for `key`, read on from `before`, what the
   * source's data before it left unfinished (its carry): what goes is omitted, read with the head it
   * completes for the state it sets, since the head went with the cut and set nothing alone (our review
   * of the 84 commits through a8b6f28, PR #22: `ESC [ 0 ; … ;` cut, then `4hXY CR Z`, showed `ZY`). A
   * head over 64 bytes is the carry's short form (sequenceHead), so what its parameters set can differ
   * from the whole sequence's. An ESC held back from the string that a new sequence's start turned out to
   * be comes back with it.
   */
  const skipOpen = (key: string, data: string, before: string): string => {
    if (!dropping.has(key) || !data) return data;
    const end = sequenceEnd(before + data, 0);
    if (end === undefined) {
      drop(data, utf8Length(data));
      return '';
    }
    dropping.delete(key);
    if (end < before.length) return before.slice(end) + data;
    const gone = data.slice(0, end - before.length);
    if (gone) drop(before + gone, utf8Length(gone));
    return data.slice(end - before.length);
  };
  const emit = (key: string, pipe: boolean, info: SourceInfo | undefined, data: string, head?: string) => {
    const bytes = utf8Length(data);
    if (budget?.keep === 'head' && outBytes >= budget.max) {
      drop(data, bytes);
      return;
    }
    outBytes += bytes;
    const last = out[out.length - 1];
    if (last && last.key === key && !fresh) {
      // The data goes on from where the segment's ends: a head it began inside is in the segment already.
      last.data += data;
      last.bytes += bytes;
    } else {
      fresh = false;
      const header = info && label?.(info);
      let named: Segment | undefined;
      if (header) {
        const h = `${header}\n`;
        named = { key: `n:${notes++}`, pipe: true, data: h, bytes: utf8Length(h), header: true, whole: h };
        out.push(named);
        outBytes += utf8Length(h);
      }
      out.push({ key, pipe, data, bytes, ...(named ? { named } : {}), ...(head !== undefined ? { head } : {}) });
    }
    if (budget?.keep !== 'tail') return;
    // Kept tail: the segments after the first hold the budget, so the first cannot survive the cut.
    while (out.length > 1 && outBytes - out[0]!.bytes >= budget.max) {
      const gone = out.shift()!;
      outBytes -= gone.bytes;
      // A header is no input: what goes of it is no input omitted (inputBytes).
      if (!gone.header) drop((gone.head ?? '') + gone.data, gone.bytes);
    }
    // One source's run past twice the budget: only its last budget's worth can survive.
    const end = out[out.length - 1]!;
    if (end.bytes > 2 * budget.max) {
      const { at, gone } = tailCut(end, budget.max);
      leaveOpen(end.key, (end.head ?? '') + end.data, at + (end.head?.length ?? 0));
      const goneBytes = utf8Length(end.data.slice(0, at));
      cutFront(end, at);
      outBytes -= end.bytes;
      end.bytes = utf8Length(end.data);
      outBytes += end.bytes;
      drop(gone, goneBytes);
    }
  };
  const flush = () => {
    for (const [key, h] of held) if (h.data) emit(key, h.pipe, h.info, h.data, h.head);
    held.clear();
  };
  for (const ch of chunks) {
    if (typeof ch !== 'string' && ('note' in ch || 'hole' in ch)) {
      flush();
      carries.clear();
      dropping.clear();
      pending.clear();
      if ('hole' in ch) fresh = true;
      else emit(`n:${notes++}`, true, undefined, `${ch.note}\n`);
      continue;
    }
    const c = typeof ch === 'string' ? { data: ch } : ch;
    if (!c.data) continue;
    const pipe = c.stream === 'stdout' || c.stream === 'stderr';
    const key = pipe ? `p:${c.runId ?? ''}` : 'pty';
    // Line ends are read over the whole chunk, as the stream wrote it, before a tail cut's leftover is skipped.
    let carry = carries.get(key);
    if (!carry) carries.set(key, (carry = lineCarry()));
    const before = carry.open;
    const { through, head } = interleaveCut(c.data, carry);
    // A sequence a tail cut moved past is skipped as it comes, and what comes after it begins inside nothing.
    if (dropping.has(key)) pending.delete(key);
    const data = skipOpen(key, c.data, before);
    if (!data) continue;
    let h = held.get(key);
    if (!h) {
      // A Run's pipes together are labelled `stdout`.
      const info: SourceInfo = { stream: pipe ? 'stdout' : 'pty' };
      if (pipe && c.runId !== undefined) info.runId = c.runId;
      const begun = pending.get(key);
      pending.delete(key);
      h = { info, pipe, data: '', bytes: 0, full: false, ...(begun !== undefined ? { head: begun } : {}) };
      held.set(key, h);
    }
    // Only the new data is read for a line end, so a long unfinished line costs its length once.
    const skipped = c.data.length - data.length;
    const nl = through - 1 >= skipped ? through - 1 - skipped : -1;
    if (nl === -1) {
      if (h.full) {
        drop(data, utf8Length(data));
        continue;
      }
      h.data += data;
      h.bytes += utf8Length(data);
      if (budget && h.bytes > 2 * budget.max) {
        // An unfinished line past twice the budget: only a budget's worth of it can survive. Kept
        // head: that worth is its start, and the rest of the line (`full`) is dropped as it comes.
        const tail = budget.keep === 'tail' ? tailCut(h, budget.max) : undefined;
        const cut = tail ? tail.at : headIndex(h.data, budget.max);
        if (tail) {
          leaveOpen(key, (h.head ?? '') + h.data, cut + (h.head?.length ?? 0));
          // More than the budget goes from this line, which follows every segment emitted so far: none of
          // them can survive the cut. Kept, `head` before a title's payload held whole survived the
          // payload's 20 KB (a title's LFs end no line now, so the payload is a held line's).
          for (const s of out.splice(0)) if (!s.header) drop((s.head ?? '') + s.data, s.bytes);
          outBytes = 0;
        }
        const gone = tail ? h.data.slice(0, cut) : h.data.slice(cut);
        if (tail) cutFront(h, cut);
        else h.data = h.data.slice(0, cut);
        h.bytes = utf8Length(h.data);
        h.full = budget.keep === 'head';
        drop(tail ? tail.gone : gone, utf8Length(gone));
      }
      continue;
    }
    if (h.full) drop(data.slice(0, nl + 1), utf8Length(data.slice(0, nl + 1)));
    emit(key, pipe, h.info, h.full ? h.data : h.data + data.slice(0, nl + 1), h.head);
    // Re-inserted, so the held ends keep the order in which they began.
    held.delete(key);
    // The line ends outside every control string, so nothing a cut left open reaches past it; one a CSI
    // executed leaves the rest inside that CSI, which the rest begins with (rule 6), however little of it came.
    h.data = data.slice(nl + 1);
    h.bytes = utf8Length(h.data);
    h.full = false;
    if (head !== undefined) h.head = head;
    else delete h.head;
    if (h.data) held.set(key, h);
    else if (head !== undefined) pending.set(key, head);
  }
  flush();
  return out;
}

/** Drop the segments before `k` and segment `k`'s data before `at`; the dropped data goes to `dropped`. */
function dropHead(segs: Segment[], k: number, at: number, dropped: string[]): void {
  // A segment that begins inside a CSI is dropped with its head, so the lasting state the CSI set is replayed.
  for (let i = 0; i < k; i++) dropped.push((segs[i]!.head ?? '') + segs[i]!.data);
  dropped.push((segs[k]!.head ?? '') + segs[k]!.data.slice(0, at));
  cutFront(segs[k]!, at);
  segs[k]!.bytes = utf8Length(segs[k]!.data);
  segs.splice(0, k);
  if (!segs[0]!.data) segs.shift();
}

/**
 * Keep at most `max` UTF-8 bytes of the segments' data from one end (rule 7).
 * Returns bytes omitted; the omitted head's data goes to `dropped`.
 */
function cutInput(segs: Segment[], max: number, keep: 'head' | 'tail', dropped: string[]): number {
  const sizes = segs.map((s) => utf8Length(s.data));
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= max) return 0;
  const input = inputBytes(segs);
  if (keep === 'tail') {
    let acc = 0;
    let k = segs.length - 1;
    while (k >= 0 && acc + sizes[k]! <= max) acc += sizes[k--]!;
    // Segment k holds the cut; the budget left for it is max - acc.
    dropHead(segs, k, tailCut(segs[k]!, max - acc).at, dropped);
  } else {
    let acc = 0;
    let k = 0;
    while (k < segs.length && acc + sizes[k]! <= max) acc += sizes[k++]!;
    // A cut inside a header names what it cut away: it goes whole, as the tail's cut puts it back whole.
    if (segs[k]!.header) {
      segs.splice(k);
      return input - inputBytes(segs);
    }
    const seg = segs[k]!;
    let end = headIndex(seg.data, max - acc);
    const ends = lineEnds(seg.data.slice(0, end));
    const nl = ends.length ? ends[ends.length - 1]! : -1;
    if (nl !== -1 && utf8Length(seg.data.slice(nl + 1, end)) <= max / 2) end = nl + 1;
    seg.data = seg.data.slice(0, end);
    seg.bytes = utf8Length(seg.data);
    segs.splice(k + 1);
    if (!seg.data) segs.pop();
  }
  return input - inputBytes(segs);
}

/**
 * The UTF-8 bytes of input the segments hold: their data, a header's left out, since a header names a source and is
 * no input (rule 6). A header still takes room in the bytes a budget projects, but what a cut takes of one is no input
 * omitted: a 6-byte budget over the pty's two lines and a Run's two counted the dropped `[terminal]` header's 11 bytes
 * beside the pty's 8 (the house's review of 4f4c067..a8b6f28, #22, comment 6323055715).
 */
const inputBytes = (segs: readonly Segment[]): number => segs.reduce((a, s) => a + (s.header ? 0 : utf8Length(s.data)), 0);

/** A switch to or from the alternate screen (modes 47, 1047, 1049), matched at `lastIndex`. */
const ALT_SWITCH = /\x1b\[\?([0-9;]*)([hl])/y;

/** The last alternate-screen switch in `d` that starts before `i`: where, and whether it enters. */
function altSwitchBefore(d: string, i: number): { at: number; enter: boolean } | undefined {
  let j = i;
  while (j > 0 && (j = d.lastIndexOf('\x1b[?', j - 1)) !== -1) {
    ALT_SWITCH.lastIndex = j;
    const m = ALT_SWITCH.exec(d);
    if (m && m[1]!.split(';').some((p) => ALT_MODES.has(Number(p)))) return { at: j, enter: m[2] === 'h' };
  }
  return undefined;
}

/**
 * Keep only input after the line end that precedes the last `n` line ends (rule 7,
 * tail; line ends by `lineEnds`, headers not counted). Newlines inside a full-screen program's time on the alternate screen
 * are not counted: the program's frames project as one final frame of at most
 * `rows` lines (plus the line it interrupted), whatever they contained, so that
 * time counts as `rows + 1`, and the cut never lands inside it (the house's read
 * of ed4ecac, #22: five frames of 29 lines cut `before` from a three-line
 * projection). Returns bytes omitted; the omitted data goes to `dropped`.
 */
function cutToLastNewlines(segs: Segment[], n: number, rows: number, dropped: string[]): number {
  const cut = (k: number, at: number): number => {
    const omitted = inputBytes(segs.slice(0, k)) + utf8Length(segs[k]!.data.slice(0, at));
    dropHead(segs, k, at, dropped);
    return omitted;
  };
  // Whether the range ends inside a full-screen program: the last switch in the pty's output says.
  let inAlt = false;
  const lastSwitch: Array<{ at: number; enter: boolean } | undefined> = [];
  for (let k = segs.length - 1; k >= 0; k--) {
    const sw = segs[k]!.pipe ? undefined : altSwitchBefore(segs[k]!.data, segs[k]!.data.length);
    lastSwitch[k] = sw;
    if (sw) {
      inAlt = sw.enter;
      break;
    }
  }
  let seen = 0;
  for (let k = segs.length - 1; k >= 0; k--) {
    const seg = segs[k]!;
    // A header is no line of output: `maxLines` does not count it.
    if (seg.header) continue;
    const d = seg.data;
    const ends = lineEnds(d, { open: seg.head ?? '' });
    let e = ends.length - 1;
    let i = d.length;
    let sw = k in lastSwitch ? lastSwitch[k] : seg.pipe ? undefined : altSwitchBefore(d, i);
    while (i > 0) {
      while (e >= 0 && ends[e]! >= i) e--;
      const nl = e >= 0 ? ends[e]! : -1;
      if (sw && sw.at > nl) {
        if (!sw.enter) inAlt = true;
        else if (inAlt) {
          inAlt = false;
          seen += rows + 1;
          if (seen > n) return cut(k, sw.at);
        }
        i = sw.at;
        sw = altSwitchBefore(d, i);
        continue;
      }
      if (nl === -1) break;
      if (!inAlt && ++seen > n) return cut(k, nl + 1);
      i = nl;
    }
  }
  return 0;
}

const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Project a range of output to text (see the module comment for the exact semantics). */
export async function project(chunks: Iterable<ProjectChunk>, opts: ProjectOptions): Promise<Projection> {
  const int = (v: number | undefined, fallback: number, min: number) => (v !== undefined && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback);
  const cols = int(opts.cols, DEFAULT_GEOMETRY.cols, 2);
  const rows = int(opts.rows, DEFAULT_GEOMETRY.rows, 1);
  const maxLines = int(opts.maxLines, DEFAULT_MAX_LINES, 1);
  const keep = opts.keep ?? 'tail';
  const budget: Budget | undefined = opts.maxInputBytes !== undefined ? { max: Math.max(0, opts.maxInputBytes), keep, omitted: 0, state: '' } : undefined;
  const segs = segments(chunks, opts.label, budget);
  const headers = new Set(segs.flatMap((s) => (s.header ? [s.data.slice(0, -1)] : [])));
  let omitted = budget?.omitted ?? 0;
  const dropped: string[] = [];
  if (opts.state) dropped.push(opts.state);
  if (budget?.state) dropped.push(budget.state);
  if (budget) omitted += cutInput(segs, budget.max, keep, dropped);
  if (keep === 'tail') omitted += cutToLastNewlines(segs, maxLines + 2 * rows, rows, dropped);
  // A cut inside a source's data keeps the header naming that source: the tail budget, cutInput and
  // cutToLastNewlines each dropped the segments before the cut, its header among them, and the first
  // lines kept were nobody's (a reviewer's read of the fixes for #22). The header is no input omitted.
  // It counts as a header for keepLines too: the tail budget dropped it inside `segments`, before the
  // headers were gathered, so a tail of 2 counted it as a line of output and cut it again (our read of the
  // house's fixes for its review of f3750e4, PR #22).
  // A cut inside the header itself kept its tail, `n r1]`, as the first line, and it is put back whole too:
  // what of it the cuts took is no input omitted either (a reviewer's read of the fixes for #22), as no cut
  // counts what it takes of a header (inputBytes).
  const first = segs[0];
  const named = first?.named ?? (first?.whole !== undefined && first.data !== first.whole ? first : undefined);
  if (named?.whole !== undefined) {
    named.data = named.whole;
    named.bytes = utf8Length(named.whole);
    if (named !== first) segs.unshift(named);
    headers.add(named.whole.slice(0, -1));
  }
  // A segment that begins inside a CSI is fed that CSI's head first (rule 6), as no input.
  for (const seg of segs) {
    if (seg.head === undefined) continue;
    seg.data = seg.head + seg.data;
    seg.lead = seg.head.length;
    delete seg.head;
  }
  const input = (seg: Segment, from = 0) => (seg.header ? 0 : utf8Length(seg.data.slice(Math.max(from, seg.lead ?? 0))));
  // The output before the range (`opts.state`) and the omitted head set lasting terminal state (rule 7): a scroll
  // region, modes, character sets. It applies before the first thing kept, a restored header too, as before a header a
  // cut kept whole, so a header lands in the state of the lines it names; and as no source's output, so margins it
  // sets have no known owner (Projector.owner).
  const state = dropped.length ? persistentState(dropped.map(persistentState).join('')) : '';

  const pr = new Projector(cols, rows, keep, maxLines);
  try {
    if (state) await pr.feed(state);
    let slice = performance.now();
    let headersFed = 0;
    // Where feeding stopped, when the head's lines were complete before the range's end.
    let stopped: { s: number; pos: number } | undefined;
    outer: for (let s = 0; s < segs.length; s++) {
      const seg = segs[s]!;
      if (seg.header) headersFed++;
      pr.feeding(seg.key.startsWith('n:') ? undefined : seg.key);
      let pos = 0;
      while (pos < seg.data.length) {
        if (keep === 'head' && pr.out.lines.length > maxLines + headersFed) {
          // The first maxLines lines are complete: the rest is not projected (rule 7).
          omitted += input(seg, pos) + segs.slice(s + 1).reduce((a, x) => a + input(x), 0);
          stopped = { s, pos };
          // A header the loop counted on reaching it but stopped before feeding wasn't fed (the look-alike count below).
          if (seg.header && pos === 0) headersFed--;
          break outer;
        }
        const end = batchEnd(seg.data, pos, pr.budget, cols);
        const raw = seg.data.slice(pos, end);
        await pr.feedBatch(seg.pipe ? pipeToTty(raw) : raw);
        await pr.afterBatch();
        pos = end;
        if (performance.now() - slice > 16) {
          await yieldTurn();
          slice = performance.now();
        }
      }
      // The next source starts on a fresh line (rule 6). No segment takes the next as a payload: a
      // control sequence a segment left open (its end lost with the events a gap stands for, or a held
      // line's at the end of the range) is ended by CAN first, before a note, a header or another
      // source's output alike (the house's read of ed4ecac, #22; an independent read of the fix for the
      // house's read of the 33 commits, #22, comment 6307350650: a title held open at the range's end
      // took a Run's held line, unlabelled).
      if (s + 1 < segs.length) {
        await pr.boundary();
        await pr.afterBatch();
      }
    }
    let lines = pr.finish(opts.open === true);
    // What a cut left out: input not projected, or lines dropped (Projection.cut).
    let cut = omitted > 0 || pr.out.dropped;
    const kept = keepLines(lines, maxLines, keep, headers);
    if (kept) {
      // Headers are known by their text, so an output line that reads as one (a `[terminal]` that `tsm read`'s own
      // output printed in a session) counts as a header too, and a cut that dropped it read as dropping headers alone:
      // nothing truncated, nothing omitted. Where more lines read as headers than header segments were fed, a dropped
      // one can't be told from such a line, so every dropped line counts (a reviewer's read of the fixes for #22).
      const outputs = (ls: string[]) => ls.filter((l) => !headers.has(l)).length;
      const lookalike = lines.length - outputs(lines) > headersFed;
      const made = lookalike ? lines.length - headersFed : outputs(lines);
      const gone = lookalike ? lines.length - kept.length : made - outputs(kept);
      // A cut that drops headers alone, naming sources that showed nothing (a Run that printed a title or blanks),
      // drops no line of output: nothing is truncated (an independent read of the fixes for #22).
      if (gone > 0) {
        // The head's cut of lines dropped what was fed past the last line it kept, in the batch where the limit fell
        // and, when the range fitted on the screen, in all of it: that input was not projected either. Left out, a
        // range of a few short lines over `maxLines` reported 0 omitted with `truncated`, which the reader takes for
        // lost (the house's review of a8b6f28..4860d4c, PR #22, comment 6341260318).
        if (keep === 'head') omitted += droppedInput(segs, maxLines, stopped, gone, made);
        cut = true;
      }
      // The head's cut dropped the lines after the ones kept: the line the cursor stands on is not the last shown.
      if (keep === 'head') pr.lastLine = undefined;
      lines = kept;
    }
    return {
      text: lines.join('\n'),
      truncated: cut || pr.lost,
      omittedInputBytes: omitted,
      ...(cut ? { cut: true as const } : {}),
      ...(pr.lost ? { lost: true as const } : {}),
      ...(pr.lastLine !== undefined ? { lastLine: pr.lastLine } : {}),
    };
  } finally {
    pr.dispose();
  }
}

/**
 * The input bytes of the `dropped` lines of output, of the `made`, that the head's cut of lines took (rule 7, head), from
 * what was fed (up to where feeding stopped; headers and a segment's CSI head are no input). When the lines made are the
 * input's lines, one per line end (`lineEnds`) bar an unfinished last, the dropped lines' input is what was fed after the
 * `n`th line end. Otherwise which line end closed which line can't be told (a cursor moved down, or a screen an erase kept,
 * made lines with none, as on every page the reader cuts to its `maxLines`; a redraw went back over lines), and the fed
 * input is shared among the lines it made, the dropped lines' share counting.
 */
function droppedInput(segs: readonly Segment[], n: number, stopped: { s: number; pos: number } | undefined, dropped: number, made: number): number {
  let ends = 0;
  let after = 0;
  let fed = 0;
  const last = stopped?.s ?? segs.length - 1;
  for (let s = 0; s <= last; s++) {
    const seg = segs[s]!;
    if (seg.header) continue;
    const end = s === stopped?.s ? stopped.pos : seg.data.length;
    const lead = seg.lead ?? 0;
    const bytes = utf8Length(seg.data.slice(lead, Math.max(lead, end)));
    fed += bytes;
    if (ends >= n) after += bytes;
    for (const e of lineEnds(seg.data.slice(0, end))) {
      if (++ends === n) after += utf8Length(seg.data.slice(Math.max(lead, e + 1), Math.max(lead, end)));
    }
  }
  const byLineEnds = ends >= n && Math.abs(made - ends) <= 1;
  // A dropped line counts a byte at least, so a cut never reads as lost.
  return Math.max(dropped > 0 ? 1 : 0, byLineEnds ? after : Math.round((fed * dropped) / Math.max(1, made)));
}

/**
 * The last (or first) `max` lines of output, with the header lines among them and the one naming the
 * first line's source; undefined when all of them fit. A header names a source and is no line of
 * output (rule 6), so `maxLines` counts output lines, and a tail of 5 across two sources showed 4 of
 * them (an independent read of the fix for the house's read of the 33 commits, #22, comment
 * 6307350650). Headers are known by their text. The header naming the first kept line's source is the
 * nearest one before it, wherever it sits: one only just before the cut was kept, and a tail of 3
 * over a Run's `a1` to `a3` then the pty's `p2` began with `a2` and no name (a reviewer's read of the
 * fixes for #22). The compat pack's logs take their tail of the reader's text by this rule too.
 */
export function keepLines(lines: string[], max: number, keep: 'head' | 'tail', headers: ReadonlySet<string>): string[] | undefined {
  if (lines.length <= max) return undefined;
  let count = 0;
  if (keep === 'tail') {
    let i = lines.length;
    while (i > 0 && count < max) if (!headers.has(lines[--i]!)) count++;
    if (i === 0) return undefined;
    const h = namingHeader(lines, i, headers);
    if (h === i - 1) return h > 0 ? lines.slice(h) : undefined;
    return h === -1 ? lines.slice(i) : [lines[h]!, ...lines.slice(i)];
  }
  let i = 0;
  while (i < lines.length && count < max) if (!headers.has(lines[i++]!)) count++;
  return i < lines.length ? lines.slice(0, i) : undefined;
}

/**
 * Where the header naming the source of `lines[first]` is: the nearest header line before it, wherever it
 * sits (rule 6); -1 when none is. The one rule for a tail's lines, the projection's (keepLines) and the
 * reader's byte fit (an independent read of the fixes for the review of f3750e4, PR #22: the fit had its own copy).
 */
export function namingHeader(lines: readonly string[], first: number, headers: ReadonlySet<string>): number {
  let h = first - 1;
  while (h >= 0 && !headers.has(lines[h]!)) h--;
  return h;
}

/** The projection's text alone (the tail survives `maxLines`); see `project`. */
export async function transcript(chunks: Iterable<ProjectChunk>, opts: TranscriptOptions = {}): Promise<string> {
  const o: ProjectOptions = { cols: opts.cols ?? DEFAULT_GEOMETRY.cols, rows: opts.rows ?? DEFAULT_GEOMETRY.rows };
  if (opts.maxLines !== undefined) o.maxLines = opts.maxLines;
  return (await project(chunks, o)).text;
}
