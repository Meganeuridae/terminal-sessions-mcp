/**
 * Lines of output for *matching*: `cleanLine` reads one line as the transcript
 * would display it, and `LineSplitter`/`StreamMatcher` cut a stream into such
 * lines for watches, wait_for and service probes; search reads its lines through
 * `cleanLine` too. Rendering text for reading goes through the transcript
 * projection (§6), never through this.
 */
import { err } from './errors.js';
import { compileUserRegex, execBounded } from './regex.js';
import { lineCarry, lineEnds, safeCut, sequenceEnd, type LineCarry } from './text.js';

/**
 * The longest line a StreamMatcher holds: a longer one is matched on its first MAX_LINE, the hit says
 * `clipped`, and the rest of the line is dropped. Also the farthest column a cursor move can carry
 * `cleanLine`'s cursor to: a terminal's width bounds a move; with no width here, this does.
 */
export const MAX_LINE = 64 * 1024;

/** The in-line controls `cleanLine` applies: erase in line (K), cursor back (D), forward (C), to a column (G). */
const LINE_CONTROL = /^(?:\x1b\[|\x9b)([0-9;]*)([KDCG])$/;

/**
 * The widths the emulator gives characters: xterm's built-in Unicode 6 table (Markus Kuhn's wcwidth),
 * since the transcript and the screen load no other. Zero cells for a combining or enclosing mark,
 * a format character and a Hangul medial vowel or final consonant; two for the East Asian wide and
 * fullwidth ranges; one for everything else, emoji included (the table predates their wide form).
 * Marks added to Unicode since 5.0, which the table predates, read as zero cells here and one there.
 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\u0600-\u0603\u06dd\u06de\u070f\u1160-\u11ff\u1734\u200b-\u200f\u202a-\u202e\u2060-\u2063\u206a-\u206f\u302e\u302f\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}]$/u;
const WIDE = /^[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]$/u;

/** The cells one character takes on a terminal row, as the emulator lays it out: none, one or two. */
export function cellWidth(ch: string): 0 | 1 | 2 {
  // Nothing below U+0300, where the combining marks begin, is zero-width or wide: most text skips the two tests.
  if (ch.charCodeAt(0) < 0x300) return 1;
  return ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
}

/**
 * One line of output as a reader sees it, rendered as the transcript renders a row: a cursor over
 * a row of cells, to which a carriage return (column 0), a backspace (one cell left), a tab (the
 * next tab stop, every eight cells), erase in line (`ESC [ K` to the end, `1K` to the start, `2K`
 * the whole row), and cursor back, forward and to-column moves (`ESC [ n D`, `n C`, `n G`) apply;
 * every other sequence is dropped (the house's read of 78c4d6e, #22: `Progress: 100%\r\x1b[KDone`
 * read `Doneress: 100%` where the transcript shows `Done`). A wide character takes two cells and a
 * combining mark none, as on the row, so a move lands where the transcript's cursor would, and
 * overwriting half a wide character blanks it whole (the house's read of the 38 commits, #22,
 * comment 6274773484: `ab\tc\x1b[2Dz` read `abzc` against the row's `ab     zc`, `日本\x1b[1Dx`
 * read `日x` against `日 x`). So `ABCDE\rXY` reads `XYCDE`, `abcdef\x1b[3DXY` reads `abcXYf`,
 * `abc\x1b[5Cz` reads `abc     z`, and a spinner's `|\b/\b-\b\\` reads its last frame. A move
 * past the end of what the row holds pads with blanks when the next character is written, as a
 * terminal does up to its width; with no width here, no move carries the cursor past MAX_LINE, or
 * past the row's end once the row is longer, so the row grows by at most what is written (the same
 * read: a move and a write repeated grew a line to eight million cells). Trailing blanks stay (a pattern may
 * anchor on them); a display trims them. Search, watches and the segmenter read lines through
 * this one function (the house's read of 3eade8a, #22). The overwrites are applied on the raw
 * text, sequences skipped by `sequenceEnd`, so no character stands in for a backspace: a U+E000 in
 * the output is text (the house's read of 39787b3, #22, found it taken for one). A sequence left
 * unfinished at the end takes the rest of the text with it: its payload is not text (the same
 * read: `ready\x1b]0;title` read `ready]0;title`).
 *
 * Where it differs from the emulator's row (the house's read of the 33 commits, #22, comment
 * 6307351104): tab stops are xterm's defaults, every eight columns, always. A line that sets or
 * clears a stop (HTS `ESC H`, TBC `ESC [ g`) or moves by stops (CHT `ESC [ n I`, CBT `ESC [ n Z`)
 * reads as if it had not: `abc ESC H x CR q TAB Z` reads `qbcx    Z` where xterm shows `qbcZ`.
 * Stops an earlier line set cannot be seen from one line at all. And a combining mark Unicode added
 * after the emulator's table (U+1AB0, Unicode 7) takes no cell here and one there (see cellWidth).
 */
export function cleanLine(raw: string): string {
  // A wide character's second cell holds '' (its continuation); a combining mark joins the cell before it.
  const cells: string[] = [];
  let col = 0;
  const moveTo = (c: number) => (col = Math.max(0, Math.min(c, Math.max(cells.length, MAX_LINE))));
  // Erase to the start is applied lazily, so each costs the same however long the row: blanking the
  // row cell by cell held the event loop for half a second on a 55 kB line of moves and erases, and
  // for longer on a long row erased again and again (the house's read of the 33 commits, #22, comment
  // 6307351104). Each cell carries the time it was written; `erased` holds the erases that still
  // matter, oldest first, each reaching a column short of the one before it (a newer erase reaching
  // as far hides an older one), so a cell reads blank when an erase reaching it came after its write.
  const written: number[] = [];
  const erased: Array<{ to: number; at: number }> = [];
  let clock = 0;
  const at = (k: number): string | undefined => {
    const v = cells[k];
    if (v === undefined || !erased.length) return v;
    // The newest erase that reaches k: the last of those (a prefix of `erased`) reaching it.
    let lo = 0;
    let hi = erased.length - 1;
    if (erased[0]!.to < k) return v;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (erased[mid]!.to >= k) lo = mid;
      else hi = mid - 1;
    }
    return erased[lo]!.at > (written[k] ?? 0) ? ' ' : v;
  };
  const set = (k: number, v: string) => {
    cells[k] = v;
    written[k] = ++clock;
  };
  const truncate = (n: number) => {
    cells.length = Math.min(cells.length, n);
    written.length = Math.min(written.length, n);
  };
  for (let i = 0; i < raw.length; ) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b || c === 0x9b) {
      const end = sequenceEnd(raw, i);
      if (end === undefined) break;
      const m = LINE_CONTROL.exec(raw.slice(i, end));
      if (m) {
        const n = Number(m[1]!.split(';')[0]);
        const arg = Number.isFinite(n) ? n : 0;
        if (m[2] === 'K') {
          if (arg === 0) {
            if (at(col) === '' && col > 0) set(col - 1, ' ');
            truncate(col);
          } else if (arg === 1) {
            // The cells up to the cursor, within the row; a wide character the erase ends inside goes whole, as the emulator clears both halves.
            const to = Math.min(col, cells.length - 1);
            if (to >= 0) {
              if (at(to) !== '' && at(to + 1) === '') set(to + 1, ' ');
              while (erased.length && erased[erased.length - 1]!.to <= to) erased.pop();
              erased.push({ to, at: ++clock });
            }
          } else if (arg === 2) {
            truncate(0);
            erased.length = 0;
          }
        } else if (m[2] === 'D') moveTo(col - Math.max(1, arg));
        else if (m[2] === 'C') moveTo(col + Math.max(1, arg));
        else moveTo(Math.max(1, arg) - 1);
      }
      i = end;
      continue;
    }
    if (c === 0x0d) col = 0;
    else if (c === 0x08) col = Math.max(0, col - 1);
    else if (c === 0x09) moveTo(((col >> 3) + 1) << 3);
    else if ((c >= 0x20 && c !== 0x7f) || c === 0x0a) {
      const ch = String.fromCodePoint(raw.codePointAt(i)!);
      i += ch.length;
      const w = cellWidth(ch);
      if (w === 0 && col > 0) {
        // A combining mark or a joiner composes with the character before the cursor; at column 0
        // there is none, and the emulator gives the mark a cell of its own.
        let k = Math.max(0, col - 1);
        if (at(k) === '' && k > 0) k--;
        while (cells.length < k) cells.push(' '); // after a move past the end: the cells it crossed are blanks
        set(k, (at(k) ?? ' ') + ch);
        continue;
      }
      while (cells.length < col) cells.push(' ');
      // Overwriting either half of a wide character blanks the other half.
      if (at(col) === '' && col > 0) set(col - 1, ' ');
      if (at(col + 1) === '') set(col + 1, ' ');
      set(col++, ch);
      if (w === 2) {
        if (at(col + 1) === '') set(col + 1, ' ');
        set(col++, '');
      }
      continue;
    }
    i++;
  }
  if (!erased.length) return cells.join('');
  // The row as it reads: walking right, the newest erase reaching each column moves down the stack.
  let e = erased.length - 1;
  let out = '';
  for (let k = 0; k < cells.length; k++) {
    while (e >= 0 && erased[e]!.to < k) e--;
    out += e >= 0 && erased[e]!.at > (written[k] ?? 0) ? ' ' : cells[k]!;
  }
  return out;
}

