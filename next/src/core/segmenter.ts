/**
 * The Segmenter (§10.2): turns one session's journal into messages for hosts.
 * One per session, shared by every connection; each connection's lane decides
 * per principal what to deliver (suppression G28, explicit interest, open or
 * closed channel) and personalizes the few fields that depend on the reader.
 *
 * Every segment's text opens with one self-describing line — session, what
 * happened, and the cursor that fetches more — because in some hosts the text is
 * all a model sees and a held rendering keeps only its first few hundred
 * characters (§10.6). Ambient segments (digests, screens, control, notes, human
 * input) reach open channels only; digests and screens carry `supersedes`,
 * never deltas: at most one per cadence per subject.
 *
 * Lifecycle segments are rebuilt from the journal alone for catch-up and channel
 * history (`scanLifecycle`, `replayNewest`), for any life of a name and for a
 * history-only session, so a completion is never lost because nobody was
 * following the session when it happened (G22, G28).
 */
import { stripAnsi } from './ansi.js';
import type { Journal } from './journal.js';
import type { RunOutput } from './runindex.js';
import { looksLikeSecretPrompt } from './session.js';
import { project } from './transcript.js';
import type { JournalEvent, OutputStream, Principal, RunInfo, ScreenSnapshot, Seq } from './types.js';

export type SegmentKind =
  | 'run'
  | 'service'
  | 'output'
  | 'screen'
  | 'needs-input'
  | 'watch'
  | 'control'
  | 'session-exit'
  | 'human-input'
  | 'recovered'
  | 'note'
  /** The lane's one-line account of lifecycle messages a catch-up did not replay (ux-25). */
  | 'summary';

export interface Segment {
  kind: SegmentKind;
  /** Lifecycle segments reach interested principals as push events when the channel is closed; ambient ones only open channels. */
  lifecycle: boolean;
  /** The journal event this segment reports (the delivered cursor advances to it). */
  seq: Seq;
  /** When it happened (the journal event's time). */
  ts: number;
  /** `<session>~<epoch>:<kind>:<seq>`; the lane qualifies it with the node (§10.2). */
  messageId: string;
  supersedes?: string;
  tags: string[];
  /** The first line, without the per-reader suffix. */
  head: string;
  body?: string;
  metadata: Record<string, unknown>;
  /** Principals with explicit interest (G28); the session owner always has it. */
  interested: Principal[];
  /** For run segments: withheld from a principal whose synchronous call returned the outcome (G28). */
  runId?: string;
  author?: Principal;
}

/** What the segmenter needs from its session. */
export interface SegmentSource {
  readonly id: string;
  readonly owner: Principal;
  readonly journal: Journal;
  readonly state: string;
  readonly cwd: string;
  readonly currentController: Principal | null;
  run(runId: string): RunInfo;
  listRuns(): RunInfo[];
  runTranscript(runId: string): Promise<RunText>;
  snapshot(): ScreenSnapshot;
}

export interface SegmenterOptions {
  /** Ambient digest cadence per subject (ms); also the most often a full-screen program's screen is sent. */
  cadenceMs?: number;
  /** Settle after a Run's end before its message is built (lets the prompt land). */
  runSettleMs?: number;
  /** Quiet period before a full-screen program's screen is sent. */
  screenQuietMs?: number;
  /** A screen that keeps changing is sent at most this long after its first unsent change (never starved, m2-13). */
  screenMaxWaitMs?: number;
  /** Silence before needs-input is considered (G15). */
  needsInputMs?: number;
}

export interface RunText {
  text: string;
  truncated: boolean;
  seq: [Seq, Seq];
  nextCursor: Seq;
}

/**
 * What rebuilding lifecycle segments needs: a journal and its Runs, of any life of
 * the name (G30) — a live session, or history. Built with `journalSource`.
 */
export interface ReplaySource {
  readonly id: string;
  readonly journal: Journal;
  readonly owner: Principal;
  /** Stamped on each message's metadata. */
  readonly state: string;
  readonly cwd: string | undefined;
  readonly controller: Principal | null;
  /** Any Run the journal holds; throws when it holds none. */
  run(runId: string): RunInfo;
  /** The Run's output as text: its newest part, visibly cut. */
  runText(runId: string): Promise<RunText>;
}

// ───────────── ids (§10.2, mcpl-4) ─────────────

/**
 * `<session>~<epoch>:<kind>:<seq>` — the lane qualifies it with the node. The journal's
 * epoch is kept across lives and restarts, so replayed messages keep their ids (G22), and
 * is new when a forgotten name starts `seq` over, so an id never names two events (mcpl-4).
 */
/**
 * A message's stable id. A Run's progress digest carries the Run's id too: two Runs in one
 * session, each printing a line and going quiet, had digests at the same journal seq and so the
 * same id, and the lane's sent-set dropped the second as a repeat (the house's review of #11).
 */
export function segmentId(session: string, journal: Journal, kind: SegmentKind, seq: Seq, runId?: string): string {
  return `${session}~${journal.epoch}:${kind}${runId !== undefined ? `~${runId}` : ''}:${seq}`;
}

/** The seq a message id reports, when it is one of ours. */
export function seqOfMessageId(id: string): Seq | undefined {
  const m = /~[^:/]+:[a-z-]+(?:~[^:]+)?:(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
}

// ───────────── formatting ─────────────

/** Last lines that ask a question outright (G15: a heuristic, labelled as one). */
const ASKS = /(?:\?$|\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\]|password|passphrase|press (?:any key|enter|return)|continue\?)/i;
/** A label ending in `:` asks only when it names what it wants (m2-23: `Downloading assets:` does not). */
const LABEL_ASK =
  /\b(?:enter|name|user(?:name)?|login|e-?mail|password|passphrase|pin|token|code|otp|choice|choose|select|option|answer|confirm|value|input|path|directory|folder|file|number|port|host|key|reply|response|type)\b[^:]*:$/i;
