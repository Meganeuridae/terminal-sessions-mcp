import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { historyIsolationEnv } from '../core/env.js';
import { err } from '../core/errors.js';
import { shellLaunch, viaBash } from '../core/launch.js';
import * as integration from './integration.js';
import type { Nonce } from './integration.js';
import * as proc from './proc.js';
import { Transcript, type Pos } from './transcript.js';
import type { Command, Ending, Exit, Front, Lines, Match, OpenOptions, OpenSession, Process, RunOutcome, Screen, SendOutcome, Session, SessionEvent, ShellKind, StopOutcome, StopStep, Until, WaitOutcome } from './types.js';

const LINUX = process.platform === 'linux';
const TICK_MS = 50;
const POLL_MS = 250;
const HOOKS_QUIET_MS = 500;
const STEP_GRACE_MS = 1500;
const CLOSE_GRACE_MS = 2000;
const RECENT_NONCES = 64;
const MAX_COMMANDS = 10_000;

const randomDigits = (): string => Array.from({ length: 4 }, () => String(randomInt(10000, 100000))).join('');

function findBash(): string | undefined {
  for (const p of ['/bin/bash', ...(process.env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'bash'))]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return undefined;
}

const unescape = (v: string): string => v.replace(/\\(\\|x([0-9a-f]{2}))/g, (_, c: string, hex: string | undefined) => (hex ? String.fromCharCode(Number.parseInt(hex, 16)) : c));

interface Call {
  take: boolean;
  ended: Command[];
  own?: number;
}

class LiveSession implements Session {
  readonly name: string;
  readonly pid: number;
  readonly openedAt = Date.now();
  private readonly t: Transcript;
  private readonly pts: string;
  private readonly shellName: string;
  private expected: Nonce;
  private readonly recent: string[] = [];
  private atPrompt = false;
  private inCommand = false;
  private submitted = false;
  private sentPending: string | undefined;
  private promptAt: Pos | undefined;
  private readonly commands = new Map<number, Command>();
  private running: Command | undefined;
  private lastEnded: Command | undefined;
  private runCommand: Command | undefined;
  private refused = 0;
  private cwdNow: string;
  private exitInfo: Exit | undefined;
  private exitedAt = 0;
  private lastOutput = 0;
  private lastWrite = 0;
  private frontKey = '';
  private frontSince = Date.now();
  private waitingKey = '';
  private readonly calls = new Set<Call>();
  private readonly wakers = new Set<() => void>();
  private readonly watches = new Map<number, { pattern: RegExp; from: number }>();
  private watchSeq = 0;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private poll: NodeJS.Timeout | undefined;
  private hooksLost = false;
  private execed = false;
  private opened = false;
  private closed = false;

  constructor(
    o: OpenOptions,
    private readonly p: pty.IPty,
    private readonly dir: string,
    readonly kind: ShellKind,
    nonce: Nonce,
    private readonly nextId: () => number,
    private readonly argvAtOpen: string,
  ) {
    this.name = o.name;
    this.pid = p.pid;
    this.cwdNow = o.cwd;
    this.expected = nonce;
    this.remember(nonce);
    this.shellName = path.basename(o.shell);
    this.pts = (p as unknown as { ptsName?: string; _pty?: string }).ptsName ?? (p as unknown as { _pty?: string })._pty ?? '';
    this.t = new Transcript(o.cols, o.rows, {
      reply: (d) => this.p.write(d),
      pressure: (paused) => (paused ? this.p.pause() : this.p.resume()),
      redact: (s) => this.redact(s),
      mark: (payload, at) => this.mark(payload, at),
    });
    p.onData((d) => {
      this.lastOutput = Date.now();
      this.t.write(d, () => {
        this.checkWatches();
        this.wake();
      });
    });
    p.onExit(({ exitCode, signal }) => void this.exited(signal ? { code: null, signal: `SIG${signalName(signal)}` } : { code: exitCode }));
    this.schedulePoll();
  }

