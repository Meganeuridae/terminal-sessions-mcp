/**
 * The journal: append-only, per-session monotonic `seq`, typed events (G10).
 * Cursors are `seq` values; reading past retention yields a visible `gap` (G11).
 *
 * Two stores (§6): a hot memory ring and, optionally, a cold file store. The
 * cold store failing (disk full, EACCES, EIO) is a daemon-level condition
 * reported by `stats()`, never an exception out of `append` — the append runs
 * inside a PTY's data callback, where a throw would take the daemon and every
 * session down (G19). The hot ring carries on, and the cold store catches up
 * from it once the disk accepts writes again.
 *
 * No seq is issued twice, across a restart or a power loss (G10), with the
 * exceptions below, both while the disk refuses writes. Appends are
 * not synced: the page cache keeps them through a daemon crash, but a power
 * loss can take the files' unsynced tail. So a seq is issued only below a
 * reservation kept beside the cold store, written and synced a block ahead
 * (one small durable write per 10,000 seqs), lowered to the last seq when the
 * journal seals, and marked `failed` while the store refuses events. The next
 * journal over the store (a new life, or the daemon after a restart) numbers
 * above it and records the seqs between the files' last and the reservation as
 * a gap: `store-failed` when the disk refused them, `torn-write` when a crash
 * on another boot may have taken them (G11). On the same boot nothing the page
 * cache held was lost, and numbering simply continues. The reservation is best
 * effort — a write to the same disk, retried at most once a second while it is
 * refused — so a journal whose reservation the disk refuses can reissue seqs
 * after a power loss. So can a daemon crash on the same boot while the disk
 * refuses the events and also the mark that would flag the reservation failed:
 * the reservation left on disk is not marked failed, a start on the same boot
 * does not honour such a one, and numbering resumes at the files' last seq.
 * What the ring drops while the disk refuses is recorded as it is lost and
 * written as a `store-error` gap at the catch-up; until then every read (a
 * range, a tail) shows that stretch where it is, as the gap the catch-up will
 * write, never joining what the disk holds to what the ring holds across it.
 * A gap says whether its count is exact (`exact`): where the journal opens, it
 * knows which seqs of a hole were issued.
 */
import { clocks, timerMs } from './clock.js';
import { boots } from './lock.js';
import { RunIndex } from './runindex.js';
import { lineBytes, MemoryStore, newEpoch, type JournalStore, type Reservation } from './stores.js';
import type { EventInput, EventOf, GapReason, Hole, JournalEvent, Seq } from './types.js';

export type JournalListener = (event: JournalEvent) => void;

type GapEvent = EventOf<'gap'>;

export interface ReadResult {
  events: JournalEvent[];
  /**
   * Present when the requested start predates retention: the range that is gone. A read that finds nothing
   * at all reports its range too, under the reason of a hole the journal knows that holds it.
   */
  gap?: Hole;
  /** Cursor to continue from: the last returned seq, or the requested start when nothing was returned. */
  nextCursor: Seq;
  /** True when more retained events exist beyond `limit`. */
  more: boolean;
}

export interface JournalOptions {
  /** Hot store; defaults to an 8 MiB memory ring. */
  hot?: JournalStore;
  /** Cold store with longer retention (the file store). Optional. */
  cold?: JournalStore;
  /** Resume `seq` numbering after this value (recovery); never below what the stores hold. */
  startSeq?: Seq;
  now?: () => number;
  /** The session this journal belongs to (stamped on the run index's RunInfo). */
  sessionId?: string;
  /** A run index to continue — a new life of a name. Otherwise one is built by streaming the stores once. */
  runs?: RunIndex;
  /** Where to say that the cold store stopped taking writes, and that writing resumed (the daemon's log). */
  log?: ((level: 'warn' | 'info', text: string) => void) | undefined;
}

/** What a journal retains and whether its disk is keeping up (G21, §6 backpressure). */
export interface JournalStats {
  hotBytes: number;
  coldBytes: number;
  /** The cold store's last write error while it is failing; null when healthy or absent. */
  coldFailed: string | null;
  /** Oldest retained seq (G21); null when nothing is retained. */
  oldestSeq: Seq | null;
  lastSeq: Seq;
  retention: { maxBytes: number | null; maxAgeMs: number | null; memoryBytes: number | null };
  /** Appends refused because the journal was closed: late events of a closed session (jr-10). */
  droppedAfterClose: number;
}

const gapEvent = (from: Seq, to: Seq, reason: GapReason, exact: boolean): EventInput => ({ type: 'gap', from, to, reason, ...(exact && { exact: true as const }) });