/** How long a stream must be quiet before its unterminated line (a prompt like `Password:`) is matched. */
export const PARTIAL_QUIET_MS = 500;

/**
 * Compile a caller's line pattern (watch, wait_for, `ready.pattern`, `fail.pattern`):
 * on the linear-time engine (`compileUserRegex`), and refused when it matches the
 * empty string: one that matches it anywhere (`x*`, `(error)?`) would match every
 * line, and one that matches only an empty line (`^$`, `^\s*$`) could never
 * match, since the splitter offers no empty line. Throws invalid_argument, so a
 * bad pattern fails when the watch or service is created, never later.
 */
export function compileLinePattern(pattern: string): RegExp {
  const re = compileUserRegex(pattern);
  if (re.test('')) {
    const why = re.test('x') ? 'the empty string, so it would match every line' : 'only an empty line, which is never offered for matching (empty lines are dropped)';
    throw err('invalid_argument', `pattern /${pattern}/ matches ${why}: make it require at least one character`);
  }
  return re;
}

/** One line (or frame) a LineSplitter cut, read through `cleanLine`. */
export interface SplitLine {
  text: string;
  /** The line was longer than MAX_LINE: this is its head, and the rest was dropped. */
  cut?: true;
}

export interface LineMatch {
  /** The text the pattern matched. */
  match: string;
  /** The whole line it was found in, as `cleanLine` reads it. */
  line: string;
  /** Only the line's head was searched: it is longer than the pattern's match window (`$` meant the window's end), or longer than MAX_LINE (the rest was dropped). */
  clipped?: true;
}

