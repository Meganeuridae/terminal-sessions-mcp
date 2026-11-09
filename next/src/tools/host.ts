import * as os from 'node:os';
import * as path from 'node:path';
import { validate, ValidationError } from '../api/validate.js';
import { clause, TermError } from '../core/errors.js';
import { inputBytes, PASTE_END } from '../core/keys.js';
import { compileUserRegex, headOnlyText, testBounded } from '../core/regex.js';
import type { Command, Front, Lines, Match, OpenSession, Session, SessionEvent, Took } from '../session/types.js';
import { boundedStrings, dirText, duration, endingText, exitText, fitted, fittedLength, frontText, linesText, outputValue, quoted, quotedString, RESULT_MAX_CHARS, SCREEN_ROOM_CHARS, screenChars, screenText, statusLine } from './render.js';
import { SESSION_NAME_RE, TOOLS, WAIT_DEFAULT_S, WAIT_MAX_S, type ToolDef } from './table.js';

const mono = (): number => performance.now();
/**
 * How long a daemon's stop may take to close every session: the shortest stop timeout of what stops it. The shipped
 * termd.service and com.animalabs.termd.plist each give 20 s before SIGKILL; `tsm daemon stop` waits 25 s, and the
 * transient unit the relay starts gets systemd's default, 90 s on Ubuntu 26.04. A KILL after this, while the socket
 * closes, leaves only a socket file the next daemon replaces.
 */
const STOP_BUDGET_MS = 20_000;

export interface Caller {
  scope: string;
  takes: boolean;
  pushes: boolean;
}

export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
  isError?: true;
}

export interface Wake {
  scope: string;
  session: string;
  tag: 'terminal:ended' | 'terminal:waiting' | 'terminal:exited' | 'terminal:match';
  key: string;
  text: string;
}

export type WakeSink = (w: Wake) => Promise<boolean>;

export interface HostOptions {
  openSession: OpenSession;
  shell: string;
  env: Record<string, string>;
  sessionsDir: string;
  startedAt: number;
  oomScoreAdj?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Unseen {
  seq: number;
  at: number;
  wake: Wake;
  lines: string[];
  command: number | undefined;
}

interface Subscriber {
  sink: WakeSink;
  offered: number;
  busy: boolean;
  gone: boolean;
}

interface Entry {
  scope: string;
  name: string;
  session: Session;
  cursor: number;
  unseen: Map<string, Unseen>;
  watches: Map<number, { key: string; command: number | undefined }>;
  dying: number | undefined;
  closing: boolean;
  settling: Set<Promise<void>>;
  latest: Map<string, { at: number; command: number | undefined }>;
  off: () => void;
}

interface Held {
  took: Took;
  shows: 'all' | 'none' | readonly Command[];
}

const PUSH_LINES = 20;

const keyOf = (scope: string, name: string): string => `${scope}\u0000${name}`;

export class Host {
  private readonly entries = new Map<string, Entry>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly opening = new Set<string>();
  private readonly starting = new Set<Promise<void>>();
  private readonly stopper = new AbortController();
  private stopping: number | undefined;
  private wakeSeq = 0;
  private readonly happened = new WeakMap<object, number>();
  private readonly settled = new WeakMap<Took[number], { count: number; shown: boolean }>();
  private nextId = 1;
  private readonly now: () => number;

  constructor(private readonly o: HostOptions) {
    this.now = o.now ?? Date.now;
  }

  tools(): readonly ToolDef[] {
    return TOOLS;
  }

  subscribe(scope: string, sink: WakeSink): () => void {
    let set = this.subscribers.get(scope);
    if (!set) this.subscribers.set(scope, (set = new Set()));
    const sub: Subscriber = { sink, offered: this.wakeSeq, busy: false, gone: false };
    set.add(sub);
    return () => {
      sub.gone = true;
      set.delete(sub);
      if (set.size === 0 && this.subscribers.get(scope) === set) this.subscribers.delete(scope);
    };
  }

