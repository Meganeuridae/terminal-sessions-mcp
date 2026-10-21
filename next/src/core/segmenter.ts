/**
 * The Segmenter (§10.2): turns one session's journal into messages for hosts.
 * One per session, shared by every connection; each connection's lane decides
 * per principal what to deliver (suppression G28, explicit interest, open or
 * closed channel) and personalizes the few fields that depend on the reader.
 *
 * Every segment's text opens with one self-describing line — the session and what
 * happened, and for a completion, a watch or a recovery the cursor that fetches
 * more — because in some hosts the text is all a model sees and a held rendering
 * keeps only its first few hundred characters (§10.6). Ambient segments (digests,
 * screens, control, notes, human input) reach open channels only; digests and
 * screens carry `supersedes`, never deltas: at most one per cadence per subject.
 *
 * Lifecycle segments are rebuilt from the journal alone for catch-up and channel
 * history (`scanLifecycle`, `replayNewest`), for any life of a name and for a
 * history-only session, so a completion is never lost because nobody was
 * following the session when it happened (G22, G28). Channel history is bounded
 * (HISTORY_MAX_EVENTS) and says when it stopped short; a catch-up that starts
 * inside a retention gap says what range is gone.
 */
import { cellWidth, cleanLine } from './ansi.js';
import { clocks } from './clock.js';
import type { Journal } from './journal.js';
import type { RunOutput } from './runindex.js';
import { cutPlumbing } from './plumbing.js';
import { looksLikeSecretPrompt } from './session.js';
import { safeCut, tailStart, unfinishedSequence } from './text.js';
import { headOnlyText } from './regex.js';
import { project } from './transcript.js';
import { DEFAULT_GEOMETRY, type EventOf, type GapReason, type JournalEvent, type OutputStream, type Principal, type RunInfo, type ScreenSnapshot, type Seq } from './types.js';

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
  /** When it happened: the journal event's time for a lifecycle segment, a note or a seat change; when it was built for a digest, a screen or human input. */
  ts: number;
  /** `<session>~<epoch>:<kind>:<seq>`, a digest's with `~<runId>` after the kind; the lane qualifies it with the node (§10.2, see segmentId). */
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
  /** How long the Run has run so far, by the session's one rule (Session.runDurationMs); undefined for a Run the source does not hold. */
  runDurationMs(runId: string): number | undefined;
}

