/**
 * A scripted shell with rich integration, for deterministic session tests.
 * It echoes typed lines, emits the keyed OSC 133/633 marks a real integrated shell
 * would (the key comes with the spawn, out of band, as with the real integration), runs
 * registered handlers for command lines, and answers ^C.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { ScriptedBackend, type ScriptedPty } from '../src/backends/scripted.js';
import { Journal } from '../src/core/journal.js';
import { CLEAR_LINE_KEYS, encodeVscodeValue } from '../src/core/marks.js';
import type { TermError } from '../src/core/errors.js';
import { Session, type RunInfo } from '../src/core/session.js';
import type { JournalEvent } from '../src/core/types.js';
import { prepareIntegration } from '../src/shell/integration.js';

export interface FakeCommandResult {
  output?: string;
  exit?: number;
  /** Resolve later: the test ends the command by calling finishHung(). */
  hang?: boolean;
  /** The line produces no pre-execution mark: output, then a new prompt (no C, no D). */
  noPreexec?: boolean;
}

export type FakeHandler = (line: string, shell: FakeShell) => FakeCommandResult;

export interface FakeShellOptions {
  marks?: 'rich' | 'basic' | 'none';
  promptAtStart?: boolean;
  /** ^C and ^\ are ignored while a command runs (a job that will not die). */
  ignoreSignals?: boolean;
  /** Emit the integration's handshake before the first prompt (default: with marks). */
  hello?: boolean;
  /** dash-like: a ^C that kills the job also aborts the rest of the typed line. */
  abortListOnInterrupt?: boolean;
  /** SIGTERM/SIGKILL to the job's process group do not end it either. */
  ignoreGroupSignals?: boolean;
  /**
   * Keystrokes typed while a command runs wait in the tty buffer and are read at the
   * next prompt, before anything written after them (default: the command swallows them).
   */
  typeahead?: boolean;
  /** fish-like: a ^C at an empty prompt is answered with nothing (no new prompt, no marks). */
  quietEmptyInterrupt?: boolean;
}

export const OSC = (s: string) => `\x1b]${s}\x07`;
export const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
export const ofType = <T extends JournalEvent['type']>(evs: JournalEvent[], t: T) => evs.filter((e): e is Extract<JournalEvent, { type: T }> => e.type === t);
/** The error code `fn` throws with, or 'no error'. */
export const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as TermError).code;
  }
  return 'no error';
};

export class FakeShell {
  cwd = '/home/t';
  private buf = '';
  private running: { finish: (exit: number, output?: string, withPrompt?: boolean) => void; aborted?: boolean } | undefined;
  private handlers: Array<{ match: RegExp | string; handler: FakeHandler }> = [];
  private started = false;
  private paused = false;
  private held = '';
  /** Typeahead, in arrival order, read after the running command ends. */
  private queued = '';
  private lastExit = 0;
  /** Lines the fake shell has executed, in order (the sourced text for temp-file lines). */
  readonly executed: string[] = [];
  /** Lines typed at its prompt, exactly as read. */
  readonly typed: string[] = [];
  /** How often the clear keys emptied its line editor. */
  clears = 0;
  readonly key: string;
  readonly marks: 'rich' | 'basic' | 'none';
  ignoreSignals = false;
  readonly opts: FakeShellOptions;

  constructor(readonly pty: ScriptedPty, opts: FakeShellOptions = {}) {
    this.opts = opts;
    this.marks = opts.marks ?? 'rich';
    this.ignoreSignals = opts.ignoreSignals ?? false;
    this.key = pty.opts.bootstrap?.key ?? '';
    pty.onWrite((d) => this.onWrite(d));
    pty.onGroupSignal = (pgid, sig) => {
      if (!this.running || pgid !== this.jobPgid || this.opts.ignoreGroupSignals) return;
      if (sig === 'SIGTERM' || sig === 'SIGKILL') this.finishRunning(sig === 'SIGTERM' ? 143 : 137, '');
    };
    if (opts.promptAtStart !== false) queueMicrotask(() => this.start());
  }

  /** A keyed mark, as the real integration emits it. */
  mark(payload: string): string {
    return OSC(`${payload};k=${this.key}`);
  }

  get jobPgid(): number {
    return this.pty.pid + 1;
  }

