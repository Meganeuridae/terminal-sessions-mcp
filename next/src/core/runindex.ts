/**
 * Runs reconstructed from the journal (G1, G20): `run.admit`, `run.start` and
 * `run.end` are enough to say what every Run was, how it ended, and which range
 * of the journal holds its output. A live Session keeps richer records of its
 * own Runs; this index is what answers for everything else — a history-only
 * session, a closed one, and the previous lives of a reused name, whose runIds
 * stay valid because the journal is continuous.
 */
import { err } from './errors.js';
import type { Journal } from './journal.js';
import type { EventOf, JournalEvent, RunInfo, Seq } from './types.js';

type OutputEvent = EventOf<'output'>;

/**
 * Written at the head of each file the file store rotates into: the Runs still
 * open at that point. When the file holding a Run's admission is pruned, the
 * header of the oldest retained file still names it, so recovery can end it
 * `lost` instead of leaving it unresolved (G20).
 */
export interface RotationHeader {
  v: 1;
  openRuns: RunInfo[];
}

/** A command line longer than this is shortened in a rotation header (the Run itself keeps its line). */
const HEADER_LINE_MAX = 512;

const shorten = (s: string) => (s.length > HEADER_LINE_MAX ? `${s.slice(0, HEADER_LINE_MAX)}…` : s);

/**
 * A header within `maxBytes` of JSON (jr2-8): long command lines and argv are
 * shortened first, then the oldest open Runs are left out. A Run left out is
 * still reconstructed (as partial) from any later `run.start` or `run.end`
 * that remains; one with neither is forgotten once its admission is pruned.
 */
export function boundHeader(h: RotationHeader, maxBytes = Number.POSITIVE_INFINITY): RotationHeader {
  const size = (r: RunInfo) => Buffer.byteLength(JSON.stringify(r)) + 1;
  const base = Buffer.byteLength(JSON.stringify({ header: { v: 1, openRuns: [] } })) + 1;
  let runs = h.openRuns;
  let total = base + runs.reduce((a, r) => a + size(r), 0);
  if (total <= maxBytes) return h;
  runs = runs.map((r) => {
    const c: RunInfo = { ...r, seq: { ...r.seq } };
    if (c.line !== undefined) c.line = shorten(c.line);
    if (c.argv) {
      let left = HEADER_LINE_MAX;
      const argv: string[] = [];
      for (const a of c.argv) {
        if (left <= 0) break;
        argv.push(a.length > left ? `${a.slice(0, left)}…` : a);
        left -= a.length;
      }
      c.argv = argv;
    }
    return c;
  });
  const sizes = runs.map(size);
  total = base + sizes.reduce((a, b) => a + b, 0);
  let k = 0;
  while (k < runs.length && total > maxBytes) total -= sizes[k++]!;
  return { v: 1, openRuns: runs.slice(k) };
}

type GapEvent = EventOf<'gap'>;

/** A Run's attributed output, the same shape as `Session.runOutput` (G12), holes included: `gaps` is part of what the reader relies on. */
export interface RunOutput {
  events: JournalEvent[];
  from: Seq;
  to: Seq;
  truncated: boolean;
  /** With `limit`: output events of the range remain after the last one returned. */
  more?: boolean;
  /**
   * The journal's gap events within the part of the range this result covers (before the first
   * output dropped by `limit`, after the first one kept by `maxBytes`), when there are any: a
   * reader shows a Run's holes where they are, however many other events lie between its outputs
   * (the house's read of 1cabc6a, #22).
   */
  gaps?: GapEvent[];
}

/** Which part of a Run's output to return. Readers page with these instead of loading the whole Run. */
export interface RunOutputRange {
  /** Only events after this seq. */
  since?: Seq;
  /** Only events up to this seq. */
  until?: Seq;
  /** At most this many output events, from the start of the range; `more` says whether others remain. */
  limit?: number;
  /** Only the newest part: output events ending at the range's end, at most this many bytes (at least one event). */
  maxBytes?: number;
}

/** Apply a range to a Run's whole output (the reference semantics; stores may do it without loading everything). */
export function narrowOutput(o: RunOutput, range: RunOutputRange): RunOutput {
  if (range.since === undefined && range.until === undefined && range.limit === undefined && range.maxBytes === undefined) return o;
  const within = (e: JournalEvent) => (range.since === undefined || e.seq > range.since) && (range.until === undefined || e.seq <= range.until);
  let events = o.events.filter(within);
  let gaps = o.gaps?.filter(within);
  let more = false;
  if (range.limit !== undefined && events.length > range.limit) {
    // The holes kept are those before the first output dropped.
    const cutAt = events[Math.max(0, range.limit)]!.seq;
    gaps = gaps?.filter((g) => g.seq < cutAt);
    events = events.slice(0, Math.max(0, range.limit));
    more = true;
  }
  let truncated = o.truncated;
  if (range.maxBytes !== undefined) {
    let bytes = 0;
    let k = events.length;
    while (k > 0) {
      const b = Buffer.byteLength((events[k - 1] as OutputEvent).data, 'utf8'); // caps are UTF-8 bytes (text.ts)
      if (k < events.length && bytes + b > range.maxBytes) break;
      bytes += b;
      k--;
    }
    if (k > 0) {
      const dropped = events[k - 1]!.seq;
      gaps = gaps?.filter((g) => g.seq > dropped);
      events = events.slice(k);
      truncated = true;
    }
  }
  const out: RunOutput = { events, from: o.from, to: range.until !== undefined ? Math.min(o.to, range.until) : o.to, truncated };
  if (range.limit !== undefined) out.more = more;
  if (gaps?.length) out.gaps = gaps;
  return out;
}