/** A stretch of seqs no store holds and no gap event in a store records yet: what the catch-up writes as a gap (see `lost`). */
interface LostRange {
  from: Seq;
  to: Seq;
  reason: GapReason;
  /** Every seq of it was issued (the gap's `exact`): false only for an opening hole carried here, or for ranges joined past MAX_LOST. */
  exact: boolean;
  /** When it was found lost: the time its gap bears in a read before the catch-up records it. */
  ts: number;
}

/**
 * Lost stretches kept apart at most. A new one begins only after a catch-up that wrote part of the ring and was
 * refused again (at most one a second, backing off to 30 s); past this the oldest two are joined, and the joined
 * range counts as a bound, since the disk holds the events between them.
 */
const MAX_LOST = 256;

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
/**
 * Seqs are reserved this many ahead of the last one issued: one durable write per block. Forcing every
 * append to disk instead cost about 4 ms an event on macOS and 0.4 ms on Linux; a reservation a block
 * ahead costs microseconds an event, amortized (the house's read of the 33 commits, PR #22, comment
 * 6307349700, its question of intent).
 */
export const HIGH_WATER_BLOCK = 10_000;

/**
 * Whether a journal opening over the store honours its reservation: numbers above it, and records the
 * seqs between the files' last and it as a hole. A failed reservation always (the disk refused those
 * seqs). A standing one unless it was written on this very boot: then the daemon stopped but the machine
 * did not, the page cache kept every line, and no seq above the files' last was issued. With no boot
 * known, on either side, it is honoured. The journal's constructor and the registry's expiry both read it.
 */
export function reservationHonoured(r: Reservation): boolean {
  if (r.failed === true || r.boot === undefined) return true;
  const boot = boots.current();
  return boot === undefined || boot !== r.boot;
}

export class Journal {
  private seq: Seq;
  private readonly hot: JournalStore;
  private readonly cold: JournalStore | undefined;
  private readonly now: () => number;
  /** Each listener with the last seq that existed when it subscribed: it receives only newer events (G13). */
  private readonly listeners = new Map<JournalListener, Seq>();
  private readonly pending: JournalEvent[] = [];
  private dispatching = false;
  private sealed = false;
  private coldError: string | null = null;
  /** The newest seq the cold store has accepted. */
  private persisted: Seq;
  /** When the cold store is tried again, on the monotonic clock: a wall-clock step neither delays the retry nor brings it on (the house's read of the 38 commits, #22, comment 6274935728, item 7). */
  private retryAt = 0;
  private retryMs = RETRY_MIN_MS;
  /** Retries the cold store at `retryAt` even if no event arrives meanwhile: an idle session's unwritten history must not wait for its next event (the house's read of dd8b602). */
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly log: JournalOptions['log'];
  private catchingUp = false;
  private dropped = 0;
  /** The reservation this journal has confirmed on disk (0: none yet): every seq issued is at or below it. */
  private reserved = 0;
  /** Whether the confirmed reservation says the store refused the seqs above its last. */
  private reservedFailed = false;
  /**
   * A reservation write was refused or could not be confirmed, so the file may hold something other
   * than what is confirmed (an unsynced raise): the wanted reservation is written again even where it
   * matches the confirmed one, and the store writes only if the file differs. A clear compared with the
   * confirmed mark alone left such a raise on disk, a false lost range after the next restart (the
   * house's read of the 33 commits, PR #22, comment 6307349700, item 3).
   */
  private markUnsure = false;
  /**
   * The constructor honoured a reservation left by another boot (or by none known) and has not yet appended
   * the gap that records its hole: a reservation written meanwhile carries no boot, so it is honoured on
   * this boot too. Stamped with this boot, it told a recovery on this boot, after a daemon crash before the
   * gap reached the file, that the files held every seq issued, and the seqs above them were issued again.
   */
  private holeOpen = false;
  /**
   * When a refused reservation write is tried again, on the monotonic clock: one durable write a second
   * while the disk refuses, whatever the write was for. An extension was retried on every event, 1,976
   * full write attempts in 3,000 events (comment 6307349700, item 4).
   */
  private markRetryAt = 0;
  /** A refused reservation write has been said, and its landing is said once one lands. */
  private markRefusedSaid = false;
  /**
   * Events the ring dropped that the cold store never took, recorded as they are lost (not computed
   * at the catch-up from `persisted` and the ring's oldest seq: an empty ring or a catch-up that
   * failed partway hid them — the house's read of b047b92, points 2 and 3). Written as gaps once the
   * store catches up; meanwhile every read shows each where it is (`lostGaps`). In seq order, one
   * stretch apart from the next only where a catch-up that failed partway wrote events between them:
   * kept as one, the gap claimed those events too.
   */
  private lost: LostRange[] = [];
  /**
   * Gap events the disk has not taken (the constructor's for its hole, a catch-up's refused right after): if
   * the ring drops one first, no event records its hole any more, so it joins `lost` under its own reason
   * and count.
   */
  private unwritten: GapEvent[] = [];
  /** Every Run the journal holds, reconstructed from its lifecycle events (G1, G20). */
  readonly runs: RunIndex;
  /**
   * The journal's incarnation (≥ 16 hex): kept by every life of a name and across restarts, since
   * the journal and its numbering continue; new when a forgotten name is created again and seq
   * starts over. Anything naming an event by seq outside the daemon qualifies it with this (mcpl-4).
   * It is the cold store's persisted one; a journal without one gets a random one.
   */
  readonly epoch: string;

