import xterm from '@xterm/headless';
import type { IMarker, Terminal as TerminalType } from '@xterm/headless';
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
const FREEZE_EVERY = 1000;

const isAlt = (params: (number | number[])[]): boolean => params.some((p) => p === 1049 || p === 1047 || p === 47);

/**
 * A session's terminal output through a headless emulator. Lines that scroll off the normal screen
 * are frozen into a numbered, append-only list; the screen stays live. A line is a logical line:
 * wrapped rows are joined, and an accepted mark that falls mid-row starts a new line there.
 */
export class Transcript {
  private readonly term: TerminalType;
  private readonly frozen: string[] = [];
  private dropped = 0;
  private at: IMarker | undefined;
  private above: IMarker | undefined;
  private anchored = false;
  private splits: Split[] = [];
  private pending = 0;
  private paused = false;
  private linefeeds = 0;
  private reset = false;
  private titleText = '';
  private written = 0;
  private parsed = 0;
  private readonly settledWaiters: Array<{ upto: number; resolve: () => void }> = [];

  constructor(
    cols: number,
    rows: number,
    private readonly io: {
      reply: (data: string) => void;
      pressure: (paused: boolean) => void;
      redact: (text: string) => string;
      /** A mark's payload, as the parser meets it. Return true to start a new line there. */
      mark: (payload: string, at: Pos) => boolean;
    },
    private readonly maxLines = 10_000,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
    this.term.onData((d) => d && this.io.reply(d));
    this.term.onTitleChange((t) => (this.titleText = t));
    this.term.onLineFeed(() => {
      if (++this.linefeeds >= FREEZE_EVERY) this.freezeScrolled();
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

  get appCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /** Feeds output; `parsed` runs once the emulator has parsed it. */
  write(data: string, parsed: () => void): void {
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

  /** Resolves once everything written so far is parsed. */
  settled(): Promise<void> {
    if (this.parsed >= this.written) return Promise.resolve();
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
    const w = this.walk(this.firstLine(), b.baseY + b.cursorY, { row: b.baseY + b.cursorY, x: b.cursorX });
    return { line: this.dropped + this.frozen.length + (w.cursor?.index ?? 0), col: w.cursor?.col ?? 0 };
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
    for (let y = 0; y < this.term.rows; y++) rows.push(this.io.redact(b.getLine(b.baseY + y)?.translateToString(true) ?? ''));
    return { rows, cursor: { row: b.cursorY, col: b.cursorX }, alt: b.type === 'alternate', title: this.titleText };
  }

  dispose(): void {
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
    }
    if (this.at && !this.at.isDisposed) return this.at.line;
    if (this.above && !this.above.isDisposed) return this.above.line + 1;
    return this.anchored ? this.term.buffer.normal.baseY : 0;
  }

  private splitsAt(line: number): Split[] {
    return this.splits.filter((s) => !s.marker.isDisposed && s.marker.line === line).sort((a, b) => a.col - b.col);
  }

  private split(): void {
    const b = this.term.buffer.normal;
    const marker = this.term.registerMarker(0);
    if (marker) this.splits.push({ marker, col: b.cursorX });
  }

  private live(): string[] {
    if (!this.normal) return [];
    const b = this.term.buffer.normal;
    return this.walk(this.firstLine(), b.baseY + Math.max(this.lastRow(), b.cursorY)).lines;
  }

  private walk(from: number, to: number, cursor?: { row: number; x: number }): { lines: string[]; cursor?: { index: number; col: number } } {
    const b = this.term.buffer.normal;
    const lines: string[] = [];
    let at: { index: number; col: number } | undefined;
    for (let i = from; i <= to; i++) {
      const row = b.getLine(i);
      if (!row) continue;
      const text = row.translateToString(!b.getLine(i + 1)?.isWrapped);
      const starts = [0, ...this.splitsAt(i).map((s) => s.col)];
      starts.forEach((start, k) => {
        const piece = text.slice(start, starts[k + 1] ?? text.length);
        const continues = k === 0 && row.isWrapped && lines.length > 0;
        const before = continues ? lines[lines.length - 1]!.length : 0;
        if (continues) lines[lines.length - 1] += piece;
        else lines.push(piece);
        if (cursor && cursor.row === i && cursor.x >= start && (k + 1 >= starts.length || cursor.x < starts[k + 1]!)) at = { index: lines.length - 1, col: before + cursor.x - start };
      });
    }
    return at ? { lines, cursor: at } : { lines };
  }

  private push(text: string): void {
    this.frozen.push(text);
    if (this.frozen.length > this.maxLines + 1000) {
      const n = this.frozen.length - this.maxLines;
      this.frozen.splice(0, n);
      this.dropped += n;
    }
  }

  private freezeThrough(upto: number): number {
    const b = this.term.buffer.normal;
    const from = this.firstLine();
    while (upto >= from && b.getLine(upto + 1)?.isWrapped) upto--;
    if (upto < from) return from;
    for (const l of this.walk(from, upto).lines) this.push(this.io.redact(l));
    for (const s of this.splits) if (s.marker.line <= upto) s.marker.dispose();
    this.splits = this.splits.filter((s) => !s.marker.isDisposed);
    return upto + 1;
  }

  private freezeScrolled(): void {
    this.linefeeds = 0;
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
