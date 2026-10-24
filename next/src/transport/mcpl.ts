/**
 * The MCPL lane (§10), one per connection. It holds the grant and the enabled
 * feature sets, registers the principal's visible sessions as channels, and
 * delivers the session segmenter's messages: on an open channel everything
 * flows as channels/incoming; on a closed one only lifecycle messages flow, as
 * push/event, and only to principals with explicit interest — Runs they
 * started, Watches and Services they set up, sessions they own (G28). A Run's
 * completion is withheld from the principal whose synchronous call returns it:
 * held while that call may still return, released if it never did (mcpl-1).
 * Catch-up after a reconnect resumes from the principal's `delivered` cursor
 * (G22), which never passes a message still owed to it, and covers history-only
 * sessions too: a Run lost at a daemon restart is a completion like any other.
 *
 * `channels/publish` records what the agent said as a note in the session's
 * journal, visible to observers; it never types into the terminal. Hosts route
 * an agent's ordinary speech to the channel that woke it, so publish-as-typing
 * would execute prose. Typing is `input` or `run`, always explicit (G25).
 */
import * as os from 'node:os';
import { capabilityGranted, deriveFeatureSets, grantFromUpdate, withRevision, type CapabilityGrantState, type FeatureSetDeclaration, type FeatureSetsUpdateParams } from '@animalabs/mcpl-core';
import type { App, Caller } from '../api/app.js';
import { presence } from '../api/presence.js';
import { describeGap } from '../api/reader.js';
import type { AnySession, HistorySession } from '../api/registry.js';
import { CORE_TOOLS, TOOLS, type Tier } from '../api/tools.js';
import { clocks } from '../core/clock.js';
import { TermError } from '../core/errors.js';
import type { Journal } from '../core/journal.js';
import {
  countOmitted,
  fmtBytes,
  isDone,
  journalSource,
  liveSource,
  renderPicked,
  replayNewest,
  runOf,
  scanLifecycle,
  segmentId,
  seqOfMessageId,
  type Gone,
  type LifecycleEvent,
  type LifecycleScan,
  type Omitted,
  type Picked,
  type ReplaySource,
  type Segment,
  type SegmentKind,
  type Segmenter,
} from '../core/segmenter.js';
import { serviceOutcomeKey, type Session } from '../core/session.js';
import { lineBytes } from '../core/stores.js';
import type { GapReason, JournalEvent, Principal, RunInfo, Seq } from '../core/types.js';
import { CAPABILITY_DENIED, CHANNEL_NOT_PERMITTED, INTERNAL, INVALID_PARAMS, OVERLOADED, RpcError, UNKNOWN_CHANNEL, type Outbound } from './jsonrpc.js';

/**
 * The node part of message ids and channel addresses: `TSM_NODE`, else the machine's
 * name (mcpl-4: never 'local' everywhere). Two daemons on one machine stay apart
 * through the journal epoch every id carries (§10.2).
 */
export const NODE_NAME = nodeName();

function nodeName(): string {
  const configured = process.env.TSM_NODE?.trim();
  if (configured) return configured;
  const host = (os.hostname().split('.')[0] ?? '').replace(/[^A-Za-z0-9_-]/g, '-');
  return host || 'local';
}

const TAG_ONTOLOGY = {
  coreTags: ['chat:from-human', 'chat:from-agent', 'chat:from-self'],
  tags: {
    'terminal:run-finished': { desc: 'A Run ended with an observed outcome (exit code or signal in metadata)', facet: 'lifecycle' },
    'terminal:run-lost': { desc: 'A Run ended without an observed outcome (reason in metadata)', facet: 'lifecycle' },
    'terminal:session-exited': { desc: "The session's shell exited", facet: 'lifecycle' },
    'terminal:recovered': { desc: 'The daemon restarted; the keyed terminal:recovered=<class> says what survived', facet: 'lifecycle' },
    'terminal:needs-input': { desc: 'A running program may be waiting for input (heuristic; evidence in metadata)', facet: 'lifecycle' },
    'terminal:service-ready': { desc: 'A Service became ready (its readiness probes passed)', facet: 'lifecycle' },
    'terminal:service-unhealthy': { desc: 'A Service failed a probe or showed its fail pattern', facet: 'lifecycle' },
    'terminal:service-exited': { desc: "A Service's process ended", facet: 'lifecycle' },
    'terminal:service-running': { desc: 'A Service with no readiness probe stayed alive through its liveness window', facet: 'lifecycle' },
    'terminal:service-lost': { desc: "A Service's Run ended without an observed exit; its process may still run", facet: 'lifecycle' },
    'terminal:watch': { desc: 'A watch fired (the keyed terminal:watch=<label> names it)', facet: 'lifecycle' },
    'terminal:missed': { desc: 'Messages owed that were not delivered one by one: while you were away, past what a catch-up replays, or refused on delivery past the retry bound (a count and the cursor to read them)', facet: 'lifecycle' },
    'terminal:pattern': { desc: 'The firing watch matched a pattern', facet: 'watch' },
    'terminal:silence': { desc: 'The firing watch saw output stop', facet: 'watch' },
    'terminal:idle': { desc: 'The firing watch saw the shell become available', facet: 'watch' },
    'terminal:human-input': { desc: 'A human typed into a program in the session', facet: 'sender' },
    'terminal:note': { desc: 'A note a principal published on the channel (never typed into the terminal)', facet: 'sender' },
    'terminal:output': { desc: 'Progress digest of a running command (supersedes the previous one)', facet: 'ambient' },
    'terminal:running': { desc: 'The command is still running', facet: 'ambient' },
    'terminal:screen': { desc: 'The screen of a full-screen program (supersedes the previous one)', facet: 'ambient' },
    'terminal:control': { desc: 'The controller seat changed hands', facet: 'ambient' },
  },
  keyed: {
    'terminal:exit': { desc: 'how an ended Run ended', values: ['ok', 'nonzero', 'signal'] },
    'terminal:origin': { desc: 'who issued the Run, relative to the recipient', values: ['self', 'human', 'agent', 'system'] },
    'terminal:target': { desc: 'shell | process', values: ['shell', 'process'] },
    'terminal:watch': { desc: 'the firing watch’s label' },
    'terminal:recovered': { desc: 'what a daemon restart left of the session', values: ['continuous', 'reattached', 'history-only'] },
  },
  suggestedTreatment: [
    { tagsAny: ['terminal:needs-input', 'terminal:watch', 'terminal:session-exited', 'terminal:recovered', 'terminal:service-unhealthy', 'terminal:service-exited', 'terminal:service-lost'], behavior: 'immediate' },
    { tagsAny: ['terminal:run-finished', 'terminal:run-lost', 'terminal:service-ready', 'terminal:service-running', 'terminal:missed'], behavior: 'immediate' },
    // A person's typed line is held like ordinary output, not a wake: an agent sharing a terminal with someone in a
    // long interactive session would otherwise run inference on every line (Aster's call, 2026-10-24). A host that
    // wants it as a wake can key on `chat:from-human`, which the same message carries.
    { tagsAny: ['terminal:output', 'terminal:screen', 'terminal:control', 'terminal:note', 'terminal:human-input'], behavior: 'throttle' },
  ],
  open: true,
};

/** Feature sets (§10.5). `uses` is exhaustive and fail-closed (SPEC §6.4), so tool tiers need only `tools`. */
export const FEATURE_SETS = {
  // Named from the tool table, so the description cannot drift from the set (the house's read of 2f357bd, #22).
  'terminal.core': { description: `The ${CORE_TOOLS.length} core tools: ${CORE_TOOLS.join(', ')}`, uses: ['tools'] },
  'terminal.control': { description: 'signal, control (the seat), resize, session_env_capture', uses: ['tools'] },
  'terminal.services': { description: 'start: long-running commands with readiness and health probes', uses: ['tools'] },
  'terminal.watch': { description: 'watch, unwatch, watches, wait_for: patterns, silence and idle', uses: ['tools'] },
  'terminal.search': { description: 'search: a regex over output history with cursors', uses: ['tools'] },
  'terminal.live': {
    description: 'Push events for what concerns you: your Runs ending, your Services and Watches, needs-input, your sessions exiting',
    uses: ['pushEvents'],
    tagOntology: TAG_ONTOLOGY,
  },
  'terminal.channels': {
    description: 'Sessions as channels: while one is open, every message flows on it, including progress digests, screens, notes and human input',
    uses: ['channels.register', 'channels.lifecycle', 'channels.incoming'],
  },
  'terminal.annotate': { description: "What an agent says on a session's channel is recorded as a note for observers (never typed into the shell)", uses: ['channels.publish'] },
  'terminal.presence': { description: 'Before each inference, a short status of your sessions: what changed since you last read', uses: ['contextHooks.beforeInference.inject.beforeUser'] },
} as const;

const TIER_SET: Record<Tier, string | undefined> = {
  core: 'terminal.core',
  control: 'terminal.control',
  services: 'terminal.services',
  watch: 'terminal.watch',
  search: 'terminal.search',
  compat: undefined, // the 1.x names are for plain MCP hosts only
};

export const TOOL_FEATURE_SET: Record<string, string> = Object.fromEntries(
  TOOLS.filter((t) => TIER_SET[t.tier] !== undefined).map((t) => [t.name, TIER_SET[t.tier]!]),
);

const DECLARATIONS = FEATURE_SETS as unknown as Record<string, FeatureSetDeclaration>;

export function manifest(): Record<string, unknown> {
  return withRevision({
    version: '0.5',
    pushEvents: true,
    contextHooks: { beforeInference: { inject: { beforeUser: true } } },
    channels: { register: true, publish: true, incoming: true, lifecycle: true },
    featureSets: DECLARATIONS,
  } as never) as unknown as Record<string, unknown>;
}

export interface ChannelDescriptor {
  id: string;
  type: 'terminal';
  label: string;
  direction: 'bidirectional';
  address: { node: string; session: string };
  metadata: Record<string, unknown>;
  initiallyOpen: boolean;
  capabilities: { history: { maxMessages: number; supportsBeforeMessage: boolean } };
}

export const channelId = (session: string): string => `terminal:${session}`;
export const sessionOf = (id: string): string | undefined => (id.startsWith('terminal:') ? id.slice('terminal:'.length) : undefined);
const qualify = (id: string) => `${NODE_NAME}/${id}`;
/** The id without this node's name, when it carries it; another node's id is never ours (mcpl-4). */
const unqualify = (id: string): string | undefined => (id.startsWith(`${NODE_NAME}/`) ? id.slice(NODE_NAME.length + 1) : undefined);

interface IncomingMessage {
  channelId: string;
  messageId: string;
  author: { id: string; name: string };
  timestamp: string;
  content: Array<{ type: 'text'; text: string }>;
  metadata: Record<string, unknown>;
  tags: string[];
}

/** Per-request context the endpoint hands the lane. */
export interface LaneContext {
  /** False for notifications (no response will be written). */
  isRequest: boolean;
  /** Run `fn` after this request's response has been written (on a later macrotask). */
  after(fn: () => void): void;
}

const HISTORY_MAX = 500;
/** Messages a catch-up replays at most, newest first across sessions; the rest are summarised per session (ux-25). */
const CATCHUP_LIMIT = 20;
const BATCH_MS = 50;
/** How long a completion is held for a synchronous call that may still return it (G28, mcpl-1); checked every HOLD_POLL_MS. */
const HOLD_MS = 2000;
const HOLD_POLL_MS = 100;
/** Message ids remembered per connection so one message is delivered once (mcpl-8). */
const SENT_MAX = 4096;
/** The lane's retry cadence: 500 ms, doubling to 30 s against a host, or a store, that keeps failing. */
const retryDelay = (attempt: number): number => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));

/**
 * Notes (mcpl-5): small, a few a second per principal, and never more than a share of the
 * session's retention. The share counts bytes as the journal stores them — the whole event
 * line, about a hundred bytes more than the text — since that is what retention evicts
 * (the house's read of 2f357bd, #22).
 */
const NOTE_MAX_BYTES = 4096;
const NOTE_RATE_PER_S = 2;
const NOTE_BURST = 5;
const NOTE_PER_MINUTE = 30;
const NOTE_SHARE = 16;
/** Events a note-budget seed reads per page from a session's journal after a daemon restart. */
const NOTE_SCAN_PAGE = 5000;

type Settled = 'accepted' | 'not-owed' | 'refused';

