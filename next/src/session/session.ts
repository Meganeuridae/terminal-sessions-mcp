import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { historyIsolationEnv } from '../core/env.js';
import { clause, err } from '../core/errors.js';
import { inputBytes, PASTE_END, PASTE_START } from '../core/keys.js';
import { shellLaunch, shellQuote, unrunnableHelper, viaBash } from '../core/launch.js';
import { testBounded } from '../core/regex.js';
import * as integration from './integration.js';
import type { Nonce } from './integration.js';
import * as proc from './proc.js';
import { Transcript, type Pos } from './transcript.js';
import type { Closed, Command, Ending, Exit, Front, IntegrateOutcome, Lines, Match, OpenOptions, OpenSession, Process, RunOutcome, Screen, SendOutcome, Session, SessionEvent, ShellKind, StopOutcome, StopStep, Took, Until, WaitOutcome } from './types.js';

const LINUX = process.platform === 'linux';
const TICK_MS = 50;
const POLL_MS = 250;
const HOOKS_QUIET_MS = 500;
const STEP_GRACE_MS = 1500;
const CLOSE_GRACE_MS = 2000;
const HANGUP_EVERY_MS = 500;
const RECENT_NONCES = 64;
const MAX_COMMANDS = 10_000;
/** The kept commands' text and discarded input, at most, besides the count: the frozen transcript's bound. */
const MAX_COMMAND_CHARS = 6 * 1024 * 1024;
const keptChars = (c: Command): number => (c.text?.length ?? 0) + (c.end?.flushed?.length ?? 0);
/** What a recent nonce becomes in output, padded to the nonce's length so columns taken on the output as written still hold. */
const REDACTED = '[redacted]';
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

/** A nonce's random part, which redaction replaces: four groups of five digits, with nothing between. */
const NONCE_DIGITS = 20;
const randomDigits = (): string => Array.from({ length: NONCE_DIGITS / 5 }, () => String(randomInt(10000, 100000))).join('');
/** Text without this can't hold a nonce. */
const DIGIT_RUN = new RegExp(`\\d{${NONCE_DIGITS}}`);

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
  took: Took;
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

/**
 * Whether text read from the prompt's line shows nothing typed: the screen leaves an empty cell as U+0020, its one blank. Every
 * other space, such as a no-break space, is input a line editor hands the shell. A line break here only joins the line's rows.
 */
const emptyText = (text: string): boolean => /^[ \n]*$/.test(text);
/** How long the shell's own read must have been seen before it counts as a builtin read: a bound on the kernel's delivery of output the shell wrote before it began reading, not a proof. */
const SHELL_READ_FLOOR_MS = 50;

/** A process of a far shell's carrier group with no child in that group, such as the ssh of `sh -c 'ssh h; cat'`, and its command line. */
interface Leaf {
  pid: number;
  argv: string;
}

/** Where one shell's chain of marks stands: what it has drawn, what was typed or sent at its prompt, and the command it runs. */
interface Chain {
  expected: Nonce;
  atPrompt: boolean;
  inCommand: boolean;
  submitted: boolean;
  sentPending: string | undefined;
  /** The prompt's line and the cursor as they were when `send` last wrote at `at`, and whether a parse since has changed either. */
  sentView: { at: Pos; line: string; cursor: Pos; changed: boolean } | undefined;
  promptAt: Pos | undefined;
  /** At a shell without integration: `lastWrite` when `promptAt` was taken, so a prompt drawn later with nothing typed since moves it. */
  promptAtWrite: number;
  running: Command | undefined;
  runCommand: Command | undefined;
  refused: number;
  cwd: string;
  /** A shell given the integration with `integrate`: its kind, the local program it runs under, and what its drain sent since the last end mark, as hex. */
  far?: { kind: integration.FarKind; within: Process; drained: string[]; leaves: Leaf[]; self?: string };
  /** The prompt at which `send` last wrote: something was sent since `promptAt` when this is it. */
  sentAt?: Pos;
  /** The prompt's line as drawn at rest, with nothing sent and the cursor at its end mark, such as a right prompt: text that isn't typed. */
  rest?: { at: Pos; text: string };
}

/** The job a `stop` with a signal sent it to, and the command running then; once that command ends, whether its group holds a stopped process. */
interface Signalled {
  pgid: number;
  command: number | undefined;
  checked?: true;
  stopped?: boolean | undefined;
}

/** What a shell answered `integrate`'s probe line with: each one's version, empty but for the shell that ran it; `$0` from a shell that named none. */
interface ProbeAnswer {
  fish: string;
  zsh: string;
  bash: string;
  zero?: string;
}

/** The text a far shell's drain sent before an end mark, from its hex pieces, which are taken. A piece that output from elsewhere broke into isn't hex, and is left out. */
const farDrained = (far: { drained: string[] }): string => {
  const hex = far.drained.filter((p) => /^(?:[0-9a-f]{2})*$/.test(p)).join('');
  far.drained = [];
  return Buffer.from(hex, 'hex').toString('utf8');
};

const newChain = (expected: Nonce, cwd: string): Chain => ({
  expected,
  atPrompt: false,
  inCommand: false,
  submitted: false,
  sentPending: undefined,
  sentView: undefined,
  promptAt: undefined,
  promptAtWrite: -1,
  running: undefined,
  runCommand: undefined,
  refused: 0,
  cwd,
});

