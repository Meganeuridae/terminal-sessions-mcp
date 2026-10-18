/**
 * Presence (§10.4): what changed in your sessions since you last looked — one
 * short line per session, keyed on the principal's `read` cursor (G22). "Since
 * your last read" means since the last tool result that returned that session's
 * content to you. Building it reads the journal but advances no cursor.
 *
 * What a line reports, newest first: Runs that ended after the cursor, from the
 * run index, so none is missed however busy the session was (m2-8, mcpl-12);
 * unread output and human typing, from a bounded scan backwards from the newest
 * event, with `≥` when older unread events lie beyond it; Runs still running on
 * either target (a process Run never shows as the shell's state, m2-7); the
 * services the reader started or owns, with their evidence when something is
 * wrong; the reader's armed watches. A session whose shell is gone — closed, or
 * recovered history-only after a daemon restart — reports the Runs that ended
 * `lost` with it (mcpl-2). Only a live session with none of this is rolled up
 * into "idle, nothing new".
 */
import { fmtBytes, oneLine } from '../core/segmenter.js';
import type { ServiceInfo } from '../core/services.js';
import type { Journal } from '../core/journal.js';
import type { Principal, RunInfo, Seq } from '../core/types.js';
import type { App } from './app.js';
import type { AnySession } from './registry.js';

const MAX_LINES = 10;
/** Events scanned backwards from the newest for unread bytes and typing. */
const SCAN = 5000;

const dur = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${Math.max(0, Math.round(ms / 1000))}s`);
const describe = (r: RunInfo) => oneLine(r.line ?? r.argv?.join(' ') ?? r.runId, 60);
const running = (r: RunInfo) => r.state === 'running' || r.state === 'starting';

/** How a Run ended, in a few words. */
function outcomeOf(r: RunInfo): string {
  if (r.state === 'exited') return r.signal ? `killed by ${r.signal}` : `→ ${r.exit ?? '?'}`;
  if (r.state === 'cancelled') return 'cancelled';
  return `lost (${r.reason ?? 'outcome unknown'})`;
}

/** Unread command output and human typing after `read`, scanning back from the newest event. */
function scanUnread(journal: Journal, read: Seq, principal: Principal): { bytes: number; humanTyped: number; bounded: boolean } {
  let bytes = 0;
  let humanTyped = 0;
  if (journal.lastSeq <= read) return { bytes, humanTyped, bounded: false };
  const recent = journal.tail(SCAN);
  let i = recent.length - 1;
  for (; i >= 0; i--) {
    const e = recent[i]!;
    if (e.seq <= read) break;
    // Command output counts; prompt redraws between commands are not news.
    if (e.type === 'output' && e.runId !== undefined) bytes += Buffer.byteLength(e.data);
    else if (e.type === 'input' && e.principal.startsWith('human:') && e.principal !== principal && e.kind !== 'protocol-reply') humanTyped++;
  }
  // The scan stopped at its bound, or retention cut the range: older unread events exist.
  const oldest = recent[0]?.seq;
  const bounded = i < 0 && oldest !== undefined && oldest > read + 1;
  return { bytes, humanTyped, bounded };
}

function lineFor(app: App, s: AnySession, principal: Principal, now: number): { text: string; quiet: boolean } | undefined {
  const t = s.kind === 'live' ? s.session : s;
  const { id, journal } = t;
  const read = t.cursorsOf(principal).read;
  const runs = s.listRuns();
  const unread = scanUnread(journal, read, principal);
  // Ended after the cursor, from the run index: exact however many events came since (m2-8). A
  // call returned the outcome only to a live life (history keeps no such record, G28).
  const returned = (runId: string) => s.kind === 'live' && s.session.outcomeDeliveredTo(runId, principal);
  const ended = runs.filter((r) => r.seq.end !== undefined && r.seq.end > read && !returned(r.runId)).sort((a, b) => a.seq.end! - b.seq.end!);
  const bits: string[] = [];

  if (s.kind === 'history') {
    // The shell is gone: nothing can change here any more, so only Runs that ended since
    // the reader last looked are news — above all those the restart or close made lost.
    if (!ended.length) return undefined;
    bits.push(s.closed ? 'closed' : 'shell gone (daemon restarted; history only)');
    if (unread.bytes > 0) bits.push(`${unread.bounded ? '≥ ' : ''}${fmtBytes(unread.bytes)} of output you have not read (read since=${read})`);
    pushEnded(bits, ended, principal);
    return { text: `[terminal] ${id}: ${bits.join(' · ')}`, quiet: false };
  }

  const session = s.session;
  const info = session.info();
  const current = info.currentRun ? runs.find((r) => r.runId === info.currentRun) : undefined;
  const shellBusy = current !== undefined && running(current);
  // A Run in a declared shell (§8.1) runs in the program in front, not as the shell's own
  // current Run, so it is looked for by itself: without this, presence said "idle" while a
  // declared `sleep 3` ran (an outside review's finding). The innermost one is the live one.
  const declared = runs.filter((r) => r.shell !== undefined && running(r));
  const front = declared.at(-1);
  if (session.exit !== undefined) bits.push('shell exited');
  else if (front) bits.push(`running \`${describe(front)}\` ${dur(now - (front.startedAt ?? front.admittedAt))} in the declared ${front.shell} shell${current ? ` (inside \`${describe(current)}\`)` : ''}`);
  else if (shellBusy) bits.push(`${info.state === 'tui' ? 'full-screen' : 'running'} \`${describe(current)}\` ${dur(now - (current.startedAt ?? current.admittedAt))} (cwd ${info.cwd})${info.declared ? `, a declared ${info.declared.shell} shell at its prompt` : ''}`);
  else bits.push(`${info.state} (cwd ${info.cwd})${info.declared ? `, a declared ${info.declared.shell} shell in front` : ''}`);

  // Process Runs never make the shell busy (§4), so they get their own bit (m2-7).
  const procs = runs.filter((r) => r.target === 'process' && running(r));
  const mine = procs.filter((r) => r.principal === principal);
  for (const r of mine.slice(0, 2)) bits.push(`running \`${describe(r)}\` ${dur(now - (r.startedAt ?? r.admittedAt))} (process)`);
  if (mine.length > 2) bits.push(`${mine.length - 2} more process runs of yours`);
  if (procs.length > mine.length) bits.push(`${procs.length - mine.length} process run${procs.length - mine.length > 1 ? 's' : ''} by others`);

  if (unread.bytes > 0) bits.push(`${unread.bounded ? '≥ ' : ''}${fmtBytes(unread.bytes)} new since your last read (read since=${read})`);
  pushEnded(bits, ended, principal);
  if (unread.humanTyped) bits.push(`a human typed here${unread.bounded ? ' (at least)' : ''}`);

  const x = app.extras(session);
  // The services the reader started, or all of them in a session it owns.
  const services = x.services.list().filter((v) => v.owner === principal || session.owner === principal);
  let serviceNews = false;
  for (const v of services) {
    const since = v.seq !== undefined && v.seq > read;
    if ((v.status === 'exited' || v.status === 'lost') && !since) continue;
    const trouble = v.status === 'starting' || v.status === 'unhealthy' || v.status === 'lost' || v.status === 'exited';
    if (trouble || since) serviceNews = true;
    bits.push(serviceBit(v, trouble));
  }
  const watches = x.watches.list().filter((w) => w.owner === principal).length;
  if (watches) bits.push(`${watches} watch${watches > 1 ? 'es' : ''} armed`);

  const quiet = unread.bytes === 0 && ended.length === 0 && unread.humanTyped === 0 && !shellBusy && front === undefined && procs.length === 0 && !serviceNews && watches === 0 && session.exit === undefined;
  return { text: `[terminal] ${id}: ${bits.join(' · ')}`, quiet };
}