/**
 * Delivery bookkeeping for one session name on this connection. Keyed by lineage —
 * the name's run index, which every life of the name shares (G30: seq numbering
 * continues) and a forgotten name's successor does not — so a stale seq of one
 * journal never pins another's cursor (mcpl-7).
 */
interface LaneState {
  lineage: object;
  /** Lifecycle seqs still owed (G22). Elapsed time is never an acknowledgement. */
  owed: Set<Seq>;
  /**
   * Message ids whose delivery awaits the host's answer, each with the seq it carries: a lifecycle message's own,
   * none for an ambient one, which is neither retried nor owed. A summary and an event can share a seq.
   */
  inflight: Map<string, Seq | undefined>;
  /** Failed lifecycle deliveries remain owed, with their original stable message id; past `McplLane.retryMax` the oldest fold into a summary. */
  retries: Map<string, { seq: Seq; kind: SegmentKind; attempt: number; timer?: NodeJS.Timeout | undefined }>;
  /**
   * A summary pins at its oldest event until accepted, then settles the individual debts it covers. One
   * that `folded` refused messages stands for them: they are no longer owed one by one. A catch-up's
   * summary owes its own seq (`owes`), its last omitted event or the end of its last gap.
   */
  summaries: Map<string, { from: Seq; covered: Set<Seq>; folded?: Omitted; owes?: Seq }>;
  /** Messages withheld while a synchronous call may still return them (G28): key (runId, or `runId:service=status@seq`) → since, on the monotonic clock. */
  held: Map<string, { since: number; seq?: Seq; timer?: NodeJS.Timeout | undefined }>;
  /** Everything up to here is settled for this principal except what is owed: `delivered` may advance to it. */
  clearTo: Seq;
  /** While catch-up scans from here, `delivered` does not pass it. */
  scanningFrom?: Seq | undefined;
  /** Set where this connection began carrying the session again (see `regain`); `delivered` does not pass it until a catch-up planned after it has scanned the session. */
  regainPin?: { at: Seq } | undefined;
}

/** A session as delivery sees it: the live Session of one life, or history; either keeps the principal's cursors (G22). */
type Target = Session | HistorySession;

/**
 * An open of a channel reading its history (see `McplLane.opening`): the lineage it reads, the messages
 * held for it, by id (the catch-up and the live path can both bring one), and how many such reads are
 * under way. The lineage is the name's run index, as for `LaneState`: a channel's history runs on across
 * the lives of one lineage (G30), and a forgotten name's successor starts another.
 */
interface Opening {
  lineage: object;
  held: Map<string, { t: Target; seg: Segment }>;
  opens: number;
}

/**
 * Where a catch-up summary pins the cursor: the earliest start among the omitted range and the gone
 * ranges it names. Pinned at the omitted range's start, the later one, it let the cursor pass a gone
 * range before the host acknowledged it (the house's read of 78c4d6e, #22).
 */
export const summaryFloor = (o: Omitted | undefined, gaps: ReadonlyArray<{ from: Seq }>): Seq => Math.min(o?.from ?? Number.POSITIVE_INFINITY, ...gaps.map((g) => g.from));
const targetOf = (entry: AnySession): Target => (entry.kind === 'live' ? entry.session : entry);
const liveOf = (t: Target): Session | undefined => ('kind' in t && t.kind === 'history' ? undefined : (t as Session));

/** Note budgets by lineage (mcpl-5). */
const noteBudgets = new WeakMap<object, NoteBudget>();

/**
 * The lanes of one App, by principal. A principal's `delivered` cursor is one across its
 * connections, so no lane moves it past what another lane of the same principal still owes
 * while that lane can carry the session (the house's read of 2f357bd, #22; see `floorAcross`).
 */
const lanesByApp = new WeakMap<App, Map<Principal, Set<McplLane>>>();

export class McplLane {
  /** Methods the endpoint routes to the lane; any of them on a plain MCP connection is METHOD_NOT_FOUND. */
  static readonly METHODS: ReadonlySet<string> = new Set([
    'featureSets/update',
    'mcpl/manifest',
    'channels/list',
    'channels/open',
    'channels/close',
    'channels/publish',
    'channels/acknowledge',
    'channels/typing',
    'context/beforeInference',
    'inference/lifecycle',
  ]);