export interface LineSplitterOptions {
  /**
   * Offered the unterminated line (cleaned) once the stream has been quiet for
   * `partialAfterMs`; it runs from a timer, not from `feed`. Returning true spends
   * the line: it is not returned again when it completes. Without it, only
   * terminated lines come out.
   */
  onPartial?: (line: SplitLine) => boolean;
  /** Quiet period before the unterminated line is offered (ms); default PARTIAL_QUIET_MS. */
  partialAfterMs?: number;
}

/**
 * Cuts one output stream into lines for matching. LF or CRLF ends a line, as in
 * `search`; a lone CR ends a *frame*, which is offered as a line too, so a progress
 * bar's frames (`10%\r20%\r`) match as they come, where search reads only the
 * line's last state (`ABCDE\rXY` is the frames `ABCDE` and `XY` here and the line
 * `XYCDE` to search). Each line or frame is read through `cleanLine`, so backspaces,
 * erases and in-line cursor moves apply as they display and `ab\bc` is `ac` to both
 * (the house's read of 78c4d6e, #22: a watch read it as `abc`). A sequence split by
 * a write completes before the line is read. Empty lines are dropped. A line longer
 * than MAX_LINE is cut there: its head comes out marked `cut` and the rest of the
 * line is dropped, as search keeps only a line's head (the same read: a line
 * matched in pieces let `^MATCH` hit mid-line). The unterminated line (a prompt:
 * `Password: `, `>>> `) can be offered once the stream has gone quiet. One splitter
 * per stream: interleaving two streams' writes would join their partial lines.
 */
export class LineSplitter {
  /** The unterminated line, raw (its head, once `cut`). */
  private raw = '';
  /** The unterminated line passed MAX_LINE: `raw` is its head, and the rest is dropped as it comes. */
  private cut = false;
  /** The last chunk ended in CR: an LF opening the next one belongs to it. */
  private pendingCr = false;
  /** What the stream left unfinished for the line-end rule (lineEnds). */
  private readonly scan: LineCarry = lineCarry();
  /** The unterminated line was consumed as a prompt. */
  private spent = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly quietMs: number;
  private readonly onPartial: ((line: SplitLine) => boolean) | undefined;

  constructor(opts: LineSplitterOptions = {}) {
    this.quietMs = opts.partialAfterMs ?? PARTIAL_QUIET_MS;
    this.onPartial = opts.onPartial;
  }