/** A short REPL or sub-shell prompt: `>>>`, `...`, `In [3]:`, `(Pdb)`, `mysql>`, `sh-3.2$`, `#`. A bare `]` or `%` is a progress bar. */
const REPL = /^(?:>>>|\.\.\.|In \[\d+\]:|\([\w-]+\)|[\w.@~/()\[\]:+-]{0,32}[>$#])$/;

const looksLikePrompt = (t: string) => ASKS.test(t) || LABEL_ASK.test(t) || REPL.test(t);

/**
 * The prompt-like line the cursor waits at, if any (G15, m2-23): the cursor at the
 * end of an unterminated line that asks for something, or on an empty line under a
 * question (`Name?` then a newline).
 */
export function promptLine(snap: ScreenSnapshot): string | undefined {
  const row = snap.lines[snap.cursor.y] ?? '';
  if (row.slice(snap.cursor.x).trim()) return undefined; // the cursor is not at the end of what is written
  const before = row.slice(0, snap.cursor.x).trim();
  if (before) return looksLikePrompt(before) ? before : undefined;
  const prev = snap.cursor.y > 0 ? (snap.lines[snap.cursor.y - 1] ?? '').trim() : '';
  return prev && ASKS.test(prev) ? prev : undefined;
}

const fmtDuration = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
export const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
export const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
export const isDone = (s: RunInfo['state']) => s === 'exited' || s === 'cancelled' || s === 'lost';
const describeRun = (run: RunInfo) => oneLine(run.line ?? run.argv?.join(' ') ?? run.runId, 100);
const bySeq = (a: Picked, b: Picked) => a.ev.seq - b.ev.seq;
const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));
/** How a shell ended, as the tail of a sentence (ux-25: "by daemon shutdown", not a bare exit code). */
const howEnded = (x: SessionExit) =>
  x.reason === 'daemon-shutdown' ? ' by daemon shutdown' : x.reason === 'daemon-restart' ? ' by a daemon restart' : x.reason !== undefined ? ` (${x.reason})` : x.code !== null ? ` with code ${x.code}` : x.signal ? ` by ${x.signal}` : '';

/** One line of output as a reader sees it: control sequences gone, a carriage return's overwrite applied. */
function cleanLine(raw: string): string {
  const s = stripAnsi(raw);
  const cr = s.lastIndexOf('\r', s.length - 2);
  return (cr === -1 ? s : s.slice(cr + 1)).replace(/\r/g, '').trimEnd();
}

/** The Run, or undefined when the source does not know it. */
export function runOf(src: { run(runId: string): RunInfo }, runId: string): RunInfo | undefined {
  try {
    return src.run(runId);
  } catch {
    return undefined;
  }
}

function tailBytes(text: string, max: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= max) return text;
  let start = buf.length - max;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++; // never cut a UTF-8 sequence
  const kept = buf.subarray(start).toString();
  const nl = kept.indexOf('\n');
  return nl === -1 ? kept : kept.slice(nl + 1);
}

// ───────────── sources ─────────────

type Output = Extract<JournalEvent, { type: 'output' }>;
type RunEnd = Extract<JournalEvent, { type: 'run.end' }>;
type Recovered = Extract<JournalEvent, { type: 'recovered' }>;
type SessionExit = Extract<JournalEvent, { type: 'session.exit' }>;

/** Input read to render a Run of an earlier life or of history: its newest part (runOutput walks backwards). */
const HISTORY_RUN_INPUT_BYTES = 64 * 1024;

/** A Run's text from the journal alone: the newest part of its attributed output, projected (§6). */
export async function journalRunText(o: RunOutput, cols = 120): Promise<RunText> {
  const events = o.events.filter((e): e is Output => e.type === 'output');
  const p = await project(
    events.map((e) => ({ data: e.data, stream: e.stream })),
    { cols, maxInputBytes: HISTORY_RUN_INPUT_BYTES, keep: 'tail' },
  );
  return { text: p.text, truncated: o.truncated || p.truncated, seq: [o.from, o.to], nextCursor: o.to };
}

/**
 * A replay source over a journal and its Runs (by default, the journal's run index).
 * `transcript` renders a Run of the live shell (the session knows its exec strategy);
 * every other Run — an earlier life's, or history's — is rendered from the journal's
 * newest part of its output.
 */
export function journalSource(o: {
  id: string;
  journal: Journal;
  owner: Principal;
  run?(runId: string): RunInfo;
  transcript?(runId: string): Promise<RunText> | undefined;
  state?: () => string;
  cwd?: () => string | undefined;
  controller?: () => Principal | null;
  cols?: number;
}): ReplaySource {
  return {
    id: o.id,
    journal: o.journal,
    owner: o.owner,
    get state() {
      return o.state?.() ?? 'exited';
    },
    get cwd() {
      return o.cwd?.();
    },
    get controller() {
      return o.controller?.() ?? null;
    },
    run: (runId) => (o.run ? o.run(runId) : o.journal.runs.run(runId)),
    runText: (runId) => o.transcript?.(runId) ?? journalRunText(o.journal.runs.output(o.journal, runId, { maxBytes: HISTORY_RUN_INPUT_BYTES }), o.cols),
  };
}

/** A live session as a replay source: its own Runs through the session, earlier lives' through the journal (G30, mcpl-18). */
export function liveSource(s: SegmentSource, cols?: number): ReplaySource {
  return journalSource({
    id: s.id,
    journal: s.journal,
    owner: s.owner,
    run: (runId) => runOf(s, runId) ?? s.journal.runs.run(runId),
    transcript: (runId) => (runOf(s, runId) ? s.runTranscript(runId) : undefined),
    state: () => s.state,
    cwd: () => s.cwd,
    controller: () => s.currentController,
    ...(cols !== undefined ? { cols } : {}),
  });
}

// ───────────── rendering ─────────────

/** Builds segments from journal events; shared by the live segmenter and replay. */
class Render {
  constructor(readonly src: ReplaySource) {}

  base(kind: SegmentKind, seq: Seq, extra: Record<string, unknown> = {}, ts = Date.now()): Pick<Segment, 'kind' | 'seq' | 'ts' | 'messageId' | 'metadata'> {
    const meta: Record<string, unknown> = { session: this.src.id, state: this.src.state, controller: this.src.controller };
    if (this.src.cwd !== undefined) meta.cwd = this.src.cwd;
    const ofRun = kind === 'output' && typeof extra.runId === 'string' ? extra.runId : undefined;
    return { kind, seq, ts, messageId: segmentId(this.src.id, this.src.journal, kind, seq, ofRun), metadata: { ...meta, ...extra } };
  }