  async ready(waitMs: number): Promise<void> {
    await this.until(Date.now() + waitMs, () => (this.atPrompt || this.exitInfo || (this.kind === 'none' && this.front().state === 'prompt') ? true : undefined));
    if (!this.atPrompt && this.kind !== 'none') this.hooksLost = true;
    this.opened = true;
  }

  get exit(): Exit | undefined {
    return this.exitInfo;
  }

  startupText(): string {
    return this.t.lines(0).lines.join('\n').trim();
  }

  private remember(n: Nonce): void {
    this.recent.push(n.random);
    if (this.recent.length > RECENT_NONCES) this.recent.shift();
  }

  private redact(s: string): string {
    if (!/\d{20}|[0-9a-f]{16}/.test(s)) return s;
    for (const r of this.recent) if (s.includes(r)) s = s.replaceAll(r, '[redacted]');
    return s;
  }

  private mark(payload: string, at: Pos): boolean {
    const [kind, nonce, ...rest] = payload.split(';');
    const expected = integration.nonceText(this.expected);
    if (kind === 'C' && nonce === expected && this.inCommand) return false;
    const ok = nonce === expected && !this.exitInfo;
    if (kind === 'C' && ok) return this.started(at, rest[0] ? unescape(rest[0]) : undefined), true;
    if (kind === 'D' && ok) {
      const [next, status, pipe, flags, cwd, flushed] = rest;
      const m = /^(\d+)\.(\w+)$/.exec(next ?? '');
      if (m && Number(m[1]) === this.expected.counter + 1) {
        this.ended(at, { status: Number(status), pipe: (pipe ?? '').split(' ').filter(Boolean).map(Number), flags: flags ?? '', cwd: unescape(cwd ?? ''), flushed: unescape(flushed ?? '') });
        this.expected = { counter: Number(m[1]), random: m[2]! };
        this.remember(this.expected);
        return true;
      }
    }
    if (kind === 'B' && ok && this.atPrompt) {
      this.promptAt = at;
      return false;
    }
    if (kind === 'C' || kind === 'D' || kind === 'B') this.refused++;
    return false;
  }

  private started(at: Pos, text: string | undefined): void {
    this.inCommand = true;
    this.atPrompt = false;
    this.submitted = false;
    this.sentPending = undefined;
    this.promptAt = undefined;
    const from = at.col > 0 ? at.line + 1 : at.line;
    let c = this.runCommand;
    this.runCommand = undefined;
    if (c) c.from = from;
    else {
      c = { id: this.nextId(), from, startedAt: Date.now() };
      if (text !== undefined && text !== '') c.text = text;
      this.store(c);
    }
    this.running = c;
    this.wake();
  }

  private ended(at: Pos, d: { status: number; pipe: number[]; flags: string; cwd: string; flushed: string }): void {
    this.inCommand = false;
    this.hooksLost = false;
    this.atPrompt = true;
    this.submitted = false;
    this.sentPending = undefined;
    this.promptAt = undefined;
    if (d.cwd) this.cwdNow = d.cwd;
    const c = this.running;
    this.running = undefined;
    if (c) {
      const end: Ending = { at: Date.now(), status: d.status, errexit: d.flags.includes('e'), refusedMarks: this.refused };
      if (d.pipe.length > 1) end.pipeline = d.pipe;
      if (d.cwd) end.cwd = d.cwd;
      if (d.flushed) end.flushed = d.flushed;
      this.finish(c, at, end);
    }
    this.refused = 0;
    this.wake();
  }

  private finish(c: Command, at: Pos | undefined, end: Ending): void {
    const to = at ? (at.col > 0 ? at.line + 1 : at.line) : this.t.end();
    c.to = Math.max(to, c.from);
    c.end = end;
    this.lastEnded = c;
    let taken = false;
    for (const call of this.calls) {
      if (call.own !== undefined && call.own !== c.id) continue;
      call.ended.push(c);
      taken ||= call.take;
    }
    this.emit({ kind: 'ended', command: c, taken });
  }

