import { testBounded } from '../src/core/regex.js';
import type { Command, Exit, Front, IntegrateOutcome, Lines, Match, OpenOptions, Screen, Session, SessionEvent, StopOutcome, Until, WaitOutcome, RunOutcome, SendOutcome } from '../src/session/types.js';

export class FakeSession implements Session {
  readonly pid = 4242;
  readonly kind = 'bash' as const;
  readonly openedAt = Date.now();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  frontNow: Front = { state: 'prompt', since: Date.now() };
  dir: string;
  out: string[] = [];
  live = 1;
  commands = new Map<number, Command>();
  private listeners = new Set<(e: SessionEvent) => void>();
  watches = new Map<number, { pattern: RegExp; from: number }>();
  private nextWatch = 1;
  runMode: 'refuse' | 'end' | 'run' = 'end';
  runOutput: string[] = [];
  runStatus: number | undefined = 0;
  closedWith: Exit | undefined;
  screenNow: Screen | undefined;
  promptUndrawn = false;

  constructor(readonly name: string, readonly opts: OpenOptions) {
    this.dir = opts.cwd;
  }

  front(): Front {
    return this.frontNow;
  }
  cwd(): string {
    return this.dir;
  }
  current(): Command | undefined {
    return [...this.commands.values()].find((c) => !c.end);
  }
  last(): Command | undefined {
    return [...this.commands.values()].filter((c) => c.end).at(-1);
  }
  command(id: number): Command | undefined {
    return this.commands.get(id);
  }
  lines(from: number, to?: number): Lines {
    const end = to ?? this.out.length;
    return { from, to: end, lines: this.out.slice(from, end), dropped: 0, live: to === undefined ? Math.min(this.live, end - from) : 0 };
  }
  screen(): Screen {
    return this.screenNow ?? { rows: this.out.slice(-5), cursor: { row: 0, col: 0 }, alt: false, title: '' };
  }

  print(...lines: string[]): void {
    this.out.push(...lines);
    this.checkWatches();
  }

  private checkWatches(): void {
    for (const [id, w] of this.watches) {
      const match = this.firstMatch(w.pattern, w.from);
      if (match) {
        this.watches.delete(id);
        this.emit({ kind: 'match', watch: id, match });
      }
    }
  }

  private firstMatch(pattern: RegExp, from: number): Match | undefined {
    for (let i = from; i < this.out.length; i++) {
      const t = testBounded(pattern, this.out[i]!);
      if (t.matched) return { line: i, text: this.out[i]!, ...(t.clipped ? { clipped: true as const } : {}) };
    }
    return undefined;
  }

  end(status: number | undefined, taken = false): Command {
    const c = this.current();
    if (!c) throw new Error('nothing runs');
    c.to = this.out.length;
    c.end = { at: Date.now(), ms: Date.now() - c.startedAt, errexit: false, refusedMarks: 0, ...(status === undefined ? {} : { status }), cwd: this.dir };
    this.frontNow = { state: 'prompt', since: Date.now() };
    this.emit({ kind: 'ended', command: c, taken });
    return c;
  }

  exit(exit: Exit): void {
    this.frontNow = { state: 'exited', since: Date.now(), exit };
    this.emit({ kind: 'exited', exit, taken: false });
  }

  emit(e: SessionEvent): void {
    queueMicrotask(() => {
      for (const l of this.listeners) l(e);
    });
  }

  async run(text: string, opts: { waitMs: number; take?: boolean; signal?: AbortSignal }): Promise<RunOutcome> {
    this.calls.push({ method: 'run', args: [text, opts] });
    if (this.runMode === 'refuse' || this.frontNow.state !== 'prompt') return { kind: 'refused', front: this.frontNow, took: [] };
    const id = this.opts.nextCommandId();
    this.out.push(`$ ${text}`);
    const c: Command = { id, text, from: this.out.length, startedAt: Date.now() };
    this.commands.set(id, c);
    this.out.push(...this.runOutput);
    if (this.runMode === 'end') {
      c.to = this.out.length;
      c.end = { at: Date.now(), ms: Date.now() - c.startedAt, ...(this.runStatus === undefined ? {} : { status: this.runStatus }), errexit: false, refusedMarks: 0, cwd: this.dir };
      const ended = { kind: 'ended' as const, command: c, taken: opts.take !== false, takers: 1 };
      this.emit(ended);
      return { kind: 'ended', command: c, front: this.frontNow, took: ended.taken ? [ended] : [] };
    }
    this.frontNow = { state: 'running', since: Date.now(), process: { pgid: 99, argv: text, shell: false }, command: id, waitVisible: true };
    return { kind: 'running', command: c, front: this.frontNow, took: [] };
  }

  async send(text: string, opts: { waitMs: number; keys?: readonly string[]; paste?: boolean; until?: RegExp; quietMs?: number; take?: boolean; signal?: AbortSignal }): Promise<SendOutcome> {
    this.calls.push({ method: 'send', args: [text, opts] });
    const from = this.out.length;
    if (this.promptUndrawn) return { sent: false, lines: this.lines(from), front: this.frontNow, ended: [], by: 'timeout', took: [] };
    return { sent: this.frontNow.state !== 'exited', lines: this.lines(from), ...(this.screenNow?.alt ? { screen: this.screenNow } : {}), front: this.frontNow, ended: [], by: 'quiet', took: [] };
  }

  async wait(until: Until, opts: { waitMs: number; from: number; take?: boolean; signal?: AbortSignal }): Promise<WaitOutcome> {
    this.calls.push({ method: 'wait', args: [until, opts] });
    if (until.kind === 'end' && this.frontNow.state === 'prompt' && !this.current()) return { by: 'end', front: this.frontNow, ended: [], took: [] };
    const matched = until.kind === 'match' ? this.firstMatch(until.pattern, opts.from) : undefined;
    return matched ? { by: 'match', front: this.frontNow, ended: [], matched, took: [] } : { by: 'timeout', front: this.frontNow, ended: [], took: [] };
  }

  async stop(signal?: NodeJS.Signals, _opts?: { abort?: AbortSignal }): Promise<StopOutcome> {
    this.calls.push({ method: 'stop', args: [signal] });
    return { steps: [{ sent: signal ?? 'C-c', front: this.frontNow }], front: this.frontNow };
  }

  async integrate(opts: { waitMs: number; signal?: AbortSignal }): Promise<IntegrateOutcome> {
    this.calls.push({ method: 'integrate', args: [opts.waitMs] });
    return { kind: 'refused', front: this.frontNow };
  }

  async close(opts: { force?: boolean; deadline: number }): Promise<Exit> {
    this.calls.push({ method: 'close', args: [opts] });
    this.closedWith = { code: 0 };
    const c = this.current();
    if (c) {
      c.to = this.out.length;
      c.end = { at: Date.now(), ms: Date.now() - c.startedAt, errexit: false, refusedMarks: 0, cwd: this.dir };
      this.emit({ kind: 'ended', command: c, taken: false });
    }
    this.frontNow = { state: 'exited', since: Date.now(), exit: this.closedWith };
    this.emit({ kind: 'exited', exit: this.closedWith, taken: false });
    return this.closedWith;
  }

  watch(pattern: RegExp, from: number, command?: number): number {
    this.calls.push({ method: 'watch', args: [pattern, from, command] });
    const id = this.nextWatch++;
    this.watches.set(id, { pattern, from });
    queueMicrotask(() => this.checkWatches());
    return id;
  }
  unwatch(id: number): void {
    this.calls.push({ method: 'unwatch', args: [id] });
    this.watches.delete(id);
  }
  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