  async run(ev: RunEnd): Promise<Segment | undefined> {
    const run = runOf(this.src, ev.runId);
    if (!run) return undefined;
    const t = await this.src.runText(ev.runId).catch((): RunText => ({ text: '', seq: [ev.seq, ev.seq], nextCursor: ev.seq, truncated: false }));
    let body = t.text;
    if (Buffer.byteLength(body) > RUN_BODY_BYTES) {
      body = `[… earlier output omitted · read runId=${ev.runId} for all of it]\n` + tailBytes(body, RUN_BODY_BYTES);
    }
    const status =
      ev.state === 'exited'
        ? ev.signal
          ? `→ killed by ${ev.signal}`
          : `→ exit ${ev.exit ?? '?'}`
        : ev.state === 'cancelled'
          ? `→ cancelled${ev.signal ? ` by ${ev.signal}` : ev.exit !== undefined ? ` (exit ${ev.exit})` : ''}`
          : `→ outcome unknown (${ev.reason ?? 'lost'})`;
    const who = run.origin === 'self' || run.origin === 'system' ? '' : ` · by ${run.principal}`;
    const head = `[terminal] ${this.src.id}: \`${describeRun(run)}\` ${status} in ${fmtDuration(ev.durationMs)}${who} · run ${ev.runId} · read since=${Math.max(0, t.seq[0] - 1)}`;
    // The origin facet and the chat:from-* sender tag are relative to the reader; the lane adds them.
    const tags = [ev.state === 'lost' ? 'terminal:run-lost' : 'terminal:run-finished', `terminal:target=${run.target}`];
    if (ev.signal) tags.push('terminal:exit=signal');
    else if (ev.state === 'exited') tags.push(`terminal:exit=${ev.exit === 0 ? 'ok' : 'nonzero'}`);
    const meta: Record<string, unknown> = { runId: ev.runId, runState: ev.state, target: run.target, principal: run.principal, durationMs: ev.durationMs, outputFrom: t.seq[0], outputTo: t.seq[1], nextCursor: t.nextCursor };
    if (ev.exit !== undefined) meta.exit = ev.exit;
    if (ev.signal) meta.signal = ev.signal;
    if (ev.reason) meta.reason = ev.reason;
    if (run.line !== undefined) meta.line = run.line;
    const seg: Segment = { ...this.base('run', ev.seq, meta, ev.ts), lifecycle: true, tags, head, interested: [run.principal], runId: ev.runId, author: run.principal };
    if (body) seg.body = body;
    return seg;
  }

  service(ev: Extract<JournalEvent, { type: 'service' }>): Segment {
    const run = runOf(this.src, ev.runId);
    const desc = run ? describeRun(run) : ev.runId;
    const name = ev.name ? `${ev.name} ` : '';
    return {
      ...this.base('service', ev.seq, { runId: ev.runId, service: ev.status, probe: ev.probe, evidence: ev.evidence }, ev.ts),
      lifecycle: true,
      tags: [`terminal:service-${ev.status}`],
      head: `[terminal] ${this.src.id}: service ${name}\`${desc}\` ${ev.status}${ev.evidence ? ` (${oneLine(ev.evidence, 120)})` : ''} · run ${ev.runId}`,
      interested: ev.principal ? [ev.principal] : [],
      runId: ev.runId,
    };
  }

  watch(ev: Extract<JournalEvent, { type: 'watch.fired' }>): Segment {
    const what = ev.kind === 'pattern' ? `matched: ${oneLine(ev.line ?? ev.match ?? '', 160)}` : ev.kind === 'silence' ? (ev.match ?? 'output went quiet') : 'the shell is available';
    return {
      ...this.base('watch', ev.seq, { watchId: ev.watchId, label: ev.label, watchKind: ev.kind, match: ev.match, at: ev.at }, ev.ts),
      lifecycle: true,
      tags: [`terminal:watch=${ev.label}`, 'terminal:watch', `terminal:${ev.kind}`],
      head: `[terminal] ${this.src.id}: watch "${oneLine(ev.label, 60)}" fired · ${what}${ev.suppressed ? ` (+${ev.suppressed} more)` : ''} · read since=${Math.max(0, ev.at - 1)}`,
      interested: [ev.principal],
    };
  }

  exit(ev: SessionExit, interested: Principal[]): Segment {
    return {
      ...this.base('session-exit', ev.seq, { state: 'exited', code: ev.code, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) }, ev.ts),
      lifecycle: true,
      tags: ['terminal:session-exited'],
      head: `[terminal] ${this.src.id}: the shell ${ev.reason !== undefined ? 'was ended' : 'exited'}${howEnded(ev)} · history stays readable (read session=${this.src.id})`,
      interested: [...new Set(interested)],
    };
  }

  /**
   * §10.2's recovery message (m2-4): a daemon restart left this session's history
   * behind. A shell exit it cut short is folded in; the Runs it made lost have their
   * own completions.
   */
  recovered(ev: Recovered, lost: Lost, exit?: SessionExit): Segment {
    const gone = ev.class === 'history-only';
    const shell = exit ? ` (the shell had ended${howEnded(exit)})` : '';
    const runs = lost.count ? ` · ${lost.count} Run${lost.count > 1 ? 's' : ''} lost (each is reported)` : '';
    const what = gone ? `the daemon restarted and this session's shell is gone: history only${shell}` : `the daemon restarted; the session continued (${ev.class})`;
    const tags = ['terminal:recovered', `terminal:recovered=${ev.class}`];
    if (gone) tags.unshift('terminal:session-exited');
    const meta: Record<string, unknown> = { state: gone ? 'exited' : this.src.state, recovered: ev.class, lostRuns: lost.count };
    if (exit) meta.code = exit.code;
    return {
      ...this.base('recovered', ev.seq, meta, ev.ts),
      lifecycle: true,
      tags,
      head: `[terminal] ${this.src.id}: ${what}${runs} · read session=${this.src.id}`,
      interested: [...new Set(lost.principals)],
    };
  }

  waiting(ev: Extract<JournalEvent, { type: 'run.waiting' }>): Segment | undefined {
    const run = runOf(this.src, ev.runId);
    if (!run) return undefined;
    return {
      ...this.base('needs-input', ev.seq, { runId: ev.runId, evidence: { lastLine: ev.lastLine, silentMs: ev.silentMs, state: ev.state }, heuristic: true }, ev.ts),
      lifecycle: true,
      tags: ['terminal:needs-input'],
      head: `[terminal] ${this.src.id}: \`${describeRun(run)}\` may be waiting for input (heuristic: silent ${fmtDuration(ev.silentMs)}, last line "${oneLine(ev.lastLine, 80)}") · answer with input session=${this.src.id}`,
      interested: [run.principal],
      runId: ev.runId,
    };
  }

  /** A note (§10.1): what a principal said on the channel, for everyone else with it open (mcpl-14). */
  note(ev: Extract<JournalEvent, { type: 'note' }>): Segment {
    const seg: Segment = {
      ...this.base('note', ev.seq, { principal: ev.principal }, ev.ts),
      lifecycle: false,
      tags: ['terminal:note'],
      head: `[terminal] ${this.src.id}: note from ${ev.principal}: ${oneLine(ev.text, 200)}`,
      interested: [],
      author: ev.principal,
    };
    if (ev.text.includes('\n') || ev.text.length > 200) seg.body = tailBytes(ev.text, RUN_BODY_BYTES);
    return seg;
  }
}