  constructor(opts: JournalOptions = {}) {
    this.hot = opts.hot ?? new MemoryStore();
    this.cold = opts.cold;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.epoch = this.cold?.epoch?.() ?? newEpoch();
    const coldLast = this.cold?.lastSeq() ?? 0;
    const hotLast = this.hot.lastSeq() ?? 0;
    const hw = this.cold?.highWater?.();
    // What the stores account for: their events, and retention's floor (every file up to it aged out).
    const accounted = Math.max(coldLast, hotLast, hw?.floor ?? 0);
    // Seqs above that, up to a reservation, may have been issued — by an earlier life, or before a
    // restart — and reached subscribers: never reissue them, and record the hole (jr2-6, G10), when the
    // reservation is honoured (reservationHonoured).
    const r = hw?.reservation;
    const honoured = r !== undefined && reservationHonoured(r);
    // A new life of a name in this daemon knows the last seq the life before it issued (startSeq): none above
    // it was, so a reservation above it (the block a seal could not lower) adds nothing to skip. Skipped, those
    // seqs made a hole of events every one of which was issued count as a bound (the house's review of the 40
    // commits through f3750e4, PR #22, comment 6310921374, question 4).
    const known = opts.startSeq;
    this.seq = Math.max(accounted, known ?? (honoured ? r.to : 0));
    this.persisted = this.seq;
    this.runs = opts.runs ?? new RunIndex(opts.sessionId ?? '');
    if (!opts.runs) this.index();
    // Below what the stores hold now, retention has taken the files, and the gaps they recorded with them.
    this.runs.knownFrom ??= this.oldestSeq ?? accounted + 1;
    this.cold?.setRotationHeader?.((maxBytes) => this.runs.header(maxBytes));
    // Likewise a crash that cut the event after the last complete line (G11); a hole covers that event.
    const torn = this.cold?.takeTornTail?.() ?? false;
    const hole = this.cold !== undefined && this.seq > accounted;
    if (hole || torn) {
      if (!hole) this.persisted = ++this.seq;
      // The count is exact where the journal knows every seq of the hole was issued: the one event a torn line
      // held, or what the life before this one issued and the disk never took, unless a hole of its own whose
      // count is a bound lies among it. Up to a reservation it is a bound: the block may hold seqs never issued.
      const exact = !hole || (known !== undefined && this.runs.countsExactly(accounted + 1, this.seq));
      const crash = known === undefined && honoured && !r.failed && this.seq === r.to;
      this.holeOpen = hole;
      this.append(gapEvent(accounted + 1, this.seq, hole && !crash ? 'store-failed' : 'torn-write', exact));
      if (this.holeOpen) {
        this.holeOpen = false;
        // The gap is in the store now: the block above it takes this boot, so a later stop on this boot is
        // read as one that lost nothing the page cache held. With the store refusing it, the reservation
        // is the failed one keepMark wrote, which no boot affects.
        if (this.coldError === null && this.reserved > this.seq) this.writeReservation(this.reserved, false);
      }
    }
  }

  /**
   * One streaming pass over what the stores retain (jr-14): Run lifecycle events, and the gaps the
   * journal recorded, so a Run's reads know of a hole recorded after its end (see RunIndex.gapsWithin).
   */
  private index(): void {
    const scan = this.cold?.scan?.bind(this.cold);
    if (scan) {
      this.runs.scanStore({ scan }); // the one place the scan's patterns live
      return;
    }
    for (const ev of (this.cold ?? this.hot).read()) this.runs.feed(ev);
  }

