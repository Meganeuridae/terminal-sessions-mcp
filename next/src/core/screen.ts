/**
 * The screen: a headless terminal emulator holding the session's current state
 * (§6, §14). It is the sole responder to terminal queries (G25): replies the
 * emulator generates (cursor position reports, device attributes) are surfaced
 * through `onReply` so the session can write them back to the PTY.
 *
 * Feeding. PTY output is queued and handed to the emulator in batches: everything
 * queued when the emulator is free goes in one xterm write (capped at
 * MAX_BATCH), and the next batch is issued from the previous one's parse
 * callback. There is no promise or timer per chunk, so throughput is the
 * parser's, and exactly one batch is ever inside xterm. Because xterm parses a
 * single write without yielding, the emulator state seen by any other code is
 * always the state after a whole batch: `appliedSeq` (the seq passed with the
 * last parsed write) names exactly what the screen shows, and a snapshot never
 * claims output the emulator has not parsed (G13, G14). Resizes go through the
 * same queue, so output received before a resize is parsed at the old size.
 *
 * Backpressure. The backlog (queued, unparsed UTF-16 units) is reported through
 * `onPressure`: `true` when it reaches `highWater`, `false` once it drains to
 * `lowWater`. The owner is expected to pause the PTY reader meanwhile, as a real
 * terminal blocks a program that outruns it (§6, Backpressure). If the backlog
 * still grows past `maxBacklog`, the oldest queued output is compacted to the
 * sequences that change persistent terminal state (DEC private and ANSI modes,
 * keypad mode, scroll region, character sets, title, resets) and the rest is
 * discarded and counted in `droppedUnits`: the screen then shows the most recent
 * output with the right modes, and the daemon's memory stays bounded. Queries in
 * discarded output are not answered; a reply that late would only be typed into
 * whatever reads the terminal next (G25).
 */
import xterm from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { sequenceEnd, unfinishedSequence } from './text.js';
import type { ScreenSnapshot, Seq } from './types.js';

const { Terminal } = xterm;
const { SerializeAddon } = serializeAddon as unknown as {
  SerializeAddon: new () => { serialize(opts?: { scrollback?: number; excludeModes?: boolean; excludeAltBuffer?: boolean }): string; activate(t: unknown): void; dispose(): void };
};

/** Largest single xterm write, in UTF-16 units: bounds one parse slice (tens of ms at worst). */
const MAX_BATCH = 256 * 1024;

