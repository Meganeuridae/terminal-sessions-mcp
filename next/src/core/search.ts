/**
 * Search over a journal range (§11 `search`): a regex over output lines with
 * control sequences stripped, each match anchored at the `seq` of the event
 * that completed its line, with lines of context, and the cursor that reads
 * from the start of that line.
 *
 * Lines are a matching projection, stated exactly here (§6 names search as
 * built from raw output and the transcript; this is the part that runs over
 * every retained line, so it is kept line-oriented and cheap):
 *
 * 1. Streams. The pty is one stream, and each process Run's stdout and stderr
 *    are one stream each; their lines never mix.
 * 2. Lines. A stream's raw bytes are joined across events and cut at LF, so a
 *    line is the same whatever the chunking: a CRLF, an escape sequence or a
 *    long line split across events reads as if it came in one piece.
 * 3. Cleaning. Control sequences are removed from the whole line, trailing CRs
 *    before the LF are dropped (a PTY writes a program's CRLF as CR CR LF), and
 *    a carriage return inside the line starts it over (a progress bar reads as
 *    its last state).
 * 4. Gaps. A `gap` event (output lost to retention, a torn write or a store
 *    failure) ends every unfinished line: nothing is joined across a hole.
 * 5. Bounds. A line's raw bytes are kept up to MAX_LINE_RAW (cut before a
 *    control sequence the cut would split), and it is matched on its head within
 *    the pattern's match window (`testBounded`); longer lines are counted in
 *    `clippedLines` (G11: the cut is visible). Displayed lines and context are
 *    cut at MAX_SHOWN characters, marked `clipped`; a context line cut either
 *    way marks the match it belongs to.
 * 6. The limit. Once `limit` matches are found, the first line that matches
 *    beyond them ends the matching, and the scan goes on only as far as the
 *    after-context of the last matches needs (`full` says when nothing more is
 *    wanted); `stop` is where that further match began, so a continuation finds
 *    it first.
 *
 * The scanner is incremental: feed events in order, in as many calls as the
 * caller likes (searchJournal pages, yields and stops on a budget), and ask
 * where to continue.
 */
import { stripAnsi } from './ansi.js';
import { testBounded } from './regex.js';
import { indexAtByte, unfinishedSequence, utf8Length } from './text.js';
import type { JournalEvent, Seq } from './types.js';

export interface SearchMatch {
  /** The event that completed the line. */
  seq: Seq;
  /** 1-based line number within the scanned range. */
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
  /** Pass as read `since` (with `offset`) to read from the start of this line: `seq` alone starts after it (er-6). */
  cursor: Seq;
  /** UTF-8 bytes into the first output event after `cursor` where the line starts; absent when 0. */
  offset?: number;
  /** The line (or a context line) is longer than shown, or than the part matched. */
  clipped?: true;
}

export interface SearchOptions {
  context?: number;
  limit?: number;
}

/** Raw characters of one line kept for matching; the rest of a longer line is dropped. */
export const MAX_LINE_RAW = 256 * 1024;
/** Characters of a line shown in a match or as context. */
export const MAX_SHOWN = 2000;

/** Where a line (or the scan) can be resumed: the seq before an event, and bytes into that event. */
export interface Resume {
  cursor: Seq;
  offset: number;
}

interface Carry {
  raw: string;
  /** The line's raw bytes passed MAX_LINE_RAW: only its head is kept. */
  cut: boolean;
  start: Resume;
}

const shown = (s: string): { text: string; cut: boolean } => (s.length > MAX_SHOWN ? { text: `${s.slice(0, MAX_SHOWN)}…`, cut: true } : { text: s, cut: false });

/** Rule 3: control sequences out, trailing CRs dropped, the last carriage return starts the line over. */
export function cleanLine(raw: string): string {
  const text = stripAnsi(raw).replace(/\r+$/, '');
  const cr = text.lastIndexOf('\r');
  return cr === -1 ? text : text.slice(cr + 1);
}

/** UTF-8 byte length of a string that may be all ASCII (the common case costs nothing). */
const bytesOf = (s: string, ascii: boolean): number => (ascii ? s.length : Buffer.byteLength(s));

export class LineScanner {
  readonly matches: SearchMatch[] = [];
  /** Lines completed so far. */
  lines = 0;
  /** Lines matched only on their head (rule 5). */
  clippedLines = 0;
  /** Where the first match past `limit` starts (set once the limit is reached). */
  stop: Resume | undefined;
  /** The limit was reached: lines still complete the last matches' after-context, but nothing more is matched. */
  private limited = false;
  private readonly context: number;
  private readonly limit: number;
  private readonly recent: Array<{ text: string; cut: boolean }> = [];
  private readonly waiting: SearchMatch[] = [];
  private readonly carries = new Map<string, Carry>();