  get lastSeq(): Seq {
    return this.seq;
  }

  /** Oldest seq still readable from any store (undefined when empty). */
  get oldestSeq(): Seq | undefined {
    const c = this.cold?.oldestSeq();
    const h = this.hot.oldestSeq();
    if (c === undefined) return h;
    if (h === undefined) return c;
    return Math.min(c, h);
  }

  /** True once `close()` or `seal()` ran: appends are refused, reads still work. */
  get closed(): boolean {
    return this.sealed;
  }

  append(input: EventInput): JournalEvent {
    if (this.sealed) {
      // A closed session's stragglers (a process Run's late exit, jr-10) must not
      // reach the store: a new life of the name may be numbering the same file.
      // The returned event is not part of the journal.
      this.dropped++;
      return this.stamp(input, this.seq + 1);
    }
    return this.issue(input);
  }

  /** The event `input` becomes at `seq`: the journal's decoration is its seq and its clock's time. */
  private stamp(input: EventInput, seq: Seq): JournalEvent {
    return { ...input, seq, ts: this.now() } as JournalEvent;
  }

  /** What the store would write for `input` appended now: its line's bytes, decoration included (a note's share of retention is counted so). */
  sizeOf(input: EventInput): number {
    return lineBytes(this.stamp(input, this.seq + 1));
  }

  /** Number, index, keep and deliver an event, sealed or not. */
  private issue(input: EventInput): JournalEvent {
    this.keepMark();
    const event = this.stamp(input, ++this.seq);
    this.hot.append(event);
    this.pending.push(event);
    // Persist before the run index sees the event: a run.end that makes the store rotate then
    // gets a header naming its Run, still open, in the new file (the house's read of b047b92).
    if (this.cold) this.persist(event);
    if (event.type === 'gap' && this.coldError !== null && this.persisted < event.seq) this.unwritten.push(event);
    if (this.coldError !== null) this.noteRingDrops();
    this.runs.feed(event);
    if (!this.dispatching) this.dispatch();
    return event;
  }

  /** Whatever the ring has dropped beyond `persisted` is lost for good: remember it (see `lost`). */
  private noteRingDrops(): void {
    if (this.persisted >= this.seq) return;
    const oldest = this.hot.oldestSeq();
    const droppedTo = oldest === undefined ? this.seq : oldest - 1;
    const from = Math.max(this.persisted, this.lost[this.lost.length - 1]?.to ?? 0) + 1;
    if (droppedTo < from) return;
    // A gap event among them takes its hole along; it lies below `from` (a gap is issued after its hole, and
    // the first seq the disk refused is the gap's), so `lost` stays in seq order.
    for (const g of this.unwritten.splice(0)) {
      if (g.seq > droppedTo) this.unwritten.push(g);
      else if (g.seq > this.persisted) this.lost.push({ from: g.from, to: g.to, reason: g.reason, exact: g.exact === true, ts: g.ts });
    }
    const last = this.lost[this.lost.length - 1];
    if (last && last.to === from - 1 && last.reason === 'store-error') last.to = droppedTo;
    else this.lost.push({ from, to: droppedTo, reason: 'store-error', exact: true, ts: this.now() });
    if (this.lost.length > MAX_LOST) {
      const [a, b] = this.lost.splice(0, 2) as [LostRange, LostRange];
      this.lost.unshift({ from: a.from, to: b.to, reason: 'store-error', exact: false, ts: a.ts });
    }
  }

  private persist(event: JournalEvent): void {
    if (this.coldError === null) {
      try {
        this.cold!.append(event);
        this.persisted = event.seq;
      } catch (e) {
        this.coldFailed(e);
      }
    } else if (!this.catchingUp && clocks.monotonic() >= this.retryAt) {
      this.catchUp();
    }
  }

  private coldFailed(e: unknown): void {
    const first = this.coldError === null;
    this.coldError = e instanceof Error ? e.message : String(e);
    this.retryAt = clocks.monotonic() + this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.keepMark();
    this.armRetry();
    if (first) this.log?.('warn', `history is not being written to disk: ${this.coldError}; the recent part is kept in memory and the disk is retried`);
  }