// ───────────── replay: catch-up and channel history ─────────────

export type LifecycleEvent = Extract<JournalEvent, { type: 'run.end' | 'service' | 'watch.fired' | 'session.exit' | 'recovered' | 'run.waiting' | 'note' }>;

/** The Runs a daemon restart made lost, and whose they were (they have explicit interest in its recovery, G28). */
export interface Lost {
  principals: Principal[];
  count: number;
}

export interface Picked {
  ev: LifecycleEvent;
  /** For a recovery: the Runs it made lost. */
  lost?: Lost;
  /** A shell exit folded into this recovery. */
  exit?: SessionExit;
}

export interface Omitted {
  count: number;
  from: Seq;
  to: Seq;
  kinds: Record<string, number>;
}

export interface LifecycleScan {
  /** Oldest first, at most `keep`. */
  picked: Picked[];
  /** Owed events not kept (the oldest ones). */
  omitted?: Omitted;
  /** The last seq the scan covered. */
  end: Seq;
}

/** Events only a running shell journals: after an exit or recovery they mean a new life began, which supersedes it (a viewer attaching to an ended shell is not one). */
const LIFE_EVENTS = new Set<JournalEvent['type']>(['integration', 'prompt', 'run.admit', 'run.start', 'cwd']);
const lostAtRestart = (ev: RunEnd) => ev.state === 'lost' && ev.reason !== undefined && ev.reason.startsWith('daemon-');
/** Events a catch-up scan reads per page; it yields to the event loop between pages. */
const SCAN_PAGE = 5000;
/** Channel history reads the journal backwards in pages of this many events, never more than HISTORY_MAX_EVENTS. */
const HISTORY_PAGE = 2000;
const HISTORY_MAX_EVENTS = 200_000;

const kindOf = (ev: LifecycleEvent): SegmentKind =>
  ev.type === 'run.end' ? 'run' : ev.type === 'watch.fired' ? 'watch' : ev.type === 'session.exit' ? 'session-exit' : ev.type === 'run.waiting' ? 'needs-input' : ev.type === 'recovered' ? 'recovered' : ev.type === 'note' ? 'note' : 'service';

/** `o` with `dropped` counted in: how many of each kind, and their seq range. */
export function countOmitted(o: Omitted | undefined, dropped: Picked[]): Omitted | undefined {
  if (!dropped.length) return o;
  const out: Omitted = o ? { ...o, kinds: { ...o.kinds } } : { count: 0, from: 0, to: 0, kinds: {} };
  for (const { ev } of dropped) {
    out.count++;
    if (!out.from || ev.seq < out.from) out.from = ev.seq;
    out.to = Math.max(out.to, ev.seq);
    out.kinds[kindOf(ev)] = (out.kinds[kindOf(ev)] ?? 0) + 1;
  }
  return out;
}

/**
 * Every lifecycle event after `since`, read forward in bounded pages to the end
 * (mcpl-3: never only the oldest window), keeping the newest `keep` the caller
 * accepts — what is owed (default: all) — and counting the rest. A shell exit or recovery a later
 * life of the name superseded is left out (ux-25). Cost is linear in the events
 * after `since`, and the event loop is yielded to between pages.
 */
export async function scanLifecycle(src: ReplaySource, since: Seq, opts: { keep?: number; accept?: (p: Picked) => boolean } = {}): Promise<LifecycleScan> {
  const keep = Math.max(0, opts.keep ?? 20);
  const end = src.journal.lastSeq;
  const kept: Picked[] = [];
  let omitted: Omitted | undefined;
  // The end of the last life seen: its exit and recovery wait here until a later life supersedes them.
  let tentative: Picked[] = [];
  let lost: Lost = { principals: [], count: 0 };
  const trim = () => {
    kept.sort(bySeq);
    omitted = countOmitted(omitted, kept.splice(0, Math.max(0, kept.length - keep)));
  };
  const commit = (p: Picked) => {
    // A needs-input whose Run has ended since is stale: not news, not counted.
    if (p.ev.type === 'run.waiting' && isDone(runOf(src, p.ev.runId)?.state ?? 'lost')) return;
    if (opts.accept && !opts.accept(p)) return;
    kept.push(p);
    if (kept.length > Math.max(64, keep * 4)) trim();
  };

  for (let cursor = since; cursor < end; ) {
    const page = src.journal.since(cursor, SCAN_PAGE);
    const events = page.events;
    if (!events.length) break;
    for (const ev of events) {
      if (ev.seq > end) break;
      if (LIFE_EVENTS.has(ev.type)) {
        tentative = [];
        lost = { principals: [], count: 0 };
      } else if (ev.type === 'run.end') {
        if (lostAtRestart(ev)) {
          lost.count++;
          const who = runOf(src, ev.runId)?.principal;
          if (who !== undefined) lost.principals.push(who);
        }
        commit({ ev });
      } else if (ev.type === 'watch.fired' || ev.type === 'run.waiting' || (ev.type === 'service' && ev.status !== 'starting')) {
        commit({ ev });
      } else if (ev.type === 'session.exit') {
        tentative.push({ ev });
      } else if (ev.type === 'recovered') {
        // The exit of the same life (no life began since) is part of the recovery: one message (ux-25).
        const p: Picked = { ev, lost };
        const exitAt = tentative.findIndex((t) => t.ev.type === 'session.exit');
        if (exitAt !== -1) p.exit = tentative.splice(exitAt, 1)[0]!.ev as SessionExit;
        tentative.push(p);
        lost = { principals: [], count: 0 };
      }
    }
    cursor = events[events.length - 1]!.seq;
    if (!page.more) break;
    await yieldTurn();
  }
  for (const t of tentative) commit(t);
  trim();
  const out: LifecycleScan = { picked: kept, end };
  if (omitted) out.omitted = omitted;
  return out;
}

