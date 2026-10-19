/**
 * A native subscriber's delivery from one journal (G11, G13): every retained
 * event after a cursor, oldest first, in pages with no cap on the total, then
 * live events — never a duplicate, never a silent hole.
 *
 * Backpressure (§6): the PTY is never paused for a slow subscriber. Past a
 * high-water mark of bytes queued on the socket the follower stops sending and
 * keeps only its cursor; the journal is the buffer. Once the socket drains below
 * the low-water mark it resumes from the journal by cursor, and when retention
 * has moved past the cursor meanwhile, the first thing it sends is a gap naming
 * the range that is gone. Daemon memory held for a stalled subscriber is bounded
 * by the high-water mark plus one event.
 */
import type { Journal } from '../core/journal.js';
import type { JournalEvent, Seq } from '../core/types.js';

/** The part of a journal a follower reads. */
export type JournalSource = Pick<Journal, 'since' | 'subscribe' | 'lastSeq'>;

export interface FollowerGap {
  from: Seq;
  to: Seq;
  reason: string;
}

/** Where a follower writes, and how it sees the socket's queue. */
export interface FollowerSink {
  event(ev: JournalEvent): void;
  gap(g: FollowerGap): void;
  /** Bytes queued on the socket and not yet handed to the kernel (ws `bufferedAmount`). */
  buffered(): number;
  /** False once the socket is closing; the follower then stops for good. */
  open(): boolean;
}

/** Events read from the journal per page while catching up. */
const PAGE_SIZE = 2000;

export interface FollowerOptions {
  /** Stop sending when this many bytes are queued (default 1 MiB); resume at a quarter of it. */
  highWaterBytes?: number | undefined;
  /** How often a paused follower looks at the socket's queue (default 25 ms). */
  pollMs?: number;
  /** Called when reading the journal failed; the follower has closed itself (the stream ended, it was not skipped). */
  onError?: (e: unknown) => void;
}

export type FollowerState = 'idle' | 'live' | 'paused' | 'closed';

export class Follower {
  private stateValue: FollowerState = 'idle';
  private off: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private cursorValue: Seq;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly pollMs: number;
  private readonly onError: ((e: unknown) => void) | undefined;
  /** The first gap this follower reported, for the subscribe response. */
  firstGap: FollowerGap | undefined;

  constructor(
    /** The journal this follower reads. */
    readonly source: JournalSource,
    cursor: Seq,
    private readonly sink: FollowerSink,
    opts: FollowerOptions = {},
  ) {
    this.cursorValue = Math.max(0, Math.min(cursor, source.lastSeq));
    this.highWater = opts.highWaterBytes ?? 1024 * 1024;
    this.lowWater = Math.floor(this.highWater / 4);
    this.pollMs = opts.pollMs ?? 25;
    this.onError = opts.onError;
  }

  /** The last seq delivered (or skipped past by a reported gap). */
  get cursor(): Seq {
    return this.cursorValue;
  }

  get state(): FollowerState {
    return this.stateValue;
  }

  /**
   * Subscribe and catch up in the same tick, so no append can fall between the
   * replay and the live listener. Afterwards the follower is live, or paused
   * because the socket is full. A closed follower stays closed. When reading the
   * journal fails, the follower closes itself and the error is thrown to the
   * caller (later failures, while resuming, go to `onError`).
   */
  start(): void {
    if (this.stateValue !== 'idle') return;
    this.off = this.source.subscribe((ev) => this.onLive(ev));
    try {
      this.pump();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  close(): void {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'closed';
    this.off?.();
    this.off = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private onLive(ev: JournalEvent): void {
    // Paused or catching up: the journal keeps the event; delivery resumes by cursor.
    if (this.stateValue !== 'live') return;
    if (ev.seq <= this.cursorValue) return;
    if (ev.seq !== this.cursorValue + 1) {
      // Never expected (appends are sequential); read the hole from the journal rather than skip it.
      this.guarded(() => this.pump());
      return;
    }
    if (!this.sink.open()) return this.close();
    if (this.sink.buffered() >= this.highWater) return this.pause();
    this.sink.event(ev);
    this.cursorValue = ev.seq;
  }

  /** Read and send by cursor until caught up (→ live) or the socket is full (→ paused). Synchronous. */
  private pump(): void {
    for (;;) {
      if (this.stateValue === 'closed') return;
      if (!this.sink.open()) return this.close();
      if (this.sink.buffered() >= this.highWater) return this.pause();
      const before = this.cursorValue;
      const r = this.source.since(this.cursorValue, PAGE_SIZE);
      if (r.gap) {
        // G11: truncation is visible. The cursor moves past what is gone.
        const g: FollowerGap = { from: r.gap.from, to: r.gap.to, reason: r.gap.reason };
        this.firstGap ??= g;
        this.sink.gap(g);
        this.cursorValue = Math.max(this.cursorValue, g.to);
      }
      for (const ev of r.events) {
        if (ev.seq <= this.cursorValue) continue;
        this.sink.event(ev);
        this.cursorValue = ev.seq;
        if (this.sink.buffered() >= this.highWater) return this.pause();
      }
      if (!r.more) {
        this.stateValue = 'live';
        return;
      }
      // A page that says `more` but moved nothing would spin here forever, holding the event loop.
      if (this.cursorValue === before) throw new Error(`journal returned no events after seq ${before} but reported more`);
    }
  }

  /** Run a resume step; a failure ends the stream visibly (onError), never silently or by throwing into a journal listener. */
  private guarded(step: () => void): void {
    try {
      step();
    } catch (e) {
      this.close();
      this.onError?.(e);
    }
  }

  private pause(): void {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'paused';
    if (this.timer) return;
    const poll = (): void => {
      this.timer = undefined;
      if (this.stateValue !== 'paused') return;
      if (!this.sink.open()) return this.close();
      if (this.sink.buffered() > this.lowWater) {
        this.timer = setTimeout(poll, this.pollMs);
        this.timer.unref?.();
        return;
      }
      this.guarded(() => this.pump());
    };
    this.timer = setTimeout(poll, this.pollMs);
    this.timer.unref?.();
  }
}
