/**
 * Measure (§16): the daemon sees every call, so it records them — per tool, per
 * host kind, errors — and a report finds confusion signatures: a `read` right
 * after a `run` whose wait was too short, `input` sent twice within a second,
 * `screen` polled in a loop, `cancel` after a `busy`. The endpoint builds the
 * records (transport/server.ts); termd appends them to `<data-dir>/usage.jsonl`;
 * `tsm usage` reads them back through `analyze`.
 *
 * What a record holds: argument names; the tool name when it is one the daemon
 * serves (otherwise `(unknown)` and a clipped copy); session and run ids,
 * states and `wait` values; and for text-bearing calls a keyed digest. Never a
 * command, typed text or key. The digest is an HMAC under a key that exists only
 * in the daemon's memory (`usageKey`), so digests compare within one daemon run
 * and cannot be brute-forced from the file; input marked `sensitive` gets no
 * digest at all (G26). Every string is length-limited, so no client can bloat
 * the log.
 */
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';

export interface UsageRecord {
  ts: number;
  principal: string;
  connection: string;
  host: 'mcp' | 'mcpl' | 'native';
  profile: string;
  /** A tool the daemon serves, or `(unknown)` (then `requested` holds the clipped name). */
  tool: string;
  /** The requested name, clipped, when `tool` is `(unknown)`. */
  requested?: string;
  ok: boolean;
  error?: string;
  ms: number;
  /** The session the call named, or the one its result reported. */
  session?: string;
  runId?: string;
  state?: string;
  /** For a `busy` result: the Run occupying the shell, which a following `cancel {runId}` names. */
  blockedBy?: string;
  wait?: number;
  /** Argument names given. */
  args: string[];
  /** Keyed digest of the text-bearing arguments (command / text / keys / input), for duplicate detection within one daemon run. */
  digest?: string;
  /** The call was input marked sensitive: nothing about its text is recorded, not even a digest (G26). */
  sensitive?: true;
}

export interface Distribution {
  count: number;
  p50: number;
  p90: number;
  max: number;
}

export interface UsageReport {
  calls: number;
  /** Calls by agents (not a human's GUI and not the native family): the ones the signatures read. */
  agentCalls: number;
  from?: string;
  to?: string;
  byTool: Record<string, { calls: number; errors: number; p50ms: number }>;
  byHost: Record<string, number>;
  errors: Record<string, number>;
  signatures: Record<string, { count: number; description: string }>;
  /**
   * `await` after a result that was not finished is the documented flow, not confusion
   * (every `running` status line prescribes it); what it measures is how short the
   * wait was. `extraMs` is the time from the first unfinished result to the call that
   * returned the Run's end — an upper bound, since it includes the agent's own time.
   */
  waits: { awaitAfterUnfinished: number; runsAwaited: number; extraMs: Distribution };
}

const SIGNATURES = {
  'read-after-short-wait': 'read (or tailLogs) within 10 s of a run, start or await on that Run or session that returned before it finished (the wait was too short)',
  'input-twice': 'the same input sent twice within 1 s (a blind resend)',
  'screen-polling': 'screen called 3+ times on one session within 10 s (polling instead of waiting)',
  'cancel-after-busy': 'cancel (or signal) within 10 s of a run that returned `busy`, on that session or the Run that blocked it',
  'busy-retry': 'run retried within 5 s of returning `busy`',
} as const;

/** Result states that mean the Run had not ended when the call returned. */
const UNFINISHED: ReadonlySet<string> = new Set(['running', 'starting', 'queued']);
const RUN_TOOLS: ReadonlySet<string> = new Set(['run', 'runCommand', 'start', 'launch', 'await']);
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'tailLogs']);
const CANCEL_TOOLS: ReadonlySet<string> = new Set(['cancel', 'signal', 'sendSignal']);

/**
 * Signatures describe agents: a human typing in the GUI (principal `human:…`) sends Up
 * Up or Enter Enter on purpose, and the native family (GUI, CLI) is not the model surface
 * the traces are meant to tune.
 */
export const isAgentCall = (r: Pick<UsageRecord, 'principal' | 'host'>): boolean => !String(r.principal).startsWith('human:') && r.host !== 'native';

function distribution(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { count: s.length, p50: at(0.5), p90: at(0.9), max: s[s.length - 1] ?? 0 };
}

/** Count into a Map: client-chosen keys never meet Object.prototype (`constructor`, `__proto__`). */
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** A record from disk is data: anything not shaped like one is skipped, never trusted. */
function wellFormed(r: unknown): r is UsageRecord {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.ts === 'number' && typeof o.tool === 'string' && typeof o.principal === 'string' && typeof o.host === 'string' && typeof o.ms === 'number';
}