/**
 * A Run's attributed output (G12) in the journal range [from, to], narrowed by `range`: equal to
 * `narrowOutput` over the whole range, but reading only what the range asks for (jr2-9, er-11).
 * `since`/`until` bound the journal range; `maxBytes` alone walks it backwards in tail pages
 * until one event more than fits; otherwise it is read forward until one output event more than
 * `limit` (a hole in the journal is read past). `truncated` when retention cut the Run's range (G11).
 */
export function pageOutput(journal: Journal, runId: string, from: Seq, to: Seq, range: RunOutputRange = {}): RunOutput {
  const lo = range.since !== undefined ? Math.max(from, range.since + 1) : from;
  const hi = range.until !== undefined ? Math.min(to, range.until) : to;
  const mine = (e: JournalEvent): e is OutputEvent => e.type === 'output' && e.runId === runId;
  const events: OutputEvent[] = [];
  // A gap recorded inside the Run's range (the ring dropped what the disk refused) cuts its output
  // as retention does: `truncated` says so (the house's read of b047b92), and the gap events passed
  // on the way go with the result, so a reader can place them.
  let holed = journal.holeWithin(lo, hi);
  const gaps: GapEvent[] = [];
  const seeGap = (e: JournalEvent): void => {
    if (e.type !== 'gap') return;
    gaps.push(e);
    if (e.to >= lo && e.from <= hi) holed = true;
  };
  if (range.maxBytes !== undefined && range.limit === undefined) {
    let bytes = 0;
    walk: for (let cursor = hi; cursor >= lo; ) {
      const page = journal.tail(OUTPUT_PAGE, cursor);
      for (let i = page.length - 1; i >= 0; i--) {
        const e = page[i]!;
        if (e.seq < lo) break walk;
        seeGap(e);
        if (!mine(e)) continue;
        events.push(e);
        bytes += Buffer.byteLength(e.data, 'utf8');
        if (events.length > 1 && bytes > range.maxBytes) break walk;
      }
      if (!page.length) break;
      cursor = page[0]!.seq - 1;
    }
    events.reverse();
  } else {
    const want = range.limit !== undefined ? Math.max(0, range.limit) + 1 : Number.POSITIVE_INFINITY;
    for (let cursor = lo; cursor <= hi && events.length < want; ) {
      const res = journal.range(cursor, hi, want === Number.POSITIVE_INFINITY ? want : OUTPUT_PAGE);
      for (const e of res.events) {
        seeGap(e);
        if (mine(e) && events.length < want) events.push(e);
      }
      const last = res.events[res.events.length - 1];
      if (!res.more || !last) break;
      cursor = last.seq + 1;
    }
  }
  const whole: RunOutput = { events, from, to: hi, truncated: journal.gapAt(from, to) || holed };
  if (gaps.length) whole.gaps = gaps.sort((a, b) => a.seq - b.seq);
  return narrowOutput(whole, range);
}

const terminal = (s: RunInfo['state']) => s === 'exited' || s === 'cancelled' || s === 'lost';
/** Events per page when a Run's output is read in pieces. */
const OUTPUT_PAGE = 512;
const copy = (r: RunInfo): RunInfo => ({ ...r, seq: { ...r.seq } });
/**
 * Runs remembered at most, a bound on the index's memory (10,000 Runs cost about 450 MiB
 * unbounded, core 3 of the house's review of #11); beyond it the oldest ended Runs are
 * forgotten. Their output is not: retention is opt-in and unlimited by default (G21), so a
 * Run the index forgot is no longer reachable by its id, while its output stays readable by
 * cursor (`read since`) and in channel history. G30 states the bound (the house's read of
 * 07ab3dd, #22: this comment gave retention as the reason).
 */
const MAX_RUNS = 100_000;

export class RunIndex {
  private readonly runs = new Map<string, RunInfo>();
  private readonly openIds = new Set<string>();

  /** `sessionId` is stamped on every RunInfo. */
  constructor(readonly sessionId: string) {}

