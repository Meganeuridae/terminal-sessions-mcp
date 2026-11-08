import * as os from 'node:os';
import * as path from 'node:path';
import { validate, ValidationError } from '../api/validate.js';
import { TermError } from '../core/errors.js';
import { inputBytes } from '../core/keys.js';
import { compileUserRegex, headOnlyText, testBounded } from '../core/regex.js';
import type { Command, Front, Lines, OpenSession, Session, SessionEvent } from '../session/types.js';
import { endingText, exitText, frontText, linesText, RESULT_MAX_CHARS, screenText, statusLine } from './render.js';
import { SESSION_NAME_RE, TOOLS, WAIT_DEFAULT_S, type ToolDef } from './table.js';

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
}

interface Unseen {
  key: string;
  text: string;
}

interface Entry {
  scope: string;
  name: string;
  session: Session;
  cursor: number;
  unseen: Map<string, Unseen>;
  watches: Map<number, string>;
  dying: number | undefined;
  off: () => void;
}

const PUSH_LINES = 20;

const keyOf = (scope: string, name: string): string => `${scope}\u0000${name}`;

export class Host {
  private readonly entries = new Map<string, Entry>();
  private readonly sinks = new Map<string, Set<WakeSink>>();
  private nextId = 1;
  private readonly now: () => number;

  constructor(private readonly o: HostOptions) {
    this.now = o.now ?? Date.now;
  }

  tools(): readonly ToolDef[] {
    return TOOLS;
  }

  subscribe(scope: string, sink: WakeSink): () => void {
    let set = this.sinks.get(scope);
    if (!set) this.sinks.set(scope, (set = new Set()));
    set.add(sink);
    return () => set.delete(sink);
  }