export function analyze(records: UsageRecord[]): UsageReport {
  const byTool = new Map<string, { calls: number; errors: number; times: number[] }>();
  const byHost = new Map<string, number>();
  const errors = new Map<string, number>();
  const sig = new Map<string, number>();
  const sorted = records.filter(wellFormed).sort((a, b) => a.ts - b.ts);
  /** `p|run:<id>` and `p|session:<s>` → when a call about it last returned unfinished. */
  const lastUnfinished = new Map<string, number>();
  /** `p|run:<id>` → when the first unfinished result for that Run came back. */
  const firstUnfinished = new Map<string, number>();
  /** `p|session:<s>` → the Run whose unfinished result last marked the session, so that Run's end clears the mark. */
  const unfinishedBy = new Map<string, string>();
  const lastBusy = new Map<string, number>();
  const lastInput = new Map<string, { ts: number; digest?: string }>();
  const screens = new Map<string, number[]>();
  const extra: number[] = [];
  let awaitAfterUnfinished = 0;
  let agentCalls = 0;
  const recent = (m: Map<string, number>, keys: string[], ts: number, windowMs: number) => keys.some((k) => (m.get(k) ?? -Infinity) > ts - windowMs);

  for (const r of sorted) {
    let t = byTool.get(r.tool);
    if (!t) byTool.set(r.tool, (t = { calls: 0, errors: 0, times: [] }));
    t.calls++;
    t.times.push(r.ms);
    bump(byHost, String(r.host));
    if (!r.ok) {
      t.errors++;
      bump(errors, typeof r.error === 'string' ? r.error : 'unknown');
    }
    if (!isAgentCall(r)) continue;
    agentCalls++;
    const p = r.principal;
    const sessionKey = typeof r.session === 'string' ? `${p}|session:${r.session}` : undefined;
    const runKey = typeof r.runId === 'string' ? `${p}|run:${r.runId}` : undefined;
    const about = [runKey, sessionKey].filter((k): k is string => k !== undefined);
    // A read keyed by its runId asks about that Run; otherwise about the session.
    const readAbout = runKey ? [runKey] : about;

    if (READ_TOOLS.has(r.tool) && recent(lastUnfinished, readAbout, r.ts, 10_000)) bump(sig, 'read-after-short-wait');
    if (r.tool === 'await' && runKey && lastUnfinished.has(runKey)) awaitAfterUnfinished++;
    if (CANCEL_TOOLS.has(r.tool) && recent(lastBusy, about, r.ts, 10_000)) bump(sig, 'cancel-after-busy');
    if ((r.tool === 'run' || r.tool === 'runCommand') && sessionKey && recent(lastBusy, [sessionKey], r.ts, 5_000)) bump(sig, 'busy-retry');
    if ((r.tool === 'input' || r.tool === 'sendInput') && sessionKey) {
      const prev = lastInput.get(sessionKey);
      if (prev?.digest && prev.digest === r.digest && r.ts - prev.ts < 1000) bump(sig, 'input-twice');
      lastInput.set(sessionKey, r.digest !== undefined ? { ts: r.ts, digest: r.digest } : { ts: r.ts });
    }
    if ((r.tool === 'screen' || r.tool === 'takeScreenshot') && sessionKey) {
      const within = (screens.get(sessionKey) ?? []).filter((ts) => ts > r.ts - 10_000);
      within.push(r.ts);
      screens.set(sessionKey, within);
      if (within.length === 3) bump(sig, 'screen-polling');
    }
    if (RUN_TOOLS.has(r.tool) && typeof r.state === 'string') {
      if (UNFINISHED.has(r.state)) {
        for (const k of about) lastUnfinished.set(k, r.ts);
        if (runKey && sessionKey) unfinishedBy.set(sessionKey, runKey);
        if (runKey && !firstUnfinished.has(runKey)) firstUnfinished.set(runKey, r.ts);
      } else if (r.state === 'busy') {
        for (const k of about) lastBusy.set(k, r.ts);
        if (typeof r.blockedBy === 'string') lastBusy.set(`${p}|run:${r.blockedBy}`, r.ts);
      } else if (runKey) {
        // The Run ended: whatever an earlier unfinished result started is settled — for the session
        // too, when this Run was what left it unfinished, so a `read` after a completed `await` is
        // not a short wait (the house's read of 1cabc6a, #22).
        const first = firstUnfinished.get(runKey);
        if (first !== undefined) extra.push(r.ts - first);
        firstUnfinished.delete(runKey);
        lastUnfinished.delete(runKey);
        if (sessionKey && unfinishedBy.get(sessionKey) === runKey) {
          lastUnfinished.delete(sessionKey);
          unfinishedBy.delete(sessionKey);
        }
      }
    }
  }
  // Object.fromEntries defines own properties, so a tool named `__proto__` is just a key.
  const report: UsageReport = {
    calls: sorted.length,
    agentCalls,
    byTool: Object.fromEntries([...byTool].map(([k, v]) => [k, { calls: v.calls, errors: v.errors, p50ms: distribution(v.times).p50 }])),
    byHost: Object.fromEntries(byHost),
    errors: Object.fromEntries(errors),
    signatures: Object.fromEntries(Object.entries(SIGNATURES).map(([k, d]) => [k, { count: sig.get(k) ?? 0, description: d }])),
    waits: { awaitAfterUnfinished, runsAwaited: extra.length, extraMs: distribution(extra) },
  };
  if (sorted.length) {
    report.from = new Date(sorted[0]!.ts).toISOString();
    report.to = new Date(sorted[sorted.length - 1]!.ts).toISOString();
  }
  return report;
}

/** How many rotated files the usage log keeps beside the current one (`<file>.1` … `<file>.N`). */
export const USAGE_GENERATIONS = 4;

/** Every record in the log and its rotated generations, oldest file first. */
export function readUsage(file: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (let i = USAGE_GENERATIONS; i >= 0; i--) {
    const f = i ? `${file}.${i}` : file;
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (wellFormed(r)) out.push(r);
      } catch {
        // a torn last line
      }
    }
  }
  return out;
}

/** A client string in a usage record: bounded, so one call cannot write megabytes (§15). */
export function clipField(v: string, n = 128): string {
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

/** A fresh digest key: random, in memory only, one per daemon run. */
export const newUsageKey = (): Buffer => randomBytes(32);

/** The keyed digest of a call's text-bearing arguments (HMAC-SHA-256, 16 hex characters). */
export function usageDigest(key: Buffer, typed: Array<[string, unknown]>): string {
  return createHmac('sha256', key).update(JSON.stringify(typed)).digest('hex').slice(0, 16);
}