  private store(c: Command): void {
    this.commands.set(c.id, c);
    if (this.commands.size > MAX_COMMANDS) this.commands.delete(this.commands.keys().next().value!);
  }

  private async exited(exit: Exit): Promise<void> {
    await this.t.settled();
    this.exitInfo = exit;
    this.exitedAt = Date.now();
    const c = this.running ?? this.runCommand;
    this.running = this.runCommand = undefined;
    if (c) this.finish(c, undefined, { at: Date.now(), errexit: false, refusedMarks: this.refused });
    this.atPrompt = false;
    if (this.poll) clearTimeout(this.poll);
    this.emit({ kind: 'exited', exit, taken: [...this.calls].some((c) => c.take) });
    this.wake();
  }

  private emit(e: SessionEvent): void {
    queueMicrotask(() => {
      for (const l of this.listeners) l(e);
    });
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }

  private schedulePoll(): void {
    if (!LINUX || this.exitInfo || this.closed) return;
    this.poll = setTimeout(() => {
      if (!this.atPrompt) this.observe(this.front());
      this.schedulePoll();
    }, POLL_MS);
    this.poll.unref();
  }

  private observe(f: Front): void {
    if (f.state !== 'waiting') {
      this.waitingKey = '';
      return;
    }
    const key = `${f.process.pgid}:${f.since}`;
    if (key === this.waitingKey) return;
    this.waitingKey = key;
    this.emit({ kind: 'waiting', front: f, taken: [...this.calls].some((c) => c.take) });
  }

  private since(key: string): number {
    if (key !== this.frontKey) {
      this.frontKey = key;
      this.frontSince = Date.now();
    }
    return this.frontSince;
  }

  front(): Front {
    if (this.exitInfo) return { state: 'exited', since: this.exitedAt, exit: this.exitInfo };
    const g = proc.groups(this.pid);
    const command = this.running?.id ?? this.runCommand?.id;
    const at = <T extends object>(o: T): T => (command !== undefined ? { ...o, command } : o);
    if (!g || g.tpgid === g.pgrp) {
      if (this.atPrompt && !this.submitted) {
        const pending = this.pending();
        return { state: 'prompt', since: this.since('prompt'), ...(pending !== undefined && { pending }) };
      }
      const process: Process = { pgid: g?.pgrp ?? this.pid, argv: proc.argv(this.pid) ?? this.shellName, shell: true };
      const reads = proc.readsTerminal(this.pid, this.pts);
      if ((!this.submitted || this.kind === 'none' || this.hooksLost) && this.withoutHooks(reads)) {
        this.submitted = false;
        const open = this.running ?? this.runCommand;
        if (open) {
          this.running = this.runCommand = undefined;
          this.inCommand = false;
          if (this.kind !== 'none') this.hooksLost = true;
          this.finish(open, { line: this.t.pos().line, col: 0 }, { at: Date.now(), errexit: false, refusedMarks: this.refused });
          this.refused = 0;
        }
        const pending = this.sentPending;
        return { state: 'prompt', since: this.since('prompt'), ...(pending !== undefined && { pending }) };
      }
      if (reads && !this.plain) return at({ state: 'waiting', since: this.since(`w:${process.pgid}`), process, echo: proc.modes(this.pts)?.echo ?? true });
      return at({ state: 'running', since: this.since(`r:${process.pgid}`), process, waitVisible: reads !== undefined && !this.plain });
    }
    const members = proc.descendants(this.pid)?.filter((d) => d.pgrp === g.tpgid).map((d) => d.pid) ?? [];
    const process: Process = { pgid: g.tpgid, argv: proc.argv(g.tpgid) ?? (members[0] !== undefined ? proc.argv(members[0]) : undefined) ?? '?', shell: false };
    const reads = members.map((m) => proc.readsTerminal(m, this.pts));
    if (reads.includes(true)) return at({ state: 'waiting', since: this.since(`w:${g.tpgid}`), process, echo: proc.modes(this.pts)?.echo ?? true });
    return at({ state: 'running', since: this.since(`r:${g.tpgid}`), process, waitVisible: members.length > 0 && !reads.includes(undefined) });
  }

