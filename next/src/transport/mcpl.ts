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
import type { AnySession, HistorySession } from '../api/registry.js';
import { CORE_TOOLS, TOOLS, type Tier } from '../api/tools.js';
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
  type LifecycleEvent,
  type LifecycleScan,
  type Omitted,
  type Picked,
  type ReplaySource,
  type Segment,
  type Segmenter,
} from '../core/segmenter.js';
import type { Session } from '../core/session.js';
import type { JournalEvent, Principal, RunInfo, Seq } from '../core/types.js';
import { CAPABILITY_DENIED, CHANNEL_NOT_PERMITTED, INVALID_PARAMS, OVERLOADED, RpcError, UNKNOWN_CHANNEL, type Outbound } from './jsonrpc.js';

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
    'terminal:missed': { desc: 'Messages owed while you were away that a catch-up did not replay (a count and the cursor to read them)', facet: 'lifecycle' },
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
    { tagsAny: ['terminal:run-finished', 'terminal:run-lost', 'terminal:service-ready', 'terminal:service-running', 'terminal:human-input', 'terminal:missed'], behavior: 'immediate' },
    { tagsAny: ['terminal:output', 'terminal:screen', 'terminal:control', 'terminal:note'], behavior: 'throttle' },
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
  /** Message ids whose delivery awaits the host's answer. A summary and an event can share a seq. */
  inflight: Map<string, Seq>;
  /** Failed lifecycle deliveries remain owed, with their original stable message id. */
  retries: Map<string, { seq: Seq; attempt: number; timer?: NodeJS.Timeout | undefined }>;
  /** A summary pins at its oldest event until accepted, then settles the individual debts it covers. */
  summaries: Map<string, { from: Seq; covered: Set<Seq> }>;
  /** Messages withheld while a synchronous call may still return them (G28): key (runId, or `runId:service=status@seq`) → since. */
  held: Map<string, { since: number; seq?: Seq; timer?: NodeJS.Timeout | undefined }>;
  /** Everything up to here is settled for this principal except what is owed: `delivered` may advance to it. */
  clearTo: Seq;
  /** While catch-up scans from here, `delivered` does not pass it. */
  scanningFrom?: Seq | undefined;
}

/** A session as delivery sees it: the live Session of one life, or history; either keeps the principal's cursors (G22). */
type Target = Session | HistorySession;
const targetOf = (entry: AnySession): Target => (entry.kind === 'live' ? entry.session : entry);
const liveOf = (t: Target): Session | undefined => ('kind' in t && t.kind === 'history' ? undefined : (t as Session));

/** Note budgets by lineage (mcpl-5). */
const noteBudgets = new WeakMap<object, NoteBudget>();

