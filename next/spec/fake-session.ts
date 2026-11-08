import type { Command, Exit, Front, Lines, OpenOptions, Screen, Session, SessionEvent, StopOutcome, Until, WaitOutcome, RunOutcome, SendOutcome } from '../src/session/types.js';

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
  private watches = new Map<number, { pattern: RegExp; from: number }>();
  private nextWatch = 1;
  runMode: 'refuse' | 'end' | 'run' = 'end';
  closedWith: Exit | undefined;

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
    return { rows: this.out.slice(-5), cursor: { row: 0, col: 0 }, alt: false, title: '' };
  }
  keyOptions(): { appCursor: boolean } {
    return { appCursor: false };
  }

  print(...lines: string[]): void {
    this.out.push(...lines);
    for (const [id, w] of this.watches) {
      const i = this.out.findIndex((l, n) => n >= w.from && w.pattern.test(l));
      if (i >= 0) {
        this.watches.delete(id);
        this.emit({ kind: 'match', watch: id, match: { line: i, text: this.out[i]! } });
      }
    }
  }

  end(status: number | undefined, taken = false): Command {
    const c = this.current();
    if (!c) throw new Error('nothing runs');
    c.to = this.out.length;
    c.end = { at: Date.now(), errexit: false, refusedMarks: 0, ...(status === undefined ? {} : { status }), cwd: this.dir };
    this.frontNow = { state: 'prompt', since: Date.now() };
    this.emit({ kind: 'ended', command: c, taken });
    return c;
  }

  exit(exit: Exit): void {
    this.frontNow = { state: 'exited', since: Date.now(), exit };
    this.emit({ kind: 'exited', exit, taken: false });
  }

  emit(e: SessionEvent): void {
    for (const l of this.listeners) l(e);
  }

  async run(text: string, opts: { waitMs: number; take?: boolean }): Promise<RunOutcome> {
    this.calls.push({ method: 'run', args: [text, opts] });
    if (this.runMode === 'refuse' || this.frontNow.state !== 'prompt') return { kind: 'refused', front: this.frontNow };
    const id = this.opts.nextCommandId();
    const c: Command = { id, text, from: this.out.length, startedAt: Date.now() };
    this.commands.set(id, c);
    this.out.push(`$ ${text}`);
    if (this.runMode === 'end') {
      c.to = this.out.length;
      c.end = { at: Date.now(), status: 0, errexit: false, refusedMarks: 0, cwd: this.dir };
      this.emit({ kind: 'ended', command: c, taken: opts.take !== false });
      return { kind: 'ended', command: c, front: this.frontNow };
    }
    this.frontNow = { state: 'running', since: Date.now(), process: { pgid: 99, argv: text, shell: false }, command: id, waitVisible: true };
    return { kind: 'running', command: c, front: this.frontNow };
  }

  async send(bytes: string, opts: { waitMs: number; until?: RegExp; quietMs?: number; take?: boolean }): Promise<SendOutcome> {
    this.calls.push({ method: 'send', args: [bytes, opts] });
    const from = this.out.length;
    return { sent: this.frontNow.state !== 'exited', lines: this.lines(from), front: this.frontNow, ended: [], by: 'quiet' };
  }

  async wait(until: Until, opts: { waitMs: number; from: number; take?: boolean }): Promise<WaitOutcome> {
    this.calls.push({ method: 'wait', args: [until, opts] });
    return { by: 'timeout', front: this.frontNow, ended: [] };
  }

  async stop(signal?: NodeJS.Signals): Promise<StopOutcome> {
    this.calls.push({ method: 'stop', args: [signal] });
    return { steps: [{ sent: signal ?? 'C-c', front: this.frontNow }], front: this.frontNow };
  }

  async close(opts?: { force?: boolean }): Promise<Exit> {
    this.calls.push({ method: 'close', args: [opts] });
    this.closedWith = { code: 0 };
    return this.closedWith;
  }

  watch(pattern: RegExp, from: number): number {
    const id = this.nextWatch++;
    this.watches.set(id, { pattern, from });
    return id;
  }
  unwatch(id: number): void {
    this.watches.delete(id);
  }
  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
