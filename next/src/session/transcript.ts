import xterm from '@xterm/headless';
import type { IMarker, Terminal as TerminalType } from '@xterm/headless';
import { MAX_MATCH_INPUT } from '../core/regex.js';
import type { Lines, Screen } from './types.js';

const { Terminal } = xterm;

export interface Pos {
  line: number;
  col: number;
}

interface Split {
  marker: IMarker;
  col: number;
}

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
/** Rows scrolled off the screen between two freezes, at most; each freeze takes every row above the screen. */
const FREEZE_EVERY = 100;
/** A logical line longer than this is kept as lines of this length: the most any pattern searches of one line. */
const MAX_LINE = MAX_MATCH_INPUT;
/**
 * Frozen characters kept, besides the line limit: at most 12 MiB as V8 keeps them (2 bytes a character
 * at worst), under the 13.3 MiB the emulator's own 10,000-row scrollback took at 80 columns. 80-column
 * text meets the line limit first; only long lines meet this one.
 */
const MAX_CHARS = 6 * 1024 * 1024;

const isAlt = (params: (number | number[])[]): boolean => params.some((p) => p === 1049 || p === 1047 || p === 47);

/**
 * A session's terminal output through a headless emulator. Lines that scroll off the normal screen
 * are frozen into a numbered, append-only list; the screen stays live. A line is a logical line:
 * wrapped rows are joined, and an accepted mark that falls mid-row starts a new line there. A logical
 * line longer than MAX_LINE is numbered as its pieces, live and frozen alike, so freezing never
 * renumbers a line.
 */
export class Transcript {
  private readonly term: TerminalType;
  private readonly frozen: string[] = [];
  private frozenChars = 0;
  private dropped = 0;
  private at: IMarker | undefined;
  private above: IMarker | undefined;
  private anchored = false;
  private splits: Split[] = [];
  private pending = 0;
  private paused = false;
  private scrolled = 0;
  /** The head of a logical line that goes on wrapping, taken from the emulator by a freeze before it ended. */
  private partial = '';
  private reset = false;
  private titleText = '';
  private written = 0;
  private parsed = 0;
  private isDisposed = false;
  private readonly settledWaiters: Array<{ upto: number; resolve: () => void }> = [];