export interface ScreenOptions {
  cols: number;
  rows: number;
  scrollback?: number;
  /** Backlog (UTF-16 units) at which `onPressure(true)` fires. Default 1 MiB. */
  highWater?: number;
  /** Backlog at which `onPressure(false)` fires after pressure. Default 256 KiB. */
  lowWater?: number;
  /** Backlog beyond which queued output is compacted (see the module comment). Default 8 MiB. */
  maxBacklog?: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

type Op = { kind: 'data'; data: string; seq: Seq | undefined } | { kind: 'resize'; cols: number; rows: number };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Sequences kept when queued output is discarded: they change state that
 * outlives the bytes around them. Queries (DSR, DA) are deliberately absent.
 */
const PERSISTENT_STATE =
  /\x1bc|\x1b\[!p|\x1b\[\??[0-9;:]*[hl]|\x1b[=>]|\x1b\[[0-9;]*r|\x1b[()*+][0-9A-Za-z<>=%"&'`]|\x1b\][012];[^\x07\x1b]*(?:\x07|\x1b\\)|[\x0e\x0f]/g;

/**
 * The sequences in `data` that change lasting terminal state (see
 * PERSISTENT_STATE), reduced to the last setting of each thing set and kept in
 * their order, so the result is bounded by the number of things a terminal can
 * have set, not by the output's length, and a replay reaches the same state: a
 * mode's last set and last reset, each in its place (a sequence setting several
 * modes is split into one per mode; a program's visit to the alternate screen
 * is still a visit when replayed), the last scroll region, keypad mode and
 * designation of each character set, the last shift (SO or SI), a soft reset
 * (DECSTR) in its place among them, since it resets the shift and the
 * designations before it, the last title and the last icon name (OSC 0 sets
 * both), and a full reset (RIS), which makes everything before it moot. Also
 * used by the transcript and the reader for output they omit (the house's read
 * of ed4ecac, #22).
 */
export function persistentState(data: string): string {
  // Key → position in `kept`; a setting seen again moves to its latest place.
  const at = new Map<string, number>();
  let kept: Array<{ key: string; s: string } | undefined> = [];
  let live = 0;
  const put = (key: string, s: string) => {
    const old = at.get(key);
    if (old !== undefined) {
      kept[old] = undefined;
      live--;
    }
    at.set(key, kept.length);
    kept.push({ key, s });
    live++;
    if (kept.length > 4 * live + 64) {
      // Sparse: close the holes so the array stays proportional to the state.
      kept = kept.filter((x) => x !== undefined);
      kept.forEach((e, i) => at.set(e!.key, i));
    }
  };
  for (const m of data.matchAll(PERSISTENT_STATE)) {
    const s = m[0];
    if (s === '\x1bc') {
      at.clear();
      kept = [];
      live = 0;
      put('ris', s);
    } else if (s.startsWith('\x1b]')) {
      // OSC 0 sets the title and the icon name (one entry, `both`, which replaces either); 1 the icon
      // name; 2 the title. A `both` that a later title and a later icon name both supersede is dropped.
      const n = s[2];
      if (n === '0') {
        for (const k of ['title', 'icon']) {
          const old = at.get(k);
          if (old !== undefined) {
            kept[old] = undefined;
            live--;
            at.delete(k);
          }
        }
        put('both', s);
      } else {
        put(n === '1' ? 'icon' : 'title', s);
        const both = at.get('both');
        if (both !== undefined && at.has('title') && at.has('icon')) {
          kept[both] = undefined;
          live--;
          at.delete('both');
        }
      }
    } else if (s === '\x0e' || s === '\x0f') put('shift', s);
    else if (s === '\x1b[!p') put('decstr', s);
    else if (s === '\x1b=' || s === '\x1b>') put('keypad', s);
    else if (s[1] === '(' || s[1] === ')' || s[1] === '*' || s[1] === '+') put(`charset${s[1]}`, s);
    else if (s.endsWith('r')) put('region', s);
    else {
      // Modes: the last set and the last reset of each mode number (with its private marker).
      const priv = s[2] === '?' ? '?' : '';
      const params = s.slice(2 + priv.length, -1);
      const final = s[s.length - 1]!;
      for (const p of params.split(';')) put(`mode${priv}${p}${final}`, `\x1b[${priv}${p}${final}`);
    }
  }
  return kept.filter((x): x is { key: string; s: string } => x !== undefined).map((e) => e.s).join('');
}

/** How far a sequence left open at a compaction cut is followed into the next data for its end. */
const COMPLETION_LOOKAHEAD = 4096;

/**
 * Where the control sequence left open at the end of `before` ends inside `after`
 * (an index into `after`), or undefined when none is open or it does not end
 * within COMPLETION_LOOKAHEAD.
 */
function completionLength(before: string, after: string): number | undefined {
  const open = unfinishedSequence(before);
  if (open === before.length) return undefined;
  const e = sequenceEnd(before.slice(open) + after.slice(0, COMPLETION_LOOKAHEAD), 0);
  return e === undefined ? undefined : e - (before.length - open);
}

export class Screen {
  private term: TerminalType;
  private altState = false;
  private titleText = '';
  private replyListeners = new Set<(data: string) => void>();
  private modeListeners = new Set<(alt: boolean) => void>();
  private titleListeners = new Set<(title: string) => void>();
  private pressureListeners = new Set<(paused: boolean) => void>();
  private disposed = false;
  private readonly serializer = new SerializeAddon();

  private readonly queue: Op[] = [];
  private queuedUnits = 0;
  private inflightUnits = 0;
  /** The end of the last batch written to xterm, as far back as a sequence it left open can start. */
  private lastBatchTail = '';
  private inflight = false;
  private scheduled = false;
  /** Resolves when everything queued so far (and not yet sent) is parsed. */
  private open: Deferred | undefined;
  /** Resolves when the batch now inside xterm is parsed (and every batch before it). */
  private sent: Deferred | undefined;
  private pressured = false;
  private applied: Seq = 0;
  private dropped = 0;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly maxBacklog: number;

  /** The size most recently asked for (the PTY's size); the emulator catches up in order. */
  cols: number;
  rows: number;

  constructor(opts: ScreenOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.highWater = opts.highWater ?? 1024 * 1024;
    this.lowWater = Math.min(opts.lowWater ?? 256 * 1024, this.highWater);
    this.maxBacklog = Math.max(opts.maxBacklog ?? 8 * 1024 * 1024, 2 * MAX_BATCH);
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? 10_000,
      allowProposedApi: true,
    });
    this.term.onData((d) => {
      if (!d) return;
      for (const l of this.replyListeners) l(d);
    });
    this.term.loadAddon(this.serializer as never);
    this.term.onTitleChange((t) => {
      this.titleText = t;
      for (const l of this.titleListeners) l(t);
    });
    // Buffer switches are observed where the parser makes them, so an enter and
    // exit inside one batch are both reported, in order.
    this.term.buffer.onBufferChange((buf) => {
      const alt = buf.type === 'alternate';
      if (alt === this.altState) return;
      this.altState = alt;
      for (const l of this.modeListeners) l(alt);
    });
  }

  get alt(): boolean {
    return this.altState;
  }

  get title(): string {
    return this.titleText;
  }

  /** The seq of the last write the emulator has parsed (0 before any write that carried one). */
  get appliedSeq(): Seq {
    return this.applied;
  }

  /** Application cursor-key mode (DECCKM) as of the parsed output: arrows then send SS3 forms (keys.ts). */
  get applicationCursorKeys(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /** UTF-16 units written but not yet parsed. */
  get backlog(): number {
    return this.queuedUnits + this.inflightUnits;
  }

  /** UTF-16 units discarded because the backlog passed `maxBacklog` (see the module comment). */
  get droppedUnits(): number {
    return this.dropped;
  }

  /**
   * Feed PTY output. `seq` is the journal position this data completes; once the
   * data is parsed it becomes `appliedSeq`. The returned promise resolves once
   * the data is parsed; writes queued together share one promise.
   */
  write(data: string, seq?: Seq): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!data && seq === undefined) return this.settled();
    this.queue.push({ kind: 'data', data, seq });
    this.queuedUnits += data.length;
    this.open ??= deferred();
    const p = this.open.promise;
    if (this.backlog >= this.highWater && !this.pressured) this.setPressure(true);
    if (this.queuedUnits > this.maxBacklog) this.compact();
    this.schedule();
    return p;
  }

  /** Resolves when every write issued so far has been parsed. */
  settled(): Promise<void> {
    return this.open?.promise ?? this.sent?.promise ?? Promise.resolve();
  }

  onReply(listener: (data: string) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }

  onMode(listener: (alt: boolean) => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  onTitle(listener: (title: string) => void): () => void {
    this.titleListeners.add(listener);
    return () => this.titleListeners.delete(listener);
  }

  /** Backpressure: `true` when the backlog reaches highWater, `false` when it drains to lowWater. */
  onPressure(listener: (paused: boolean) => void): () => void {
    this.pressureListeners.add(listener);
    return () => this.pressureListeners.delete(listener);
  }

  /** Resize after everything already written has been parsed at the old size. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.disposed) return;
    if (!this.inflight && this.queue.length === 0) {
      this.term.resize(cols, rows);
      return;
    }
    this.queue.push({ kind: 'resize', cols, rows });
    this.open ??= deferred();
    this.schedule();
  }

  /**
   * The visible rows now (G14). `seq` defaults to `appliedSeq`, the position the
   * emulator has actually parsed; a caller passing its own vouches for it. After
   * backlog compaction the screen is approximate, and the snapshot says so with
   * `droppedUnits` (§6 Backpressure, G11: nothing is presented as exact that is not).
   */
  snapshot(seq: Seq = this.applied): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      lines.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
    }
    const snap: ScreenSnapshot = {
      cols: this.term.cols,
      rows: this.term.rows,
      alt: buf.type === 'alternate',
      cursor: { x: buf.cursorX, y: buf.cursorY },
      lines,
      title: this.titleText,
      seq,
    };
    if (this.dropped > 0) snap.droppedUnits = this.dropped;
    return snap;
  }

  /**
   * The emulator state as an escape-sequence stream that reproduces it in another
   * emulator of the same size: both buffers, cursor, modes, and the active
   * buffer's scroll region (the serialize addon leaves that out; the house's read
   * of ed4ecac, #22). `seq` is `appliedSeq`, so a client attaching with this
   * snapshot continues from events after `seq` (G13). Call after `settled()` to
   * include every write issued so far.
   */
  serialize(opts: { scrollback?: number } = {}): { data: string; cols: number; rows: number; alt: boolean; seq: Seq } {
    let data = this.serializer.serialize({ scrollback: opts.scrollback ?? 1000 });
    // DECSTBM homes the cursor, so it goes between a save and a restore of it (xterm internals; skipped if they change).
    const buf = (this.term as unknown as { _core?: { buffers?: { active?: { scrollTop?: unknown; scrollBottom?: unknown } } } })._core?.buffers?.active;
    if (buf && typeof buf.scrollTop === 'number' && typeof buf.scrollBottom === 'number' && (buf.scrollTop > 0 || buf.scrollBottom < this.term.rows - 1)) {
      data += `\x1b7\x1b[${buf.scrollTop + 1};${buf.scrollBottom + 1}r\x1b8`;
    }
    return { data, cols: this.term.cols, rows: this.term.rows, alt: this.altState, seq: this.applied };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.queuedUnits = 0;
    this.inflightUnits = 0;
    this.open?.resolve();
    this.sent?.resolve();
    this.term.dispose();
    this.replyListeners.clear();
    this.modeListeners.clear();
    this.titleListeners.clear();
    this.pressureListeners.clear();
  }

  // ───────────────────────────── feeding ─────────────────────────────

  private schedule(): void {
    if (this.inflight || this.scheduled || this.disposed) return;
    this.scheduled = true;
    // One turn's worth of chunks coalesces into the first batch.
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  /** Issue the next batch. Called when idle, and from the previous batch's parse callback. */
  private pump(): void {
    while (!this.disposed && !this.inflight) {
      // Resizes at the head of the queue apply now: everything before them is parsed.
      while (this.queue[0]?.kind === 'resize') {
        const op = this.queue.shift() as Extract<Op, { kind: 'resize' }>;
        this.term.resize(op.cols, op.rows);
      }
      if (this.queue.length === 0) {
        const done = this.open;
        this.open = undefined;
        done?.resolve();
        return;
      }
      const parts: string[] = [];
      let units = 0;
      let seq: Seq | undefined;
      while (this.queue[0]?.kind === 'data' && (parts.length === 0 || units + this.queue[0].data.length <= MAX_BATCH)) {
        const op = this.queue.shift() as Extract<Op, { kind: 'data' }>;
        parts.push(op.data);
        units += op.data.length;
        if (op.seq !== undefined) seq = op.seq;
      }
      this.queuedUnits -= units;
      // The open promise covers everything queued; it moves to this batch once the queue is drained.
      let batch: Deferred;
      if (this.queue.length === 0 && this.open) {
        batch = this.open;
        this.open = undefined;
      } else batch = deferred();
      if (units === 0) {
        // Only positions (writes of no data): nothing for the parser to do.
        if (seq !== undefined) this.applied = seq;
        batch.resolve();
        continue;
      }
      this.inflightUnits = units;
      this.inflight = true;
      this.sent = batch;
      const text = parts.join('');
      this.lastBatchTail = text.slice(-COMPLETION_LOOKAHEAD);
      this.term.write(text, () => {
        this.inflight = false;
        this.inflightUnits = 0;
        if (this.disposed) return;
        if (seq !== undefined) this.applied = seq;
        if (this.sent === batch) this.sent = undefined;
        batch.resolve();
        if (this.pressured && this.backlog <= this.lowWater) this.setPressure(false);
        // xterm parses a write without yielding and calls back before its next
        // write, so issuing the next batch here keeps exactly one batch inside
        // xterm and nothing observes a half-parsed batch.
        if (this.queue.length > 0) this.pump();
      });
    }
  }

  private setPressure(paused: boolean): void {
    this.pressured = paused;
    for (const l of this.pressureListeners) l(paused);
  }

  /**
   * The backlog passed maxBacklog: replace the oldest queued output (not the
   * batch inside xterm) with its persistent-state sequences until half the cap
   * remains. A queued resize stays where it is, and the output on each side of it
   * is compacted on its own, so the cap holds behind a resize too (the house's
   * read of ed4ecac, #22: the backlog had reached twelve times the cap). A
   * sequence the discarded output cuts in two is kept whole: the last batch
   * written may have ended inside one, whose end is taken from the discarded
   * output (CAN, 0x18, aborts it only when its end is not within reach), and the
   * discarded output may end inside one, whose beginning stays in the queue for
   * the output after it to finish (a mode set across the cut is still set, and a
   * long OSC goes on as the payload it is). Otherwise the first kept chunk is
   * advanced to its first newline or ESC (within 256 units) so the tail of a line
   * cut in two is not printed.
   */
  private compact(): void {
    const target = this.maxBacklog / 2;
    let i = 0;
    while (i < this.queue.length && this.queuedUnits > target) {
      if (this.queue[i]!.kind === 'resize') {
        i++;
        continue;
      }
      const start = i;
      const parts: string[] = [];
      let seq: Seq | undefined;
      let removed = 0;
      while (i < this.queue.length && this.queue[i]!.kind === 'data' && this.queuedUnits - removed > target) {
        const op = this.queue[i] as Extract<Op, { kind: 'data' }>;
        parts.push(op.data);
        removed += op.data.length;
        if (op.seq !== undefined) seq = op.seq;
        i++;
      }
      let dropped = parts.join('');
      // A sequence left open at the end of the discarded output stays, for what follows to finish.
      const open = unfinishedSequence(dropped);
      const tail = dropped.slice(open);
      dropped = dropped.slice(0, open);
      const next = this.queue[i];
      if (!tail && next?.kind === 'data') {
        const cut = next.data.slice(0, 256).search(/[\n\x1b]/);
        if (cut > 0) {
          dropped += next.data.slice(0, cut);
          removed += cut;
          next.data = next.data.slice(cut);
        }
      }
      // At the head: the last batch written may have ended inside a sequence that this output finishes.
      let head = '';
      if (start === 0) {
        const c = completionLength(this.lastBatchTail, dropped);
        if (c !== undefined) {
          head = dropped.slice(0, c);
          dropped = dropped.slice(c);
        } else head = '\x18';
      }
      const kept = head + persistentState(dropped) + tail;
      this.queue.splice(start, i - start, { kind: 'data', data: kept, seq });
      this.queuedUnits += kept.length - removed;
      this.dropped += dropped.length;
      i = start + 1;
    }
  }
}
