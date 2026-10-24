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
import { until } from './testhost.js';

export { until };

export interface FakeCommandResult {
  output?: string;
  exit?: number;
  /** Resolve later: the test ends the command by calling finishHung(). */
  hang?: boolean;
  /** The line produces no pre-execution mark: output, then a new prompt (no C, no D). */
  noPreexec?: boolean;
  /** The line runs without its E and C marks (a hook that did not print), but its D still comes. */
  noStartMark?: boolean;
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
/** The terminal's mode under a line editor at its prompt (bash's readline, zsh's zle, fish), and under a program or a `read` waiting for a line. */
export const EDITOR_MODE = { canonical: false, echo: false };
export const COOKED_MODE = { canonical: true, echo: true };
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
  /** Stopped (SIGSTOP): a ^C is not acted on until cont(), as a shell not yet scheduled does not. */
  private stopped = false;
  private interruptPending = false;
  private held = '';
  /** Typeahead, in arrival order, read after the running command ends. */
  private queued = '';
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
    // At its prompt the line editor holds the terminal (a shell without marks here stands for dash, which
    // has none), and nothing else reads it: what the cancel's checks read before typing its empty line.
    this.pty.mode = this.marks === 'none' ? COOKED_MODE : EDITOR_MODE;
    this.pty.reader = false;
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

  /** SIGSTOP: input waits, and a ^C flushes it but is acted on only at cont() (a shell descheduled under load). */
  stop(): void {
    this.paused = true;
    this.stopped = true;
  }