/** Render picked events as segments, oldest first (a Run's text is read here, once per kept event). */
export async function renderPicked(src: ReplaySource, picked: Picked[]): Promise<Segment[]> {
  const r = new Render(src);
  const out: Segment[] = [];
  for (const p of picked) {
    const seg = await renderOne(r, p);
    if (seg) out.push(seg);
  }
  return out;
}

async function renderOne(r: Render, p: Picked): Promise<Segment | undefined> {
  const ev = p.ev;
  switch (ev.type) {
    case 'run.end':
      return r.run(ev);
    case 'service':
      return r.service(ev);
    case 'watch.fired':
      return r.watch(ev);
    case 'session.exit':
      return r.exit(ev, []);
    case 'recovered':
      return r.recovered(ev, p.lost ?? { principals: [], count: 0 }, p.exit);
    case 'run.waiting':
      return r.waiting(ev);
    case 'note':
      return r.note(ev);
  }
}

/**
 * The newest `limit` lifecycle messages (and notes) before `before`, for channel
 * history (§10.1): the journal is read backwards in bounded pages, never more than
 * HISTORY_MAX_EVENTS. Runs of every life are rendered (mcpl-18). Oldest first.
 */
export async function replayNewest(src: ReplaySource, opts: { limit: number; before?: Seq }): Promise<{ segments: Segment[]; truncated: boolean }> {
  const limit = Math.max(0, opts.limit);
  let budget = HISTORY_MAX_EVENTS;
  const picked: Picked[] = []; // newest first
  let to = (opts.before ?? src.journal.lastSeq + 1) - 1;
  let truncated = false;
  // Scanning backwards, a recovery waits for the exit that may precede it (only run ends between).
  let recovery: Picked | undefined;
  const oldest = src.journal.oldestSeq ?? 1;
  outer: while (limit > 0 && to >= oldest && budget > 0) {
    const page = src.journal.tail(Math.min(HISTORY_PAGE, budget), to);
    if (!page.length) break;
    budget -= page.length;
    for (let i = page.length - 1; i >= 0; i--) {
      const ev = page[i]!;
      if (ev.type === 'run.end' && recovery?.lost && lostAtRestart(ev)) {
        recovery.lost.count++;
        const who = runOf(src, ev.runId)?.principal;
        if (who !== undefined) recovery.lost.principals.push(who);
      } else if (ev.type === 'session.exit' && recovery) {
        recovery.exit = ev;
        recovery = undefined;
        continue;
      } else if (LIFE_EVENTS.has(ev.type)) recovery = undefined;
      let p: Picked | undefined;
      if (ev.type === 'recovered') recovery = p = { ev, lost: { principals: [], count: 0 } };
      else if (ev.type === 'run.end' || ev.type === 'watch.fired' || ev.type === 'session.exit' || ev.type === 'run.waiting' || ev.type === 'note' || (ev.type === 'service' && ev.status !== 'starting')) p = { ev };
      if (!p) continue;
      if (picked.length === limit) {
        truncated = true;
        break outer;
      }
      picked.push(p);
    }
    to = page[0]!.seq - 1;
    await yieldTurn();
  }
  if (budget <= 0 && to >= oldest) truncated = true;
  return { segments: await renderPicked(src, picked.reverse()), truncated };
}

// ───────────── the live segmenter ─────────────

interface RunWatch {
  runId: string;
  bytes: number;
  bytesAtLastDigest: number;
  lastDigestId?: string;
  timer?: NodeJS.Timeout | undefined;
  silenceTimer?: NodeJS.Timeout | undefined;
  askedAtSeq?: Seq;
  /** The last complete output lines, cleaned (er-3: a digest never reads the journal). */
  lines: string[];
  /** Raw text after the last newline, capped. */
  carry: string;
  carryStream?: OutputStream;
  /** (seq, bytes before it) checkpoints, for "new since your last read" without reading the journal. */
  marks: Array<[Seq, number]>;
}

interface Submitted {
  text: string;
  seq: Seq;
  sensitive: boolean;
  /** The text was on the screen when Enter was pressed (the program echoed it). */
  echoed: boolean;
  /** The line it answered asked for a secret. */
  secretPrompt: boolean;
}

interface HumanLine {
  principal: Principal;
  /** The line being edited, with BS/DEL, ^U, ^W and ^C applied (m2-22). */
  buf: string;
  bufSensitive: boolean;
  bufSeq: Seq;
  /** What the screen showed before the line's first keystroke: the program's prompt. */
  prompt: string;
  /** An escape sequence being skipped, across input events (arrows, SS3 keys). */
  esc: '' | 'esc' | 'csi' | 'ss3' | 'osc' | 'osc-esc';
  lines: Submitted[];
  firstAt?: number | undefined;
  timer?: NodeJS.Timeout | undefined;
}

interface Settling {
  fire: () => void;
  done: Promise<void>;
}

/** Output a run message (and a note or several typed lines) shows at most: its tail. */
const RUN_BODY_BYTES = 4096;
/** Lines a progress digest shows. */
const DIGEST_LINES = 8;
const CARRY_MAX = 4096;
const MARKS_MAX = 1024;
const SENSITIVE = '[sensitive input]';
const NOT_ECHOED = '[input not echoed — not shown]';

