import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { historyIsolationEnv } from '../core/env.js';
import { err } from '../core/errors.js';
import { shellLaunch, viaBash } from '../core/launch.js';
import { testBounded } from '../core/regex.js';
import * as integration from './integration.js';
import type { Nonce } from './integration.js';
import * as proc from './proc.js';
import { Transcript, type Pos } from './transcript.js';
import type { Closed, Command, Ending, Exit, Front, Lines, Match, OpenOptions, OpenSession, Process, RunOutcome, Screen, SendOutcome, Session, SessionEvent, ShellKind, StopOutcome, StopStep, Until, WaitOutcome } from './types.js';

const LINUX = process.platform === 'linux';
const TICK_MS = 50;
const POLL_MS = 250;
const HOOKS_QUIET_MS = 500;
const STEP_GRACE_MS = 1500;
const CLOSE_GRACE_MS = 2000;
const HANGUP_EVERY_MS = 500;
const RECENT_NONCES = 64;
const MAX_COMMANDS = 10_000;
/** A process exec'd in the shell's place still counts as a shell when its name is one of these. */
const SHELLS = new Set(['sh', 'ash', 'dash', 'hush', 'bash', 'zsh', 'fish', 'ksh', 'ksh93', 'mksh', 'pdksh', 'oksh', 'yash', 'posh', 'tcsh', 'csh']);
/** `busybox APPLET` is a shell only for its shell applets; an applet run through its own link is named by it. */
const isShell = (argv: string): boolean => {
  const [cmd = '', applet = ''] = argv.split(' ');
  const name = path.basename(cmd).replace(/^-/, '');
  return name === 'busybox' ? ['sh', 'ash', 'hush'].includes(path.basename(applet)) : SHELLS.has(name);
};
/** Deadlines, graces and quiet periods; the times a session reports are wall-clock. */
const mono = (): number => performance.now();

/** Pattern searches in one turn of the event loop, in every session, stop once they've spent this long, each after at least one line or row in that turn, and go on in a later turn. */
const SLICE_MS = TICK_MS;
/** A pattern search fetches the lines it searches this many at a time. */
const SCAN_CHUNK = 16;
let sliceEnd: number | undefined;
/** Counts the turns in which a search started a slice; a search notes the one it last searched in. */
let turn = 0;
/** Whether this turn's pattern searches have spent their slice; the first search in a turn starts it. */
function spent(): boolean {
  if (sliceEnd === undefined) {
    sliceEnd = mono() + SLICE_MS;
    setImmediate(() => {
      sliceEnd = undefined;
      turn++;
    });
    return false;
  }
  return mono() >= sliceEnd;
}

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

/**
 * Where a pattern search has got to. Lines before `from` were searched, didn't match, and are frozen.
 * A pass searches the lines from `from` on, then the alternate screen's rows. `parses`: the parse the pass
 * began after; `next` and `row`: where it goes on, `next` undefined once it's done; `turn`: the turn it last
 * searched in. `clipped`: frozen lines searched on their head only; `clippedLive`: live ones, in the last
 * whole pass; `live`: in this pass so far.
 */
interface Scan {
  from: number;
  parses: number;
  next: number | undefined;
  row: number;
  turn: number;
  clipped: number;
  clippedLive: number;
  live: number;
}