  async call(caller: Caller, tool: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === tool);
    if (!def) return refused(`There is no tool \`${tool}\`. The tools are ${TOOLS.map((t) => t.name).join(', ')}.`, { error: 'unknown_tool' });
    try {
      validate(args ?? {}, def.inputSchema);
    } catch (e) {
      if (e instanceof ValidationError) return refused(`The arguments to \`${tool}\` don't fit: ${e.message}.`, { error: 'invalid_argument' });
      throw e;
    }
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      switch (tool) {
        case 'open':
          return await this.open(caller, a);
        case 'list':
          return this.list(caller);
      }
      const name = a.name as string;
      const entry = this.entries.get(keyOf(caller.scope, name));
      if (!entry) return this.noSession(caller, name);
      if (entry.closing && (tool === 'run' || tool === 'send' || tool === 'stop' || tool === 'integrate')) {
        return refused(`Session ${JSON.stringify(name)} is closing, so nothing was ${tool === 'stop' ? 'sent' : 'typed'}. \`close\` with \`force\` ends it at once.`, { error: 'session_exited', session: name });
      }
      switch (tool) {
        case 'run':
          return await this.taking(entry, (held) => this.run(caller, entry, a, signal, held));
        case 'send':
          return await this.taking(entry, (held) => this.send(caller, entry, a, signal, held));
        case 'look':
          return await this.taking(entry, (held) => this.look(caller, entry, a, signal, held));
        case 'read':
          return await this.read(entry, a, signal);
        case 'stop':
          return await this.stop(entry, a, signal);
        case 'integrate':
          return await this.integrate(caller, entry, a, signal);
        case 'close':
          return await this.close(caller, entry, a);
      }
      return refused(`\`${tool}\` isn't handled here.`, { error: 'unknown_tool' });
    } catch (e) {
      if (e instanceof TermError) {
        const text = e.code === 'backend_failure' ? `${capitalized(e.message)}.` : e.message;
        return refused(text, { error: e.code });
      }
      return refused(`\`${tool}\` failed: ${clause((e as Error)?.message ?? String(e))}. ${UNKNOWN_AFTER_FAILURE[tool] ?? 'Nothing was typed or sent.'}`, { error: 'backend_failure' });
    }
  }

  async closeAll(): Promise<void> {
    const deadline = (this.stopping = mono() + STOP_BUDGET_MS);
    this.stopper.abort();
    await Promise.all([
      ...[...this.entries.values()].map(async (e) => {
        e.closing = true;
        try {
          await e.session.close({ deadline });
        } catch (err) {
          this.o.log?.(`closing session ${JSON.stringify(e.name)} of scope ${JSON.stringify(e.scope)} failed: ${(err as Error)?.message ?? String(err)}`);
        }
      }),
      ...this.starting,
    ]);
  }

  private noSession(caller: Caller, name: string): ToolResult {
    const names = [...this.entries.values()].filter((e) => e.scope === caller.scope).map((e) => e.name);
    return refused(
      `No session named ${JSON.stringify(name)} is open in scope ${JSON.stringify(caller.scope)}, and none is opened for you. ` +
        `${names.length ? `Open here: ${names.join(', ')}.` : 'None is open here.'} ` +
        `\`open\` makes one. This daemon started at ${new Date(this.o.startedAt).toISOString()}, and no session outlives the daemon that held it.`,
      { error: 'session_not_found', session: name, open: names },
    );
  }

  private waitMs(a: Record<string, unknown>): number {
    return Math.round(((a.wait as number | undefined) ?? WAIT_DEFAULT_S) * 1000);
  }

  private regex(pattern: string, arg: string, notDone: string): RegExp {
    try {
      return compileUserRegex(pattern);
    } catch (err) {
      if (err instanceof TermError) throw new TermError(err.code, `\`${arg}\`: ${err.message}. ${notDone[0]!.toUpperCase()}${notDone.slice(1)}.`);
      throw err;
    }
  }

  private async open(caller: Caller, a: Record<string, unknown>): Promise<ToolResult> {
    const name = a.name as string;
    if (!SESSION_NAME_RE.test(name)) return refused(`${JSON.stringify(name)} isn't a session name: 1 to 64 letters, digits, ".", "_" or "-".`, { error: 'invalid_argument' });
    const k = keyOf(caller.scope, name);
    if (this.entries.has(k) || this.opening.has(k)) return refused(`A session named ${JSON.stringify(name)} is already open in this scope, or opening. Use it, or \`close\` it first.`, { error: 'session_exists', session: name });
    if (this.stopping !== undefined) return refused('The daemon is stopping, so no session opens.', { error: 'backend_failure' });
    const cols = (a.cols as number | undefined) ?? 120;
    const rows = (a.rows as number | undefined) ?? 40;
    const fits = RESULT_MAX_CHARS - SCREEN_ROOM_CHARS;
    if (screenChars(cols, rows) > fits) {
      const maxRows = Math.floor(fits / (cols + 1));
      const maxCols = Math.floor(fits / rows) - 1;
      return refused(
        `A terminal of ${cols} by ${rows} can show a screen of ${screenChars(cols, rows)} characters, more than a result can carry whole ` +
          `(${RESULT_MAX_CHARS}, less ${SCREEN_ROOM_CHARS} for its other lines), so a full-screen program's status bar and prompt would be cut off. ` +
          `${maxRows >= 1 ? `At ${cols} columns, up to ${maxRows} rows fit` : `No height fits at ${cols} columns`}; ${maxCols >= 1 ? `at ${rows} rows, up to ${maxCols} columns` : `no width fits at ${rows} rows`}.`,
        { error: 'invalid_argument', fits: { cols: maxCols, rows: maxRows } },
      );
    }
    const raw = (a.cwd as string | undefined) ?? '~';
    const cwd = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    if (!path.isAbsolute(cwd)) return refused(`The directory ${JSON.stringify(raw)} must be absolute, or start with "~".`, { error: 'invalid_argument' });
    this.opening.add(k);
    let started!: () => void;
    const start = new Promise<void>((r) => (started = r));
    this.starting.add(start);
    try {
      return await this.opened(caller, name, k, cwd, cols, rows, a);
    } finally {
      this.opening.delete(k);
      this.starting.delete(start);
      started();
    }
  }

  private async opened(caller: Caller, name: string, k: string, cwd: string, cols: number, rows: number, a: Record<string, unknown>): Promise<ToolResult> {
    const session = await this.o.openSession({
      name,
      shell: this.o.shell,
      cwd,
      cols,
      rows,
      env: this.o.env,
      parent: this.o.sessionsDir,
      nextCommandId: () => this.nextId++,
      waitMs: this.waitMs(a),
      signal: this.stopper.signal,
      ...(this.o.oomScoreAdj ? { oomScoreAdj: this.o.oomScoreAdj } : {}),
      ...(this.o.log ? { log: this.o.log } : {}),
    });
    if (this.stopping !== undefined) {
      await session.close({ force: true, deadline: this.stopping });
      return refused('The daemon stopped while this session started, so its shell is closed.', { error: 'backend_failure' });
    }
    const entry: Entry = { scope: caller.scope, name, session, cursor: 0, unseen: new Map(), watches: new Map(), dying: undefined, closing: false, settling: new Set(), latest: new Map(), off: () => {} };
    entry.off = session.onEvent((ev) => this.onEvent(entry, ev));
    this.entries.set(k, entry);
    const front = session.front();
    const kind = session.kind === 'none' ? `${path.basename(this.o.shell)}, with no integration: its commands' statuses can't be known` : session.kind;
    const text = `${this.status(entry, front)}\nOpened ${JSON.stringify(name)}: ${kind}, pid ${session.pid}.${front.state === 'prompt' ? '' : ` It isn't at its prompt yet: ${frontText(front, this.now())}.`}`;
    return ok(text, { session: name, pid: session.pid, shell: session.kind, front });
  }

  private list(caller: Caller): ToolResult {
    const mine = [...this.entries.values()].filter((e) => e.scope === caller.scope);
    if (!mine.length) return ok(`No session is open in scope ${JSON.stringify(caller.scope)}.`, { sessions: [] });
    const now = this.now();
    const rows = mine.map((e) => {
      const front = e.session.front();
      return { e, front, line: `${e.name}: ${frontText(front, now)} · ${dirText(e.session.cwd())}${e.unseen.size ? ` · ${reportsText(e.unseen.size)}` : ''}` };
    });
    const pending = rows.flatMap((r) => [...r.e.unseen.values()].map((u) => ({ e: r.e, u }))).sort((a, b) => a.u.at - b.u.at);
    const build = (n: number): { joined: string; ends: number[] } => {
      let joined = rows.slice(0, n).map((r) => r.line).join('\n');
      if (n < rows.length) joined += `\n… ${rows.length - n} more session${rows.length - n === 1 ? '' : 's'}, listed in structuredContent`;
      if (pending.length) joined += '\n\nNot yet seen:';
      const ends = pending.map((p) => (joined += `\n${p.u.lines.join('\n')}`).length);
      return { joined, ends };
    };
    let shownRows = rows.length;
    let built = build(shownRows);
    while (pending.length && shownRows > 0 && built.ends[0]! > fittedLength(built.joined)) built = build(--shownRows);
    const { joined, ends } = built;
    const text = fitted(joined);
    const kept = fittedLength(joined);
    const shown = pending.filter((_, i) => ends[i]! <= kept);
    if (caller.takes) for (const p of shown) this.forget(p.e, p.u);
    return ok(text, {
      sessions: rows.map((r) => ({ name: r.e.name, front: r.front, cwd: r.e.session.cwd() })),
      unseen: shown.map((p) => p.u.lines.join('\n')),
    });
  }

  private async run(caller: Caller, e: Entry, a: Record<string, unknown>, signal: AbortSignal | undefined, held: Held): Promise<ToolResult> {
    const deadline = mono() + WAIT_MAX_S * 1000;
    const notify = a.notify_on !== undefined ? this.regex(a.notify_on as string, 'notify_on', 'nothing was typed') : undefined;
    const r = await e.session.run(a.command as string, { waitMs: this.waitMs(a), take: caller.takes, ...(signal ? { signal } : {}) });
    held.took = r.took;
    if (r.kind === 'running' && notify && !e.closing) e.watches.set(e.session.watch(notify, r.command.from, r.command.id), { key: this.pushKey(e, r.command.id, 'match'), command: r.command.id });
    if (signal?.aborted) return this.cancelled(held);
    if (e.closing) return this.closed(e, held, r.kind === 'refused' ? 'Nothing was typed.' : typedText(r.command), r.kind === 'refused' ? [] : endOf(r.command));
    if (r.kind === 'refused' && r.tooLong) {
      const where = r.front.state === 'prompt' && r.front.within ? `in the shell within ${quoted(r.front.within.argv)}` : 'in a shell given the integration';
      return refused(
        `${this.status(e, r.front)}\nNothing was typed: ${where}, \`run\` types the text as one line, and this one would type as ${r.tooLong.typed} characters, over the ${r.tooLong.max} it takes. Split it into shorter runs, or copy a script over and run that.`,
        { error: 'invalid_argument', tooLong: r.tooLong, front: r.front },
      );
    }
    if (r.kind === 'refused') return refused(`${this.status(e, r.front)}\nNothing was typed: ${refusalAdvice(r.front)}`, { error: 'not_at_prompt', front: r.front });
    const c = r.command;
    const out = e.session.lines(c.from, c.to);
    const search = r.kind === 'ended' && notify ? await firstMatch(notify, out, deadline, () => signal?.aborted === true || e.closing) : undefined;
    if (signal?.aborted) return this.cancelled(held);
    if (e.closing) return this.closed(e, held, typedText(c), endOf(c));
    if (caller.takes && out.from <= e.cursor) e.cursor = Math.max(e.cursor, out.to - (r.kind === 'ended' ? 0 : out.live));
    const found = search?.match;
    const left = search && !found && search.to < out.to ? [`\`notify_on\` searched lines ${out.from} to ${search.to} ${RAN_OUT}; \`read\` with \`match\` and \`lines: [${search.to}, ${out.to}]\` searches the rest.`] : [];
    const head = [this.status(e, r.front, c), ...(found ? [matchedText(found)] : []), ...left].join('\n');
    const tail = r.kind === 'running'
      ? `\nIt keeps running. ${caller.pushes ? 'Its end will be reported to you, or ' : ''}\`look\` with \`until: "end"\` waits for it; \`stop\` stops it.`
      : '';
    const budget = RESULT_MAX_CHARS - head.length - tail.length - 1;
    return ok(`${head}\n${this.output(out, budget)}${tail}`, {
      command: c,
      front: r.front,
      running: r.kind === 'running',
      exitCode: c.end?.stopped ? null : (c.end?.status ?? null),
      ...(c.end?.stopped ? { stopped: true } : {}),
      ...outputValue(out.lines, budget),
      ...(out.dropped ? { outputDropped: out.dropped } : {}),
    });
  }

  private async send(caller: Caller, e: Entry, a: Record<string, unknown>, signal: AbortSignal | undefined, held: Held): Promise<ToolResult> {
    const text = (a.text as string | undefined) ?? '';
    const keys = (a.keys as string[] | undefined) ?? [];
    const paste = a.paste === true;
    try {
      inputBytes(undefined, keys);
    } catch (err) {
      if (err instanceof TermError) return refused(`\`keys\`: ${err.message}. Nothing was typed.`, { error: err.code });
      throw err;
    }
    if (text === '' && keys.length === 0) return refused('Nothing to send: give `text`, `keys`, or both.', { error: 'invalid_argument' });
    if (paste && text === '') return refused('Nothing was typed: `paste` sends `text` as a paste, so it needs `text`.', { error: 'invalid_argument' });
    if (paste && text.includes(PASTE_END)) return refused('Nothing was typed: `text` holds the bracketed-paste end marker, ESC [ 2 0 1 ~, which would end the paste early.', { error: 'invalid_argument' });
    const until = a.wait_for !== undefined ? this.regex(a.wait_for as string, 'wait_for', 'nothing was typed') : undefined;
    const r = await e.session.send(text, { waitMs: this.waitMs(a), keys, ...(paste ? { paste } : {}), take: caller.takes, ...(until ? { until } : {}), ...(signal ? { signal } : {}) });
    held.took = r.took;
    if (signal?.aborted) return this.cancelled(held);
    if (e.closing || r.by === 'closed') return this.closed(e, held, [r.sent ? 'Its input was typed.' : 'Nothing was typed.', ...r.ended.map(endedLine)].join(' '), r.ended);
    if (!r.sent && r.by === 'paste_off') {
      return refused(`${this.status(e, r.front)}\nNothing was typed: the program in front hasn't turned bracketed paste on. \`send\` without \`paste\` types the text.`, { error: 'invalid_argument', front: r.front });
    }
    if (!r.sent && r.by === 'timeout' && r.front.state !== 'exited') {
      return refused(
        `${this.status(e, r.front)}\nNothing was typed: the shell hasn't finished drawing its prompt after ${duration(this.now() - r.front.since)}, and keys sent before a line editor has the terminal would reach the terminal's own line editing instead. ${this.waitMs(a) >= WAIT_MAX_S * 1000 ? '`look` shows what is in front.' : '`send` again with a longer `wait`.'}`,
        { error: 'not_at_prompt', front: r.front },
      );
    }
    if (!r.sent) return refused(`${this.status(e, r.front)}\nNothing was sent: the shell has exited.`, { error: 'session_exited', front: r.front });
    if (caller.takes && !r.screen && r.lines.from <= e.cursor) e.cursor = Math.max(e.cursor, r.lines.to - r.lines.live);
    const parts = [this.status(e, r.front)];
    for (const c of r.ended) parts.push(endedLine(c));
    if (r.by === 'timeout') parts.push(until ? searchEndedText('send', r, false, this.unsearched(e, r)) : 'Output was still changing when the wait ended.');
    if (r.matched) parts.push(matchedText(r.matched));
    const used = parts.join('\n').length + 1;
    parts.push(r.screen ? screenText(r.screen, RESULT_MAX_CHARS - used) : this.output(r.lines, RESULT_MAX_CHARS - used));
    return ok(parts.join('\n'), { front: r.front, by: r.by, ended: r.ended, ...(r.matched ? { matched: r.matched } : {}), lines: { from: r.lines.from, to: r.lines.to } });
  }

  private async look(caller: Caller, e: Entry, a: Record<string, unknown>, signal: AbortSignal | undefined, held: Held): Promise<ToolResult> {
    if (a.until !== undefined && a.match !== undefined) return refused('Give `until` or `match`, not both.', { error: 'invalid_argument' });
    const parts: string[] = [];
    let ended: Command[] = [];
    let front: Front = e.session.front();
    if (a.until !== undefined || a.match !== undefined) {
      const pattern = a.match !== undefined ? this.regex(a.match as string, 'match', 'nothing was waited for') : undefined;
      const until = pattern ? { kind: 'match' as const, pattern } : { kind: a.until as 'end' | 'input' };
      const from = e.cursor;
      const w = await e.session.wait(until, { waitMs: this.waitMs(a), from, take: caller.takes, ...(signal ? { signal } : {}) });
      held.took = w.took;
      if (signal?.aborted) return this.cancelled(held);
      if (e.closing || w.by === 'closed') return this.closed(e, held, w.ended.map(endedLine).join(' '), w.ended);
      front = w.front;
      ended = w.ended;
      for (const c of w.ended) parts.push(endedLine(c));
      if (w.matched) parts.push(matchedText(w.matched));
      if (w.by === 'timeout') {
        if (pattern) {
          if (caller.pushes) {
            const key = `${e.scope}/${e.name}/look`;
            for (const [id, watch] of e.watches) if (watch.key === key) (e.session.unwatch(id), e.watches.delete(id));
            e.watches.set(e.session.watch(pattern, from), { key, command: undefined });
          }
          parts.push(searchEndedText('look', w, caller.pushes, this.unsearched(e, w)));
        } else parts.push(`The wait ended first. ${laterText(a.until as 'end' | 'input', caller.pushes, e.session.current() !== undefined, front)}`);
      }
    }
    const lines = e.session.lines(e.cursor);
    const pending = [...e.unseen.values()].sort((x, y) => x.at - y.at);
    let before = [this.status(e, front), ...parts].join('\n');
    const ends = pending.map((u) => (before += `\n${u.lines.join('\n')}`).length);
    const full = `${before}\n${lines.lines.length ? this.output(lines, RESULT_MAX_CHARS - before.length - 1) : '(no new output)'}`;
    const text = fitted(full);
    const kept = fittedLength(full);
    const shown = pending.filter((_, i) => ends[i]! <= kept);
    if (caller.takes) {
      e.cursor = Math.max(e.cursor, lines.to - lines.live);
      for (const u of shown) this.forget(e, u);
    }
    return ok(text, { front, ...(ended.length ? { ended } : {}), unseen: shown.map((u) => u.lines.join('\n')), lines: { from: lines.from, to: lines.to } });
  }

  private async read(e: Entry, a: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ToolResult> {
    const deadline = mono() + WAIT_MAX_S * 1000;
    let from = 0;
    let to: number | undefined;
    let what = 'the session\'s output';
    if (a.command !== undefined && a.lines !== undefined) return refused('Give `command` or `lines`, not both: `lines` within a command\'s own range reads part of it.', { error: 'invalid_argument' });
    if (a.command !== undefined) {
      const c = e.session.command(a.command as number);
      if (!c) return refused(`Session ${JSON.stringify(e.name)} has no command ${String(a.command)} it still knows of.`, { error: 'run_not_found' });
      from = c.from;
      to = c.to;
      what = `command ${c.id}'s output`;
    } else if (a.lines !== undefined) {
      const l = a.lines as number[];
      if (l.length !== 2 || l[0]! > l[1]!) return refused('`lines` takes two line numbers, [from, to], with from no greater than to.', { error: 'invalid_argument' });
      from = l[0]!;
      to = l[1]!;
      what = `lines ${from} to ${to}`;
    }
    const lines = e.session.lines(from, to);
    const head = `${this.status(e, e.session.front())}\n${what}, lines ${lines.from} to ${lines.to}:`;
    if (a.match === undefined) return ok(`${head}\n${this.output(lines, RESULT_MAX_CHARS - head.length - 1)}`, { from: lines.from, to: lines.to, dropped: lines.dropped });
    const re = this.regex(a.match as string, 'match', 'nothing was read');
    const ctx = (a.context as number | undefined) ?? 2;
    const hits: number[] = [];
    let clipped = 0;
    let searched = lines.lines.length;
    for (let i = 0; i < lines.lines.length; i++) {
      if (signal?.aborted) return CANCELLED;
      if (e.closing) return closedMeanwhile(e);
      if (mono() >= deadline) {
        searched = i;
        break;
      }
      const t = testBounded(re, lines.lines[i]!);
      if (t.clipped) clipped++;
      if (t.matched) hits.push(i);
      await turn();
    }
    const isHit = new Set(hits);
    const out: string[] = [];
    let last = -2;
    for (const h of hits) {
      for (let i = Math.max(last + 1, h - ctx); i <= Math.min(lines.lines.length - 1, h + ctx); i++) {
        if (i !== last + 1 && out.length) out.push('--');
        out.push(`${lines.from + i}${isHit.has(i) ? ':' : '-'} ${lines.lines[i]}`);
        last = i;
      }
    }
    const body = { from: 0, to: out.length, lines: out, dropped: lines.dropped, live: 0 };
    const rest = lines.from + searched;
    const left = searched < lines.lines.length ? `; searched lines ${lines.from} to ${rest} ${RAN_OUT}; \`read\` with \`match\` and \`lines: [${rest}, ${lines.to}]\` searches the rest` : '';
    const counted = `${head}\n${hits.length} matching line${hits.length === 1 ? '' : 's'}${clipped ? `; ${headOnlyText(clipped)}` : ''}${left}`;
    return ok(`${counted}\n${linesText(body, RESULT_MAX_CHARS - counted.length - 1, 'narrow `lines` or the pattern')}`, { matches: hits.map((i) => lines.from + i), ...(left ? { unsearched: { from: rest, to: lines.to } } : {}) });
  }

  private async stop(e: Entry, a: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ToolResult> {
    const name = a.signal === undefined ? undefined : `SIG${(a.signal as string).toUpperCase().replace(/^SIG/, '')}`;
    if (name !== undefined && !(name in os.constants.signals)) return refused(`${JSON.stringify(a.signal)} isn't a signal this system has. Nothing was sent.`, { error: 'invalid_argument' });
    const r = await e.session.stop(name as NodeJS.Signals | undefined, signal ? { abort: signal } : {});
    if (r.cancelled || signal?.aborted) return CANCELLED;
    const now = this.now();
    const steps = r.steps.map((s) =>
      s.refused
        ? `${s.sent} wasn't delivered${s.to ? ` to ${quoted(s.to.argv)}` : ''} (${s.refused}), so no further step was taken: now ${frontText(s.front, now)}.`
        : s.withheld
          ? `${s.sent} wasn't sent${s.to ? ` to ${quoted(s.to.argv)}` : ''}: the shell's processes couldn't be listed, so its group couldn't be confirmed as still the shell's, and no further step was taken: now ${frontText(s.front, now)}.`
          : `Sent ${s.sent}${s.to ? ` to ${quoted(s.to.argv)}` : ''}: now ${frontText(s.front, now)}.${s.stopped ? ' The job is stopped: `jobs` lists it, and `run fg` or `run bg` continues it.' : ''}`,
    );
    const farSignal = r.within === true && a.signal !== undefined;
    if (farSignal) {
      const local = r.front.state !== 'exited' && r.front.state !== 'waiting' && r.front.within ? quoted(r.front.within.argv) : 'the local program';
      steps.push(`Nothing was sent: a signal would reach ${local}, not the job in the shell within it. \`stop\` without \`signal\` types Ctrl-C there.`);
    } else if (!r.steps.length) steps.push(`Nothing was sent: ${frontText(r.front, now)}.`);
    if (r.next === 'close') steps.push('What runs is the shell itself, or a job that outlived KILL: only `close` ends it.');
    const structured = { steps: r.steps, front: r.front, ...(r.next ? { next: r.next } : {}), ...(r.within ? { within: true } : {}) };
    const notSent = farSignal || r.steps.some((s) => s.refused || s.withheld) || (a.signal !== undefined && r.next === 'close' && r.steps.length === 0);
    const text = [this.status(e, r.front), ...steps].join('\n');
    return notSent ? refused(text, { error: 'not_sent', ...structured }) : ok(text, structured);
  }

  private async integrate(caller: Caller, e: Entry, a: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ToolResult> {
    const before = caller.takes ? e.session.lines(e.cursor) : undefined;
    const r = await e.session.integrate({ waitMs: this.waitMs(a), ...(signal ? { signal } : {}) });
    if (signal?.aborted) return CANCELLED;
    if (e.closing || (r.kind === 'incomplete' && r.by === 'closed')) return closedMeanwhile(e);
    const head = this.status(e, r.front);
    switch (r.kind) {
      case 'integrated': {
        const printed = r.printed?.length ? `\nWhile taking the hooks, the shell printed:\n${r.printed.join('\n')}` : '';
        const said = `\nThe shell in front, ${r.shell} ${r.version}, now has the session's integration. \`run\` types there, with statuses, until that shell exits. Then \`run\` goes back to the shell it was typed from.${printed}`;
        const shown = before?.lines.length ? `\n${this.output(before, Math.max(0, RESULT_MAX_CHARS - head.length - said.length - 1))}` : '';
        if (before) e.cursor = Math.max(e.cursor, e.session.lines(e.cursor).to - 1);
        return ok(
          `${head}${shown}${said}`,
          { integrated: { shell: r.shell, version: r.version, ...(r.printed?.length ? { printed: r.printed } : {}) }, front: r.front },
        );
      }
      case 'refused':
        if (r.integrating) return refused(`${head}\nNothing was typed: another \`integrate\` is running in this session. Its result says how it went.`, { error: 'not_sent', integrating: true, front: r.front });
        if (r.sent) return refused(`${head}\nNothing was typed: a line sent at this prompt hasn't started yet, and what is in front may be a question, such as a password, that anything typed would answer. \`look\` until the shell it reaches shows its prompt, then call \`integrate\` again.`, { error: 'not_at_prompt', sent: true, front: r.front });
        if (r.canonical) return refused(`${head}\nNothing was typed: what's in front reads a whole line itself, such as a password or a yes/no question, or a shell without a line editor. \`look\` until a shell prompt shows, then call \`integrate\` again.`, { error: 'not_at_prompt', canonical: true, front: r.front });
        if (r.front.state === 'exited') return refused(`${head}\nNothing was typed: ${refusalAdvice(r.front)}`, { error: 'session_exited', front: r.front });
        return refused(`${head}\nNothing was typed: the shell in front has the session's integration already, so \`run\` works there.`, { error: 'already_integrated', front: r.front });
      case 'unsupported':
        return refused(
          `${head}\nThe shell in front${r.shell ? `, ${r.shell},` : ''} gets no integration: only bash, zsh and fish do. It answered the probe, and nothing more was typed. \`send\` types into it.`,
          { error: 'unsupported_shell', ...(r.shell ? { shell: r.shell } : {}), front: r.front },
        );
      case 'incomplete': {
        const what =
          r.by === 'exited'
            ? r.front.state === 'exited'
              ? 'The session\'s shell exited before the integration was complete.'
              : r.step === 'probe'
                ? 'What the probe line was typed into ended before a shell answered it, and the shell below is back at its prompt. Nothing more was typed.'
                : 'What the hooks were typed into ended before it drew a prompt with them, and the shell below is back at its prompt. Nothing more was typed.'
            : r.step === 'probe'
              ? 'The probe line was typed, and no shell answered it within the wait, so nothing more was typed. The shell in front has no integration.'
              : 'The hooks were typed in part or whole, and no prompt with them was drawn within the wait. Nothing more is typed. If their last part was typed, a prompt drawn later still gives that shell the integration, and the status line then names what it runs within.';
        return refused(`${head}\n${what}`, { error: 'incomplete', step: r.step, by: r.by, front: r.front });
      }
    }
  }

  private async close(caller: Caller, e: Entry, a: Record<string, unknown>): Promise<ToolResult> {
    e.closing = true;
    const [exit] = await Promise.all([e.session.close({ force: a.force === true, deadline: mono() + WAIT_MAX_S * 1000 }), Promise.all(e.settling)]);
    e.off();
    const unseen = [...e.unseen.values()].sort((x, y) => x.at - y.at).map((u) => u.lines.join('\n'));
    if (caller.takes) e.unseen.clear();
    const k = keyOf(e.scope, e.name);
    if (this.entries.get(k) === e) this.entries.delete(k);
    const how = exit.unconfirmed ? `was sent ${exit.signal ?? 'SIGKILL'}, and its exit wasn't seen within the grace after it` : exitText(exit);
    const unlisted = exit.unlisted ? " The session couldn't list every process it started, so jobs it started may live on." : '';
    const unreached = exit.unreached?.length ? ` These signals weren't delivered: ${exit.unreached.map((g) => `${g.signal} to group ${g.pgid} (${g.error})`).join(', ')}. Their processes may live on.` : '';
    return ok(`[${e.name} · closed]\nThe shell ${how}.${unlisted}${unreached}${unseen.length ? `\n\nNot yet seen:\n${unseen.join('\n')}` : ''}`, { session: e.name, exit, ...(unseen.length ? { unseen } : {}) });
  }

  private async taking(e: Entry, call: (held: Held) => Promise<ToolResult>): Promise<ToolResult> {
    const held: Held = { took: [], shows: 'all' };
    let done!: () => void;
    const settling = new Promise<void>((r) => (done = r));
    e.settling.add(settling);
    try {
      return await call(held);
    } catch (err) {
      held.shows = 'none';
      throw err;
    } finally {
      try {
        this.settle(e, held);
      } finally {
        e.settling.delete(settling);
        done();
      }
    }
  }

  private cancelled(held: Held): ToolResult {
    held.shows = 'none';
    return CANCELLED;
  }

  private closed(e: Entry, held: Held, happened: string, ended: readonly Command[]): ToolResult {
    held.shows = ended;
    return closedMeanwhile(e, happened, [...ended]);
  }

  private settle(e: Entry, held: Held): void {
    let dying: number | undefined;
    for (const ev of held.took) {
      const s = this.settled.get(ev) ?? { count: 0, shown: false };
      this.settled.set(ev, s);
      s.count++;
      if (held.shows === 'all' || (held.shows !== 'none' && ev.kind === 'ended' && held.shows.includes(ev.command))) s.shown = true;
      const front = ev.kind === 'waiting' ? e.session.front() : undefined;
      const over = ev.kind === 'waiting' && (e.closing || front?.state !== 'waiting' || front.process.pgid !== ev.front.process.pgid || front.since !== ev.front.since);
      if (s.count === ev.takers && !s.shown && !over) this.onEvent(e, { ...ev, taken: false }, { dying, at: this.happened.get(occurrenceOf(ev)) ?? ++this.wakeSeq });
      dying = ev.kind === 'ended' && ev.command.end?.status === undefined ? ev.command.id : undefined;
    }
  }

  private unsearched(e: Entry, r: { unsearched?: number; unsearchedFrom?: number }): { from: number; to: number; rows: number } | undefined {
    if (!r.unsearched || r.unsearchedFrom === undefined) return undefined;
    const to = e.session.lines(r.unsearchedFrom).to;
    return { from: r.unsearchedFrom, to, rows: Math.max(0, r.unsearched - (to - r.unsearchedFrom)) };
  }

  private status(e: Entry, front: Front, command?: Command): string {
    return statusLine({ session: e.name, front, cwd: e.session.cwd(), ...(command ? { command } : {}), unseen: e.unseen.size, now: this.now() });
  }

  private output(l: Lines, budget: number): string {
    return linesText(l, budget, `\`read\` with a range of \`lines\` within [${l.from}, ${l.to}] gives more`);
  }

  private pushKey(e: Entry, command: number | undefined, kind?: 'match'): string {
    return `${e.scope}/${e.name}/${command ?? 'shell'}${kind ? `/${kind}` : ''}`;
  }

  private onEvent(e: Entry, ev: SessionEvent, restored?: { dying: number | undefined; at: number }): void {
    if (e.closing && !restored) return;
    const dying = restored ? restored.dying : e.dying;
    if (!restored) e.dying = ev.kind === 'ended' && ev.command.end?.status === undefined ? ev.command.id : undefined;
    if (ev.kind === 'ended') for (const [id, w] of e.watches) if (w.command === ev.command.id) (e.session.unwatch(id), e.watches.delete(id));
    this.retire(e);
    let at: number | undefined;
    if (ev.kind !== 'match') {
      const about = ev.kind === 'ended' ? ev.command.id : ev.kind === 'waiting' ? ev.front.command : dying;
      const key = this.pushKey(e, about);
      if (restored) {
        if (about !== undefined && !e.session.command(about)) return;
        if ((e.latest.get(key)?.at ?? 0) > restored.at) return;
        at = restored.at;
      } else {
        at = ++this.wakeSeq;
        this.happened.set(occurrenceOf(ev), at);
        e.latest.set(key, { at, command: about });
        if (ev.taken) return;
      }
    }
    const withTail = (status: string, c?: Command): string => (e.closing ? status : `${status}\n${this.tailText(e, status, c)}`);
    let wake: Wake;
    let command: number | undefined;
    switch (ev.kind) {
      case 'ended': {
        const status = this.status(e, e.session.front(), ev.command);
        command = ev.command.id;
        wake = { scope: e.scope, session: e.name, tag: 'terminal:ended', key: this.pushKey(e, ev.command.id), text: withTail(status, ev.command) };
        break;
      }
      case 'waiting': {
        const status = this.status(e, ev.front);
        command = ev.front.command;
        wake = { scope: e.scope, session: e.name, tag: 'terminal:waiting', key: this.pushKey(e, ev.front.command), text: withTail(status) };
        break;
      }
      case 'exited': {
        const status = `[${e.name} · the shell ${exitText(ev.exit)}]`;
        command = dying;
        wake = { scope: e.scope, session: e.name, tag: 'terminal:exited', key: this.pushKey(e, dying), text: withTail(status) };
        break;
      }
      case 'match': {
        const w = e.watches.get(ev.watch);
        if (w === undefined) return;
        e.watches.delete(ev.watch);
        command = w.command;
        wake = { scope: e.scope, session: e.name, tag: 'terminal:match', key: w.key, text: `${this.status(e, e.session.front())}\n${matchedText(ev.match)}` };
        break;
      }
    }
    wake.text = fitted(wake.text);
    const lines = wake.text.split('\n');
    const seq = ++this.wakeSeq;
    e.unseen.set(wake.key, { seq, at: at ?? seq, wake, lines: wake.tag === 'terminal:match' ? lines.slice(0, 2) : lines.slice(0, 1), command });
    if (!e.closing) this.pump(e.scope);
  }

  private retire(e: Entry): void {
    for (const [k, u] of e.unseen) if (u.command !== undefined && !e.session.command(u.command)) e.unseen.delete(k);
    for (const [k, l] of e.latest) if (l.command !== undefined && !e.session.command(l.command)) e.latest.delete(k);
  }

  private tailText(e: Entry, status: string, c: Command | undefined = e.session.current() ?? e.session.last()): string {
    const screen = e.session.screen();
    if (screen.alt) return screenText(screen, RESULT_MAX_CHARS - status.length - 1);
    const all = e.session.lines(c?.from ?? 0, c?.to);
    const l = { ...all, from: Math.max(all.from, all.to - PUSH_LINES), lines: all.lines.slice(-PUSH_LINES), dropped: 0 };
    return linesText(l, RESULT_MAX_CHARS - status.length - 1, c ? `\`read\` with \`command: ${c.id}\` gives more of it` : '`read` gives earlier lines');
  }

  private pump(scope: string): void {
    for (const sub of this.subscribers.get(scope) ?? []) {
      if (sub.busy || sub.gone) continue;
      const next = this.nextUnseen(scope, sub.offered);
      if (!next) continue;
      sub.offered = next.u.seq;
      sub.busy = true;
      void sub
        .sink(next.u.wake)
        .catch(() => false)
        .then((accepted) => {
          sub.busy = false;
          if (accepted) this.forget(next.e, next.u);
          if (!sub.gone) this.pump(scope);
        });
    }
  }

  private nextUnseen(scope: string, after: number): { e: Entry; u: Unseen } | undefined {
    let best: { e: Entry; u: Unseen } | undefined;
    for (const e of this.entries.values()) {
      if (e.scope !== scope) continue;
      for (const u of e.unseen.values()) if (u.seq > after && (!best || u.seq < best.u.seq)) best = { e, u };
    }
    return best;
  }

  private forget(e: Entry, u: Unseen): void {
    if (e.unseen.get(u.wake.key) === u) e.unseen.delete(u.wake.key);
  }
}

async function firstMatch(re: RegExp, l: Lines, deadline: number, stopped: () => boolean): Promise<{ match?: Match; to: number }> {
  for (let i = 0; i < l.lines.length; i++) {
    if (stopped() || mono() >= deadline) return { to: l.from + i };
    const t = testBounded(re, l.lines[i]!);
    if (t.matched) return { match: { line: l.from + i, text: l.lines[i]!, ...(t.clipped ? { clipped: true as const } : {}) }, to: l.from + i + 1 };
    await turn();
  }
  return { to: l.to };
}

const RAN_OUT = `before the ${WAIT_MAX_S} s a call may hold ran out`;

const endedLine = (c: Command): string => `Command ${c.id} ended: ${endingText(c).join(' · ')}.`;

const endOf = (c: Command): Command[] => (c.end ? [c] : []);

const occurrenceOf = (ev: Exclude<SessionEvent, { kind: 'match' }>): object => (ev.kind === 'ended' ? ev.command : ev.kind === 'waiting' ? ev.front : ev.exit);

const typedText = (c: Command): string => `Command ${c.id} was typed${c.end ? `, and ended: ${endingText(c).join(' · ')}` : ', and the close ended its shell before it ended'}.`;

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

const matchedText = (m: Match): string => `Matched ${m.row === undefined ? `at line ${m.line}` : `on the screen, row ${m.row + 1}`}: ${quoted(m.text)}${m.clipped ? ` (${headOnlyText()})` : ''}`;

const CANCELLED: ToolResult = { text: 'The call was cancelled.', structured: { error: 'cancelled' }, isError: true };

const UNKNOWN_AFTER_FAILURE: Record<string, string> = {
  open: 'Whether the session opened is unknown; `list` shows the sessions open.',
  close: 'Whether the shell ended is unknown; `list` shows whether the session is still open.',
  run: 'Whether anything was typed or run is unknown; `look` shows the session as it is.',
  send: 'Whether anything was typed is unknown; `look` shows the session as it is.',
  stop: 'Whether a signal was sent is unknown; `look` shows what is in front.',
  integrate: 'Whether anything was typed is unknown; `look` shows the session as it is.',
};

const capitalized = (s: string): string => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

function searchEndedText(call: 'send' | 'look', r: { unsearched?: number; clipped?: number }, pushes: boolean, left: { from: number; to: number; rows: number } | undefined): string {
  const clipped = r.clipped ? `; ${headOnlyText(r.clipped)}` : '';
  if (!r.unsearched || !left) {
    if (call === 'send') return `The wait ended before the pattern matched${clipped}.`;
    return `The wait ended first${clipped}.${pushes ? ' The match will be reported to you when it comes.' : ' `look` with the same `match` again waits for it.'}`;
  }
  const n = `${r.unsearched} line${r.unsearched === 1 ? '' : 's'}`;
  const rows = left.rows ? ` The screen's ${left.rows} row${left.rows === 1 ? '' : 's'} it didn't reach are on the screen now.` : '';
  const next = pushes ? ' The match will be reported to you when it comes.' : ` \`read\` with \`match\` and \`lines: [${left.from}, ${left.to}]\` searches them.${rows}`;
  return `The wait ended with ${n} not yet searched, and no match in those it searched${clipped}.${next}`;
}

const reportsText = (n: number): string => `${n} report${n === 1 ? '' : 's'} not yet seen`;

function laterText(until: 'end' | 'input', pushes: boolean, commandRunning: boolean, front: Front): string {
  if (until === 'end') {
    if (!commandRunning) return 'No command is running, so no end will be reported; the status line says what is in front.';
    return pushes ? 'The end will be reported to you when it comes.' : '`look` with `until: "end"` again waits for it.';
  }
  if (front.state === 'running' && !front.waitVisible) return "This system can't show a program waiting for input, so none will be reported; `look` again shows what is in front.";
  return pushes ? 'A wait for input will be reported to you when it comes.' : '`look` with `until: "input"` again waits for it.';
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { text: fitted(text), structured: boundedStrings(structured) };
}

function refused(text: string, structured: Record<string, unknown>): ToolResult {
  return { text: fitted(text), structured: boundedStrings(structured), isError: true };
}

const closedMeanwhile = (e: Entry, happened = '', ended: Command[] = []): ToolResult =>
  refused(`Session ${JSON.stringify(e.name)} was closed while this call waited.${happened ? ` ${happened}` : ''} \`list\` shows the sessions still open.`, { error: 'session_exited', session: e.name, ...(ended.length ? { ended } : {}) });

function integrateHint(argv: string): string {
  const program = path.basename(argv.trim().split(/\s+/)[0] ?? '').replace(/^-/, '');
  if (program === 'ssh') return ' At the prompt of the shell it reached, `integrate` gives that shell statuses.';
  if (program === 'bash' || program === 'zsh' || program === 'fish') return ' At its prompt, `integrate` gives it statuses.';
  return '';
}

function refusalAdvice(front: Front): string {
  switch (front.state) {
    case 'prompt':
      return `${quotedString(front.pending ?? '')} is typed at the prompt and not run. \`send\` with \`keys: ["C-e", "C-u"]\` clears the line, or \`keys: ["Enter"]\` runs it.`;
    case 'running':
      if (front.within) return `the shell within ${quoted(front.within.argv)} is running a command. \`look\` with \`until: "end"\` waits for it, \`send\` types into it, \`stop\` types Ctrl-C to it.`;
      if (front.starting) return `the shell is still running its startup files${front.process.shell ? '' : `, now ${quoted(front.process.argv)}`}, and \`run\` works once it has drawn its first prompt. \`look\` shows what it prints, \`send\` types into it.`;
      if (front.process.shell) return 'the shell itself is busy. `look` with `until: "end"` waits for it, `send` types into it. If a command removed the session\'s prompt hooks, `close` it and `open` it again.';
      return `${quoted(front.process.argv)} is running. \`look\` with \`until: "end"\` waits for it, \`send\` types into it, \`stop\` stops it.${integrateHint(front.process.argv)}`;
    case 'waiting': {
      const waits = `${quoted(front.process.argv)} is waiting for input${front.starting ? " in the shell's startup files" : ''}. \`send\` answers it`;
      return front.process.shell ? `${waits}.` : `${waits}, \`stop\` stops it.${integrateHint(front.process.argv)}`;
    }
    case 'exited':
      return 'the shell has exited. `close` this session and `open` another.';
  }
}
