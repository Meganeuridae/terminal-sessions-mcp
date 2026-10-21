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
 *    read as the whole range does.
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
 *    under a header line when `label` gives one. A `note` chunk is a line of its
 *    own (a reader's `[… events missing …]` marker), never part of any source.
 *    A LF that a CSI executes inside it ends a line (`lineEnds`), so the interleave
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
 *    counts as omitted. Any omission or dropped line sets `truncated`. Input
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

export type ProjectChunk = string | { data: string; stream?: 'pty' | 'stdout' | 'stderr'; runId?: string } | { note: string };

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
}

export interface Projection {
  text: string;
  /** True when any input was omitted or any line dropped (G11). */
  truncated: boolean;
  /** UTF-8 bytes of input not projected. */
  omittedInputBytes: number;
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

class Projector {
  readonly term: TerminalType;
  readonly out: Lines;
  /** Rows may have scrolled out of the scratch scrollback unread (a batch outran its bound). */
  lost = false;
  private readonly capacity: number;

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

  get cursorX(): number {
    return this.term.buffer.active.cursorX;
  }

  /** Rows the next batch may add before the scratch scrollback could drop an unread row. */
  get budget(): number {
    return Math.max(1, SCRATCH_SCROLLBACK - 1 - this.term.buffer.normal.baseY);
  }

  /** The final text: kept lines, then the normal buffer, then the frame if a full-screen program is still up. */
  finish(open = false): string[] {
    const n = this.term.buffer.normal;
    const alt = this.term.buffer.active.type === 'alternate';
    let last = lastNonEmpty(n);
    let unfinished = false;
    if (open && !alt) {
      // A range that a next range continues keeps what the next one builds on: the blank
      // lines it ended with (every line it began, up to the cursor's), and an unfinished
      // last line with its trailing whitespace (rule 3).
      const row = n.baseY + n.cursorY;
      if (n.cursorX > 0) {
        unfinished = row >= last;
        last = Math.max(last, row);
      } else last = Math.max(last, row - 1);
    }
    this.rowsOut(n, 0, last + 1);
    if (alt) this.frameOut(this.term.buffer.alternate);
    if (!unfinished) this.out.close();
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
    }
    return false;
  }

  /** Entering the alternate screen: keep the content above the cursor (rule 5). */
  private onAltEnter(params: (number | number[])[]): boolean {
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
    return false;
  }

  /** Leaving the alternate screen: keep its final frame (rule 5). */
  private onAltExit(params: (number | number[])[]): boolean {
    const buf = this.term.buffer.active;
    if (buf.type !== 'alternate' || !params.some((p) => ALT_MODES.has(num(p)))) return false;
    this.frameOut(buf);
    return false;
  }