  constructor(
    cols: number,
    rows: number,
    private readonly io: {
      reply: (data: string) => void;
      pressure: (paused: boolean) => void;
      redact: (text: string) => string;
      /** The longest text `redact` replaces. It replaces only whole texts, so a freeze keeps a partial line's last redactSpan - 1 characters unfrozen. */
      redactSpan: number;
      /** A mark's payload, as the parser meets it. Return true to start a new line there. */
      mark: (payload: string, at: Pos) => boolean;
    },
    private readonly maxLines = 10_000,
  ) {
    // The scrollback holds only what no freeze has taken yet: the rows scrolled since the last freeze, at
    // most FREEZE_EVERY, and the last frozen row, which anchors the first unfrozen one if its row is deleted.
    this.term = new Terminal({ cols, rows, scrollback: FREEZE_EVERY + 1, allowProposedApi: true });
    this.term.onData((d) => d && this.io.reply(d));
    this.term.onTitleChange((t) => (this.titleText = t));
    this.term.onScroll(() => {
      if (++this.scrolled >= FREEZE_EVERY) this.freezeScrolled();
    });
    const p = this.term.parser;
    p.registerOscHandler(133, (data) => {
      const at = this.pos();
      if (this.io.mark(data, at) && at.col > 0) this.split();
      return true;
    });
    p.registerCsiHandler({ final: 'J' }, (params) => {
      const mode = params[0] ?? 0;
      if (this.normal && (mode === 2 || mode === 3)) {
        this.freezeScrolled();
        if (mode === 2) {
          this.freezeRows(this.lastRow());
          this.markRow(0, false);
        }
      }
      return false;
    });
    p.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (this.normal && isAlt(params)) {
        this.freezeScrolled();
        this.markRow(this.freezeRows(this.term.buffer.normal.cursorY - 1));
      }
      return false;
    });
    p.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (!this.normal && isAlt(params)) for (const r of trimEnd(this.screen().rows)) this.push(r);
      return false;
    });
    p.registerEscHandler({ final: 'c' }, () => {
      if (this.normal) {
        this.freezeScrolled();
        this.freezeRows(this.lastRow());
      } else for (const r of trimEnd(this.screen().rows)) this.push(r);
      this.reset = true;
      return false;
    });
  }

  private get normal(): boolean {
    return this.term.buffer.active.type === 'normal';
  }

  /** The screen's height in rows. */
  get rows(): number {
    return this.term.rows;
  }

  get appCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** Feeds output; `parsed` runs once the emulator has parsed it. Ignored once disposed. */
  write(data: string, parsed: () => void): void {
    if (this.isDisposed) return;
    this.pending += data.length;
    this.written += data.length;
    if (!this.paused && this.pending >= HIGH_WATER) this.setPaused(true);
    this.term.write(data, () => {
      this.pending -= data.length;
      this.parsed += data.length;
      this.freezeScrolled();
      if (this.paused && this.pending <= LOW_WATER) this.setPaused(false);
      parsed();
      while (this.settledWaiters[0] && this.settledWaiters[0].upto <= this.parsed) this.settledWaiters.shift()!.resolve();
    });
  }

  /** What leaving the alternate screen would have pushed, for a shell that exits with it still up, so its last screen isn't lost. */
  keepScreen(): void {
    if (!this.normal) for (const r of trimEnd(this.screen().rows)) this.push(r);
  }

  /** Whether everything written so far is parsed. */
  get caughtUp(): boolean {
    return this.pending === 0;
  }

  /** Resolves once everything written so far is parsed. */
  settled(): Promise<void> {
    if (this.isDisposed || this.parsed >= this.written) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push({ upto: this.written, resolve }));
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.io.pressure(paused);
  }

  /** The cursor's position as a logical line and a column within it. Valid inside a parser handler. */
  pos(): Pos {
    if (!this.normal) return { line: this.end(), col: 0 };
    const b = this.term.buffer.normal;
    const from = this.firstLine();
    const row = b.baseY + b.cursorY;
    const w = this.walk(from, b.baseY + Math.max(this.lastRow(), b.cursorY), { row, x: b.cursorX });
    let index = w.cursor?.index ?? 0;
    let col = w.cursor?.col ?? 0;
    const head = this.head(from);
    if (head === 'joins' && index === 0) col += this.partial.length;
    else if (head === 'apart') index++;
    const lines = this.withPartial(from, w.lines);
    let line = this.dropped + this.frozen.length;
    for (let i = 0; i < index && i < lines.length; i++) line += pieceCount(lines[i]!);
    const ps = index < lines.length ? pieces(lines[index]!) : [''];
    for (let k = 0; k < ps.length - 1 && col >= ps[k]!.length; k++) {
      col -= ps[k]!.length;
      line++;
    }
    return { line, col };
  }

  /** How the partial line meets the first unfrozen row: it continues there, or it ended and stands apart. */
  private head(from: number): 'joins' | 'apart' | undefined {
    if (!this.partial) return undefined;
    return this.wraps(from) ? 'joins' : 'apart';
  }

  private withPartial(from: number, lines: string[]): string[] {
    const head = this.head(from);
    if (head === 'joins' && lines.length) lines[0] = this.partial + lines[0];
    else if (head) lines.unshift(this.partial);
    return lines;
  }

  /** One past the last line, counting the cursor's. */
  end(): number {
    return this.dropped + this.frozen.length + this.live().length;
  }

  lines(from: number, to?: number): Lines {
    const live = this.live();
    const base = this.dropped + this.frozen.length;
    const last = Math.min(to ?? base + live.length, base + live.length);
    const start = Math.max(from, this.dropped);
    const out: string[] = [];
    for (let n = start; n < last; n++) out.push(this.io.redact(n < base ? this.frozen[n - this.dropped]! : live[n - base]!));
    return { from: start, to: Math.max(start, last), lines: out, dropped: Math.max(0, Math.min(this.dropped, last) - from), live: Math.max(0, last - Math.max(start, base)) };
  }

  screen(): Screen {
    const b = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; ) {
      let end = y + 1;
      while (end < this.term.rows && b.getLine(b.baseY + end)?.isWrapped) end++;
      const whole: string[] = [];
      const shown: number[] = [];
      for (let k = y; k < end; k++) {
        const line = b.getLine(b.baseY + k);
        whole.push(line?.translateToString(false) ?? '');
        shown.push(line?.translateToString(true).length ?? 0);
      }
      const text = this.io.redact(whole.join(''));
      let at = 0;
      whole.forEach((w, k) => {
        rows.push(text.slice(at, at + shown[k]!));
        at += w.length;
      });
      y = end;
    }
    return { rows, cursor: { row: b.cursorY, col: b.cursorX }, alt: b.type === 'alternate', title: this.io.redact(this.titleText) };
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  dispose(): void {
    this.isDisposed = true;
    this.term.dispose();
    for (const w of this.settledWaiters.splice(0)) w.resolve();
  }

  /** The first unfrozen row. Its marker dies when its row is deleted or erased whole, so the row above anchors it too; with both gone, it is the screen's top. */
  private firstLine(): number {
    if (this.reset) {
      this.reset = false;
      for (const m of [this.at, this.above, ...this.splits.map((x) => x.marker)]) m?.dispose();
      this.at = this.above = undefined;
      this.splits = [];
      this.anchored = false;
      if (this.partial) this.push(this.io.redact(this.partial));
      this.partial = '';
    }
    if (this.at && !this.at.isDisposed) return this.at.line;
    if (this.above && !this.above.isDisposed) return this.above.line + 1;
    return this.anchored ? this.term.buffer.normal.baseY : 0;
  }

  /** A mark at a position that already starts a line adds nothing, so splits are bounded by the live screen's positions. */
  private split(): void {
    const b = this.term.buffer.normal;
    const line = b.baseY + b.cursorY;
    this.splits = this.splits.filter((s) => !s.marker.isDisposed);
    if (this.splits.some((s) => s.marker.line === line && s.col === b.cursorX)) return;
    const marker = this.term.registerMarker(0);
    if (marker) this.splits.push({ marker, col: b.cursorX });
  }

  private live(): string[] {
    if (!this.normal) return [];
    const b = this.term.buffer.normal;
    const from = this.firstLine();
    return this.withPartial(from, this.walk(from, b.baseY + Math.max(this.lastRow(), b.cursorY)).lines).flatMap((l) => (l.length > MAX_LINE ? pieces(this.io.redact(l)) : [l]));
  }

  private walk(from: number, to: number, cursor?: { row: number; x: number }): { lines: string[]; cursor?: { index: number; col: number } } {
    const b = this.term.buffer.normal;
    const lines: string[] = [];
    let at: { index: number; col: number } | undefined;
    const splitAt = new Map<number, number[]>();
    for (const s of this.splits) {
      const l = s.marker.line;
      if (!s.marker.isDisposed && l >= from && l <= to) (splitAt.get(l) ?? splitAt.set(l, []).get(l)!).push(s.col);
    }
    for (let i = from; i <= to; i++) {
      const row = b.getLine(i);
      if (!row) continue;
      const last = !this.wraps(i + 1);
      const starts = [0, ...(splitAt.get(i) ?? []).sort((x, y) => x - y)];
      starts.forEach((start, k) => {
        const stop = starts[k + 1];
        const piece = stop === undefined ? row.translateToString(last, start) : row.translateToString(false, start, stop);
        const continues = k === 0 && row.isWrapped && lines.length > 0;
        const before = continues ? lines[lines.length - 1]!.length : 0;
        if (continues) lines[lines.length - 1] += piece;
        else lines.push(piece);
        if (cursor && cursor.row === i && cursor.x >= start && (stop === undefined || cursor.x < stop)) at = { index: lines.length - 1, col: before + row.translateToString(false, start, cursor.x).length };
      });
    }
    return at ? { lines, cursor: at } : { lines };
  }

  private push(text: string): void {
    for (const piece of pieces(text)) {
      // V8 keeps a string built by appending, as the emulator builds a row's text, as a rope of its pieces,
      // about ten times the memory of the flat string. A string decoded from a buffer is flat.
      this.frozen.push(Buffer.from(piece, 'utf16le').toString('utf16le'));
      this.frozenChars += piece.length;
    }
    if (this.frozen.length > this.maxLines + 1000) this.drop(this.frozen.length - this.maxLines);
    if (this.frozenChars > MAX_CHARS + MAX_CHARS / 8) {
      let n = 0;
      for (let chars = this.frozenChars; chars > MAX_CHARS; n++) chars -= this.frozen[n]!.length;
      this.drop(n);
    }
  }

  private drop(n: number): void {
    for (const l of this.frozen.splice(0, n)) this.frozenChars -= l.length;
    this.dropped += n;
  }

  private freezeThrough(upto: number): number {
    const from = this.firstLine();
    if (upto < from) return from;
    const lines = this.withPartial(from, this.walk(from, upto).lines);
    this.partial = this.wraps(upto + 1) ? (lines.pop() ?? '') : '';
    for (const l of lines) this.push(this.io.redact(l));
    if (this.partial.length > MAX_LINE) {
      // A text to redact whose head ends the partial goes on in the next row, so redacting the partial
      // can't replace it. The partial keeps every piece that holds part of its last redactSpan - 1
      // characters: a text that reaches a frozen piece then lies wholly in the partial, which was
      // redacted. The kept text starts at a cut, so the live line is cut where it was.
      const ps = pieces(this.io.redact(this.partial));
      let kept = ps.pop()!;
      while (ps.length && kept.length < this.io.redactSpan - 1) kept = ps.pop()! + kept;
      this.partial = kept;
      for (const piece of ps) this.push(piece);
    }
    for (const s of this.splits) if (s.marker.line <= upto) s.marker.dispose();
    this.splits = this.splits.filter((s) => !s.marker.isDisposed);
    return upto + 1;
  }

  private freezeScrolled(): void {
    this.scrolled = 0;
    if (!this.normal) return;
    const b = this.term.buffer.normal;
    if (this.firstLine() >= b.baseY) return;
    this.markRow(this.freezeThrough(b.baseY - 1) - b.baseY);
  }

  private freezeRows(last: number): number {
    const b = this.term.buffer.normal;
    return this.freezeThrough(b.baseY + last) - b.baseY;
  }

  private markRow(row: number, onRow = true): void {
    const b = this.term.buffer.normal;
    this.at?.dispose();
    this.above?.dispose();
    this.at = onRow ? this.term.registerMarker(row - b.cursorY) : undefined;
    this.above = row - 1 >= -b.baseY ? this.term.registerMarker(row - 1 - b.cursorY) : undefined;
    this.anchored = true;
  }

  /**
   * Whether row `i` of the normal buffer goes on from the row above it. A row past the buffer's end
   * goes on from nothing: once the scrollback is full, `getLine` there returned a wrapped row.
   */
  private wraps(i: number): boolean {
    const b = this.term.buffer.normal;
    return i < b.length && Boolean(b.getLine(i)?.isWrapped);
  }

  private lastRow(): number {
    const b = this.term.buffer.normal;
    for (let y = this.term.rows - 1; y >= 0; y--) if (b.getLine(b.baseY + y)?.translateToString(true)) return y;
    return -1;
  }
}

function trimEnd(rows: string[]): string[] {
  let n = rows.length;
  while (n > 0 && !rows[n - 1]) n--;
  return rows.slice(0, n);
}

/**
 * `text` cut into lines of at most MAX_LINE, never between the two halves of a surrogate pair. A cut
 * looks only at the character before it, so a line that grows is cut where it was, and redaction,
 * which keeps length and writes no surrogates, moves no cut.
 */
function pieces(text: string): string[] {
  if (text.length <= MAX_LINE) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + MAX_LINE);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const pieceCount = (text: string): number => (text.length <= MAX_LINE ? 1 : pieces(text).length);