  grant: CapabilityGrantState | null = null;
  enabledFeatureSets = new Set<string>();
  policyReceived = false;
  private readonly open = new Set<string>();
  /**
   * Channels whose open is reading its history page. Such a channel is not open, so nothing goes
   * out on it before the open is answered, and not closed either, so what the session delivers
   * meanwhile is held, not settled as owed to nobody: opened after the read, a channel missed a Run
   * that ended during it, and the opener never heard of it (the house's read of 78c4d6e, #22).
   */
  private readonly opening = new Map<string, Opening>();
  /** How many closes each channel open or opening has had on this connection: an open that saw the count change during its history read leaves the channel closed (see `closeChannel`). */
  private readonly closes = new Map<string, number>();
  private readonly registered = new Set<string>();
  /** Session id → the life followed, its segmenter, and the subscriptions. */
  private readonly watched = new Map<string, { session: Session; segmenter: Segmenter; off: () => void }>();
  private readonly states = new Map<string, LaneState>();
  /** Qualified message ids delivered or in flight on this connection, oldest first. */
  private readonly sent = new Set<string>();
  private batch: Array<{ t: Target; seg: Segment; msg: IncomingMessage }> = [];
  private batchTimer: NodeJS.Timeout | undefined;
  /** What delivery the grant allowed at the last activation: catch-up runs when it widens (mcpl-8). */
  private deliverable = { push: false, channels: false };
  private catchingUp: Promise<void> | undefined;
  /** A catch-up wanted while one runs: for every session (a grant change) or for the named ones (channels opened). */
  private catchUpAgain: Set<string> | 'all' | undefined;
  /** A catch-up whose scan failed is run again on the retry cadence; its sessions stay pinned at `delivered` meanwhile (see `scanAgain`). */
  private catchUpRetry: { attempt: number; scope: Set<string> | 'all'; timer?: NodeJS.Timeout | undefined } | undefined;
  private disposed = false;
  /** Warns, once, when the host has sent no grant this long after initializing: the connection is then on the core tools with no deliveries, and the log should say so rather than look like a profile. */
  static grantWarnMs = 5000;
  /** Refused lifecycle messages of one session retried one by one at most (see `foldRetries`). */
  static retryMax = 32;
  private grantTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly app: App,
    private readonly caller: Caller,
    private readonly out: Outbound,
    private readonly log: (line: string, level?: 'info' | 'warn') => void,
  ) {
    let byPrincipal = lanesByApp.get(app);
    if (!byPrincipal) lanesByApp.set(app, (byPrincipal = new Map()));
    let lanes = byPrincipal.get(caller.principal);
    if (!lanes) byPrincipal.set(caller.principal, (lanes = new Set()));
    lanes.add(this);
    this.grantTimer = setTimeout(() => {
      this.grantTimer = undefined;
      if (this.disposed || this.policyReceived) return;
      this.log(`no featureSets/update from the host ${McplLane.grantWarnMs} ms after initialize: serving the core tools only, with no push events, channels or presence, until the grant arrives`, 'warn');
    }, McplLane.grantWarnMs);
    this.grantTimer.unref();
  }

  private get me(): Principal {
    return this.caller.principal;
  }

  has(path: string): boolean {
    return this.grant !== null && capabilityGranted(this.grant.effectiveCapabilities, path);
  }

  private enabled(set: string, ...paths: string[]): boolean {
    return this.enabledFeatureSets.has(set) && paths.every((p) => this.has(p));
  }

  /** Which tools this connection may list and call: the core until the policy arrives, then the enabled tiers. */
  toolAllowed(name: string): boolean {
    if (!this.policyReceived) return CORE_TOOLS.includes(name);
    const fs = TOOL_FEATURE_SET[name];
    return fs !== undefined && this.enabledFeatureSets.has(fs);
  }

  /** Dispatch one MCPL method (routing only; the endpoint owns framing and errors). */
  async handle(method: string, params: Record<string, unknown>, ctx: LaneContext): Promise<unknown> {
    switch (method) {
      case 'featureSets/update': {
        const receipt = this.updatePolicy(params as never, ctx.isRequest ? 'request' : 'notification');
        // SPEC §6.7: the grant activates only after the receipt; start delivering once it is on the wire.
        if (ctx.isRequest) ctx.after(() => void this.activate());
        return receipt;
      }
      case 'mcpl/manifest':
        return manifest();
      case 'channels/list':
        if (!this.has('channels.register')) throw new RpcError(CAPABILITY_DENIED, 'channels.register not granted', { capability: 'channels.register' });
        return { channels: this.listChannels() };
      case 'channels/open':
        return this.openChannel(params as never);
      case 'channels/close':
        return this.closeChannel(String(params.channelId ?? ''));
      case 'channels/publish':
        return this.publish(params as never);
      case 'context/beforeInference':
        return this.beforeInference();
      default:
        return {};
    }
  }

  /** SPEC §5.3/§6.7: the initial policy, as a Request; the response is a degradation receipt. Malformed fails closed (§5.4). */
  updatePolicy(params: FeatureSetsUpdateParams, form: 'request' | 'notification'): Record<string, unknown> {
    const could = this.mayCarryNow();
    const r = grantFromUpdate(this.grant, params, form);
    this.grant = r.state;
    if (r.malformed) {
      // §10.5: fail closed to an empty grant — tools too, until a valid Request (mcpl-16). Never back to the pre-policy core.
      this.enabledFeatureSets = new Set();
      this.policyReceived = true;
      this.deliverable = { push: false, channels: false };
      if (this.batch.length) void this.flush();
      this.log('grant malformed (effectiveCapabilities and deniedCapabilities overlap): nothing is granted, no tools, until a valid featureSets/update', 'warn');
      throw new RpcError(INVALID_PARAMS, 'effectiveCapabilities and deniedCapabilities overlap (§5.4); nothing is granted', { conflicts: r.conflicts });
    }
    const derived = deriveFeatureSets(DECLARATIONS, r.state.effectiveCapabilities);
    const selected = r.state.enabledFeatureSets;
    const wanted = (n: string) => (selected === null || selected.includes(n) || selected.includes('*')) && !r.state.disabledFeatureSets.includes(n);
    this.enabledFeatureSets = new Set(derived.enabled.filter(wanted));
    // A session this lane can carry now and could not before is pinned before anything can settle: the flush below,
    // and what the live path settles before the activation's catch-up (see `regain`).
    for (const entry of this.app.registry.list()) {
      if (!this.app.can(this.me, entry, 'observe')) continue;
      const t = targetOf(entry);
      if (!could.has(t.id) && this.mayCarry(t)) this.regain(t);
    }
    if (form === 'request') this.policyReceived = true;
    if (this.grantTimer) clearTimeout(this.grantTimer);
    this.grantTimer = undefined;
    // The log says what the grant came to, so a connection that sees fewer
    // tools or no deliveries than its host asked for can be read from here.
    const notEnabled = Object.keys(DECLARATIONS)
      .filter((n) => !this.enabledFeatureSets.has(n))
      .map((n) => {
        const why = derived.disabled[n];
        if (why) return `${n} (${why.reason === 'capability_denied' ? 'missing ' + why.missingCapabilities.join(', ') : 'invalid uses'})`;
        return `${n} (${r.state.disabledFeatureSets.includes(n) ? 'disabled by the host' : 'not enabled by the host'})`;
      });
    const tools = TOOLS.filter((t) => this.toolAllowed(t.name)).length;
    this.log(`grant ${form === 'request' ? 'received' : 'updated'}: ${tools} tools; enabled ${[...this.enabledFeatureSets].join(', ') || 'nothing'}${notEnabled.length ? `; not enabled: ${notEnabled.join('; ')}` : ''}`);
    // A reduction binds at once (SPEC §6.7, mcpl-19): what no longer may flow is not sent, and a later widening catches up.
    this.deliverable = {
      push: this.deliverable.push && this.enabled('terminal.live', 'pushEvents'),
      channels: this.deliverable.channels && this.enabled('terminal.channels', 'channels.incoming'),
    };
    if (this.batch.length) void this.flush();
    const unavailable = Object.entries(derived.disabled)
      .filter(([n]) => wanted(n))
      .map(([featureSet, d]) => ({ featureSet, missingCapabilities: d.missingCapabilities, effect: 'disabled', reason: d.reason }));
    const notes: string[] = [];
    for (const n of selected ?? []) if (n !== '*' && !(n in FEATURE_SETS)) notes.push(`unknown feature set ${n}`);
    const receipt: Record<string, unknown> = { accepted: true, unavailableFeatures: unavailable, notes };
    if (unavailable.length) receipt.mode = 'degraded';
    return receipt;
  }

  /**
   * The connection can carry this session's lifecycle messages now (its channel opened): what is
   * owed since the principal's `delivered` cursor is caught up, as a grant that widens does — a
   * retry stranded when its timer found nothing to carry it on, and messages this connection
   * never saw (the house's read of 2f357bd, #22).
   */
  private carryNow(t: Target): void {
    if (this.disposed || !this.carries(t.id)) return;
    if (t.cursorsOf(this.me).delivered >= t.journal.lastSeq) return;
    void this.startCatchUp([t.id]);
  }

  /**
   * Catch up every session this connection carries, or only `sessions`. A reopen or grant change
   * during a scan gets a subsequent scan with the new delivery scope.
   */
  private startCatchUp(sessions?: Iterable<string>): Promise<void> {
    const scope = sessions === undefined ? 'all' : new Set(sessions);
    if (this.catchingUp) {
      if (scope === 'all' || this.catchUpAgain === 'all') this.catchUpAgain = 'all';
      else {
        const pending = this.catchUpAgain instanceof Set ? this.catchUpAgain : new Set<string>();
        for (const id of scope) pending.add(id);
        this.catchUpAgain = pending;
      }
      return this.catchingUp;
    }
    this.catchingUp = this.catchUpAll(scope === 'all' ? undefined : scope)
      .then(() => {
        // Only a scan that covered the sessions awaiting one ends the backoff: reset by any success, a channel opened
        // elsewhere had a store that kept failing scanned again at 500 ms instead of backing off (an independent read
        // of the lane fixes on PR #22, comment 6376365550).
        const r = this.catchUpRetry;
        if (r && (scope === 'all' || (r.scope !== 'all' && [...r.scope].every((id) => scope.has(id))))) {
          r.attempt = 0;
          r.scope = new Set();
        }
      })
      .catch((e) => this.scanAgain(scope, e as Error))
      .finally(() => {
        this.catchingUp = undefined;
        const again = this.catchUpAgain;
        this.catchUpAgain = undefined;
        if (again && !this.disposed) void this.startCatchUp(again === 'all' ? undefined : again);
      });
    return this.catchingUp;
  }

  /**
   * A catch-up whose scan failed (a store that could not be read) is run again after a backoff on the retry cadence,
   * and the regain pins of its sessions stay until a scan succeeds. Released at the failure, as `scanningFrom` is,
   * nothing ran the scan again: the lane had owed nothing while it could not carry the session, so its next settle
   * lifted `delivered` past completions no connection had delivered, with only the failure logged. A cursor held is
   * recoverable; a completion passed is not (an independent read of the lane fixes on PR #22, comment 6376365550).
   * One timer stands at a time; a failure meanwhile widens its scope.
   */
  private scanAgain(scope: Set<string> | 'all', e: Error): void {
    const r = (this.catchUpRetry ??= { attempt: 0, scope: new Set() });
    r.scope = r.scope === 'all' || scope === 'all' ? 'all' : new Set([...r.scope, ...scope]);
    const wait = retryDelay(r.attempt++);
    this.log(`catch-up failed: ${e.message}; its sessions stay pinned at delivered, and it is scanned again in ${wait} ms`);
    if (r.timer || this.disposed) return;
    r.timer = setTimeout(() => {
      r.timer = undefined;
      // The sessions stay recorded until a scan covering them succeeds (see `startCatchUp`); none left, a covering scan
      // came meanwhile and there is nothing to run.
      const again = r.scope;
      if (this.disposed || (again !== 'all' && !again.size)) return;
      void this.startCatchUp(again === 'all' ? undefined : again);
    }, wait);
    r.timer.unref?.();
  }

  /** After the receipt: follow visible sessions, register channels and catch up when delivery becomes possible. */
  private async activate(): Promise<void> {
    if (this.disposed) return;
    for (const s of this.app.registry.list()) if (s.kind === 'live' && !s.session.journal.closed && this.app.can(this.me, s, 'observe')) this.follow(s.session);
    // Registration and catch-up are independent: push events need no registered channel.
    void this.registerAll();
    const now = { push: this.enabled('terminal.live', 'pushEvents'), channels: this.enabled('terminal.channels', 'channels.incoming') };
    const widened = (now.push && !this.deliverable.push) || (now.channels && !this.deliverable.channels);
    this.deliverable = now;
    // Not on every update (mcpl-8): only the initial policy, or one that enables delivery.
    if (widened) await this.startCatchUp();
  }

  // ───────────── channels ─────────────

  /** A session's channel descriptor: its metadata is the App's own summary of the entry (one look per session, not a list per session — the house's read of 2f357bd, #22). */
  private descriptorFor(entry: AnySession): ChannelDescriptor {
    // The header alone: the full summary lists the session's Runs, Services and Watches, which made a
    // channel listing cost every session's Runs (a review of the consolidated branch of #22).
    const s = this.app.summaryHeader(entry);
    // `speech: 'none'` asks hosts not to route an agent's ordinary replies here (UPSTREAM-CHANGES A6).
    const metadata: Record<string, unknown> = { node: NODE_NAME, speech: 'none', owner: s.owner, state: s.state };
    if (s.controller !== null) metadata.controller = s.controller;
    if (s.cwd !== undefined) metadata.cwd = s.cwd;
    if (s.integration !== undefined) metadata.integration = s.integration;
    if (s.recovered !== undefined) metadata.recovered = s.recovered;
    return {
      id: channelId(s.id),
      type: 'terminal',
      label: `${s.id} (node: ${NODE_NAME})`,
      direction: 'bidirectional',
      address: { node: NODE_NAME, session: s.id },
      metadata,
      initiallyOpen: false,
      // History pages backwards from `beforeMessageId` (mcpl-18).
      capabilities: { history: { maxMessages: HISTORY_MAX, supportsBeforeMessage: true } },
    };
  }

  /** Every session the principal may observe, history-only ones included: their history is what matters after a restart (mcpl-2, mcpl-18). */
  listChannels(): ChannelDescriptor[] {
    return this.app.registry
      .list()
      .filter((s) => this.app.can(this.me, s, 'observe'))
      .map((s) => this.descriptorFor(s));
  }

  private channelsOn(): boolean {
    return this.enabled('terminal.channels', 'channels.register');
  }

  /** Register every visible session as a channel, honouring itemized results (§14.5); retry while the host is still activating the grant. */
  async registerAll(): Promise<void> {
    if (!this.channelsOn()) return;
    const channels = this.listChannels();
    if (!channels.length) return;
    for (let attempt = 0; attempt < 4 && !this.disposed; attempt++) {
      try {
        const r = (await this.out.request('channels/register', { channels })) as { results?: Array<{ id: string; accepted: boolean }> };
        for (const c of channels) if (!r?.results || r.results.find((x) => x.id === c.id)?.accepted !== false) this.registered.add(c.id);
        return;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code !== CAPABILITY_DENIED) {
          this.log(`channels/register failed: ${(e as Error).message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 100 * 4 ** attempt));
      }
    }
    // What still flows depends on the grant: a channels-only host gets nothing until it opens a channel itself.
    const push = this.enabled('terminal.live', 'pushEvents');
    this.log(`channels/register: the host kept refusing it; ${push ? 'lifecycle messages go as push events, and' : 'nothing is delivered until the host opens a channel (no pushEvents granted);'} channels the host opens carry everything`);
  }

  sessionCreated(sessionId: string): void {
    const s = this.app.registry.get(sessionId);
    if (!s || s.kind !== 'live' || !this.policyReceived) return;
    this.follow(s.session);
    if (!this.channelsOn()) return;
    const d = this.descriptorFor(s);
    if (this.registered.has(d.id)) this.out.notify('channels/changed', { updated: [d] });
    else {
      this.registered.add(d.id);
      this.out.notify('channels/changed', { added: [d] });
    }
  }

  /**
   * A session's shell ended and it became history: what its segmenter still owes is
   * delivered first (mcpl-6), then the life is let go — only that life: a new life
   * followed meanwhile stays followed (mcpl-10).
   */
  async sessionClosed(sessionId: string): Promise<void> {
    const w = await this.letGo(sessionId);
    if (w) this.releaseUnsettled(w.session, w.session.journal.lastSeq);
    const id = channelId(sessionId);
    const s = this.app.registry.get(sessionId);
    if (!s || !this.registered.has(id) || !this.channelsOn()) return;
    // The name may hold another life by now, which this principal may not see: the server announces a
    // created session only to those who may observe it, and an update here described another principal's
    // private session to this host (the house's read of the 40 commits, #22). Its channel goes instead.
    if (this.app.can(this.me, s, 'observe')) this.out.notify('channels/changed', { updated: [this.descriptorFor(s)] });
    else this.unregisterUnseen(id);
  }

  /** A registered channel whose name now holds a session this principal may not observe: it is removed. */
  private unregisterUnseen(id: string): void {
    if (this.registered.delete(id) && this.channelsOn()) this.out.notify('channels/changed', { removed: [id] });
  }

  /** A session and its journal are gone (`forget`, retention). A name opened again meanwhile is a different session and stays. */
  async sessionRemoved(sessionId: string): Promise<void> {
    await this.letGo(sessionId);
    const id = channelId(sessionId);
    // An open of the gone life's channel still reading history holds that life's messages: they go
    // nowhere (the house's read of the 38 commits (PR #22, comment 6274370651)). Only the gone
    // lineage's opening goes: dropped by name, a removal that landed after the name was re-created
    // dropped the new life's opening and what it held (a reviewer's read of the fixes for #22).
    const p = this.opening.get(id);
    if (p && p.lineage !== this.lineageOf(sessionId)) this.opening.delete(id);
    const now = this.app.registry.get(sessionId);
    if (now) {
      // Re-created meanwhile: sessionCreated announced it (mcpl-10), when this principal may observe it. A
      // life it may not observe was never announced, and the gone life's channel stayed registered.
      if (!this.app.can(this.me, now, 'observe')) this.unregisterUnseen(id);
      return;
    }
    const st = this.states.get(sessionId);
    if (st) for (const h of st.held.values()) if (h.timer) clearTimeout(h.timer);
    if (st) for (const r of st.retries.values()) if (r.timer) clearTimeout(r.timer);
    this.states.delete(sessionId);
    this.open.delete(id);
    this.closes.delete(id);
    if (this.registered.delete(id) && this.channelsOn()) this.out.notify('channels/changed', { removed: [id] });
  }

  async openChannel(params: {
    type?: string;
    address?: { session?: string };
    channelId?: string;
    history?: { limit?: number; beforeMessageId?: string };
  }): Promise<{ channel: ChannelDescriptor; history?: IncomingMessage[]; historyTruncated?: boolean }> {
    this.mayChangeChannels();
    const sid = params.address?.session ?? (params.channelId ? sessionOf(params.channelId) : undefined);
    if (!sid) throw new RpcError(UNKNOWN_CHANNEL, 'channels/open needs address.session or channelId');
    const id = channelId(sid);
    const s = this.app.registry.get(sid);
    if (!s || !this.app.can(this.me, s, 'observe')) throw new RpcError(UNKNOWN_CHANNEL, `unknown channel ${id}`, { channelId: id });
    // Every parameter is checked before the open takes effect: checked after, a refused open had
    // opened the channel, and the next completion reached the host on it (the house's read of
    // cc8c909..39787b3, #22).
    const raw = params.history?.limit;
    if (raw !== undefined && (typeof raw !== 'number' || Number.isNaN(raw))) throw new RpcError(INVALID_PARAMS, 'history.limit must be a number', { limit: raw });
    // A whole number, never past the cap: a fraction was kept, compared equal to no count, and got everything (the house's read of 2f357bd, #22).
    const limit = raw === undefined ? 0 : Math.min(HISTORY_MAX, Math.max(0, Math.floor(raw)));
    const t = targetOf(s);
    const boundary = limit > 0 ? params.history?.beforeMessageId : undefined;
    // A boundary that is not one of our ids is refused, not ignored: ignored, it answered with the
    // newest page as if none had been given, and a host paging back got the same page again (the
    // house's read of 07ab3dd, #22). Ours means this node's, this session's, this journal's epoch:
    // judged by its suffix's shape, another session's id, or this name's under a forgotten epoch,
    // was taken as a cursor into this journal (the house's read of 78c4d6e, #22).
    const own = boundary !== undefined ? unqualify(String(boundary)) : undefined;
    const before = own !== undefined ? seqOfMessageId(own, sid, t.journal) : undefined;
    if (boundary !== undefined && before === undefined) {
      throw new RpcError(INVALID_PARAMS, `history.beforeMessageId is not a message id of this channel: ids look like ${NODE_NAME}/${sid}~<epoch>:<kind>[~<qualifier>]:<seq>, as channels/incoming and channels/open history give them, and the node, the session and the epoch must be this channel's`, { beforeMessageId: String(boundary).slice(0, 200) });
    }
    // The history is read before anything changes: a read that fails (a store error) refuses the
    // open with nothing opened, as a refused parameter does. While it is read, the channel is
    // opening (see `opening`), and what the session delivers meanwhile waits for the outcome.
    const res: { channel: ChannelDescriptor; history?: IncomingMessage[]; historyTruncated?: boolean } = { channel: this.descriptorFor(s) };
    // From here the channel is opening until `finishOpening`, the one way out that opens it; every
    // other way out abandons the opening, or the channel stayed opening for good, with every message
    // for it held and its owed seqs pinning the cursor (a reviewer's read of the fixes for #22 comment 6270045466).
    const closes = this.closes.get(id) ?? 0;
    const could = this.mayCarry(t);
    const pending = limit > 0 ? this.beginOpening(id, t) : undefined;
    // An opening owes what the session delivers meanwhile, so the lane regains the session as the opening begins;
    // an open without a history read, as it opens (see `regain`).
    if (!could && this.mayCarry(t)) this.regain(t);
    try {
      if (limit > 0) {
        const r = await replayNewest(this.sourceOf(s), before !== undefined ? { limit, before } : { limit });
        // The connection closed during the read: nothing is registered or followed (a subscription
        // nothing would remove), and the open is answered with an error, should anything still carry
        // it (the house's read of 78c4d6e, #22). The session the open began on is gone or replaced: a
        // forgotten name's channel was opened for nobody, and a name re-created meanwhile found its
        // channel open (the reviewer's read above). A grant update that revoked channels.lifecycle
        // during the read still had the channel opened (the house's read of the 33 commits (PR #22,
        // comment 6307350861)).
        this.recheck(sid, s, id, "the channel's history was read", 'opened', () => this.mayChangeChannels());
        res.history = r.segments.map((seg) => this.message(t, seg));
        if (r.truncated) res.historyTruncated = true;
        // The host closed the channel during the read (see `closeChannel`): the close stands, whether
        // the channel was opening or already open and paging back. The page is still the open's answer;
        // nothing is attached, followed or opened. Judged by the opening alone, a page read of an open
        // channel had none, and its return reopened a channel the host had closed (a reviewer's read
        // of the fixes for #22).
        if ((this.closes.get(id) ?? 0) !== closes) return res;
      }
      if (s.kind === 'live') {
        // §9: the owner's connection takes a free seat; everyone else observes. Opening never starts a
        // shell (mcpl-9): a session whose shell ended is followed read-only, its history served.
        if (s.session.exit === undefined) this.attach(s.session);
        if (!s.session.journal.closed) this.follow(s.session);
      }
    } catch (e) {
      this.abandonOpening(id, pending);
      throw e;
    }
    this.registered.add(id);
    const wasOpen = this.open.has(id);
    this.open.add(id);
    if (!could && pending === undefined && this.carries(t.id)) this.regain(t);
    this.finishOpening(id, pending);
    if (!wasOpen) this.carryNow(t);
    return res;
  }

  /** Open, or opening (see `opening`): an open in flight owes the channel's messages as an open one does, so the cursor waits for them. */
  private openOrOpening(id: string): boolean {
    return this.open.has(id) || this.opening.has(id);
  }

  /**
   * An open of the channel begins reading its history (see `opening`); a channel already open needs no
   * hold. An opening of another lineage is a forgotten name's, whose own open fails when its read
   * returns: what it held goes nowhere, as `sessionRemoved` drops it, and this open starts its own
   * rather than joining it and sending that life's messages on the channel the name now names (the
   * house's read of the 38 commits (PR #22, comment 6274370651)).
   */
  private beginOpening(id: string, t: Target): Opening | undefined {
    if (this.open.has(id)) return undefined;
    let p = this.opening.get(id);
    if (p?.lineage !== t.journal.runs) this.opening.set(id, (p = { lineage: t.journal.runs, held: new Map(), opens: 0 }));
    p.opens++;
    return p;
  }

  /**
   * The channel is open: what was held for it goes on it, past the hold it already passed. A message
   * the page also showed goes too: the page is a read, and delivery is by the host's receipt (G22), as
   * it is for anything owed that a catch-up sends after an open with history; the id is the same.
   */
  private finishOpening(id: string, p: Opening | undefined): void {
    if (!p || this.opening.get(id) !== p) return;
    this.opening.delete(id);
    for (const h of p.held.values()) this.deliver(h.t, h.seg, { released: true });
  }

  /**
   * The open did not complete. Once no other open of the channel is still reading, what was held
   * goes the way a closed channel's messages go: pushed when owed to this principal, else settled;
   * a disposed lane delivers nothing.
   */
  private abandonOpening(id: string, p: Opening | undefined): void {
    if (!p || this.opening.get(id) !== p || --p.opens > 0) return;
    this.opening.delete(id);
    if (!this.disposed) for (const h of p.held.values()) this.deliver(h.t, h.seg, { released: true });
  }

  closeChannel(id: string): { closed: boolean } {
    this.mayChangeChannels();
    // A close while the channel's history is read stands: the opening is abandoned, what it held goes
    // a closed channel's way, and the open leaves the channel closed when its read returns. Answered
    // from `open` alone, the close said false and the returning open undid it, while the host kept the
    // close as standing, so a reconnect dropped a channel this connection still delivered on (the house's read of the 38 commits (PR #22, comment 6274370651)).
    // Every open whose read is under way sees the close by the count, an open channel's page read too.
    // Such a read's channel is open or opening until a close, so only those are counted: counted for any
    // id, a close naming no session stayed in the map for the connection's life (the house's read of the
    // 33 commits (PR #22, comment 6307350861)).
    const p = this.opening.get(id);
    if (p || this.open.has(id)) this.closes.set(id, (this.closes.get(id) ?? 0) + 1);
    if (p) {
      this.opening.delete(id);
      for (const h of p.held.values()) this.deliver(h.t, h.seg, { released: true });
    }
    const wasOpen = this.open.delete(id);
    return { closed: wasOpen || p !== undefined };
  }

  /** §14.1: the lifecycle methods need channels.lifecycle, close as much as open (the house's review of #11). */
  private mayChangeChannels(): void {
    if (!this.has('channels.lifecycle')) throw new RpcError(CAPABILITY_DENIED, 'channels.lifecycle not granted', { capability: 'channels.lifecycle' });
  }

  /** What a note on a channel needs of the grant. */
  private mayPublish(channelId: string): void {
    if (!this.has('channels.publish')) throw new RpcError(CAPABILITY_DENIED, 'channels.publish not granted', { capability: 'channels.publish' });
    if (!this.enabledFeatureSets.has('terminal.annotate')) throw new RpcError(CHANNEL_NOT_PERMITTED, 'terminal.annotate is not enabled', { channelId });
  }

  /**
   * What a channel method checked before an await, checked again after it, since the server runs a
   * connection's requests concurrently: the connection may have closed, a featureSets/update changed
   * the grant (`grant` checks it), the session been closed or its name re-created, or the principal
   * lost sight of it. Any of these refuses the method with nothing done.
   */
  private recheck(sid: string, s: AnySession, channel: string, during: string, done: string, grant: () => void): void {
    if (this.disposed) throw new RpcError(INTERNAL, `the connection closed while ${during}; nothing was ${done}`);
    grant();
    if (this.app.registry.get(sid) !== s) throw new RpcError(UNKNOWN_CHANNEL, `session ${sid} was closed or replaced while ${during}; nothing was ${done}`, { channelId: channel });
    if (!this.app.can(this.me, s, 'observe')) throw new RpcError(UNKNOWN_CHANNEL, `unknown channel ${channel}`, { channelId: channel });
  }

  private attach(session: Session): void {
    if (session.listAttachments().some((a) => a.principal === this.me && a.connectionId === this.caller.connectionId)) return;
    try {
      session.attach(this.me, this.caller.connectionId, 'auto');
    } catch {
      // observing needs no seat
    }
  }

  /**
   * What the agent said on a session's channel becomes a note for observers; it is never typed
   * (see the header). A note is small and rate-limited, and all notes together never hold more
   * than a share of the session's retention, so no observer can evict the owner's history
   * (mcpl-5, G17, G21).
   */
  async publish(params: { channelId: string; content?: Array<{ type: string; text?: string }> }): Promise<{ delivered: boolean; messageId?: string }> {
    this.mayPublish(params.channelId);
    const sid = sessionOf(params.channelId);
    const s = sid !== undefined ? this.app.registry.get(sid) : undefined;
    if (!sid || !s || !this.app.can(this.me, s, 'observe')) throw new RpcError(UNKNOWN_CHANNEL, `unknown channel ${params.channelId}`, { channelId: params.channelId });
    const text = (params.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
    if (!text) return { delivered: false };
    const bytes = Buffer.byteLength(text);
    if (bytes > NOTE_MAX_BYTES) {
      throw new RpcError(INVALID_PARAMS, `a note is at most ${NOTE_MAX_BYTES} bytes (this one is ${bytes}); write longer text to a file and point to it`, { channelId: params.channelId, bytes, maxBytes: NOTE_MAX_BYTES });
    }
    let budget: NoteBudget | undefined;
    let capped = false;
    let stored = bytes;
    if (s.kind === 'live' && !s.session.journal.closed) {
      const journal = s.session.journal;
      const retention = s.retention.maxBytes ?? Infinity;
      // What the store will write for it, by the journal's own count (the seq's digits may differ by one).
      stored = journal.sizeOf({ type: 'note', text, principal: this.me, channel: params.channelId });
      const share = NoteBudget.share(retention);
      if (stored > share) {
        const max = Math.max(0, share - (stored - bytes));
        throw new RpcError(INVALID_PARAMS, `a note on this session is at most ${max} bytes (notes may use 1/${NOTE_SHARE} of its ${fmtBytes(retention)} retention, ${fmtBytes(share)} as the journal stores them); write longer text to a file and point to it`, { channelId: params.channelId, bytes, maxBytes: max });
      }
      budget = this.budgetOf(journal);
      // After a daemon restart the budget starts empty while the journal still holds every note it kept.
      capped = Number.isFinite(retention);
      if (capped) {
        await budget.seed(journal);
        // The first seed reads the journal's notes in pages and yields between them: a grant update, or a
        // close and re-creation of the name, landing meanwhile had the note go out under a revoked grant
        // or into the name's next life (the house's read of the 33 commits (PR #22, comment 6307350861)).
        this.recheck(sid, s, params.channelId, "the session's notes were counted", 'published', () => this.mayPublish(params.channelId));
      }
      const refused = budget.take(this.me, stored, journal, retention, clocks.monotonic());
      if (refused) throw new RpcError(OVERLOADED, refused.message, { channelId: params.channelId, retryAfterMs: refused.retryAfterMs });
    }
    try {
      const r = this.app.note(this.caller, { session: sid, text, channel: params.channelId });
      // Only under a byte cap is a note's size kept: without one nothing is ever evicted and the list
      // only grew, a pair per note for the daemon's life (the house's read of the 38 commits (PR #22, comment 6274370651)).
      if (capped) budget?.record(r.seq, stored);
      // Delivered means recorded (mcpl-14): the note is in the session's journal, where the GUI, `read`
      // and other principals' open channels see it. Nobody watching right now is not a failure to report.
      return { delivered: true, messageId: qualify(segmentId(sid, targetOf(s).journal, 'note', r.seq)) };
    } catch (e) {
      if (e instanceof TermError) throw new RpcError(CHANNEL_NOT_PERMITTED, e.message, { channelId: params.channelId, ...e.data });
      throw e;
    }
  }

  /** The note budget of the session's lineage (mcpl-5), made at its first note. */
  private budgetOf(journal: Journal): NoteBudget {
    let budget = noteBudgets.get(journal.runs);
    if (!budget) noteBudgets.set(journal.runs, (budget = new NoteBudget()));
    return budget;
  }

  // ───────────── presence (§10.4) ─────────────

  private beforeInference(): Record<string, unknown> {
    if (!this.enabled('terminal.presence', 'contextHooks.beforeInference.inject.beforeUser')) return {};
    const ids = new Set<string>();
    for (const c of this.open) {
      const sid = sessionOf(c);
      if (sid) ids.add(sid);
    }
    for (const s of this.app.registry.list()) {
      // A session a restart left history-only: presence reports the Runs it lost (mcpl-2); one closed on purpose is quiet.
      if (s.kind !== 'live') {
        if (!s.closed && s.owner === this.me) ids.add(s.id);
        continue;
      }
      if (s.session.owner === this.me || this.hasRunIn(s.session)) ids.add(s.session.id);
    }
    const text = presence(this.app, this.me, ids);
    if (!text) return { featureSet: 'terminal.presence', contextInjections: [] };
    return { featureSet: 'terminal.presence', contextInjections: [{ namespace: 'terminal', position: 'beforeUser', content: [{ type: 'text', text }] }] };
  }

  /** Has this principal a Run in the session that has not ended? */
  private hasRunIn(session: Session): boolean {
    return session.listRuns().some((r) => r.principal === this.me && !isDone(r.state));
  }

  // ───────────── following sessions ─────────────

  private follow(session: Session): void {
    const cur = this.watched.get(session.id);
    if (cur?.session === session) return;
    // An earlier life still delivers what its segmenter owes before its subscription goes (mcpl-6).
    if (cur) void cur.segmenter.drained().then(cur.off, cur.off);
    const segmenter = this.app.segmenter(session);
    const offSeg = segmenter.subscribe((seg) => this.onSegment(session, seg));
    const offJ = session.journal.subscribe((ev) => this.onJournal(session, ev));
    let done = false;
    this.watched.set(session.id, {
      session,
      segmenter,
      off: () => {
        if (done) return;
        done = true;
        offSeg();
        offJ();
      },
    });
  }

  /**
   * Deliver what the followed life's segmenter still owes (mcpl-6), then stop following that life — only
   * that one (mcpl-10), and never the live life the registry holds for the name now: a close or removal
   * that lands after the name began a new life is an older life's, and letting go by name unfollowed the
   * new one (a reviewer's read of the fixes for #22).
   */
  private async letGo(sessionId: string): Promise<{ session: Session } | undefined> {
    const w = this.watched.get(sessionId);
    const now = this.app.registry.get(sessionId);
    if (w && now?.kind === 'live' && now.session === w.session) return undefined;
    if (w) await w.segmenter.drained();
    await this.flush();
    if (w && this.watched.get(sessionId) === w) {
      w.off();
      this.watched.delete(sessionId);
    }
    return w;
  }

  // ───────────── targets, state, cursors ─────────────

  private sourceOf(entry: AnySession): ReplaySource {
    if (entry.kind === 'live') return liveSource(entry.session, entry.session.screen.cols);
    return journalSource({ id: entry.id, journal: entry.journal, owner: entry.owner });
  }

  /** The name's lineage now (see `LaneState`): the run index of the life or history the registry holds for it; undefined when the name is gone. */
  private lineageOf(sessionId: string): object | undefined {
    const entry = this.app.registry.get(sessionId);
    return entry ? targetOf(entry).journal.runs : undefined;
  }

  /** Is `t` of its name's lineage now? Only such a target's messages go on the name's channel, are held for its opening, or are retried. */
  private current(t: Target): boolean {
    return this.lineageOf(t.id) === t.journal.runs;
  }

  /** This name's bookkeeping; a journal of another lineage (an old life of a forgotten name) gets a detached one. */
  private stateOf(t: Target): LaneState {
    const lineage = t.journal.runs;
    const cur = this.states.get(t.id);
    if (cur?.lineage === lineage) return cur;
    const current = this.lineageOf(t.id);
    const st: LaneState = { lineage, owed: new Set(), inflight: new Map(), retries: new Map(), summaries: new Map(), held: new Map(), clearTo: 0 };
    if (current !== undefined && current !== lineage) return st;
    if (cur) {
      for (const h of cur.held.values()) if (h.timer) clearTimeout(h.timer);
      for (const r of cur.retries.values()) if (r.timer) clearTimeout(r.timer);
    }
    this.states.set(t.id, st);
    return st;
  }

  /**
   * Did a synchronous call return this to the principal (G28): the Run's outcome, or the service
   * status event (`seq`) its start returned (mcpl-13)? That event only: a key naming the status
   * alone withheld every later return to `ready` after an unhealthy spell (the house's read of
   * 2f357bd, #22).
   */
  private returned(t: Target, runId: string, service?: { status: string; seq: Seq }): boolean {
    const to = (key: string) => liveOf(t)?.outcomeDeliveredTo(key, this.me) ?? false;
    return service === undefined ? to(runId) : to(serviceOutcomeKey(runId, service.status, service.seq)) || (service.status === 'exited' && to(runId));
  }

  private returnedSeg(t: Target, seg: Segment): boolean {
    if (seg.runId === undefined || (seg.kind !== 'run' && seg.kind !== 'service')) return false;
    return seg.kind === 'service' ? this.returned(t, seg.runId, { status: String(seg.metadata.service), seq: seg.seq }) : this.returned(t, seg.runId);
  }

  /** The key a withheld message is held under: its Run, or one service status event (two returns to a status are two messages). */
  private heldKey(seg: Segment): string | undefined {
    if (seg.runId === undefined) return undefined;
    if (seg.kind === 'run') return seg.runId;
    return seg.kind === 'service' ? serviceOutcomeKey(seg.runId, String(seg.metadata.service), seg.seq) : undefined;
  }

  /** The hold is over: the message was returned, sent, or is no longer wanted. */
  private unhold(st: LaneState, key: string | undefined): void {
    if (key === undefined) return;
    const h = st.held.get(key);
    if (h?.timer) clearTimeout(h.timer);
    st.held.delete(key);
  }

  private owe(st: LaneState, seq: Seq): void {
    st.owed.add(seq);
  }

  /** The highest seq `delivered` may reach: below every owed message, and below a catch-up's start while it scans. */
  private floor(st: LaneState): Seq {
    let min = Number.POSITIVE_INFINITY;
    for (const seq of st.owed) if (seq < min) min = seq;
    for (const summary of st.summaries.values()) if (summary.from < min) min = summary.from;
    let f = min - 1;
    if (st.scanningFrom !== undefined) f = Math.min(f, st.scanningFrom);
    if (st.regainPin !== undefined) f = Math.min(f, st.regainPin.at);
    return f;
  }

  /**
   * A message was accepted, or is owed to nobody here: `delivered` advances, but never
   * past a lifecycle message still owed to this principal (G22). A completion the
   * principal's synchronous call returned counts as accepted (mcpl-1); so does a host's
   * `duplicate` answer (mcpl-7). Refusal is not delivery: it keeps pinning the cursor. Only a lifecycle message
   * pays a debt, as only one carries it (see `carried`): an ambient message accepted at a summary's own seq, a gap
   * ending exactly there, paid the summary's debt before the host had the summary (an independent read of the lane
   * fixes on PR #22, comment 6376365550).
   */
  private settle(t: Target, seq: Seq, how: Settled, lifecycle = true): void {
    const st = this.stateOf(t);
    if (how === 'refused') return;
    if (lifecycle) st.owed.delete(seq);
    if (seq > st.clearTo) st.clearTo = seq;
    this.advance(t, st);
  }

  private settleSegment(t: Target, seg: Segment, how: Settled): void {
    const st = this.stateOf(t);
    const id = qualify(seg.messageId);
    st.inflight.delete(id);
    if (how === 'refused') return;
    const summary = st.summaries.get(id);
    st.summaries.delete(id);
    if (summary && how === 'accepted') for (const seq of summary.covered) st.owed.delete(seq);
    for (const [key, retry] of st.retries) {
      if (key !== id && !(how === 'accepted' && summary?.covered.has(retry.seq) && !st.summaries.has(key))) continue;
      if (retry.timer) clearTimeout(retry.timer);
      st.retries.delete(key);
    }
    // A summary's own seq, the last gap's end, can be a message that still carries it, which the summary left out of
    // what it covers: settled here, `delivered` could pass that message before it went out, and its refusal was then
    // settled as accepted (the house's read of 4860d4c, #22).
    if (summary && this.carried(t, st).has(seg.seq)) {
      if (seg.seq > st.clearTo) st.clearTo = seg.seq;
      return this.advance(t, st);
    }
    this.settle(t, seg.seq, how, seg.lifecycle);
  }

  private advance(t: Target, st: LaneState): void {
    // A connection that cannot carry this session's lifecycle messages leaves the cursor where it is: they are the
    // principal's, delivered by a connection that can, or found from `delivered` by a catch-up (G22).
    if (!this.carries(t.id)) return;
    t.markDelivered(this.me, Math.min(st.clearTo, this.floorAcross(t, st)));
  }

  /**
   * The lowest floor among this principal's connections for the session: `delivered` is theirs together (see `lanesByApp`).
   * A connection that can't carry the session counts for nothing: what it owed before it lost the session is the
   * principal's, found again from `delivered` when it carries again. Counted, one refused completion of a connection
   * that then closed its channel held the cursor of every connection that could deliver (the question left open in
   * #22 comment 6355747725).
   */
  private floorAcross(t: Target, st: LaneState): Seq {
    let f = this.floor(st);
    for (const lane of lanesByApp.get(this.app)?.get(this.me) ?? []) {
      if (lane === this || !lane.mayCarry(t)) continue;
      const other = lane.states.get(t.id);
      if (other && other.lineage === t.journal.runs) f = Math.min(f, lane.floor(other));
    }
    return f;
  }

  /** Can this connection deliver the session's lifecycle messages: push events, or its channel open? The endpoint asks before a tool promises notifications about the session (the house's read of 2f357bd, #22). */
  carries(sessionId: string): boolean {
    return this.enabled('terminal.live', 'pushEvents') || (this.open.has(channelId(sessionId)) && this.enabled('terminal.channels', 'channels.incoming'));
  }

  /** Can this connection carry the session now, or once an open of its channel in flight completes? Only such a lane counts in `floorAcross`. */
  private mayCarry(t: Target): boolean {
    // An open completes into carrying only with channels.incoming: asked of the opening alone, a lane granted
    // channels.lifecycle without it was pinned at the open and counted here through the history read, then could
    // carry nothing, its pin left inert (an independent read of the lane fixes on PR #22, comment 6376365550).
    return this.carries(t.id) || (this.opening.get(channelId(t.id))?.lineage === t.journal.runs && this.enabled('terminal.channels', 'channels.incoming'));
  }

  /** The sessions this lane may carry now (see `mayCarry`), among those its principal may observe. */
  private mayCarryNow(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.app.registry.list()) {
      const t = targetOf(entry);
      if (this.app.can(this.me, entry, 'observe') && this.mayCarry(t)) ids.add(t.id);
    }
    return ids;
  }

  /**
   * The lane can carry the session again: a channel opens, or the grant widens. While it could not, it dropped each
   * debt whose message it met with nothing to carry it on (see `uncarried`): what it still owes is carried by a message
   * of its own, or is a message still to be built, which settles when it comes, and a summary left standing with no
   * retry is retired by the catch-up the regain starts. So the session is only pinned at `delivered`, until a catch-up
   * planned after this scans it: a lane owing nothing has no floor, and its first settle would lift `delivered` past
   * what no connection delivered, such as a completion the opening parked whose outcome a synchronous call returned
   * meanwhile, settled as the open finishes, or anything settled before a catch-up already running lets the queued
   * one start (an independent read of the lane fixes, #22 comment 6376365550).
   */
  private regain(t: Target): void {
    if (!this.current(t)) return;
    const st = this.stateOf(t);
    const { delivered } = t.cursorsOf(this.me);
    st.regainPin = delivered < t.journal.lastSeq ? { at: delivered } : undefined;
  }

  /**
   * A message the lane can't carry, its retry's timer having found nothing to carry it on, or `deliver` having found
   * push off and the channel closed: its debt goes, unless another message of its own still carries the seq, and the
   * cursor stays where it is. The message is the principal's, found from `delivered` by a catch-up if it is still
   * owed then. Kept, a debt owed only while the channel was open, which no catch-up finds owed after it closed, held
   * every connection of the principal below it for good once this lane could carry the session again (an independent
   * read of the lane fixes, #22 comment 6376365550).
   */
  private uncarried(t: Target, st: LaneState, seq: Seq): void {
    if (!this.carried(t, st).has(seq)) st.owed.delete(seq);
  }


  /** A closed life's owed entries whose message will never come (its segmenter has drained) stop pinning the cursor (mcpl-7). */
  private releaseUnsettled(t: Target, upTo: Seq): void {
    const st = this.stateOf(t);
    const carried = this.carried(t, st);
    for (const seq of st.owed) if (seq <= upTo && !carried.has(seq)) st.owed.delete(seq);
    this.advance(t, st);
  }

  /**
   * The seqs a message of their own still carries: in flight, retried, held for a synchronous result (G28),
   * or held for an open of the channel still in flight, which goes out when the open completes. Their debts
   * stay until that message settles: released, a catch-up lifting clearTo let `delivered` pass one before any
   * host received it, and the host's later refusal was settled as accepted (a reviewer's read of the fixes for
   * #22 comment 6270045466).
   */
  private carried(t: Target, st: LaneState): Set<Seq> {
    // Only this lineage's opening: another's, a forgotten name's still reading its history, holds another journal's
    // seqs, which counted here pinned this lineage's debts (the house's read of 4860d4c, #22).
    // Lifecycle messages only: an ambient one is neither retried nor owed, so refused it left the seq it shared with a
    // summary owed, carried by nothing (the house's lean on #22's lane questions).
    const o = this.opening.get(channelId(t.id));
    const opening = o?.lineage === t.journal.runs ? [...o.held.values()].flatMap((h) => (h.seg.lifecycle ? [h.seg.seq] : [])) : [];
    const held = [...st.held.values()].flatMap((h) => (h.seq === undefined ? [] : [h.seq]));
    const inflight = [...st.inflight.values()].flatMap((seq) => (seq === undefined ? [] : [seq]));
    return new Set([...inflight, ...[...st.retries.values()].map((r) => r.seq), ...opening, ...held]);
  }

  private remember(id: string): void {
    this.sent.add(id);
    if (this.sent.size > SENT_MAX) this.sent.delete(this.sent.values().next().value!);
  }

  /** Retry only lifecycle messages. Progress can be superseded; outcomes cannot.
   * Back off to 30s on a persistently rejecting host, and recheck policy on every attempt. */
  private retry(t: Target, seg: Segment): void {
    if (this.disposed) return;
    if (!this.current(t)) return;
    const st = this.stateOf(t);
    const id = qualify(seg.messageId);
    st.inflight.delete(id);
    // An accepted catch-up summary (or another connection) may have covered this
    // message while its earlier request was still waiting for a refusal.
    if (seg.seq <= t.cursorsOf(this.me).delivered) return this.settleSegment(t, seg, 'accepted');
    this.sent.delete(id);
    if (!seg.lifecycle) return;
    // A summary pins the cursor by its own entry, and one folded into a later summary is not sent again.
    if (seg.kind === 'summary') {
      if (!st.summaries.has(id)) return;
    } else this.owe(st, seg.seq);
    let r = st.retries.get(id);
    if (!r) {
      st.retries.set(id, (r = { seq: seg.seq, kind: seg.kind, attempt: 0 }));
      this.foldRetries(t, st);
      if (!st.retries.has(id)) return;
    }
    if (r.timer) return;
    const retry = r;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      if (this.disposed) return;
      if (this.carries(t.id)) return this.deliver(t, seg, { released: true });
      // Nothing to carry it on: the retry can't fire again, so it goes, and so does its debt (see `uncarried`).
      if (st.retries.get(id) === retry) st.retries.delete(id);
      this.uncarried(t, st, seg.seq);
    }, retryDelay(retry.attempt++));
    retry.timer.unref?.();
  }

  /**
   * At most `McplLane.retryMax` refused lifecycle messages of a session are retried one by one. Past it,
   * all but the newest half are folded into one summary, retried in their place, which says how many of
   * each and where to read them: a host that refused every lifecycle message held a retry entry, its
   * message and a backed-off timer for every Run's end and Service change, without bound (the house's
   * read of the 40 commits through f3750e4, #22 comment 6310921374). What is folded is not settled: the
   * summary pins the cursor below its oldest message until the host accepts it (G22), and the log says
   * so. A summary folded before and not in flight is folded into the new one, so a session keeps one.
   *
   * A message whose resend still waits for the host's answer is not folded: refused, it is owed alone
   * again, so it was retried alone, counted by the summary, and counted again by a later fold (an
   * independent read of the fold, #22: 30 refused completions read as 4 alone and 33 in summaries when
   * the host answered 700 ms late). The oldest of the rest go, the one just refused among them, so no
   * more than `retryMax` are retried alone after a fold.
   */
  private foldRetries(t: Target, st: LaneState): void {
    const singles = [...st.retries].filter(([, r]) => r.kind !== 'summary');
    const keep = Math.floor(McplLane.retryMax / 2);
    if (singles.length <= McplLane.retryMax) return;
    const o: Omitted = { count: 0, from: Number.POSITIVE_INFINITY, to: 0, kinds: {} };
    const add = (x: Omitted): void => {
      o.count += x.count;
      o.from = Math.min(o.from, x.from);
      o.to = Math.max(o.to, x.to);
      for (const [k, n] of Object.entries(x.kinds)) o.kinds[k] = (o.kinds[k] ?? 0) + n;
    };
    const drop = (id: string): void => {
      const r = st.retries.get(id);
      if (r?.timer) clearTimeout(r.timer);
      st.retries.delete(id);
    };
    const idle = singles.filter(([id]) => !st.inflight.has(id));
    for (const [id, r] of idle.slice(0, singles.length - keep)) {
      drop(id);
      st.owed.delete(r.seq);
      add({ count: 1, from: r.seq, to: r.seq, kinds: { [r.kind]: 1 } });
    }
    const fresh = o.count;
    for (const [id, summary] of st.summaries) {
      if (!summary.folded || st.inflight.has(id)) continue;
      add(summary.folded);
      st.summaries.delete(id);
      drop(id);
      this.sent.delete(id);
    }
    const seg = this.summary(t, o, undefined, { refused: true });
    st.summaries.set(qualify(seg.messageId), { from: o.from, covered: new Set(), folded: o });
    this.log(`the host refused more than ${McplLane.retryMax} lifecycle messages of ${t.id}: the oldest ${fresh} are folded into one summary (${o.count} in all, seq ${o.from}–${o.to}), retried in their place; they stay owed until the host accepts it`, 'warn');
    this.deliver(t, seg);
  }

  // ───────────── delivery ─────────────

  /**
   * Is this lifecycle event owed to the principal (G22, G28)? Everything on an open channel;
   * otherwise its own: sessions it owns, Runs it started (or a restart lost for it), Services
   * and Watches it set up. Another principal's watch is never its business.
   */
  private owed(t: Target, ev: LifecycleEvent, open: boolean, runs: { run(runId: string): RunInfo }, lostBy: Principal[] = []): boolean {
    if (ev.type === 'watch.fired') return open || ev.principal === this.me;
    if (ev.type === 'note') return false;
    if (open || t.owner === this.me || lostBy.includes(this.me)) return true;
    if (ev.type === 'run.end' || ev.type === 'run.waiting') return runOf(runs, ev.runId)?.principal === this.me;
    return ev.type === 'service' && ev.principal === this.me;
  }

  /** Synchronous bookkeeping at the moment events happen: what is owed (G22) and what a synchronous call may return (G28). */
  private onJournal(session: Session, ev: JournalEvent): void {
    if (ev.type !== 'run.end' && ev.type !== 'session.exit' && ev.type !== 'service' && ev.type !== 'watch.fired' && ev.type !== 'run.waiting') return;
    if (ev.type === 'service' && ev.status === 'starting') return;
    const st = this.stateOf(session);
    const run = ev.type === 'run.end' ? runOf(session, ev.runId) : undefined;
    if (ev.type === 'run.end' && !run) return;
    if (run && this.maySyncReturn(session, run)) {
      // Held, not dropped (mcpl-1): if the call that is waiting never returns the outcome, the message goes out.
      st.held.set(run.runId, { since: clocks.monotonic(), seq: ev.seq });
      this.owe(st, ev.seq);
    } else if (this.owed(session, ev, this.openOrOpening(channelId(session.id)), session) || (ev.type === 'session.exit' && this.hasRunIn(session))) this.owe(st, ev.seq);
  }

  /**
   * May a synchronous call of this principal still return the Run's outcome? An `await`
   * (or `run`) in flight says so (§10.2: checked in the journal listener for run.end);
   * `start` waits on the service monitor instead, so a young service Run of ours counts too.
   */
  private maySyncReturn(session: Session, run: RunInfo): boolean {
    if (session.isAwaitedBy(run.runId, this.me)) return true;
    // The Run's age on the monotonic clock (see Session.runAgeMs): a Run this daemon life did not admit has no start in flight here.
    const age = session.runAgeMs(run.runId);
    return run.principal === this.me && age !== undefined && this.app.extras(session).services.get(run.runId) !== undefined && age < this.app.maxWaitMs + HOLD_MS;
  }

  private onSegment(session: Session, seg: Segment): void {
    if (this.disposed || !this.policyReceived) return;
    this.deliver(session, seg);
  }

  private deliver(t: Target, seg: Segment, opts: { released?: boolean } = {}): void {
    if (this.disposed) return;
    const st = this.stateOf(t);
    const id = qualify(seg.messageId);
    // Once per connection (mcpl-8): catch-up and the live path can meet on one message.
    if (this.sent.has(id)) {
      // Catch-up can encounter an already accepted message behind an earlier gap.
      if (!st.inflight.has(id) && !st.retries.has(id)) this.settleSegment(t, seg, 'accepted');
      return;
    }
    // G28 (and mcpl-13 for a start): what a synchronous result carried is not sent again — and is no
    // longer held: the entry the journal listener made stayed for every synchronous Run (the house's read of 2f357bd, #22).
    if (this.returnedSeg(t, seg)) {
      this.unhold(st, this.heldKey(seg));
      return this.settleSegment(t, seg, 'accepted');
    }
    if (!opts.released && this.shouldHold(t, st, seg)) return this.hold(t, st, seg);
    // Never a principal's own note back to it (mcpl-14).
    if (seg.kind === 'note' && seg.author === this.me) return this.settleSegment(t, seg, 'not-owed');
    const cid = channelId(t.id);
    // The name's channel carries the name's lineage only: a forgotten name's late message (a draining
    // segmenter's, a hold that ran out) goes a closed channel's way, never on the channel or into the
    // opening of the session re-created under the name (the house's read of the 38 commits (PR #22,
    // comment 6274370651); a reviewer's read of the fixes for #22).
    const ours = this.current(t);
    // An open of the channel is reading its history: held until the open completes or fails (see `opening`).
    const opening = !ours || this.open.has(cid) ? undefined : this.opening.get(cid);
    if (opening?.lineage === t.journal.runs) {
      if (!opening.held.has(id)) opening.held.set(id, { t, seg });
      return;
    }
    if (ours && this.open.has(cid) && this.enabled('terminal.channels', 'channels.incoming')) {
      const msg = this.message(t, seg);
      this.remember(msg.messageId);
      st.inflight.set(id, seg.lifecycle ? seg.seq : undefined);
      this.batch.push({ t, seg, msg });
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => void this.flush(), BATCH_MS);
        this.batchTimer.unref?.();
      }
      return;
    }
    if (!seg.lifecycle || !this.pushedTo(t, seg)) return this.settleSegment(t, seg, 'not-owed');
    if (!this.enabled('terminal.live', 'pushEvents')) {
      // Push off and the channel closed: nothing carries the message (see `uncarried`). Its own retry goes too when it
      // has already fired, as one whose message the channel's close sent back from the batch has: kept until an answer
      // that will never come, it counted as carrying the seq and could not fire again (an independent read of the lane
      // fixes, #22 comment 6376365550). One whose timer is still pending fires, and its debt stays.
      this.settleSegment(t, seg, 'refused');
      const own = st.retries.get(id);
      if (own && !own.timer) st.retries.delete(id);
      return this.uncarried(t, st, seg.seq);
    }
    this.push(t, seg);
  }

  /**
   * Whom a lifecycle message reaches by push while the channel is closed (G28): those with explicit
   * interest, and the session's owner — except a watch, which is only its setter's business, as
   * catch-up already judged it; the live path pushed another principal's watch to the owner
   * (the house's read of 2f357bd, #22).
   */
  private pushedTo(t: Target, seg: Segment): boolean {
    if (seg.interested.includes(this.me)) return true;
    return t.owner === this.me && seg.kind !== 'watch';
  }

  private shouldHold(t: Target, st: LaneState, seg: Segment): boolean {
    if (seg.runId === undefined) return false;
    if (seg.kind === 'run') return st.held.has(seg.runId);
    const session = liveOf(t);
    if (seg.kind !== 'service' || !session) return false;
    const w = this.watched.get(t.id);
    const run = runOf(session, seg.runId);
    return w !== undefined && run !== undefined && this.maySyncReturn(session, run);
  }

  /**
   * Withhold until the synchronous result is on the wire (settled as delivered), or the call
   * ended without it, or the hold ran out (sent): a completion is never lost because the call
   * that was waiting for it was orphaned (mcpl-1).
   */
  private hold(t: Target, st: LaneState, seg: Segment): void {
    const key = this.heldKey(seg)!;
    let h = st.held.get(key);
    if (!h) st.held.set(key, (h = { since: clocks.monotonic(), seq: seg.seq }));
    if (h.timer) return; // already waiting on it
    this.owe(st, seg.seq);
    const held = h;
    const check = () => {
      held.timer = undefined;
      if (this.disposed) return;
      if (this.returnedSeg(t, seg)) {
        st.held.delete(key);
        return this.settleSegment(t, seg, 'accepted');
      }
      // The hold's age is monotonic: on the wall clock a step forward released it at the next check and
      // a step back stretched it by the step (the house's correction, comment 6270946953 on #22).
      if (clocks.monotonic() - held.since >= HOLD_MS) {
        st.held.delete(key);
        return this.deliver(t, seg, { released: true });
      }
      held.timer = setTimeout(check, HOLD_POLL_MS);
      held.timer.unref?.();
    };
    check();
  }

  private push(t: Target, seg: Segment): void {
    const st = this.stateOf(t);
    const msg = this.message(t, seg);
    const cid = channelId(t.id);
    this.remember(msg.messageId);
    st.inflight.set(msg.messageId, seg.seq);
    this.out
      .request('push/event', {
        featureSet: 'terminal.live',
        eventId: msg.messageId,
        timestamp: msg.timestamp,
        tags: msg.tags,
        // The origin names the session's channel (`channelId`) but not a channel to reply in
        // (`mcplChannelId`): a completion is news about the agent's own work, not a message to
        // answer, and a host that answered where `mcplChannelId` pointed made the agent's
        // reply a note in the terminal and left the channel open (the house's review of #11).
        origin: { server: 'terminal', channelId: cid, ...flat(msg.metadata) },
        payload: { content: msg.content },
      })
      .then((r) => {
        const res = r as { accepted?: boolean; reason?: string } | undefined;
        if (res?.accepted !== false || res?.reason === 'duplicate') return this.settleSegment(t, seg, 'accepted');
        // Retrying is the design (G22); the log says why the cursor stays pinned (the house's read of 2f357bd, #22).
        this.log(`push/event refused (${res.reason ?? 'no reason given'}): ${msg.messageId}; it stays owed and is retried`);
        this.retry(t, seg);
      })
      .catch((e) => {
        this.retry(t, seg);
        this.log(`push/event failed: ${(e as Error).message}`);
      });
  }

  private async flush(): Promise<void> {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    const items = this.batch.splice(0);
    if (!items.length) return;
    // A reduction or a close since they were queued binds (SPEC §6.7, mcpl-19), and so does a forgotten
    // name's lineage (see `deliver`): those are routed again.
    const send: typeof items = [];
    for (const i of items) {
      if (this.current(i.t) && this.open.has(channelId(i.t.id)) && this.enabled('terminal.channels', 'channels.incoming')) send.push(i);
      else {
        this.stateOf(i.t).inflight.delete(i.msg.messageId);
        this.sent.delete(i.msg.messageId);
        this.deliver(i.t, i.seg, { released: true });
      }
    }
    if (!send.length) return;
    try {
      const r = (await this.out.request('channels/incoming', { messages: send.map((i) => i.msg) })) as { results?: Array<{ messageId: string; accepted: boolean; reason?: string }> };
      const refused: string[] = [];
      let ambient = 0;
      for (const i of send) {
        const x = r?.results?.find((y) => y.messageId === i.msg.messageId);
        if (!r?.results || x?.accepted === true || x?.reason === 'duplicate') this.settleSegment(i.t, i.seg, 'accepted');
        else {
          if (i.seg.lifecycle) refused.push(`${i.msg.messageId} (${x === undefined ? 'no receipt' : (x.reason ?? 'no reason given')})`);
          else ambient++;
          this.retry(i.t, i.seg);
        }
      }
      // Refused lifecycle messages stay owed and pin the cursor (G22): the log says which and why (the house's read of 2f357bd, #22).
      if (refused.length) this.log(`channels/incoming refused ${refused.length} lifecycle message${refused.length > 1 ? 's' : ''}: ${refused.join(', ')}; they stay owed and are retried${ambient ? ` (and ${ambient} ambient, not retried)` : ''}`);
    } catch (e) {
      for (const i of send) this.retry(i.t, i.seg);
      this.log(`channels/incoming failed: ${(e as Error).message}`);
    }
  }

  // ───────────── catch-up (G22) ─────────────

  /**
   * Lifecycle messages owed since the principal's delivered cursor, for every session it
   * may observe — history-only ones too (mcpl-2): each journal is read from the cursor to
   * its end in pages (mcpl-3). What is owed is the principal's own (Runs, Watches,
   * Services, sessions it owns) or everything on an open channel; exits a later life
   * superseded are not news (ux-25). At most CATCHUP_LIMIT messages go, newest first
   * across sessions; the rest of each session is one summary with the cursor to read it.
   */
  private async catchUpAll(only?: Set<string>): Promise<void> {
    const plans: Array<{ t: Target; st: LaneState; src: ReplaySource; from: Seq; open: boolean; covered: Set<Seq>; retire: string[]; pin: LaneState['regainPin']; left?: Set<Seq>; scan?: LifecycleScan }> = [];
    // Every floor goes up before any scan yields, so the live path cannot move a cursor past what a scan has yet to find.
    for (const entry of this.app.registry.list()) {
      if (!this.app.can(this.me, entry, 'observe')) continue;
      const t = targetOf(entry);
      if (only && !only.has(t.id)) continue;
      const from = t.cursorsOf(this.me).delivered;
      if (from >= t.journal.lastSeq || !this.carries(t.id)) continue;
      const st = this.stateOf(t);
      st.scanningFrom = from;
      // The summaries this catch-up may retire are those standing now: one made while it scans may hold what it won't find.
      const retire = [...st.summaries.keys()].filter((id) => !st.inflight.has(id));
      plans.push({ t, st, src: this.sourceOf(entry), from, open: this.openOrOpening(channelId(t.id)), covered: new Set(), retire, pin: st.regainPin });
    }
    // A regain pin goes with the scan planned under it once that scan has returned; a scan that fails keeps it, and
    // runs again (see `scanAgain`). One set while this catch-up scans is the queued catch-up's to release: this one
    // planned before the session was regained, and its scan may have read past what the lane then owed nothing for
    // (see `regain`).
    const unpin = (): void => {
      for (const p of plans) if (p.pin !== undefined && p.st.regainPin === p.pin) p.st.regainPin = undefined;
    };
    try {
      for (const p of plans) {
        if (this.disposed) return;
        p.scan = await scanLifecycle(p.src, p.from, { keep: CATCHUP_LIMIT, accept: (pk) => {
          if (!this.owedOnCatchUp(p.t, p.st, p.src, pk, p.open)) return false;
          // Remember only existing debts, not every event in an arbitrarily long
          // journal. Held outcomes and separately replayed messages stay separate.
          if (p.st.owed.has(pk.ev.seq)) p.covered.add(pk.ev.seq);
          return true;
        } });
      }
    } catch (e) {
      // The regain pins stay: with the scan still to come (see `scanAgain`), they are the only hold on the cursor of a
      // lane that owed nothing while it could not carry the session.
      for (const p of plans) p.st.scanningFrom = undefined;
      throw e;
    }
    unpin();
    // Only once every scan has returned, while scanningFrom still holds each floor: retired before, a scan that
    // failed left the summaries gone and the floor lowered, and delivered could pass what they stood for (the
    // house's read of a8b6f28, #22).
    for (const p of plans) p.left = this.retireSummaries(p.t, p.st, p.retire);
    const all = plans.flatMap((p) => (p.scan?.picked ?? []).map((pk) => ({ p, pk })));
    all.sort((a, b) => b.pk.ev.ts - a.pk.ev.ts || b.pk.ev.seq - a.pk.ev.seq);
    const chosen = new Set(all.slice(0, CATCHUP_LIMIT).map((x) => x.pk));
    const work: Array<{ t: Target; src: ReplaySource; picked: Picked[]; summary?: Segment }> = [];
    for (const p of plans) {
      const scan = p.scan!;
      const picked = scan.picked.filter((pk) => chosen.has(pk));
      const omitted = countOmitted(scan.omitted, scan.picked.filter((pk) => !chosen.has(pk)));
      // What is owed is recorded before the scan's floor lifts; everything else up to the scan's end is settled.
      for (const pk of picked) {
        this.owe(p.st, pk.ev.seq);
        p.covered.delete(pk.ev.seq);
      }
      const w: (typeof work)[number] = { t: p.t, src: p.src, picked };
      const carried = this.carried(p.t, p.st);
      // A debt whose event retention took lies in a range the scan reports lost, where no event is found to cover
      // it: the summary naming the range covers it, unless a message of its own still carries it. Left out,
      // completions owed while nothing carried the session, and those a retired summary had covered, pinned the
      // cursor for the life of the connection once their events were gone (the house's read of a8b6f28, #22: by
      // run).
      if (scan.lost?.length) {
        for (const seq of p.st.owed) if (scan.lost.some((g) => g.from <= seq && seq <= g.to)) p.covered.add(seq);
      }
      // Whatever a message of its own still carries, found past the cap or lost, stays that message's debt: covered,
      // the summary's acceptance let `delivered` pass a message still to go out and dropped its retry, so its refusal
      // was neither retried nor owed (a reviewer's read of the fixes for #22; the house's read of 4860d4c..bc4bc85,
      // #22, for the past-the-cap path).
      for (const seq of carried) p.covered.delete(seq);
      // What a retired summary covered that this scan neither replays nor covers, found or lost, and no message
      // carries, the scan found owed no more, as a debt owed only while the channel was open is once it has
      // closed: kept, it pinned the cursor for the life of the connection (a reviewer's read of the fixes for #22).
      const replayed = new Set(picked.map((pk) => pk.ev.seq));
      for (const seq of p.left ?? []) if (!replayed.has(seq) && !p.covered.has(seq) && !carried.has(seq)) p.st.owed.delete(seq);
      // One summary for what the host will not see replayed: the messages past the cap, and the
      // range retention took before the scan began, which the scan reports and nothing can replay
      // (the segmenter's read, comment 6265082050 on #22: the catch-up never told the host of it).
      if (omitted || scan.lost?.length) {
        const gaps = scan.lost ?? [];
        // The summary pins at the earliest of what it names (`summaryFloor`): pinned later, it let the cursor
        // pass the gone range before the host acknowledged it, and the reconnect's rescan, starting past
        // the gap, named only the omitted messages (the house's read of 78c4d6e, #22).
        const from = summaryFloor(omitted, gaps);
        const to = omitted?.to ?? gaps[gaps.length - 1]!.to;
        this.owe(p.st, to);
        w.summary = this.summary(p.t, omitted, scan.lost);
        p.st.summaries.set(qualify(w.summary.messageId), { from, covered: p.covered, owes: to });
      }
      if (scan.end > p.st.clearTo) p.st.clearTo = scan.end;
      p.st.scanningFrom = undefined;
      this.advance(p.t, p.st);
      work.push(w);
    }
    for (const w of work) {
      if (this.disposed) return;
      if (w.summary) this.deliver(w.t, w.summary);
      const segs = await renderPicked(w.src, w.picked);
      const built = new Set(segs.map((s) => s.seq));
      for (const pk of w.picked) if (!built.has(pk.ev.seq)) this.settle(w.t, pk.ev.seq, 'not-owed');
      for (const seg of segs) {
        if (this.disposed) return;
        this.deliver(w.t, seg);
      }
    }
  }

  /**
   * A catch-up scans from the delivered cursor, and every pending summary pins that cursor below what it
   * stands for, so the scan finds all of it again: it replays what it can and names the rest in its own
   * summary, which covers the debts it finds and those in the ranges it reports lost. Each summary of `ids`
   * not in flight goes, with its retry, the seq it owes and its place in an opening of the session's channel.
   * Kept, a fold made while nothing carried the session had no retry and pinned the cursor for the life of the
   * connection, its messages never sent; a fold the catch-up replayed counted them a second time once
   * accepted; and refused catch-up summaries, which never fold, piled up one per catch-up (the house's read of
   * 4f4c067, #22). Its owed seq stayed owed once retention moved past it, since nothing then had that seq to
   * settle it (a reviewer's read of the retirement, #22). Parked for an opening, it went out when the open
   * finished, beside what replaced it (the house's read of a8b6f28, #22). Its covered debts, returned, stay
   * until the summary that replaces it is accepted, or go once the scan finds them owed no more. One in flight settles by its answer. One whose answer was lost after
   * its request timed out may still reach the host, which then hears of its messages twice, as G22's
   * at-least-once allows.
   */
  private retireSummaries(t: Target, st: LaneState, ids: string[]): Set<Seq> {
    const opening = this.opening.get(channelId(t.id));
    const covered = new Set<Seq>();
    for (const id of ids) {
      const summary = st.summaries.get(id);
      if (!summary || st.inflight.has(id)) continue;
      st.summaries.delete(id);
      for (const seq of summary.covered) covered.add(seq);
      const r = st.retries.get(id);
      if (r?.timer) clearTimeout(r.timer);
      st.retries.delete(id);
      this.sent.delete(id);
      opening?.held.delete(id);
      // Its owed seq goes with it, unless another message still carries that seq (see settleSegment): asked once its
      // own retry and parked copy are gone, which carry it too.
      if (summary.owes !== undefined && !this.carried(t, st).has(summary.owes)) st.owed.delete(summary.owes);
    }
    return covered;
  }

  private owedOnCatchUp(t: Target, st: LaneState, src: ReplaySource, { ev, lost }: Picked, open: boolean): boolean {
    // A held completion is the live path's to decide; what a synchronous call returned is settled.
    if (ev.type === 'run.end' && (st.held.has(ev.runId) || this.returned(t, ev.runId))) return false;
    if (ev.type === 'service' && this.returned(t, ev.runId, { status: ev.status, seq: ev.seq })) return false;
    return this.owed(t, ev, open, src, lost?.principals);
  }

  /**
   * One message for what a catch-up did not replay (ux-25): how many of each and where to read them,
   * and the ranges the scan found gone, with whatever they held, which no read brings back (the
   * segmenter's read, comment 6265082050 on #22). Every gap the scan kept is named, not only the first
   * (comment 6269992150), each with why in a read's words (`describeGap`): all were called past
   * retention, a torn write's or a failed store's hole too (a reviewer's read of the fixes for #22). At
   * least one of the two is given.
   */
  private summary(t: Target, o: Omitted | undefined, lost: LifecycleScan['lost'], how: { refused?: boolean } = {}): Segment {
    const names: Record<string, string> = { run: 'completions', service: 'service changes', watch: 'watch firings', 'session-exit': 'shell exits', recovered: 'restarts', 'needs-input': 'input prompts' };
    const gaps = lost ?? [];
    const parts: string[] = [];
    const why = how.refused ? 'refused on delivery and no longer sent one by one' : 'while you were away not replayed';
    if (o) parts.push(`${o.count} earlier message${o.count > 1 ? 's' : ''} ${why} (${Object.entries(o.kinds).map(([k, n]) => `${n} ${names[k] ?? k}`).join(', ')}) · seq ${o.from}–${o.to}`);
    if (gaps.length) parts.push(`seq ${goneText(gaps)} gone, with whatever happened then`);
    const to = o?.to ?? gaps[gaps.length - 1]!.to;
    const since = o ? Math.max(0, o.from - 1) : gaps[gaps.length - 1]!.to;
    const metadata: Record<string, unknown> = { session: t.id, state: liveOf(t)?.state ?? 'exited', count: o?.count ?? 0, from: o?.from ?? gaps[0]!.from, to, kinds: o?.kinds ?? {} };
    // Two scalars, not a range object or a list: a push event's origin carries scalar metadata only. They are one
    // span, from the first gap's start to the last gap's end, so seqs delivered between two gaps lie inside it; the
    // text names each gap, and DESIGN §10.2 says so for hosts (the house's read of the 38 commits, #22, comment 6274773484).
    if (gaps.length) Object.assign(metadata, { lostFrom: gaps[0]!.from, lostTo: gaps[gaps.length - 1]!.to });
    if (how.refused) metadata.refused = true;
    return {
      kind: 'summary',
      lifecycle: true,
      seq: to,
      ts: Date.now(),
      // Its own id, by its range: a catch-up's summary can end at the same seq as one still in flight that named
      // less, which then took this one's entry and settled what its host never heard of (the house's read of
      // 4860d4c, #22), and a later fold can end there too and name more. Two of the same range share one, and the newer,
      // never sent, takes the older's entry: beyond the gaps and the omitted span the older's message names, it covers
      // only debts the older's scan found not owed, of the kind `left` drops as owed no more when a retired summary
      // held one, so its acceptance settles nothing the host should have heard of (reviewers' reads of 4860d4c and of
      // 4860d4c..bc4bc85, #22).
      messageId: segmentId(t.id, t.journal, 'summary', to, how.refused ? `refused-${o!.from}` : `${summaryFloor(o, gaps)}`),
      tags: ['terminal:missed'],
      // `as=events`: a plain read projects text, which has no exit statuses or service changes in it (the house's read of 2f357bd, #22).
      head: `[terminal] ${t.id}: ${parts.join(' · ')} · read session=${t.id} since=${since} as=events`,
      metadata,
      interested: [this.me],
    };
  }

  // ───────────── rendering, per recipient ─────────────

  /** A segment as this principal sees it: origin and sender tags are relative to the reader; tags are a set (mcpl-15). */
  private message(t: Target, seg: Segment): IncomingMessage {
    const tags = new Set(seg.tags);
    const author = seg.author;
    if (author !== undefined) {
      const rel = author === this.me ? 'self' : author.startsWith('human:') ? 'human' : author === 'system' ? 'system' : 'agent';
      if (seg.kind === 'run') tags.add(`terminal:origin=${rel}`);
      if (rel !== 'system') tags.add(`chat:from-${rel}`);
    }
    let head = seg.head;
    if (seg.kind === 'output' && seg.runId !== undefined) {
      const unread = this.watched.get(t.id)?.segmenter.unreadBytes(seg.runId, t.cursorsOf(this.me).read) ?? 0;
      if (unread > 0) head += ` · ${fmtBytes(unread)} new since your last read`;
    }
    const metadata: Record<string, unknown> = { node: NODE_NAME, ...seg.metadata, seq: seg.seq, kind: seg.kind };
    if (seg.supersedes) metadata.supersedes = qualify(seg.supersedes);
    return {
      channelId: channelId(t.id),
      messageId: qualify(seg.messageId),
      author: author !== undefined ? { id: author, name: author } : { id: 'terminal', name: t.id },
      timestamp: new Date(seg.ts).toISOString(),
      content: [{ type: 'text', text: seg.body ? `${head}\n${seg.body}` : head }],
      metadata,
      tags: [...tags],
    };
  }

  dispose(): void {
    this.disposed = true;
    const byPrincipal = lanesByApp.get(this.app);
    const lanes = byPrincipal?.get(this.me);
    if (lanes) {
      lanes.delete(this);
      if (!lanes.size) byPrincipal!.delete(this.me);
    }
    if (this.grantTimer) clearTimeout(this.grantTimer);
    this.grantTimer = undefined;
    for (const w of this.watched.values()) w.off();
    this.watched.clear();
    this.opening.clear();
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.catchUpRetry?.timer) clearTimeout(this.catchUpRetry.timer);
    for (const st of this.states.values()) for (const h of st.held.values()) if (h.timer) clearTimeout(h.timer);
    for (const st of this.states.values()) for (const r of st.retries.values()) if (r.timer) clearTimeout(r.timer);
  }
}

