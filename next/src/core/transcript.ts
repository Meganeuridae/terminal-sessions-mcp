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
 *    that source ends it with a LF, so lines of different sources never mix
 *    (two concurrent Runs, or a Run and the shell); the held ends of lines
 *    follow at the end of the range (or before a note), in the order they
 *    began. When the source changes, the next source starts on a fresh line,
 *    under a header line when `label` gives one. A `note` chunk is a line of its
 *    own (a reader's `[… events missing …]` marker), never part of any source.
 * 7. Budgets, all visible (G11). `maxInputBytes` caps the UTF-8 bytes projected:
 *    the head or tail (`keep`, default `tail`) is kept, cut on a line boundary
 *    when one lies in the half of the budget nearest the cut and never inside a
 *    character, and `omittedInputBytes` says how much was not projected.
 *    `maxLines` (default 50 000) caps the logical lines returned, keeping the
 *    head or tail. When keeping the tail, input older than the last
 *    `maxLines + 2·rows` newlines is not projected (it cannot contribute to the
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
import { headIndex, sequenceEnd, tailStart, utf8Length } from './text.js';

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
  /** `pty`, `p:<runId>` for a process Run's pipes, or `n:<i>` for a note. */
  key: string;
  pipe: boolean;
  data: string;
  /** UTF-8 bytes of `data`. */
  bytes: number;
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
 * and printed cells over the width.
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
    if (c === 0x1b || c === 0x9b) {
      const e = sequenceEnd(data, i);
      if (e === undefined) return i > from ? i : data.length;
      if (i > from) safe = i;
      escapes++;
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
    if (c === 0x0a || c === 0x1b || c === 0x9b) safe = next;
    i = next;
  }
  // At the cap, not inside a sequence (a straddling one moved `i` past it) and not inside a pair.
  return i < data.length && (data.charCodeAt(i) & 0xfc00) === 0xdc00 && i - 1 > from ? i - 1 : i;
}

const pipeToTty = (s: string): string => s.replace(/\n/g, '\r\n');

/**
 * Merge chunks into runs of one source, interleaved by whole lines (rule 6):
 * each source's data is emitted up to its last LF, and the rest is held until
 * that source ends the line. Held ends are emitted, in the order they began,
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
 * `budget.state`, as `cutInput`'s does. The exact cut is still `cutInput`'s.
 */
function segments(chunks: Iterable<ProjectChunk>, label: ProjectOptions['label'], budget?: Budget): Segment[] {
  const out: Segment[] = [];
  let outBytes = 0;
  const held = new Map<string, { info: SourceInfo; pipe: boolean; data: string; bytes: number; full: boolean }>();
  let notes = 0;
  const drop = (data: string, bytes: number) => {
    budget!.omitted += bytes;
    if (budget!.keep === 'tail') budget!.state = persistentState(budget!.state + persistentState(data));
  };
  const emit = (key: string, pipe: boolean, info: SourceInfo | undefined, data: string) => {
    const bytes = utf8Length(data);
    if (budget?.keep === 'head' && outBytes >= budget.max) {
      drop(data, bytes);
      return;
    }
    outBytes += bytes;
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.data += data;
      last.bytes += bytes;
    } else {
      const header = info && label?.(info);
      if (header) {
        const h = `${header}\n`;
        out.push({ key: `n:${notes++}`, pipe: true, data: h, bytes: utf8Length(h) });
        outBytes += utf8Length(h);
      }
      out.push({ key, pipe, data, bytes });
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
      const gone = end.data.slice(0, cut);
      end.data = end.data.slice(cut);
      outBytes -= end.bytes;
      end.bytes = utf8Length(end.data);
      outBytes += end.bytes;
      drop(gone, utf8Length(gone));
    }
  };
  const flush = () => {
    for (const [key, h] of held) if (h.data) emit(key, h.pipe, h.info, h.data);
    held.clear();
  };
  for (const ch of chunks) {
    if (typeof ch !== 'string' && 'note' in ch) {
      flush();
      const n = `${ch.note}\n`;
      emit(`n:${notes++}`, true, undefined, n);
      continue;
    }
    const c = typeof ch === 'string' ? { data: ch } : ch;
    if (!c.data) continue;
    const pipe = c.stream === 'stdout' || c.stream === 'stderr';
    const key = pipe ? `p:${c.runId ?? ''}` : 'pty';
    let h = held.get(key);
    if (!h) {
      // A Run's pipes together are labelled `stdout`.
      const info: SourceInfo = { stream: pipe ? 'stdout' : 'pty' };
      if (pipe && c.runId !== undefined) info.runId = c.runId;
      h = { info, pipe, data: '', bytes: 0, full: false };
      held.set(key, h);
    }
    // Only the new data is searched for a LF, so a long unfinished line costs its length once.
    const nl = c.data.lastIndexOf('\n');
    if (nl === -1) {
      if (h.full) {
        drop(c.data, utf8Length(c.data));
        continue;
      }
      h.data += c.data;
      h.bytes += utf8Length(c.data);
      if (budget && h.bytes > 2 * budget.max) {
        // An unfinished line past twice the budget: only a budget's worth of it can survive. Kept
        // head: that worth is its start, and the rest of the line (`full`) is dropped as it comes.
        const cut = budget.keep === 'tail' ? tailStart(h.data, budget.max) : headIndex(h.data, budget.max);
        const gone = budget.keep === 'tail' ? h.data.slice(0, cut) : h.data.slice(cut);
        h.data = budget.keep === 'tail' ? h.data.slice(cut) : h.data.slice(0, cut);
        h.bytes = utf8Length(h.data);
        h.full = budget.keep === 'head';
        drop(gone, utf8Length(gone));
      }
      continue;
    }
    if (h.full) drop(c.data.slice(0, nl + 1), utf8Length(c.data.slice(0, nl + 1)));
    emit(key, pipe, h.info, h.full ? h.data : h.data + c.data.slice(0, nl + 1));
    // Re-inserted, so the held ends keep the order in which they began.
    held.delete(key);
    h.data = c.data.slice(nl + 1);
    h.bytes = utf8Length(h.data);
    h.full = false;
    if (h.data) held.set(key, h);
  }
  flush();
  return out;
}