const newScan = (from: number): Scan => ({ from, parses: -1, next: undefined, row: 0, turn: -1, clipped: 0, clippedLive: 0, live: 0 });
/** On macOS a look at the kernel spawns `ps`, so a call's loop looks at most this often. */
const MAC_LOOK_EVERY_MS = 250;
/** How long the shell's own read must have been seen before it counts as a builtin read: a bound on the kernel's delivery of output the shell wrote before it began reading, not a proof. */
const SHELL_READ_FLOOR_MS = 50;

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
  private sentOutputs = -1;
  private promptAt: Pos | undefined;
  /** At a shell without integration: `lastWrite` when `promptAt` was taken, so a prompt drawn later with nothing typed since moves it. */
  private promptAtWrite = -1;
  private readonly commands = new Map<number, Command>();
  private running: Command | undefined;
  private lastEnded: Command | undefined;
  private runCommand: Command | undefined;
  private refused = 0;
  private cwdNow: string;
  private exitInfo: Exit | undefined;
  private ptyExit: Exit | undefined;
  private exitedAt = 0;
  private lastOutput = 0;
  private outputs = 0;
  private parses = 0;
  private echoSeen: { key: string; echo: boolean | undefined } = { key: '', echo: undefined };
  private readonly startedMono = new WeakMap<Command, number>();
  private lastLook = -Infinity;
  private readonly files = new Map<number, string[]>();
  private shellRead: { key: string; turns: number; at: number } | undefined;
  private lastWrite = 0;
  private frontKey = '';
  private frontSince = Date.now();
  private waitingKey = '';
  private readonly calls = new Set<Call>();
  private readonly wakers = new Set<() => void>();
  private readonly watches = new Map<number, { pattern: RegExp; scan: Scan }>();
  private watchSeq = 0;
  private resuming = false;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private poll: NodeJS.Timeout | undefined;
  private drawnOnce = false;
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
    this.lastOutput = mono();
    this.t = new Transcript(o.cols, o.rows, {
      reply: (d) => this.p.write(d),
      pressure: (paused) => (paused ? this.p.pause() : this.p.resume()),
      redact: (s) => this.redact(s),
      mark: (payload, at) => this.mark(payload, at),
    });
    p.onData((d) => {
      if (this.t.disposed) return;
      this.lastOutput = mono();
      this.outputs++;
      this.t.write(d, () => {
        this.parses++;
        this.checkWatches();
        this.wake();
      });
    });
    p.onExit(({ exitCode, signal }) => {
      this.ptyExit = signal ? { code: null, signal: `SIG${signalName(signal)}` } : { code: exitCode };
      this.exitedAt = Date.now();
      void this.exited(this.ptyExit);
    });
    this.schedulePoll();
  }

  async ready(waitMs: number): Promise<void> {
    await this.until(mono() + waitMs, () => (this.prompted || this.exitInfo || (this.kind === 'none' && this.front().state === 'prompt') ? true : undefined));
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
      const [next, status, pipe, flags, cwd] = rest;
      const m = /^(\d+)\.(\w+)$/.exec(next ?? '');
      if (m && Number(m[1]) === this.expected.counter + 1) {
        this.ended(at, { status: Number(status), pipe: (pipe ?? '').split(' ').filter(Boolean).map(Number), flags: flags ?? '', cwd: unescape(cwd ?? ''), flushed: this.drained(this.expected.counter) });
        this.expected = { counter: Number(m[1]), random: m[2]! };
        this.remember(this.expected);
        return true;
      }
    }
    if (kind === 'B' && ok) {
      this.drawnOnce = true;
      if (this.atPrompt && !this.submitted) this.promptAt = at;
      else if (this.running) this.drawnWithoutEnd(at);
      else if (!this.runCommand && (this.promptAt === undefined || at.line > this.promptAt.line)) {
        this.atPrompt = true;
        this.submitted = false;
        this.sentPending = undefined;
        this.promptAt = at;
        this.wake();
      }
      return false;
    }
    if ((kind === 'C' || kind === 'D' || kind === 'B') && /^\d+\.\d+$/.test(nonce ?? '')) this.refused++;
    return false;
  }

  /** The text the prompt hook's drain read before the end mark closing nonce `counter`, from the file it wrote; the file is removed. */
  private drained(counter: number): string {
    const f = path.join(this.dir, `${integration.DRAINED}.${counter}`);
    try {
      const text = fs.readFileSync(f, 'utf8');
      fs.rmSync(f, { force: true });
      return text;
    } catch {
      return '';
    }
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
      this.startedMono.set(c, mono());
    }
    this.running = c;
    this.wake();
  }

  private ended(at: Pos, d: { status: number; pipe: number[]; flags: string; cwd: string; flushed: string }): void {
    this.inCommand = false;
    this.atPrompt = true;
    this.submitted = false;
    this.sentPending = undefined;
    this.promptAt = undefined;
    if (d.cwd) this.cwdNow = d.cwd;
    const c = this.running ?? this.runCommand;
    this.running = this.runCommand = undefined;
    if (c) {
      const end: Omit<Ending, 'ms'> = { at: Date.now(), status: d.status, errexit: d.flags.includes('e'), refusedMarks: this.refused };
      if (d.pipe.length > 1) end.pipeline = d.pipe;
      if (d.cwd) end.cwd = d.cwd;
      if (d.flushed) end.flushed = d.flushed;
      this.finish(c, at, end);
    }
    this.refused = 0;
    this.wake();
  }

  private drawnWithoutEnd(at: Pos): void {
    const c = this.running;
    this.running = undefined;
    this.inCommand = false;
    this.atPrompt = true;
    this.submitted = false;
    this.sentPending = undefined;
    this.promptAt = at;
    if (c) this.finish(c, { line: at.line, col: 0 }, { at: Date.now(), errexit: false, refusedMarks: this.refused });
    this.refused = 0;
    this.wake();
  }

  private get prompted(): boolean {
    return this.atPrompt && !this.submitted && this.promptAt !== undefined;
  }

  private finish(c: Command, at: Pos | undefined, end: Omit<Ending, 'ms'>): void {
    const to = at ? (at.col > 0 ? at.line + 1 : at.line) : this.t.end();
    c.to = Math.max(to, c.from);
    c.end = { ...end, ms: Math.max(0, Math.round(mono() - (this.startedMono.get(c) ?? mono()))) };
    this.lastEnded = c;
    for (const f of this.files.get(c.id) ?? []) fs.rmSync(f, { force: true });
    this.files.delete(c.id);
    let taken = false;
    for (const call of this.calls) {
      if (call.own !== undefined && call.own !== c.id) continue;
      call.ended.push(c);
      taken ||= call.take;
    }
    this.checkWatches(true);
    this.emit({ kind: 'ended', command: c, taken });
  }

  private store(c: Command): void {
    this.commands.set(c.id, c);
    if (this.commands.size > MAX_COMMANDS) this.commands.delete(this.commands.keys().next().value!);
  }

  private async exited(exit: Exit): Promise<void> {
    await this.t.settled();
    this.exitInfo = exit;
    if (this.t.disposed) return;
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
      if (!this.atPrompt || this.submitted) this.observe(this.front(), [...this.calls].some((c) => c.take));
      this.schedulePoll();
    }, POLL_MS);
    this.poll.unref();
  }

  /** Emits `waiting` on each entry into that state. `taken`: the call returning `f`, or a call still open, gives it. */
  private observe(f: Front, taken: boolean): void {
    if (f.state !== 'waiting') {
      this.waitingKey = '';
      return;
    }
    const key = `${f.process.pgid}:${f.since}`;
    if (key === this.waitingKey) return;
    this.waitingKey = key;
    this.emit({ kind: 'waiting', front: f, taken });
  }

  /** The terminal's echo, read once for each wait: `key` names the wait. */
  private echo(key: string): { echo?: boolean } {
    if (this.echoSeen.key !== key) this.echoSeen = { key, echo: proc.modes(this.pts)?.echo };
    return this.echoSeen.echo === undefined ? {} : { echo: this.echoSeen.echo };
  }

  private since(key: string): number {
    if (key !== this.frontKey) {
      this.frontKey = key;
      this.frontSince = Date.now();
    }
    return this.frontSince;
  }

  front(): Front {
    const exit = this.exitInfo ?? this.ptyExit;
    if (exit) return { state: 'exited', since: this.exitedAt, exit };
    this.lastLook = mono();
    const shell = proc.info(this.pid);
    const g = shell?.tpgid !== undefined ? { pgrp: shell.pgrp, tpgid: shell.tpgid } : undefined;
    const command = this.running?.id ?? this.runCommand?.id;
    const at = <T extends object>(o: T): T => (command !== undefined ? { ...o, command } : o);
    const program = (process: Process, reads: Array<boolean | undefined>): Front => {
      if (reads.includes(true)) {
        const since = this.since(`w:${process.pgid}`);
        return at({ state: 'waiting', since, process, ...this.echo(`${process.pgid}:${since}`) });
      }
      return at({ state: 'running', since: this.since(`r:${process.pgid}`), process, waitVisible: reads.length > 0 && !reads.includes(undefined) });
    };
    if (!g || g.tpgid === g.pgrp) {
      if (this.prompted) {
        const pending = this.pending();
        return { state: 'prompt', since: this.since('prompt'), ...(pending !== undefined && { pending }) };
      }
      const pgid = g?.pgrp ?? this.pid;
      const argv = shell?.argv;
      if (this.opened && argv !== undefined && argv !== this.argvAtOpen) this.execed = true;
      const reads = proc.readsTerminal(this.pid, this.pts);
      if (this.execed && argv !== undefined && !isShell(argv)) return program({ pgid, argv, shell: false }, [reads]);
      const process: Process = { pgid, argv: argv ?? this.shellName, shell: true };
      if ((!this.submitted || this.plain) && this.withoutHooks(reads)) {
        if (this.submitted || !this.promptAt || this.lastWrite === this.promptAtWrite) {
          this.promptAt = this.t.pos();
          this.promptAtWrite = this.lastWrite;
        }
        this.submitted = false;
        const open = this.running ?? this.runCommand;
        if (open) {
          this.running = this.runCommand = undefined;
          this.inCommand = false;
          this.finish(open, { line: this.t.pos().line, col: 0 }, { at: Date.now(), errexit: false, refusedMarks: this.refused });
          this.refused = 0;
        }
        const pending = this.pending();
        return { state: 'prompt', since: this.since('prompt'), ...(pending !== undefined && { pending }) };
      }
      const starting = !this.drawnOnce && !this.plain ? { starting: true as const } : {};
      if (reads && !this.plain && (!this.atPrompt || this.submitted)) {
        const since = this.since(`w:${process.pgid}`);
        if (this.shellReadSettled(process.pgid)) return at({ state: 'waiting', since, process, ...this.echo(`${process.pgid}:${since}`), ...starting });
        return at({ state: 'running', since, process, waitVisible: true, ...starting });
      }
      return at({ state: 'running', since: this.since(`r:${process.pgid}`), process, waitVisible: reads !== undefined && !this.plain, ...starting });
    }
    const members = proc.descendants(this.pid)?.filter((d) => d.pgrp === g.tpgid).map((d) => d.pid) ?? [];
    const process: Process = { pgid: g.tpgid, argv: proc.argv(g.tpgid) ?? (members[0] !== undefined ? proc.argv(members[0]) : undefined) ?? '?', shell: false };
    return program(process, members.map((m) => proc.readsTerminal(m, this.pts)));
  }

  /**
   * Whether the shell's own read of the terminal is a builtin read in a command. The line editor reads
   * as soon as the shell has written its end mark and prompt, so when the kernel shows the shell
   * reading, those bytes may still be unread here or unparsed. They were written before the read began,
   * so once the event loop has turned twice since the read was seen with everything received parsed,
   * with no output in between, any end mark among them has been handled.
   */
  private shellReadSettled(pgid: number): boolean {
    if (!this.t.caughtUp) {
      this.shellRead = undefined;
      return false;
    }
    const key = `${pgid}:${this.outputs}`;
    if (this.shellRead?.key !== key) {
      const read = { key, turns: 0, at: mono() };
      this.shellRead = read;
      const turn = (): void => {
        if (++read.turns < 2) setImmediate(turn);
      };
      setImmediate(turn);
    }
    return this.shellRead.turns >= 2 && mono() - this.shellRead.at >= SHELL_READ_FLOOR_MS;
  }

  /**
   * A shell with no integration, or a shell exec'd in the integrated shell's place, is at its prompt
   * once output is quiet and it waits at its line editor, which holds the terminal out of canonical
   * mode, or, with no line editor (dash), reads the terminal itself.
   */
  private withoutHooks(reads: boolean | undefined): boolean {
    if (this.atPrompt || mono() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS) return false;
    if (!this.plain) return false;
    if (reads) return true;
    return proc.modes(this.pts)?.canonical === false;
  }

  private get plain(): boolean {
    return this.kind === 'none' || this.execed;
  }

  /** Whether the kernel can tell a call's loop more than the marks do: a wait for input where reads show, a prompt where there are no marks. Elsewhere (macOS) reading it on every tick only costs spawns. */
  private get kernelSays(): boolean {
    return proc.READS_VISIBLE || this.plain;
  }

  /** The prompt's text after its end mark; until output that came after the last `send` here is parsed, what that sent. */
  private pending(): string | undefined {
    const b = this.promptAt;
    if (!b) return this.sentPending;
    const cur = this.t.pos();
    if (cur.line > b.line || (cur.line === b.line && cur.col > b.col)) {
      const ls = this.t.lines(b.line, cur.line + 1).lines;
      const text = ls.length === 1 ? ls[0]!.slice(b.col, cur.col) : [ls[0]!.slice(b.col), ...ls.slice(1, -1), ls.at(-1)!.slice(0, cur.col)].join('\n');
      if (text.trim()) return text;
    }
    const sent = this.sentPending;
    return sent !== undefined && /[^\x00-\x20\x7f]/.test(sent) && (this.outputs === this.sentOutputs || !this.t.caughtUp) ? sent : undefined;
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

  /** Resolves with `done()`'s first value, or undefined at the deadline. It looks again on each wake and tick, and when `signal` aborts. */
  private until<T>(deadline: number, done: () => T | undefined, signal?: AbortSignal): Promise<T | undefined> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (v: T | undefined) => {
        this.wakers.delete(check);
        signal?.removeEventListener('abort', check);
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      const check = () => {
        const v = done();
        if (v !== undefined) return finish(v);
        if (mono() >= deadline) return finish(undefined);
      };
      const tick = () => {
        check();
        if (this.wakers.has(check)) timer = setTimeout(tick, Math.min(TICK_MS, Math.max(0, deadline - mono())));
      };
      this.wakers.add(check);
      signal?.addEventListener('abort', check, { once: true });
      tick();
    });
  }

  /** From the moment `signal` aborts, the call takes nothing it hasn't already. */
  private enter(take: boolean, signal: AbortSignal | undefined, own?: number): Call {
    const call: Call = own !== undefined ? { take, ended: [], own } : { take, ended: [] };
    this.calls.add(call);
    signal?.addEventListener('abort', () => ((call.take = false), this.wake()), { once: true });
    return call;
  }

  /** On macOS, where a look at the kernel spawns `ps`, whether a call's loop may look again yet. */
  private lookDue(): boolean {
    return LINUX || mono() - this.lastLook >= MAC_LOOK_EVERY_MS;
  }

  async run(text: string, opts: { waitMs: number; take?: boolean; signal?: AbortSignal }): Promise<RunOutcome> {
    const deadline = mono() + opts.waitMs;
    const stopped = (): boolean => this.closed || opts.signal?.aborted === true;
    if (this.atPrompt && !this.submitted && !this.prompted && !stopped()) await this.until(deadline, () => (this.prompted || this.exitInfo || !this.atPrompt || stopped() ? true : undefined), opts.signal);
    const f = this.front();
    if (stopped() || f.state !== 'prompt' || f.pending !== undefined) return { kind: 'refused', front: f };
    const id = this.nextId();
    const c: Command = { id, text, from: this.t.pos().line + 1, startedAt: Date.now() };
    this.store(c);
    this.startedMono.set(c, mono());
    const cf = integration.commandFile(this.plain ? 'none' : this.kind, this.dir, id, text);
    if (cf.files.length) this.files.set(id, cf.files.map((f) => f.path));
    for (const f of cf.files) fs.writeFileSync(f.path, f.body, { mode: 0o600 });
    this.runCommand = c;
    this.submitted = true;
    const call = this.enter(opts.take ?? true, opts.signal, id);
    this.lastWrite = mono();
    this.p.write(cf.line);
    try {
      await this.until(deadline, () => {
        if (this.exitInfo || opts.signal?.aborted) return true;
        if (c.end) return this.prompted || (this.plain && this.lookDue() && this.front().state === 'prompt') ? true : undefined;
        if (!this.kernelSays || !this.lookDue() || (this.kind !== 'none' && mono() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS)) return undefined;
        return this.front().state === 'waiting' || c.end ? true : undefined;
      }, opts.signal);
      await this.t.settled();
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front, call.take);
    return c.end ? { kind: 'ended', command: c, front } : { kind: 'running', command: c, front };
  }

  async send(bytes: string, opts: { waitMs: number; until?: RegExp; quietMs?: number; take?: boolean; signal?: AbortSignal }): Promise<SendOutcome> {
    const from = this.t.pos().line;
    const gone = (): Exit | undefined => this.exitInfo ?? this.ptyExit;
    const unsent = (by: SendOutcome['by']): SendOutcome => ({ sent: false, lines: this.t.lines(from), front: this.front(), ended: [], by });
    const stopped = (): SendOutcome['by'] | undefined => (gone() ? 'exited' : this.closed ? 'closed' : opts.signal?.aborted ? 'cancelled' : undefined);
    if (stopped()) return unsent(stopped()!);
    const deadline = mono() + opts.waitMs;
    const quiet = opts.quietMs ?? 300;
    if (this.atPrompt && !this.submitted && !this.prompted) {
      await this.until(deadline, () => (this.prompted || stopped() || !this.atPrompt ? true : undefined), opts.signal);
      if (!stopped() && this.atPrompt && !this.prompted) return unsent('timeout');
    }
    if (stopped()) return unsent(stopped()!);
    if (!this.prompted) this.frontKey = '';
    if ((this.atPrompt || this.plain) && !this.submitted) {
      if (/[\r\n]/.test(bytes)) {
        this.submitted = true;
        this.sentPending = undefined;
      } else this.sentPending = (this.sentPending ?? '') + bytes;
    }
    const call = this.enter(opts.take ?? true, opts.signal);
    const sentAt = (this.lastWrite = mono());
    this.p.write(bytes);
    this.sentOutputs = this.outputs;
    const scan = newScan(from);
    let matched: Match | undefined;
    let by: SendOutcome['by'] = 'timeout';
    try {
      const r = await this.until(deadline, () => {
        if (this.exitInfo) return 'exited' as const;
        if (opts.signal?.aborted) return 'cancelled' as const;
        if (opts.until) return (matched = this.scan(opts.until, scan)) ? ('match' as const) : undefined;
        return mono() - Math.max(this.lastOutput, sentAt) >= quiet ? ('quiet' as const) : undefined;
      }, opts.signal);
      if (r) by = r;
      await this.t.settled();
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front, call.take);
    const screen = this.t.screen();
    return { sent: true, lines: this.t.lines(from), ...(screen.alt && { screen }), front, ended: call.ended, ...(matched && { matched }), by, ...(opts.until && !matched && this.searched(scan)) };
  }

  async wait(until: Until, opts: { waitMs: number; from: number; take?: boolean; signal?: AbortSignal }): Promise<WaitOutcome> {
    const deadline = mono() + opts.waitMs;
    const call = this.enter(opts.take ?? true, opts.signal);
    const scan = newScan(opts.from);
    let matched: Match | undefined;
    let by: WaitOutcome['by'] = 'timeout';
    try {
      const r = await this.until(deadline, () => {
        if (this.exitInfo) return 'exited' as const;
        if (opts.signal?.aborted) return 'cancelled' as const;
        if (until.kind === 'match') return (matched = this.scan(until.pattern, scan)) ? ('match' as const) : undefined;
        if (this.prompted) return until.kind === 'end' ? ('end' as const) : undefined;
        if (!this.kernelSays || !this.lookDue()) return undefined;
        const s = this.front().state;
        if (s === 'waiting') return 'input' as const;
        return until.kind === 'end' && s === 'prompt' ? ('end' as const) : undefined;
      }, opts.signal);
      if (r) by = r;
      await this.t.settled();
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front, call.take);
    return { by, front, ended: call.ended, ...(matched && { matched }), ...(until.kind === 'match' && !matched && this.searched(scan)) };
  }

  /**
   * The first line from `s.from` on that matches, each matched on its head within the pattern's window;
   * then, while the alternate screen is active, its first row that matches. A pass begins after each parse,
   * moves `s.from` past frozen lines that didn't match, and counts the lines it searched on their head only.
   * It searches at least one line or row in each turn, and once this turn's searches have spent their slice,
   * the pass stops and goes on in a later turn; `now` begins a pass though nothing was parsed since the last, and
   * searches to its end.
   */
  private scan(pattern: RegExp, s: Scan, now = false): Match | undefined {
    if (now || s.parses !== this.parses) Object.assign(s, { parses: this.parses, next: s.from, row: 0, live: 0 });
    else if (s.next === undefined) return undefined;
    let n = s.next!;
    for (;;) {
      const ls = this.t.lines(n, n + SCAN_CHUNK);
      if (ls.lines.length === 0) break;
      const frozen = ls.lines.length - ls.live;
      for (let i = 0; i < ls.lines.length; i++) {
        if (!now && spent() && s.turn === turn) return this.later(s, ls.from + i, 0);
        s.turn = turn;
        const r = testBounded(pattern, ls.lines[i]!);
        if (r.matched) return { line: ls.from + i, text: ls.lines[i]!, ...(r.clipped && { clipped: true as const }) };
        if (i < frozen) {
          if (r.clipped) s.clipped++;
          s.from = ls.from + i + 1;
        } else if (r.clipped) s.live++;
      }
      n = ls.to;
    }
    const screen = this.t.screen();
    if (screen.alt)
      for (let row = s.row; row < screen.rows.length; row++) {
        if (!now && spent() && s.turn === turn) return this.later(s, n, row);
        s.turn = turn;
        const r = testBounded(pattern, screen.rows[row]!);
        if (r.matched) return { line: this.t.end(), text: screen.rows[row]!, row, ...(r.clipped && { clipped: true as const }) };
      }
    s.clippedLive = s.live;
    s.next = undefined;
    return undefined;
  }

  /** Leaves `s`'s pass to go on from line `next` and row `row`, and has the session look again in a later turn. */
  private later(s: Scan, next: number, row: number): undefined {
    s.next = next;
    s.row = row;
    if (!this.resuming) {
      this.resuming = true;
      setTimeout(() => {
        this.resuming = false;
        if (this.t.disposed) return;
        this.checkWatches();
        this.wake();
      }, 0);
    }
    return undefined;
  }

  /** For a search that ended without a match: the lines it searched on their head only, and the lines and rows its pass hadn't reached. */
  private searched(s: Scan): { clipped?: number; unsearched?: number } {
    const clipped = s.clipped + (s.next === undefined ? s.clippedLive : s.live);
    const screen = s.next === undefined ? undefined : this.t.screen();
    const unsearched = screen ? Math.max(0, this.t.end() - s.next!) + (screen.alt ? Math.max(0, screen.rows.length - s.row) : 0) : 0;
    return { ...(clipped > 0 && { clipped }), ...(unsearched > 0 && { unsearched }) };
  }

  /** Whether process group `pgid` still has a member among the shell's descendants, so a signal to it reaches the job it was read as. No, when they can't be listed. */
  private ours(pgid: number): boolean {
    return proc.descendants(this.pid, true)?.some((d) => d.pgrp === pgid) ?? false;
  }

  async stop(signal?: NodeJS.Signals): Promise<StopOutcome> {
    const steps: StopStep[] = [];
    let f = this.front();
    if (f.state === 'prompt' || f.state === 'exited') return { steps, front: f };
    const target = f.process;
    const own = target.shell || target.pgid === this.pid;
    const settled = (now: Front): boolean => now.state === 'prompt' || now.state === 'exited' || (!now.process.shell && now.process.pgid !== target.pgid);
    const gone = (now: Front): boolean => now.state === 'prompt' || now.state === 'exited' || (now.process.pgid !== target.pgid && (!now.process.shell || !this.ours(target.pgid)));
    const cleared = async (): Promise<Front> =>
      (await this.until(mono() + STEP_GRACE_MS, () => {
        const now = this.front();
        return settled(now) ? now : undefined;
      })) ?? this.front();
    const step = async (sent: StopStep['sent']): Promise<boolean> => {
      if (sent === 'C-c') {
        this.lastWrite = mono();
        this.p.write('\x03');
      } else if (this.ours(target.pgid)) {
        const refused = proc.signalGroup(target.pgid, sent);
        if (refused) {
          f = this.front();
          steps.push({ sent, to: target, refused, front: f });
          return true;
        }
      } else {
        f = this.front();
        return true;
      }
      f = await cleared();
      steps.push({ sent, ...(sent !== 'C-c' && { to: target }), front: f });
      return gone(f);
    };
    if (signal) {
      if (own) return { steps, front: f, next: 'close' };
      await step(signal);
      return { steps, front: f };
    }
    if (await step('C-c')) return { steps, front: f };
    if (own) return { steps, front: f, next: 'close' };
    for (const s of ['SIGTERM', 'SIGKILL'] as const) if (await step(s)) return { steps, front: f };
    return { steps, front: f, next: 'close' };
  }

  async close(opts: { force?: boolean } = {}): Promise<Closed> {
    this.closed = true;
    this.wake();
    if (this.poll) clearTimeout(this.poll);
    let unlisted = false;
    if (!this.exitInfo) {
      const killShell = (): void => {
        try {
          this.p.kill('SIGKILL');
        } catch {}
      };
      if (opts.force) {
        const ds = proc.descendants(this.pid, true);
        unlisted = ds === undefined;
        for (const d of ds ?? []) proc.signalGroup(d.pgrp, 'SIGKILL');
        killShell();
      } else {
        // bash can miss a SIGHUP that lands just before its line editor waits for input, and go on waiting.
        const gone = (): Exit | undefined => this.exitInfo ?? this.ptyExit;
        const grace = mono() + CLOSE_GRACE_MS;
        for (let at = mono(); !gone() && at < grace; at += HANGUP_EVERY_MS) {
          try {
            this.p.kill('SIGHUP');
          } catch {}
          await this.until(Math.min(at + HANGUP_EVERY_MS, grace), gone);
        }
        if (!gone()) killShell();
      }
      await this.until(mono() + CLOSE_GRACE_MS, () => this.exitInfo ?? this.ptyExit);
    }
    const exit = this.exitInfo ?? this.ptyExit;
    this.t.dispose();
    fs.rmSync(this.dir, { recursive: true, force: true });
    const closed: Closed = exit ? { ...exit } : { code: null, signal: 'SIGKILL', unconfirmed: true };
    if (unlisted) closed.unlisted = true;
    return closed;
  }

  watch(pattern: RegExp, from: number): number {
    const id = ++this.watchSeq;
    this.watches.set(id, { pattern, scan: newScan(from) });
    queueMicrotask(() => this.checkWatches());
    return id;
  }

  unwatch(id: number): void {
    this.watches.delete(id);
  }

  /** `now`: scan though nothing was parsed since the last scan, as `finish` does inside the parse, so a match in a command's output is emitted before its `ended`. */
  private checkWatches(now = false): void {
    for (const [id, w] of this.watches) {
      const m = this.scan(w.pattern, w.scan, now);
      if (m) {
        this.watches.delete(id);
        this.emit({ kind: 'match', watch: id, match: m });
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