  constructor(
    private readonly re: RegExp,
    opts: SearchOptions = {},
  ) {
    this.context = Math.max(0, Math.min(20, opts.context ?? 2));
    this.limit = Math.max(1, opts.limit ?? 50);
  }

  /**
   * `limit` matches were found, another matched, and their after-context is
   * complete: the scan should stop (the house's read of ed4ecac, #22: stopping
   * at the further match itself left the after-context short); `stop` is where
   * to continue.
   */
  get full(): boolean {
    return this.limited && this.waiting.length === 0;
  }

  /**
   * Feed the next event of the range (non-output events are ignored, gaps end
   * every line); from `offset` UTF-8 bytes on for a continuation that starts
   * inside it (the part before is not scanned).
   */
  feed(ev: JournalEvent, offset = 0): void {
    if (this.full) return;
    if (ev.type === 'gap') {
      this.flush(ev.seq);
      return;
    }
    if (ev.type !== 'output') return;
    const key = ev.stream === 'pty' ? 'pty' : `${ev.stream}:${ev.runId ?? ''}`;
    const i = indexAtByte(ev.data, offset);
    this.take(key, ev.data.slice(i), ev.seq, utf8Length(ev.data.slice(0, i)));
  }

  /** End of the range: unfinished lines are lines (anchored at `last`). */
  flush(last: Seq): void {
    for (const c of this.carries.values()) {
      if (this.full) break;
      if (c.raw) this.complete(c, last);
    }
    this.carries.clear();
  }

  /** The earliest start of an unfinished line: resuming there loses nothing (it may repeat lines of other streams). */
  pending(): Resume | undefined {
    let first: Resume | undefined;
    for (const c of this.carries.values()) {
      if (!first || c.start.cursor < first.cursor || (c.start.cursor === first.cursor && c.start.offset < first.offset)) first = c.start;
    }
    return first;
  }

  private take(key: string, data: string, seq: Seq, base: number): void {
    const ascii = data.length === Buffer.byteLength(data);
    let pos = 0;
    let bytes = base;
    let carry = this.carries.get(key);
    while (pos <= data.length && !this.full) {
      if (!carry) {
        if (pos === data.length) break;
        carry = { raw: '', cut: false, start: { cursor: seq - 1, offset: bytes } };
        this.carries.set(key, carry);
      }
      const nl = data.indexOf('\n', pos);
      const piece = data.slice(pos, nl === -1 ? undefined : nl);
      if (!carry.cut) {
        const room = MAX_LINE_RAW - carry.raw.length;
        if (piece.length > room) {
          // Cut before a control sequence the cut would split, so no half of one shows as text.
          const head = carry.raw + piece.slice(0, room);
          carry.raw = head.slice(0, unfinishedSequence(head));
          carry.cut = true;
        } else carry.raw += piece;
      }
      if (nl === -1) break;
      bytes += bytesOf(piece, ascii) + 1;
      pos = nl + 1;
      this.complete(carry, seq);
      this.carries.delete(key);
      carry = undefined;
    }
  }

  private complete(c: Carry, seq: Seq): void {
    const line = cleanLine(c.raw);
    this.lines++;
    // A line shown shorter than it was, by MAX_SHOWN or by the raw cut, is clipped wherever it appears.
    const view = shown(line);
    if (c.cut) view.cut = true;
    for (const m of this.waiting) {
      if (m.after.length < this.context) {
        m.after.push(view.text);
        if (view.cut) m.clipped = true;
      }
    }
    while (this.waiting.length && this.waiting[0]!.after.length >= this.context) this.waiting.shift();
    if (this.limited) return; // only the after-context was wanted of this line
    const t = testBounded(this.re, line);
    if (t.clipped || c.cut) this.clippedLines++;
    if (t.matched) {
      if (this.matches.length >= this.limit) {
        this.limited = true;
        this.stop = c.start;
        return;
      }
      const m: SearchMatch = { seq, lineNumber: this.lines, line: view.text, before: this.recent.map((r) => r.text), after: [], cursor: c.start.cursor };
      if (c.start.offset > 0) m.offset = c.start.offset;
      if (view.cut || t.clipped || this.recent.some((r) => r.cut)) m.clipped = true;
      this.matches.push(m);
      if (this.context > 0) this.waiting.push(m);
    }
    this.recent.push(view);
    if (this.recent.length > this.context) this.recent.shift();
  }
}