  /** Register a handler; a later registration for the same line wins. */
  on(match: RegExp | string, handler: FakeHandler): this {
    this.handlers.unshift({ match, handler });
    return this;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.marks !== 'none' && (this.opts.hello ?? true)) this.pty.emit(this.mark('633;P;TsmHello=fake'));
    this.prompt();
  }

  private prompt(): void {
    if (this.marks === 'rich') this.pty.emit(this.mark(`633;P;Cwd=${encodeVscodeValue(this.cwd)}`) + this.mark('133;A') + '$ ' + this.mark('133;B'));
    else this.pty.emit('$ ');
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Stop reading input (bytes queue as in a tty buffer) until resume(). */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const d = this.held;
    this.held = '';
    this.onWrite(d);
  }

  private onWrite(data: string): void {
    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      // A key's escape sequence. The integration binds the daemon's clear keys to "empty
      // the line editor" (ss-1): an integrated fake shell does too; other keys are ignored.
      const key = ch === '\x1b' ? /^\x1b\[[0-9;]*~/.exec(chars.slice(i, i + 16).join(''))?.[0] : undefined;
      if (key !== undefined) {
        i += key.length - 1;
        if (this.paused) this.held += key;
        else if (this.running) {
          if (this.opts.typeahead) this.queued += key;
        } else if (this.queued) this.queued += key;
        else if (CLEAR_LINE_KEYS.includes(key) && this.marks !== 'none') {
          this.buf = '';
          this.clears++;
        }
        continue;
      }
      if (this.paused) {
        if (ch === '\x03') {
          // The tty driver flushes unread input on SIGINT; the line editor redraws.
          this.held = '';
          this.pty.emit('^C\r\n');
          this.buf = '';
          this.prompt();
          continue;
        }
        this.held += ch;
        continue;
      }
      if (ch === '\x03') {
        if (this.running && this.ignoreSignals) continue;
        if (this.running) {
          this.pty.emit('^C\r\n');
          this.running.aborted = this.opts.abortListOnInterrupt === true;
          this.finishRunning(130);
        } else {
          if (this.buf === '' && this.opts.quietEmptyInterrupt) continue;
          // At the prompt: the line (and any typeahead, which the tty flushes) is gone.
          this.pty.emit('^C\r\n');
          this.buf = '';
          this.queued = '';
          this.prompt();
        }
        continue;
      }
      if (ch === '\x1c') {
        if (this.running && this.ignoreSignals) continue;
        if (this.running) {
          this.pty.emit('^\\Quit\r\n');
          this.finishRunning(131);
        }
        continue;
      }
      if (ch === '\x15') {
        this.buf = '';
        continue;
      }
      if (this.running) {
        if (this.opts.typeahead) this.queued += ch;
        continue; // otherwise typed into a running command: swallowed (a real reader would take it)
      }
      if (this.queued) {
        this.queued += ch; // behind earlier typeahead
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        const line = this.buf;
        this.buf = '';
        this.pty.emit('\r\n');
        this.execute(line);
      } else {
        this.buf += ch;
        this.pty.emit(ch); // echo
      }
    }
  }

  private finishRunning(exit: number, output?: string): void {
    const r = this.running;
    if (r) r.finish(exit, output);
  }

  private execute(typedLine: string): void {
    this.typed.push(typedLine);
    let line = typedLine;
    // Temp-file route: ` . '<file>'` sources a file the session wrote (bash always emits
    // C/D for it: `.` is a simple command, whatever the file holds).
    const src = /^\s*(?:command \.|\.|source|eval \(__tsm_collect) '((?:[^']|'\\'')*)'(?: \$status\))?(.*)$/.exec(typedLine);
    let tail = '';
    if (src && src[1] !== undefined) {
      const file = src[1].replace(/'\\''/g, "'");
      tail = src[2] ?? '';
      try {
        line = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
      } catch {
        // As a real shell does when the file is gone (the session removed it on close or cancel).
        line = `echo "${file}: No such file or directory"; false`;
      }
    } else {
      const probe = /^\s*echo "<<<EX""IT:([0-9a-f]+):\$(?:\?|status)>>>"$/.exec(typedLine);
      if (probe) {
        this.pty.emit(`<<<EXIT:${probe[1]}:${this.lastExit}>>>\r\n`);
        this.prompt();
        return;
      }
      if (typedLine.trim() === '') {
        this.prompt();
        return;
      }
    }
    this.executed.push(line);
    const h = this.handlers.find((x) => (typeof x.match === 'string' ? x.match === line : x.match.test(line)));
    const result: FakeCommandResult = h ? h.handler(line, this) : line.trim() === '' ? { exit: 0 } : { output: `fake: ${line.split(' ')[0]}: command not found\r\n`, exit: 127 };
    if (result.noPreexec) {
      if (result.output) this.pty.emit(result.output);
      this.prompt();
      return;
    }
    if (this.marks === 'rich') this.pty.emit(this.mark(`633;E;${encodeVscodeValue(typedLine)}`) + this.mark('133;C'));
    const finish = (exit: number, output?: string, withPrompt = true) => {
      if (this.running === undefined) return;
      const aborted = this.running.aborted === true;
      this.running = undefined;
      this.hung = undefined;
      this.pty.foregroundPgid = this.pty.pid;
      this.lastExit = exit;
      if (output) this.pty.emit(output);
      // The marker tail (`; echo "<<<EXI""T:nonce:$?>>>"`) executes after the sourced file,
      // unless an interrupt aborted the rest of the line (dash).
      const m = /echo "<<<EXI""T:([0-9a-f]+):\$(?:\?|status)>>>"/.exec(tail);
      if (m && !aborted) this.pty.emit(`<<<EXIT:${m[1]}:${exit}>>>\r\n`);
      if (this.marks !== 'none') this.pty.emit(this.mark(`133;D;${exit}`));
      if (withPrompt) {
        this.prompt();
        this.replayTypeahead();
      }
    };
    this.running = { finish };
    if (result.hang) {
      this.pty.foregroundPgid = this.jobPgid;
      this.hung = finish;
      if (result.output) this.pty.emit(result.output);
      return;
    }
    finish(result.exit ?? 0, result.output);
  }

  /** The finish() of a hung command, if one is running. */
  hung: ((exit: number, output?: string, withPrompt?: boolean) => void) | undefined;

  finishHung(exit = 0, output?: string, opts: { prompt?: boolean } = {}): void {
    const f = this.hung;
    this.hung = undefined;
    f?.(exit, output, opts.prompt ?? true);
  }

  /** Emit a prompt now (used after finishHung with prompt: false). */
  promptNow(): void {
    this.prompt();
    this.replayTypeahead();
  }

  private replayTypeahead(): void {
    if (!this.queued || this.running) return;
    const q = this.queued;
    this.queued = '';
    this.onWrite(q);
  }
}