class LiveSession implements Session {
  readonly name: string;
  readonly pid: number;
  readonly openedAt = Date.now();
  private readonly t: Transcript;
  private readonly pts: string;
  private readonly log: ((line: string) => void) | undefined;
  private readonly shellName: string;
  private readonly chains: Chain[];
  /**
   * While `integrate` runs: its probe line's answer; the index of the last typed line that acknowledged it ran, and where;
   * once its chain is pushed, that chain, and where its first end mark came.
   */
  /** The last `stop` with a signal, until the command running then ends. */
  private signalled: Signalled | undefined;
  private probe: { call: string; answer?: ProbeAnswer; acked?: number; ackedAt?: Pos; chain?: Chain; endAt?: Pos } | undefined;
  private readonly recent: string[] = [];
  private readonly commands = new Map<number, Command>();
  private commandChars = 0;
  private lastEnded: Command | undefined;
  private exitInfo: Exit | undefined;
  private ptyExit: Exit | undefined;
  private exitDone: Promise<void> | undefined;
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
  private readonly watches = new Map<number, { pattern: RegExp; scan: Scan; command?: number }>();
  private watchSeq = 0;
  private resuming = false;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private poll: NodeJS.Timeout | undefined;
  private drawnOnce = false;
  private execed = false;
  private opened = false;
  private closed = false;
  /** Each carrier group, with a foreground group a listing showed descending from it. */
  private readonly carrierSeen = new Map<number, number>();
  private closing: Promise<Closed> | undefined;
  /** A close with `force` joined the close under way, which goes on as forced from its next step. */
  private forcedLate = false;
  /** The strongest signal the close has sent the shell. */
  private sentShell: 'SIGHUP' | 'SIGKILL' | undefined;

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
    this.log = o.log;
    this.pid = p.pid;
    this.chains = [newChain(nonce, o.cwd)];
    this.remember(nonce);
    this.shellName = path.basename(o.shell);
    this.pts = (p as unknown as { ptsName?: string; _pty?: string }).ptsName ?? (p as unknown as { _pty?: string })._pty ?? '';
    this.lastOutput = mono();
    this.t = new Transcript(o.cols, o.rows, {
      reply: (d) => this.p.write(d),
      pressure: (paused) => (paused ? this.p.pause() : this.p.resume()),
      redact: (s) => this.redact(s),
      redactSpan: NONCE_DIGITS,
      mark: (payload, at) => this.mark(payload, at),
    });
    p.onData((d) => {
      if (this.t.disposed) return;
      this.lastOutput = mono();
      this.outputs++;
      this.t.write(d, () => {
        this.parses++;
        this.sentSeen();
        this.checkWatches();
        this.wake();
      });
    });
    p.onExit(({ exitCode, signal }) => {
      this.ptyExit = signal ? { code: null, signal: `SIG${signalName(signal)}` } : { code: exitCode };
      this.exitedAt = Date.now();
      this.exitDone = this.exited(this.ptyExit);
    });
    this.schedulePoll();
  }

  async ready(waitMs: number, signal?: AbortSignal): Promise<void> {
    await this.until(mono() + waitMs, () => (this.prompted || this.ptyExit || signal?.aborted || (this.kind === 'none' && this.front().state === 'prompt') ? true : undefined), signal);
    if (this.exitDone) await this.exitDone;
    this.opened = true;
  }

  get exit(): Exit | undefined {
    return this.exitInfo;
  }

  startupText(): string {
    return this.t.lines(0).lines.join('\n').trim();
  }

  /** The chain of the shell `run` types into. */
  private get top(): Chain {
    return this.chains[this.chains.length - 1]!;
  }

  private remember(n: Nonce): void {
    this.recent.push(n.random);
    if (this.recent.length > RECENT_NONCES) this.recent.shift();
  }

  private redact(s: string): string {
    if (!DIGIT_RUN.test(s)) return s;
    for (const r of [...this.recent, ...this.chains.map((c) => c.expected.random)]) if (s.includes(r)) s = s.replaceAll(r, REDACTED.padEnd(r.length, '.'));
    return s;
  }

  private mark(payload: string, at: Pos): boolean {
    const [kind, nonce, ...rest] = payload.split(';');
    if (kind === 'K') {
      if (this.probe && !this.probe.answer && nonce === this.probe.call) {
        const [fish = '', zsh = '', bash = '', zero] = rest;
        this.probe.answer = { fish, zsh, bash, ...(zero !== undefined && { zero }) };
        this.wake();
      }
      return false;
    }
    if (kind === 'P') {
      const m = /^(\d+)\.(\d+)$/.exec(nonce ?? '');
      if (this.probe && m && m[1] === this.probe.call) {
        this.probe.acked = Number(m[2]);
        this.probe.ackedAt = at;
      }
      this.wake();
      return false;
    }
    if (kind === 'D' && !this.exitInfo) {
      const next = /^(\d+)\.\w+$/.exec(rest[0] ?? '');
      const below = this.chains.findIndex((c, i) => i < this.chains.length - 1 && integration.nonceText(c.expected) === nonce && Number(next?.[1]) === c.expected.counter + 1);
      if (below >= 0) {
        // The shell below has its prompt back. Reached through a local group of its own, its command ended if that group has no
        // process, and otherwise only left the terminal, as when suspended. Through the group that reaches the far shell below, the
        // local group says nothing about what that shell ran.
        const c = this.chains[below]!;
        const carrier = this.chains[below + 1]!.far!.within;
        const how = c.far?.within.pgid === carrier.pgid ? 'back' : proc.groupAlive(carrier.pgid) ? 'left' : 'ended';
        this.drop(below, { by: (c.running ?? c.runCommand)?.text ?? carrier.argv, how });
      }
    }
    const expected = integration.nonceText(this.top.expected);
    const far = this.top.far;
    if (kind === 'F' && nonce === expected && far && !this.exitInfo) return far.drained.push(rest[0] ?? ''), false;
    if (kind === 'C' && nonce === expected && this.top.inCommand) return this.top.refused++, false;
    const ok = nonce === expected && !this.exitInfo;
    if (kind === 'C' && ok) return this.started(at, rest[0] ? unescape(rest[0]) : undefined), true;
    if (kind === 'D' && ok) {
      const [next, status, pipe, flags, cwd] = rest;
      const m = /^(\d+)\.(\w+)$/.exec(next ?? '');
      if (m && Number(m[1]) === this.top.expected.counter + 1) {
        if (this.probe?.chain === this.top) this.probe.endAt ??= at;
        this.ended(at, { status: Number(status), pipe: (pipe ?? '').split(' ').filter(Boolean).map(Number), flags: flags ?? '', cwd: unescape(cwd ?? ''), flushed: far ? farDrained(far) : this.drained(this.top.expected.counter) });
        this.top.expected = { counter: Number(m[1]), random: m[2]! };
        this.remember(this.top.expected);
        return true;
      }
    }
    if (kind === 'B' && ok) {
      this.drawnOnce = true;
      if (this.top.atPrompt && !this.top.submitted) this.top.promptAt = at;
      else if (this.top.running) this.drawnWithoutEnd(at);
      else if (!this.top.runCommand && (this.top.promptAt === undefined || at.line > this.top.promptAt.line)) {
        this.top.atPrompt = true;
        this.top.submitted = false;
        this.top.sentPending = undefined;
        this.top.promptAt = at;
        this.wake();
      }
      return false;
    }
    if ((kind === 'C' || kind === 'D' || kind === 'B' || kind === 'F') && /^\d+\.\d+$/.test(nonce ?? '')) this.top.refused++;
    return false;
  }

  /**
   * A shell given the integration through a local program, such as ssh, is followed only while that program holds the terminal,
   * itself or through a process it started, as a local shell's jobs do. Each chain with such a program is judged from the lowest
   * up, and the first whose program no longer holds the terminal is dropped, with every chain above it. 'unread' when that can't
   * be told, and nothing more is dropped; undefined when no chain is reached through a local program other than the session's own
   * shell. One listing of the shell's descendants serves every chain.
   */
  private follow(shell: ReturnType<typeof proc.info>): 'held' | 'unread' | undefined {
    this.lastLook = mono();
    let family: ReturnType<typeof proc.family> | null = null;
    const list = (): ReturnType<typeof proc.family> => (family === null ? (family = proc.family(this.pid)) : family);
    let w: number | undefined;
    for (let i = 1; i < this.chains.length; i++) {
      const far = this.chains[i]!.far;
      const by = far?.within;
      if (!far || !by) continue;
      // A group can go on with another program, as `sh -c 'ssh h; exec cat'` does.
      const left = far.leaves.find((l) => !proc.alive(l.pid));
      if (left) {
        this.drop(i - 1, { by: left.argv, how: 'ended' });
        return undefined;
      }
      if (by.pgid === this.pid) {
        // The session's own shell, given the integration in place, keeps its pid and group when it replaces itself with another
        // program, as `exec` from a trap does, so its command line is what changes.
        const now = shell?.argv;
        if (now === undefined) return 'unread';
        if (far.self !== undefined && now !== far.self) {
          this.drop(i - 1, { by: by.argv, how: 'ended' });
          return undefined;
        }
        continue;
      }
      if (by.pgid === w) continue;
      w = by.pgid;
      const h = this.holds(w, shell, list);
      if (h === undefined) return 'unread';
      if (h !== true) {
        this.drop(i - 1, { by: by.argv, how: h });
        return undefined;
      }
    }
    return w === undefined ? undefined : 'held';
  }

  /**
   * Whether group `w` holds the terminal: in front itself, or through a process it started. 'ended' once it has no process, and
   * 'left' when the terminal's foreground group is the shell's own, or one whose processes are listed and none descends from `w`.
   * Undefined when that can't be told: the foreground group can't be read, a listing fails or doesn't show `w`'s processes, or
   * shows none in that group, which then moved under the read. A verdict that a group descends from `w` is kept until `w`
   * itself holds the terminal again or a chain is dropped, so a group is listed once while it holds the terminal.
   */
  private holds(w: number, shell: ReturnType<typeof proc.info>, list: () => ReturnType<typeof proc.family>): true | 'ended' | 'left' | undefined {
    if (!proc.groupAlive(w)) return 'ended';
    const g = shell?.tpgid;
    if (g === undefined) return undefined;
    if (g === w) {
      this.carrierSeen.delete(w);
      return true;
    }
    if (g === shell!.pgrp) return 'left';
    if (this.carrierSeen.get(w) === g) return true;
    const family = list();
    const fromW = family?.from(w);
    if (!family || !fromW) return undefined;
    if (!family.all.some((d) => d.pgrp === g)) return undefined;
    if (!fromW.some((d) => d.pgrp === g)) return 'left';
    this.carrierSeen.set(w, g);
    return true;
  }

  /**
   * The chains above `i` are no longer followed: the shell holding chain `i` gave an end mark, or `by`, the program they were
   * reached through, ended or left the terminal, or the session's shell exited. That shows they're gone from here, not that a
   * command running in one ended, so it ends with no status, as not followed.
   */
  private drop(i: number, why: { by: string; how: 'ended' | 'left' | 'back' }): void {
    while (this.chains.length - 1 > i) {
      const c = this.chains.pop()!;
      const open = c.running ?? c.runCommand;
      if (open) this.finish(open, undefined, { at: Date.now(), errexit: false, refusedMarks: c.refused, unfollowed: why });
    }
    this.carrierSeen.clear();
    this.wake();
  }

  /** The text the prompt hook's drain read before the end mark closing nonce `counter`, from the file it wrote; the file is removed. */
  private drained(counter: number): string {
    const f = path.join(this.dir, `${integration.DRAINED}.${counter}`);
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
    this.remove(f);
    return text;
  }

  /** Removes a file of the session's; one that can't be removed is logged, and what removes it goes on. */
  private remove(f: string): void {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      this.note(`session ${JSON.stringify(this.name)}: ${f} couldn't be removed: ${(e as Error).message}`);
    }
  }

  private started(at: Pos, text: string | undefined): void {
    this.top.inCommand = true;
    this.top.atPrompt = false;
    this.top.submitted = false;
    this.top.sentPending = undefined;
    this.top.promptAt = undefined;
    const from = at.col > 0 ? at.line + 1 : at.line;
    let c = this.top.runCommand;
    this.top.runCommand = undefined;
    if (c) c.from = from;
    else {
      c = { id: this.nextId(), from, startedAt: Date.now() };
      if (text !== undefined && text !== '') c.text = text;
      this.store(c);
      this.startedMono.set(c, mono());
    }
    this.top.running = c;
    this.wake();
  }

  private ended(at: Pos, d: { status: number; pipe: number[]; flags: string; cwd: string; flushed: string }): void {
    this.top.inCommand = false;
    this.top.atPrompt = true;
    this.top.submitted = false;
    this.top.sentPending = undefined;
    this.top.promptAt = undefined;
    if (d.cwd) this.top.cwd = d.cwd;
    const c = this.top.running ?? this.top.runCommand;
    this.top.running = this.top.runCommand = undefined;
    if (c) {
      const end: Omit<Ending, 'ms'> = { at: Date.now(), status: d.status, errexit: d.flags.includes('e'), refusedMarks: this.top.refused };
      if (d.pipe.length > 1) end.pipeline = d.pipe;
      if (d.cwd) end.cwd = d.cwd;
      if (d.flushed) end.flushed = d.flushed;
      this.finish(c, at, end);
    }
    this.top.refused = 0;
    this.wake();
  }

  private drawnWithoutEnd(at: Pos): void {
    const c = this.top.running;
    this.top.running = undefined;
    this.top.inCommand = false;
    this.top.atPrompt = true;
    this.top.submitted = false;
    this.top.sentPending = undefined;
    this.top.promptAt = at;
    if (c) this.finish(c, { line: at.line, col: 0 }, { at: Date.now(), errexit: false, refusedMarks: this.top.refused });
    this.top.refused = 0;
    this.wake();
  }

  private get prompted(): boolean {
    return this.top.atPrompt && !this.top.submitted && this.top.promptAt !== undefined;
  }

  private finish(c: Command, at: Pos | undefined, end: Omit<Ending, 'ms'>): void {
    const to = at ? (at.col > 0 ? at.line + 1 : at.line) : this.t.end();
    c.to = Math.max(to, c.from);
    c.end = { ...end, ms: Math.max(0, Math.round(mono() - (this.startedMono.get(c) ?? mono()))) };
    const sig = this.signalled;
    if (sig && sig.command === c.id) {
      // A suspend signal gives the shell its terminal back with the job stopped, and it reports the command ended.
      this.signalled = undefined;
      sig.checked = true;
      sig.stopped = this.groupStopped(sig.pgid);
      if (sig.stopped) c.end.stopped = true;
      else if (sig.stopped === undefined) c.end.stoppedUnknown = true;
    }
    this.lastEnded = c;
    if (c.end.flushed && this.commands.get(c.id) === c) {
      this.commandChars += c.end.flushed.length;
      this.trimCommands();
    }
    for (const f of this.files.get(c.id) ?? []) this.remove(f);
    this.files.delete(c.id);
    const takers: Call[] = [];
    for (const call of this.calls) {
      if (call.own !== undefined && call.own !== c.id) continue;
      call.ended.push(c);
      if (call.take) takers.push(call);
    }
    this.checkWatches(c);
    const took = { kind: 'ended' as const, command: c, taken: true, takers: takers.length };
    for (const call of takers) call.took.push(took);
    this.emit({ kind: 'ended', command: c, taken: takers.length > 0 });
  }

  private store(c: Command): void {
    this.commands.set(c.id, c);
    this.commandChars += keptChars(c);
    this.trimCommands();
  }

  /** Drops the oldest commands past the count, or past the characters while more than the newest is kept. */
  private trimCommands(): void {
    while (this.commands.size > MAX_COMMANDS || (this.commandChars > MAX_COMMAND_CHARS && this.commands.size > 1)) {
      const [id, old] = this.commands.entries().next().value!;
      this.commands.delete(id);
      this.commandChars -= keptChars(old);
    }
  }

  private async exited(exit: Exit): Promise<void> {
    await this.t.settled();
    this.exitInfo = exit;
    if (this.t.disposed) return;
    this.t.keepScreen();
    this.drop(0, { by: this.shellName, how: 'ended' });
    const c = this.top.running ?? this.top.runCommand;
    this.top.running = this.top.runCommand = undefined;
    if (c) this.finish(c, undefined, { at: Date.now(), errexit: false, refusedMarks: this.top.refused });
    this.top.atPrompt = false;
    if (this.poll) clearTimeout(this.poll);
    const takers = [...this.calls].filter((c) => c.take);
    const took = { kind: 'exited' as const, exit, taken: true, takers: takers.length };
    for (const call of takers) call.took.push(took);
    this.emit({ kind: 'exited', exit, taken: takers.length > 0 });
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
    if (!LINUX || this.exitInfo || this.closing) return;
    this.poll = setTimeout(() => {
      if (!this.top.atPrompt || this.top.submitted) this.observe(this.front(), [...this.calls].filter((c) => c.take));
      this.schedulePoll();
    }, POLL_MS);
    this.poll.unref();
  }

  /** Emits `waiting` on each entry into that state. `takers`: the call returning `f`, or the calls still open, that give it. */
  private observe(f: Front, takers: Call[]): void {
    if (f.state !== 'waiting') {
      this.waitingKey = '';
      return;
    }
    const key = `${f.process.pgid}:${f.since}`;
    if (key === this.waitingKey) return;
    this.waitingKey = key;
    const took = { kind: 'waiting' as const, front: f, taken: true, takers: takers.length };
    for (const call of takers) call.took.push(took);
    this.emit({ kind: 'waiting', front: f, taken: takers.length > 0 });
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
    const shell = proc.info(this.pid);
    const followed = this.top.far ? this.follow(shell) : undefined;
    const command = this.top.running?.id ?? this.top.runCommand?.id;
    const at = <T extends object>(o: T): T => (command !== undefined ? { ...o, command } : o);
    const far = this.top.far;
    if (far) {
      const depth = this.chains.length;
      // Its marks say what the far shell does, not who holds this terminal.
      if (followed === 'unread') return at({ state: 'unknown', since: this.since(`unknown:${depth}`) });
      if (this.prompted) {
        const pending = this.pending();
        return { state: 'prompt', since: this.since(`prompt:${depth}`), ...(pending !== undefined && { pending }), within: far.within };
      }
      if (!shell) return at({ state: 'unknown', since: this.since(`unknown:${depth}`) });
      return at({ state: 'running', since: this.since(`r:${depth}:${command ?? ''}`), process: far.within, waitVisible: false, within: far.within });
    }
    this.lastLook = mono();
    if (!shell) return at({ state: 'unknown', since: this.since('unknown') });
    const g = shell.tpgid !== undefined ? { pgrp: shell.pgrp, tpgid: shell.tpgid } : undefined;
    const program = (process: Process, reads: Array<boolean | undefined>): Front => {
      if (reads.includes(true)) {
        const since = this.since(`w:${process.pgid}`);
        return at({ state: 'waiting', since, process, ...this.echo(`${process.pgid}:${since}`) });
      }
      return at({ state: 'running', since: this.since(`r:${process.pgid}`), process, waitVisible: reads.length > 0 && !reads.includes(undefined) });
    };
    if (!g || g.tpgid === g.pgrp) {
      const pgid = g?.pgrp ?? this.pid;
      const argv = shell.argv;
      if (this.opened && argv !== undefined && argv !== this.argvAtOpen && !this.execed) {
        this.execed = true;
        // The marks were the replaced shell's. Its last said prompt when the line that ran exec started none, as in bash 3.2,
        // which has no mark for a line it starts; that says nothing of the shell in front now.
        this.top.atPrompt = false;
      }
      if (this.prompted) {
        if (argv === undefined) return at({ state: 'unknown', since: this.since('unknown') });
        const pending = this.pending();
        return { state: 'prompt', since: this.since('prompt'), ...(pending !== undefined && { pending }) };
      }
      const reads = proc.readsTerminal(this.pid, this.pts);
      if (this.execed && argv !== undefined && !isShell(argv)) return program({ pgid, argv, shell: false }, [reads]);
      const process: Process = { pgid, argv: argv ?? this.shellName, shell: true };
      const idle = !this.top.submitted || this.plain ? this.withoutHooks(reads) : false;
      if (idle === undefined) return at({ state: 'unknown', since: this.since('unknown') });
      if (idle) {
        if (this.top.submitted || !this.top.promptAt || this.lastWrite === this.top.promptAtWrite) {
          this.top.promptAt = this.t.pos();
          this.top.promptAtWrite = this.lastWrite;
        }
        this.top.submitted = false;
        const open = this.top.running ?? this.top.runCommand;
        if (open) {
          this.top.running = this.top.runCommand = undefined;
          this.top.inCommand = false;
          this.finish(open, { line: this.t.pos().line, col: 0 }, { at: Date.now(), errexit: false, refusedMarks: this.top.refused });
          this.top.refused = 0;
        }
        const pending = this.pending();
        return { state: 'prompt', since: this.since('prompt'), ...(pending !== undefined && { pending }) };
      }
      const starting = !this.drawnOnce && !this.plain ? { starting: true as const } : {};
      if (reads && !this.plain && (!this.top.atPrompt || this.top.submitted)) {
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
   * mode, or, with no line editor (dash), reads the terminal itself. Undefined when neither the kernel
   * nor the terminal's modes could be read.
   */
  private withoutHooks(reads: boolean | undefined): boolean | undefined {
    if (this.top.atPrompt || mono() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS) return false;
    if (!this.plain) return false;
    if (reads) return true;
    const canonical = proc.modes(this.pts)?.canonical;
    if (canonical === undefined) return reads === false ? false : undefined;
    return !canonical;
  }

  /** The shell in front has no marks: the session's own without the integration, or a program exec'd in its place. */
  private get plain(): boolean {
    return !this.top.far && (this.kind === 'none' || this.execed);
  }

  /** Whether the kernel can tell a call's loop more than the marks do: a wait for input where reads show, a prompt where there are no marks. Elsewhere (macOS) reading it on every tick only costs spawns. */
  private get kernelSays(): boolean {
    return !this.top.far && (proc.READS_VISIBLE || this.plain);
  }

  /**
   * What's on the prompt's line that the prompt didn't draw. That's the text between the end mark and the cursor, when it isn't
   * blank. Otherwise it's the whole line from the end mark, past the cursor too, unless that's the line as drawn at rest. Text past
   * the cursor counts only then, since a line editor can draw its own there, as fish draws its suggestion. The rest is taken while
   * nothing has been sent at this prompt and the cursor sits at the end mark, so text a line editor draws there with the cursor
   * after it isn't taken in. With no rest taken, any text counts. Until a parse changes the prompt's line or the cursor after the last
   * `send` here, what was sent: output from elsewhere, or a far echo still on its way, says nothing of the line.
   */
  private pending(): string | undefined {
    const b = this.top.promptAt;
    if (!b) return this.top.sentPending;
    const cur = this.t.pos();
    if (cur.line > b.line || (cur.line === b.line && cur.col > b.col)) {
      const ls = this.t.lines(b.line, cur.line + 1).lines;
      const before = ls.length === 1 ? ls[0]!.slice(b.col, cur.col) : [ls[0]!.slice(b.col), ...ls.slice(1, -1), ls.at(-1)!.slice(0, cur.col)].join('\n');
      if (!emptyText(before)) return before;
    }
    const text = this.promptLine(b);
    // Typed text that draws exactly the line at rest, where the rest draws it, reads as empty: the screen can't tell input from the
    // prompt's drawing.
    if (this.top.sentAt !== b && cur.line === b.line && cur.col === b.col) this.top.rest = { at: b, text };
    if (!emptyText(text) && !(this.top.rest?.at === b && this.top.rest.text === text)) return text.replace(/^[ \n]+|[ \n]+$/g, '');
    const sent = this.top.sentPending;
    if (sent === undefined || !/[^\x00-\x20\x7f]/.test(sent)) return undefined;
    const v = this.top.sentView;
    return !this.t.caughtUp || (v?.at === b && !v.changed) ? sent : undefined;
  }

  /** Marks the view `send` took as changed once a parse leaves the prompt's line or the cursor other than they were. */
  private sentSeen(): void {
    const v = this.top.sentView;
    if (!v || v.changed) return;
    const cur = this.t.pos();
    v.changed = cur.line !== v.cursor.line || cur.col !== v.cursor.col || this.promptLine(v.at) !== v.line;
  }

  /**
   * The prompt's line from its end mark to the last line, each line's trailing blanks left out. A line editor draws its line within
   * the screen, so it's read through as many lines as the screen has rows, and anything further down marks it as more.
   */
  private promptLine(b: Pos): string {
    const last = b.line + this.t.rows;
    const ls = this.t.lines(b.line, last).lines;
    const text = [ls[0]?.slice(b.col) ?? '', ...ls.slice(1)].map((l) => l.replace(/ +$/, '')).join('\n').replace(/\n+$/, '');
    return this.t.end() > last ? `${text}\n…` : text;
  }

  cwd(): string {
    return this.top.cwd;
  }

  current(): Command | undefined {
    return this.top.running ?? this.top.runCommand;
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
    const call: Call = own !== undefined ? { take, ended: [], took: [], own } : { take, ended: [], took: [] };
    this.calls.add(call);
    signal?.addEventListener('abort', () => ((call.take = false), this.wake()), { once: true });
    return call;
  }

  /** Gives `line` to the log; a log that throws can't stop the step it reports on. */
  private note(line: string): void {
    try {
      this.log?.(line);
    } catch {}
  }

  /** Types `bytes` and returns when, as the last write; a write that throws leaves the last write as it was. */
  private write(bytes: string): number {
    const was = this.lastWrite;
    this.lastWrite = mono();
    try {
      this.p.write(bytes);
    } catch (e) {
      this.lastWrite = was;
      throw e;
    }
    return this.lastWrite;
  }

  /** On macOS, where a look at the kernel spawns `ps`, whether a call's loop may look again yet. */
  private lookDue(): boolean {
    return LINUX || mono() - this.lastLook >= MAC_LOOK_EVERY_MS;
  }

  async run(text: string, opts: { waitMs: number; take?: boolean; signal?: AbortSignal }): Promise<RunOutcome> {
    const deadline = mono() + opts.waitMs;
    const stopped = (): boolean => this.closed || opts.signal?.aborted === true;
    if (this.top.atPrompt && !this.top.submitted && !this.prompted && !stopped()) await this.until(deadline, () => (this.prompted || this.exitInfo || !this.top.atPrompt || stopped() ? true : undefined), opts.signal);
    const f = this.front();
    if (stopped() || f.state !== 'prompt' || f.pending !== undefined) return { kind: 'refused', front: f, took: [] };
    const far = this.top.far;
    const farLine = far && integration.farCommand(far.kind, text);
    if (farLine && farLine.length > integration.FAR_MAX_TYPED) return { kind: 'refused', front: f, took: [], tooLong: { typed: farLine.length, max: integration.FAR_MAX_TYPED } };
    const id = this.nextId();
    const cf: { files: Array<{ path: string; body: string }>; line: string } = farLine ? { files: [], line: farLine } : integration.commandFile(this.plain ? 'none' : this.kind, this.dir, id, text);
    const removeFiles = (): void => {
      for (const f of cf.files) this.remove(f.path);
    };
    try {
      for (const f of cf.files) fs.writeFileSync(f.path, f.body, { mode: 0o600 });
    } catch (e) {
      removeFiles();
      throw e;
    }
    const c: Command = { id, text, from: this.t.pos().line + 1, startedAt: Date.now() };
    this.startedMono.set(c, mono());
    if (cf.files.length) this.files.set(id, cf.files.map((f) => f.path));
    const before = { runCommand: this.top.runCommand, submitted: this.top.submitted };
    this.top.runCommand = c;
    this.top.submitted = true;
    const call = this.enter(opts.take ?? true, opts.signal, id);
    try {
      try {
        this.write(cf.line);
      } catch (e) {
        Object.assign(this.top, before);
        this.startedMono.delete(c);
        this.files.delete(id);
        removeFiles();
        throw e;
      }
      this.store(c);
      await this.until(deadline, () => {
        if (this.exitInfo || this.closed || opts.signal?.aborted) return true;
        if (this.top.far && this.lookDue()) this.follow(proc.info(this.pid));
        if (c.end) return this.prompted || (this.plain && this.lookDue() && this.front().state === 'prompt') ? true : undefined;
        if (!this.kernelSays || !this.lookDue() || (this.kind !== 'none' && mono() - Math.max(this.lastOutput, this.lastWrite) < HOOKS_QUIET_MS)) return undefined;
        return this.front().state === 'waiting' || c.end ? true : undefined;
      }, opts.signal);
      await this.t.settled();
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front, call.take ? [call] : []);
    return c.end ? { kind: 'ended', command: c, front, took: call.took } : { kind: 'running', command: c, front, took: call.took };
  }

  async send(text: string, opts: { waitMs: number; keys?: readonly string[]; paste?: boolean; until?: RegExp; quietMs?: number; take?: boolean; signal?: AbortSignal }): Promise<SendOutcome> {
    const from = this.t.pos().line;
    const gone = (): Exit | undefined => this.exitInfo ?? this.ptyExit;
    const unsent = (by: SendOutcome['by']): SendOutcome => ({ sent: false, lines: this.t.lines(from), front: this.front(), ended: [], by, took: [] });
    const stopped = (): SendOutcome['by'] | undefined => (gone() ? 'exited' : this.closed ? 'closed' : opts.signal?.aborted ? 'cancelled' : undefined);
    if (stopped()) return unsent(stopped()!);
    const deadline = mono() + opts.waitMs;
    const quiet = opts.quietMs ?? 300;
    await this.t.settled();
    if (stopped()) return unsent(stopped()!);
    if (this.top.atPrompt && !this.top.submitted && !this.prompted) {
      await this.until(deadline, () => (this.prompted || stopped() || !this.top.atPrompt ? true : undefined), opts.signal);
      if (!stopped() && this.top.atPrompt && !this.prompted) return unsent('timeout');
      await this.t.settled();
    }
    const at = this.top.atPrompt && !this.top.submitted ? this.top.promptAt : undefined;
    if (at && this.top.sentAt !== at && this.top.rest?.at !== at && !stopped()) {
      await this.t.settled();
      this.pending();
    }
    if (stopped()) return unsent(stopped()!);
    if (opts.paste && !this.t.bracketedPaste) return unsent('paste_off');
    const keys = opts.keys?.length ? inputBytes(undefined, opts.keys, { appCursor: this.t.appCursor }) : '';
    const bytes = opts.paste ? `${PASTE_START}${text}${PASTE_END}${keys}` : text + keys;
    if (!this.prompted) this.frontKey = '';
    const before = { submitted: this.top.submitted, sentPending: this.top.sentPending, sentAt: this.top.sentAt, sentView: this.top.sentView };
    if ((this.top.atPrompt || this.plain) && !this.top.submitted) {
      // A line break inside a paste is held by the line editor for editing; only the keys after it can submit the line.
      if (/[\r\n]/.test(opts.paste ? keys : bytes)) {
        this.top.submitted = true;
        this.top.sentPending = undefined;
      } else this.top.sentPending = (this.top.sentPending ?? '') + (opts.paste ? text + keys : bytes);
    }
    const call = this.enter(opts.take ?? true, opts.signal);
    let sentAt = 0;
    const scan = newScan(from);
    let matched: Match | undefined;
    let by: SendOutcome['by'] = 'timeout';
    try {
      const b = this.top.promptAt;
      if (b) {
        this.top.sentAt = b;
        this.top.sentView = { at: b, line: this.promptLine(b), cursor: this.t.pos(), changed: false };
      }
      try {
        sentAt = this.write(bytes);
      } catch (e) {
        Object.assign(this.top, before);
        throw e;
      }
      const r = await this.until(deadline, () => {
        if (this.closed) return 'closed' as const;
        if (this.exitInfo) return 'exited' as const;
        if (opts.signal?.aborted) return 'cancelled' as const;
        if (opts.until) return (matched = this.scan(opts.until, scan)) ? ('match' as const) : undefined;
        return mono() - Math.max(this.lastOutput, sentAt) >= quiet ? ('quiet' as const) : undefined;
      }, opts.signal);
      if (r) by = r;
      await this.t.settled();
      if (by === 'timeout' && opts.until && (matched = this.searchSettled(opts.until, scan))) by = 'match';
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front, call.take ? [call] : []);
    const screen = this.t.screen();
    return { sent: true, lines: this.t.lines(from), ...(screen.alt && { screen }), front, ended: call.ended, ...(matched && { matched }), by, ...(opts.until && !matched && this.searched(scan)), took: call.took };
  }

  async wait(until: Until, opts: { waitMs: number; from: number; take?: boolean; signal?: AbortSignal }): Promise<WaitOutcome> {
    const deadline = mono() + opts.waitMs;
    const call = this.enter(opts.take ?? true, opts.signal);
    const scan = newScan(opts.from);
    let matched: Match | undefined;
    let by: WaitOutcome['by'] = 'timeout';
    try {
      const r = await this.until(deadline, () => {
        if (this.closing) return 'closed' as const;
        if (this.exitInfo) return 'exited' as const;
        if (opts.signal?.aborted) return 'cancelled' as const;
        if (until.kind === 'match') return (matched = this.scan(until.pattern, scan)) ? ('match' as const) : undefined;
        if (this.prompted) return until.kind === 'end' ? ('end' as const) : undefined;
        if (this.top.far && this.lookDue()) this.follow(proc.info(this.pid));
        if (!this.kernelSays || !this.lookDue()) return undefined;
        const s = this.front().state;
        if (s === 'waiting') return 'input' as const;
        return until.kind === 'end' && s === 'prompt' ? ('end' as const) : undefined;
      }, opts.signal);
      if (r) by = r;
      await this.t.settled();
      if (by === 'timeout' && until.kind === 'match' && (matched = this.searchSettled(until.pattern, scan))) by = 'match';
    } finally {
      this.calls.delete(call);
    }
    const front = this.front();
    this.observe(front, call.take ? [call] : []);
    return { by, front, ended: call.ended, ...(matched && { matched }), ...(until.kind === 'match' && !matched && this.searched(scan)), took: call.took };
  }

  /** After a wait ran out and the parse caught up: when that parse added lines, one more slice of the search, so `searched` counts from where the search really stopped. */
  private searchSettled(pattern: RegExp, s: Scan): Match | undefined {
    return s.parses === this.parses ? undefined : this.scan(pattern, s);
  }

  /**
   * The first line from `s.from` on that matches, each matched on its head within the pattern's window;
   * then, while the alternate screen is active, its first row that matches. A pass begins after each parse,
   * moves `s.from` past frozen lines that didn't match, and counts the lines it searched on their head only.
   * It searches at least one line or row in each turn, and once this turn's searches have spent their slice,
   * the pass stops and goes on in a later turn. `upto` begins a pass though nothing was parsed since the last,
   * and searches the lines before that line at once; the rest wait for a slice.
   */
  private scan(pattern: RegExp, s: Scan, upto?: number): Match | undefined {
    const now = upto !== undefined;
    if (now || s.parses !== this.parses) Object.assign(s, { parses: this.parses, next: s.from, row: 0, live: 0 });
    else if (s.next === undefined) return undefined;
    let n = s.next!;
    for (;;) {
      const ls = this.t.lines(n, n + SCAN_CHUNK);
      if (ls.lines.length === 0) {
        if (ls.from <= n) break;
        n = ls.from;
        continue;
      }
      const frozen = ls.lines.length - ls.live;
      for (let i = 0; i < ls.lines.length; i++) {
        if (upto !== undefined ? ls.from + i >= upto : spent() && s.turn === turn) return this.later(s, ls.from + i, 0);
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
    if (screen.alt && !now)
      for (let row = s.row; row < screen.rows.length; row++) {
        if (spent() && s.turn === turn) return this.later(s, n, row);
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

  /** For a search that ended without a match: the lines it searched on their head only, and the kept lines and rows its pass hadn't reached, from the first such line. */
  private searched(s: Scan): { clipped?: number; unsearched?: number; unsearchedFrom?: number } {
    const clipped = s.clipped + (s.next === undefined ? s.clippedLive : s.live);
    if (s.next === undefined) return clipped > 0 ? { clipped } : {};
    const screen = this.t.screen();
    const from = this.t.lines(s.next, s.next).from;
    const unsearched = Math.max(0, this.t.end() - from) + (screen.alt ? Math.max(0, screen.rows.length - s.row) : 0);
    return { ...(clipped > 0 && { clipped }), ...(unsearched > 0 && { unsearched, unsearchedFrom: from }) };
  }

  /** Whether process group `pgid` still has a member among the shell's descendants, so a signal to it reaches the job it was read as; undefined when they can't be listed. */
  private ours(pgid: number): boolean | undefined {
    return proc.descendants(this.pid, true)?.some((d) => d.pgrp === pgid);
  }

  /** Whether group `pgid`, among the shell's descendants, holds a stopped process. */
  private groupStopped(pgid: number): boolean | undefined {
    const members = proc.descendants(this.pid, true)?.filter((d) => d.pgrp === pgid);
    return members && (members.length ? proc.stopped(members) : false);
  }

  async stop(signal?: NodeJS.Signals, opts: { abort?: AbortSignal } = {}): Promise<StopOutcome> {
    const steps: StopStep[] = [];
    let f = this.front();
    const aborted = (): boolean => opts.abort?.aborted === true;
    if (aborted()) return { steps, front: f, cancelled: true };
    if (f.state === 'prompt' || f.state === 'exited' || f.state === 'unknown') return { steps, front: f };
    const target = f.process;
    const own = target.shell || target.pgid === this.pid;
    const settled = (now: Front): boolean => now.state === 'prompt' || now.state === 'exited' || (now.state !== 'unknown' && !now.process.shell && now.process.pgid !== target.pgid);
    const gone = (now: Front): boolean => now.state === 'prompt' || now.state === 'exited' || (now.state !== 'unknown' && now.process.pgid !== target.pgid && (!now.process.shell || this.ours(target.pgid) !== true));
    const cleared = async (): Promise<Front> =>
      (await this.until(mono() + STEP_GRACE_MS, () => {
        const now = this.front();
        return settled(now) ? now : undefined;
      }, opts.abort)) ?? this.front();
    /** Takes one step. `sig`, for a signal `stop` was asked for, is recorded as the command's only once the signal is sent. */
    const step = async (sent: StopStep['sent'], sig?: Signalled): Promise<boolean> => {
      // Once a close has begun, it ends what runs, and stop sends nothing more.
      if (this.closed) return true;
      const mine = sent === 'C-c' ? true : this.ours(target.pgid);
      if (sent === 'C-c') this.write('\x03');
      else if (mine) {
        if (sig) this.signalled = sig;
        const refused = proc.signalGroup(target.pgid, sent);
        if (refused) {
          if (sig && this.signalled === sig) this.signalled = undefined;
          f = this.front();
          steps.push({ sent, to: target, refused, front: f });
          return true;
        }
      } else {
        f = this.front();
        if (mine === undefined) steps.push({ sent, to: target, withheld: true, front: f });
        return true;
      }
      f = await cleared();
      steps.push({ sent, ...(sent !== 'C-c' && { to: target }), front: f });
      return gone(f);
    };
    if (this.top.far) {
      if (!signal) await step('C-c');
      return { steps, front: f, within: true, ...(aborted() && { cancelled: true as const }) };
    }
    if (signal) {
      if (own) return { steps, front: f, next: 'close' };
      const sig: Signalled = { pgid: target.pgid, command: f.command };
      await step(signal, sig);
      const last = steps.at(-1);
      if (last && !last.refused && !last.withheld && last.front.state === 'prompt' && (sig.checked ? sig.stopped : this.groupStopped(target.pgid))) last.stopped = true;
      return { steps, front: f };
    }
    if (await step('C-c')) return { steps, front: f };
    if (aborted()) return { steps, front: f, cancelled: true };
    if (own) return { steps, front: f, next: 'close' };
    for (const s of ['SIGTERM', 'SIGKILL'] as const) {
      if (await step(s)) return { steps, front: f };
      if (aborted()) return { steps, front: f, cancelled: true };
    }
    return { steps, front: f, next: 'close' };
  }

  async integrate(opts: { waitMs: number; signal?: AbortSignal }): Promise<IntegrateOutcome> {
    const deadline = mono() + opts.waitMs;
    const by = (): 'exited' | 'closed' | 'cancelled' | undefined => (this.exitInfo || this.ptyExit ? 'exited' : this.closed ? 'closed' : opts.signal?.aborted ? 'cancelled' : undefined);
    const f = this.front();
    if (f.state === 'exited' || f.state === 'unknown' || this.prompted || by()) return { kind: 'refused', front: f };
    if (this.probe) return { kind: 'refused', integrating: true, front: f };
    if (this.top.atPrompt && !this.plain) return { kind: 'refused', front: f, ...(this.top.submitted && { sent: true as const }) };
    // At its prompt a line editor holds the terminal out of canonical mode; ssh, su and sudo ask for a password or a yes/no in it.
    const canonical = proc.modes(this.pts)?.canonical;
    if (canonical === undefined) return { kind: 'refused', unread: true, front: f };
    if (canonical) return { kind: 'refused', canonical: true, front: f };
    let within: Process;
    let self: string | undefined;
    if (f.state === 'prompt') {
      self = proc.info(this.pid)?.argv;
      if (self === undefined) return { kind: 'refused', unlisted: true, front: f };
      within = { pgid: this.pid, argv: self, shell: true };
    }
    else if (this.top.far) {
      // A far chain's front names the program it was reached through. What holds the terminal now may be one that chain's shell
      // started here, as ssh from a local shell, and that is what this shell is reached through.
      const g = proc.info(this.pid)?.tpgid;
      if (g === undefined) return { kind: 'refused', unlisted: true, front: f };
      within = { pgid: g, argv: proc.argv(g) ?? '?', shell: false };
    } else within = f.process;
    const all = proc.family(this.pid)?.all;
    const members = all && [{ pid: this.pid, pgrp: this.pid }, ...all].filter((d) => d.pgrp === within.pgid);
    if (!members?.length) return { kind: 'refused', unlisted: true, front: f };
    const leaves: Leaf[] = members.filter((m) => !members.some((c) => c.ppid === m.pid)).map((m) => ({ pid: m.pid, argv: proc.argv(m.pid) ?? within.argv }));
    const below = this.top;
    const plainBelow = this.plain && within.pgid !== this.pid;
    // A program the shell is reached through can end while the line that ran it goes on with another in the same group.
    let gone: Leaf | undefined;
    const leafGone = (): boolean => (gone ??= leaves.find((l) => !proc.alive(l.pid))) !== undefined;
    const ended = (): boolean => !this.chains.includes(below) || below.atPrompt || (plainBelow && this.lookDue() && this.front().state === 'prompt') || leafGone();
    let stopped: 'exited' | 'closed' | 'cancelled' | undefined;
    const stop = (): typeof stopped => (stopped ??= by() ?? (ended() ? 'exited' : undefined));
    const incomplete = (step: 'probe' | 'hooks', why: NonNullable<typeof stopped> | 'timeout'): IntegrateOutcome => ({
      kind: 'incomplete',
      step,
      by: why,
      ...(why === 'exited' && gone && { ended: gone.argv }),
      front: this.front(),
    });
    const call = String(randomInt(100000, 1000000));
    const answered = async (): Promise<ProbeAnswer | undefined> => {
      delete this.probe!.answer;
      return (await this.until(deadline, () => (stop() ? null : this.probe?.answer), opts.signal)) ?? undefined;
    };
    try {
      this.probe = { call };
      if (stop()) return incomplete('probe', stop()!);
      this.write(integration.probeLine(call));
      const answer = await answered();
      if (!answer) return incomplete('probe', stop() ?? 'timeout');
      const kind = answer.fish ? 'fish' : answer.zsh ? 'zsh' : answer.bash ? 'bash' : undefined;
      if (!kind) {
        if (stop()) return incomplete('probe', stop()!);
        this.write(integration.probeZeroLine(call));
        const zero = await answered();
        if (!zero) return incomplete('probe', stop() ?? 'timeout');
        const name = zero.zero?.replace(/^-/, '');
        return { kind: 'unsupported', ...(name && { shell: path.basename(name) }), front: this.front() };
      }
      const nonce = { counter: 1, random: randomDigits() };
      this.remember(nonce);
      const lines = integration.farHooks(kind, nonce, call);
      for (const [i, line] of lines.slice(0, -1).entries()) {
        if (stop()) return incomplete('hooks', stop()!);
        this.write(line);
        if (!(await this.until(deadline, () => (stop() ? false : (this.probe?.acked ?? -1) >= i ? true : undefined), opts.signal))) return incomplete('hooks', stop() ?? 'timeout');
      }
      if (stop()) return incomplete('hooks', stop()!);
      const chain = newChain(nonce, '');
      chain.far = { kind, within, drained: [], leaves, ...(self !== undefined && { self }) };
      this.chains.push(chain);
      this.probe!.chain = chain;
      try {
        this.write(lines.at(-1)!);
      } catch (e) {
        if (this.top === chain) this.chains.pop();
        throw e;
      }
      const drawn = await this.until(deadline, () => (!this.chains.includes(chain) || by() || leafGone() ? false : this.top === chain && this.prompted ? true : undefined), opts.signal);
      if (!drawn) return incomplete('hooks', by() ?? (leafGone() || !this.chains.includes(chain) ? 'exited' : 'timeout'));
      const p = this.probe!;
      const from = p.acked === lines.length - 1 ? p.ackedAt : undefined;
      const to = p.endAt ?? (chain.promptAt && { line: chain.promptAt.line, col: 0 });
      const printed = from && to ? this.between(from, to) : [];
      return { kind: 'integrated', shell: kind, version: answer[kind], ...(printed.some((l) => l.trim()) && { printed }), front: this.front() };
    } finally {
      this.probe = undefined;
    }
  }

  /** The transcript's text from `a` to `b`, a line each: the first from `a`'s column, the last up to `b`'s. */
  private between(a: Pos, b: Pos): string[] {
    if (b.line < a.line || (b.line === a.line && b.col <= a.col)) return [];
    const r = this.t.lines(a.line, b.line + 1);
    const ls = r.lines;
    if (r.from === a.line && ls.length) ls[0] = ls[0]!.slice(a.col);
    if (r.to === b.line + 1 && ls.length) {
      if (b.col === 0) ls.pop();
      else ls[ls.length - 1] = b.line === a.line && r.from === a.line ? ls.at(-1)!.slice(0, b.col - a.col) : ls.at(-1)!.slice(0, b.col);
    }
    return ls;
  }

  /**
   * A close while one is under way waits for that one, until its own deadline, so neither returns before the first has hung up what
   * it listed. With `force`, the close under way goes on as forced from its next step. At its own deadline it says the close is
   * still under way, and names only a signal that close has sent the shell. A close that fails leaves none under way, so the next
   * starts again.
   */
  close(opts: { force?: boolean; deadline: number }): Promise<Closed> {
    if (!this.closing) {
      const closing = this.shut(opts);
      this.closing = closing;
      this.wake();
      closing.catch(() => {
        if (this.closing !== closing) return;
        this.closing = undefined;
        this.forcedLate = false;
        this.sentShell = undefined;
        this.schedulePoll();
      });
      return closing;
    }
    if (opts.force && !this.forcedLate) {
      this.forcedLate = true;
      this.wake();
    }
    let timer: NodeJS.Timeout | undefined;
    const underway = new Promise<Closed>(
      (resolve) => (timer = setTimeout(() => resolve({ code: null, ...(this.sentShell ? { signal: this.sentShell } : {}), underway: true }), Math.max(0, opts.deadline - mono()))),
    );
    return Promise.race([this.closing, underway]).finally(() => clearTimeout(timer));
  }

  private async shut(opts: { force?: boolean; deadline: number }): Promise<Closed> {
    this.closed = true;
    if (this.poll) clearTimeout(this.poll);
    const { deadline } = opts;
    let unlisted = false;
    const unreached: NonNullable<Closed['unreached']> = [];
    if (!this.exitInfo) {
      const forced = (): boolean => opts.force === true || this.forcedLate;
      const killShell = (): void => {
        try {
          this.p.kill('SIGKILL');
          this.sentShell = 'SIGKILL';
        } catch {}
      };
      const failed = (why: string): void => this.note(`session ${JSON.stringify(this.name)}: close couldn't list ${why}`);
      const before = (graces: number): proc.Listing => ({ deadline: deadline - graces * CLOSE_GRACE_MS, failed });
      // Listed before the first signal: once the shell exits, nothing in its session has a terminal.
      const first = before(forced() ? 1 : 2);
      const onTerminal = (await proc.onTerminal(this.pid, this.pts, first))?.filter((d) => d.pid !== this.pid);
      let descendantsListed = forced();
      const ds = descendantsListed ? await proc.allDescendants(this.pid, first) : [];
      unlisted = onTerminal === undefined || ds === undefined;
      const listed = [...(onTerminal ?? []), ...(ds ?? [])];
      /**
       * Sends `signal` to each listed group that still holds a listed process, and records each it couldn't reach. When that can't be
       * checked, it sends nothing and records the listing as incomplete: a group whose id was taken again isn't signalled, and the
       * result says what was started may live on. A signal given as a function is chosen once the listing is back, so a force that
       * joins meanwhile is honoured.
       */
      const reach = async (which: 'SIGHUP' | 'SIGKILL' | (() => 'SIGHUP' | 'SIGKILL'), l: proc.Listing): Promise<void> => {
        const held = await proc.held(listed, l);
        if (!held) {
          if (listed.length) unlisted = true;
          return;
        }
        const signal = typeof which === 'function' ? which() : which;
        const refused: Array<{ pgid: number; error: string }> = [];
        for (const pgid of held) {
          const error = proc.signalGroup(pgid, signal);
          // On Linux, a stopped process holds the hangup until it's continued. So CONT follows a hangup that was delivered, as bash
          // sends it.
          if (signal === 'SIGHUP' && !error) proc.signalGroup(pgid, 'SIGCONT');
          if (error && error !== 'ESRCH') refused.push({ pgid, error });
        }
        if (!refused.length) return;
        const still = await proc.held(listed.filter((d) => refused.some((r) => r.pgid === d.pgrp)), l);
        for (const { pgid, error } of refused) if (still?.has(pgid) !== false) unreached.push({ pgid, signal, error });
      };
      const gone = (): Exit | undefined => this.exitInfo ?? this.ptyExit;
      /** KILLs the listed groups and the shell, listing the shell's descendants first if that wasn't done, as `force` does. */
      const kill = async (l: proc.Listing): Promise<void> => {
        if (!descendantsListed && !gone()) {
          descendantsListed = true;
          const more = await proc.allDescendants(this.pid, l);
          if (more === undefined) unlisted = true;
          else listed.push(...more);
        }
        await reach('SIGKILL', l);
        killShell();
      };
      let killed = false;
      if (forced()) {
        await kill(first);
        killed = true;
      } else {
        // bash can miss a SIGHUP that lands just before its line editor waits for input, and go on waiting.
        const grace = Math.min(mono() + CLOSE_GRACE_MS, deadline - CLOSE_GRACE_MS);
        for (let at = mono(); !gone() && !forced() && at < grace; at += HANGUP_EVERY_MS) {
          try {
            this.p.kill('SIGHUP');
            this.sentShell ??= 'SIGHUP';
          } catch {}
          await this.until(Math.min(at + HANGUP_EVERY_MS, grace), () => gone() ?? (forced() || undefined));
        }
        if (!gone() && forced()) {
          await kill(before(1));
          killed = true;
        } else if (!gone()) killShell();
      }
      await this.until(Math.min(mono() + CLOSE_GRACE_MS, deadline), gone);
      // A shell hangs up only the jobs it still counts as its own, and a KILLed one none. A close forced once the shell had gone
      // KILLs what it listed.
      if (!killed) await reach(() => (forced() ? 'SIGKILL' : 'SIGHUP'), before(0));
    } else {
      // Once the shell has exited, nothing has its terminal, so what it left running can't be listed, and may live on.
      unlisted = true;
      this.note(`session ${JSON.stringify(this.name)}: close couldn't list what the shell left running, since the shell had already exited`);
    }
    const exit = this.exitInfo ?? this.ptyExit;
    this.t.dispose();
    // A process just hung up can still be writing here as it exits, so a removal that meets a file written meanwhile tries again.
    const removal = fs.promises
      .rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      .catch((e: Error) => this.note(`session ${JSON.stringify(this.name)} closed, but its directory ${this.dir} wasn't removed: ${e.message}`));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([removal, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - mono()))))]);
    clearTimeout(timer);
    const closed: Closed = exit ? { ...exit } : { code: null, ...(this.sentShell && { signal: this.sentShell }), unconfirmed: true };
    if (unlisted) closed.unlisted = true;
    if (unreached.length) closed.unreached = unreached;
    return closed;
  }

  watch(pattern: RegExp, from: number, command?: number): number {
    const id = ++this.watchSeq;
    this.watches.set(id, { pattern, scan: newScan(from), ...(command !== undefined && { command }) });
    queueMicrotask(() => this.checkWatches());
    return id;
  }

  unwatch(id: number): void {
    this.watches.delete(id);
  }

  /** `ended`: as `finish` does inside the parse, search that command's own watches through its output at once, so a match there is emitted before its `ended`; other watches wait for their slice. */
  private checkWatches(ended?: Command): void {
    for (const [id, w] of this.watches) {
      if (ended && w.command !== ended.id) continue;
      const m = this.scan(w.pattern, w.scan, ended?.to);
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

const ptyDir = (): string | undefined => {
  try {
    return path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return undefined;
  }
};

export const openSession: OpenSession = async (o) => {
  let isDir = false;
  try {
    isDir = fs.statSync(o.cwd).isDirectory();
  } catch {}
  if (!isDir) throw err('invalid_argument', `cwd ${o.cwd} is not a directory`);
  try {
    fs.accessSync(o.shell, fs.constants.X_OK);
  } catch {
    throw err('backend_failure', `the shell ${o.shell} cannot be run. The daemon chose it when it started. Whoever runs the daemon can restart it, which chooses the shell again`);
  }
  const bash = findBash();
  if (!bash) throw err('backend_failure', 'this host has no bash, which closes the descriptors a shell would otherwise inherit from the daemon. Sessions open here once bash is installed');
  const deadline = mono() + o.waitMs;
  const dir = fs.mkdtempSync(path.join(o.parent, 's-'));
  const nonce: Nonce = { counter: 1, random: randomDigits() };
  let launch: ReturnType<typeof integration.prepare>;
  try {
    launch = integration.prepare(o.shell, dir, nonce, o.env);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const env = { ...o.env, ...historyIsolationEnv(dir), ...launch.env };
  const [file, args] = viaBash(bash, shellLaunch(o.oomScoreAdj ?? 0), 'tsm-shell', [o.shell, ...launch.args]);
  let p: pty.IPty;
  try {
    p = pty.spawn(file, args, { name: env.TERM ?? 'xterm-256color', cwd: o.cwd, env, cols: o.cols, rows: o.rows });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    const cause = `the shell could not start: ${clause((e as Error).message)}`;
    const pdir = ptyDir();
    const helper = pdir && unrunnableHelper(pdir);
    if (helper) throw err('backend_failure', `${cause}. node-pty starts every shell through ${helper}, which isn't executable. Whoever runs this host can run chmod +x ${shellQuote(helper)}, and then the session can be opened again`);
    throw err('backend_failure', `${cause}. If that error passes, such as a limit on processes, opening again may work`);
  }
  const s = new LiveSession(o, p, dir, launch.kind, nonce, o.nextCommandId, [o.shell, ...launch.args].join(' '));
  await s.ready(o.waitMs, o.signal);
  if (s.exit) {
    const said = s.startupText();
    await s.close({ deadline });
    throw err('backend_failure', `the shell exited as it started (${s.exit.signal ?? `status ${s.exit.code}`}). Its startup files or the directory are the likely cause, and opening again runs them again${said ? `. It printed: ${said.slice(-500)}` : ''}`);
  }
  return s;
};