export interface SegmenterOptions {
  /** Ambient digest cadence per subject (ms); also the most often a full-screen program's screen is sent. */
  cadenceMs?: number;
  /** Settle after a Run's end before its message is built (lets the prompt land). */
  runSettleMs?: number;
  /** Quiet period before a full-screen program's screen is sent. */
  screenQuietMs?: number;
  /** A screen that keeps changing is sent at most this long after its first unsent change (never starved, m2-13), though never more often than the cadence after the first. */
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
 * A message's stable id: `<session>~<epoch>:<kind>:<seq>`, which the lane qualifies with the
 * node. The journal's epoch is kept across lives and restarts, so replayed messages keep their
 * ids (G22), and is new when a forgotten name starts `seq` over, so an id never names two
 * events (mcpl-4). A qualifier may follow the kind, `<kind>~<qualifier>`, where one seq can carry
 * two segments of the kind: a Run's progress digest carries the Run's id (two Runs in one session,
 * each printing a line and going quiet, had digests at the same journal seq and so the same id,
 * and the lane's sent-set dropped the second as a repeat: the house's review of #11), and a
 * screen its ordinal (a screen that differed from the last only in what the emulator had dropped,
 * at the same seq, repeated its id and was dropped the same way: the house's read of 78c4d6e, #22).
 */
export function segmentId(session: string, journal: Journal, kind: SegmentKind, seq: Seq, qualifier?: string): string {
  return `${session}~${journal.epoch}:${kind}${qualifier !== undefined ? `~${qualifier}` : ''}:${seq}`;
}

/**
 * The seq a message id reports, when it is one of this journal's: the id as `segmentId` made it
 * (the lane strips its node first), with this session's name and this journal's epoch in front
 * of the kind and the seq. Read from the suffix's shape alone, an id of another session, of
 * another node, or of a forgotten life of this name passed as a cursor into this journal, which
 * the epoch exists to rule out (mcpl-4; the house's read of 78c4d6e, #22).
 */
export function seqOfMessageId(id: string, session: string, journal: Pick<Journal, 'epoch'>): Seq | undefined {
  const prefix = `${session}~${journal.epoch}:`;
  if (!id.startsWith(prefix)) return undefined;
  const m = /^[a-z-]+(?:~[^:]+)?:(\d+)$/.exec(id.slice(prefix.length));
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
  const at = columnIndex(row, snap.cursor.x);
  if (row.slice(at).trim()) return undefined; // the cursor is not at the end of what is written
  const before = row.slice(0, at).trim();
  if (before) return looksLikePrompt(before) ? before : undefined;
  const prev = snap.cursor.y > 0 ? (snap.lines[snap.cursor.y - 1] ?? '').trim() : '';
  return prev && ASKS.test(prev) ? prev : undefined;
}

/**
 * The index in a screen row's text of the cell column `x`. A combining mark takes no cell and a
 * wide character two, so a column is not a string index: `Café?` written decomposed, with the
 * cursor after it, was sliced one character short and read as no prompt (the house's read of 3eade8a, #22).
 * The widths are the emulator's (`cellWidth`, the table `cleanLine` lays a row out by).
 */
export function columnIndex(row: string, x: number): number {
  let col = 0;
  let i = 0;
  for (const ch of row) {
    const w = cellWidth(ch);
    if (col >= x && w > 0) break;
    col += w;
    i += ch.length;
  }
  return i;
}

/** A row's text up to the cursor's cell column. */
const beforeCursor = (snap: ScreenSnapshot) => {
  const row = snap.lines[snap.cursor.y] ?? '';
  return row.slice(0, columnIndex(row, snap.cursor.x));
};

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



/** The Run, or undefined when the source does not know it. */
export function runOf(src: { run(runId: string): RunInfo }, runId: string): RunInfo | undefined {
  try {
    return src.run(runId);
  } catch {
    return undefined;
  }
}

/**
 * The last `max` bytes of a text, from a line boundary when one lies in the first half of them
 * (text.ts's rule for every tail cut); a torn first line that is most of what there is stays, with a
 * leading `…` saying it is partial (the house's read of 3eade8a, #22: a torn line was dropped whatever
 * it left).
 */
export function tailBytes(text: string, max: number): string {
  const start = tailStart(text, max);
  if (start === 0) return text;
  return text[start - 1] === '\n' ? text.slice(start) : `…${text.slice(start)}`;
}

// ───────────── sources ─────────────

type Output = EventOf<'output'>;
type RunEnd = EventOf<'run.end'>;
type Recovered = EventOf<'recovered'>;
type SessionExit = EventOf<'session.exit'>;

/** Input read to render a Run of an earlier life or of history: its newest part (runOutput walks backwards). */
const HISTORY_RUN_INPUT_BYTES = 64 * 1024;

/** How a Run of history is rendered: the geometry to fall back on when the Run recorded none, and how much of its newest output is read. */
export interface HistoryRender {
  cols?: number;
  rows?: number;
  maxInputBytes?: number;
}

/**
 * A Run's text from the journal alone (the one renderer of history, for completions and for
 * results): the newest part of its attributed output, a shell Run's plumbing cut as the live
 * transcript cuts it — by the strategy, nonce and shell pid its run.start recorded, by shape for a
 * Run journaled before those were (the house's read of 39787b3, #22) — projected (§6) at the size the
 * Run started at when the journal recorded one, else the caller's.
 */
export async function journalRunText(o: RunOutput, how: HistoryRender = {}, run?: RunInfo): Promise<RunText> {
  const events = o.events.filter((e): e is Output => e.type === 'output');
  const chunks =
    run?.target === 'shell' && events.every((e) => e.stream === 'pty')
      ? [{ data: cutPlumbing(events.map((e) => e.data).join(''), { strategy: run.strategy, nonce: run.nonce, truncated: o.truncated, pid: run.shellPid !== undefined ? String(run.shellPid) : undefined }), stream: 'pty' as const }]
      : events.map((e) => ({ data: e.data, stream: e.stream }));
  const p = await project(chunks, { cols: run?.cols ?? how.cols ?? DEFAULT_GEOMETRY.cols, rows: run?.rows ?? how.rows ?? DEFAULT_GEOMETRY.rows, maxInputBytes: how.maxInputBytes ?? HISTORY_RUN_INPUT_BYTES, keep: 'tail' });
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
    runText: (runId) => o.transcript?.(runId) ?? journalRunText(o.journal.runs.output(o.journal, runId, { maxBytes: HISTORY_RUN_INPUT_BYTES }), { ...(o.cols !== undefined ? { cols: o.cols } : {}) }, runOf({ run: (id) => (o.run ? o.run(id) : o.journal.runs.run(id)) }, runId)),
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

  /** `qualifier` goes after the kind in the id (a digest's Run, a screen's ordinal; see segmentId). */
  base(kind: SegmentKind, seq: Seq, extra: Record<string, unknown> = {}, ts = Date.now(), qualifier?: string): Pick<Segment, 'kind' | 'seq' | 'ts' | 'messageId' | 'metadata'> {
    const meta: Record<string, unknown> = { session: this.src.id, state: this.src.state, controller: this.src.controller };
    if (this.src.cwd !== undefined) meta.cwd = this.src.cwd;
    return { kind, seq, ts, messageId: segmentId(this.src.id, this.src.journal, kind, seq, qualifier), metadata: { ...meta, ...extra } };
  }

  async run(ev: RunEnd): Promise<Segment | undefined> {
    const run = runOf(this.src, ev.runId);
    if (!run) return undefined;
    // A read that fails still reports the Run's own range, and the body says the output is missing
    // rather than looking like a Run that printed nothing (the house's read of 3eade8a, #22).
    let unreadable: string | undefined;
    const from = run.seq.start ?? run.seq.admit;
    const t = await this.src.runText(ev.runId).catch((e: unknown): RunText => {
      unreadable = e instanceof Error ? e.message : String(e);
      return { text: '', seq: [from, ev.seq], nextCursor: ev.seq, truncated: false };
    });
    let body = t.text;
    const cut = Buffer.byteLength(body) > RUN_BODY_BYTES;
    if (cut) body = tailBytes(body, RUN_BODY_BYTES);
    // The transcript may already be the newest part of a longer output: the omission is said either way.
    if (cut || t.truncated) body = `[… earlier output omitted · read runId=${ev.runId} for all of it]\n${body}`;
    if (unreadable !== undefined) body = `[the Run's output could not be read: ${oneLine(unreadable, 160)} · read runId=${ev.runId} to try again]`;
    const status =
      ev.state === 'exited'
        ? ev.signal
          ? `→ killed by ${ev.signal}`
          : `→ exit ${ev.exit ?? '?'}`
        : ev.state === 'cancelled'
          ? `→ cancelled${ev.signal ? ` by ${ev.signal}` : ev.exit !== undefined ? ` (exit ${ev.exit})` : ''}`
          : `→ outcome unknown (${ev.reason ?? 'lost'})`;
    const who = run.origin === 'self' || run.origin === 'system' ? '' : ` · by ${run.principal}`;
    // A process Run that left its group behind says so (shell tools 5 of the house's review of #11).
    const left = ev.leftovers ? ' · left processes running (cancel the Run to end them)' : '';
    // A journal written before durations were measured on the monotonic clock can hold a negative one (a wall-clock step back).
    const durationMs = Math.max(0, ev.durationMs);
    const head = `[terminal] ${this.src.id}: \`${describeRun(run)}\` ${status} in ${fmtDuration(durationMs)}${who}${left} · run ${ev.runId} · read since=${Math.max(0, t.seq[0] - 1)}`;
    // The origin facet and the chat:from-* sender tag are relative to the reader; the lane adds them.
    const tags = [ev.state === 'lost' ? 'terminal:run-lost' : 'terminal:run-finished', `terminal:target=${run.target}`];
    if (ev.signal) tags.push('terminal:exit=signal');
    // An end mark without a status (`→ exit ?`) is neither ok nor nonzero: no exit tag.
    else if (ev.state === 'exited' && ev.exit !== undefined) tags.push(`terminal:exit=${ev.exit === 0 ? 'ok' : 'nonzero'}`);
    const meta: Record<string, unknown> = { runId: ev.runId, runState: ev.state, target: run.target, principal: run.principal, durationMs, outputFrom: t.seq[0], outputTo: t.seq[1], nextCursor: t.nextCursor };
    if (ev.exit !== undefined) meta.exit = ev.exit;
    if (ev.signal) meta.signal = ev.signal;
    if (ev.reason) meta.reason = ev.reason;
    if (ev.leftovers) meta.leftovers = true;
    if (cut || t.truncated) meta.truncated = true;
    if (unreadable !== undefined) meta.outputError = unreadable;
    if (run.line !== undefined) meta.line = run.line;
    const seg: Segment = { ...this.base('run', ev.seq, meta, ev.ts), lifecycle: true, tags, head, interested: [run.principal], runId: ev.runId, author: run.principal };
    if (body) seg.body = body;
    return seg;
  }

  service(ev: EventOf<'service'>): Segment {
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

  watch(ev: EventOf<'watch.fired'>): Segment {
    const what = ev.kind === 'pattern' ? `matched: ${oneLine(ev.line ?? ev.match ?? '', 160)}` : ev.kind === 'silence' ? (ev.match ?? 'output went quiet') : 'the shell is available';
    // `clipped`: the line was longer than the pattern's match window and matched on its head; carried
    // to the reader, as the hit and waitFor's result carry it (the house's read of the 36 commits, #22).
    const clip = ev.clipped ? ` (${headOnlyText()})` : '';
    return {
      ...this.base('watch', ev.seq, { watchId: ev.watchId, label: ev.label, watchKind: ev.kind, match: ev.match, at: ev.at, ...(ev.clipped ? { clipped: true } : {}) }, ev.ts),
      lifecycle: true,
      tags: [`terminal:watch=${ev.label}`, 'terminal:watch', `terminal:${ev.kind}`],
      head: `[terminal] ${this.src.id}: watch "${oneLine(ev.label, 60)}" fired · ${what}${clip}${ev.suppressed ? ` (+${ev.suppressed} more)` : ''} · read since=${Math.max(0, ev.at - 1)}`,
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

  waiting(ev: EventOf<'run.waiting'>): Segment | undefined {
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
  note(ev: EventOf<'note'>): Segment {
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

export type LifecycleEvent = EventOf<'run.end' | 'service' | 'watch.fired' | 'session.exit' | 'recovered' | 'run.waiting' | 'note'>;

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
  /**
   * Seqs the scan found gone (retention, or a hole a cold-store failure left): a catch-up from an old
   * cursor over a small memory ring returned a handful of completions as if they were all (the house's
   * read of 3eade8a, #22). Every page's gap is kept, not only the first page's, so a hole in a later
   * page is not silently skipped (the house's read of the 36 commits, #22, comment 6269992150), and so
   * is every gap event the journal recorded; each range is clipped to the scan, in seq order, with its
   * reason (see `goneRanges`).
   */
  lost?: Gone[];
}

/** A range of seqs a scan found gone, and why. */
export interface Gone {
  from: Seq;
  to: Seq;
  reason: GapReason;
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

  // The holes the journal recorded as gap events, and those only a page's read reported.
  const recorded: Gone[] = [];
  const inferred: Gone[] = [];
  for (const page of src.journal.pages(since, SCAN_PAGE)) {
    // Every page's gap, not only the first: a hole a cold-store failure left is reported as the gap of
    // the later page that starts inside it, and dropping it moved the catch-up past the hole with no
    // notice (the house's read of the 36 commits, #22, comment 6269992150).
    if (page.gap) inferred.push({ from: page.gap.from, to: page.gap.to, reason: page.gap.reason });
    const events = page.events;
    if (!events.length) break;
    for (const ev of events) {
      if (ev.seq > end) break;
      // A hole the journal recorded as an event: a failing store's, once it recovered, which no page
      // reports as a gap then, since the events after it are on disk again.
      if (ev.type === 'gap') recorded.push({ from: ev.from, to: ev.to, reason: ev.reason });
      else if (LIFE_EVENTS.has(ev.type)) {
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
    // Nothing past `end` (what the journal held when the scan began) is this scan's; the pages yield between.
    if (events[events.length - 1]!.seq >= end || !page.more) break;
    await yieldTurn();
  }
  for (const t of tentative) commit(t);
  trim();
  const out: LifecycleScan = { picked: kept, end };
  if (omitted) out.omitted = omitted;
  const gones = goneRanges(recorded, inferred, since + 1, end);
  if (gones.length) out.lost = gones;
  return out;
}

/**
 * The ranges a scan of [`from`, `to`] found gone, in seq order, each clipped to the scan: a page read
 * while the ring dropped events can report a gap past the scan's end, where the lane would pin its
 * summary (the house's read of the 38 commits, #22, comment 6274773484). Each keeps its reason: a gap
 * event's own, and retention for what only a page reported (a page cannot tell why a hole is there)
 * where no recorded gap covers it, as a read reports it (`uncovered` in the reader); the catch-up
 * summary called every range past retention (a reviewer's read of the fixes for #22). Ranges of one
 * reason that overlap or touch are one, so a hole reported both as a page's gap and as the journal's
 * gap event is named once.
 */
function goneRanges(recorded: Gone[], inferred: Gone[], from: Seq, to: Seq): Gone[] {
  const clip = (g: Gone): Gone[] => {
    const f = Math.max(g.from, from);
    const t = Math.min(g.to, to);
    return f > t ? [] : [{ from: f, to: t, reason: g.reason }];
  };
  const known = recorded.flatMap(clip);
  let rest = inferred.flatMap(clip);
  for (const r of known) rest = rest.flatMap((p) => (r.to < p.from || r.from > p.to ? [p] : [...(r.from > p.from ? [{ ...p, to: r.from - 1 }] : []), ...(r.to < p.to ? [{ ...p, from: r.to + 1 }] : [])]));
  const out: Gone[] = [];
  for (const g of [...known, ...rest].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = out[out.length - 1];
    if (last && last.reason === g.reason && g.from <= last.to + 1) last.to = Math.max(last.to, g.to);
    else out.push({ ...g });
  }
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
  /** The Run's start on the monotonic clock, which a digest's elapsed time is measured from. */
  startMono: number;
  /** A process Run's output is its pipes, which the terminal never shows; a shell Run's is the pty. */
  pipes: boolean;
  bytes: number;
  /** The count began when the segmenter did, after some output it could only read bounded (a Run already in flight). */
  bytesAtLeast: boolean;
  bytesAtLastDigest: number;
  lastDigestId?: string;
  timer?: NodeJS.Timeout | undefined;
  silenceTimer?: NodeJS.Timeout | undefined;
  askedAtSeq?: Seq;
  /** The last complete output lines, cleaned (er-3: a digest never reads the journal). */
  lines: string[];
  /** Raw text after the last newline, capped. */
  carry: string;
  /**
   * (seq, bytes through it) checkpoints, for "new since your last read" without reading the
   * journal. Bytes *through* an event, and the newest mark always kept: with "bytes before" and
   * every other mark dropped, a read whose mark was gone counted from a later one and came up
   * short, to zero when the newest had gone (the house's read of 3eade8a, #22).
   */
  marks: Array<[Seq, number]>;
}

interface Submitted {
  text: string;
  seq: Seq;
  sensitive: boolean;
  /** The text was on the screen after its prompt when Enter was pressed (the program echoed it). */
  echoed: boolean;
  /** The line it answered asked for a secret. */
  secretPrompt: boolean;
  /** What the screen showed before the line's first keystroke: the program's prompt. */
  prompt: string;
  /** The line met a cursor, history or completion key, so what was typed is not what was submitted. */
  unknown: boolean;
}

interface HumanLine {
  principal: Principal;
  /** The line being edited, with BS/DEL, ^U, ^W and ^C applied (m2-22). */
  buf: string;
  bufSensitive: boolean;
  bufSeq: Seq;
  /**
   * A cursor, history or completion key was pressed since the line was last empty: readline
   * applied it to text this reconstruction does not have (a recalled line, a completed path), so
   * the text is not shown (the house's read of 3eade8a, #22).
   */
  bufUnknown: boolean;
  /** What the screen showed before the line's first keystroke: the program's prompt. */
  prompt: string;
  /** An escape sequence being skipped, across input events (arrows, SS3 keys). */
  esc: '' | 'esc' | 'csi' | 'ss3' | 'osc' | 'osc-esc';
  lines: Submitted[];
  /** When the first line of the burst was submitted, on the monotonic clock. */
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
const NOT_RECONSTRUCTED = '[input edited with cursor, history or completion keys — not shown]';
/** Output of a Run already in flight when the segmenter starts is counted from a bounded read. */
const INFLIGHT_COUNT_BYTES = 1024 * 1024;

/**
 * The live segmenter: builds segments as its session's journal grows, for the lanes subscribed to
 * it. Its timers and cadences run on the monotonic clock: a wall-clock step scheduled a screen a
 * minute out and showed a Run's age as negative (the house's read of 3eade8a, #22).
 */
export class Segmenter {
  private readonly listeners = new Set<(s: Segment) => void>();
  private readonly off: () => void;
  private readonly running = new Map<string, RunWatch>();
  /** Completions waiting out the settle, by run.end seq; emitted, never dropped, on dispose (mcpl-6). */
  private readonly settling = new Map<Seq, Settling>();
  /**
   * Segments built while an earlier completion settles, waiting for it: segments go out in seq
   * order, so a cursor a reader advances to a later message never passes a completion that is
   * still being built. A note journaled after a Run's end went out first, and a lane that then
   * died would have lost the completion to its catch-up (the house's read of 3eade8a, #22).
   */
  private readonly deferred: Segment[] = [];
  private readonly o: Required<SegmenterOptions>;
  private readonly render: Render;
  private screenTimer: NodeJS.Timeout | undefined;
  private screenAt: number | undefined;
  /** When the screen first changed since the last one sent (a max-wait, m2-13); monotonic. */
  private screenDirtySince: number | undefined;
  /** The first screen of a full-screen program is not held to the cadence. */
  private firstScreenPending = false;
  /** Monotonic; negative infinity until a screen was sent, so the first is never held to a cadence from zero. */
  private lastScreenAt = Number.NEGATIVE_INFINITY;
  private lastScreenId: string | undefined;
  /** Screens sent in this segmenter's life: each screen's id carries its ordinal (see segmentId). */
  private screens = 0;
  /** The last screen's text; undefined when none was sent for this program, so a blank first frame is still a screen. */
  private lastScreenText: string | undefined;
  /** The emulator's dropped-unit count the last screen reported. */
  private lastScreenDropped = 0;
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
    // Runs already in flight when the segmenter starts get digests too, counting what they
    // printed before it, and a shell Run already sitting at a prompt gets its needs-input check
    // (the house's read of 3eade8a, #22: one waiting at `Name? ` got none, and counted from 0).
    for (const r of s.listRuns()) if (r.state === 'running') this.trackInflight(r);
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

  /**
   * Output bytes of a running Run after `read` (for "new since your last read"), or undefined when
   * it is not tracked. Exact while the mark for `read` is kept; when it was dropped, the count runs
   * from the last kept mark before it, so it is never short.
   */
  unreadBytes(runId: string, read: Seq): number | undefined {
    const w = this.running.get(runId);
    if (!w) return undefined;
    let through = 0;
    for (const [seq, bytes] of w.marks) {
      if (seq > read) break;
      through = bytes;
    }
    return w.bytes - through;
  }

  private emit(seg: Segment | undefined): void {
    if (!seg || this.disposed) return;
    if (this.behindSettling(seg)) {
      this.deferred.push(seg);
      return;
    }
    this.send(seg);
  }

  /** Is a completion with an earlier seq (or this one, for another kind at the same seq) still settling? */
  private behindSettling(seg: Segment): boolean {
    for (const seq of this.settling.keys()) if (seg.seq > seq || (seg.seq === seq && seg.kind !== 'run')) return true;
    return false;
  }

  /** A completion went out: what waited behind it follows, in seq order, up to the next one settling. */
  private release(): void {
    this.deferred.sort((a, b) => a.seq - b.seq);
    while (this.deferred.length && !this.behindSettling(this.deferred[0]!)) this.send(this.deferred.shift()!);
  }

  private send(seg: Segment): void {
    if (this.disposed) return;
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
            this.release();
            resolve();
          });
      },
    };
    const timer = setTimeout(e.fire, this.o.runSettleMs);
    this.settling.set(ev.seq, e);
  }

  private track(runId: string): RunWatch | undefined {
    if (this.running.has(runId) || this.disposing) return undefined;
    const run = runOf(this.s, runId);
    // The digests count the Run's elapsed time on the monotonic clock, so a step neither stops it nor jumps it
    // (comment 6274773484), from the session's own measure of the time so far: a Run already in flight when the
    // segmenter began was dated from the wall-clock age of its journaled start, which a step back before then
    // clamped to zero while the result said minutes (a reviewer's read of the fixes for #22).
    const startMono = clocks.monotonic() - (this.s.runDurationMs(runId) ?? 0);
    const w: RunWatch = { runId, startMono, pipes: run?.target === 'process', bytes: 0, bytesAtLeast: false, bytesAtLastDigest: 0, lines: [], carry: '', marks: [] };
    this.running.set(runId, w);
    w.timer = setInterval(() => this.digest(w), this.o.cadenceMs);
    return w;
  }

  /** Track a Run that was already running: count its output so far (bounded), feed its last lines, arm needs-input. */
  private trackInflight(run: RunInfo): void {
    const w = this.track(run.runId);
    if (!w) return;
    let out: RunOutput | undefined;
    try {
      out = this.s.journal.runs.output(this.s.journal, run.runId, { maxBytes: INFLIGHT_COUNT_BYTES });
    } catch {
      return; // nothing journaled for it yet
    }
    for (const ev of out.events) {
      if (ev.type !== 'output') continue;
      w.bytes += Buffer.byteLength(ev.data);
      if (!this.alt || w.pipes) this.feedLines(w, ev.data, ev.stream);
    }
    w.bytesAtLeast = out.truncated;
    if (out.events.length) w.marks.push([out.events[out.events.length - 1]!.seq, w.bytes]);
    if (!w.pipes) w.silenceTimer = setTimeout(() => this.checkNeedsInput(w), this.o.needsInputMs);
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
    w.bytes += Buffer.byteLength(ev.data);
    w.marks.push([ev.seq, w.bytes]);
    if (w.marks.length > MARKS_MAX) w.marks = w.marks.filter((_, i) => i % 2 === 0 || i === w.marks.length - 1);
    // A full-screen program's redraws are not lines; its screens are the message. A process Run's
    // pipes are not drawn on the terminal at all, so a full-screen program hides nothing of theirs.
    if (!this.alt || w.pipes) this.feedLines(w, ev.data, ev.stream);
    // Needs-input: a shell Run that goes silent with a prompt-like last line (G15).
    if (ev.stream === 'pty') {
      if (w.silenceTimer) clearTimeout(w.silenceTimer);
      w.silenceTimer = setTimeout(() => this.checkNeedsInput(w), this.o.needsInputMs);
    }
  }

  /**
   * Keep the Run's last lines as output arrives, so a digest costs what it shows (er-3, mcpl-11,
   * m2-17). A process Run's stdout and stderr are one source, as the transcript reads them (§6
   * rule 6): `abc` on stdout then `def\n` on stderr is the line `abcdef`, not two lines.
   */
  private feedLines(w: RunWatch, data: string, _stream: OutputStream): void {
    let buf = w.carry + data;
    const nl = buf.lastIndexOf('\n');
    if (nl !== -1) {
      const fresh: string[] = [];
      let end = nl;
      // Only the newest lines can survive, so read back from the end until there are enough. A
      // newline at index 0 ends an empty first line, and a search before index 0 must find nothing:
      // `lastIndexOf('\n', -1)` would search from 0 (the house's read of 3eade8a, #22).
      while (end >= 0 && fresh.length < DIGEST_LINES) {
        const start = end > 0 ? buf.lastIndexOf('\n', end - 1) : -1;
        const line = cleanLine(buf.slice(start + 1, end)).trimEnd();
        if (line) fresh.push(line);
        if (start < 0) break;
        end = start;
      }
      this.pushLines(w, fresh.reverse());
      buf = buf.slice(nl + 1);
    }
    if (buf.length > CARRY_MAX) {
      // A line that never ends (a progress bar): what follows its last carriage return is what shows.
      // The cut lands on a safe boundary, never inside a control sequence or a surrogate pair (the
      // house's read of 78c4d6e, #22: a digest began with a lone low surrogate, another with `;5;196m`).
      const cr = buf.lastIndexOf('\r', buf.length - 2);
      buf = buf.slice(safeCut(buf, cr !== -1 && buf.length - cr - 1 <= CARRY_MAX ? cr + 1 : buf.length - CARRY_MAX));
    }
    w.carry = buf;
  }

  private pushLines(w: RunWatch, lines: string[]): void {
    for (const l of lines) if (l) w.lines.push(l);
    if (w.lines.length > DIGEST_LINES) w.lines.splice(0, w.lines.length - DIGEST_LINES);
  }

  private digest(w: RunWatch): void {
    const run = runOf(this.s, w.runId);
    if (!run || w.bytes === w.bytesAtLastDigest || (this.alt && !w.pipes) || this.disposing) return;
    // A carry that ends inside a control sequence is held until the sequence completes: what it does
    // to the line is not known yet, and its payload is not text (the house's read of 78c4d6e, #22:
    // `working ESC [ 3` showed as `working [3` until the next read). A Run's end does not release it:
    // the watch goes with the Run, and nothing is lost, since the completion renders the Run's text
    // from the journal, not from these lines (the house's read of the 38 commits, #22, comment 6274773484).
    const partial = unfinishedSequence(w.carry) < w.carry.length ? '' : cleanLine(w.carry).trimEnd();
    const tail = (partial ? [...w.lines, partial] : w.lines).slice(-DIGEST_LINES).join('\n');
    const seq = this.s.journal.lastSeq;
    const elapsed = Math.max(0, Math.round(clocks.monotonic() - w.startMono));
    const seg: Segment = {
      ...this.render.base('output', seq, { runId: w.runId, bytes: w.bytes, ...(w.bytesAtLeast ? { bytesAtLeast: true } : {}), elapsedMs: elapsed, nextCursor: seq }, Date.now(), w.runId),
      lifecycle: false,
      tags: ['terminal:output', 'terminal:running'],
      head: `[terminal] ${this.s.id}: running \`${describeRun(run)}\` ${fmtDuration(elapsed)} · ${w.bytesAtLeast ? 'at least ' : ''}${fmtBytes(w.bytes)} so far · run ${w.runId}`,
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
      // A new program's first frame is news even when blank (the house's read of 3eade8a, #22).
      this.lastScreenText = undefined;
      this.scheduleScreen();
      return;
    }
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.screenTimer = undefined;
    this.screenAt = undefined;
    this.screenDirtySince = undefined;
    // What a full-screen program drew is not lines of output; a process Run's pipes it never touched.
    for (const w of this.running.values()) {
      if (w.pipes) continue;
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
    const now = clocks.monotonic();
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
    // Dropped output is part of what a screen says (G11): a compaction that left the visible text
    // as it was still ends the last screen's claim to be exact (the house's read of 39787b3, #22).
    if (text === this.lastScreenText && (snap.droppedUnits ?? 0) === this.lastScreenDropped) return;
    this.lastScreenText = text;
    this.lastScreenDropped = snap.droppedUnits ?? 0;
    this.lastScreenAt = clocks.monotonic();
    this.firstScreenPending = false;
    // Output the emulator dropped under pressure is part of what the screen does not show (§6).
    const dropped = snap.droppedUnits ? ` · ${snap.droppedUnits} output units were dropped under pressure, so the screen may be incomplete` : '';
    // Its own ordinal in the id: a screen that differs from the last only in what was dropped, or one
    // taken between a compaction and the parse of the kept batch, is at the same seq as the last.
    const seg: Segment = {
      ...this.render.base('screen', snap.seq, { cols: snap.cols, rows: snap.rows, ...(snap.droppedUnits ? { droppedUnits: snap.droppedUnits } : {}) }, Date.now(), String(++this.screens)),
      lifecycle: false,
      tags: ['terminal:screen'],
      head: `[terminal] ${this.s.id}: full-screen program${snap.title ? ` "${oneLine(snap.title, 60)}"` : ''} · screen at seq ${snap.seq}${dropped} (screen session=${this.s.id} for the current one)`,
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
  private onInput(ev: EventOf<'input'>): void {
    if (ev.kind === 'protocol-reply' || !ev.principal.startsWith('human:') || this.alt || this.disposing) return;
    let h = this.human.get(ev.principal);
    if (!h) {
      h = { principal: ev.principal, buf: '', bufSensitive: false, bufUnknown: false, bufSeq: ev.seq, prompt: '', esc: '', lines: [] };
      this.human.set(ev.principal, h);
    }
    h.bufSeq = ev.seq;
    // A line's first keystroke is journaled before the program sees it: the cursor row is its prompt.
    if (!h.buf && !h.bufUnknown) h.prompt = this.cursorRow();
    if (ev.sensitive) {
      // Journaled as a placeholder (G26); whatever it was, it is a sensitive answer.
      h.bufSensitive = true;
      this.submit(h, ev.seq);
    } else this.edit(h, ev.data, ev.seq);
    if (h.timer) clearTimeout(h.timer);
    h.timer = undefined;
    const now = clocks.monotonic();
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
      // Arrows, Home/End, Up for history: the editor applied them to text not reconstructed here.
      if (ch === '\x1b') {
        h.esc = 'esc';
        h.bufUnknown = true;
      } else if (ch === '\r' || ch === '\n') this.submit(h, seq);
      else if (ch === '\x7f' || ch === '\b') h.buf = [...h.buf].slice(0, -1).join('');
      else if (ch === '\x15') {
        h.buf = ''; // ^U: the line is empty again, whatever it held
        h.bufUnknown = false;
      } else if (ch === '\x17') h.buf = h.buf.replace(/\S*\s*$/, ''); // ^W
      else if (ch === '\x03') {
        h.buf = ''; // ^C abandons the line
        h.bufSensitive = false;
        h.bufUnknown = false;
      } else if (ch >= ' ') h.buf += ch;
      // Tab completion, ^A/^E/^B/^F, ^P/^N/^R history, ^K/^Y, ^T: the line changed in ways not seen here.
      else h.bufUnknown = true;
    }
  }

  private submit(h: HumanLine, seq: Seq): void {
    const text = h.buf;
    const sensitive = h.bufSensitive;
    const unknown = h.bufUnknown;
    h.buf = '';
    h.bufSensitive = false;
    h.bufUnknown = false;
    // An empty buffer under a history or completion key is a line this reconstruction never saw
    // (Up then Enter recalls one): reported as not shown (the house's read of 39787b3, #22).
    if (!text.trim() && !sensitive && !unknown) return;
    const snap = this.s.snapshot();
    h.lines.push({ text, seq, sensitive, echoed: !sensitive && !unknown && echoedOn(snap, h.prompt, text, 0), secretPrompt: looksLikeSecretPrompt(h.prompt), prompt: h.prompt, unknown });
    h.prompt = this.cursorRow();
  }

  private cursorRow(): string {
    try {
      return beforeCursor(this.s.snapshot());
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
    if (!h.buf && !h.esc && !h.bufUnknown) this.human.delete(h.principal);
    const snap = this.s.snapshot();
    const ran = this.executedLines(h.principal, lines);
    const shown: string[] = [];
    lines.forEach((l, i) => {
      if (ran.has(i)) return;
      if (l.sensitive || l.secretPrompt) shown.push(SENSITIVE);
      else if (l.unknown) shown.push(NOT_RECONSTRUCTED);
      else if (l.echoed || echoedOn(snap, l.prompt, l.text, 3)) shown.push(oneLine(l.text, 200));
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

  /**
   * Which of the lines became this human's commands (the Run's end is their message): the Runs
   * of their own that were admitted after a line and started before the next one. Lines pasted
   * in one input event share a seq, so a group of n such lines takes the first n Runs started
   * after it. Only the typer's Runs count: another principal's Run admitted after an `exit()`
   * typed into a REPL hid the line (the house's read of 3eade8a, #22).
   */
  private executedLines(principal: Principal, lines: Submitted[]): Set<number> {
    const ran = new Set<number>();
    for (let i = 0; i < lines.length; ) {
      const seq = lines[i]!.seq;
      let j = i;
      while (j < lines.length && lines[j]!.seq === seq) j++;
      const next = lines[j]?.seq;
      const starts = this.recentStarts.filter((st) => {
        if (!(st.seq > seq && (next === undefined || st.seq < next))) return false;
        const run = runOf(this.s, st.runId);
        return run !== undefined && run.seq.admit > seq && run.principal === principal;
      });
      for (let k = i; k < Math.min(j, i + starts.length); k++) ran.add(k);
      i = j;
    }
    return ran;
  }
}

/**
 * Did the program echo `text` after `prompt`: does a row near the cursor end with the prompt
 * followed by the text (wrapped rows joined)? (The house's read of 3eade8a, #22.) `extra` rows above the ones the line would span,
 * for a check made after the program moved on.
 */
function echoedOn(snap: ScreenSnapshot, prompt: string, text: string, extra: number): boolean {
  const t = text.trim();
  if (!t) return false;
  const want = `${prompt}${text}`.trim();
  const span = Math.ceil(want.length / Math.max(1, snap.cols)) + 1 + extra;
  const rows = snap.lines.slice(Math.max(0, snap.cursor.y - span), snap.cursor.y + 1);
  if (extra === 0) rows[rows.length - 1] = beforeCursor(snap);
  return rows.some((r) => r.trimEnd().endsWith(want)) || rows.join('').trimEnd().endsWith(want);
}