  /** Apply one journal event; anything but run lifecycle events is ignored. */
  feed(ev: JournalEvent): void {
    switch (ev.type) {
      case 'run.admit': {
        if (this.runs.has(ev.runId)) return; // already known from a rotation header
        const r: RunInfo = {
          runId: ev.runId,
          sessionId: this.sessionId,
          target: ev.target,
          origin: ev.origin ?? (ev.principal === 'system' ? 'system' : 'self'),
          principal: ev.principal,
          // A queued Run waits for availability; any other is being written or spawned.
          state: ev.queued ? 'queued' : 'starting',
          admittedAt: ev.ts,
          seq: { admit: ev.seq },
          attribution: ev.target === 'process' ? 'exact' : 'temporal',
        };
        if (ev.line !== undefined) r.line = ev.line;
        if (ev.argv) r.argv = ev.argv;
        if (ev.idem !== undefined) r.idem = ev.idem;
        if (ev.shell !== undefined) r.shell = ev.shell;
        if (ev.within !== undefined) r.within = ev.within;
        this.add(r);
        return;
      }
      case 'run.start': {
        // Admission rotated out of retention and no header named it: what run.start says is all there is.
        const r = this.runs.get(ev.runId) ?? this.add(this.partial(ev.runId, ev.envBasis !== undefined ? 'process' : 'shell', ev.seq, ev.ts));
        if (!terminal(r.state)) r.state = 'running';
        r.startedAt = ev.ts;
        r.seq.start = ev.seq;
        r.cwd = ev.cwd;
        if (ev.line !== undefined && r.line === undefined) r.line = ev.line;
        if (ev.envBasis) r.envBasis = ev.envBasis;
        // The width its transcript projects at (§6), and the process group recovery may have to end (jr2-4).
        if (ev.cols !== undefined) r.cols = ev.cols;
        if (ev.rows !== undefined) r.rows = ev.rows;
        if (ev.pid !== undefined) r.pid = ev.pid;
        if (ev.pgid !== undefined) r.pgid = ev.pgid;
        return;
      }
      case 'run.end': {
        const r = this.runs.get(ev.runId) ?? this.add(this.partial(ev.runId, 'shell', ev.seq, ev.ts - ev.durationMs));
        r.state = ev.state;
        r.endedAt = ev.ts;
        r.seq.end = ev.seq;
        if (ev.exit !== undefined) r.exit = ev.exit;
        if (ev.signal) r.signal = ev.signal;
        if (ev.reason) r.reason = ev.reason;
        if (ev.leftovers) r.leftovers = true;
        if (ev.pipeStatus) r.pipeStatus = [...ev.pipeStatus];
        this.openIds.delete(ev.runId);
        return;
      }
      default:
        return;
    }
  }

  /** Take the Runs a rotation header names that this index has not seen admitted. */
  absorbHeader(h: RotationHeader): void {
    if (!h || !Array.isArray(h.openRuns)) return;
    for (const r of h.openRuns) {
      if (!r || typeof r.runId !== 'string' || this.runs.has(r.runId)) continue;
      this.add({ ...copy(r), sessionId: this.sessionId });
    }
  }

  /** The Run, or undefined. */
  get(runId: string): RunInfo | undefined {
    const r = this.runs.get(runId);
    return r ? copy(r) : undefined;
  }

  /** The Run; `run_not_found` when the journal never held it (or it aged out of the index). */
  run(runId: string): RunInfo {
    const r = this.runs.get(runId);
    if (!r) throw err('run_not_found', `run ${runId} not found`, { runId });
    return copy(r);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Every known Run, in admission order. */
  list(): RunInfo[] {
    return [...this.runs.values()].map(copy);
  }

  /** Runs not yet terminal: queued, starting or running. */
  open(): RunInfo[] {
    const out: RunInfo[] = [];
    for (const id of this.openIds) {
      const r = this.runs.get(id);
      if (r) out.push(copy(r));
    }
    return out;
  }

  /** What the file store writes at the head of a new file (see RotationHeader), within `maxBytes` when given. */
  header(maxBytes?: number): RotationHeader {
    return boundHeader({ v: 1, openRuns: this.open() }, maxBytes);
  }

  /** The Run's attributed output from `journal`: its range is from its start (or admission) to its end (or the journal's last seq). */
  output(journal: Journal, runId: string, range: RunOutputRange = {}): RunOutput {
    const r = this.run(runId);
    return pageOutput(journal, runId, r.seq.start ?? r.seq.admit, r.seq.end ?? journal.lastSeq, range);
  }

  private partial(runId: string, target: RunInfo['target'], seq: Seq, ts: number): RunInfo {
    // Who admitted it is unknown: its admission is no longer retained.
    return {
      runId,
      sessionId: this.sessionId,
      target,
      origin: 'system',
      principal: 'unknown',
      state: 'running',
      admittedAt: ts,
      seq: { admit: seq },
      attribution: target === 'process' ? 'exact' : 'temporal',
    };
  }

  private add(r: RunInfo): RunInfo {
    this.runs.set(r.runId, r);
    if (!terminal(r.state)) this.openIds.add(r.runId);
    if (this.runs.size > MAX_RUNS) {
      for (const [id, old] of this.runs) {
        if (this.runs.size <= MAX_RUNS) break;
        if (terminal(old.state)) this.runs.delete(id);
      }
    }
    return r;
  }
}