  /** Try the cold store again at its backoff deadline, whether or not an event arrives first (an idle session would otherwise wait for one). */
  private armRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.coldError !== null && !this.catchingUp && !this.sealed) this.catchUp();
    }, timerMs(this.retryAt - clocks.monotonic()));
    this.retryTimer.unref();
  }

  /**
   * Keep the reservation where the next seq needs it, before that seq is issued: above it, a block ahead
   * (exactly at it once sealed: a sealed journal issues only what its catch-up records), and marked
   * `failed` exactly while the cold store refuses events. One comparison an event while nothing is due.
   * A refused write is retried at most once a second; the event is issued meanwhile, so a power loss
   * while the disk refuses can reissue seqs (best effort, as the module says). A refusal that leaves
   * numbering exposed is said, once until a write lands: a refused failed mark (a daemon crash on this
   * boot would number from the files' last line, as the module says), or any refused write once the next
   * seq is past the reservation on disk (a power loss would number from it). Appends may be landing, and
   * nothing else would say so. The write that lands after it is said too.
   */
  private keepMark(): void {
    if (!this.cold?.setHighWater) return;
    const failed = this.coldError !== null;
    const ahead = this.reserved > this.seq;
    if (ahead && this.reservedFailed === failed && !this.markUnsure) return;
    if (clocks.monotonic() < this.markRetryAt) return;
    const to = ahead ? this.reserved : this.seq + (this.sealed ? 1 : HIGH_WATER_BLOCK);
    if (this.writeReservation(to, failed)) {
      if (this.markRefusedSaid) {
        this.markRefusedSaid = false;
        this.log?.('info', `the journal's reservation is written again (seqs up to ${to}${failed ? ', marked failed' : ''}): its numbers are no longer at risk of being given twice`);
      }
      return;
    }
    this.markRetryAt = clocks.monotonic() + 1000;
    // Any other refusal exposes nothing yet: the reservation on disk still covers the next seq, and one marked
    // failed is honoured on any boot.
    if (!this.markRefusedSaid && (failed || this.seq + 1 > this.reserved)) {
      this.markRefusedSaid = true;
      const what = failed
        ? `the journal's reservation could not be marked failed while the disk refuses its events: until a write lands, a daemon crash on this boot, or a power loss${this.reserved ? ` for seqs past ${this.reserved}` : ''},`
        : `the journal's reservation could not be written, and seq ${this.seq + 1} is past the one on disk${this.reserved ? ` (seqs up to ${this.reserved})` : ''}: until a write lands, a power loss`;
      this.log?.('warn', `${what} can make this journal give numbers its readers have already seen; it is retried at most once a second`);
    }
  }

  /**
   * The store already holds the exact reservation a seal would write: at this journal's last seq, not
   * failed, and nothing unconfirmed. Its boot does not matter then: whichever boot opens the store next,
   * honoured or not, the reservation adds no seq above the files' last, so restamping it with this boot
   * changed nothing but cost a durable write. Every journal a restart recovers seals without issuing, and
   * after a reboot each restamped its boot: 500 closed sessions started in 4.6 s instead of 0.3 s (an
   * independent read of the fix for the house's read of the 33 commits, PR #22, comment 6307349700).
   */
  private exactlyReserved(): boolean {
    if (this.coldError !== null || this.markUnsure) return false;
    const r = this.cold?.highWater?.()?.reservation;
    return r !== undefined && r.to === this.seq && r.failed !== true;
  }

  /** Write the reservation `to`, marked `failed` or with this boot, and remember it once it is confirmed. */
  private writeReservation(to: Seq, failed: boolean): boolean {
    const boot = failed || this.holeOpen ? undefined : boots.current();
    const ok = this.cold!.setHighWater!({ reservation: { to, ...(failed && { failed: true as const }), ...(boot !== undefined && { boot }) } });
    if (ok) {
      this.reserved = to;
      this.reservedFailed = failed;
    }
    this.markUnsure = !ok;
    return ok;
  }

  /**
   * Rewrite into the cold store what only the hot ring holds since the failure.
   * If the ring has already dropped part of it, that part is gone everywhere,
   * and a `gap` event says so.
   */
  private catchUp(): boolean {
    this.catchingUp = true;
    try {
      this.noteRingDrops();
      const lost = [...this.lost];
      let caught = 0;
      try {
        for (const ev of this.hot.read(this.persisted + 1)) {
          this.cold!.append(ev);
          this.persisted = ev.seq;
          caught++;
        }
      } catch (e) {
        this.coldFailed(e);
        return false;
      }
      this.coldError = null;
      this.retryMs = RETRY_MIN_MS;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      // Every gap event the disk had not taken is on disk now, or the ring dropped it and its hole is among `lost`.
      this.unwritten = [];
      const missing = lost.map((r) => `${r.from}–${r.to}`).join(', ');
      this.log?.('info', `history is being written to disk again: ${caught} events caught up${lost.length ? `; seqs ${missing} were lost from memory meanwhile (gaps record them)` : ''}`);
      // Even a sealed journal records what its ring lost, under the next seqs (the next life numbers after them).
      this.lost = [];
      for (const r of lost) this.issue(gapEvent(r.from, r.to, r.reason, r.exact));
      if (this.coldError === null && this.persisted >= this.seq) {
        this.markRetryAt = 0; // the disk takes writes again: the reservation's `failed` goes now, not at a throttle's deadline
        // A sealed journal issues nothing after this: its reservation goes back to exactly its last seq. Left a
        // seq ahead, for the next issue a sealed journal never makes, it read after the next reboot as a
        // torn-write gap for a seq never issued (an independent read of the fix for comment 6307349700).
        if (this.sealed) this.writeReservation(this.seq, false);
        else this.keepMark();
      }
      return this.coldError === null;
    } finally {
      this.catchingUp = false;
    }
  }

  /**
   * Try the failed cold store now instead of at the next backoff deadline. True when it is healthy.
   * A sealed journal may still flush its ring this way (a new life of the name tries it first).
   */
  retryCold(): boolean {
    if (!this.cold || this.coldError === null) return true;
    const ok = this.catchUp();
    if (this.sealed) {
      this.cold.close();
      if (ok && this.persisted === this.seq) this.hot.close();
    }
    return ok;
  }

  /**
   * Deliver pending events in seq order. An event appended by a listener is
   * queued and delivered after the current one has reached every listener, so
   * no listener ever sees seq n+1 before n (jr-19).
   */
  private dispatch(): void {
    this.dispatching = true;
    try {
      for (let i = 0; i < this.pending.length; i++) {
        const ev = this.pending[i]!;
        for (const [l, after] of this.listeners) {
          if (ev.seq <= after) continue;
          try {
            l(ev);
          } catch {
            // A listener's failure is never the journal's problem.
          }
        }
      }
    } finally {
      this.pending.length = 0;
      this.dispatching = false;
    }
  }

  /** Receive every event appended after this call (G13: nothing older, nothing twice). */
  subscribe(listener: JournalListener): () => void {
    this.listeners.set(listener, this.seq);
    return () => this.listeners.delete(listener);
  }

  /** Events with `seq > cursor`, oldest first, up to `limit` (G11). */
  since(cursor: Seq, limit = Number.POSITIVE_INFINITY): ReadResult {
    return this.readRange(cursor + 1, undefined, limit, cursor);
  }

  /** Events with `from <= seq <= to`. */
  range(from: Seq, to?: Seq, limit = Number.POSITIVE_INFINITY): ReadResult {
    return this.readRange(from, to, limit, from - 1);
  }

  /**
   * Every retained event after `cursor`, oldest first, in pages of at most `pageSize` (`since`
   * repeated to the end); a hole comes as its gap event, in the page where it lies (the house's read
   * of 3eade8a, #22). The one loop for the readers that go to the end; a first page that holds only
   * a gap is yielded for it.
   */
  *pages(cursor: Seq, pageSize = Number.POSITIVE_INFINITY): Generator<ReadResult, void, undefined> {
    for (;;) {
      const page = this.since(cursor, pageSize);
      if (!page.events.length && !page.gap) return;
      yield page;
      if (!page.more || !page.events.length) return;
      cursor = page.nextCursor;
    }
  }

  /**
   * The last `n` events (with `seq <= to` when given); the cold store serves
   * what the hot ring no longer (or never) had, reading its newest file backwards.
   * A stretch neither holds (`lost`) comes as its gap event where it lies, so a
   * tail never joins the two across it (the house's review of the 40 commits
   * through f3750e4, PR #22, comment 6310921374).
   */
  tail(n: number, to?: Seq): JournalEvent[] {
    if (!(n > 0)) return [];
    const hotPart = this.hot.tail ? this.hot.tail(n, to) : this.hot.read(undefined, to).slice(-n);
    if (hotPart.length >= n || !this.cold) return hotPart;
    const hotOldest = this.hot.oldestSeq();
    const before = Math.min(to ?? Number.POSITIVE_INFINITY, (hotPart[0]?.seq ?? hotOldest ?? this.seq + 1) - 1);
    const need = n - hotPart.length;
    const coldPart = this.cold.tail ? this.cold.tail(need, before) : this.cold.read(undefined, before).slice(-need);
    // Lost stretches lie below the ring's part: between it and the cold part, or among the cold part after a
    // catch-up that failed partway. One below a full cold part comes with the page before.
    const holes = this.lostGaps(coldPart.length < need ? 0 : coldPart[0]!.seq, before);
    if (!holes.length) return [...coldPart, ...hotPart];
    return [...coldPart, ...holes].sort((a, b) => a.seq - b.seq).slice(-need).concat(hotPart);
  }

  /**
   * Whether a read of `[from, to]` begins with a gap (G11) — what `range(from, to).gap`
   * says — decided from the stores' bounds and the lost stretches without reading any
   * event (jr2-9).
   */
  gapAt(from: Seq, to?: Seq): boolean {
    if (to !== undefined && to < from) return false;
    const hotOldest = this.hot.oldestSeq();
    if (hotOldest !== undefined && from >= hotOldest) return false;
    const floor = this.floor();
    if (floor === undefined) return from <= this.seq;
    if (from < floor) return true;
    // Otherwise only a read that finds nothing reports one (readRange's last rule): no lost stretch's gap is
    // seated in the range, no ring event (it ends below the ring's oldest), and no cold event (it lies above the
    // cold store's last, or wholly inside a lost stretch, which no store holds).
    const end = Math.min(to ?? this.seq, this.seq);
    if (from > end || this.lost.some((r) => r.to >= from && r.to <= end)) return false;
    return end < (hotOldest ?? Number.POSITIVE_INFINITY) && (from > (this.cold?.lastSeq() ?? 0) || this.lost.some((r) => r.from <= from && end < r.to));
  }

  /**
   * Does [from, to] touch a hole — the seqs the disk refused and the ring has since dropped, whether
   * still lost or recorded since as a gap event, wherever that event sits — anywhere in the range?
   * `gapAt` answers for the range's start; a Run's output that lost a middle stretch is `truncated` by
   * this (the house's read of b047b92), including one whose gap the catch-up recorded after the Run
   * ended, which only the range's own events said nothing of (the house's read of cc8c909..39787b3, #22).
   */
  holeWithin(from: Seq, to: Seq): boolean {
    return this.runs.gapsWithin(from, to).length > 0 || this.lost.some((r) => r.to >= from && r.from <= to);
  }

  /**
   * The gap events whose holes meet [from, to], wherever each sits: those the journal recorded (its run
   * index), and a gap for each stretch still lost, seated at its end, as a read finds it there.
   */
  gapsWithin(from: Seq, to: Seq): GapEvent[] {
    const lost = this.lost.filter((r) => r.to >= from && r.from <= to).map((r) => this.lostGap(r));
    return lost.length ? [...this.runs.gapsWithin(from, to), ...lost].sort((a, b) => a.seq - b.seq) : this.runs.gapsWithin(from, to);
  }

  /**
   * A lost stretch as the gap event the catch-up will record for it (its `lost` entry), seated at the
   * stretch's own last seq, which no event holds: what a read shows there until the disk takes writes again.
   */
  private lostGap(r: LostRange): GapEvent {
    return { type: 'gap', from: r.from, to: r.to, reason: r.reason, ...(r.exact && { exact: true as const }), seq: r.to, ts: r.ts };
  }

  /** The gaps of the lost stretches seated in [from, to], in seq order. */
  private lostGaps(from: Seq, to: Seq): GapEvent[] {
    return this.lost.filter((r) => r.to >= from && r.to <= to).map((r) => this.lostGap(r));
  }

  /** The oldest seq a read accounts for, in a store or as a lost stretch; below it retention took everything. Undefined when neither holds anything. */
  private floor(): Seq | undefined {
    const oldest = this.oldestSeq;
    const lost = this.lost[0]?.from;
    return oldest === undefined ? lost : lost === undefined ? oldest : Math.min(oldest, lost);
  }

  /**
   * The hot ring is always a suffix of the journal. The cold store serves what
   * precedes it — everything, while it is healthy. After a cold failure the two
   * may not meet: what lies between them, or between the cold store's events
   * after a catch-up that failed partway, is lost, and comes as the gap event
   * the catch-up will record for it, where it lies (G11). Joined without it, a
   * read showed the cold part and the ring's as one (the house's review of the
   * 40 commits through f3750e4, PR #22, comment 6310921374).
   */
  private readRange(from: Seq, to: Seq | undefined, limit: number, cursor: Seq): ReadResult {
    const want = limit === Number.POSITIVE_INFINITY ? limit : limit + 1;
    const hotOldest = this.hot.oldestSeq();
    const floor = this.floor();
    let events: JournalEvent[] = [];
    let gap: ReadResult['gap'];
    let more = false;
    if (to !== undefined && to < from) {
      // empty range
    } else if (hotOldest !== undefined && from >= hotOldest) {
      events = this.hot.read(from, to, want);
    } else {
      if (floor !== undefined && from < floor) gap = { from, to: floor - 1, reason: 'retention' };
      // Nothing retained at all (everything aged out): what was issued is gone, visibly (G11).
      else if (floor === undefined && from <= this.seq) gap = { from, to: Math.min(to ?? this.seq, this.seq), reason: 'retention' };
      const coldEnd = hotOldest === undefined ? to : Math.min(to ?? Number.POSITIVE_INFINITY, hotOldest - 1);
      if (this.cold && this.cold.oldestSeq() !== undefined) events = this.cold.read(from, coldEnd, want);
      const holes = this.lostGaps(from, events.length >= want ? events[events.length - 1]!.seq : (coldEnd ?? this.seq));
      if (holes.length) events = [...events, ...holes].sort((a, b) => a.seq - b.seq).slice(0, want);
      if (hotOldest !== undefined && events.length < want && (to === undefined || to >= hotOldest)) events = events.concat(this.hot.read(hotOldest, to, want - events.length));
    }
    // Seqs are dense: a non-empty range within the journal's span that holds no event at all is a
    // hole, whatever made it (the ring dropped what the disk refused), and the read says so rather
    // than returning nothing (the house's read of b047b92: `range(2, 6)` inside a hole was silent),
    // under the reason and count of a hole the journal knows that holds it.
    const end = Math.min(to ?? this.seq, this.seq);
    if (!events.length && gap === undefined && from <= end && floor !== undefined && from >= floor) {
      const known = this.gapsWithin(from, end).find((g) => g.from <= from && g.to >= end);
      gap = { from, to: end, reason: known?.reason ?? 'retention', ...(known?.exact && { exact: true as const }) };
    }
    if (events.length > limit) {
      more = true;
      events = events.slice(0, limit);
    }
    const last = events[events.length - 1];
    const result: ReadResult = { events, nextCursor: last ? last.seq : cursor, more };
    if (gap && gap.to >= gap.from) result.gap = gap;
    return result;
  }

  stats(): JournalStats {
    const cr = this.cold?.retention?.();
    const hr = this.hot.retention?.();
    const oldest = this.oldestSeq;
    return {
      hotBytes: this.hot.bytes?.() ?? 0,
      coldBytes: this.cold?.bytes?.() ?? 0,
      coldFailed: this.coldError,
      oldestSeq: oldest ?? null,
      lastSeq: this.seq,
      retention: {
        maxBytes: (this.cold ? cr?.maxBytes : hr?.maxBytes) ?? null,
        maxAgeMs: (this.cold ? cr?.maxAgeMs : hr?.maxAgeMs) ?? null,
        memoryBytes: hr?.maxBytes ?? null,
      },
      droppedAfterClose: this.dropped,
    };
  }

  /**
   * Apply age retention now (G21, jr2-7): the ring releases events past its
   * `maxAgeMs` and the file store rotates and drops aged files, with no append
   * needed. The registry's sweep calls this for every session, live or not.
   */
  expire(now?: number): void {
    this.hot.expire?.(now);
    if (this.coldError !== null) this.noteRingDrops();
    this.cold?.expire?.(now);
  }

  /**
   * Stop appending, keep reading: a closed session's journal stays history
   * (G19). The write descriptor is released, and the hot ring too when the
   * cold store holds everything it did. A failing cold store gets one last
   * catch-up, whatever the backoff says; if the disk still refuses, the ring
   * keeps the events readable here, and the high water makes the next journal
   * over this store number above them and record the hole (jr2-6, G10, G11).
   */
  seal(): void {
    if (this.sealed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.cold && this.coldError !== null) this.catchUp();
    if (this.cold?.setHighWater && !this.exactlyReserved()) {
      // Exact now: a sealed journal issues no more seqs, so the next journal over the store numbers on from
      // this one's last, and after a power loss records as lost only what the files lost. If the disk
      // refuses this too, the reservation a block ahead stands, which is safe.
      this.writeReservation(this.seq, this.coldError !== null);
    }
    this.sealed = true;
    this.listeners.clear();
    this.cold?.close();
    if (this.cold && this.coldError === null && this.persisted === this.seq) this.hot.close();
  }

  close(): void {
    this.seal();
    this.hot.close();
    this.cold?.close();
  }
}