  /** RIS clears both buffers: keep them first (rule 4). */
  private onReset(): boolean {
    const n = this.term.buffer.normal;
    this.rowsOut(n, 0, lastNonEmpty(n) + 1);
    this.out.close();
    if (this.term.buffer.active.type === 'alternate') this.frameOut(this.term.buffer.alternate);
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
   * source's data before it left unfinished (its carry): what goes is omitted. An ESC held back from
   * the string that a new sequence's start turned out to be comes back with it.
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
    if (gone) drop(gone, utf8Length(gone));
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
    if (last && last.key === key) {
      // The data goes on from where the segment's ends: a head it began inside is in the segment already.
      last.data += data;
      last.bytes += bytes;
    } else {
      const header = info && label?.(info);
      let named: Segment | undefined;
      if (header) {
        const h = `${header}\n`;
        named = { key: `n:${notes++}`, pipe: true, data: h, bytes: utf8Length(h), header: true };
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
      drop(gone.data, gone.bytes);
    }
    // One source's run past twice the budget: only its last budget's worth can survive.
    const end = out[out.length - 1]!;
    if (end.bytes > 2 * budget.max) {
      const cut = tailStart(end.data, budget.max);
      leaveOpen(end.key, end.data, cut);
      const gone = end.data.slice(0, cut);
      cutFront(end, cut);
      outBytes -= end.bytes;
      end.bytes = utf8Length(end.data);
      outBytes += end.bytes;
      drop(gone, utf8Length(gone));
    }
  };
  const flush = () => {
    for (const [key, h] of held) if (h.data) emit(key, h.pipe, h.info, h.data, h.head);
    held.clear();
  };
  for (const ch of chunks) {
    if (typeof ch !== 'string' && 'note' in ch) {
      flush();
      carries.clear();
      dropping.clear();
      pending.clear();
      const n = `${ch.note}\n`;
      emit(`n:${notes++}`, true, undefined, n);
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
        const cut = budget.keep === 'tail' ? tailStart(h.data, budget.max) : headIndex(h.data, budget.max);
        if (budget.keep === 'tail') {
          leaveOpen(key, h.data, cut);
          // More than the budget goes from this line, which follows every segment emitted so far: none of
          // them can survive the cut. Kept, `head` before a title's payload held whole survived the
          // payload's 20 KB (a title's LFs end no line now, so the payload is a held line's).
          for (const s of out.splice(0)) drop(s.data, s.bytes);
          outBytes = 0;
        }
        const gone = budget.keep === 'tail' ? h.data.slice(0, cut) : h.data.slice(cut);
        if (budget.keep === 'tail') cutFront(h, cut);
        else h.data = h.data.slice(0, cut);
        h.bytes = utf8Length(h.data);
        h.full = budget.keep === 'head';
        drop(gone, utf8Length(gone));
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
  for (let i = 0; i < k; i++) dropped.push(segs[i]!.data);
  dropped.push(segs[k]!.data.slice(0, at));
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
  if (keep === 'tail') {
    let acc = 0;
    let k = segs.length - 1;
    while (k >= 0 && acc + sizes[k]! <= max) acc += sizes[k--]!;
    // Segment k holds the cut; the budget left for it is max - acc.
    dropHead(segs, k, tailStart(segs[k]!.data, max - acc), dropped);
  } else {
    let acc = 0;
    let k = 0;
    while (k < segs.length && acc + sizes[k]! <= max) acc += sizes[k++]!;
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
  return total - segs.reduce((a, s) => a + utf8Length(s.data), 0);
}

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
    const omitted = segs.slice(0, k).reduce((a, s) => a + utf8Length(s.data), 0) + utf8Length(segs[k]!.data.slice(0, at));
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
  const dropped: string[] = budget?.state ? [budget.state] : [];
  if (budget) omitted += cutInput(segs, budget.max, keep, dropped);
  if (keep === 'tail') omitted += cutToLastNewlines(segs, maxLines + 2 * rows, rows, dropped);
  // A cut inside a source's data keeps the header naming that source: the tail budget, cutInput and
  // cutToLastNewlines each dropped the segments before the cut, its header among them, and the first
  // lines kept were nobody's (a reviewer's read of the fixes for #22). The header is no input omitted.
  const first = segs[0];
  if (first?.named) {
    segs.unshift(first.named);
    omitted -= first.named.bytes;
  }
  // A segment that begins inside a CSI is fed that CSI's head first (rule 6), as no input.
  for (const seg of segs) {
    if (seg.head === undefined) continue;
    seg.data = seg.head + seg.data;
    seg.lead = seg.head.length;
    delete seg.head;
  }
  const input = (seg: Segment, from = 0) => utf8Length(seg.data.slice(Math.max(from, seg.lead ?? 0)));
  // The omitted head still set lasting terminal state (rule 7): a scroll region, modes, character sets.
  // It applies before the first thing kept, a restored header too, as before a header a cut kept whole,
  // so a header lands in the state of the lines it names.
  const state = dropped.length ? persistentState(dropped.map(persistentState).join('')) : '';
  if (state && segs[0]) segs[0].data = state + segs[0].data;

  const pr = new Projector(cols, rows, keep, maxLines);
  try {
    let slice = performance.now();
    let headersFed = 0;
    outer: for (let s = 0; s < segs.length; s++) {
      const seg = segs[s]!;
      if (seg.header) headersFed++;
      let pos = 0;
      while (pos < seg.data.length) {
        if (keep === 'head' && pr.out.lines.length > maxLines + headersFed) {
          // The first maxLines lines are complete: the rest is not projected (rule 7).
          omitted += input(seg, pos) + segs.slice(s + 1).reduce((a, x) => a + input(x), 0);
          break outer;
        }
        const end = batchEnd(seg.data, pos, pr.budget, cols);
        const raw = seg.data.slice(pos, end);
        await pr.feed(seg.pipe ? pipeToTty(raw) : raw);
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
        await pr.feed(`\x18${pr.cursorX > 0 ? '\r\n' : ''}`);
        await pr.afterBatch();
      }
    }
    let lines = pr.finish(opts.open === true);
    let truncated = omitted > 0 || pr.lost || pr.out.dropped;
    const kept = keepLines(lines, maxLines, keep, headers);
    if (kept) {
      lines = kept;
      truncated = true;
    }
    return { text: lines.join('\n'), truncated, omittedInputBytes: omitted };
  } finally {
    pr.dispose();
  }
}

/**
 * The last (or first) `max` lines of output, with the header lines among them and the one naming the
 * first line's source; undefined when all of them fit. A header names a source and is no line of
 * output (rule 6), so `maxLines` counts output lines, and a tail of 5 across two sources showed 4 of
 * them (an independent read of the fix for the house's read of the 33 commits, #22, comment
 * 6307350650). Headers are known by their text. The header naming the first kept line's source is the
 * nearest one before it, wherever it sits: one only just before the cut was kept, and a tail of 3
 * over a Run's `a1` to `a3` then the pty's `p2` began with `a2` and no name (a reviewer's read of the
 * fixes for #22).
 */
function keepLines(lines: string[], max: number, keep: 'head' | 'tail', headers: ReadonlySet<string>): string[] | undefined {
  if (lines.length <= max) return undefined;
  let count = 0;
  if (keep === 'tail') {
    let i = lines.length;
    while (i > 0 && count < max) if (!headers.has(lines[--i]!)) count++;
    if (i === 0) return undefined;
    let h = i - 1;
    while (h >= 0 && !headers.has(lines[h]!)) h--;
    if (h === i - 1) return h > 0 ? lines.slice(h) : undefined;
    return h === -1 ? lines.slice(i) : [lines[h]!, ...lines.slice(i)];
  }
  let i = 0;
  while (i < lines.length && count < max) if (!headers.has(lines[i++]!)) count++;
  return i < lines.length ? lines.slice(0, i) : undefined;
}

/** The projection's text alone (the tail survives `maxLines`); see `project`. */
export async function transcript(chunks: Iterable<ProjectChunk>, opts: TranscriptOptions = {}): Promise<string> {
  const o: ProjectOptions = { cols: opts.cols ?? DEFAULT_GEOMETRY.cols, rows: opts.rows ?? DEFAULT_GEOMETRY.rows };
  if (opts.maxLines !== undefined) o.maxLines = opts.maxLines;
  return (await project(chunks, o)).text;
}
