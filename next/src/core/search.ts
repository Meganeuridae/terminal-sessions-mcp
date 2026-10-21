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
 * 1. Sources. The sources are the transcript's (§6 rule 6): the pty, and each
 *    process Run's stdout and stderr together, so `abc` on stdout then `def` and
 *    a LF on stderr is the line `abcdef`, as a read and the digests show it, and
 *    the lines of different sources never mix. A match on a Run's line names the
 *    pipe its first character came from (`stream`), and says `mixed` when the
 *    line holds output from both (the house's review of f3750e4..4f4c067, #22,
 *    comment 6315636412, question 4: they were two sources here and one there).
 * 2. Lines. A stream's raw bytes are joined across events and cut at each LF
 *    outside a control string (`lineEnds`, the one line-end rule: a LF inside a
 *    window title ends no line), so a line is the same whatever the chunking: a
 *    CRLF, an escape sequence or a long line split across events reads as if it
 *    came in one piece. A LF that a CSI executes inside it ends a line too, and
 *    the next line begins with the CSI's head, so its rest is no text (the
 *    house's review of the 40 commits through f3750e4, #22, comment 6310921374).
 * 3. Cleaning. The line is read as the transcript displays it (`cleanLine`):
 *    control sequences are removed, and a carriage return, a backspace, erase in
 *    line and in-line cursor moves apply as overwrites, so `ABCDE\rXY` reads
 *    `XYCDE`, a progress bar reads as its last state, and trailing CRs before the
 *    LF leave nothing (a PTY writes a program's CRLF as CR CR LF). Watches split a
 *    lone CR into frames instead (see LineSplitter), to match a bar as it moves.
 * 4. Gaps. A `gap` event (output lost to retention, a torn write or a store
 *    failure) ends every unfinished line: nothing is joined across a hole.
 * 5. Bounds. A line's raw bytes are kept up to MAX_LINE_RAW (cut before a
 *    control sequence the cut would split), and it is matched on its head within
 *    the pattern's match window (`testBounded`); longer lines are counted in
 *    `clippedLines` (G11: the cut is visible). Displayed lines and context are
 *    cut at MAX_SHOWN characters, marked `clipped`; a context line cut either
 *    way marks the match it belongs to.
 * 6. The limit, and stopping. Once `limit` matches are found, the first line
 *    that matches beyond them ends the matching, and the scan goes on only as
 *    far as the after-context of the last matches needs (`full` says when
 *    nothing more is wanted); `stop` is where that further match began, so a
 *    continuation finds it first. Unless that line began where the scan began:
 *    a continuation could never start it again from a later point, so it is
 *    matched now, beyond the limit. Where a scan stops, at the limit or a
 *    budget, a line still open that began where the scan began, or before other
 *    lines completed (a prompt without its newline, another source's line among
 *    this one's), is matched now on what there is of it (`settle`): a
 *    continuation never scans completed lines again. Its rest, if any, is a line
 *    of its own to the continuation. A line cut at the very end stays pending,
 *    and the continuation starts at its start, so no match straddling the cut is
 *    missed (the house's reads of ed4ecac and 1cabc6a, #22).
 *
 * The scanner is incremental: feed events in order, in as many calls as the
 * caller likes (searchJournal pages, yields and stops on a budget), and ask
 * where to continue.
 */
import { cleanLine } from './ansi.js';
import { testBounded } from './regex.js';
import { headAt, indexAtByte, isStringStart, lineCarry, lineEnds, showsCharacter, unfinishedSequence, utf8Length, type LineCarry } from './text.js';
import type { JournalEvent, OutputStream, Seq } from './types.js';

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
  /** A process Run's line: the pipe its first character came from (rule 1). */
  stream?: 'stdout' | 'stderr';
  /** The line holds output from both of the Run's pipes. */
  mixed?: true;
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
  /**
   * The stream of the piece holding the first character the line shows (of the event it began in until one shows),
   * and whether a piece from the other pipe shows a character of the line too, within what the line keeps (rule 1).
   */
  stream: OutputStream;
  mixed: boolean;
  /** The line shows a character: `stream` is decided. */
  shown: boolean;
  start: Resume;
  /** Lines completed when this one began (rule 6: more since means other lines came between). */
  linesAt: number;
}

const before = (a: Resume, b: Resume): boolean => a.cursor < b.cursor || (a.cursor === b.cursor && a.offset < b.offset);

const shown = (s: string): { text: string; cut: boolean } => (s.length > MAX_SHOWN ? { text: `${s.slice(0, MAX_SHOWN)}…`, cut: true } : { text: s, cut: false });

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
  /** A match past `limit` was found (`stop` says where): lines still complete the last matches' after-context, but nothing more is matched. */
  limited = false;
  private readonly context: number;
  private readonly limit: number;
  private readonly recent: Array<{ text: string; cut: boolean }> = [];
  private readonly waiting: SearchMatch[] = [];
  private readonly carries = new Map<string, Carry>();
  /** Per stream, what its data left unfinished for the line-end rule (lineEnds); a hole ends it all. */
  private readonly scans = new Map<string, LineCarry>();
  /** Where the scan began: the point before the first event fed, as a continuation names it (rule 6). */
  private start: Resume | undefined;

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
    this.start ??= { cursor: ev.seq - 1, offset };
    if (ev.type === 'gap') {
      this.flush(ev.seq);
      this.scans.clear();
      return;
    }
    if (ev.type !== 'output') return;
    const key = ev.stream === 'pty' ? 'pty' : `p:${ev.runId ?? ''}`;
    const i = indexAtByte(ev.data, offset);
    // A continuation that starts inside a CSI (a line begun after a LF the CSI executed) reads it on from its head.
    const head = i > 0 && !this.scans.has(key) ? headAt(ev.data, i) : '';
    if (head) this.scans.set(key, { open: head });
    this.take(key, ev.data.slice(i), ev.seq, utf8Length(ev.data.slice(0, i)), ev.stream);
  }

  /**
   * End of the range: unfinished lines are lines (anchored at `last`). One of them can be
   * the match past the limit: the scan stops there (`stop`), and the lines still unfinished
   * stay for `pending()`.
   */
  flush(last: Seq): void {
    for (const [key, c] of this.carries) {
      if (this.full) break;
      if (c.raw) this.complete(c, last);
      this.carries.delete(key);
    }
  }

  /**
   * Where a stopped scan leaves its open lines (rule 6): one open since the scan began, or begun
   * before other lines completed, is matched now on what there is of it, anchored at `last`; the
   * lines cut at the very end stay pending.
   */
  settle(last: Seq): void {
    const lines = this.lines;
    for (const [key, c] of this.carries) {
      // A line begun at or after the match past the limit is the continuation's whole (the scan went
      // on past that match only for the last matches' after-context): it stays as it is.
      if (this.stop !== undefined && !before(c.start, this.stop)) continue;
      if (this.progressed(c.start) && c.linesAt === lines) continue;
      if (c.raw) this.complete(c, last, true);
      this.carries.delete(key);
    }
  }

  /** True when a continuation from `at` gets further than this scan's start. */
  private progressed(at: Resume): boolean {
    const s = this.start;
    return s === undefined || at.cursor > s.cursor || (at.cursor === s.cursor && at.offset > s.offset);
  }

  /** The earliest start of an unfinished line: resuming there loses nothing (it may repeat lines of other streams). */
  pending(): Resume | undefined {
    let first: Resume | undefined;
    for (const c of this.carries.values()) {
      if (!first || c.start.cursor < first.cursor || (c.start.cursor === first.cursor && c.start.offset < first.offset)) first = c.start;
    }
    return first;
  }

  private take(key: string, data: string, seq: Seq, base: number, stream: OutputStream): void {
    const ascii = data.length === Buffer.byteLength(data);
    let pos = 0;
    let bytes = base;
    let carry = this.carries.get(key);
    let scan = this.scans.get(key);
    if (!scan) this.scans.set(key, (scan = lineCarry()));
    // A line begun inside a CSI, after a LF it executed, begins with the CSI's head (rule 2): the one open
    // where this data begins, or the one a line end inside this data names.
    let head = isStringStart(scan.open, 0) ? '' : scan.open;
    // What a piece reads on from for showsCharacter: what the stream left open before this data, then each later
    // line's head.
    let open = scan.open;
    const heads = new Map<number, string>();
    // A LF inside a window title ends no line: search found the title's rest as a line of its own, and not
    // the line the tail showed (an independent read of the fix for the house's read of the 33 commits, #22,
    // comment 6307350650).
    const ends = lineEnds(data, scan, Number.POSITIVE_INFINITY, false, heads);
    let e = 0;
    while (pos <= data.length && !this.full) {
      if (!carry) {
        if (pos === data.length) break;
        carry = { raw: head, cut: false, stream, mixed: false, shown: false, start: { cursor: seq - 1, offset: bytes }, linesAt: this.lines };
        this.carries.set(key, carry);
      }
      const nl = e < ends.length ? ends[e++]! : -1;
      const piece = data.slice(pos, nl === -1 ? undefined : nl);
      // What of the piece the line keeps, found without slicing `raw`, which would flatten it once per piece.
      let kept = '';
      if (!carry.cut) {
        const room = MAX_LINE_RAW - carry.raw.length;
        if (piece.length > room) {
          // Cut before a control sequence the cut would split, so no half of one shows as text.
          const head = carry.raw + piece.slice(0, room);
          const at = unfinishedSequence(head);
          kept = piece.slice(0, Math.max(0, at - carry.raw.length));
          carry.raw = head.slice(0, at);
          carry.cut = true;
        } else {
          kept = piece;
          carry.raw += piece;
        }
      }
      // Only what the line keeps names a pipe, and only once it shows a character.
      if (stream !== 'pty' && kept && !carry.mixed && !(carry.shown && stream === carry.stream) && showsCharacter(open, kept)) {
        if (!carry.shown) {
          carry.stream = stream;
          carry.shown = true;
        } else carry.mixed = true;
      }
      if (nl === -1) break;
      bytes += bytesOf(piece, ascii) + 1;
      pos = nl + 1;
      head = heads.get(nl) ?? '';
      open = head;
      this.complete(carry, seq);
      this.carries.delete(key);
      carry = undefined;
    }
  }

  /** A line is complete; `settled` ones are matched whatever the limit (rule 6). */
  private complete(c: Carry, seq: Seq, settled = false): void {
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
    if (this.limited && !settled) return; // only the after-context was wanted of this line (a settled one is still matched, rule 6)
    const t = testBounded(this.re, line);
    if (t.clipped || c.cut) this.clippedLines++;
    if (t.matched) {
      // The match past the limit stops the scan where its line starts, unless that is where the
      // scan started: then the line is matched now, beyond the limit (rule 6).
      if (!settled && this.matches.length >= this.limit && this.progressed(c.start)) {
        this.limited = true;
        this.stop = c.start;
        return;
      }
      const m: SearchMatch = { seq, lineNumber: this.lines, line: view.text, before: this.recent.map((r) => r.text), after: [], cursor: c.start.cursor };
      if (c.start.offset > 0) m.offset = c.start.offset;
      if (view.cut || t.clipped || this.recent.some((r) => r.cut)) m.clipped = true;
      if (c.stream !== 'pty') m.stream = c.stream;
      if (c.mixed) m.mixed = true;
      this.matches.push(m);
      if (this.context > 0) this.waiting.push(m);
    }
    this.recent.push(view);
    if (this.recent.length > this.context) this.recent.shift();
  }
}