  /**
   * A shell with no integration, or whose hooks are gone, is at its prompt once output is quiet and
   * it waits at its line editor, which holds the terminal out of canonical mode, or, with no line
   * editor (dash), reads the terminal itself. A shell whose process now runs another program (an
   * exec) is treated as one without integration.
   */
  private withoutHooks(reads: boolean | undefined): boolean {
    if (this.atPrompt || Date.now() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS) return false;
    if (this.kind !== 'none' && !this.execed && this.opened) {
      const now = proc.argv(this.pid);
      if (now !== undefined && now !== this.argvAtOpen) this.execed = this.hooksLost = true;
    }
    if (this.kind !== 'none' && !this.hooksLost && !this.inCommand && !this.runCommand) return false;
    if (reads) return this.plain;
    return proc.modes(this.pts)?.canonical === false;
  }

  private get plain(): boolean {
    return this.kind === 'none' || this.execed;
  }

  private pending(): string | undefined {
    const b = this.promptAt;
    if (!b) return this.sentPending;
    const cur = this.t.pos();
    if (cur.line < b.line || (cur.line === b.line && cur.col <= b.col)) return undefined;
    const ls = this.t.lines(b.line, cur.line + 1).lines;
    const text = ls.length === 1 ? ls[0]!.slice(b.col, cur.col) : [ls[0]!.slice(b.col), ...ls.slice(1, -1), ls.at(-1)!.slice(0, cur.col)].join('\n');
    return text.trim() ? text : undefined;
  }

  cwd(): string {
    return this.cwdNow;
  }

  current(): Command | undefined {
    return this.running ?? this.runCommand;
  }

  last(): Command | undefined {
    return this.lastEnded;
  }

  command(id: number): Command | undefined {
    return this.commands.get(id);
  }

  lines(from: number, to?: number): Lines {
    return this.t.lines(from, to);
  }

  screen(): Screen {
    return this.t.screen();
  }

  keyOptions(): { appCursor: boolean } {
    return { appCursor: this.t.appCursor };
  }