  /** Feed a chunk; returns the lines it completed, in order. */
  feed(chunk: string): SplitLine[] {
    const out: SplitLine[] = [];
    if (!chunk) return out;
    let text = chunk;
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1);
    // Lines and frames end by the one rule (lineEnds, with CRs): a LF or CR inside a window title ends
    // neither (an independent read of the fix for the house's read of the 33 commits, #22, comment 6307350650).
    const breaks = lineEnds(text, this.scan, Number.POSITIVE_INFINITY, true);
    this.pendingCr = text.endsWith('\r') && breaks[breaks.length - 1] === text.length - 1;
    const parts: string[] = [];
    let from = 0;
    for (let k = 0; k < breaks.length; k++) {
      const b = breaks[k]!;
      parts.push(text.slice(from, b));
      // A CRLF is one break.
      if (text[b] === '\r' && text[b + 1] === '\n' && breaks[k + 1] === b + 1) k++;
      from = breaks[k]! + 1;
    }
    parts.push(text.slice(from));
    const last = parts.pop()!;
    for (const part of parts) {
      this.add(part);
      this.complete(out);
    }
    this.add(last);
    this.schedulePartial();
    return out;
  }

  /**
   * Append to the unterminated line, keeping only its first MAX_LINE. The cut lands on a safe
   * boundary: never inside a control sequence or a surrogate pair (the house's read of the 38
   * commits, #22, comment 6274773484: a head ended in a lone high surrogate).
   */
  private add(part: string): void {
    if (this.cut || !part) return;
    if (this.raw.length + part.length <= MAX_LINE) {
      this.raw += part;
      return;
    }
    const head = this.raw + part.slice(0, MAX_LINE - this.raw.length + 1);
    this.raw = head.slice(0, safeCut(head, MAX_LINE));
    this.cut = true;
  }

  /** The stream ended: the unterminated line is complete (unless it was spent as a prompt). */
  flush(): SplitLine[] {
    const out: SplitLine[] = [];
    this.complete(out);
    this.pendingCr = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return out;
  }

  /** Stop the quiet timer; nothing is offered afterwards. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private current(): SplitLine | undefined {
    const text = cleanLine(this.raw);
    if (!text) return undefined;
    return this.cut ? { text, cut: true } : { text };
  }

  private complete(out: SplitLine[]): void {
    const line = this.spent ? undefined : this.current();
    this.raw = '';
    this.cut = false;
    this.spent = false;
    if (line) out.push(line);
  }

  private schedulePartial(): void {
    if (!this.onPartial || this.quietMs <= 0) return;
    if (!this.raw || this.spent) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    // Output restarts the quiet period; refreshing the pending timer is cheaper than a new one per chunk.
    if (this.timer) {
      this.timer.refresh();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const line = this.spent ? undefined : this.current();
      if (line && this.onPartial?.(line)) this.spent = true;
    }, this.quietMs);
    // A pending prompt check never keeps the process alive; whoever waits on it has its own timer.
    this.timer.unref();
  }
}

export interface StreamMatcherOptions {
  /**
   * Receives a match found in the unterminated line once the stream has been quiet
   * for `partialAfterMs` (it arrives from a timer). Without it, only terminated
   * lines are matched.
   */
  onPartial?: (m: LineMatch) => void;
  /** Quiet period before the unterminated line is matched (ms); default PARTIAL_QUIET_MS. */
  partialAfterMs?: number;
}

/**
 * One pattern over one output stream, with the semantics `search` has: each line
 * (see LineSplitter) is tested once, so `^` and `$` mean the line's start and end
 * wherever the writes happened to split. A line yields at most one match, its
 * first, reported when the line is complete, so a split write is never reported
 * cut short and no text is matched twice. An unterminated line is matched once
 * the stream has been quiet for `partialAfterMs` when `onPartial` is given; a
 * line that matched that way is not matched again when it completes. A line is
 * matched on its head: within the pattern's match window (`execBounded`), as
 * search matches it, so a long pattern on a long line costs a bounded match on
 * the daemon's thread, and within the first MAX_LINE the splitter kept; a hit on
 * such a line says `clipped`.
 */
export class StreamMatcher {
  private readonly lines: LineSplitter;

  /** `re` comes from `compileLinePattern`. */
  constructor(
    private readonly re: RegExp,
    o: StreamMatcherOptions = {},
  ) {
    const onPartial = o.onPartial;
    const split: LineSplitterOptions = {};
    if (onPartial) {
      split.onPartial = (line) => {
        const hit = this.test(line);
        if (hit) onPartial(hit);
        return hit !== undefined;
      };
    }
    if (o.partialAfterMs !== undefined) split.partialAfterMs = o.partialAfterMs;
    this.lines = new LineSplitter(split);
  }

  /** Feed a chunk; returns the matches of the lines it completed. */
  feed(chunk: string): LineMatch[] {
    return this.collect(this.lines.feed(chunk));
  }

  /** The stream ended: match its unterminated line now. */
  flush(): LineMatch[] {
    return this.collect(this.lines.flush());
  }

  dispose(): void {
    this.lines.dispose();
  }

  private collect(lines: SplitLine[]): LineMatch[] {
    const out: LineMatch[] = [];
    for (const line of lines) {
      const hit = this.test(line);
      if (hit) out.push(hit);
    }
    return out;
  }

  private test(line: SplitLine): LineMatch | undefined {
    const r = execBounded(this.re, line.text);
    if (!r.match) return undefined;
    const hit: LineMatch = { match: r.match[0], line: line.text };
    if (r.clipped || line.cut) hit.clipped = true;
    return hit;
  }
}