  async call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
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
      switch (tool) {
        case 'run':
          return await this.run(caller, entry, a);
        case 'send':
          return await this.send(caller, entry, a);
        case 'look':
          return await this.look(caller, entry, a);
        case 'read':
          return this.read(entry, a);
        case 'stop':
          return await this.stop(entry, a);
        case 'close':
          return await this.close(entry, a);
      }
      return refused(`\`${tool}\` isn't handled here.`, { error: 'unknown_tool' });
    } catch (e) {
      if (e instanceof TermError) return refused(e.message, { error: e.code });
      throw e;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.session.close().catch(() => undefined)));
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

  private regex(pattern: string): RegExp {
    return compileUserRegex(pattern);
  }

  private async open(caller: Caller, a: Record<string, unknown>): Promise<ToolResult> {
    const name = a.name as string;
    if (!SESSION_NAME_RE.test(name)) return refused(`${JSON.stringify(name)} isn't a session name: 1 to 64 letters, digits, ".", "_" or "-".`, { error: 'invalid_argument' });
    const k = keyOf(caller.scope, name);
    if (this.entries.has(k)) return refused(`A session named ${JSON.stringify(name)} is already open in this scope. Use it, or \`close\` it first.`, { error: 'session_exists', session: name });
    const raw = (a.cwd as string | undefined) ?? '~';
    const cwd = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    if (!path.isAbsolute(cwd)) return refused(`The directory ${JSON.stringify(raw)} must be absolute, or start with "~".`, { error: 'invalid_argument' });
    const session = await this.o.openSession({
      name,
      shell: this.o.shell,
      cwd,
      cols: (a.cols as number | undefined) ?? 120,
      rows: (a.rows as number | undefined) ?? 40,
      env: this.o.env,
      parent: this.o.sessionsDir,
      nextCommandId: () => this.nextId++,
      waitMs: this.waitMs(a),
      ...(this.o.oomScoreAdj ? { oomScoreAdj: this.o.oomScoreAdj } : {}),
    });
    if (this.entries.has(k)) {
      await session.close({ force: true });
      return refused(`A session named ${JSON.stringify(name)} was opened in this scope while this one started; this one is closed.`, { error: 'session_exists', session: name });
    }
    const entry: Entry = { scope: caller.scope, name, session, cursor: 0, unseen: new Map(), watches: new Map(), dying: undefined, off: () => {} };
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
      return { e, front, line: `${e.name}: ${frontText(front, now)} · ${e.session.cwd()}${e.unseen.size ? ` · ${e.unseen.size} ending${e.unseen.size === 1 ? '' : 's'} not yet seen` : ''}` };
    });
    const unseen = rows.flatMap((r) => [...r.e.unseen.values()].map((u) => u.text));
    if (caller.takes) for (const r of rows) r.e.unseen.clear();
    return ok([...rows.map((r) => r.line), ...(unseen.length ? ['', 'Not yet seen:', ...unseen] : [])].join('\n'), {
      sessions: rows.map((r) => ({ name: r.e.name, front: r.front, cwd: r.e.session.cwd() })),
      unseen,
    });
  }

  private async run(caller: Caller, e: Entry, a: Record<string, unknown>): Promise<ToolResult> {
    const notify = a.notify_on !== undefined ? this.regex(a.notify_on as string) : undefined;
    const r = await e.session.run(a.command as string, { waitMs: this.waitMs(a), take: caller.takes });
    if (r.kind === 'refused') return refused(`${this.status(e, r.front)}\nNothing was typed: ${refusalAdvice(r.front)}`, { error: 'not_at_prompt', front: r.front });
    const c = r.command;
    if (r.kind === 'running' && notify) e.watches.set(e.session.watch(notify, c.from), this.pushKey(e, c.id));
    const out = e.session.lines(c.from, c.to);
    if (caller.takes) e.cursor = Math.max(e.cursor, out.to - (r.kind === 'ended' ? 0 : out.live));
    const head = this.status(e, r.front, c);
    const tail = r.kind === 'running'
      ? `\nIt keeps running. ${caller.pushes ? 'Its end will be reported to you, or ' : ''}\`look\` with \`until: "end"\` waits for it; \`stop\` stops it.`
      : '';
    const body = this.output(out, c, RESULT_MAX_CHARS - head.length - tail.length - 1);
    return ok(`${head}\n${body}${tail}`, { command: c, front: r.front, running: r.kind === 'running' });
  }

  private async send(caller: Caller, e: Entry, a: Record<string, unknown>): Promise<ToolResult> {
    const bytes = inputBytes(a.text as string | undefined, a.keys as string[] | undefined, e.session.keyOptions());
    if (bytes === '') return refused('Nothing to send: give `text`, `keys`, or both.', { error: 'invalid_argument' });
    const until = a.wait_for !== undefined ? this.regex(a.wait_for as string) : undefined;
    const r = await e.session.send(bytes, { waitMs: this.waitMs(a), take: caller.takes, ...(until ? { until } : {}) });
    if (!r.sent) return refused(`${this.status(e, r.front)}\nNothing was sent: the shell has exited.`, { error: 'session_exited', front: r.front });
    if (caller.takes) e.cursor = Math.max(e.cursor, r.lines.to - r.lines.live);
    const parts = [this.status(e, r.front)];
    for (const c of r.ended) parts.push(`Command ${c.id} ended: ${endingText(c).join(' · ')}.`);
    if (r.by === 'timeout') parts.push(until ? 'The wait ended before the pattern matched.' : 'Output was still changing when the wait ended.');
    if (r.matched) parts.push(`Matched at line ${r.matched.line}: ${r.matched.text}`);
    const used = parts.join('\n').length + 1;
    parts.push(r.screen ? screenText(r.screen) : this.output(r.lines, undefined, RESULT_MAX_CHARS - used));
    return ok(parts.join('\n'), { front: r.front, by: r.by, ended: r.ended, ...(r.matched ? { matched: r.matched } : {}), lines: { from: r.lines.from, to: r.lines.to } });
  }

  private async look(caller: Caller, e: Entry, a: Record<string, unknown>): Promise<ToolResult> {
    if (a.until !== undefined && a.match !== undefined) return refused('Give `until` or `match`, not both.', { error: 'invalid_argument' });
    const parts: string[] = [];
    let front: Front = e.session.front();
    if (a.until !== undefined || a.match !== undefined) {
      const pattern = a.match !== undefined ? this.regex(a.match as string) : undefined;
      const until = pattern ? { kind: 'match' as const, pattern } : { kind: a.until as 'end' | 'input' };
      const w = await e.session.wait(until, { waitMs: this.waitMs(a), from: e.cursor, take: caller.takes });
      front = w.front;
      for (const c of w.ended) parts.push(`Command ${c.id} ended: ${endingText(c).join(' · ')}.`);
      if (w.matched) parts.push(`Matched at line ${w.matched.line}: ${w.matched.text}`);
      if (w.by === 'timeout') {
        if (pattern) {
          const current = e.session.current();
          e.watches.set(e.session.watch(pattern, e.cursor), this.pushKey(e, current?.id));
          parts.push(`The wait ended first.${caller.pushes ? ' The match will be reported to you when it comes.' : ''}`);
        } else parts.push(`The wait ended first.${caller.pushes ? ` ${a.until === 'end' ? 'The end' : 'A wait for input'} will be reported to you when it comes.` : ''}`);
      }
    }
    const lines = e.session.lines(e.cursor);
    const unseen = [...e.unseen.values()].map((u) => u.text);
    if (caller.takes) {
      e.cursor = Math.max(e.cursor, lines.to - lines.live);
      e.unseen.clear();
    }
    const before = [this.status(e, front), ...unseen, ...parts].join('\n');
    const text = `${before}\n${lines.lines.length ? this.output(lines, undefined, RESULT_MAX_CHARS - before.length - 1) : '(no new output)'}`;
    return ok(text, { front, unseen, lines: { from: lines.from, to: lines.to } });
  }

  private read(e: Entry, a: Record<string, unknown>): ToolResult {
    let from = 0;
    let to: number | undefined;
    let what = 'the session\'s output';
    let c: Command | undefined;
    if (a.command !== undefined) {
      c = e.session.command(a.command as number);
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
    if (a.match === undefined) return ok(`${head}\n${this.output(lines, c, RESULT_MAX_CHARS - head.length - 1)}`, { from: lines.from, to: lines.to, dropped: lines.dropped });
    const re = this.regex(a.match as string);
    const ctx = (a.context as number | undefined) ?? 2;
    const hits: number[] = [];
    let clipped = 0;
    lines.lines.forEach((line, i) => {
      const t = testBounded(re, line);
      if (t.clipped) clipped++;
      if (t.matched) hits.push(i);
    });
    const shown = new Set<number>();
    for (const h of hits) for (let i = Math.max(0, h - ctx); i <= Math.min(lines.lines.length - 1, h + ctx); i++) shown.add(i);
    const out: string[] = [];
    let last = -2;
    for (const i of [...shown].sort((x, y) => x - y)) {
      if (i !== last + 1 && out.length) out.push('--');
      out.push(`${lines.from + i}${hits.includes(i) ? ':' : '-'} ${lines.lines[i]}`);
      last = i;
    }
    const body = { from: 0, to: out.length, lines: out, dropped: lines.dropped, live: 0 };
    const counted = `${head}\n${hits.length} matching line${hits.length === 1 ? '' : 's'}${clipped ? `; ${headOnlyText(clipped)}` : ''}`;
    return ok(`${counted}\n${linesText(body, RESULT_MAX_CHARS - counted.length - 1, 'narrow `lines` or the pattern')}`, { matches: hits.map((i) => lines.from + i) });
  }

  private async stop(e: Entry, a: Record<string, unknown>): Promise<ToolResult> {
    const r = await e.session.stop(a.signal !== undefined ? (`SIG${a.signal as string}` as NodeJS.Signals) : undefined);
    const now = this.now();
    const steps = r.steps.map((s) => `Sent ${s.sent}${s.to ? ` to ${s.to.argv}` : ''}: now ${frontText(s.front, now)}.`);
    if (!r.steps.length) steps.push(`Nothing was sent: ${frontText(r.front, now)}.`);
    if (r.next === 'close') steps.push('What runs is the shell itself, or a job that outlived KILL: only `close` ends it.');
    return ok([this.status(e, r.front), ...steps].join('\n'), { steps: r.steps, front: r.front, ...(r.next ? { next: r.next } : {}) });
  }

  private async close(e: Entry, a: Record<string, unknown>): Promise<ToolResult> {
    const exit = await e.session.close({ force: a.force === true });
    e.off();
    this.entries.delete(keyOf(e.scope, e.name));
    return ok(`[${e.name} · closed]\nThe shell ${exitText(exit)}.`, { session: e.name, exit });
  }

  private status(e: Entry, front: Front, command?: Command): string {
    return statusLine({ session: e.name, front, cwd: e.session.cwd(), ...(command ? { command } : {}), unseen: e.unseen.size, now: this.now() });
  }

  private output(l: Lines, c: Command | undefined, budget: number): string {
    const hint = c ? `\`read\` with \`command: ${c.id}\` gives it whole` : `\`read\` with \`lines: [${l.from}, ${l.to}]\` gives them`;
    return linesText(l, budget, hint);
  }

  private pushKey(e: Entry, command: number | undefined): string {
    return `${e.scope}/${e.name}/${command ?? 'shell'}`;
  }

  private onEvent(e: Entry, ev: SessionEvent): void {
    const dying = e.dying;
    e.dying = ev.kind === 'ended' && ev.command.end?.status === undefined ? ev.command.id : undefined;
    let wake: Wake;
    switch (ev.kind) {
      case 'ended': {
        if (ev.taken) return;
        const status = this.status(e, e.session.front(), ev.command);
        wake = { scope: e.scope, session: e.name, tag: 'terminal:ended', key: this.pushKey(e, ev.command.id), text: `${status}\n${this.tailText(e, status, ev.command)}` };
        break;
      }
      case 'waiting': {
        if (ev.taken) return;
        const status = this.status(e, ev.front);
        wake = { scope: e.scope, session: e.name, tag: 'terminal:waiting', key: this.pushKey(e, ev.front.command), text: `${status}\n${this.tailText(e, status)}` };
        break;
      }
      case 'exited': {
        if (ev.taken) return;
        const status = `[${e.name} · the shell ${exitText(ev.exit)}]`;
        wake = { scope: e.scope, session: e.name, tag: 'terminal:exited', key: this.pushKey(e, dying), text: `${status}\n${this.tailText(e, status)}` };
        break;
      }
      case 'match': {
        const key = e.watches.get(ev.watch);
        if (key === undefined) return;
        e.watches.delete(ev.watch);
        wake = { scope: e.scope, session: e.name, tag: 'terminal:match', key, text: `${this.status(e, e.session.front())}\nMatched at line ${ev.match.line}: ${ev.match.text}` };
        break;
      }
    }
    e.unseen.set(wake.key, { key: wake.key, text: wake.text.split('\n')[0]! });
    void this.deliver(e, wake);
  }

  private tailText(e: Entry, status: string, c: Command | undefined = e.session.current() ?? e.session.last()): string {
    const screen = e.session.screen();
    if (screen.alt) return screenText(screen);
    const all = e.session.lines(c?.from ?? 0, c?.to);
    const l = { ...all, from: Math.max(all.from, all.to - PUSH_LINES), lines: all.lines.slice(-PUSH_LINES), dropped: 0 };
    return linesText(l, RESULT_MAX_CHARS - status.length - 1, c ? `\`read\` with \`command: ${c.id}\` gives it whole` : '`read` gives the rest');
  }

  private async deliver(e: Entry, w: Wake): Promise<void> {
    const sinks = [...(this.sinks.get(e.scope) ?? [])];
    const results = await Promise.all(sinks.map((s) => s(w).catch(() => false)));
    if (results.some(Boolean)) e.unseen.delete(w.key);
  }
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { text, structured };
}

function refused(text: string, structured: Record<string, unknown>): ToolResult {
  return { text, structured, isError: true };
}

function refusalAdvice(front: Front): string {
  switch (front.state) {
    case 'prompt':
      return `${JSON.stringify(front.pending ?? '')} is typed at the prompt and not run. \`send\` with \`keys: ["C-u"]\` clears it, or \`keys: ["Enter"]\` runs it.`;
    case 'running':
      return `${front.process.shell ? 'the shell itself is busy' : `${front.process.argv} is running`}. \`look\` with \`until: "end"\` waits for it, \`send\` types into it, \`stop\` stops it.`;
    case 'waiting':
      return `${front.process.argv} is waiting for input. \`send\` answers it, \`stop\` stops it.`;
    case 'exited':
      return 'the shell has exited. `close` this session and `open` another.';
  }
}