  private until<T>(deadline: number, done: () => T | undefined): Promise<T | undefined> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (v: T | undefined) => {
        this.wakers.delete(check);
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      const check = () => {
        const v = done();
        if (v !== undefined) return finish(v);
        if (Date.now() >= deadline) return finish(undefined);
      };
      const tick = () => {
        check();
        if (this.wakers.has(check)) timer = setTimeout(tick, Math.min(TICK_MS, Math.max(0, deadline - Date.now())));
      };
      this.wakers.add(check);
      tick();
    });
  }

  private enter(take: boolean, own?: number): Call {
    const call: Call = own !== undefined ? { take, ended: [], own } : { take, ended: [] };
    this.calls.add(call);
    return call;
  }

  async run(text: string, opts: { waitMs: number; take?: boolean }): Promise<RunOutcome> {
    const f = this.front();
    if (f.state !== 'prompt' || f.pending !== undefined) return { kind: 'refused', front: f };
    const deadline = Date.now() + opts.waitMs;
    const id = this.nextId();
    const c: Command = { id, text, from: this.t.pos().line + 1, startedAt: Date.now() };
    this.store(c);
    const via = this.plain ? 'none' : this.kind;
    const cf = integration.commandFile(via, this.dir, id, text);
    if (via !== 'none') fs.writeFileSync(cf.file, cf.body, { mode: 0o600 });
    this.runCommand = c;
    this.submitted = true;
    const call = this.enter(opts.take ?? true, id);
    this.lastWrite = Date.now();
    this.p.write(cf.line);
    try {
      await this.until(deadline, () => {
        if (c.end || this.exitInfo) return true;
        if (this.kind !== 'none' && Date.now() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS) return undefined;
        return this.front().state === 'waiting' || c.end ? true : undefined;
      });
      await this.t.settled();
    } finally {
      this.calls.delete(call);
      if (via !== 'none' && c.end) fs.rmSync(cf.file, { force: true });
    }
    const front = this.front();
    this.observe(front);
    return c.end ? { kind: 'ended', command: c, front } : { kind: 'running', command: c, front };
  }

  async send(bytes: string, opts: { waitMs: number; until?: RegExp; quietMs?: number; take?: boolean }): Promise<SendOutcome> {
    const from = this.t.pos().line;
    if (this.exitInfo) return { sent: false, lines: this.t.lines(from), front: this.front(), ended: [], by: 'exited' };
    const deadline = Date.now() + opts.waitMs;
    const quiet = opts.quietMs ?? 300;
    if (this.atPrompt && !this.submitted) {
      if (/[\r\n]/.test(bytes)) this.submitted = true;
      else this.sentPending = (this.sentPending ?? '') + bytes;
    }
    const call = this.enter(opts.take ?? true);
    const sentAt = (this.lastWrite = Date.now());
    this.p.write(bytes);
    let matched: Match | undefined;
    let by: SendOutcome['by'] = 'timeout';
    try {
      const r = await this.until(deadline, () => {
        if (this.exitInfo) return 'exited' as const;
        if (opts.until) return (matched = this.search(opts.until, from)) ? ('match' as const) : undefined;
        return Date.now() - Math.max(this.lastOutput, sentAt) >= quiet ? ('quiet' as const) : undefined;
      });
      if (r) by = r;
      await this.t.settled();
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front);
    const screen = this.t.screen();
    return { sent: true, lines: this.t.lines(from), ...(screen.alt && { screen }), front, ended: call.ended, ...(matched && { matched }), by };
  }

  async wait(until: Until, opts: { waitMs: number; from: number; take?: boolean }): Promise<WaitOutcome> {
    const deadline = Date.now() + opts.waitMs;
    const call = this.enter(opts.take ?? true);
    let matched: Match | undefined;
    let by: WaitOutcome['by'] = 'timeout';
    try {
      const r = await this.until(deadline, () => {
        if (this.exitInfo) return 'exited' as const;
        if (until.kind === 'match') return (matched = this.search(until.pattern, opts.from)) ? ('match' as const) : undefined;
        if (this.atPrompt && !this.submitted) return until.kind === 'end' ? ('end' as const) : undefined;
        if (!LINUX && this.kind !== 'none' && Date.now() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS) return undefined;
        const s = this.front().state;
        if (s === 'waiting') return 'input' as const;
        return until.kind === 'end' && s === 'prompt' ? ('end' as const) : undefined;
      });
      if (r) by = r;
      await this.t.settled();
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front);
    return { by, front, ended: call.ended, ...(matched && { matched }) };
  }

  private search(pattern: RegExp, from: number): Match | undefined {
    const ls = this.t.lines(from);
    for (let i = 0; i < ls.lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(ls.lines[i]!)) return { line: ls.from + i, text: ls.lines[i]! };
    }
    return undefined;
  }

  async stop(signal?: NodeJS.Signals): Promise<StopOutcome> {
    const steps: StopStep[] = [];
    let f = this.front();
    if (f.state === 'prompt' || f.state === 'exited') return { steps, front: f };
    const target = f.process;
    const gone = (now: Front): boolean => now.state === 'prompt' || now.state === 'exited' || (!now.process.shell && now.process.pgid !== target.pgid);
    const cleared = async (): Promise<Front> => (await this.until(Date.now() + STEP_GRACE_MS, () => (gone(this.front()) ? this.front() : undefined))) ?? this.front();
    const step = async (sent: StopStep['sent']): Promise<boolean> => {
      if (sent === 'C-c') {
        this.lastWrite = Date.now();
        this.p.write('\x03');
      }
      else proc.signalGroup(target.pgid, sent);
      f = await cleared();
      steps.push({ sent, ...(sent !== 'C-c' && { to: target }), front: f });
      return gone(f);
    };
    if (signal) {
      if (target.shell) return { steps, front: f, next: 'close' };
      await step(signal);
      return { steps, front: f };
    }
    if (await step('C-c')) return { steps, front: f };
    if (target.shell) return { steps, front: f, next: 'close' };
    for (const s of ['SIGTERM', 'SIGKILL'] as const) if (await step(s)) return { steps, front: f };
    return { steps, front: f, next: 'close' };
  }

  async close(opts: { force?: boolean } = {}): Promise<Exit> {
    this.closed = true;
    if (this.poll) clearTimeout(this.poll);
    if (!this.exitInfo) {
      const kill = () => {
        for (const d of proc.descendants(this.pid) ?? []) proc.signalGroup(d.pgrp, 'SIGKILL');
        try {
          this.p.kill('SIGKILL');
        } catch {}
      };
      if (opts.force) kill();
      else {
        try {
          this.p.kill('SIGHUP');
        } catch {}
        await this.until(Date.now() + CLOSE_GRACE_MS, () => this.exitInfo);
        if (!this.exitInfo) kill();
      }
      await this.until(Date.now() + CLOSE_GRACE_MS, () => this.exitInfo);
    }
    this.t.dispose();
    fs.rmSync(this.dir, { recursive: true, force: true });
    return this.exitInfo ?? { code: null, signal: 'SIGKILL' };
  }

  watch(pattern: RegExp, from: number): number {
    const id = ++this.watchSeq;
    this.watches.set(id, { pattern, from });
    queueMicrotask(() => this.checkWatches());
    return id;
  }

  unwatch(id: number): void {
    this.watches.delete(id);
  }

  private checkWatches(): void {
    for (const [id, w] of this.watches) {
      const m = this.search(w.pattern, w.from);
      if (m) {
        this.watches.delete(id);
        this.emit({ kind: 'match', watch: id, match: m });
      } else {
        const ls = this.t.lines(w.from);
        w.from = Math.max(w.from, ls.to - ls.live);
      }
    }
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const SIGNALS: Record<number, string> = { 1: 'HUP', 2: 'INT', 3: 'QUIT', 6: 'ABRT', 9: 'KILL', 13: 'PIPE', 15: 'TERM' };
const signalName = (n: number): string => SIGNALS[n] ?? String(n);

export const openSession: OpenSession = async (o) => {
  let isDir = false;
  try {
    isDir = fs.statSync(o.cwd).isDirectory();
  } catch {}
  if (!isDir) throw err('invalid_argument', `cwd ${o.cwd} is not a directory`);
  try {
    fs.accessSync(o.shell, fs.constants.X_OK);
  } catch {
    throw err('backend_failure', `the shell ${o.shell} cannot be run`);
  }
  const bash = findBash();
  if (!bash) throw err('backend_failure', 'this host has no bash, which closes the descriptors a shell would otherwise inherit from the daemon');
  const dir = fs.mkdtempSync(path.join(o.parent, 's-'));
  const nonce: Nonce = { counter: 1, random: randomDigits() };
  const launch = integration.prepare(o.shell, dir, nonce, o.env);
  const env = { ...o.env, ...historyIsolationEnv(dir), ...launch.env };
  const [file, args] = viaBash(bash, shellLaunch(o.oomScoreAdj ?? 0), 'tsm-shell', [o.shell, ...launch.args]);
  let p: pty.IPty;
  try {
    p = pty.spawn(file, args, { name: env.TERM ?? 'xterm-256color', cwd: o.cwd, env, cols: o.cols, rows: o.rows });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err('backend_failure', `the shell could not start: ${(e as Error).message}`);
  }
  const s = new LiveSession(o, p, dir, launch.kind, nonce, o.nextCommandId, [o.shell, ...launch.args].join(' '));
  await s.ready(o.waitMs);
  if (s.exit) {
    const said = s.startupText();
    await s.close();
    throw err('backend_failure', `the shell exited as it started (${s.exit.signal ?? `status ${s.exit.code}`})${said ? `: ${said.slice(-500)}` : ''}`);
  }
  return s;
};