/**
 * Notes a session holds (mcpl-5): per principal a token bucket (a few a second) and a
 * per-minute cap; per lineage, notes still retained never exceed 1/16 of the session's
 * retention — counted as stored, with no floor, since a 4 KiB floor was a quarter of the
 * smallest retention a session may ask for — so publishing can never evict more than that
 * share of its history. The budget is seeded from the journal once per daemon life (the
 * house's read of 2f357bd, #22). Without a byte cap there is nothing to evict: the share is
 * unbounded and only the rates apply.
 */
class NoteBudget {
  private readonly buckets = new Map<Principal, { tokens: number; at: number; minute: number[] }>();
  private readonly retained: Array<[Seq, number]> = [];
  private bytes = 0;
  private seeded: Promise<void> | undefined;

  /** The bytes notes may hold on a session with this retention, as the journal stores them. */
  static share(retentionBytes: number): number {
    return Math.floor(retentionBytes / NOTE_SHARE);
  }

  /** Count the notes the journal still retains: once, in pages, before the first note of this daemon life. */
  seed(journal: Journal): Promise<void> {
    if (!this.seeded) {
      const seeding = (async () => {
        for (const page of journal.pages((journal.oldestSeq ?? 1) - 1, NOTE_SCAN_PAGE)) {
          for (const ev of page.events) if (ev.type === 'note') this.record(ev.seq, lineBytes(ev));
          if (!page.more) return;
          await new Promise((r) => setImmediate(r));
        }
      })();
      this.seeded = seeding;
      // A count that failed is forgotten with what it had counted, so the next note counts again: kept, one
      // page that could not be read refused every later note on the lineage until the daemon restarted (the
      // house's read of the 40 commits, #22). Nothing else records meanwhile, since every note awaits this.
      seeding.catch(() => {
        if (this.seeded !== seeding) return;
        this.seeded = undefined;
        this.retained.length = 0;
        this.bytes = 0;
      });
    }
    return this.seeded;
  }