function serviceBit(v: ServiceInfo, withEvidence: boolean): string {
  let bit = `service ${v.name ?? v.runId} ${v.status}`;
  if (withEvidence && v.evidence) bit += ` (${oneLine(v.evidence, 50)}${v.repeats ? `, +${v.repeats} more` : ''})`;
  return bit;
}

/** The newest two ended Runs, described; the rest counted. */
function pushEnded(bits: string[], ended: RunInfo[], principal: Principal): void {
  for (const r of ended.slice(-2)) bits.push(`\`${describe(r)}\` ${outcomeOf(r)}${r.principal !== principal ? ` by ${r.principal}` : ''}`);
  if (ended.length > 2) bits.push(`${ended.length - 2} more ended`);
}

/** The presence block for `principal`, covering `sessionIds`; undefined when there is nothing to say. */
export function presence(app: App, principal: Principal, sessionIds: Iterable<string>, now = Date.now()): string | undefined {
  const lines: string[] = [];
  const quiet: string[] = [];
  for (const id of sessionIds) {
    const s = app.registry.get(id);
    if (!s || !app.can(principal, s, 'observe')) continue;
    const l = lineFor(app, s, principal, now);
    if (!l) continue;
    if (l.quiet) quiet.push(s.kind === 'live' ? s.session.id : s.id);
    else lines.push(l.text);
  }
  if (!lines.length && !quiet.length) return undefined;
  const out = lines.slice(0, MAX_LINES - (quiet.length ? 1 : 0));
  if (lines.length > out.length) out.push(`[terminal] … and ${lines.length - out.length} more sessions with news (session_list)`);
  if (quiet.length) out.push(`[terminal] idle, nothing new: ${quiet.slice(0, 12).join(', ')}${quiet.length > 12 ? ` (+${quiet.length - 12})` : ''}`);
  return out.join('\n');
}