/** Drop the segments before `k` and segment `k`'s data before `at`; the dropped data goes to `dropped`. */
function dropHead(segs: Segment[], k: number, at: number, dropped: string[]): void {
  for (let i = 0; i < k; i++) dropped.push(segs[i]!.data);
  dropped.push(segs[k]!.data.slice(0, at));
  segs[k]!.data = segs[k]!.data.slice(at);
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
    const nl = end > 0 ? seg.data.lastIndexOf('\n', end - 1) : -1;
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
 * Keep only input after the newline that precedes the last `n` newlines (rule 7,
 * tail). Newlines inside a full-screen program's time on the alternate screen
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
    const d = seg.data;
    let i = d.length;
    let sw = k in lastSwitch ? lastSwitch[k] : seg.pipe ? undefined : altSwitchBefore(d, i);
    while (i > 0) {
      const nl = d.lastIndexOf('\n', i - 1);
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
  let omitted = budget?.omitted ?? 0;
  const dropped: string[] = budget?.state ? [budget.state] : [];
  if (budget) omitted += cutInput(segs, budget.max, keep, dropped);
  if (keep === 'tail') omitted += cutToLastNewlines(segs, maxLines + 2 * rows, rows, dropped);
  // The omitted head still set lasting terminal state (rule 7): a scroll region, modes, character sets.
  const state = dropped.length ? persistentState(dropped.map(persistentState).join('')) : '';
  if (state && segs[0]) segs[0].data = state + segs[0].data;

  const pr = new Projector(cols, rows, keep, maxLines);
  try {
    let slice = performance.now();
    outer: for (let s = 0; s < segs.length; s++) {
      const seg = segs[s]!;
      let pos = 0;
      while (pos < seg.data.length) {
        if (keep === 'head' && pr.out.lines.length > maxLines) {
          // The first maxLines lines are complete: the rest is not projected (rule 7).
          omitted += utf8Length(seg.data.slice(pos)) + segs.slice(s + 1).reduce((a, x) => a + utf8Length(x.data), 0);
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
      // The next source starts on a fresh line (rule 6). A note or header is never part of any
      // source: a control sequence the output before it left open (its end lost with the events a
      // gap stands for) must not take the note as its payload, so CAN ends anything in progress
      // first (the house's read of ed4ecac, #22).
      if (s + 1 < segs.length) {
        const cancel = segs[s + 1]!.key.startsWith('n:') ? '\x18' : '';
        const fresh = pr.cursorX > 0 ? '\r\n' : '';
        if (cancel || fresh) {
          await pr.feed(cancel + fresh);
          await pr.afterBatch();
        }
      }
    }
    let lines = pr.finish(opts.open === true);
    let truncated = omitted > 0 || pr.lost || pr.out.dropped;
    if (lines.length > maxLines) {
      lines = keep === 'tail' ? lines.slice(-maxLines) : lines.slice(0, maxLines);
      truncated = true;
    }
    return { text: lines.join('\n'), truncated, omittedInputBytes: omitted };
  } finally {
    pr.dispose();
  }
}

/** The projection's text alone (the tail survives `maxLines`); see `project`. */
export async function transcript(chunks: Iterable<ProjectChunk>, opts: TranscriptOptions = {}): Promise<string> {
  const o: ProjectOptions = { cols: opts.cols ?? DEFAULT_GEOMETRY.cols, rows: opts.rows ?? DEFAULT_GEOMETRY.rows };
  if (opts.maxLines !== undefined) o.maxLines = opts.maxLines;
  return (await project(chunks, o)).text;
}