  /** `now` is on the monotonic clock: the buckets measure intervals, never a time of day. */
  take(p: Principal, bytes: number, journal: Journal, retentionBytes: number, now: number): { message: string; retryAfterMs: number } | undefined {
    const oldest = journal.oldestSeq ?? 0;
    while (this.retained.length && this.retained[0]![0] < oldest) this.bytes -= this.retained.shift()![1];
    const share = NoteBudget.share(retentionBytes);
    if (this.bytes + bytes > share) {
      return { message: `notes on this session already hold ${fmtBytes(this.bytes)} of the ${fmtBytes(share)} they may use (1/${NOTE_SHARE} of its retention); space frees as retention moves past them`, retryAfterMs: 60_000 };
    }
    const b = this.buckets.get(p) ?? { tokens: NOTE_BURST, at: now, minute: [] };
    b.tokens = Math.min(NOTE_BURST, b.tokens + ((now - b.at) / 1000) * NOTE_RATE_PER_S);
    b.at = now;
    b.minute = b.minute.filter((at) => now - at < 60_000);
    this.buckets.set(p, b);
    if (b.minute.length >= NOTE_PER_MINUTE) return { message: `at most ${NOTE_PER_MINUTE} notes a minute on a session`, retryAfterMs: 60_000 - (now - b.minute[0]!) };
    if (b.tokens < 1) return { message: `notes are limited to ${NOTE_RATE_PER_S} a second (bursts of ${NOTE_BURST})`, retryAfterMs: Math.ceil(((1 - b.tokens) / NOTE_RATE_PER_S) * 1000) };
    b.tokens -= 1;
    b.minute.push(now);
    return undefined;
  }

  record(seq: Seq, bytes: number): void {
    this.retained.push([seq, bytes]);
    this.bytes += bytes;
  }
}

/** Gone ranges in seq order, each run of one reason named once in a read's words: `1–100, 150–226 (past retention), 300–310 (a crash cut the journal short)`. */
function goneText(gaps: ReadonlyArray<Gone>): string {
  const runs: Array<{ reason: GapReason; ranges: string[] }> = [];
  for (const g of gaps) {
    const last = runs[runs.length - 1];
    if (last?.reason === g.reason) last.ranges.push(`${g.from}–${g.to}`);
    else runs.push({ reason: g.reason, ranges: [`${g.from}–${g.to}`] });
  }
  return runs.map((r) => `${r.ranges.join(', ')} (${describeGap(r.reason)})`).join(', ');
}

function flat(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as string | number | boolean;
  return out;
}