// ───────────── a scripted session harness shared by the core specs ─────────────

export interface Harness {
  session: Session;
  shell: FakeShell;
  pty: ScriptedPty;
  backend: ScriptedBackend;
  journal: Journal;
}

export interface HarnessOptions extends FakeShellOptions {
  control?: 'seat' | 'owner-priority' | 'open';
  setup?: (s: FakeShell) => void;
  tempDir?: string;
  daemonEnv?: NodeJS.ProcessEnv;
  env?: Record<string, string>;
  seatGraceMs?: number;
  editingStaleMs?: number;
  integrationGraceMs?: number;
  startupCapMs?: number;
  owner?: string;
  /** Attach the owner (who takes the free seat) once started; default true. */
  attachOwner?: boolean;
}

export const AGENT = 'agent:a@test';
export const HUMAN = 'human:test:1';
const harnessTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-session-'));
/** Temp dirs this process made, removed again at exit: atuin's background writer can recreate a closed session's history dir. */
const temps = new Set([harnessTmp]);
/** Remove a test directory; atuin's background writer can refill one while it goes, and cleanup never fails a test. */
const removeDir = (d: string) => {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // left for the exit hook
  }
};
process.on('exit', () => temps.forEach(removeDir));

/** A Session on the scripted backend with a FakeShell and the usual command handlers. */
export async function scriptedSession(opts: HarnessOptions = {}): Promise<Harness> {
  const backend = new ScriptedBackend();
  const marks = opts.marks ?? 'rich';
  let shell!: FakeShell;
  let pty!: ScriptedPty;
  backend.onSpawnShell = (p) => {
    pty = p;
    const so: FakeShellOptions = { ...opts, marks };
    if (opts.hello === undefined) so.hello = marks === 'rich';
    shell = new FakeShell(p, so);
    shell.on('echo hello', () => ({ output: 'hello\r\n', exit: 0 }));
    shell.on(/^false$/, () => ({ exit: 1 }));
    shell.on(/^exit (\d+)$/, (l) => ({ exit: Number(l.split(' ')[1]) }));
    shell.on(/^sleep/, () => ({ hang: true }));
    shell.on(/^cd (\S+)$/, (l, sh) => {
      sh.cwd = l.split(' ')[1]!;
      return { exit: 0 };
    });
    shell.on(/^env -0 > '(.*)'$/, (l) => {
      fs.writeFileSync(/^env -0 > '(.*)'$/.exec(l)![1]!.replace(/'\\''/g, "'"), 'A=1\0B=two\0');
      return { exit: 0 };
    });
    opts.setup?.(shell);
    // The scripted PTY only records kills; a SIGHUP/SIGKILL ends the fake shell.
    const origKill = p.kill.bind(p);
    p.kill = (sig) => {
      origKill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') p.exit({ exitCode: null, signal: sig });
    };
  };
  const journal = new Journal();
  const so: Parameters<typeof Session.start>[0] = {
    id: 't',
    owner: opts.owner ?? AGENT,
    control: opts.control ?? 'seat',
    shell: '/bin/fake',
    cwd: '/home/t',
    env: opts.env ?? { SESSION_VAR: 'yes' },
    daemonEnv: opts.daemonEnv ?? { PATH: '/bin' },
    backend,
    journal,
    integrationGraceMs: opts.integrationGraceMs ?? 100,
    tempDir: opts.tempDir ?? harnessTmp,
  };
  if (opts.seatGraceMs !== undefined) so.seatGraceMs = opts.seatGraceMs;
  if (opts.editingStaleMs !== undefined) so.editingStaleMs = opts.editingStaleMs;
  if (opts.startupCapMs !== undefined) so.startupCapMs = opts.startupCapMs;
  if (marks !== 'none') so.integration = { args: [], env: {} };
  const session = await Session.start(so);
  if (opts.attachOwner ?? true) session.attach(so.owner, 'c1'); // the owner takes the free seat (§9)
  return { session, shell, pty, backend, journal };
}

// ───────────── real shells, with a fake HOME holding the "user's" rc files ─────────────

export interface RealOptions {
  /** A separate directory for command files (the registry's short /tmp one). */
  commandDir?: string;
  /** Files to create under the fake HOME (relative path → content). */
  rc?: Record<string, string>;
  /** The session's creation-time env. */
  env?: Record<string, string>;
  /** The daemon's env (default: this process's env with HOME set to the fake home). */
  daemonEnv?: NodeJS.ProcessEnv;
  login?: boolean;
  noUserRc?: boolean;
  integrationGraceMs?: number;
  startupCapMs?: number;
  /** A ZDOTDIR the "user" had when the daemon started (`~/` is the fake HOME). */
  userZdotdir?: string;
  cols?: number;
  editingStaleMs?: number;
  control?: 'seat' | 'owner-priority' | 'open';
}

export interface Real {
  session: Session;
  journal: Journal;
  home: string;
  tmp: string;
  startMs: number;
  /** Initial credential, available to tests for exact leak detection, never put in a child environment. */
  integrationKey: string | undefined;
  /** Admit (waiting out prompt-pending), await, and return the Run with its transcript. */
  run(line: string, wait?: number): Promise<RunInfo & { text: string }>;
  close(): Promise<void>;
}

/** A real shell in a real PTY, isolated from the developer's rc files and history. */
export async function realSession(shell: string, opts: RealOptions = {}): Promise<Real> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-real-'));
  temps.add(tmp);
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const [f, body] of Object.entries(opts.rc ?? {})) {
    fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true });
    fs.writeFileSync(path.join(home, f), body);
  }
  const userEnv: NodeJS.ProcessEnv = { HOME: home };
  if (opts.userZdotdir !== undefined) userEnv.ZDOTDIR = opts.userZdotdir.replace(/^~\//, `${home}/`);
  const integ = prepareIntegration(shell, { noUserRc: opts.noUserRc ?? false, userEnv, dir: path.join(tmp, 'integration') });
  const journal = new Journal();
  const daemonEnv = opts.daemonEnv ?? {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
  };
  delete daemonEnv.ZDOTDIR;
  const so: Parameters<typeof Session.start>[0] = {
    id: 'real',
    owner: AGENT,
    shell,
    cwd: tmp,
    backend: new NodePtyBackend(),
    journal,
    tempDir: tmp,
    daemonEnv,
    env: opts.env ?? {},
    integrationGraceMs: opts.integrationGraceMs ?? 3000,
  };
  if (opts.login !== undefined) so.login = opts.login;
  if (opts.startupCapMs !== undefined) so.startupCapMs = opts.startupCapMs;
  if (opts.cols !== undefined) so.cols = opts.cols;
  if (opts.editingStaleMs !== undefined) so.editingStaleMs = opts.editingStaleMs;
  if (opts.control !== undefined) so.control = opts.control;
  if (opts.commandDir !== undefined) so.commandDir = opts.commandDir;
  if (integ.kind !== 'none') so.integration = integ;
  const t0 = Date.now();
  const session = await Session.start(so);
  const startMs = Date.now() - t0;
  session.attach(AGENT, 'c1');
  return {
    session,
    journal,
    home,
    tmp,
    startMs,
    integrationKey: integ.key,
    async run(line, wait = 5000) {
      const a = await session.admitWhenAvailable({ target: 'shell', line, principal: AGENT }, 3000);
      if (!a.admitted) throw new Error(`not admitted (${a.reason}): ${line}`);
      const r = await session.awaitRun(a.run.runId, wait);
      return { ...r, text: (await session.runTranscript(r.runId)).text };
    },
    async close() {
      await session.close();
      removeDir(tmp);
    },
  };
}

/** Poll until `fn` holds (real shells answer asynchronously). */
export async function until(fn: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`${what} not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const hasShell = (p: string): boolean => fs.existsSync(p);

/** Pids of processes whose command line matches `pattern` (pgrep -f). */
export const pgrep = (pattern: string): number[] => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
export const reap = (pattern: string) => {
  try {
    execFileSync('pkill', ['-9', '-f', pattern]);
  } catch {
    // nothing left
  }
};