export class Segmenter {
  private readonly listeners = new Set<(s: Segment) => void>();
  private readonly off: () => void;
  private readonly running = new Map<string, RunWatch>();
  /** Completions waiting out the settle, by run.end seq; emitted, never dropped, on dispose (mcpl-6). */
  private readonly settling = new Map<Seq, Settling>();
  private readonly o: Required<SegmenterOptions>;
  private readonly render: Render;
  private screenTimer: NodeJS.Timeout | undefined;
  private screenAt: number | undefined;
  /** When the screen first changed since the last one sent (a max-wait, m2-13). */
  private screenDirtySince: number | undefined;
  /** The first screen of a full-screen program is not held to the cadence. */
  private firstScreenPending = false;
  private lastScreenAt = 0;
  private lastScreenId: string | undefined;
  private lastScreenText = '';
  private alt = false;
  private readonly human = new Map<Principal, HumanLine>();
  /** Recent run.start events: a human line followed by one was a command, and the Run is its message. */
  private readonly recentStarts: Array<{ seq: Seq; runId: string }> = [];
  private disposing: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly s: SegmentSource,
    opts: SegmenterOptions = {},
  ) {
    const screenQuietMs = opts.screenQuietMs ?? 500;
    this.o = {
      cadenceMs: opts.cadenceMs ?? 10_000,
      runSettleMs: opts.runSettleMs ?? 200,
      screenQuietMs,
      screenMaxWaitMs: opts.screenMaxWaitMs ?? Math.max(2 * screenQuietMs, 1000),
      needsInputMs: opts.needsInputMs ?? 5_000,
    };
    this.render = new Render(liveSource(s));
    // Runs already in flight when the segmenter starts get digests too.
    for (const r of s.listRuns()) if (r.state === 'running') this.track(r.runId);
    this.off = s.journal.subscribe((ev) => this.onEvent(ev));
    // Created while a full-screen program is up (the first lane arrived late): its screens flow (m2-19).
    try {
      if (s.snapshot().alt) this.onMode(true);
    } catch {
      // no screen yet
    }
  }

  subscribe(l: (s: Segment) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Resolves once every completion still settling has been emitted (a lane waits for this before letting a closed session go). */
  async drained(): Promise<void> {
    while (this.settling.size) await Promise.all([...this.settling.values()].map((e) => e.done));
  }

  /**
   * Stop. Completions still settling are built and emitted first — a session closed
   * within the settle still reports its Runs (G28, mcpl-6) — then listeners go.
   * Resolves when that is done; calling it again returns the same promise.
   */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.off();
    for (const r of [...this.running.values()]) this.untrack(r.runId);
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.screenTimer = undefined;
    for (const h of this.human.values()) if (h.timer) clearTimeout(h.timer);
    this.human.clear();
    for (const e of [...this.settling.values()]) e.fire();
    this.disposing = this.drained().then(() => {
      this.disposed = true;
      this.listeners.clear();
    });
    return this.disposing;
  }

  /** Output bytes of a running Run after `read` (for "new since your last read"), or undefined when it is not tracked. */
  unreadBytes(runId: string, read: Seq): number | undefined {
    const w = this.running.get(runId);
    if (!w) return undefined;
    const first = w.marks.find(([seq]) => seq > read);
    return first ? w.bytes - first[1] : 0;
  }

  private emit(seg: Segment | undefined): void {
    if (!seg || this.disposed) return;
    for (const l of this.listeners) {
      try {
        l(seg);
      } catch {
        // A listener's failure is never the segmenter's problem.
      }
    }
  }

  // ───────────── journal ─────────────

  private onEvent(ev: JournalEvent): void {
    switch (ev.type) {
      case 'run.start':
        this.track(ev.runId);
        this.recentStarts.push({ seq: ev.seq, runId: ev.runId });
        if (this.recentStarts.length > 32) this.recentStarts.shift();
        return;
      case 'output':
        this.onOutput(ev);
        return;
      case 'run.end':
        this.untrack(ev.runId);
        this.settle(ev);
        return;
      case 'service':
        if (ev.status !== 'starting') this.emit(this.render.service(ev));
        return;
      case 'watch.fired':
        return this.emit(this.render.watch(ev));
      case 'run.waiting':
        return this.emit(this.render.waiting(ev));
      case 'note':
        return this.emit(this.render.note(ev));
      case 'screen.mode':
        this.onMode(ev.alt);
        return;
      case 'control':
        this.emit({
          ...this.render.base('control', ev.seq, { controller: ev.controller }, ev.ts),
          lifecycle: false,
          tags: ['terminal:control'],
          head: `[terminal] ${this.s.id}: seat ${ev.controller ? `taken by ${ev.controller}` : 'released'} (${ev.how}${ev.by !== ev.controller ? ` by ${ev.by}` : ''})`,
          interested: [],
        });
        return;
      case 'session.exit':
        // Interest: principals whose Runs this exit cuts short (G28); the lane adds the owner.
        this.emit(this.render.exit(ev, this.s.listRuns().filter((r) => !isDone(r.state)).map((r) => r.principal)));
        return;
      case 'input':
        this.onInput(ev);
        return;
      default:
        return;
    }
  }

  // ───────────── runs ─────────────

  /** A completion is built `runSettleMs` after its end (the prompt lands first), or at once on dispose. */
  private settle(ev: RunEnd): void {
    let started = false;
    let resolve!: () => void;
    const e: Settling = {
      done: new Promise<void>((r) => (resolve = r)),
      fire: () => {
        clearTimeout(timer);
        if (started) return;
        started = true;
        void this.render
          .run(ev)
          .then((seg) => this.emit(seg))
          .catch(() => undefined)
          .finally(() => {
            this.settling.delete(ev.seq);
            resolve();
          });
      },
    };
    const timer = setTimeout(e.fire, this.o.runSettleMs);
    this.settling.set(ev.seq, e);
  }

  private track(runId: string): void {
    if (this.running.has(runId) || this.disposing) return;
    const w: RunWatch = { runId, bytes: 0, bytesAtLastDigest: 0, lines: [], carry: '', marks: [] };
    this.running.set(runId, w);
    w.timer = setInterval(() => this.digest(w), this.o.cadenceMs);
  }

  private untrack(runId: string): void {
    const w = this.running.get(runId);
    if (!w) return;
    if (w.timer) clearInterval(w.timer);
    if (w.silenceTimer) clearTimeout(w.silenceTimer);
    this.running.delete(runId);
  }

  private onOutput(ev: Output): void {
    if (this.alt && ev.stream === 'pty') this.scheduleScreen();
    if (!ev.runId) return;
    const w = this.running.get(ev.runId);
    if (!w) return;
    const n = Buffer.byteLength(ev.data);
    w.marks.push([ev.seq, w.bytes]);
    if (w.marks.length > MARKS_MAX) w.marks = w.marks.filter((_, i) => i % 2 === 0);
    w.bytes += n;
    // A full-screen program's redraws are not lines; its screens are the message.
    if (!this.alt) this.feedLines(w, ev.data, ev.stream);
    // Needs-input: a shell Run that goes silent with a prompt-like last line (G15).
    if (ev.stream === 'pty') {
      if (w.silenceTimer) clearTimeout(w.silenceTimer);
      w.silenceTimer = setTimeout(() => this.checkNeedsInput(w), this.o.needsInputMs);
    }
  }

  /** Keep the Run's last lines as output arrives, so a digest costs what it shows (er-3, mcpl-11, m2-17). */
  private feedLines(w: RunWatch, data: string, stream: OutputStream): void {
    if (w.carry && w.carryStream !== undefined && w.carryStream !== stream) {
      // A change of source starts on a fresh line (§6 rule 6).
      this.pushLines(w, [cleanLine(w.carry)]);
      w.carry = '';
    }
    w.carryStream = stream;
    let buf = w.carry + data;
    const nl = buf.lastIndexOf('\n');
    if (nl !== -1) {
      const fresh: string[] = [];
      let end = nl;
      // Only the newest lines can survive, so read back from the end until there are enough.
      while (end >= 0 && fresh.length < DIGEST_LINES) {
        const start = buf.lastIndexOf('\n', end - 1);
        const line = cleanLine(buf.slice(start + 1, end));
        if (line) fresh.push(line);
        if (start < 0) break;
        end = start;
      }
      this.pushLines(w, fresh.reverse());
      buf = buf.slice(nl + 1);
    }
    if (buf.length > CARRY_MAX) {
      // A line that never ends (a progress bar): what follows its last carriage return is what shows.
      const cr = buf.lastIndexOf('\r', buf.length - 2);
      buf = cr !== -1 && buf.length - cr - 1 <= CARRY_MAX ? buf.slice(cr + 1) : buf.slice(-CARRY_MAX);
    }
    w.carry = buf;
  }

  private pushLines(w: RunWatch, lines: string[]): void {
    for (const l of lines) if (l) w.lines.push(l);
    if (w.lines.length > DIGEST_LINES) w.lines.splice(0, w.lines.length - DIGEST_LINES);
  }

  private digest(w: RunWatch): void {
    const run = runOf(this.s, w.runId);
    if (!run || w.bytes === w.bytesAtLastDigest || this.alt || this.disposing) return;
    const partial = cleanLine(w.carry);
    const tail = (partial ? [...w.lines, partial] : w.lines).slice(-DIGEST_LINES).join('\n');
    const seq = this.s.journal.lastSeq;
    const elapsed = Date.now() - (run.startedAt ?? run.admittedAt);
    const seg: Segment = {
      ...this.render.base('output', seq, { runId: w.runId, bytes: w.bytes, elapsedMs: elapsed, nextCursor: seq }),
      lifecycle: false,
      tags: ['terminal:output', 'terminal:running'],
      head: `[terminal] ${this.s.id}: running \`${describeRun(run)}\` ${fmtDuration(elapsed)} · ${fmtBytes(w.bytes)} so far · run ${w.runId}`,
      interested: [run.principal],
      runId: w.runId,
    };
    if (tail) seg.body = tail;
    if (w.lastDigestId) seg.supersedes = w.lastDigestId;
    w.lastDigestId = seg.messageId;
    w.bytesAtLastDigest = w.bytes;
    this.emit(seg);
  }

  /**
   * A Run silent for `needsInputMs` whose cursor waits at a prompt-like line (G15,
   * m2-23) is journaled as `run.waiting` with its evidence (m2-18); the segment is
   * built from that event, so catch-up and presence see it too.
   */
  private checkNeedsInput(w: RunWatch): void {
    w.silenceTimer = undefined;
    if (!this.running.has(w.runId) || this.alt || this.disposing) return;
    const snap = this.s.snapshot();
    const line = promptLine(snap);
    if (line === undefined || w.askedAtSeq === snap.seq) return;
    w.askedAtSeq = snap.seq;
    this.s.journal.append({ type: 'run.waiting', runId: w.runId, lastLine: line, silentMs: this.o.needsInputMs, state: this.s.state });
  }

  // ───────────── screens ─────────────

  private onMode(alt: boolean): void {
    this.alt = alt;
    if (alt) {
      this.firstScreenPending = true;
      this.scheduleScreen();
      return;
    }
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.screenTimer = undefined;
    this.screenAt = undefined;
    this.screenDirtySince = undefined;
    // What a full-screen program drew is not lines of output.
    for (const w of this.running.values()) {
      w.lines = [];
      w.carry = '';
    }
  }

  /**
   * A screen goes `screenQuietMs` after the last change, but never later than
   * `screenMaxWaitMs` after the first unsent change — a program that redraws all
   * the time still gets screens (m2-13) — and, after the first, at most once per cadence.
   */
  private scheduleScreen(): void {
    if (this.disposing) return;
    const now = Date.now();
    if (this.screenDirtySince === undefined) this.screenDirtySince = now;
    const quietAt = now + this.o.screenQuietMs;
    const latestAt = this.screenDirtySince + this.o.screenMaxWaitMs;
    const notBefore = this.firstScreenPending ? now : this.lastScreenAt + this.o.cadenceMs;
    const at = Math.max(notBefore, Math.min(quietAt, latestAt));
    if (this.screenTimer) {
      if (this.screenAt === at) return;
      clearTimeout(this.screenTimer);
    }
    this.screenAt = at;
    this.screenTimer = setTimeout(() => {
      this.screenTimer = undefined;
      this.screenAt = undefined;
      this.screenSegment();
    }, Math.max(0, at - now));
  }

  private screenSegment(): void {
    if (!this.alt || this.disposing) return;
    this.screenDirtySince = undefined;
    const snap = this.s.snapshot();
    const text = snap.lines.join('\n').replace(/\n+$/, '');
    if (text === this.lastScreenText) return;
    this.lastScreenText = text;
    this.lastScreenAt = Date.now();
    this.firstScreenPending = false;
    const seg: Segment = {
      ...this.render.base('screen', snap.seq, { cols: snap.cols, rows: snap.rows }),
      lifecycle: false,
      tags: ['terminal:screen'],
      head: `[terminal] ${this.s.id}: full-screen program${snap.title ? ` "${oneLine(snap.title, 60)}"` : ''} · screen at seq ${snap.seq} (screen session=${this.s.id} for the current one)`,
      body: text,
      interested: [],
    };
    if (this.lastScreenId) seg.supersedes = this.lastScreenId;
    this.lastScreenId = seg.messageId;
    this.emit(seg);
  }

  // ───────────── human input ─────────────

  /**
   * A human typing into a program (a REPL, a prompt) is worth telling an agent with
   * the channel open — never as a push (mcpl-15: it is ambient). A line that starts a
   * Run is not repeated (the Run's end is the message); keystrokes into a full-screen
   * program are not lines (its screens are the message). The text is the line as
   * edited (m2-22), shown only when the program echoed it and the prompt did not ask
   * for a secret; anything else is a placeholder (m2-2, G26).
   */
  private onInput(ev: Extract<JournalEvent, { type: 'input' }>): void {
    if (ev.kind === 'protocol-reply' || !ev.principal.startsWith('human:') || this.alt || this.disposing) return;
    let h = this.human.get(ev.principal);
    if (!h) {
      h = { principal: ev.principal, buf: '', bufSensitive: false, bufSeq: ev.seq, prompt: '', esc: '', lines: [] };
      this.human.set(ev.principal, h);
    }
    h.bufSeq = ev.seq;
    // A line's first keystroke is journaled before the program sees it: the cursor row is its prompt.
    if (!h.buf) h.prompt = this.cursorRow();
    if (ev.sensitive) {
      // Journaled as a placeholder (G26); whatever it was, it is a sensitive answer.
      h.bufSensitive = true;
      this.submit(h, ev.seq);
    } else this.edit(h, ev.data, ev.seq);
    if (h.timer) clearTimeout(h.timer);
    h.timer = undefined;
    const now = Date.now();
    if (h.lines.length) {
      // On Enter wait briefly (does a Run start?), coalescing a burst of lines, never past 2 s.
      h.firstAt ??= now;
      h.timer = setTimeout(() => this.flushHuman(h!), Math.max(0, Math.min(300, h.firstAt + 2000 - now)));
    } else if (h.buf.trim()) h.timer = setTimeout(() => this.flushHuman(h!), 2000);
  }

  private edit(h: HumanLine, data: string, seq: Seq): void {
    for (const ch of data) {
      switch (h.esc) {
        case 'esc':
          h.esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : ch === ']' ? 'osc' : '';
          continue;
        case 'csi':
          if (ch >= '@' && ch <= '~') h.esc = '';
          continue;
        case 'ss3':
        case 'osc-esc':
          h.esc = '';
          continue;
        case 'osc':
          if (ch === '\x07') h.esc = '';
          else if (ch === '\x1b') h.esc = 'osc-esc';
          continue;
        default:
          break;
      }
      if (ch === '\x1b') h.esc = 'esc';
      else if (ch === '\r' || ch === '\n') this.submit(h, seq);
      else if (ch === '\x7f' || ch === '\b') h.buf = [...h.buf].slice(0, -1).join('');
      else if (ch === '\x15') h.buf = ''; // ^U
      else if (ch === '\x17') h.buf = h.buf.replace(/\S*\s*$/, ''); // ^W
      else if (ch === '\x03') {
        h.buf = ''; // ^C abandons the line
        h.bufSensitive = false;
      } else if (ch >= ' ') h.buf += ch;
    }
  }

  private submit(h: HumanLine, seq: Seq): void {
    const text = h.buf;
    const sensitive = h.bufSensitive;
    h.buf = '';
    h.bufSensitive = false;
    if (!text.trim() && !sensitive) return;
    const snap = this.s.snapshot();
    h.lines.push({ text, seq, sensitive, echoed: !sensitive && echoedOn(snap, text, 0), secretPrompt: looksLikeSecretPrompt(h.prompt) });
    h.prompt = this.cursorRow();
  }

  private cursorRow(): string {
    try {
      const snap = this.s.snapshot();
      return (snap.lines[snap.cursor.y] ?? '').slice(0, snap.cursor.x);
    } catch {
      return '';
    }
  }

  private flushHuman(h: HumanLine): void {
    h.timer = undefined;
    if (this.disposing) return;
    if (h.buf.trim()) this.submit(h, h.bufSeq); // 2 s quiet ends a line too (§10.2)
    const lines = h.lines.splice(0);
    h.firstAt = undefined;
    if (!h.buf && !h.esc) this.human.delete(h.principal);
    const snap = this.s.snapshot();
    const shown: string[] = [];
    lines.forEach((l, i) => {
      if (this.executed(l.seq, lines[i + 1]?.seq)) return;
      if (l.sensitive || l.secretPrompt) shown.push(SENSITIVE);
      else if (l.echoed || echoedOn(snap, l.text, 3)) shown.push(oneLine(l.text, 200));
      else shown.push(NOT_ECHOED);
    });
    if (!shown.length) return;
    const last = lines[lines.length - 1]!.seq;
    const head =
      shown.length === 1
        ? `[terminal] ${this.s.id}: ${h.principal} typed: ${shown[0]}`
        : `[terminal] ${this.s.id}: ${h.principal} typed ${shown.length} lines: ${oneLine(shown.join(' ⏎ '), 200)}`;
    const seg: Segment = {
      ...this.render.base('human-input', last),
      lifecycle: false,
      tags: ['terminal:human-input', 'chat:from-human'],
      head,
      interested: [],
      author: h.principal,
    };
    if (shown.length > 1) seg.body = tailBytes(shown.join('\n'), RUN_BODY_BYTES);
    this.emit(seg);
  }

  /** Did a Run admitted after this line start before the next one (the line was a command)? */
  private executed(seq: Seq, next: Seq | undefined): boolean {
    return this.recentStarts.some((st) => st.seq > seq && (next === undefined || st.seq < next) && (runOf(this.s, st.runId)?.seq.admit ?? 0) > seq);
  }
}

/** Is `text` on the screen near the cursor (the program echoed it)? `extra` rows above the ones it would span. */
function echoedOn(snap: ScreenSnapshot, text: string, extra: number): boolean {
  const t = text.trim();
  if (!t) return false;
  const span = Math.ceil(t.length / Math.max(1, snap.cols)) + 1 + extra;
  const rows = snap.lines.slice(Math.max(0, snap.cursor.y - span), snap.cursor.y + 1);
  return rows.join('').includes(t) || rows.some((r) => r.includes(t));
}