  /** SIGCONT: a ^C that came while stopped is acted on first — a new prompt, or nothing (quietEmptyInterrupt) — then the input. */
  cont(): void {
    this.stopped = false;
    if (this.interruptPending) {
      this.interruptPending = false;
      if (!this.opts.quietEmptyInterrupt) {
        this.pty.emit('^C\r\n');
        this.prompt();
      }
    }
    this.resume();
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
          // The tty driver flushes unread input on SIGINT; the line editor redraws — or, like fish
          // at an empty line, prints nothing at all (quietEmptyInterrupt), so no prompt mark follows.
          this.held = '';
          this.buf = '';
          if (this.stopped) {
            this.interruptPending = true;
            continue;
          }
          if (this.opts.quietEmptyInterrupt) continue;
          this.pty.emit('^C\r\n');
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
    let startMark = '';
    if (src && src[1] !== undefined) {
      const file = src[1].replace(/'\\''/g, "'");
      tail = src[2] ?? '';
      try {
        // The daemon ends a command file with a line capturing the pipeline's statuses (shell tools 3);
        // a real shell runs it and returns with the command's status. The fake drops it and runs the text.
        // Under the marker strategy the file begins with a line printing the Run's start mark
        // (plumbing.ts markerStartLine): the fake prints the mark, as a shell running the file does.
        const text = fs.readFileSync(file, 'utf8');
        const start = /^.*printf '<<<STAR''T:%s:%s>>>\\n' ([0-9a-f]+) .*\n/.exec(text);
        if (start) startMark = `<<<START:${start[1]}:${this.pty.pid}>>>\r\n`;
        line = (start ? text.slice(start[0].length) : text)
          .replace(/\n\n(?:__tsm_st=\$\? __tsm_ps=.*; return \$__tsm_st|set -g __tsm_pst \$pipestatus \$status; __tsm_setst .*)\n$/, '\n')
          .replace(/\n$/, '');
      } catch {
        // As a real shell does when the file is gone (the session removed it on close or cancel).
        line = `echo "${file}: No such file or directory"; false`;
      }
    } else {
      // The marker strategy's end-marker probe: a marker of its own (the house's read of a6d0c35, #22),
      // printf-built (plumbing.ts markerProbe).
      const probe = /^\s*(?:\{ )?printf '%s:%s>>>\\n' "<<<PRO""BE:([0-9a-f]+)" (?:"\$\(exec \/bin\/sh -c 'echo \$PPID'\)"|"\$\$"|\$fish_pid)(?:; \} 2>\/dev\/null)?$/.exec(typedLine);
      if (probe) {
        this.pty.emit(`<<<PROBE:${probe[1]}:${this.pty.pid}>>>\r\n`);
        this.prompt();
        return;
      }
      if (typedLine.trim() === '') {
        this.prompt();
        return;
      }
    }
    if (startMark) this.pty.emit(startMark);
    this.executed.push(line);
    // The editor gave the terminal back to cooked mode for the command, until the next prompt.
    this.pty.mode = COOKED_MODE;
    const h = this.handlers.find((x) => (typeof x.match === 'string' ? x.match === line : x.match.test(line)));
    const result: FakeCommandResult = h ? h.handler(line, this) : line.trim() === '' ? { exit: 0 } : { output: `fake: ${line.split(' ')[0]}: command not found\r\n`, exit: 127 };
    if (result.noPreexec) {
      if (result.output) this.pty.emit(result.output);
      this.prompt();
      return;
    }
    if (this.marks === 'rich' && !result.noStartMark) this.pty.emit(this.mark(`633;E;${encodeVscodeValue(typedLine)}`) + this.mark('133;C'));
    const finish = (exit: number, output?: string, withPrompt = true) => {
      if (this.running === undefined) return;
      const aborted = this.running.aborted === true;
      this.running = undefined;
      this.hung = undefined;
      this.pty.foregroundPgid = this.pty.pid;
      if (output) this.pty.emit(output);
      // The marker tail (`; { printf '%s:%s>>>\n' "<<<EXI""T:nonce" "$?"; } 2>/dev/null`) executes
      // after the sourced file, unless an interrupt aborted the rest of the line (dash).
      const m = /printf '%s:%s>>>\\n' "<<<EXI""T:([0-9a-f]+)" (?:"\$\?"|\$status)/.exec(tail);
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
      this.pty.reader = true; // the job, in the foreground, can read the terminal
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

// ───────────── a scripted backend of fake shells, and a scripted session harness, shared by the specs ─────────────

/**
 * The scripted PTY only records kills; a real shell ends on SIGHUP and SIGKILL, so the fake does too:
 * at once, or on a microtask (`deferred`), as a real PTY's exit arrives after the kill returned.
 */
export function endOnHangup(p: ScriptedPty, deferred = false): void {
  const kill = p.kill.bind(p);
  p.kill = (sig) => {
    kill(sig);
    if (sig !== 'SIGHUP' && sig !== 'SIGKILL') return;
    const exit = () => p.exit({ exitCode: null, signal: sig });
    if (deferred) queueMicrotask(exit);
    else exit();
  };
}

/**
 * A scripted backend whose shells are FakeShells that end on hangup; `setup` scripts each shell's
 * commands (and may keep it). The one wiring for the specs that drive a registry, a server or the
 * CLI over the scripted backend; `scriptedSession` below adds the usual handlers for one Session.
 */
export function fakeShellBackend(setup?: (shell: FakeShell, pty: ScriptedPty) => void, opts: FakeShellOptions & { exitDeferred?: boolean } = {}): ScriptedBackend {
  const { exitDeferred, ...shellOpts } = opts;
  const backend = new ScriptedBackend();
  backend.onSpawnShell = (p) => {
    const shell = new FakeShell(p, shellOpts);
    setup?.(shell, p);
    endOnHangup(p, exitDeferred);
  };
  return backend;
}

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
  promptDrawnWaitMs?: number;
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
    shell.on(/^env -0 >\| '(.*)'$/, (l) => {
      fs.writeFileSync(/^env -0 >\| '(.*)'$/.exec(l)![1]!.replace(/'\\''/g, "'"), 'A=1\0B=two\0');
      return { exit: 0 };
    });
    opts.setup?.(shell);
    endOnHangup(p);
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
  if (opts.promptDrawnWaitMs !== undefined) so.promptDrawnWaitMs = opts.promptDrawnWaitMs;
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
  /** The daemon's other variables. The fixture supplies HOME and XDG directories after these. Defaults to this process's env. */
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
  /** false: start the shell without its integration, so its Runs take the marker strategy. */
  integration?: false;
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
  // In a fresh HOME fish starts its man-page completion generator while it reads its config, in its own
  // process group beside the shell under test: fish 3.7 when `$__fish_user_data_dir/generated_completions`
  // is missing, with the terminal as the generator's input, and fish 4 when `$__fish_cache_dir/
  // generated_completions` is. Its python parsing every man page shared every fish spec's terminal and CPU,
  // and the cancel's reader check took it for a reader. Both dirs are there, as after any earlier fish start.
  for (const d of ['.local/share/fish/generated_completions', '.cache/fish/generated_completions']) fs.mkdirSync(path.join(home, d), { recursive: true });
  for (const [f, body] of Object.entries(opts.rc ?? {})) {
    fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true });
    fs.writeFileSync(path.join(home, f), body);
  }
  const userEnv: NodeJS.ProcessEnv = { HOME: home };
  if (opts.userZdotdir !== undefined) userEnv.ZDOTDIR = opts.userZdotdir.replace(/^~\//, `${home}/`);
  const integ = prepareIntegration(shell, { noUserRc: opts.noUserRc ?? false, userEnv, dir: path.join(tmp, 'integration') });
  const journal = new Journal();
  const daemonEnv: NodeJS.ProcessEnv = {
    ...(opts.daemonEnv ?? process.env),
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
  if (integ.kind !== 'none' && opts.integration !== false) so.integration = integ;
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

export const hasShell = (p: string): boolean => fs.existsSync(p);

/** Pids of processes whose command line matches `pattern` (pgrep -f). No match is `[]`; a pgrep that failed to run is an error, never an absence (the house's read of a6d0c35, #22). */
export const pgrep = (pattern: string): number[] => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean).map(Number);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
};
/**
 * SIGSTOP a shell while it waits for terminal input, not partway through a system call it makes as it draws its
 * prompt. The session counts a shell ready at its prompt's end mark, which it can read before the shell's write of
 * that prompt returns. Stopped in that write, bash took a ^C pending at SIGCONT outside its wait for input, and
 * readline 8.2 then handled it without the event hook that throws bash to a new prompt (rl_getc calls the hook only
 * when the wait itself is interrupted), so it waited for a key. By run on Linux x86_64 with bash 5.2.37 under load,
 * stopped in pselect6 the stopped-shell cancel spec's steps passed 154 times of 154, and the two that stalled were
 * both stopped in write (CI on #22 failed the spec at 9f2952d and 3ad4183). On Linux the shell is stopped, the system call it
 * stopped in is read from /proc and compared with the one it sleeps in while waiting, and it is continued and stopped
 * again until they agree. Elsewhere, with no /proc, it is stopped at once.
 */
export async function stopWhileWaiting(pid: number, attempts = 50): Promise<void> {
  const proc = (f: string): string | undefined => {
    try {
      return fs.readFileSync(`/proc/${pid}/${f}`, 'utf8').trim();
    } catch {
      return undefined;
    }
  };
  const call = () => proc('syscall')?.split(' ')[0];
  if (call() === undefined) {
    process.kill(pid, 'SIGSTOP');
    return;
  }
  // Asleep in the select or poll a line editor waits in. Not wait_woken: a read of the terminal sleeps there, but so
  // does a write to a full one, which is the state this stop must miss (by run on Linux 6.18: `cat` reading and `head`
  // writing a full pty both showed wait_woken; Gideon-2613's read of this helper).
  const waiting = () => /^(do_select|do_sys_poll|poll_schedule_timeout)/.test(proc('wchan') ?? '');
  for (let i = 0; i < attempts; i++) {
    await until(waiting, 5000, 'the shell to wait for input');
    const waitsIn = call();
    process.kill(pid, 'SIGSTOP');
    await until(() => /^T/.test(proc('stat')?.split(') ')[1] ?? ''), 2000, 'the shell to stop');
    // On arm64 a stopped task's syscall file reads -1 whatever call the stop interrupted (by run on Linux 6.8,
    // aarch64: 72, pselect6, before the stop; -1 after), so there the reading before the stop is all there is and
    // the race stays open, as without /proc. Elsewhere -1 is a task stopped outside a call, which this stop must miss.
    const after = call();
    if (waitsIn !== undefined && waitsIn !== 'running' && (after === waitsIn || (after === '-1' && process.arch === 'arm64'))) return;
    process.kill(pid, 'SIGCONT');
  }
  throw new Error(`the shell was never stopped in its wait for input in ${attempts} attempts`);
}
export const reap = (pattern: string) => {
  try {
    execFileSync('pkill', ['-9', '-f', pattern]);
  } catch {
    // nothing left
  }
};