/**
 * The lanes of one App, by principal. A principal's `delivered` cursor is one across its
 * connections, so no lane moves it past what another lane of the same principal still owes:
 * a completion owed only through the channel one connection had open was lost when a second
 * connection, channel closed, settled it as none of its business and the first one's retry
 * then found the cursor already past it (the house's read of 2f357bd, #22).
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
  private disposed = false;
  /** Warns, once, when the host has sent no grant this long after initializing: the connection is then on the core tools with no deliveries, and the log should say so rather than look like a profile. */
  static grantWarnMs = 5000;
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
   * never saw. Resuming only this lane's own retries lost a completion to a channels-only host
   * that reconnected and opened the channel after its grant: the grant's catch-up had nothing to
   * carry it on, and the open started none (the house's read of 2f357bd, #22).
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
      .catch((e) => this.log(`catch-up failed: ${(e as Error).message}`))
      .finally(() => {
        this.catchingUp = undefined;
        const again = this.catchUpAgain;
        this.catchUpAgain = undefined;
        if (again && !this.disposed) void this.startCatchUp(again === 'all' ? undefined : again);
      });
    return this.catchingUp;
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

  /**
   * A session's channel descriptor, read from the session itself: a listing of every session
   * through `sessionList`, which summarises services, watches and Runs, made the channel list
   * quadratic in sessions (the house's read of 2f357bd, #22).
   */
  private descriptorFor(entry: AnySession): ChannelDescriptor {
    const sessionId = entry.kind === 'live' ? entry.session.id : entry.id;
    // `speech: 'none'` asks hosts not to route an agent's ordinary replies here (UPSTREAM-CHANGES A6).
    const metadata: Record<string, unknown> = { node: NODE_NAME, speech: 'none' };
    if (entry.kind === 'live') {
      const i = entry.session.info();
      metadata.owner = i.owner;
      if (i.controller !== null) metadata.controller = i.controller;
      metadata.state = i.state;
      metadata.cwd = i.cwd;
      metadata.integration = i.integration;
    } else {
      metadata.owner = entry.owner;
      metadata.state = 'exited';
      if (!entry.closed) metadata.recovered = entry.recovered;
    }
    return {
      id: channelId(sessionId),
      type: 'terminal',
      label: `${sessionId} (node: ${NODE_NAME})`,
      direction: 'bidirectional',
      address: { node: NODE_NAME, session: sessionId },
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
    if (s && this.registered.has(id) && this.channelsOn()) this.out.notify('channels/changed', { updated: [this.descriptorFor(s)] });
  }

  /** A session and its journal are gone (`forget`, retention). A name opened again meanwhile is a different session and stays. */
  async sessionRemoved(sessionId: string): Promise<void> {
    await this.letGo(sessionId);
    if (this.app.registry.get(sessionId)) return; // re-created meanwhile: sessionCreated announced it (mcpl-10)
    const st = this.states.get(sessionId);
    if (st) for (const h of st.held.values()) if (h.timer) clearTimeout(h.timer);
    if (st) for (const r of st.retries.values()) if (r.timer) clearTimeout(r.timer);
    this.states.delete(sessionId);
    const id = channelId(sessionId);
    this.open.delete(id);
    if (this.registered.delete(id) && this.channelsOn()) this.out.notify('channels/changed', { removed: [id] });
  }

  async openChannel(params: {
    type?: string;
    address?: { session?: string };
    channelId?: string;
    history?: { limit?: number; beforeMessageId?: string };
  }): Promise<{ channel: ChannelDescriptor; history?: IncomingMessage[]; historyTruncated?: boolean }> {
    if (!this.has('channels.lifecycle')) throw new RpcError(CAPABILITY_DENIED, 'channels.lifecycle not granted', { capability: 'channels.lifecycle' });
    const sid = params.address?.session ?? (params.channelId ? sessionOf(params.channelId) : undefined);
    if (!sid) throw new RpcError(UNKNOWN_CHANNEL, 'channels/open needs address.session or channelId');
    const id = channelId(sid);
    const s = this.app.registry.get(sid);
    if (!s || !this.app.can(this.me, s, 'observe')) throw new RpcError(UNKNOWN_CHANNEL, `unknown channel ${id}`, { channelId: id });
    this.registered.add(id);
    if (s.kind === 'live') {
      // §9: the owner's connection takes a free seat; everyone else observes. Opening never starts a
      // shell (mcpl-9): a session whose shell ended is followed read-only, its history served.
      if (s.session.exit === undefined) this.attach(s.session);
      if (!s.session.journal.closed) this.follow(s.session);
    }
    const wasOpen = this.open.has(id);
    this.open.add(id);
    if (!wasOpen) this.carryNow(targetOf(s));
    const res: { channel: ChannelDescriptor; history?: IncomingMessage[]; historyTruncated?: boolean } = { channel: this.descriptorFor(s) };
    const raw = params.history?.limit;
    if (raw !== undefined && (typeof raw !== 'number' || Number.isNaN(raw))) throw new RpcError(INVALID_PARAMS, 'history.limit must be a number', { limit: raw });
    // A whole number, never past the cap: a fraction was kept, compared equal to no count, and got everything (the house's read of 2f357bd, #22).
    const limit = raw === undefined ? 0 : Math.min(HISTORY_MAX, Math.max(0, Math.floor(raw)));
    if (limit > 0) {
      const before = params.history?.beforeMessageId !== undefined ? seqOfMessageId(params.history.beforeMessageId) : undefined;
      const r = await replayNewest(this.sourceOf(s), before !== undefined ? { limit, before } : { limit });
      const t = targetOf(s);
      res.history = r.segments.map((seg) => this.message(t, seg));
      if (r.truncated) res.historyTruncated = true;
    }
    return res;
  }

  closeChannel(id: string): { closed: boolean } {
    // §14.1: lifecycle methods need channels.lifecycle, close as much as open (the house's review of #11).
    if (!this.has('channels.lifecycle')) throw new RpcError(CAPABILITY_DENIED, 'channels.lifecycle not granted', { capability: 'channels.lifecycle' });
    return { closed: this.open.delete(id) };
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
    if (!this.has('channels.publish')) throw new RpcError(CAPABILITY_DENIED, 'channels.publish not granted', { capability: 'channels.publish' });
    if (!this.enabledFeatureSets.has('terminal.annotate')) throw new RpcError(CHANNEL_NOT_PERMITTED, 'terminal.annotate is not enabled', { channelId: params.channelId });
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
    let stored = bytes;
    if (s.kind === 'live' && !s.session.journal.closed) {
      const journal = s.session.journal;
      const retention = s.retention.maxBytes ?? Infinity;
      // What the store will write for it: the event line, with the seq it is about to get (its digits may differ by one).
      stored = storedBytes({ type: 'note', text, principal: this.me, channel: params.channelId, seq: journal.lastSeq + 1, ts: Date.now() });
      const share = NoteBudget.share(retention);
      if (stored > share) {
        const max = Math.max(0, share - (stored - bytes));
        throw new RpcError(INVALID_PARAMS, `a note on this session is at most ${max} bytes (notes may use 1/${NOTE_SHARE} of its ${fmtBytes(retention)} retention, ${fmtBytes(share)} as the journal stores them); write longer text to a file and point to it`, { channelId: params.channelId, bytes, maxBytes: max });
      }
      const lineage = journal.runs;
      budget = noteBudgets.get(lineage);
      if (!budget) noteBudgets.set(lineage, (budget = new NoteBudget()));
      // After a daemon restart the budget starts empty while the journal still holds every note it kept.
      if (Number.isFinite(retention)) await budget.seed(journal);
      const refused = budget.take(this.me, stored, journal, retention, Date.now());
      if (refused) throw new RpcError(OVERLOADED, refused.message, { channelId: params.channelId, retryAfterMs: refused.retryAfterMs });
    }
    try {
      const r = this.app.note(this.caller, { session: sid, text, channel: params.channelId });
      budget?.record(r.seq, stored);
      // Delivered means recorded (mcpl-14): the note is in the session's journal, where the GUI, `read`
      // and other principals' open channels see it. Nobody watching right now is not a failure to report.
      return { delivered: true, messageId: qualify(segmentId(sid, targetOf(s).journal, 'note', r.seq)) };
    } catch (e) {
      if (e instanceof TermError) throw new RpcError(CHANNEL_NOT_PERMITTED, e.message, { channelId: params.channelId, ...e.data });
      throw e;
    }
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

  /** Deliver what the followed life's segmenter still owes (mcpl-6), then stop following that life — only that one (mcpl-10). */
  private async letGo(sessionId: string): Promise<{ session: Session } | undefined> {
    const w = this.watched.get(sessionId);
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

  /** This name's bookkeeping; a journal of another lineage (an old life of a forgotten name) gets a detached one. */
  private stateOf(t: Target): LaneState {
    const lineage = t.journal.runs;
    const cur = this.states.get(t.id);
    if (cur?.lineage === lineage) return cur;
    const entry = this.app.registry.get(t.id);
    const current = entry ? (entry.kind === 'live' ? entry.session.journal.runs : entry.journal.runs) : undefined;
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
  private returned(t: Target, runId: string, service?: string, seq?: Seq): boolean {
    const to = (key: string) => liveOf(t)?.outcomeDeliveredTo(key, this.me) ?? false;
    return service === undefined ? to(runId) : to(`${runId}:service=${service}@${seq}`) || (service === 'exited' && to(runId));
  }

  private returnedSeg(t: Target, seg: Segment): boolean {
    if (seg.runId === undefined || (seg.kind !== 'run' && seg.kind !== 'service')) return false;
    return seg.kind === 'service' ? this.returned(t, seg.runId, String(seg.metadata.service), seg.seq) : this.returned(t, seg.runId);
  }

  /** The key a withheld message is held under: its Run, or one service status event (two returns to a status are two messages). */
  private heldKey(seg: Segment): string | undefined {
    if (seg.runId === undefined) return undefined;
    if (seg.kind === 'run') return seg.runId;
    return seg.kind === 'service' ? `${seg.runId}:service=${String(seg.metadata.service)}@${seg.seq}` : undefined;
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
    return f;
  }

  /**
   * A message was accepted, or is owed to nobody here: `delivered` advances, but never
   * past a lifecycle message still owed to this principal (G22). A completion the
   * principal's synchronous call returned counts as accepted (mcpl-1); so does a host's
   * `duplicate` answer (mcpl-7). Refusal is not delivery: it keeps pinning the cursor.
   */
  private settle(t: Target, seq: Seq, how: Settled): void {
    const st = this.stateOf(t);
    if (how === 'refused') return;
    st.owed.delete(seq);
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
    this.settle(t, seg.seq, how);
  }

  private advance(t: Target, st: LaneState): void {
    // A connection that cannot carry this session's lifecycle messages leaves the cursor where it is:
    // they stay owed for one that can (G22).
    if (!this.carries(t.id)) return;
    t.markDelivered(this.me, Math.min(st.clearTo, this.floorAcross(t, st)));
  }

  /** The lowest floor among this principal's connections for the session: `delivered` is theirs together (see `lanesByApp`). */
  private floorAcross(t: Target, st: LaneState): Seq {
    let f = this.floor(st);
    for (const lane of lanesByApp.get(this.app)?.get(this.me) ?? []) {
      if (lane === this) continue;
      const other = lane.states.get(t.id);
      if (other && other.lineage === t.journal.runs) f = Math.min(f, lane.floor(other));
    }
    return f;
  }

  /** Can this connection deliver the session's lifecycle messages: push events, or its channel open? */
  private carries(sessionId: string): boolean {
    return this.enabled('terminal.live', 'pushEvents') || (this.open.has(channelId(sessionId)) && this.enabled('terminal.channels', 'channels.incoming'));
  }

  /** A closed life's owed entries whose message will never come (its segmenter has drained) stop pinning the cursor (mcpl-7). */
  private releaseUnsettled(t: Target, upTo: Seq): void {
    const st = this.stateOf(t);
    const held = new Set([...st.held.values()].map((h) => h.seq));
    const pending = new Set([...st.inflight.values(), ...[...st.retries.values()].map((r) => r.seq)]);
    for (const seq of st.owed) if (seq <= upTo && !pending.has(seq) && !held.has(seq)) st.owed.delete(seq);
    this.advance(t, st);
  }

  private remember(id: string): void {
    this.sent.add(id);
    if (this.sent.size > SENT_MAX) this.sent.delete(this.sent.values().next().value!);
  }

  /** Retry only lifecycle messages. Progress can be superseded; outcomes cannot.
   * Back off to 30s on a persistently rejecting host, and recheck policy on every attempt. */
  private retry(t: Target, seg: Segment): void {
    if (this.disposed) return;
    const entry = this.app.registry.get(t.id);
    if (!entry || targetOf(entry).journal.runs !== t.journal.runs) return;
    const st = this.stateOf(t);
    const id = qualify(seg.messageId);
    st.inflight.delete(id);
    // An accepted catch-up summary (or another connection) may have covered this
    // message while its earlier request was still waiting for a refusal.
    if (seg.seq <= t.cursorsOf(this.me).delivered) return this.settleSegment(t, seg, 'accepted');
    this.sent.delete(id);
    if (!seg.lifecycle) return;
    this.owe(st, seg.seq);
    let r = st.retries.get(id);
    if (!r) st.retries.set(id, (r = { seq: seg.seq, attempt: 0 }));
    if (r.timer) return;
    const retry = r;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      if (!this.disposed && this.carries(t.id)) this.deliver(t, seg, { released: true });
    }, Math.min(30_000, 500 * 2 ** Math.min(retry.attempt++, 6)));
    retry.timer.unref?.();
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
      st.held.set(run.runId, { since: Date.now(), seq: ev.seq });
      this.owe(st, ev.seq);
    } else if (this.owed(session, ev, this.open.has(channelId(session.id)), session) || (ev.type === 'session.exit' && this.hasRunIn(session))) this.owe(st, ev.seq);
  }

  /**
   * May a synchronous call of this principal still return the Run's outcome? An `await`
   * (or `run`) in flight says so (§10.2: checked in the journal listener for run.end);
   * `start` waits on the service monitor instead, so a young service Run of ours counts too.
   */
  private maySyncReturn(session: Session, run: RunInfo): boolean {
    if (session.isAwaitedBy(run.runId, this.me)) return true;
    return run.principal === this.me && this.app.extras(session).services.get(run.runId) !== undefined && Date.now() - run.admittedAt < this.app.maxWaitMs + HOLD_MS;
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
    if (this.open.has(channelId(t.id)) && this.enabled('terminal.channels', 'channels.incoming')) {
      const msg = this.message(t, seg);
      this.remember(msg.messageId);
      st.inflight.set(id, seg.seq);
      this.batch.push({ t, seg, msg });
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => void this.flush(), BATCH_MS);
        this.batchTimer.unref?.();
      }
      return;
    }
    if (!seg.lifecycle || !this.pushedTo(t, seg)) return this.settleSegment(t, seg, 'not-owed');
    if (!this.enabled('terminal.live', 'pushEvents')) return this.settleSegment(t, seg, 'refused');
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
    if (!h) st.held.set(key, (h = { since: Date.now(), seq: seg.seq }));
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
      if (Date.now() - held.since >= HOLD_MS) {
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
    // A reduction or a close since they were queued binds (SPEC §6.7, mcpl-19): those are routed again.
    const send: typeof items = [];
    for (const i of items) {
      if (this.open.has(channelId(i.t.id)) && this.enabled('terminal.channels', 'channels.incoming')) send.push(i);
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
    const plans: Array<{ t: Target; st: LaneState; src: ReplaySource; from: Seq; open: boolean; covered: Set<Seq>; scan?: LifecycleScan }> = [];
    // Every floor goes up before any scan yields, so the live path cannot move a cursor past what a scan has yet to find.
    for (const entry of this.app.registry.list()) {
      if (!this.app.can(this.me, entry, 'observe')) continue;
      const t = targetOf(entry);
      if (only && !only.has(t.id)) continue;
      const from = t.cursorsOf(this.me).delivered;
      if (from >= t.journal.lastSeq || !this.carries(t.id)) continue;
      const st = this.stateOf(t);
      st.scanningFrom = from;
      plans.push({ t, st, src: this.sourceOf(entry), from, open: this.open.has(channelId(t.id)), covered: new Set() });
    }
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
      for (const p of plans) p.st.scanningFrom = undefined;
      throw e;
    }
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
      if (omitted) {
        this.owe(p.st, omitted.to);
        w.summary = this.summary(p.t, omitted);
        p.st.summaries.set(qualify(w.summary.messageId), { from: omitted.from, covered: p.covered });
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

  private owedOnCatchUp(t: Target, st: LaneState, src: ReplaySource, { ev, lost }: Picked, open: boolean): boolean {
    // A held completion is the live path's to decide; what a synchronous call returned is settled.
    if (ev.type === 'run.end' && (st.held.has(ev.runId) || this.returned(t, ev.runId))) return false;
    if (ev.type === 'service' && this.returned(t, ev.runId, ev.status, ev.seq)) return false;
    return this.owed(t, ev, open, src, lost?.principals);
  }

  /** One message for what a catch-up did not replay (ux-25): how many of each, and where to read them. */
  private summary(t: Target, o: Omitted): Segment {
    const names: Record<string, string> = { run: 'completions', service: 'service changes', watch: 'watch firings', 'session-exit': 'shell exits', recovered: 'restarts', 'needs-input': 'input prompts' };
    const parts = Object.entries(o.kinds).map(([k, n]) => `${n} ${names[k] ?? k}`);
    return {
      kind: 'summary',
      lifecycle: true,
      seq: o.to,
      ts: Date.now(),
      messageId: segmentId(t.id, t.journal, 'summary', o.to),
      tags: ['terminal:missed'],
      // `as=events`: a plain read projects text, which has no exit statuses or service changes in it (the house's read of 2f357bd, #22).
      head: `[terminal] ${t.id}: ${o.count} earlier message${o.count > 1 ? 's' : ''} while you were away not replayed (${parts.join(', ')}) · seq ${o.from}–${o.to} · read session=${t.id} since=${Math.max(0, o.from - 1)} as=events`,
      metadata: { session: t.id, state: liveOf(t)?.state ?? 'exited', count: o.count, from: o.from, to: o.to, kinds: o.kinds },
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
    if (this.batchTimer) clearTimeout(this.batchTimer);
    for (const st of this.states.values()) for (const h of st.held.values()) if (h.timer) clearTimeout(h.timer);
    for (const st of this.states.values()) for (const r of st.retries.values()) if (r.timer) clearTimeout(r.timer);
  }
}

/** What the disk store writes for an event: its JSON line. */
const storedBytes = (event: JournalEvent): number => Buffer.byteLength(JSON.stringify(event)) + 1;

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
      this.seeded = (async () => {
        let cursor = (journal.oldestSeq ?? 1) - 1;
        for (;;) {
          const page = journal.since(cursor, NOTE_SCAN_PAGE);
          for (const ev of page.events) if (ev.type === 'note') this.record(ev.seq, storedBytes(ev));
          if (!page.more || !page.events.length) return;
          cursor = page.events[page.events.length - 1]!.seq;
          await new Promise((r) => setImmediate(r));
        }
      })();
    }
    return this.seeded;
  }

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

function flat(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as string | number | boolean;
  return out;
}
