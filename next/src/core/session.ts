/**
 * Session: a persistent environment — one shell in one terminal — with a journal,
 * a screen, Runs, Attachments, a controller seat, and per-principal cursors.
 * This file is where the guarantees of DESIGN.md §5 are enforced; each rule is
 * cited where it bites.
 *
 * Marks are evidence only when they carry the session's key (marks.ts): a second
 * integration in the user's rc, a nested shell, or a program printing OSC 133 can
 * neither start, end nor attribute a Run, nor move the cwd.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExecutionBackend, ProcessHandle, PtyExit, PtyHandle } from '../backends/types.js';
import { configuredEnv, historyIsolationEnv, parseEnvNul, redactSnapshot, type EnvSnapshot } from './env.js';
import { err } from './errors.js';
import type { Journal } from './journal.js';
import { livingGroups } from './lock.js';
import { clocks, timerMs } from './clock.js';
import { CLEAR_LINE_KEYS, MarksParser, type Mark } from './marks.js';
import { Screen } from './screen.js';
import { pageOutput, type RunOutput, type RunOutputRange } from './runindex.js';
import { commandFile, cutPlumbing, exitMark, inlineProbe, markerCommandText, markerProbe, probeMark, shellQuote, sourceLine, startMark, type ShellFlavor } from './plumbing.js';
import { stripEscapes } from './text.js';
import { project, runChunks } from './transcript.js';
import { type AttachmentRole, type ControlPolicy, type Cursors, DEFAULT_GEOMETRY, type EnvBasis, type EventOf, type IntegrationLevel, type JournalEvent, type Principal, type RunInfo, type RunOrigin, type RunState, type RunTarget, type ScreenSnapshot, type Seq, type ShellState, SYSTEM, type Visibility } from './types.js';

export type { RunInfo } from './types.js';

export interface SessionOptions {
  id: string;
  owner: Principal;
  visibility?: Visibility;
  control?: ControlPolicy | 'open';
  shell: string;
  shellArgs?: string[];
  cwd: string;
  env?: Record<string, string>;
  daemonEnv?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  backend: ExecutionBackend;
  journal: Journal;
  /**
   * Integration setup from `prepareIntegration`; omit for none. The mark key never enters the
   * shell's environment: it reaches the backend out of band (`bootstrap`), and the launcher
   * writes it to a private file the integration reads. Without a key one is generated.
   */
  integration?: { args: string[]; env: Record<string, string>; key?: string; launcher?: string };
  /** How long to wait for the integration's handshake before declaring `none` (G5). */
  integrationGraceMs?: number;
  /** After the handshake, how long `start` waits for the first prompt at most (it then resolves in `starting`). */
  startupCapMs?: number;
  /** Linux: the shell's and process Runs' oom_score_adj (0 or unset: unchanged); see the daemon's --session-oom-score-adj. */
  oomScoreAdj?: number;
  /** Temp files and the session's own shell history live here. */
  tempDir?: string;
  /** Where the command files the daemon sources live (default tempDir); keep it short, it is echoed at the prompt. */
  commandDir?: string;
  /** Start the shell as a login shell: bash emulates it, zsh and fish get `-l` (default true). */
  login?: boolean;
  /** How long the seat stays reserved for a holder whose last attachment went away (default 30 s). */
  seatGraceMs?: number;
  /** A partial line typed at the prompt stops blocking shell Runs after this long without input (default 30 s). */
  editingStaleMs?: number;
  /** Cursors carried over from an earlier life or a restart (G22): the registry persists them. */
  cursors?: Record<Principal, Cursors>;
  /** Called when a principal's cursor advances (cheap and synchronous; the registry debounces its writes). */
  onCursors?: (principal: Principal, cursors: Cursors) => void;
}

export interface Attachment {
  attachmentId: string;
  principal: Principal;
  role: AttachmentRole;
  connectionId: string;
}

export interface AdmitOptions {
  target: RunTarget;
  line?: string;
  argv?: string[];
  principal: Principal;
  origin?: RunOrigin;
  queue?: boolean;
  envBasis?: EnvBasis;
  /** Skip the seat check (the daemon's own internal runs). */
  internal?: boolean;
  /** Recorded on the Run and its run.admit event (G16); opaque to the session. */
  idem?: string;
  /** The caller acts with the owner's seat rights (the owner's own GUI human, §12); the application layer decides. */
  asOwner?: boolean;
}

/**
 * A declared shell (§8.1): the caller said the program in front of the terminal is a shell of
 * this kind — the remote end of `ssh`, a `sudo -i`, a nested shell, or what replaced the
 * session's shell — and shell Runs go to it until the Run whose program it is ends.
 */
export interface DeclaredShell {
  shell: string;
  /** The Run whose program is the shell; null for the program that replaced the session's shell. */
  within: string | null;
  by: Principal;
  at: number;
}

export interface DeclareOptions {
  /** The kind of shell in front: `sh` (default; bash, zsh, dash and ksh are typed the same), `fish`, or `none` to take the last declaration back. */
  shell?: string;
  /** The Run whose program is the shell. Default: the innermost running Run (the one holding the terminal). */
  within?: string;
  principal: Principal;
  asOwner?: boolean;
}

/** Seat-checked operations accept the owner's rights for a principal the application layer vouches for (tsg-13, atc-12). */
export interface SeatOptions {
  asOwner?: boolean;
}

export type BusyReason = 'running' | 'prompt-pending' | 'cancel-unanswered' | 'human-editing' | 'human-submitted' | 'starting' | 'shell-unavailable' | 'exited' | 'declared-shell-ended';
export type AdmitResult = { admitted: true; run: RunInfo } | { admitted: false; busy: RunInfo | null; reason: BusyReason };

export interface CancelResult {
  runId: string;
  state: RunState;
  contract: 'process' | 'shell';
  /** Present when the Run survived every step of the contract (shell target only): what to do next (`cancel <runId>` names the enclosing Run of a declared shell). */
  escalation?: 'session_close' | `cancel ${string}`;
  /** What the daemon did, in order (e.g. `^C`, `^\`, `SIGTERM → foreground process group 4242`). */
  steps: string[];
}

export interface SessionInfo {
  id: string;
  owner: Principal;
  visibility: Visibility;
  control: ControlPolicy | 'open';
  controller: Principal | null;
  state: ShellState | 'tui';
  integration: IntegrationLevel;
  cwd: string;
  cols: number;
  rows: number;
  backend: string;
  pid: number;
  createdAt: number;
  lastActivity: number;
  currentRun: string | null;
  queued: number;
  attachments: number;
  lastSeq: Seq;
  /** The innermost declared shell (§8.1), where shell Runs go now; absent when they go to the session's own shell. */
  declared?: { shell: string; within: string | null };
  /** While the seat holder is disconnected, when its reservation lapses (epoch ms). */
  seatReservedUntil?: number;
}

/** The principal of a command typed when nobody's input is on record. */
export const UNKNOWN_TYPER: Principal = 'human:unknown';

interface RunRecord extends RunInfo {
  waiters: Array<(r: RunInfo) => void>;
  /**
   * The monotonic clock at admission, for the ages this daemon life measures (see `runAgeMs`); never
   * journaled. Every RunRecord is this life's (newRun is the one constructor; another life's Runs are
   * the journal's RunInfo, never held here), so it always has one (the house's read of the 33 commits,
   * #22 comment 6307351617, item 6).
   */
  admittedMono: number;
  /** The monotonic clock at the Run's start, which its journaled duration is measured from (likewise never journaled). */
  startedMono?: number;
  /** Called on any state change (start or end). */
  changeWaiters?: Array<() => void>;
  process?: ProcessHandle;
  markerNonce?: string;
  /** Which launch strategy issued this shell Run (transcript hygiene differs). `inline`: a declared shell's Run (§8.1). */
  strategy?: 'rich' | 'basic' | 'marker' | 'inline';
  /** Inline strategy: the lines still to type, one per acknowledgement; and how many pieces were acknowledged. */
  inlineLines?: string[];
  inlineAck?: number;
  tempFile?: string;
  /** The exact line typed for a daemon-issued shell Run (trimmed): what its 633;E must say. */
  execLine?: string;
  cancelRequested?: boolean;
  /** Output positions seen so far for marker-strategy scanning. */
  markerTail?: string;
  /** Whether the end-marker probe was typed (marker and inline strategies, after an aborting ^C). */
  probed?: boolean;
  /** The reason a process Run ends with when the daemon tears it down (close, shell exit). */
  endReason?: string;
  /** Order of the daemon's write of this Run's line among everything typed into the terminal. */
  writeOrder?: number;
  /** Prompt starts a pending Run survives: lines typed ahead of it ran first (ss-1). */
  survivePrompts?: number;
  /** A new shell announced itself while this Run was in flight (`exec`, ss-4). */
  replaced?: boolean;
  /** Output of the process group after the Run's end was noted once (ss-10). */
  lingerNoted?: boolean;
}

/** How much of a Run's newest output a transcript reads and projects. */
const TRANSCRIPT_INPUT_CHARS = 4 * 1024 * 1024;
/** Daemon lines remembered after their Run was declared lost before it started. */
const MAX_ORPHAN_LINES = 32;
/**
 * How long a prompt waits for the pre-execution mark of the empty line a cancel typed (askForPrompt). A
 * line still queued in the tty is read as soon as the prompt is drawn, so past this the line is taken as
 * lost (a later ^C flushed it, or a program read it) and the shell as back at that prompt. Counting
 * prompts instead never ended the wait when no further prompt came (the house's review of the 40 commits
 * through f3750e4, PR #22 comment 6310921374, question 1). A late run of the line is still known by its
 * file (probeLine), and a Run written behind it waits for it.
 */
const PROMPT_PROBE_GRACE_MS = 300;
/**
 * For a shell whose prompts carry an end mark, the empty line's grace runs from that mark, once PS1 is
 * drawn; from the start mark it waits this long for it. A prompt that has stopped carrying the end mark
 * (bash's `shopt -u promptvars` after the first prompts leaves PS1's mark unexpanded) is still given up,
 * and a PS1 slower than this to draw is given up at this bound, as at the start mark before (the house's
 * review of the 40 commits through 4f4c067).
 */
const PROMPT_DRAWN_WAIT_MS = 3000;
/**
 * How often, and how far apart, the terminal's mode is read before a cancel types its empty line: one
 * read just after the ^C varied in the same case, raw once and canonical once (question 1).
 */
const EDITOR_SETTLE_READS = 4;
const EDITOR_SETTLE_STEP_MS = 50;
/** The newest replies to the shell's terminal queries kept for resendReplies. */
const REPLIES_KEPT = 8;
/** What a note says when the reinit gate after `exec bash` gives up: the recovery that loads the integration with the session's key. */
const REINIT_RECOVERY = 'Shell commands are unavailable until it loads: once the shell shows its own prompt, send ` . "$TSM_BASH_RC" reinit typed` with input to load it, or open a new session';
const publicRun = (r: RunRecord): RunInfo => {
  const { waiters: _w, changeWaiters: _cw, process: _p, markerNonce: _n, inlineLines: _il, inlineAck: _ia, tempFile: _t, execLine: _x, cancelRequested: _c, markerTail: _m, probed: _pr, endReason: _e, writeOrder: _wo, survivePrompts: _sp, replaced: _rp, lingerNoted: _ln, admittedMono: _am, startedMono: _sm, ...info } = r;
  return { ...info, seq: { ...info.seq } };
};

/**
 * The inline strategy (§8.1): a Run for a shell the daemon has no marks from — the remote end
 * of `ssh`, a `sudo -i`, a nested shell, the program that replaced the session's shell — whose
 * filesystem may not be ours, so the text travels on the typed line itself. Bytes outside this
 * set go as `printf '%b'` octal escapes: the typed line then holds nothing a line editor
 * expands or completes (no `!`, no tab, no quote the body could close), and each line stays
 * under what any tty line discipline accepts (1024 bytes in canonical mode on macOS). A long
 * body goes in pieces, each acknowledged by the shell before the next is typed, so nothing
 * piles up unread; the last line prints a start marker naming the shell's pid, runs the text
 * with `eval` in the shell itself (so `cd` and exports persist), and prints the end marker with
 * the status. A cancel's probe prints a marker of its own with the pid of the shell that ran
 * it: only the shell the Run was typed into can answer for the Run (see applyInlineMarker).
 *
 * Every line checks, before it prints any marker, that the variable holds exactly as many
 * characters as the lines so far typed, and prints a gone marker otherwise. Text already at
 * the prompt when the first line arrives (a person's half-typed command in a shared
 * terminal) would otherwise swallow the assignment while the markers after it still ran,
 * and the Run would report `exited 0` for a command that never ran (an outside review
 * reproduced it). The first line is preceded by ^U, which clears what precedes the cursor
 * (the whole line at its end); the check is what stands when that is not enough.
 */
const INLINE_SAFE = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,._/:=@+-'].map((c) => c.charCodeAt(0)));
const INLINE_LINE_BYTES = 900;
/** Ended Runs a session keeps in memory; older ones are read from the journal's run index. */
const MAX_ENDED_RUNS = 1000;
/**
 * How long a prompt waits for the echo of keys typed during the last Run before the queue
 * drains (see onPromptStart): the line editor shows them in the same breath as the prompt.
 */
const TYPEAHEAD_GRACE_MS = 150;
/**
 * Keys that empty a line editor without our integration's bindings: ^E (end of line in the emacs
 * keymaps of readline, zsh and fish; a plain character to a canonical-mode reader) then ^U (kill
 * to the beginning; the tty's line kill in canonical mode, which takes the ^E with the rest).
 */
const CLEAR_WHOLE_LINE = '\x05\x15';

/**
 * Does `text` open a heredoc (`<<WORD`, `<<-WORD`; never `<<<`) that no later line closes? Read
 * as the shell reads it (the house's read of a6d0c35, #22): the delimiter is the whole word up to
 * the next unquoted metacharacter with its quotes removed (`<<123`, `<<EOF.txt`, `<<"E"OF` all
 * count, and `EOF` does not close `EOF.txt`), the bodies follow the line's unquoted newline in
 * order and are never scanned (a `<<` inside one is text), and an operator inside quotes, a
 * comment or arithmetic is not one. A reading the shell would refuse (an empty delimiter) counts as
 * open: the text then simply gets no capture line.
 */
export function hasOpenHeredoc(text: string): boolean {
  const pending: Array<{ word: string; strip: boolean }> = [];
  const meta = (c: string | undefined) => c === undefined || ' \t\n|&;()<>'.includes(c);
  let quote: "'" | '"' | undefined;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      i++;
    } else if (c === '\\') {
      i += 2;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      i++;
    } else if (c === '#' && (i === 0 || ' \t\n|&;()'.includes(text[i - 1]!))) {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '(' && text[i + 1] === '(' && (text[i - 1] === '$' || i === 0 || ' \t\n|&;'.includes(text[i - 1]!))) {
      // `$(( … ))` and `(( … ))`: a `<<` there is a shift.
      let depth = 0;
      do {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      } while (i < text.length && depth > 0);
    } else if (c === '\n') {
      i++;
      for (const h of pending.splice(0)) {
        for (;;) {
          if (i >= text.length) return true;
          const nl = text.indexOf('\n', i);
          const line = text.slice(i, nl === -1 ? text.length : nl);
          i = nl === -1 ? text.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.word) break;
        }
      }
    } else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      i += 2;
      const strip = text[i] === '-';
      if (strip) i++;
      while (text[i] === ' ' || text[i] === '\t') i++;
      let word = '';
      let q: "'" | '"' | undefined;
      while (i < text.length && (q !== undefined || !meta(text[i]))) {
        const d = text[i]!;
        if (q === undefined && (d === "'" || d === '"')) q = d;
        else if (q === d) q = undefined;
        else if (d === '\\' && q !== "'" && i + 1 < text.length) word += text[++i];
        else word += d;
        i++;
      }
      if (word === '') return true;
      pending.push({ word, strip });
    } else {
      i++;
    }
  }
  return pending.length > 0;
}
/** After a line submitted at a declared prompt, how long the shell's own group in front must stand before it means the command ended (the shell may not have forked it yet). */
const FOREGROUND_SETTLE_MS = 200;
/** How often a declared Run held behind a submitted line looks again (no event ends such a hold). */
const DECLARED_RECHECK_MS = 250;

function inlineTokens(body: string): string[] {
  const out: string[] = [];
  for (const b of Buffer.from(body, 'utf8')) out.push(INLINE_SAFE.has(b) ? String.fromCharCode(b) : `\\0${b.toString(8).padStart(3, '0')}`);
  return out;
}

/**
 * The lines to type for `body`, bounded by markers carrying `nonce`: pieces end in an
 * acknowledgement, the last line in start and end markers, and every line prints its marker
 * only where the variable holds the text typed so far, `len` characters (the text is ASCII,
 * so every shell counts alike), and the gone marker otherwise (see the module comment).
 */
export function inlineLines(body: string, nonce: string, fish: boolean): string[] {
  const toks = inlineTokens(body);
  const gone = `printf '<<<GON''E:${nonce}>>>\\n'`;
  const set = fish ? (c: string) => ` set -g __tsm_b '${c}'` : (c: string) => ` __tsm_b='${c}'`;
  const add = fish ? (c: string) => ` set -g __tsm_b "$__tsm_b"'${c}'` : (c: string) => ` __tsm_b=\${__tsm_b-}'${c}'`;
  // `then` … `else` … `fi` around what a line does once the text so far is whole.
  const whole = fish
    ? (len: number, then: string) => `if set -q __tsm_b; and test (string length -- "$__tsm_b") = ${len}; ${then}; else; ${gone}; end`
    : (len: number, then: string) => `if [ "\${__tsm_b+set}" = set ] && [ "\${#__tsm_b}" = "${len}" ]; then ${then}; else ${gone}; fi`;
  const ack = (k: number) => `printf '<<<AC''K:${nonce}:${k}>>>\\n'`;
  // The shell that prints the start marker first sets the token the cancel probe prints (see
  // plumbing.ts's inlineProbe): an unexported variable, so a nested shell has none of it.
  const finish = fish
    ? `set -g __tsm_r ${nonce}; printf '<<<STAR''T:${nonce}:%s>>>\\n' $fish_pid; eval (printf '%b' "$__tsm_b" | string collect); printf '<<<EXI''T:${nonce}:%s>>>\\n' $status`
    : `__tsm_r=${nonce}; printf '<<<STAR''T:${nonce}:%s>>>\\n' "$$"; eval "$(printf '%b' "$__tsm_b")"; printf '<<<EXI''T:${nonce}:%s>>>\\n' "$?"`;
  const forget = fish ? 'set -e __tsm_b' : 'unset __tsm_b';
  const all = toks.join('');
  const single = `${set(all)}; ${whole(all.length, finish)}; ${forget}`;
  if (Buffer.byteLength(single) <= INLINE_LINE_BYTES) return [single];
  const room = INLINE_LINE_BYTES - `${add('')}; ${whole(999999, ack(999))}`.length;
  const pieces: string[] = [];
  let cur = '';
  for (const t of toks) {
    if (cur.length + t.length > room) {
      pieces.push(cur);
      cur = '';
    }
    cur += t;
  }
  pieces.push(cur);
  let typed = 0;
  const lines = pieces.map((c, i) => {
    typed += c.length;
    return `${i === 0 ? set(c) : add(c)}; ${whole(typed, ack(i + 1))}`;
  });
  return [...lines, ` ${whole(typed, finish)}; ${forget}`];
}

type InlineMarkerKind = 'ack' | 'start' | 'exit' | 'gone' | 'probe';
/** A declared shell's marker found in the output: which Run's, which kind, where the piece carrying it ends, and what it printed. */
interface InlineHit {
  run: RunRecord;
  kind: InlineMarkerKind;
  end: number;
  value?: number;
  token?: string;
}

/** The caller's name for the shell in front → the syntax the inline strategy types. */
function declaredFlavor(name: string): 'posix' | 'fish' {
  const base = path.basename(name.trim()).replace(/^-/, '');
  if (base === 'fish') return 'fish';
  if (/^(sh|bash|zsh|dash|ash|ksh|mksh|busybox|posix)$/.test(base)) return 'posix';
  throw err('invalid_argument', `shell: "${name}" is not a shell the daemon can type for (sh, bash, zsh, dash, ash, ksh, fish)`, { shell: name });
}

type OutputEvent = EventOf<'output'>;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The position of whichever of `needles` comes first in `text`; -1 when none does. */
/**
 * Create a command file that did not exist, never through a symlink (jr2-3). The directory
 * was checked to be ours, so an existing name is a file an earlier life of this session left
 * behind (the counter restarts): it is removed and the file created afresh.
 */
function writeExclusive(file: string, text: string): string {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(file, flags, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    fs.unlinkSync(file);
    fd = fs.openSync(file, flags, 0o600);
  }
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}
const errMessage = (e: unknown) => {
  const x = e as NodeJS.ErrnoException;
  return x && typeof x === 'object' && 'message' in x ? `${x.code ? `${x.code} ` : ''}${x.message}` : String(e);
};

/** Signals typed as control characters: the terminal delivers them to the foreground job. */
const CONTROL_CHARS: Record<string, string> = { SIGINT: '\x03', SIGTSTP: '\x1a', SIGQUIT: '\x1c' };

function normalizeSignal(signal: unknown): NodeJS.Signals {
  if (typeof signal !== 'string' || signal.trim() === '') throw err('invalid_argument', 'signal needs a signal name, e.g. SIGINT');
  let name = signal.trim().toUpperCase();
  if (!name.startsWith('SIG')) name = `SIG${name}`;
  if (!Object.prototype.hasOwnProperty.call(os.constants.signals, name)) throw err('invalid_argument', `unknown signal ${signal}`, { signal });
  return name as NodeJS.Signals;
}

/**
 * The flavor of a shell path or command line (`-zsh` for a login shell, `/bin/bash --rcfile …`).
 * An unrecognised shell is POSIX here, on purpose, and not refused the way `declaredFlavor` refuses
 * an unknown declared name (the house's read, #22 comment 6264958172): this is the session's own
 * shell, chosen when the session was opened, and all it decides is how a daemon line is sourced — by
 * `.`, which every POSIX shell has — whereas a declared name decides inline syntax typed into a
 * foreign shell, where a wrong guess is worse than a clear refusal.
 */
function flavorOf(command: string | undefined): ShellFlavor {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? '';
  const base = path.basename(first).replace(/^-/, '');
  return base === 'fish' ? 'fish' : base === 'zsh' ? 'zsh' : 'posix';
}

/**
 * m2-2: the line at the cursor asks for a secret (sudo, ssh, gpg, git, database and
 * package-manager logins, `read -s -p "Password: "`). Evidence for redacting what is typed
 * next; measured against realistic prompts in session-round2.spec.
 */
const SECRET_PROMPT =
  /(?:pass(?:word|phrase|code)|\bpins?\b|\bsecrets?\b|\btokens?\b|\botp\b|one[- ]time (?:password|code)|verification code|auth(?:entication)? code|\bapi[ _-]?key\b|\baccess key\b)[^\n]*:\s*$/i;

export const looksLikeSecretPrompt = (textBeforeCursor: string): boolean => SECRET_PROMPT.test(textBeforeCursor);


export class Session {
  readonly id: string;
  readonly owner: Principal;
  readonly visibility: Visibility;
  readonly control: ControlPolicy | 'open';
  readonly journal: Journal;
  readonly screen: Screen;
  readonly createdAt: number;
  lastActivity: number;
  /**
   * The monotonic-clock reading of the last activity (output or input), beside `lastActivity`'s
   * wall-clock timestamp: the editing/submitted holds measure their quiet from this, so a wall-clock
   * step neither ends a hold early nor stretches it (the house's read, #22 comment 6269901528).
   */
  private lastActivityMono: number;

  private readonly opts: SessionOptions;
  /** Wall-clock `Date.now`: journal timestamps and the reported `lastActivity`/seat deadline only — never an interval (the house's read, #22 comment 6269901528). Intervals use `clocks.monotonic()`. */
  private readonly now = Date.now;
  private readonly backend: ExecutionBackend;
  private pty!: PtyHandle;
  /** The key marks must carry; retired when it leaked to a program that is not our shell (ss-4). */
  private markKey: string;
  private readonly marks: MarksParser;
  private flavor: ShellFlavor;
  private readonly safeId: string;
  private readonly histFile: string;
  private shellState: ShellState = 'starting';
  private integrationLevel: IntegrationLevel = 'unknown';
  private cwdPath: string;
  private sawHello = false;
  /** The shell's command line when the handshake arrived or `none` was declared (a later difference means it exec'd). */
  private helloCommand: string | undefined;
  private sawPromptStart = false;
  private sawPromptEnd = false;
  /** This shell's prompts carry an end mark (a B was seen): the empty line's grace then runs from it. */
  private promptsCarryEnd = false;
  /** An `exec` in the Run in flight may replace the shell: its command line is watched (ss-4). */
  private execWatch: { run: RunRecord; timer: NodeJS.Timeout } | undefined;
  /** Order of everything typed into the terminal: principals' lines and the daemon's (ss-1). */
  private writeOrder = 0;
  /** Printable text typed while a Run was in flight, since its last Enter: read by the line editor at the next prompt unless the program took it. */
  private typeahead = '';
  /** Lines submitted while a Run was in flight, in write order: they may run ahead of a daemon line (ss-1). */
  private typeaheadLines: Array<{ line: string; order: number }> = [];
  /** Typeahead to look for in the editor's echo at the prompt; seen, it makes the line human editing (G4, ss-1). */
  private typeaheadWatch: string | undefined;
  /** Runs from the prompt start until the typeahead's echo arrives or TYPEAHEAD_GRACE_MS pass without it (see onPromptStart). */
  private typeaheadTimer: NodeJS.Timeout | undefined;
  private idleEcho = '';
  /** A secret prompt is being answered: keystrokes are journaled redacted until Enter (m2-2). */
  private secretInput = false;
  /** The end of the latest terminal output (what a program waiting for input printed last). */
  private outputTail = '';
  private humanEditing = false;
  /** When the partial line was last edited, on the monotonic clock (a wall-clock step must not move the stale period). */
  private editedAt = 0;
  /** A principal submitted a line at the prompt (Enter / ^C): the shell answers with C or A. */
  private submittedAt: number | undefined;
  /** A partial line went stale in the editor: the next daemon line clears it first. */
  private staleLine = false;
  private sensitiveSinceCommand = false;
  private lastCommandLine: string | undefined;
  /** The principal whose keystrokes most recently reached the terminal (attribution of typed commands). */
  private lastTyper: Principal | undefined;
  /**
   * How many more prompt starts `lastTyper` survives without a C: none for a line
   * typed at the prompt (the shell answers it with C, or with A for an empty line),
   * one for keystrokes sent while a command ran (typeahead is read after its prompt).
   */
  private typerPrompts = 0;
  /**
   * This life's Runs, in admission order, bounded (see pruneRuns): ended Runs beyond
   * MAX_ENDED_RUNS live on in the journal's run index, which the registry reads for a Run the
   * session no longer holds. Unbounded, a session that ran process Runs all day grew by their
   * handles and slowed every listing (the house's review of #11, core finding 3: 10,000 Runs
   * took 449 MiB and 35 ms per `session_list`).
   */
  private readonly runs = new Map<string, RunRecord>();
  private currentShellRun: RunRecord | undefined;
  private pendingShellRun: RunRecord | undefined;
  /** Daemon lines whose Run ended before its C: a later C with that line is their late execution. */
  private readonly orphanLines = new Map<string, RunRecord>();
  /**
   * After a cancel whose two ^C drew no mark (askForPrompt): the empty line it typed to learn when the
   * shell is back — its file, or none when nothing was typed — whether that line's pre-execution mark
   * came (the mark's line holds the file's quoted path), and whether a prompt came since. The shell is
   * busy until the prompt after the mark, or with nothing typed until its next prompt; a prompt that is
   * not followed by the mark within PROMPT_PROBE_GRACE_MS (promptProbeTimer) frees it too, the line lost.
   */
  private promptProbe: { path: string | undefined; started: boolean; prompted: boolean } | undefined;
  private promptProbeTimer: NodeJS.Timeout | undefined;
  /**
   * The last empty line's quoted file and its place in the write order: its start after the session gave
   * up on it is not a person's command, and a Run written after it waits behind it (onPreExec).
   */
  private probeLine: { file: string; order: number } | undefined;
  /** The replies the screen wrote to the shell's terminal queries since its last prompt start, the newest REPLIES_KEPT (resendReplies). */
  private replies: string[] = [];
  private readonly queue: RunRecord[] = [];
  /**
   * Declared shells (§8.1): the Run in flight in front of each program — keyed by the Run whose
   * program it is (null: what replaced the session's shell) — and the Runs queued behind them.
   */
  private readonly inFront = new Map<string | null, RunRecord>();
  private readonly declaredQueue: RunRecord[] = [];
  /** Declared shells, innermost last: shell Runs go to the last one (§8.1). A layer ends with the Run whose program it is. */
  private readonly layers: DeclaredShell[] = [];
  /** A declared shell ended without its caller's word (§8.1, fail closed): the next shell Run is refused once, so a line meant for it does not run in the shell underneath. */
  private declaredEnded: { shell: string; within: string; how: string } | undefined;
  /** Per declared layer (by `within`): the terminal's foreground group when that shell is at its prompt, and whether another group was ever seen in front there, which proves the shell runs on this terminal (see declaredForeground). */
  private readonly declaredFg = new Map<string | null, { own: number; proven: boolean }>();
  private fgRead: { at: number; pgid: number | undefined } | undefined;
  private declaredRecheck: NodeJS.Timeout | undefined;
  /** The end of the terminal output so far (64 chars): a declared shell's marker may straddle two reads. */
  private inlineTail = '';
  private controller: Principal | null = null;
  private seatReserved: { principal: Principal; until: number; timer: NodeJS.Timeout } | undefined;
  private readonly attachments = new Map<string, Attachment>();
  private readonly cursors = new Map<Principal, Cursors>();
  private readonly outcomeDelivered = new Map<string, Set<Principal>>();
  /** Principals whose synchronous `await` on a Run is in flight (G28). */
  private readonly awaiting = new Map<string, Map<Principal, number>>();
  private envSnapshot: EnvSnapshot | undefined;
  private readonly configured: Record<string, string>;
  private exitInfo: PtyExit | undefined;
  private readyResolve!: () => void;
  private readonly readyPromise: Promise<void>;
  private readonly tempDir: string;
  private commandDir: string;
  private readonly extraTempFiles = new Set<string>();
  private tempCounter = 0;
  private runCounter = 0;
  private attachCounter = 0;
  private graceTimer: NodeJS.Timeout | undefined;
  private capTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private editingTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private readonly availabilityWaiters: Array<() => void> = [];
  /** What close waits for: process-group teardowns and command files being removed. */
  private readonly teardowns = new Set<Promise<void>>();
  private closeReason: string | undefined;
  private closing: Promise<void> | undefined;
  /** Set when close() resolves: nothing is journaled after that. */
  private closed = false;

  private constructor(opts: SessionOptions) {
    this.opts = opts;
    for (const [p, c] of Object.entries(opts.cursors ?? {})) this.cursors.set(p, { delivered: c.delivered, read: c.read });
    this.id = opts.id;
    this.owner = opts.owner;
    this.visibility = opts.visibility ?? 'private';
    this.control = opts.control ?? 'seat';
    this.journal = opts.journal;
    this.backend = opts.backend;
    this.cwdPath = opts.cwd;
    this.createdAt = this.now();
    this.lastActivity = this.createdAt;
    this.lastActivityMono = clocks.monotonic();
    this.tempDir = opts.tempDir ?? os.tmpdir();
    this.commandDir = opts.commandDir ?? this.tempDir;
    this.safeId = this.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.histFile = path.join(this.tempDir, `tsm-history-${this.safeId}`);
    this.configured = configuredEnv(opts.daemonEnv ?? process.env, opts.env ?? {});
    this.markKey = opts.integration?.key || randomBytes(16).toString('hex');
    this.marks = new MarksParser(this.markKey);
    this.flavor = flavorOf(opts.shell);
    this.screen = new Screen({ cols: opts.cols ?? DEFAULT_GEOMETRY.cols, rows: opts.rows ?? DEFAULT_GEOMETRY.rows });
    this.readyPromise = new Promise<void>((resolve) => (this.readyResolve = resolve));
  }

  /**
   * Spawn the shell and resolve once integration is known and the shell is available
   * (or declared `none`). After the integration's handshake it waits for the first
   * prompt, at most `startupCapMs` after spawn; it may then resolve in `starting`.
   */
  static async start(opts: SessionOptions): Promise<Session> {
    const s = new Session(opts);
    s.spawn();
    await s.readyPromise;
    return s;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  private spawn(): void {
    // One rule for shells and process Runs (the house's read, #22 comment 6269901528): without bash
    // (or /dev/fd) a shell would inherit — and could write into — other sessions' terminal masters,
    // the same reason process Runs are refused. So a session is not opened at all; it is refused with
    // the same reason, said once at daemon startup too.
    const support = this.backend.processSupport?.();
    if (support && !support.ok) throw err('unsupported', support.reason);
    const kind = path.basename(this.opts.shell);
    const integrated = this.opts.integration !== undefined;
    const login = this.opts.login ?? true;
    // The session's own history, never the user's (G6): a per-session file under tempDir, and
    // history tools the user's rc may load (atuin) pointed at the session's own directory.
    const env: Record<string, string> = { ...this.configured, HISTFILE: this.histFile };
    const given = this.opts.env ?? {};
    const historyDir = path.join(this.tempDir, `tsm-history-${this.safeId}.d`);
    const isolation = historyIsolationEnv(historyDir);
    if (!Object.keys(isolation).some((k) => k in given)) {
      try {
        fs.mkdirSync(historyDir, { mode: 0o700 });
        Object.assign(env, isolation);
      } catch (e) {
        // Without a private directory the tools keep their own configuration.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') Object.assign(env, isolation);
      }
    }
    const args = [...(this.opts.shellArgs ?? [])];
    if (integrated) {
      Object.assign(env, this.opts.integration!.env, { TSM_HISTFILE: this.histFile });
      if (login && kind === 'bash') env.TSM_LOGIN = '1';
      if (login && (kind === 'zsh' || kind === 'fish')) args.push('-l');
      // ss-7: login files (macOS path_helper, fish's login config) and the user's rc reorder
      // PATH; a PATH given at creation is put first again once they ran.
      if (given.PATH !== undefined) env.TSM_SESSION_PATH = given.PATH;
      args.push(...this.opts.integration!.args);
    }
    const launcher = this.opts.integration?.launcher;
    const bootstrap = integrated ? { key: this.markKey, ...(launcher && { launcher }) } : undefined;
    this.pty = this.backend.spawnShell({ shell: this.opts.shell, args, cwd: this.opts.cwd, env, cols: this.screen.cols, rows: this.screen.rows, ...(bootstrap && { bootstrap }), ...(this.opts.oomScoreAdj !== undefined && { oomScoreAdj: this.opts.oomScoreAdj }) });
    this.pty.onData((d) => this.onPtyData(d));
    this.pty.onExit((e) => this.onPtyExit(e));
    // G25: the daemon's emulator is the sole responder to terminal queries.
    this.screen.onReply((reply) => {
      if (this.shellState === 'exited' || this.closed) return;
      this.writeReply(reply);
      this.replies.push(reply);
      if (this.replies.length > REPLIES_KEPT) this.replies.shift();
    });
    this.screen.onMode((alt) => this.append({ type: 'screen.mode', alt }));
    // §6 backpressure: when the daemon's own emulator falls behind, stop reading the PTY until
    // it catches up — never for an observer, which falls behind retention and gets a gap instead.
    this.screen.onPressure((paused) => {
      if (this.closed || this.shellState === 'exited') return;
      if (paused) this.pty.pause?.();
      else this.pty.resume?.();
    });
    this.screen.onTitle((text) => this.append({ type: 'title', text }));
    if (!integrated) {
      this.declareIntegration('none');
      return;
    }
    // G5: no handshake within the grace means no integration; after one, wait for the
    // first prompt, but `start` never waits past the cap.
    const checkStartup = (): void => {
      this.graceTimer = undefined;
      if (this.closed || this.shellState !== 'starting' || this.integrationLevel !== 'unknown') return;
      if (!this.sawHello || this.replacedDuringStartup()) this.declareIntegration('none');
      else {
        // Resolving start at its cap does not end the shell's startup. Its rc may exec
        // later; keep watching until a prompt or replacement supplies actual evidence.
        this.graceTimer = setTimeout(checkStartup, 100);
        this.graceTimer.unref();
      }
    };
    this.graceTimer = setTimeout(checkStartup, this.opts.integrationGraceMs ?? 3000);
    this.capTimer = setTimeout(() => {
      this.capTimer = undefined;
      // Still no prompt: resolve in `starting` (admission answers busy 'starting' until
      // the prompt arrives) — unless the rc replaced the shell (`exec zsh` in a .bashrc),
      // whose prompt carries no marks: shell command admission then remains unavailable.
      if (this.integrationLevel === 'unknown' && this.replacedDuringStartup()) this.declareIntegration('none');
      else this.markReady();
    }, this.opts.startupCapMs ?? 15_000);
  }

  /** Did the shell process exec something else after the integration's handshake (its rc exec'd a shell)? */
  private replacedDuringStartup(): boolean {
    if (this.sawPromptStart || !this.opts.integration) return false;
    const now = this.pty.command?.();
    if (now === undefined) return false;
    if (this.sawHello) {
      if (this.helloCommand === undefined || now === this.helloCommand) return false;
    } else {
      // User/system startup files can exec before our first hello (fish conf.d,
      // for example). Missing integration does not make that replacement a shell.
      const program = path.basename(now.trim().split(/\s+/)[0] ?? '').replace(/^-/, '');
      if (program === path.basename(this.opts.shell).replace(/^-/, '')) return false;
    }
    this.onShellReplaced(now);
    this.markReady();
    return true;
  }

  /** Integration level is observed evidence and only rises: none → basic → rich (G5). */
  private declareIntegration(level: IntegrationLevel): void {
    const rank: Record<IntegrationLevel, number> = { unknown: 0, none: 1, basic: 2, rich: 3 };
    if (rank[level] <= rank[this.integrationLevel]) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.integrationLevel = level;
    this.append({ type: 'integration', level });
    if (level === 'none' && this.shellState === 'starting') {
      // Without marks, availability cannot be observed; the shell is assumed
      // available when no daemon Run is in flight (G5). Give it a moment to
      // print its first prompt so the first line is not typed ahead of it.
      this.settleTimer = setTimeout(() => this.settleNone(), 800);
    }
  }

  private markReady(): void {
    clearTimeout(this.readyTimer);
    clearTimeout(this.capTimer);
    this.readyTimer = this.capTimer = undefined;
    this.ready = true;
    this.readyResolve();
    this.armTypeaheadGrace();
  }

  private settleNone(): void {
    if (this.shellState !== 'starting') return;
    if (this.replacedDuringStartup()) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    // The program at its prompt now (not the spawn's helper): what a later `exec` is told from (ss-4).
    this.helloCommand ??= this.pty.command?.();
    this.shellState = 'idle';
    this.markReady();
    this.notifyAvailable();
    this.drainQueue();
  }

  /** Journal an event unless the session is closed (nothing is appended after close resolves). */
  private append(ev: Parameters<Journal['append']>[0]): JournalEvent | undefined {
    if (this.closed) return undefined;
    return this.journal.append(ev);
  }

  private note(text: string): void {
    this.append({ type: 'note', text, principal: SYSTEM });
  }

  private onPtyData(data: string): void {
    if (this.closed) return;
    this.lastActivity = this.now();
    this.lastActivityMono = clocks.monotonic();
    let shown = data;
    try {
      shown = this.consume(data);
    } catch (e) {
      // A bug here must not escape into node-pty's emitter (it would take the daemon down).
      this.note(`internal error handling terminal output: ${errMessage(e)}`);
    }
    // The screen gets what the journal got — no keyed mark, no key (atc-3) — with the seq
    // this chunk completes, so snapshots say exactly which output they reflect (G13, G14).
    void this.screen.write(shown, this.journal.lastSeq);
  }

  /** Journal a PTY chunk as output pieces and marks; returns the output (what the screen shows). */
  private consume(data: string): string {
    if (this.integrationLevel === 'none' && this.shellState === 'starting') {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.settleNone(), 100);
    }
    let shown = '';
    for (const piece of this.marks.feed(data)) {
      if (piece.kind === 'output') {
        shown += piece.data;
        this.outputTail = (this.outputTail + piece.data).slice(-512);
        this.emitOutput(piece.data);
        if (this.typeaheadWatch !== undefined) this.watchTypeahead(piece.data);
      } else {
        this.onMark(piece.mark);
      }
    }
    return shown;
  }

  /**
   * Journal an output piece attributed to the Run whose program holds the terminal (G12: temporal,
   * to the innermost running Run — a declared shell's inside `ssh`). A declared shell's markers
   * cut the piece: what precedes a start marker belongs to the Run around it and what follows to
   * the Run it starts; an end marker closes its Run before the prompt that follows it.
   */
  private emitOutput(data: string): void {
    let rest = data;
    let seen = this.inlineTail;
    while (rest.length) {
      const hit = this.nextInlineMarker(seen, rest);
      const chunk = hit ? rest.slice(0, hit.end) : rest;
      const run = this.innermostRunning();
      this.append({ type: 'output', data: chunk, stream: 'pty', ...(run && { runId: run.runId, attribution: 'temporal' as const }) });
      // The marker ends its Run right after the piece that carried it, before any mark
      // that follows in the same read (the line's own D and A when marks appeared).
      const base = this.currentShellRun;
      if (base?.state === 'running' && base.markerNonce) this.scanMarker(base, chunk);
      seen = (seen + chunk).slice(-64);
      rest = rest.slice(chunk.length);
      if (hit) this.applyInlineMarker(hit);
    }
    this.inlineTail = seen;
  }

  /**
   * ss-1: keystrokes typed while the last Run ran are read by the line editor at this
   * prompt unless the program took them. When the editor's echo shows them, a line is
   * being edited: the shell is not available (G4) until it is submitted, cleared or stale.
   */
  private watchTypeahead(data: string): void {
    if (this.shellState !== 'idle' || !this.sawPromptEnd || this.pendingShellRun || this.currentShellRun) return;
    this.idleEcho = (this.idleEcho + stripEscapes(data).text).slice(-1024);
    if (!this.idleEcho.includes(this.typeaheadWatch!)) return;
    this.typeaheadWatch = undefined;
    if (this.typeaheadTimer) clearTimeout(this.typeaheadTimer);
    this.typeaheadTimer = undefined;
    this.idleEcho = '';
    this.humanEditing = true;
    this.editedAt = clocks.monotonic();
    this.armEditingTimer();
  }

  private onMark(mark: Mark): void {
    if (mark.osc === 633) {
      if (mark.code === 'E') this.lastCommandLine = mark.line;
      else if (mark.code === 'P' && mark.property === 'Cwd' && mark.value) {
        // The cwd comes only from the keyed 633;P;Cwd (G7): exact bytes, no percent-decoding.
        this.cwdPath = mark.value;
        this.append({ type: 'cwd', path: mark.value });
      } else if (mark.code === 'P' && mark.property === 'TsmHello') this.onHello(mark.value);
      else if (mark.code === 'P' && mark.property === 'TsmExec') this.onExecArmed();
      return;
    }
    switch (mark.code) {
      case 'A':
        return this.onPromptStart();
      case 'B':
        this.sawPromptEnd = true;
        this.append({ type: 'prompt', cwd: this.cwdPath, phase: 'end' });
        // The shell is at its line editor — but only after a prompt start (a B from a PS1
        // alone, with the hooks broken, is not the integration's first prompt).
        if (this.sawPromptStart) this.markReady();
        // The editor reads a queued line only once the prompt is drawn (a PS1 with a command
        // substitution takes its time): the empty line's grace runs from here (onPromptStart).
        if (this.sawPromptStart) this.promptsCarryEnd = true;
        if (this.promptProbe?.prompted && !this.promptProbe.started) this.armPromptProbeGrace();
        return;
      case 'C':
        return this.onPreExec();
      case 'D':
        return this.onCommandEnd(mark.exit, mark.pipeStatus);
      default:
        return;
    }
  }

  /** The integration announced itself (`kind`: bash, zsh, fish): wait for the first prompt instead of declaring `none`. */
  private onHello(kind: string | undefined): void {
    if (kind) this.flavor = flavorOf(kind);
    if (!this.sawHello) {
      this.sawHello = true;
      this.helloCommand = this.pty.command?.();
      // The rc can exec before we consume its hello. Do not take the replacement's
      // command line as proof that it was the shell which emitted that handshake.
      if (kind && this.helloCommand && path.basename(this.helloCommand.trim().split(/\s+/)[0] ?? '').replace(/^-/, '') !== kind) {
        this.helloCommand = kind;
      }
      // The grace timer stays: when it fires without a prompt, it checks that the rc
      // has not replaced the shell.
      return;
    }
    // A second handshake: the shell was replaced in place by one of ours (`exec zsh` from
    // bash re-integrates too, ss-4). Its first prompt ends whatever Run was in flight: lost,
    // 'shell-replaced' — its end was not observed (G3, G5).
    this.stopExecWatch();
    this.helloCommand = this.pty.command?.();
    const cur = this.currentShellRun ?? this.pendingShellRun;
    if (cur && !isTerminal(cur.state)) cur.replaced = true;
    this.note(`shell integration re-initialised (the shell was replaced in place${kind ? ` by ${kind}` : ''})`);
  }

  /**
   * ss-4: the integration saw an `exec` in the line it is about to run. The shell process's
   * command line is watched while the Run is in flight: when it becomes another program
   * and no handshake follows (the startup cap for bash, zsh and fish, the grace for anything
   * else), the shell was replaced by one without our integration (onShellReplaced).
   */
  private onExecArmed(): void {
    const run = this.currentShellRun ?? this.pendingShellRun;
    if (!run || isTerminal(run.state) || this.execWatch || !this.pty.command) return;
    // Told from the command line the shell had when it announced itself: by the time this mark is
    // read, the exec has usually happened.
    const before = this.helloCommand ?? this.pty.command();
    const startedAt = clocks.monotonic();
    let changedAt: number | undefined;
    let reinitTyped = false;
    let reinitWaitStart: number | undefined;
    const tick = (): void => {
      if (isTerminal(run.state) || this.closed || this.shellState === 'exited') return this.stopExecWatch();
      const now = this.pty.command?.();
      if (now !== undefined && before !== undefined && now !== before) {
        changedAt ??= clocks.monotonic();
        // bash, zsh and fish re-announce themselves after an exec: their hello gets the startup cap.
        const kind = path.basename(now.trim().split(/\s+/)[0] ?? '').replace(/^-/, '');
        const cap = this.opts.startupCapMs ?? 15_000;
        const wait = ['bash', 'zsh', 'fish'].includes(kind) ? cap : (this.opts.integrationGraceMs ?? 3000);
        if (clocks.monotonic() - changedAt >= wait) {
          if (kind === 'bash' && !reinitTyped) {
            // A new bash whose rc replaced the PROMPT_COMMAND the handoff left it never loaded the
            // integration (the house's read of 1d83ffa). The rc's path is still in its environment:
            // load it from here, once, and wait for its hello again — but only when it is safe, and
            // the gate tells no more than it can (the house's read, #22 comment 6269901528, and of the
            // 38 commits, comment 6274841346). The reinit is typed only when the terminal is in
            // readline's own mode (ICANON and ECHO off) and no process other than the shell can read
            // it (PtyHandle.otherReader). Anything else, or anything the checks cannot answer, waits;
            // at the cap the gate gives up as a replacement and says the last cause it saw. `read -e`
            // and `read -s -n` are the shell itself in readline's mode, and a program that reads the
            // terminal only through descriptor 1 or 2 (`more` behind a pipe) is no reader to the
            // check: the stated limits, where a typed reinit draws no hello (the branch after this).
            // The mode first, and the reader check only when the mode would let the reinit be typed.
            // stty is the one process a tick starts on Linux, where the reader check reads /proc;
            // elsewhere the check adds a `ps`, and an `lsof` only while a program other than the shell
            // is in the terminal's foreground group (item 4).
            const mode = this.pty.inputMode?.();
            const editing = mode !== undefined && !mode.canonical && !mode.echo;
            const reader = editing ? this.pty.otherReader?.() : undefined;
            if (editing && reader === false) {
              reinitTyped = true;
              changedAt = clocks.monotonic();
              this.note('the new bash did not load the shell integration (its rc replaced PROMPT_COMMAND): loading it once more');
              this.pty.write(' . "$TSM_BASH_RC" reinit typed\n');
            } else {
              reinitWaitStart ??= clocks.monotonic();
              if (clocks.monotonic() - reinitWaitStart >= cap) {
                const why =
                  mode === undefined
                    ? 'its terminal mode could not be read (stty failed), so whether a program is reading its input is unknown'
                    : mode.canonical
                      ? 'its terminal is in canonical mode, where a `read -p` prompt and a `bash --noediting` prompt cannot be told apart (--noediting is unsupported for the handoff)'
                      : mode.echo
                        ? 'its terminal is non-canonical with echo on, as under `read -n` (readline turns echo off), so a read in its rc may be waiting for input'
                        : reader === true
                          ? 'a process other than the shell, in the terminal’s foreground process group, holds the terminal for input, so something its rc started may be reading it'
                          : 'whether a process other than the shell is reading the terminal could not be checked (no process listing, or a process that cannot be inspected), and unknown is not none';
                // The key stays: the bash in front still holds it in the file the exec left, so this
                // recovery loads the integration with marks the daemon accepts (item 5; retiring the
                // key here refused them, and the advised line left the session unavailable). This note
                // is the replacement's one note: the generic one after it said the shell "reports no
                // marks" and offered only input or a new session, beside a recovery that restores them
                // (a reviewer's read of the fixes for #22).
                this.stopExecWatch();
                return this.onShellReplaced(now, { keepKey: true, note: `the new bash did not load the shell integration within ${cap} ms, and the daemon did not type it in: ${why}. ${REINIT_RECOVERY}` });
              }
            }
          } else if (kind === 'bash') {
            // The typed reinit drew no hello within the cap: a program read it — one that reads the
            // terminal only through descriptor 1 or 2, as `more` behind a pipe does, which the reader
            // check cannot see, or the shell's own `read -e` or `read -s -n` — or the shell is still
            // busy. The key stays and the note gives the same recovery as the gate's own give-up; the
            // generic replacement retired the key, so that recovery's marks were refused (the house's
            // read of the 33 commits, #22 comment 6307351617, item 3).
            this.stopExecWatch();
            return this.onShellReplaced(now, { keepKey: true, note: `the new bash did not load the shell integration within ${cap} ms of the daemon typing the line that loads it: a program may have read that line instead. ${REINIT_RECOVERY}` });
          } else {
            this.stopExecWatch();
            return this.onShellReplaced(now);
          }
        }
      }
      // An exec replaces the process at once, but it may come at the end of a long line: poll
      // briskly at first, then slowly.
      if (this.execWatch) this.execWatch.timer = setTimeout(tick, clocks.monotonic() - startedAt < 3000 ? 100 : 1000);
    };
    this.execWatch = { run, timer: setTimeout(tick, 50) };
  }

  private stopExecWatch(): void {
    if (this.execWatch) clearTimeout(this.execWatch.timer);
    this.execWatch = undefined;
  }

  /**
   * ss-4: the shell became a program without our integration (`exec sh`, `exec python3`, an
   * rc of the new shell that never loads us). The Run in flight ends lost ('shell-replaced');
   * the level drops to what the program provides — none (G5 as amended: the level is what
   * the terminal's current program reports, and it only rises within one program) — so the
   * replacement remains available for explicit input, but is not a verified shell command
   * destination. Neither a process name nor elapsed time establishes prompt readiness. `note`
   * replaces the generic note where the caller knows more (the reinit gate: the shell is ours,
   * and a line it advises loads the integration again).
   */
  private onShellReplaced(command: string, opts: { keepKey?: boolean; note?: string } = {}): void {
    this.note(opts.note ?? `the shell was replaced by \`${command}\`, which reports no marks: shell commands are unavailable; use input to interact, or open a new session`);
    // A fresh key, so nothing the replacement inherited can speak for the session — except for a bash
    // of ours the reinit gate gave up on (keepKey): its key is in the file the exec left for it, and
    // the recovery the gate's note gives reads it from there.
    if (!opts.keepKey) {
      this.markKey = randomBytes(16).toString('hex');
      this.marks.rekey(this.markKey);
    }
    this.helloCommand = command;
    this.flavor = flavorOf(command);
    this.dropPromptProbe();
    const inFlight = [this.pendingShellRun, this.currentShellRun];
    this.pendingShellRun = undefined;
    this.currentShellRun = undefined;
    this.humanEditing = false;
    this.submittedAt = undefined;
    this.staleLine = false;
    this.typeaheadWatch = undefined;
    if (this.integrationLevel !== 'none') {
      this.integrationLevel = 'none';
      this.append({ type: 'integration', level: 'none' });
    }
    if (this.shellState !== 'exited') this.shellState = 'unavailable';
    for (const r of inFlight) if (r && !isTerminal(r.state)) this.endRun(r, { state: 'lost', reason: 'shell-replaced' });
  }

  private onPromptStart(): void {
    this.sawPromptStart = true;
    // The prompt's own queries follow its start mark (fish sends them after the fish_prompt event that
    // prints it); a reply kept from before it was a running program's (resendReplies).
    this.replies = [];
    this.sawPromptEnd = false;
    this.humanEditing = false;
    this.submittedAt = undefined;
    this.staleLine = false;
    this.secretInput = false;
    this.lastCommandLine = undefined;
    // Keystrokes typed while the last Run ran, which the editor may now show (ss-1).
    this.typeaheadWatch = this.typeahead.length >= 2 ? this.typeahead : undefined;
    this.typeahead = '';
    this.idleEcho = '';
    if (this.typerPrompts > 0) this.typerPrompts--;
    else {
      // Nobody's keystrokes are waiting to run (core-10): a later C is not theirs.
      this.lastTyper = undefined;
      this.sensitiveSinceCommand = false;
    }
    this.declareIntegration('rich');
    this.append({ type: 'prompt', cwd: this.cwdPath, phase: 'start' });
    const cur = this.currentShellRun;
    if (cur && cur.state === 'running') {
      if (cur.strategy === 'marker') {
        // Marks appeared while a marker Run is in flight (an rc slower than the grace):
        // its nonce'd marker still ends it (core-9).
      } else {
        // A prompt without an end mark: the Run's end was not observed (G3) — a new shell
        // announced itself meanwhile (`exec`), or something removed the hooks (G5).
        this.endRun(cur, { state: 'lost', reason: cur.replaced ? 'shell-replaced' : 'prompt-without-end-mark' });
      }
    }
    const pending = this.pendingShellRun;
    if (pending && (pending.survivePrompts ?? 0) > 0) {
      // A line typed ahead of ours ran first (its C came after our write); ours is next in the
      // tty's queue (ss-1). Only that evidence keeps a pending Run past a prompt start.
      pending.survivePrompts!--;
    } else if (pending) {
      // The shell came back to a prompt without starting our line: a ^C discarded it, a hook
      // failed — or the line is still unread (a ^C that raced the write makes a prompt first,
      // ss-8). Its command file goes before the outcome is declared, so a late read of the line
      // sources a missing file (a harmless error) and never runs the command as a Run nobody
      // awaits. Never invent an exit (G3); the prompt confirms availability (G4).
      this.discardPending(pending, pending.cancelRequested ? { state: 'cancelled', reason: 'cancelled-before-start' } : { state: 'lost', reason: 'no-pre-execution-mark' });
    }
    if (this.currentShellRun && isTerminal(this.currentShellRun.state)) this.currentShellRun = undefined;
    // After a cancel whose ^C drew no mark (askForPrompt): with nothing typed, this prompt is the shell's
    // answer; with the empty line typed, the prompt after its pre-execution mark is. A prompt before that
    // mark (the ^C's own, or one that ends a line read before the ^C) is followed at once by the line, which
    // the editor reads as soon as the prompt is drawn; without the mark within the grace the line was lost,
    // and the shell is back at this prompt (onPromptProbeLost). Counting prompts kept the shell busy for good
    // when no other came (the house's review of the 40 commits through f3750e4, #22 comment 6310921374,
    // question 1). The grace runs from the prompt's end mark, once PS1 is expanded, when this shell's prompts
    // carry one: from here, a PS1 with a second's command substitution gave the line up at 300 ms, and it ran
    // at 1 s (the house's review of the 40 commits through 4f4c067). Until the end mark comes, the wait is
    // PROMPT_DRAWN_WAIT_MS. A shell whose prompts have shown no end mark gets the grace from here.
    const probe = this.promptProbe;
    if (probe && (probe.started || probe.path === undefined)) this.dropPromptProbe();
    else if (probe) {
      probe.prompted = true;
      this.armPromptProbeGrace(this.promptsCarryEnd ? PROMPT_DRAWN_WAIT_MS : PROMPT_PROBE_GRACE_MS);
    }
    if (this.shellState !== 'exited') this.shellState = this.currentShellRun || this.pendingShellRun || this.promptProbe ? 'busy' : 'idle';
    if (!this.ready && !this.readyTimer) {
      // The prompt is being printed; a shell is only truly at its line editor once it
      // is done (the B mark). Do not wait forever for a PS1 that lost our mark.
      this.readyTimer = setTimeout(() => this.markReady(), 500);
    }
    // Keys typed while the last Run ran may be in the editor now: their echo comes after the
    // prompt's end mark, so a queued Run launched here, with its clear-line keys first, wiped
    // a person's half-typed command and said nothing (the house's review of #11, core finding
    // 4). The queue waits for the echo (then the line is being edited: G4 holds the shell
    // until it is submitted, cleared or stale) or for a short grace without it (the program
    // took the keys).
    // The grace starts at the prompt's end mark (B), after PS1 is expanded: readline shows the
    // typed text only then, and a PS1 with a command substitution ate a grace that started here
    // (the house's read of f6fe640). Until then the shell is `prompt-pending` (shellAvailable).
    if (this.typeaheadWatch !== undefined) return;
    this.drainQueue();
    this.notifyAvailable();
  }

  /** Start the typed-ahead grace (see onPromptStart), once the prompt is fully printed: the B mark, or the 500 ms fallback for a PS1 that lost it. */
  private armTypeaheadGrace(): void {
    if (this.typeaheadWatch === undefined || this.typeaheadTimer) return;
    this.typeaheadTimer = setTimeout(() => {
      this.typeaheadTimer = undefined;
      this.typeaheadWatch = undefined;
      this.idleEcho = '';
      this.drainQueue();
      this.notifyAvailable();
    }, TYPEAHEAD_GRACE_MS);
    this.typeaheadTimer.unref();
  }

  /** (Re)start the empty line's grace at a prompt that came before its pre-execution mark (see onPromptStart). */
  private armPromptProbeGrace(ms = PROMPT_PROBE_GRACE_MS): void {
    clearTimeout(this.promptProbeTimer);
    this.promptProbeTimer = setTimeout(() => this.onPromptProbeLost(ms), ms);
    this.promptProbeTimer.unref();
  }

  /**
   * The shell's prompt was not followed by the empty line's pre-execution mark: the line is gone (a ^C
   * typed after it flushed it, or a program read it), and the shell is back at that prompt. Were the
   * line read later still, its mark names its file (onPreExec), and a Run written meanwhile waits for it.
   */
  private onPromptProbeLost(ms: number): void {
    this.promptProbeTimer = undefined;
    const probe = this.promptProbe;
    if (!probe || probe.started || this.closed) return;
    this.note(`the empty line typed after a cancel's ^C did not start within ${ms} ms of the shell's prompt: it was lost (a ^C after it flushed it, or a program read it), and the shell counts as available again at that prompt`);
    this.dropPromptProbe();
    if (this.shellState === 'busy' && !this.currentShellRun && !this.pendingShellRun) this.shellState = 'idle';
    this.drainQueue();
    this.notifyAvailable();
  }

  /**
   * A pending Run whose line will not start as ours: its command file goes before the outcome is
   * declared, so a late read of the line sources a missing file (a harmless error) and never runs the
   * command as a Run nobody awaits; its line is remembered so a late C is still attributed to it as
   * an orphan's. Never invents an exit (G3).
   */
  private discardPending(pending: RunRecord, outcome: { state: 'cancelled' | 'lost'; reason: string }): void {
    if (this.pendingShellRun === pending) this.pendingShellRun = undefined;
    if (pending.tempFile) {
      try {
        fs.rmSync(pending.tempFile, { force: true });
      } catch {
        // already gone
      }
      delete pending.tempFile;
    }
    if (pending.execLine) {
      this.orphanLines.set(pending.execLine, pending);
      // Most were discarded (a ^C flushed them): keep only the recent ones.
      for (const k of this.orphanLines.keys()) {
        if (this.orphanLines.size <= MAX_ORPHAN_LINES) break;
        this.orphanLines.delete(k);
      }
    }
    this.endRun(pending, outcome);
  }

  private onPreExec(): void {
    this.humanEditing = false;
    this.submittedAt = undefined;
    this.staleLine = false;
    this.secretInput = false;
    this.typeaheadWatch = undefined;
    const line = this.lastCommandLine;
    this.lastCommandLine = undefined;
    const probeLine = this.probeLine;
    if (line !== undefined && probeLine !== undefined && line.includes(probeLine.file)) {
      // The empty line a cancel typed (askForPrompt): not a Run. The prompt after it frees the shell.
      this.shellState = 'busy';
      if (this.promptProbe) {
        this.promptProbe.started = true;
        clearTimeout(this.promptProbeTimer);
        this.promptProbeTimer = undefined;
      }
      this.probeLine = undefined;
      // Run late, after the session gave up on it and wrote a Run's line behind it: that line is next
      // in the tty's queue, and the empty line's own prompt must not discard it, as a line typed ahead
      // of it would not (an independent read of the fix for #22 comment 6307351617: a third prompt
      // before the empty line brought item 1 back).
      const pending = this.pendingShellRun;
      if (pending?.writeOrder !== undefined && pending.writeOrder > probeLine.order) pending.survivePrompts = (pending.survivePrompts ?? 0) + 1;
      return;
    }
    const cur = this.currentShellRun;
    if (cur && cur.state === 'running') {
      // Never replace a running Run (it would be orphaned 'running' forever). A marker
      // Run's own line gets a C when marks appeared mid-flight; anything else is noted.
      if (cur.strategy !== 'marker') this.note(`pre-execution mark while ${cur.runId} is running; ignored`);
      return;
    }
    this.shellState = 'busy';
    const pending = this.pendingShellRun;
    const trimmed = line?.trim();
    let run: RunRecord;
    if (pending && (trimmed === undefined || trimmed === pending.execLine)) {
      this.pendingShellRun = undefined;
      run = pending;
    } else if (pending && line !== undefined && pending.tempFile !== undefined && line.includes(shellQuote(pending.tempFile))) {
      // ss-1: our line merged with text already in the line editor (a history search left
      // open, a mode the clear keys do not reach): what the shell runs for our write is ours.
      this.pendingShellRun = undefined;
      run = pending;
      this.note(`the line written for ${pending.runId} ran merged with text that was in the line editor: ${JSON.stringify(line)}`);
    } else {
      // Somebody else's command (typeahead, a human, a lost Run's late line): a Run of its
      // own; ours, if any, keeps waiting for its own C — through the next prompt start too,
      // when this line was typed before ours was written (it ran ahead of ours in the tty).
      const ahead = trimmed === undefined ? -1 : this.typeaheadLines.findIndex((t) => t.line === trimmed);
      if (ahead !== -1) {
        const t = this.typeaheadLines.splice(ahead, 1)[0]!;
        if (pending?.writeOrder !== undefined && t.order < pending.writeOrder) pending.survivePrompts = (pending.survivePrompts ?? 0) + 1;
      }
      const orphan = trimmed !== undefined ? this.orphanLines.get(trimmed) : undefined;
      const typer = this.lastTyper;
      const init: Parameters<Session['newRun']>[0] = orphan
        ? { target: 'shell', principal: orphan.principal, origin: orphan.origin, queued: false }
        : { target: 'shell', principal: typer ?? UNKNOWN_TYPER, origin: typer === undefined || typer.startsWith('human:') ? 'human' : 'agent', queued: false };
      if (orphan) {
        // The line of a Run that ended before the shell read it (ss-8): its command file was
        // removed first, so what runs is the plumbing line alone (a missing-file error).
        this.orphanLines.delete(trimmed!);
        init.line = line!;
        this.note(`the line written for ${orphan.runId} (${orphan.state} before the shell read it) ran late; its command file had been removed, so its command did not run`);
      } else if (line !== undefined) {
        // shell-9: a line typed as sensitive input is not promoted into structured metadata.
        init.line = this.sensitiveSinceCommand ? '[redacted]' : line;
      }
      run = this.newRun(init);
    }
    this.lastTyper = undefined;
    this.sensitiveSinceCommand = false;
    this.startRun(run, { cwd: this.cwdPath });
  }

  private onCommandEnd(exit: number | undefined, pipeStatus?: number[]): void {
    this.declareIntegration('basic');
    const run = this.currentShellRun;
    if (run && run.strategy === 'marker') return; // its marker ends it
    if (run && run.state === 'running') {
      const outcome: { state: 'exited' | 'cancelled'; exit?: number; pipeStatus?: number[] } = { state: run.cancelRequested ? 'cancelled' : 'exited' };
      if (exit !== undefined) outcome.exit = exit;
      // One status per pipeline command (shell tools 3); a single command's is `exit` itself.
      if (pipeStatus && pipeStatus.length > 1) outcome.pipeStatus = pipeStatus;
      this.endRun(run, outcome);
    }
    const pending = this.pendingShellRun;
    if (!run && pending?.cancelRequested) {
      // An end mark with no Run running and our line still unstarted, while that line is being
      // cancelled: the shell finished something whose pre-execution mark never came (a ^C that landed in
      // the hook before it printed). Whatever it was, our line did not start as a Run; it ends
      // cancelled now rather than waiting for a prompt that a ^C-quiet shell may not print (CI at
      // cb603a8 on #22). The exit is not attributed to it (G3).
      this.note(`${pending.runId}: an end mark arrived with no pre-execution mark for its line while it was being cancelled; the line never started as a Run`);
      this.discardPending(pending, { state: 'cancelled', reason: 'cancelled-before-start' });
    }
    this.currentShellRun = undefined;
    // Availability waits for the prompt mark (G4); under `basic` there is none.
    if (this.integrationLevel === 'basic') {
      this.shellState = 'idle';
      this.drainQueue();
      this.notifyAvailable();
    }
  }

  private onPtyExit(exit: PtyExit): void {
    for (const piece of this.marks.flush()) if (piece.kind === 'output') this.append({ type: 'output', data: piece.data, stream: 'pty' });
    this.exitInfo = exit;
    this.shellState = 'exited';
    this.stopExecWatch();
    const ev: Parameters<Journal['append']>[0] = { type: 'session.exit', code: exit.exitCode };
    if (exit.signal) ev.signal = exit.signal;
    if (this.closeReason !== undefined) ev.reason = this.closeReason;
    this.append(ev);
    // In-flight shell Runs cannot report an end mark now (G3: never invent an exit).
    // The reason carries how the shell itself ended, which is often the clue: a
    // shell that exits under a Run with the Run's own failing status had `set -e` on.
    const reason = this.closeReason ?? this.shellExitedReason();
    for (const r of [this.pendingShellRun, this.currentShellRun]) {
      if (r && !isTerminal(r.state)) this.endRun(r, { state: 'lost', reason });
    }
    this.pendingShellRun = undefined;
    this.currentShellRun = undefined;
    // Declared shells went with the terminal's program (those inside a Run above ended with it).
    for (const r of [...this.inFront.values()]) if (!isTerminal(r.state)) this.endRun(r, { state: 'lost', reason });
    for (const r of this.declaredQueue.splice(0)) this.endRun(r, { state: 'lost', reason: this.closeReason ?? 'shell-exited-before-start' });
    this.layers.length = 0;
    // What the shell forked outside any job stays in its own process group — command
    // substitutions, or a fork hung on a lock inherited from an interrupted hook — and
    // may ignore the hangup. It ends with the shell. Jobs (`cmd &`, nohup) have groups
    // of their own and are left alone.
    this.pty.signalGroup?.(this.pty.pid, 'SIGKILL');
    for (const r of this.queue.splice(0)) this.endRun(r, { state: 'lost', reason: this.closeReason ?? 'shell-exited-before-start' });
    this.teardownProcessGroups();
    for (const t of [this.graceTimer, this.settleTimer, this.capTimer, this.editingTimer, this.typeaheadTimer, this.promptProbeTimer]) clearTimeout(t);
    if (this.integrationLevel === 'unknown') this.integrationLevel = 'none';
    this.markReady();
    for (const w of this.availabilityWaiters.splice(0)) w();
  }

  /**
   * End the shell: SIGHUP; a second SIGHUP after a short grace (an interactive bash
   * defers the first one while it is still printing its prompt); SIGKILL at
   * `timeoutMs`. The terminal's foreground job is hung up with it, and when it ignores or
   * handles the hangup (a server that reloads on SIGHUP) it gets SIGTERM, then SIGKILL,
   * within the same timeout (ss-6; journaled as a note). Resolves once process Runs are
   * torn down as well (they are the daemon's children); after that nothing more is
   * journaled. With a `reason` (e.g. 'daemon-shutdown'), in-flight shell Runs end `lost`
   * with it instead of 'shell-exited'.
   */
  close(opts: { graceful?: boolean; timeoutMs?: number; reason?: string } = {}): Promise<void> {
    if (!this.closing) this.closing = this.doClose(opts);
    return this.closing;
  }

  private async doClose(opts: { graceful?: boolean; timeoutMs?: number; reason?: string }): Promise<void> {
    if (opts.reason !== undefined) this.closeReason = opts.reason;
    if (this.shellState !== 'exited') {
      const exited = new Promise<void>((resolve) => {
        const off = this.pty.onExit(() => {
          off();
          resolve();
        });
      });
      const gone = () => this.exitInfo !== undefined;
      // Race the exit against a timer that is always cleared (core-17).
      const wait = (ms: number) =>
        new Promise<boolean>((resolve) => {
          if (gone()) return resolve(true);
          const t = setTimeout(() => resolve(false), ms);
          void exited.then(() => {
            clearTimeout(t);
            resolve(true);
          });
        });
      // Closing a terminal hangs up its foreground job. bash 3.2 does not pass its own SIGHUP on
      // to a job started from a sourced file — every daemon line is one (G6) — and macOS sends
      // nothing when the shell exits, so the job's group is signalled here, never the shell's.
      const foregroundJob = (sig: NodeJS.Signals) => {
        const fg = this.pty.foreground?.();
        if (fg && fg.foregroundPgid !== fg.shellPgid) this.pty.signalGroup?.(fg.foregroundPgid, sig);
      };
      // The job is known now; once the shell is gone nothing can ask the terminal for it.
      const job = this.foregroundJob();
      const total = opts.timeoutMs ?? 3000;
      // The close wait is the longest wait on the shutdown path: measured on the monotonic clock, as is
      // the reapJob deadline it hands on (the reviewer's read of 2f32e8a..a088780, #22).
      const started = clocks.monotonic();
      const graceful = opts.graceful ?? true;
      if (graceful) {
        foregroundJob('SIGHUP');
        this.pty.kill('SIGHUP');
        if (!(await wait(Math.min(300, total)))) {
          // A shell waiting on a command substitution defers the hangup until that
          // child ends: hang up the shell's own process group (the shell and what it
          // forked outside any job), and the shell once more.
          if (!gone()) this.pty.signalGroup?.(this.pty.pid, 'SIGHUP');
          if (!gone()) this.pty.kill('SIGHUP');
          await wait(Math.max(0, total - (clocks.monotonic() - started)));
        }
      }
      if (!gone()) {
        foregroundJob('SIGKILL');
        this.pty.signalGroup?.(this.pty.pid, 'SIGKILL');
        if (!gone()) this.pty.kill('SIGKILL');
        await exited;
      }
      if (graceful && job !== undefined) await this.reapJob(job, started + total);
    }
    // Process Runs are the daemon's children: they do not outlive the session (core-11),
    // nor do the members of their groups that outlived the leader (ss-10).
    this.teardownProcessGroups();
    await Promise.allSettled([...this.teardowns]);
    for (const t of [this.graceTimer, this.settleTimer, this.readyTimer, this.capTimer, this.editingTimer, this.typeaheadTimer, this.promptProbeTimer, this.seatReserved?.timer]) clearTimeout(t);
    this.seatReserved = undefined;
    this.cleanupTempFiles();
    await this.screen.settled();
    this.screen.dispose();
    this.closed = true;
  }

  /**
   * ss-6: the foreground job survived its hangup (it ignores SIGHUP, or handles it as
   * "reload"): SIGTERM, then SIGKILL, to its process group — never the daemon's — before
   * `deadline` (a clocks.monotonic() instant). What was done is journaled.
   */
  private async reapJob(pgid: number, deadline: number): Promise<void> {
    const alive = () => this.pty.groupAlive?.(pgid) ?? false;
    if (!this.pty.groupAlive || pgid === process.pid) return;
    const waitGone = async (until: number) => {
      while (alive() && clocks.monotonic() < until) await sleep(20);
      return !alive();
    };
    const left = () => Math.max(0, deadline - clocks.monotonic());
    if (await waitGone(clocks.monotonic() + Math.min(300, left()))) return;
    const steps: string[] = [];
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      if (!alive()) break;
      if (this.pty.signalGroup?.(pgid, sig)) steps.push(sig);
      if (sig === 'SIGTERM' && (await waitGone(clocks.monotonic() + Math.max(100, Math.min(1000, left()))))) break;
    }
    if (steps.length) this.note(`close: the foreground job (process group ${pgid}) survived the hangup; sent ${steps.join(', then ')}`);
  }

  /** Tear down every process Run still running, and every process group that outlived its Run's leader (ss-10). */
  private teardownProcessGroups(): void {
    for (const r of this.runs.values()) {
      if (r.target === 'process' && (!isTerminal(r.state) || (r.process?.groupAlive?.() ?? false))) this.teardownProcess(r);
    }
  }

  // ───────────────────────────── runs ─────────────────────────────

  private newRun(init: {
    target: RunTarget;
    principal: Principal;
    origin: RunOrigin;
    line?: string | undefined;
    argv?: string[];
    queued: boolean;
    envBasis?: EnvBasis | undefined;
    idem?: string | undefined;
    shell?: string;
    within?: string | null;
  }): RunRecord {
    const runId = `r${++this.runCounter}-${randomBytes(3).toString('hex')}`;
    const given: { line?: string; argv?: string[]; idem?: string; shell?: string; within?: string | null } = {};
    if (init.line !== undefined) given.line = init.line;
    if (init.argv) given.argv = init.argv;
    if (init.idem !== undefined) given.idem = init.idem;
    if (init.shell !== undefined) given.shell = init.shell;
    if (init.within !== undefined) given.within = init.within;
    const admitted = this.append({ type: 'run.admit', runId, target: init.target, principal: init.principal, origin: init.origin, queued: init.queued, ...given });
    const rec: RunRecord = {
      runId,
      sessionId: this.id,
      target: init.target,
      origin: init.origin,
      principal: init.principal,
      state: 'queued',
      admittedAt: admitted?.ts ?? this.now(),
      admittedMono: clocks.monotonic(),
      seq: { admit: admitted?.seq ?? this.journal.lastSeq },
      attribution: init.target === 'process' ? 'exact' : 'temporal',
      waiters: [],
      ...given,
    };
    if (init.envBasis) rec.envBasis = init.envBasis;
    this.runs.set(runId, rec);
    return rec;
  }

  private startRun(run: RunRecord, info: { cwd: string; envBasis?: EnvBasis; pid?: number; pgid?: number | undefined; startTicks?: number | undefined; bootId?: string | undefined }): void {
    // er-4: the geometry the Run starts at; its transcript is projected at this width (§6 rule 1).
    const ev: Parameters<Journal['append']>[0] = { type: 'run.start', runId: run.runId, cwd: info.cwd, cols: this.screen.cols, rows: this.screen.rows };
    if (run.line !== undefined) ev.line = run.line;
    if (info.envBasis) ev.envBasis = info.envBasis;
    // jr2-4: a process Run's pid and process group, so a recovery can find what outlived a crash; and the
    // leader's frame-free start (Linux ticks and boot id, from the backend), so recovery can judge the
    // group across a wall-clock step (comment 6269992150, item 4). Recorded only with a group.
    if (info.pid !== undefined && info.pid > 0) ev.pid = info.pid;
    if (info.pgid !== undefined && info.pgid > 0) {
      ev.pgid = info.pgid;
      if (info.startTicks !== undefined && info.bootId !== undefined) {
        ev.startTicks = info.startTicks;
        ev.bootId = info.bootId;
      }
    }
    if (run.target === 'shell') {
      // What the output holds besides the command's own, so history cuts it as the live transcript
      // does (core/plumbing.ts; the house's read of 39787b3, #22). A line typed at the prompt is
      // bounded by the integration's marks like a daemon line under the rich strategy.
      run.strategy ??= 'rich';
      ev.strategy = run.strategy;
      if (run.markerNonce !== undefined) ev.nonce = run.nonce = run.markerNonce;
      // The pid the inline start marker named, which history has no other way to know (comment 6274773484).
      if (run.shellPid !== undefined) ev.shellPid = run.shellPid;
    }
    // Stamped before the append, which dispatches run.start to listeners at once: the segmenter dates the
    // Run's digests from what the session measures then, and with no start stamp yet that was the
    // admission, counting the time the Run queued (the house's read of the 33 commits, #22, comment
    // 6307351104).
    run.startedMono = clocks.monotonic();
    const started = this.append(ev);
    run.state = 'running';
    run.startedAt = started?.ts ?? this.now();
    run.seq.start = started?.seq ?? this.journal.lastSeq;
    run.cwd = info.cwd;
    run.cols = this.screen.cols;
    run.rows = this.screen.rows;
    // A declared shell's Run runs inside the Run that occupies the shell; it never becomes it.
    if (run.target === 'shell' && run.strategy !== 'inline') this.currentShellRun = run;
    for (const w of run.changeWaiters?.splice(0) ?? []) w();
  }

  /** Resolve once the Run leaves `state`, or after `ms` (a wait that times out leaves nothing behind, see awaitRun). */
  private waitLeave(run: RunRecord, state: RunState, ms: number): Promise<void> {
    if (run.state !== state) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = (run.changeWaiters ??= []);
      const left = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        const i = waiters.indexOf(left);
        if (i !== -1) waiters.splice(i, 1);
        resolve();
      }, timerMs(ms));
      waiters.push(left);
    });
  }

  private endRun(run: RunRecord, outcome: { state: 'exited' | 'cancelled' | 'lost'; exit?: number; signal?: string; reason?: string; leftovers?: boolean; pipeStatus?: number[] }): void {
    if (isTerminal(run.state)) return;
    const endedAt = this.now();
    const durationMs = this.elapsedMs(run);
    const reason = outcome.reason ?? (outcome.state !== 'exited' ? run.endReason : undefined);
    const ev: Parameters<Journal['append']>[0] = { type: 'run.end', runId: run.runId, state: outcome.state, durationMs };
    if (outcome.exit !== undefined) ev.exit = outcome.exit;
    if (outcome.signal) ev.signal = outcome.signal;
    if (reason) ev.reason = reason;
    if (outcome.leftovers) ev.leftovers = true;
    if (outcome.pipeStatus) ev.pipeStatus = [...outcome.pipeStatus];
    // G28: run.end is journaled while the waiting principals are still recorded as
    // awaiting; the waiters are released after it.
    const ended = this.append(ev);
    run.state = outcome.state;
    run.endedAt = endedAt;
    run.durationMs = durationMs;
    run.seq.end = ended?.seq ?? this.journal.lastSeq;
    if (outcome.exit !== undefined) run.exit = outcome.exit;
    if (outcome.signal) run.signal = outcome.signal;
    if (reason) run.reason = reason;
    if (outcome.leftovers) run.leftovers = true;
    if (outcome.pipeStatus) run.pipeStatus = [...outcome.pipeStatus];
    // A line the shell never started goes with its file too: a late read of it sources a
    // missing file and never runs the command unawaited (ss-8). Close waits for the removal,
    // then removes the command directory.
    if (run.tempFile) {
      const removed: Promise<void> = fs.promises.rm(run.tempFile, { force: true }).catch(() => undefined).finally(() => this.teardowns.delete(removed));
      this.teardowns.add(removed);
      delete run.tempFile;
    }
    if (this.execWatch?.run === run) this.stopExecWatch();
    if (run.strategy === 'inline') {
      const ctx = run.within ?? null;
      if (this.inFront.get(ctx) === run) {
        this.inFront.delete(ctx);
        queueMicrotask(() => this.drainDeclared(ctx));
      }
    }
    // The program this Run started went with it: Runs declared for that program can never report (G3),
    // and the declaration itself ends — shell Runs go to what is in front now.
    if (run.target === 'shell') {
      // Capture the intent while its inline child is still in front. An earlier cancelled
      // command says nothing about a later disconnect, and ending the children loses this state.
      const callerEnded = run.cancelRequested || this.callerExiting(run.runId);
      this.endDeclaredIn(run.runId, `enclosing-run-ended: ${run.runId} ${outcome.state}`);
      const i = this.layers.findIndex((l) => l.within === run.runId);
      if (i !== -1) {
        const [layer] = this.layers.splice(i);
        const now = this.layers.at(-1);
        const how = `${outcome.state}${outcome.exit !== undefined ? ` ${outcome.exit}` : ''}`;
        const under = now ? `the declared ${now.shell} shell` : "the session's own shell";
        if (outcome.state === 'cancelled' || callerEnded) {
          this.note(`the declared ${layer!.shell} shell ended with ${run.runId} (${how}): shell Runs go to ${under} again`);
        } else {
          // Fail closed (§8.1): an end the caller did not ask for — a dropped connection, a remote
          // shell that died — must not send the next line, meant for that shell, into the one underneath.
          this.declaredEnded = { shell: layer!.shell, within: run.runId, how };
          this.note(`the declared ${layer!.shell} shell ended with ${run.runId} (${how}) without its caller asking: the next shell Run is refused once (declared-shell-ended), then shell Runs go to ${under} again`);
        }
      }
    }
    const wasCurrent = this.currentShellRun === run;
    if (wasCurrent) this.currentShellRun = undefined;
    if (wasCurrent && this.integrationLevel === 'none' && this.shellState !== 'exited' && this.shellState !== 'unavailable') {
      this.shellState = outcome.state === 'lost' ? 'unavailable' : 'idle';
      queueMicrotask(() => {
        this.drainQueue();
        this.notifyAvailable();
      });
    }
    const snapshot = publicRun(run);
    for (const w of run.waiters.splice(0)) w(snapshot);
    for (const w of run.changeWaiters?.splice(0) ?? []) w();
    this.pruneRuns();
  }

  /**
   * Keep at most MAX_ENDED_RUNS ended Runs in memory, the oldest going first. A process Run
   * whose group still has members stays, so close and cancel can still reach them; so does a
   * Run anyone still waits on. What goes is read back from the journal's run index.
   */
  private pruneRuns(): void {
    if (this.runs.size <= MAX_ENDED_RUNS) return;
    for (const [id, r] of this.runs) {
      if (this.runs.size <= MAX_ENDED_RUNS) break;
      if (!isTerminal(r.state) || r.waiters.length || r.changeWaiters?.length) continue;
      if (r.target === 'process' && (r.process?.groupAlive?.() ?? false)) continue;
      this.runs.delete(id);
      this.outcomeDelivered.delete(id);
    }
  }

  /** Is the shell terminal available for a shell Run (G4)? */
  shellAvailable(): { ok: true } | { ok: false; reason: BusyReason } {
    if (this.shellState === 'exited') return { ok: false, reason: 'exited' };
    if (this.shellState === 'unavailable') return { ok: false, reason: 'shell-unavailable' };
    if (this.shellState === 'starting') return { ok: false, reason: 'starting' };
    if (this.pendingShellRun || (this.currentShellRun && !isTerminal(this.currentShellRun.state))) return { ok: false, reason: 'running' };
    // The last Run ended but the prompt that confirms the shell is back has not arrived — after a cancel
    // whose ^C drew no mark, none at all yet, which may never come by itself (askForPrompt).
    if (this.shellState === 'busy') return { ok: false, reason: this.promptProbe && !this.promptProbe.started && !this.promptProbe.prompted ? 'cancel-unanswered' : 'prompt-pending' };
    // The prompt is here, and keys typed during the last Run may be in its editor (see onPromptStart): until
    // the prompt's end mark and the grace after it, nothing says whether the editor shows them.
    if (this.typeaheadWatch !== undefined) return { ok: false, reason: 'prompt-pending' };
    if (this.editingBlocks()) return { ok: false, reason: this.editingReason() };
    return { ok: true };
  }

  /**
   * A partial line (or a just-submitted one) blocks shell Runs, until it goes stale. At a declared
   * prompt a submitted line's hold ends on evidence where there is some (declaredForeground): at
   * once when the person's command is seen to have ended, and not at all, stale or not, while a
   * program other than the declared shell holds the terminal (the house's read of 236301b: the
   * hold's end sent the queued Run into the person's `cat`).
   */
  private editingBlocks(): boolean {
    const now = clocks.monotonic(); // an interval, not a timestamp: a wall-clock step must not end a hold early or stretch it (the house's read, #22 comment 6269901528)
    const stale = this.opts.editingStaleMs ?? 30_000;
    if (this.humanEditing && now - this.editedAt >= stale) {
      this.humanEditing = false;
      this.staleLine = true;
    }
    if (this.submittedAt !== undefined) {
      const fg = this.declaredForeground();
      if (fg === 'busy') return true;
      if (fg === 'free' && now - this.submittedAt >= FOREGROUND_SETTLE_MS) this.submittedAt = undefined;
      else if (fg !== 'free' && now - this.submittedQuietSince() >= stale) this.submittedAt = undefined;
    }
    return this.humanEditing || this.submittedAt !== undefined;
  }

  /**
   * Where nothing shows what is in front (ssh), a submitted line's hold ends after the stale period
   * of quiet, as §8.1 says: output or input since the submission means the person's command is still
   * going, so the period counts from the last of it, not from the submission (the house's read of
   * 07ab3dd, #22: counted from the submission, the hold ended while the program printed and read, and
   * a Run's wrapper was typed into it). `lastActivity` is stamped by both: onPtyData for output, and
   * input() for what is typed, so a keystroke counts at once, not only through its echo.
   */
  private submittedQuietSince(): number {
    return Math.max(this.submittedAt ?? 0, this.lastActivityMono);
  }

  /** What stands in the way: a line being typed, or one submitted whose command may still be running. */
  private editingReason(): BusyReason {
    return this.humanEditing ? 'human-editing' : 'human-submitted';
  }

  /**
   * §8.1: at a declared prompt the terminal's foreground process group is evidence where the
   * declared shell runs on this terminal (a nested shell, `sudo -i`): a group other than the one
   * the shell holds at its prompt is a program the person started; the shell's own means their
   * command has ended. Through a client such as `ssh` the client's group holds the foreground
   * throughout, and reads exactly like the shell's own: so the shell's own group counts as `free`
   * only once another group was seen in front of this layer, which proves the shell runs here (the
   * house's read of a6d0c35, #22: at a remote shell the hold ended after 200 ms and the queued Run
   * was typed into the person's `cat`). Until then nothing is known and the hold ends only when stale.
   */
  private declaredForeground(): 'busy' | 'free' | 'unknown' {
    const layer = this.layers.at(-1);
    if (!layer || this.inFront.has(layer.within)) return 'unknown';
    const known = this.declaredFg.get(layer.within);
    if (known === undefined) return 'unknown';
    const fg = this.foregroundNow();
    if (fg === undefined) return 'unknown';
    if (fg !== known.own) {
      known.proven = true;
      return 'busy';
    }
    return known.proven ? 'free' : 'unknown';
  }

  /** The terminal's foreground group, read at most every 100 ms (it is a `ps` on macOS). */
  private foregroundNow(): number | undefined {
    const now = clocks.monotonic(); // a cache age, not a timestamp: never set back by a clock step
    if (this.fgRead && now - this.fgRead.at < 100) return this.fgRead.pgid;
    const pgid = this.pty.foreground?.()?.foregroundPgid;
    this.fgRead = { at: now, pgid };
    return pgid;
  }

  /** Where the declared shell runs on this terminal, learn the group it holds at its prompt: at the declaration, and again at each of its Runs' end markers. */
  private learnDeclaredForeground(within: string | null): void {
    const fg = this.pty.foreground?.();
    if (fg) this.declaredFg.set(within, { own: fg.foregroundPgid, proven: this.declaredFg.get(within)?.proven ?? false });
    this.fgRead = undefined;
  }

  private armEditingTimer(ms = (this.opts.editingStaleMs ?? 30_000) + 5): void {
    if (this.editingTimer) clearTimeout(this.editingTimer);
    this.editingTimer = setTimeout(() => {
      this.editingTimer = undefined;
      // A submitted line's hold counts its quiet from the last activity (submittedQuietSince): still
      // held, come back when that period would end; held by a program in front, after another period.
      if (this.editingBlocks() && this.submittedAt !== undefined) {
        const stale = this.opts.editingStaleMs ?? 30_000;
        const left = this.submittedQuietSince() + stale - clocks.monotonic();
        this.armEditingTimer((left > 0 ? left : stale) + 5);
        return;
      }
      this.drainQueue();
      const layer = this.layers.at(-1);
      if (layer) this.drainDeclared(layer.within);
      this.notifyAvailable();
    }, timerMs(ms));
    this.editingTimer.unref();
  }

  private notifyAvailable(): void {
    if (!this.shellAvailable().ok) return;
    for (const w of this.availabilityWaiters.splice(0)) w();
  }

  /** Resolve true once the shell is available, or false after `ms` (a wait that times out leaves nothing behind, see awaitRun). */
  waitAvailable(ms: number): Promise<boolean> {
    if (this.shellAvailable().ok) return Promise.resolve(true);
    if (this.shellState === 'exited') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.shellState !== 'exited');
      };
      const timer = setTimeout(() => {
        const i = this.availabilityWaiters.indexOf(waiter);
        if (i !== -1) this.availabilityWaiters.splice(i, 1);
        resolve(false);
      }, timerMs(ms));
      this.availabilityWaiters.push(waiter);
    });
  }

  /**
   * Admit, waiting out the window between a Run's end mark and the next prompt
   * (`prompt-pending`, or `cancel-unanswered` after a cancel's ^C drew no mark) or the
   * shell's startup, up to `settleMs`. A Run that is actually running still answers
   * `busy` at once.
   */
  async admitWhenAvailable(opts: AdmitOptions, settleMs = 1500): Promise<AdmitResult> {
    const deadline = clocks.monotonic() + settleMs;
    for (;;) {
      const a = this.admit(opts);
      if (a.admitted || (a.reason !== 'prompt-pending' && a.reason !== 'cancel-unanswered' && a.reason !== 'starting')) return a;
      const remaining = deadline - clocks.monotonic();
      if (remaining <= 0) return a;
      await this.waitAvailable(remaining);
    }
  }

  /** Admit a Run (G1, G4). Shell Runs need availability; process Runs never occupy the shell. */
  admit(opts: AdmitOptions): AdmitResult {
    if (!opts.internal && opts.principal !== SYSTEM && this.control !== 'open') this.requireSeat(opts.principal, 'run', { asOwner: opts.asOwner === true });
    const origin = opts.origin ?? (opts.principal === SYSTEM ? 'system' : 'self');
    if (opts.target === 'process') {
      this.assertAlive();
      // A host without bash or /dev/fd cannot run process Runs (ExecutionBackend.processSupport): refused with the reason, never admitted to end lost.
      const support = this.backend.processSupport?.();
      if (support && !support.ok) throw err('unsupported', support.reason);
      // A line's text reaches the shell on descriptor 3 (see SpawnProcessOptions.line): on
      // `/bin/sh -c LINE` it was in the shell's argv, where a `pkill -f` in the line itself found
      // and killed it (the house's review of #11), and a file could be removed under a shell
      // that had not yet opened it.
      const argv = opts.argv ?? (opts.line !== undefined ? ['/bin/sh'] : undefined);
      if (!argv || argv.length === 0) throw err('invalid_argument', 'process Run needs argv or line');
      const run = this.newRun({ target: 'process', principal: opts.principal, origin, argv, line: opts.line, envBasis: opts.envBasis, idem: opts.idem, queued: false });
      this.launchProcess(run);
      return { admitted: true, run: publicRun(run) };
    }
    if (opts.line === undefined) throw err('invalid_argument', 'shell Run needs a line');
    if (this.declaredEnded && !opts.internal && opts.principal !== SYSTEM) {
      // Fail closed (§8.1): the declared shell this line may have been meant for is gone; one
      // refusal, naming the Run whose shell it was, and the next Run goes where it says.
      const ended = this.declaredEnded;
      this.declaredEnded = undefined;
      this.resumeDeclared();
      const opener = this.runs.get(ended.within);
      return { admitted: false, busy: opener ? publicRun(opener) : null, reason: 'declared-shell-ended' };
    }
    // A declared shell in front (§8.1): the Run goes to it, inline.
    const layer = this.layers.at(-1);
    if (layer) return this.admitDeclared(opts, origin, layer);
    const avail = this.shellAvailable();
    if (!avail.ok && (avail.reason === 'exited' || avail.reason === 'shell-unavailable' || !opts.queue)) {
      // (After an exit no shell Run is in flight: busy is null.)
      const busy = this.currentShellRun ?? this.pendingShellRun;
      return { admitted: false, busy: busy ? publicRun(busy) : null, reason: avail.reason };
    }
    const run = this.newRun({ target: 'shell', principal: opts.principal, origin, line: opts.line, idem: opts.idem, queued: !avail.ok });
    if (avail.ok) this.launchShellRun(run);
    else this.queue.push(run);
    return { admitted: true, run: publicRun(run) };
  }

  private drainQueue(): void {
    // (Not held by `declaredEnded`: this queue holds Runs admitted for the session's own shell,
    // before any declaration, which the fail-closed refusal has nothing to protect — the house's
    // read of 236301b.)
    while (this.queue.length && this.shellAvailable().ok) {
      const next = this.queue.shift()!;
      if (isTerminal(next.state)) continue;
      try {
        this.launchShellRun(next);
      } catch (e) {
        // This runs inside the PTY data callback: one bad Run must not escape it (core-16).
        this.endRun(next, { state: 'lost', reason: `launch-failed: ${errMessage(e)}` });
      }
    }
  }

  // ───────────── declared shells (§8.1) ─────────────

  /**
   * The caller declares that the program in front of the terminal is a shell — the remote end of
   * `ssh`, a `sudo -i`, a nested shell, or what replaced the session's shell. From then on shell
   * Runs go to it, inline; the daemon has no marks from that shell, so the caller's word says
   * where Runs go and the markers that come back say what happened. The declaration ends by
   * itself with the Run whose program the shell is (the `ssh` exiting), or on `none`.
   */
  declareShell(opts: DeclareOptions): { shell: string | null; within: string | null; depth: number } {
    this.assertAlive();
    if (opts.principal !== SYSTEM && this.control !== 'open') this.requireSeat(opts.principal, 'declare', { asOwner: opts.asOwner === true });
    const shell = (opts.shell ?? 'sh').trim();
    if (shell === 'none') {
      const top = this.layers.pop();
      if (!top) throw err('invalid_argument', 'no declared shell to take back: shell Runs already go to the session’s own shell');
      this.declaredEnded = undefined;
      this.endDeclaredIn(top.within, 'undeclared');
      this.resumeDeclared();
      const now = this.layers.at(-1);
      this.note(`the declared ${top.shell} shell was taken back: shell Runs go to ${now ? `the declared ${now.shell} shell` : "the session's own shell"} again`);
      return { shell: now?.shell ?? null, within: now?.within ?? null, depth: this.layers.length };
    }
    declaredFlavor(shell);
    const within = this.frontOf(opts.within);
    this.declaredEnded = undefined; // a valid declaration explicitly chooses the execution context
    const same = this.layers.findIndex((l) => l.within === within);
    const layer: DeclaredShell = { shell, within, by: opts.principal, at: this.now() };
    // Declaring the same program again corrects the kind; anything declared inside it is gone with the
    // old word: the layers above it end with their Runs, in flight and queued (the house's read of
    // a6d0c35, #22).
    if (same !== -1) {
      const [old, ...inner] = this.layers.splice(same);
      for (const l of inner) {
        this.endDeclaredIn(l.within, 'undeclared');
        this.note(`the declared ${l.shell} shell inside ${l.within} goes with the new declaration: its Runs end (undeclared)`);
      }
      if (old!.shell !== shell) this.note(`the program in front is declared a ${shell} shell now (was ${old!.shell})`);
    } else {
      const program = within === null ? 'the program that replaced the session’s shell' : `${within} (${(this.runs.get(within)?.line ?? '').slice(0, 60)})`;
      this.note(`declared: ${program} is a ${shell} shell; shell Runs go to it${within === null ? '' : ` until ${within} ends`}`);
    }
    this.layers.push(layer);
    // A fresh declaration starts with nothing proven: the shell proven to run here before (a local
    // `sh`) is not the one declared now (`exec ssh host`, declared at the same layer), and a carried
    // `proven` would read the remote shell as free whenever its client is in front (the house's read,
    // #22 comment 6264958172). learnDeclaredForeground keeps `proven` only at an end marker.
    this.declaredFg.delete(within);
    this.learnDeclaredForeground(within);
    return { shell, within, depth: this.layers.length };
  }

  /** The Run whose program holds the terminal now, as a declared shell's context: a running Run's id, or null for the replacement program. */
  private frontOf(within: string | undefined): string | null {
    if (within !== undefined) {
      const enclosing = this.runs.get(within);
      if (!enclosing || enclosing.target !== 'shell') throw err('invalid_argument', `within: ${within} is not a shell Run of this session`, { runId: within });
      if (enclosing.state !== 'running') throw err('invalid_argument', `within: ${within} is ${enclosing.state}: nothing of its is in front of the terminal`, { runId: within });
      return enclosing.runId;
    }
    const front = this.innermostRunning();
    if (front) return front.runId;
    if (this.shellState === 'unavailable') return null;
    throw err('invalid_argument', "nothing is running in front of the session's own shell: there is no shell to declare (run `ssh host` or the like first)");
  }

  private admitDeclared(opts: AdmitOptions, origin: RunOrigin, layer: DeclaredShell): AdmitResult {
    const { shell, within } = layer;
    if (within !== null && this.runs.get(within)?.state !== 'running') {
      // The layer outlived its Run for a moment (its end is being processed): nothing in front to type into.
      return { admitted: false, busy: null, reason: 'shell-unavailable' };
    }
    const init = { target: 'shell' as const, principal: opts.principal, origin, line: opts.line, idem: opts.idem, shell, within };
    const occupying = this.inFront.get(within);
    const running = occupying !== undefined && !isTerminal(occupying.state);
    if (running || this.editingBlocks()) {
      if (!opts.queue) return { admitted: false, busy: running ? publicRun(occupying!) : null, reason: running ? 'running' : this.editingReason() };
      const run = this.newRun({ ...init, queued: true });
      this.declaredQueue.push(run);
      // A hold with no event to end it (a submitted line) is looked at again from the drain.
      queueMicrotask(() => this.drainDeclared(within));
      return { admitted: true, run: publicRun(run) };
    }
    const run = this.newRun({ ...init, queued: false });
    this.launchInline(run);
    return { admitted: true, run: publicRun(run) };
  }

  private launchInline(run: RunRecord): void {
    const fish = declaredFlavor(run.shell!) === 'fish';
    run.markerNonce = randomBytes(4).toString('hex');
    // Public from the launch: the pieces' marks and a GONE mark print before the start mark, or with none,
    // and a reader of the session's text cuts them by it (App.runPlumbing; the house's read of the 33
    // commits, #22, comment 6307351617, item 5).
    run.nonce = run.markerNonce;
    run.strategy = 'inline';
    run.inlineLines = inlineLines(run.line ?? '', run.markerNonce, fish);
    run.inlineAck = 0;
    if (this.staleLine) this.note('a stale partial line at the declared shell prompt is being cleared before the next command');
    this.humanEditing = false;
    this.submittedAt = undefined;
    this.staleLine = false;
    // Typed, not started: the start marker says when the shell took it (no mark will). ^E then ^U
    // clears a stale or unobserved line wherever its cursor was left: ^U alone kills only what
    // precedes the cursor, and a remainder joined the Run's first line and hung it (the house's
    // read of 236301b); known active edits block admission above.
    run.state = 'starting';
    this.inFront.set(run.within ?? null, run);
    this.pty.write(`${CLEAR_WHOLE_LINE}${run.inlineLines.shift()!}\n`);
    for (const w of run.changeWaiters?.splice(0) ?? []) w();
  }

  /**
   * The declared shells answer with markers — an acknowledgement per piece typed, the start marker,
   * the end marker with the status. The earliest one that ends inside `rest` (what precedes `rest`
   * was `seen` already) says where to cut the piece and what it means.
   */
  private nextInlineMarker(seen: string, rest: string): InlineHit | undefined {
    const window = seen + rest;
    let best: InlineHit | undefined;
    // `value`: the exit status of an end marker; the pid of the shell that printed a start marker or
    // a probe's answer. `token`: what a probe's answer printed from the Run's variable (inlineProbe).
    const consider = (run: RunRecord, kind: InlineMarkerKind, idx: number, len: number, value?: number, token?: string) => {
      if (idx === -1 || idx + len <= seen.length) return;
      const end = idx + len - seen.length;
      if (!best || end < best.end) best = { run, kind, end, ...(value !== undefined && { value }), ...(token !== undefined && { token }) };
    };
    const numbered = (run: RunRecord, kind: InlineMarkerKind, re: RegExp) => {
      const m = re.exec(window);
      if (m) consider(run, kind, m.index, m[0].length, Number(m[1]), m[2]);
    };
    for (const run of this.inFront.values()) {
      if (isTerminal(run.state)) continue;
      const n = run.markerNonce!;
      if (run.inlineLines?.length) {
        const t = `<<<ACK:${n}:${(run.inlineAck ?? 0) + 1}>>>`;
        consider(run, 'ack', window.indexOf(t), t.length);
      }
      if (run.state === 'starting') {
        const t = `<<<GONE:${n}>>>`;
        consider(run, 'gone', window.indexOf(t), t.length);
        numbered(run, 'start', startMark(n));
      }
      if (run.state === 'running') numbered(run, 'exit', exitMark(n));
      if (run.probed) numbered(run, 'probe', probeMark(n));
    }
    return best;
  }

  private applyInlineMarker(hit: InlineHit): void {
    const { run } = hit;
    if (hit.kind === 'ack') {
      run.inlineAck = (run.inlineAck ?? 0) + 1;
      // Cleared like the first line: keys a person typed at the prompt between two pieces would
      // otherwise start the next one (the house's read of a6d0c35, #22); the whole-line check in
      // the piece stands behind that.
      this.pty.write(`${CLEAR_WHOLE_LINE}${run.inlineLines!.shift()!}\n`);
    } else if (hit.kind === 'gone') {
      // A line reached the shell changed or cut (text already at its prompt, a reader in front):
      // the variable does not hold what was typed, and the command never ran (G3). Nothing more
      // is typed for it.
      run.inlineLines = [];
      this.endRun(run, { state: run.cancelRequested ? 'cancelled' : 'lost', reason: 'line-not-whole' });
    } else if (hit.kind === 'start') {
      if (hit.value !== undefined) run.shellPid = hit.value;
      this.startRun(run, { cwd: '' }); // that shell's cwd is not tracked (no cwd mark)
    } else if (hit.kind === 'probe') {
      // Only the shell the Run was typed into answers for the Run: the one whose pid the start
      // marker named, printing the token the Run's line set in it. A nested shell the Run started,
      // or a second ssh hop, prints its own pid and no token: the Run's program is still in front
      // and the Run goes on (the house's read of a6d0c35, #22: the Run ended `cancelled` and the
      // next Run, meant for the declared shell, ran in the nested bash). The same pid with no token
      // is the declared shell replaced in place — a Run of `exec zsh` keeps the pid and loses the
      // unexported variable — and that shell answers for it, as it did before the token; a shell in
      // another PID namespace with the same pid is told apart from it by nothing printable, so it is
      // taken for the exec (the house's read of 39787b3, #22). A token that is another Run's is a
      // stranger's. The start marker precedes `eval`, so a Run answered before it never ran (G3).
      if (run.shellPid !== undefined && (hit.value !== run.shellPid || (hit.token !== run.markerNonce && hit.token !== '' && hit.token !== undefined))) {
        const who = hit.value !== run.shellPid ? `pid ${hit.value}; the declared shell's is ${run.shellPid}` : `pid ${hit.value} like the declared shell's, but with another Run's token`;
        this.note(`the end-marker probe for ${run.runId} was answered by another shell (${who}): what ${run.runId} started is still in front`);
        return;
      }
      if (run.shellPid !== undefined && hit.token === '') this.note(`the end-marker probe for ${run.runId} was answered by the shell now in place of the declared one (pid ${hit.value}, without the variable the Run's line set: the Run replaced it, as exec does)`);
      this.learnDeclaredForeground(run.within ?? null);
      this.endRun(run, { state: run.cancelRequested ? 'cancelled' : 'lost', reason: run.state === 'starting' ? 'cancelled-before-start' : 'exit-unobserved' });
    } else {
      // The shell printed the end marker: the text ended with this status and the shell is in front
      // again. After a cancel that failed, a natural end reads as what it is (the probe is a marker of its own).
      this.learnDeclaredForeground(run.within ?? null);
      this.endRun(run, { state: run.cancelRequested ? 'cancelled' : 'exited', exit: hit.value! });
    }
  }

  /**
   * Is an explicit request to leave executing when the enclosing program ends? Cancelling
   * a command inside that shell does not acknowledge losing the shell itself.
   */
  private callerExiting(within: string): boolean {
    const current = this.inFront.get(within);
    return current?.state === 'running' && /(?:^|;|&&|\|\|)\s*(?:exit|logout)(?:\s+\d+)?\s*;?\s*$/.test(current.line ?? '');
  }

  /** The Run whose program holds the terminal: the deepest running declared Run, else the shell's own. */
  private innermostRunning(): RunRecord | undefined {
    let run = this.currentShellRun?.state === 'running' ? this.currentShellRun : undefined;
    for (let r = this.inFront.get(run?.runId ?? null); r && r.state === 'running'; r = this.inFront.get(r.runId)) run = r;
    return run;
  }

  /** The program a Run started is gone: every Run declared for it ends — in flight as `lost`, queued before it started. */
  private endDeclaredIn(within: string | null, reason: string): void {
    for (const r of [...this.inFront.values()]) if (!isTerminal(r.state) && (r.within ?? null) === within) this.endRun(r, { state: 'lost', reason });
    const waiting = this.declaredQueue.filter((r) => (r.within ?? null) === within);
    if (!waiting.length) return;
    this.declaredQueue.splice(0, this.declaredQueue.length, ...this.declaredQueue.filter((r) => !waiting.includes(r)));
    for (const r of waiting) this.endRun(r, { state: 'lost', reason: `${reason} (before start)` });
  }

  /** The one-shot refusal is spent, or a declaration was taken back: Runs waiting for the declared shell in front get their turn (nothing else restarts a held queue; the house's read of a6d0c35, #22). */
  private resumeDeclared(): void {
    const layer = this.layers.at(-1);
    if (layer) queueMicrotask(() => this.drainDeclared(layer.within));
  }

  private drainDeclared(within: string | null): void {
    if (this.declaredEnded || this.closed) return;
    if (this.editingBlocks()) {
      // A submitted line's hold has no event to end it: a Run waiting behind it looks again shortly.
      if (!this.declaredRecheck && this.declaredQueue.some((r) => (r.within ?? null) === within && !isTerminal(r.state))) {
        this.declaredRecheck = setTimeout(() => {
          this.declaredRecheck = undefined;
          this.drainDeclared(within);
          this.notifyAvailable();
        }, DECLARED_RECHECK_MS);
        this.declaredRecheck.unref();
      }
      return;
    }
    if (this.inFront.has(within)) return;
    const i = this.declaredQueue.findIndex((r) => (r.within ?? null) === within && !isTerminal(r.state));
    if (i === -1) return;
    const next = this.declaredQueue.splice(i, 1)[0]!;
    const present = within === null ? this.shellState === 'unavailable' : this.runs.get(within)?.state === 'running';
    if (!present) {
      this.endRun(next, { state: 'lost', reason: 'enclosing-run-ended (before start)' });
      return this.drainDeclared(within);
    }
    try {
      this.launchInline(next);
    } catch (e) {
      this.endRun(next, { state: 'lost', reason: `launch-failed: ${errMessage(e)}` });
    }
  }

  /**
   * Cancel in a declared shell: the daemon cannot see or signal that shell's jobs (they may be
   * on another machine), so it does what a person at the keyboard could — ^C, the end marker
   * typed alone, ^\ — and when the Run survives, names the enclosing Run as the next thing to
   * cancel (its program, e.g. `ssh`, is what the daemon can reach).
   */
  private async cancelDeclared(run: RunRecord, principal: Principal, grace: number, steps: string[]): Promise<CancelResult> {
    const runId = run.runId;
    if (run.state === 'queued') {
      const i = this.declaredQueue.indexOf(run);
      if (i !== -1) this.declaredQueue.splice(i, 1);
      steps.push('removed from the queue');
      this.endRun(run, { state: 'cancelled', reason: 'cancelled-before-start' });
      return { runId, state: run.state, contract: 'shell', steps };
    }
    if (run.state === 'starting') await this.waitLeave(run, 'starting', grace);
    if (isTerminal(run.state)) return { runId, state: run.state, contract: 'shell', steps };
    run.cancelRequested = true;
    run.inlineLines = []; // no more pieces, whatever is acknowledged from here
    this.typeSignal(run, 'SIGINT', principal);
    steps.push('^C');
    await this.awaitRun(runId, grace);
    if (!isTerminal(run.state)) {
      // The ^C may have cut the line before its end marker (dash abandons the rest of a line): the probe
      // (ss-5), which only the shell the Run was typed into can answer for it (applyInlineMarker).
      run.probed = true;
      this.pty.write(`${inlineProbe(run.markerNonce!, declaredFlavor(run.shell!) === 'fish')}\n`);
      steps.push('end-marker probe');
      await this.awaitRun(runId, grace);
    }
    if (!isTerminal(run.state)) {
      this.typeSignal(run, 'SIGQUIT', principal);
      steps.push('^\\');
      await this.awaitRun(runId, grace);
    }
    if (!isTerminal(run.state)) {
      // The quit may have flushed the first probe out of the tty while ending the job.
      // Ask again afterwards; without an observed marker the outcome remains unknown.
      this.pty.write(`${inlineProbe(run.markerNonce!, declaredFlavor(run.shell!) === 'fish')}\n`);
      steps.push('end-marker probe after ^\\');
      await this.awaitRun(runId, grace);
    }
    if (!isTerminal(run.state)) {
      run.cancelRequested = false; // core-14
      return { runId, state: run.state, contract: 'shell', escalation: run.within ? `cancel ${run.within}` : 'session_close', steps };
    }
    return { runId, state: run.state, contract: 'shell', steps };
  }

  private launchShellRun(run: RunRecord): void {
    // Every daemon-issued line goes through the temp file, never typed as its own
    // text: history expansion (`!`), completion (a literal tab), comments, syntax
    // errors and PS2 continuations cannot change or wedge it (G6). The file is
    // written before any state changes, so a failure leaves nothing half-launched.
    const marker = this.integrationLevel === 'none';
    // Marker strategy (§8.1 fallback): a per-Run nonce in the start mark the file's first line prints
    // and in the end mark chained on the typed line.
    const nonce = marker ? randomBytes(4).toString('hex') : undefined;
    let file: string;
    try {
      // With an integration (bash, zsh, fish), the file ends by capturing the pipeline's statuses
      // for the end mark; the marker strategy's shell (dash, an unknown sh) gets the text after its
      // start mark.
      file = this.writeTempFile(run.line ?? '', !marker, nonce);
    } catch (e) {
      this.endRun(run, { state: 'lost', reason: `temp-file: ${errMessage(e)}` });
      return;
    }
    run.tempFile = file;
    if (nonce !== undefined) run.markerNonce = nonce;
    const src = sourceLine(file, this.flavor, run.markerNonce);
    run.execLine = src.trim();
    run.writeOrder = ++this.writeOrder;
    // Whatever is in the line editor would merge with ours (ss-1). Our integration binds the
    // clear keys to "empty the editor" in every keymap and mode; without it (the marker
    // strategy: dash, sh, a shell that never integrated) a stale partial line gets the tty's
    // line kill (^U), which a canonical-mode shell honours for the whole line.
    const clear = marker ? (this.staleLine ? CLEAR_WHOLE_LINE : '') : CLEAR_LINE_KEYS;
    this.staleLine = false;
    this.typeaheadWatch = undefined;
    if (marker) {
      run.strategy = 'marker';
      run.markerTail = '';
      this.shellState = 'busy'; // G5: a marker Run occupies the shell too (core-8)
      this.startRun(run, { cwd: this.cwdPath });
      this.pty.write(`${clear}${src}\n`);
      return;
    }
    if (this.integrationLevel === 'basic') {
      // End marks only: the Run starts when the line is written and ends at D.
      run.strategy = 'basic';
      this.shellState = 'busy';
      this.startRun(run, { cwd: this.cwdPath });
      this.pty.write(`${clear}${src}\n`);
      return;
    }
    // Rich: the C mark whose 633;E line is ours starts the Run, the D mark ends it.
    run.strategy = 'rich';
    this.pendingShellRun = run;
    run.state = 'starting';
    this.shellState = 'busy';
    this.pty.write(`${clear}${src}\n`);
  }

  private writeTempFile(body: string, capturePipeStatus = false, markerNonce?: string): string {
    // Typed (and echoed at the prompt) as ` . '<dir>/tsm-cmd-N'`: the integration scripts know
    // plumbing by that name, and a short command directory keeps the echo short.
    const name = commandFile(++this.tempCounter);
    let text = body.endsWith('\n') ? body : body + '\n';
    // The marker strategy's start mark, from the file's first line (plumbing.ts markerCommandText): what
    // the shell printed before it ran the file is cut up to it, whatever that was.
    if (markerNonce !== undefined) text = markerCommandText(text, markerNonce, this.flavor);
    // The pipeline's statuses (shell tools 3) are gone by the time the integration's end hook
    // runs: after `. file`, bash, zsh and fish report the statuses of `.` itself. So the file
    // captures them as its last line, in the same statement as `$?`, and returns with that status
    // so the shell and its prompt see the command's own. The empty line before it ends a command
    // whose last line continued with a backslash. The end hook reads and unsets the variable.
    // (bash's PIPESTATUS and zsh's pipestatus in one line: each is empty in the other shell.)
    // A heredoc the text never terminates ends at the end of the file, and would take the capture
    // line in as its last lines — into whatever it feeds (the house's read of e1d2b8b): no capture
    // then, and the Run reports no pipeStatus. (Fish has no heredocs.)
    if (capturePipeStatus && (this.flavor === 'fish' || !hasOpenHeredoc(text))) text += this.flavor === 'fish' ? '\nset -g __tsm_pst $pipestatus $status; __tsm_setst $__tsm_pst[-1]\n' : '\n__tsm_st=$? __tsm_ps="${PIPESTATUS[*]-}${pipestatus[*]-}"; return $__tsm_st\n';
    if (this.commandDir !== this.tempDir && !this.commandDirTrusted()) {
      // jr2-3: the short directory lives under /tmp, where a cleaner may remove it and anyone
      // may create a directory of that name. Not provably ours: the session's own directory
      // serves from now on.
      this.note(`the command directory ${this.commandDir} is no longer private to the daemon; command files go to the session's own directory`);
      this.commandDir = this.tempDir;
    }
    try {
      return writeExclusive(path.join(this.commandDir, name), text);
    } catch (e) {
      if (this.commandDir === this.tempDir) throw e;
      this.commandDir = this.tempDir;
      return writeExclusive(path.join(this.tempDir, name), text);
    }
  }

  /**
   * jr2-3: before every command file, `/tmp/tsm-<uid>` and its session directory are checked
   * again with lstat — a real directory, not a symlink, owned by us, closed to others. A
   * directory that is gone (a cleaner) is not recreated mid-life: whoever holds the name now
   * is unknown, so the caller falls back to the session's own directory (§8.1).
   */
  private commandDirTrusted(): boolean {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return uid !== undefined && trustedDir(path.dirname(this.commandDir), uid) && trustedDir(this.commandDir, uid);
  }

  private cleanupTempFiles(): void {
    for (const r of this.runs.values()) {
      if (r.tempFile) {
        fs.rmSync(r.tempFile, { force: true });
        delete r.tempFile;
      }
    }
    for (const f of this.extraTempFiles) fs.rmSync(f, { force: true });
    this.extraTempFiles.clear();
    // A command directory of its own goes with the shell (when empty; a new life recreates it).
    if (this.commandDir !== this.tempDir) {
      try {
        fs.rmdirSync(this.commandDir);
      } catch {
        // not empty, or already gone
      }
    }
  }

  private scanMarker(run: RunRecord, chunk: string): void {
    const window = (run.markerTail ?? '') + chunk;
    const exit = exitMark(run.markerNonce!).exec(window);
    const probe = run.probed ? (probeMark(run.markerNonce!).exec(window)?.index ?? -1) : -1;
    if (exit && (probe === -1 || exit.index < probe)) {
      run.markerTail = '';
      // The marker chained on the command's line: its status, after a cancel that failed too. It is
      // printf-built, so no `set -x` trace of the line holds one, and the first is the real one (the
      // house's review of the 40 commits through f3750e4, PR #22, comment 6310921374).
      this.endRun(run, { state: run.cancelRequested ? 'cancelled' : 'exited', exit: Number(exit[1]) });
      return;
    }
    if (probe !== -1) {
      run.markerTail = '';
      // The probe is a line of its own, typed after a ^C at the prompt: it confirms the shell is
      // back, and the command's exit was not observed (ss-5; G2, G3).
      this.endRun(run, { state: run.cancelRequested ? 'cancelled' : 'lost', reason: 'exit-unobserved' });
      return;
    }
    run.markerTail = window.slice(-64);
  }

  private launchProcess(run: RunRecord): void {
    // The snapshot basis is the configured one until a snapshot was captured (§8.2).
    const snapshot = run.envBasis === 'snapshot' ? this.envSnapshot : undefined;
    run.envBasis = snapshot ? 'snapshot' : 'configured';
    let proc: ProcessHandle;
    try {
      proc = this.backend.spawnProcess({ argv: run.argv!, ...(run.line !== undefined && { line: run.line }), ...(this.opts.oomScoreAdj !== undefined && { oomScoreAdj: this.opts.oomScoreAdj }), cwd: this.cwdPath, env: { ...(snapshot?.vars ?? this.configured) } });
    } catch (e) {
      // Nothing ran: no exit and no signal were observed (G2, G3).
      this.endRun(run, { state: 'lost', reason: `spawn-failed: ${errMessage(e)}` });
      return;
    }
    run.process = proc;
    this.startRun(run, { cwd: this.cwdPath, envBasis: run.envBasis, pid: proc.pid, pgid: proc.pgid, startTicks: proc.startTicks, bootId: proc.bootId });
    const output = (stream: 'stdout' | 'stderr') => (d: string) => {
      if (!isTerminal(run.state)) {
        this.append({ type: 'output', data: d, stream, runId: run.runId, attribution: 'exact' });
        return;
      }
      // ss-10: the leader exited and the Run ended, but members of its group still write. The
      // Run's attributed range ended at its run.end (G12): this output is the session's, not
      // the Run's. cancel on the Run and session close still reach the group.
      if (!run.lingerNoted) {
        run.lingerNoted = true;
        this.note(`${run.runId} ended, but its process group ${proc.pgid ?? proc.pid} still has members; their output is journaled without the Run's id`);
      }
      this.append({ type: 'output', data: d, stream });
    };
    proc.onStdout(output('stdout'));
    proc.onStderr(output('stderr'));
    proc.onExit((e) => {
      if (e.spawnError !== undefined) {
        this.endRun(run, { state: 'lost', reason: `spawn-failed: ${e.spawnError}` });
        return;
      }
      const outcome: Parameters<Session['endRun']>[1] = { state: run.cancelRequested ? 'cancelled' : 'exited' };
      if (e.exitCode !== null) outcome.exit = e.exitCode;
      if (e.signal) outcome.signal = e.signal;
      // The leader is reaped by now (Node waits for it before this callback): a group that still
      // has a living member is a child the Run left behind, and the result says so rather than
      // reading as a clean end (the house's review of #11, shell tools 5). Living: a group that
      // answers a signal may hold only zombies where no init reaps orphans (a container's PID 1),
      // which no cancel could end, so the listing that leaves zombies out decides — only when the
      // group answers at all. Not for a cancelled Run: its cancel goes on signalling the group after
      // the leader's exit, and its own result says what happened (the house's read of ec34e1e).
      if (!run.cancelRequested && proc.groupAlive?.() && livingGroups([proc.pgid ?? proc.pid]).length > 0) outcome.leftovers = true;
      this.endRun(run, outcome);
    });
  }

  /**
   * Wait up to `waitMs` for the Run to reach a terminal state (G3: the wait never
   * changes it). With a `principal`, that principal counts as awaiting the Run until
   * the wait resolves (G28, `isAwaitedBy`).
   */
  awaitRun(runId: string, waitMs: number, principal?: Principal): Promise<RunInfo> {
    const run = this.getRun(runId);
    if (isTerminal(run.state) || waitMs <= 0) return Promise.resolve(publicRun(run));
    if (principal !== undefined) {
      let m = this.awaiting.get(runId);
      if (!m) this.awaiting.set(runId, (m = new Map()));
      m.set(principal, (m.get(principal) ?? 0) + 1);
    }
    return new Promise<RunInfo>((resolve) => {
      let done = false;
      const finish = (r: RunInfo) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (principal !== undefined) {
          const m = this.awaiting.get(runId);
          const n = (m?.get(principal) ?? 1) - 1;
          if (n > 0) m!.set(principal, n);
          else m?.delete(principal);
          if (m && m.size === 0) this.awaiting.delete(runId);
        }
        resolve(r);
      };
      const timer = setTimeout(() => {
        // A wait that times out takes its callback with it: a long Run polled every few seconds
        // collected one per poll until its end (the house's read of a6d0c35, #22).
        const i = run.waiters.indexOf(finish);
        if (i !== -1) run.waiters.splice(i, 1);
        finish(publicRun(run));
      }, timerMs(waitMs));
      run.waiters.push(finish);
    });
  }

  /** Is `principal`'s synchronous wait on this Run in flight right now (G28)? */
  isAwaitedBy(runId: string, principal: Principal): boolean {
    return (this.awaiting.get(runId)?.get(principal) ?? 0) > 0;
  }

  /**
   * Cancel under the contract for the Run's target (G29). Allowed to the seat holder,
   * the Run's own principal, the owner (`asOwner`: whoever the application layer lets act
   * with the owner's rights), the daemon, anyone under control 'open' — and anyone else
   * who finds the seat free, and takes it (ux-10; the application layer checks verbs).
   * A process Run that ended while members of its group live on is cancelled as a group
   * still (ss-10): the steps are reported, the recorded state stays.
   */
  async cancel(runId: string, principal: Principal, opts: { graceMs?: number; asOwner?: boolean } = {}): Promise<CancelResult> {
    const run = this.getRun(runId);
    this.requireCancel(run, principal, opts.asOwner === true);
    const steps: string[] = [];
    const grace = opts.graceMs ?? 500;
    if (run.target === 'process') {
      if (!isTerminal(run.state) || run.process?.groupAlive?.()) await this.cancelProcess(run, grace, steps, principal);
      if (!isTerminal(run.state)) run.cancelRequested = false; // core-14
      return { runId, state: run.state, contract: 'process', steps };
    }
    if (isTerminal(run.state)) return { runId, state: run.state, contract: 'shell', steps };
    if (run.strategy === 'inline' || run.shell !== undefined) return this.cancelDeclared(run, principal, grace, steps);
    if (run.state === 'queued') {
      // Not started: leave the terminal alone (the Run ahead is someone else's).
      const i = this.queue.indexOf(run);
      if (i !== -1) this.queue.splice(i, 1);
      steps.push('removed from the queue');
      this.endRun(run, { state: 'cancelled', reason: 'cancelled-before-start' });
      return { runId, state: run.state, contract: 'shell', steps };
    }
    // A line just written is normally started within milliseconds: let it, so the ^C
    // goes to its job. A ^C that reaches the shell itself while it prints its prompt
    // or runs its hooks can hang bash 3.2 (it longjmps out of a stdio write and leaves
    // the lock held; every later fork deadlocks), and zsh drops a ^C that arrives in
    // the same burst as the line.
    if (run.state === 'starting') await this.waitLeave(run, 'starting', grace);
    // Likewise its pre-execution mark comes from the shell's hook, before the job owns
    // the terminal: wait until the foreground group is the job (a builtin never is).
    if (run.state === 'running') await this.waitForegroundJob(run, grace);
    if (isTerminal(run.state)) return { runId, state: run.state, contract: 'shell', steps };
    run.cancelRequested = true;
    // ^C: the foreground job's interrupt — or, for a line the shell has not started,
    // the line editor's discard; the prompt that follows resolves it (A while pending).
    const sentWhile = run.state;
    this.typeSignal(run, 'SIGINT', principal);
    steps.push('^C');
    await this.awaitRun(runId, grace);
    if (run.state === 'starting' || (sentWhile === 'starting' && run.state === 'running')) {
      // The first ^C raced the line (dropped, or spent before the job started): one
      // more, at the line editor or to the job.
      this.typeSignal(run, 'SIGINT', principal);
      steps.push('^C');
      await this.awaitRun(runId, grace);
    }
    if (run.state === 'starting' && this.pendingShellRun === run) {
      // Two ^Cs and no mark of any kind: the line never started. The tty flushes unread input on a
      // SIGINT and the line editor drops a line it had read, so the line is gone either way — but
      // a shell whose ^C at an empty line prints nothing (fish) sends no prompt mark to say so,
      // and the Run was left `starting` for good, the cancel answering as if it had failed (CI at
      // cb603a8 on #22: a macOS runner under load). It ends cancelled here. A late start of the
      // line, were it ever read, is attributed as an orphan's (discardPending).
      //
      // The shell is not available yet: no mark says it acted on the ^Cs. A bash stopped or not yet
      // scheduled, or still in a DEBUG trap of the user's that ignores ^C, prints its prompt later;
      // counted available here, the next Run was written at once, discarded at that late prompt, and
      // its line ran after its command file was gone (the house's read of the 33 commits, #22 comment
      // 6307351617, item 1). It stays busy until the shell shows it is back, which askForPrompt asks.
      this.discardPending(run, { state: 'cancelled', reason: 'cancelled-before-start' });
      steps.push('the line was discarded before it started');
      const asked = await this.askForPrompt();
      const discarded = `${runId}: no mark followed two ^C; the line was discarded before it started`;
      if (asked === 'typed') {
        steps.push('an empty line, whose prompt says the shell is back');
        this.note(`${discarded}, and the shell counts as available again once it has run an empty line typed after the ^C, or at a prompt that does not read that line`);
      } else if (asked === 'answered') this.note(`${discarded}; the shell's prompt since says it is back`);
      else if (asked === 'gone') this.note(discarded);
      else {
        steps.push(`no empty line typed, since ${asked.why}: the shell is back at its next prompt`);
        this.note(`${discarded}. No empty line was typed to learn when the shell is back, since ${asked.why}: it counts as available again at its next prompt. Until then it is busy; if no prompt comes, read the screen to see what holds the terminal, then send it input, or close the session`);
      }
    }
    this.replacedStep(run, steps);
    if (run.state === 'running') await this.probeMarker(run, grace, steps);
    if (run.state === 'running') {
      this.typeSignal(run, 'SIGQUIT', principal);
      steps.push('^\\');
      await this.awaitRun(runId, grace);
    }
    // Then the terminal's foreground process group, when it is known and is a job —
    // never the shell itself (the daemon never kills the shell to cancel a job).
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      if (run.state !== 'running') break;
      const job = this.foregroundJob();
      if (job === undefined) break;
      this.append({ type: 'signal', signal: sig, principal, runId });
      const delivered = this.pty.signalGroup?.(job, sig) ?? false;
      steps.push(delivered ? `${sig} → foreground process group ${job}` : `${sig} → foreground process group ${job} (not delivered)`);
      await this.awaitRun(runId, sig === 'SIGKILL' ? grace * 2 : grace);
    }
    this.replacedStep(run, steps);
    if (run.state === 'running') await this.probeMarker(run, grace, steps);
    if (!isTerminal(run.state)) {
      // cancel: failed. A later natural end is reported as what it is (core-14).
      run.cancelRequested = false;
      return { runId, state: run.state, contract: 'shell', escalation: 'session_close', steps };
    }
    return { runId, state: run.state, contract: 'shell', steps };
  }

  /**
   * After a cancel's two ^Cs drew no mark (item 1): type a daemon line with an empty command file, and
   * count the shell available at the prompt that follows that line's pre-execution mark. The shell reads
   * the line only after what the terminal held before it, and that mark's line names its file, so the
   * prompt after it is the one that says the shell is back. Any earlier prompt is not: bash prints one for the
   * pending ^C when it is scheduled again; zsh 5.9, when the ^C flushed input it had been woken for,
   * prints one only once the next byte arrives (here the empty line's first); fish prints none for a ^C
   * at an empty line; and a line read before the ^C ends with a prompt of its own. An Enter drew one
   * prompt or two, by shell and by where the ^C caught it, with nothing to tell them apart, and a Run
   * written between the two was discarded at the second. Until the line's prompt the shell is busy, so
   * no Run is written behind it.
   *
   * The line is typed only when the shell's line editor holds the terminal (whyNotEditor): typed into a
   * program, or into a DEBUG trap of the user's that reads the terminal, the reader took it, and the shell
   * then sat at its prompt busy for good (the house's review of the 40 commits through f3750e4, #22
   * comment 6310921374, question 1). Otherwise nothing is typed, as when the file cannot be written, and
   * the shell's next prompt is its answer. Until a prompt comes the shell is busy as `cancel-unanswered`,
   * whose advice is to read the screen, send it input, or close the session: no bound frees it without a
   * prompt, since nothing else says the shell reads its editor again. Answers `typed`; or why nothing
   * was typed; `answered` when a prompt came while the terminal was read (the shell is back); `gone` when
   * the shell exited or was replaced, or the session is closing, meanwhile.
   */
  private async askForPrompt(): Promise<'typed' | 'answered' | 'gone' | { why: string }> {
    const waiting = { path: undefined, started: false, prompted: false };
    this.promptProbe = waiting;
    const why = await this.whyNotEditor();
    if (this.shellState === 'exited' || this.shellState === 'unavailable' || this.closing) return 'gone';
    if (this.promptProbe !== waiting) return 'answered';
    if (why !== undefined) return { why };
    this.resendReplies();
    let file: string;
    try {
      file = this.writeTempFile('', true);
    } catch (e) {
      this.note(`the empty line that asks the shell for its prompt could not be written (${errMessage(e)})`);
      return { why: 'its file could not be written' };
    }
    const src = sourceLine(file, this.flavor);
    this.extraTempFiles.add(file);
    this.promptProbe = { path: file, started: false, prompted: false };
    this.probeLine = { file: shellQuote(file), order: ++this.writeOrder };
    this.pty.write(`${CLEAR_LINE_KEYS}${src}\n`);
    return 'typed';
  }

  /**
   * Why a line typed now might not be the shell's line editor's to read, or undefined when it is: the
   * reinit gate's checks (onExecArmed). The mode the editors of bash, zsh and fish set at their prompt
   * (ICANON and ECHO off) on every one of EDITOR_SETTLE_READS reads over a short settle, since one read
   * just after the ^C varied (question 1), and then no process other than the shell that can read the
   * terminal. What the checks cannot answer is a reason too: unknown is not the editor.
   */
  private async whyNotEditor(): Promise<string | undefined> {
    for (let i = 0; i < EDITOR_SETTLE_READS; i++) {
      if (i > 0) await sleep(EDITOR_SETTLE_STEP_MS);
      const mode = this.pty.inputMode?.();
      if (mode === undefined) return 'its terminal mode could not be read';
      if (mode.canonical) return 'its terminal is in canonical mode, as while a program or a `read` waits for a line';
      if (mode.echo) return 'its terminal is non-canonical with echo on, as under `read -n`';
    }
    const reader = this.pty.otherReader?.();
    if (reader === undefined) return 'whether a process other than the shell reads its terminal could not be checked';
    return reader ? 'a process other than the shell holds its terminal for input' : undefined;
  }

  /**
   * The empty line's file goes at the prompt after its pre-execution mark, or once the session gave up on
   * it. This runs inside the prompt's handling, which must go on whatever the unlink does: a file that
   * cannot be removed now (the command directory made read-only, say) stays listed for the session's
   * cleanup at close, and its line runs nothing if it is read late, since the file is empty.
   */
  private dropPromptProbe(): void {
    const probe = this.promptProbe;
    clearTimeout(this.promptProbeTimer);
    this.promptProbeTimer = undefined;
    if (!probe) return;
    this.promptProbe = undefined;
    if (probe.path === undefined) return;
    try {
      fs.rmSync(probe.path, { force: true });
      this.extraTempFiles.delete(probe.path);
    } catch (e) {
      this.note(`the empty line's file ${probe.path} could not be removed (${errMessage(e)}); it is removed with the session's other files`);
    }
  }

  /**
   * A ^C's tty flush discards the input the shell has not read, the daemon's replies to its terminal
   * queries with it. fish 4.9 sends queries with each prompt and reads no key until the DA1 reply
   * comes: stopped across a cancel, whose empty line a later ^C flushed, it read nothing more, an Enter
   * included, until the session closed (found by run on macOS while answering the house's review of the
   * 40 commits through f3750e4, #22 comment 6310921374, question 1). So the replies written since the
   * shell's last prompt start go again after the ^Cs of a cancel that drew no mark, ahead of its empty
   * line, and after any ^C while the shell has not answered it — each time only once the checks that
   * gate the empty line say the line editor holds the terminal (whyNotEditor). Sent while a program or a
   * DEBUG trap's `read` holds it, they were that reader's input, and from before the prompt start they
   * could be a program's (an independent read of the fix for question 1). A shell that read them already
   * gets them twice: fish ignores a reply it did not ask for; bash and zsh, whose prompts send no queries
   * unless a theme does, would show one in the editor, which a daemon line's clear keys empty.
   */
  private resendReplies(): void {
    for (const reply of this.replies) this.writeReply(reply);
  }

  private async resendRepliesWhileUnanswered(): Promise<void> {
    const probe = this.promptProbe;
    if (!probe || probe.started || this.replies.length === 0) return;
    if ((await this.whyNotEditor()) !== undefined) return;
    if (this.promptProbe === probe && !probe.started && !this.closing && this.shellState !== 'exited') this.resendReplies();
  }

  private writeReply(reply: string): void {
    this.pty.write(reply);
    this.append({ type: 'input', data: reply, principal: SYSTEM, kind: 'protocol-reply' });
  }

  private requireCancel(run: RunRecord, principal: Principal, asOwner: boolean): void {
    if (principal === SYSTEM || this.control === 'open' || principal === this.controller || principal === run.principal || principal === this.owner || asOwner) return;
    // Anyone else acts through the seat: a free one is theirs (ux-10).
    this.requireSeat(principal, 'cancel');
  }

  /**
   * ss-4, during a cancel: nothing holds the foreground but the terminal's program, and that
   * is no longer the shell the Run was written to (an `exec` the integration did not see, or
   * one under the marker strategy): the Run's end can never be observed, and it ends lost.
   */
  private replacedStep(run: RunRecord, steps: string[]): void {
    if (run.state !== 'running' || this.foregroundJob() !== undefined) return;
    const now = this.pty.command?.();
    if (now === undefined || this.helloCommand === undefined || now === this.helloCommand) return;
    this.onShellReplaced(now);
    steps.push(`the shell was replaced by ${now}`);
  }

  private typeSignal(run: RunRecord, signal: 'SIGINT' | 'SIGQUIT', principal: Principal): void {
    this.append({ type: 'signal', signal, principal, runId: run.runId });
    this.pty.write(CONTROL_CHARS[signal]!);
  }

  /** Poll (bounded) until the terminal's foreground group is a job, the Run ends, or the backend cannot tell. */
  private async waitForegroundJob(run: RunRecord, ms: number): Promise<void> {
    const end = clocks.monotonic() + ms;
    while (run.state === 'running' && clocks.monotonic() < end) {
      const fg = this.pty.foreground?.();
      if (!fg || fg.foregroundPgid !== fg.shellPgid) return;
      await sleep(15);
    }
  }

  /** The terminal's foreground group when it is a job; undefined when it is the shell or unknown. */
  private foregroundJob(): number | undefined {
    const fg = this.pty.foreground?.();
    if (!fg || fg.foregroundPgid === fg.shellPgid) return undefined;
    return fg.foregroundPgid;
  }

  /**
   * Marker strategy: a ^C can abort the rest of the line in shells like dash, so the
   * marker echo never runs (core-6). Once the terminal's foreground group is the
   * shell's own again, the job is gone: type the marker alone, with the same nonce,
   * and its `$?` ends the Run. Residual risk: a shell builtin still running in the
   * shell's own process group (a `while` loop that ignores INT, a builtin `read`)
   * would take the probe line as input or run it later.
   */
  private async probeMarker(run: RunRecord, grace: number, steps: string[]): Promise<void> {
    if (run.strategy !== 'marker' || run.probed || !run.markerNonce || run.state !== 'running') return;
    const fg = this.pty.foreground?.();
    if (!fg || fg.foregroundPgid !== fg.shellPgid) return;
    run.probed = true;
    this.pty.write(`${markerProbe(run.markerNonce, this.flavor)}\n`);
    steps.push('end-marker probe');
    await this.awaitRun(run.runId, grace);
  }

  /** Signal the process group the daemon owns until it is empty, even after the leader exited (G29, tg-12). */
  private async cancelProcess(run: RunRecord, grace: number, steps: string[], principal: Principal): Promise<void> {
    const proc = run.process;
    if (!proc) return;
    run.cancelRequested = true;
    const alive = () => !isTerminal(run.state) || (proc.groupAlive?.() ?? false);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      if (!alive()) break;
      this.append({ type: 'signal', signal: sig, principal, runId: run.runId });
      proc.kill(sig);
      steps.push(`${sig} → process group`);
      const deadline = clocks.monotonic() + (sig === 'SIGKILL' ? grace * 4 : grace);
      await this.awaitRun(run.runId, deadline - clocks.monotonic());
      while (alive() && clocks.monotonic() < deadline) await sleep(20);
    }
  }

  /** `shell-exited (status N)` or `shell-exited (SIGNAL)`, from the shell's own exit. */
  private shellExitedReason(): string {
    const e = this.exitInfo;
    if (!e) return 'shell-exited';
    return `shell-exited (${e.signal ? e.signal : `status ${e.exitCode ?? '?'}`})`;
  }

  private teardownProcess(run: RunRecord): void {
    if (run.endReason !== undefined) return;
    run.endReason = this.closeReason ?? (this.shellState === 'exited' && !this.closing ? this.shellExitedReason() : 'session-closed');
    const p: Promise<void> = this.cancelProcess(run, 500, [], SYSTEM)
      .catch(() => undefined)
      .finally(() => this.teardowns.delete(p));
    this.teardowns.add(p);
  }

  getRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw err('run_not_found', `run ${runId} not found`, { runId });
    return run;
  }

  run(runId: string): RunInfo {
    return publicRun(this.getRun(runId));
  }

  /**
   * How long ago the Run was admitted, on the monotonic clock, for a hold or a window this daemon
   * life measures: against the journaled wall-clock stamp, a step forward ended a young service
   * Run's hold (a reviewer's read of the fixes for #22 comment 6270045466). Undefined for a Run this
   * session does not hold (pruned, or another daemon life's), whose only stamp is the journal's wall clock.
   */
  runAgeMs(runId: string): number | undefined {
    const r = this.runs.get(runId);
    return r === undefined ? undefined : clocks.monotonic() - r.admittedMono;
  }

  /**
   * How long a Run ran, or has run so far: the one rule for a Run's duration, so a run or await
   * result, a progress digest, a completion and a session-closed end agree. An ended Run's is the
   * duration its run.end journaled (RunInfo.durationMs); a Run in flight is measured like it, by
   * elapsedMs. Each reader computed its own from the wall clock, and a step back between the start
   * and the read made a result say `exited 0 in -2999ms` beside a completion's 2.5s (a reviewer's
   * read of the fixes for #22). Undefined for a Run this session does not hold in memory, whose
   * journaled duration its RunInfo carries.
   */
  runDurationMs(runId: string): number | undefined {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    return isTerminal(r.state) ? r.durationMs : this.elapsedMs(r);
  }

  /**
   * A Run's time since its start, or since its admission while it has not started: an interval, so on
   * the monotonic clock (the house's read of the 38 commits, #22, comment 6274773484: from the wall
   * clock, a step back journaled a negative duration and the completion read `exit 0 in -3.0s`).
   */
  private elapsedMs(r: RunRecord): number {
    return Math.max(0, Math.round(clocks.monotonic() - (r.startedMono ?? r.admittedMono)));
  }

  listRuns(): RunInfo[] {
    return [...this.runs.values()].map(publicRun);
  }

  /**
   * The Run's attributed output events (G12), with the journal's gap marker when retention
   * cut it; `range` narrows it (see RunOutputRange). A page costs what the page covers, not
   * the whole Run (er-11): the journal is read in bounded pages from the cursor, or from
   * the end backwards for `maxBytes`. The result equals narrowOutput over the whole Run.
   */
  runOutput(runId: string, range: RunOutputRange = {}): RunOutput {
    const run = this.getRun(runId);
    const from = run.seq.start ?? run.seq.admit;
    const to = run.seq.end ?? this.journal.lastSeq;
    return pageOutput(this.journal, runId, from, to, range);
  }

  /**
   * Transcript of a Run's output (§6), projected at the width the Run started at (er-4); the daemon's plumbing
   * is cut out. Where the Run's gaps say output was lost, the projection starts afresh (runChunks).
   */
  async runTranscript(runId: string): Promise<{ text: string; truncated: boolean; seq: [Seq, Seq]; nextCursor: Seq }> {
    const run = this.getRun(runId);
    // Results show the tail: only the newest part is read and projected, so a flood renders
    // in bounded time (emu-3, tg-4, er-11), visibly cut.
    const out = this.runOutput(runId, { maxBytes: TRANSCRIPT_INPUT_CHARS });
    const events = out.events as OutputEvent[];
    // The plumbing the launch strategy left in the output — the typed line's echo, the markers,
    // the probes a cancel typed — goes, by the Run's nonce, by the one rule history uses too
    // (core/plumbing.ts; the house's reads of 39787b3, #22). Process output comes from pipes (LF → CRLF, rule 6).
    const cut =
      run.target === 'shell' && run.strategy !== undefined
        ? (raw: string) => cutPlumbing(raw, { strategy: run.strategy, nonce: run.markerNonce, truncated: out.truncated, pid: run.shellPid !== undefined ? String(run.shellPid) : undefined })
        : undefined;
    const input = runChunks(events, out.gaps, cut);
    const p = await project(input, { cols: run.cols ?? this.screen.cols, rows: run.rows ?? this.screen.rows, maxInputBytes: TRANSCRIPT_INPUT_CHARS, keep: 'tail' });
    return { text: p.text, truncated: out.truncated || p.truncated, seq: [out.from, out.to], nextCursor: out.to };
  }

  // ───────────────────────────── terminal capabilities (G8) ─────────────────────────────

  /**
   * Type into the terminal exactly what is given; nothing appended (§11.1). Input typed
   * at a prompt that asks for a secret (m2-2) is journaled like input marked `sensitive`
   * (G26): redacted, and never promoted into a Run's line — until Enter or ^C.
   */
  input(data: string, opts: { principal: Principal; kind?: 'text' | 'keys' | 'paste'; sensitive?: boolean; asOwner?: boolean }): void {
    this.assertAlive();
    if (data.length === 0) throw err('invalid_argument', 'input needs text or keys: there is nothing to send');
    if (opts.principal !== SYSTEM) this.requireSeat(opts.principal, 'input', { asOwner: opts.asOwner === true });
    const sensitive = opts.sensitive === true || (opts.principal !== SYSTEM && (this.secretInput || this.atSecretPrompt()));
    if (sensitive && opts.principal !== SYSTEM) this.secretInput = !/[\r\n\x03]/.test(data);
    const ev: Parameters<Journal['append']>[0] = { type: 'input', data: sensitive ? '[redacted]' : data, principal: opts.principal, kind: opts.kind ?? 'text' };
    if (sensitive) ev.sensitive = true;
    const current = this.currentShellRun ?? this.pendingShellRun;
    if (current) ev.runId = current.runId;
    this.append(ev);
    if (opts.principal !== SYSTEM) {
      this.lastTyper = opts.principal;
      const layer = this.layers.at(-1);
      const atPrompt = (this.shellState === 'idle' && !this.currentShellRun && !this.pendingShellRun) || (layer !== undefined && !this.inFront.has(layer.within));
      this.typerPrompts = atPrompt ? 0 : 1;
      if (sensitive) this.sensitiveSinceCommand = true;
      if (!atPrompt) this.noteTypeahead(data, sensitive);
      this.noteEditing(data);
    }
    this.pty.write(data);
    if (data.includes('\x03')) void this.resendRepliesWhileUnanswered();
    // Send the user's clearing keys before giving a waiting declared Run its turn.
    const layer = this.layers.at(-1);
    if (layer) queueMicrotask(() => this.drainDeclared(layer.within));
    this.lastActivity = this.now();
    this.lastActivityMono = clocks.monotonic();
  }

  /**
   * m2-2: the text left of the cursor asks for a secret, and the shell's own line editor is
   * not what reads it (under rich integration an idle prompt is the editor: a PS1 that ends
   * in "token-service:" is not a password prompt).
   */
  private atSecretPrompt(): boolean {
    if (this.integrationLevel === 'rich' && this.shellState === 'idle' && !this.currentShellRun && !this.pendingShellRun) return false;
    // The last line printed (the screen may not have parsed it yet when an agent answers at once)…
    const last = stripEscapes(this.outputTail).text.split(/\n/).pop() ?? '';
    if (looksLikeSecretPrompt(last)) return true;
    // …or the text left of the cursor (a full-screen prompt such as pinentry's).
    const snap = this.screen.snapshot();
    const line = snap.lines[snap.cursor.y] ?? '';
    return looksLikeSecretPrompt(line.slice(0, snap.cursor.x));
  }

  /**
   * ss-1: keystrokes sent while a Run is in flight wait in the tty for whoever reads next —
   * the program, or the line editor at the next prompt. Lines submitted this way may run
   * ahead of a daemon line written later; a partial one may show in the editor.
   */
  private noteTypeahead(data: string, sensitive: boolean): void {
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!;
      if (c === '\r' || c === '\n') {
        const line = this.typeahead.trim();
        if (line && !sensitive) {
          this.typeaheadLines.push({ line, order: ++this.writeOrder });
          if (this.typeaheadLines.length > 16) this.typeaheadLines.shift();
        }
        this.typeahead = '';
      } else if (c === '\x03') {
        // The tty discards unread input on an interrupt.
        this.typeahead = '';
        this.typeaheadLines = [];
      } else if (c === '\x15') this.typeahead = '';
      else if (c === '\x7f' || c === '\b') this.typeahead = this.typeahead.slice(0, -1);
      else if (c === '\x1b') {
        // A key's escape sequence edits nothing we could follow: stop following this line.
        this.typeahead = '';
        const m = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)/.exec(data.slice(i));
        if (m) i += m[0].length - 1;
      } else if (c >= ' ' && !sensitive && this.typeahead.length < 4096) this.typeahead += c;
    }
    if (sensitive) this.typeahead = '';
  }

  /**
   * G4: a principal typing at an idle prompt is editing a command, and the shell is not
   * available until the line is submitted (the shell answers with C or A), cleared, or
   * left alone long enough to go stale. A declared prompt uses the same guard on explicit
   * input. The session's own basic/none integration has no prompt marks to clear it.
   */
  private noteEditing(data: string): void {
    const layer = this.layers.at(-1);
    const declaredPrompt = layer !== undefined && !this.inFront.has(layer.within);
    if (!declaredPrompt && (this.integrationLevel !== 'rich' || this.shellState !== 'idle' || this.pendingShellRun || this.currentShellRun)) return;
    const last = data[data.length - 1];
    const now = clocks.monotonic(); // the holds below are intervals: a wall-clock step must not move them (the house's read, #22 comment 6269901528)
    if (last === '\r' || last === '\n') {
      this.humanEditing = false;
      this.submittedAt = now;
    } else if (last === '\x03' || last === '\x15') {
      // The line is discarded. A ^C that discarded something is answered with a
      // prompt start; one at an empty prompt may be answered with nothing (fish), so
      // nothing is awaited then.
      const hadLine = this.humanEditing || this.staleLine || data.length > 1;
      this.humanEditing = false;
      this.staleLine = false;
      // At a declared prompt a ^U says nothing about a command already submitted: that hold stands
      // (following the old hint's ^U ended it and typed the Run into the person's program).
      if (last === '\x03' && hadLine) this.submittedAt = now;
      else if (!declaredPrompt) this.submittedAt = undefined;
    } else {
      this.humanEditing = true;
      this.editedAt = now;
    }
    this.armEditingTimer();
  }

  /**
   * SIGINT/SIGTSTP/SIGQUIT are typed as control characters (the terminal gives them to
   * the foreground job). Any other signal goes to the terminal's foreground process
   * group when that group is a job; signalling the shell itself is refused — that is
   * `session_close`. Unknown or empty names are invalid.
   */
  signal(signal: string, principal: Principal, opts: SeatOptions = {}): void {
    this.assertAlive();
    if (principal !== SYSTEM) this.requireSeat(principal, 'signal', opts);
    const name = normalizeSignal(signal);
    const current = this.currentShellRun ?? this.pendingShellRun;
    const ev: Parameters<Journal['append']>[0] = { type: 'signal', signal: name, principal };
    if (current) ev.runId = current.runId;
    const c = CONTROL_CHARS[name];
    if (c !== undefined) {
      this.append(ev);
      this.pty.write(c);
      if (name === 'SIGINT') void this.resendRepliesWhileUnanswered();
      return;
    }
    const fg = this.pty.foreground?.();
    if (!fg) throw err('unsupported', `${name} goes to the terminal's foreground job, which the ${this.backend.kind} backend cannot observe`);
    if (fg.foregroundPgid === fg.shellPgid) {
      throw err('invalid_argument', `no foreground job to receive ${name}: it would signal the session's shell itself (end the shell with session_close)`, { signal: name });
    }
    this.append(ev);
    if (!this.pty.signalGroup?.(fg.foregroundPgid, name)) {
      // Why, as far as the backend can tell: a group that still answers was not ours to signal
      // (EPERM: a job running as another user), not one that ended (the house's read of a6d0c35, #22).
      const alive = this.pty.groupAlive?.(fg.foregroundPgid);
      const why = alive === true ? 'not permitted: the job runs as another user' : alive === false ? 'the job ended' : 'the backend cannot say why';
      this.note(`${name} to process group ${fg.foregroundPgid} was not delivered (${why})`);
    }
  }

  resize(cols: number, rows: number, principal: Principal, opts: SeatOptions = {}): void {
    this.assertAlive();
    if (principal !== SYSTEM) this.requireSeat(principal, 'resize', opts);
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
    this.append({ type: 'resize', cols, rows, principal });
  }

  /** The current screen (G14). Never touches the PTY. */
  snapshot(): ScreenSnapshot {
    return this.screen.snapshot();
  }

  /**
   * Capture the shell's environment for later process Runs (§8.2): `env -0` as a shell
   * Run, written to a file rather than the terminal, so the values never pass through
   * the journal's raw output. The daemon's credential names are dropped before the
   * snapshot is journaled (G26). It types into the shell like any run, so it needs the
   * seat like any run (api-3).
   */
  async captureEnv(principal: Principal, waitMs = 10_000, opts: SeatOptions = {}): Promise<EnvSnapshot> {
    this.assertAlive();
    if (principal !== SYSTEM && this.control !== 'open') this.requireSeat(principal, 'run', opts);
    const out = path.join(this.tempDir, `tsm-env-${process.pid}-${this.safeId}-${++this.tempCounter}.bin`);
    this.extraTempFiles.add(out);
    const admitted = await this.admitWhenAvailable({ target: 'shell', line: `env -0 > ${shellQuote(out)}`, principal, internal: true, origin: 'system' });
    if (!admitted.admitted) throw err('busy', `shell not available: ${admitted.reason}`, { reason: admitted.reason });
    const run = await this.awaitRun(admitted.run.runId, waitMs);
    if (run.state !== 'exited') throw err('timeout', `env capture did not complete (${run.state})`, { runId: run.runId });
    const discard = () => {
      fs.rmSync(out, { force: true });
      this.extraTempFiles.delete(out);
    };
    if (run.exit !== 0) {
      // A capture that failed (no `env` on the PATH, a full disk) leaves an empty or cut file: not a
      // snapshot (the house's read of a6d0c35, #22: process Runs would have started with no environment).
      discard();
      throw err('backend_failure', `env capture failed: env -0 exited ${run.exit ?? '?'}`, { runId: run.runId });
    }
    let text: string;
    try {
      text = fs.readFileSync(out, 'utf8');
    } catch (e) {
      throw err('backend_failure', `env capture produced no output (exit ${run.exit ?? '?'}): ${errMessage(e)}`, { runId: run.runId });
    } finally {
      discard();
    }
    const vars = redactSnapshot(parseEnvNul(text));
    // The values stay in memory: nothing reads them back from the journal (after a restart the
    // configured basis serves, and says so), so journaling them only kept a copy of the
    // environment on disk (the house's review of #11, core finding 5). The event records that a
    // capture happened, and how many variables it held.
    const ev = this.append({ type: 'env.snapshot', count: Object.keys(vars).length });
    this.envSnapshot = { vars, seq: ev?.seq ?? this.journal.lastSeq, capturedAt: ev?.ts ?? this.now() };
    return this.envSnapshot;
  }

  // ───────────────────────────── control and attachments (G16–G18) ─────────────────────────────

  attach(principal: Principal, connectionId: string, role: AttachmentRole | 'auto' = 'auto'): Attachment {
    const attachmentId = `a${++this.attachCounter}`;
    let actual: AttachmentRole = 'observer';
    if (role === 'controller' || (role === 'auto' && principal === this.owner)) {
      if (this.controller === null || this.controller === principal) {
        if (this.controller === null) this.setController(principal, principal, 'auto');
        actual = 'controller';
      } else if (role === 'controller') {
        throw err('not_controller', `seat held by ${this.controller}`, { controller: this.controller });
      }
    }
    if (this.controller === principal) {
      // The holder is back (a reconnect within the grace): the seat was kept for it.
      this.clearSeatReservation();
      actual = 'controller';
    }
    const att: Attachment = { attachmentId, principal, role: actual, connectionId };
    this.attachments.set(attachmentId, att);
    if (!this.cursors.has(principal)) this.cursors.set(principal, { delivered: 0, read: 0 });
    this.append({ type: 'attach', attachmentId, principal, role: actual });
    return att;
  }

  /** `keepSeat: false` (a connection closed on purpose) releases a held seat at once; a dropped one keeps it through the grace. */
  detach(attachmentId: string, opts: { keepSeat?: boolean } = {}): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    this.attachments.delete(attachmentId);
    this.append({ type: 'detach', attachmentId, principal: att.principal });
    if (this.controller !== att.principal || [...this.attachments.values()].some((a) => a.principal === att.principal)) return;
    // The holder's last attachment went away. Keep the seat for it through a short
    // grace (a reconnect gets it back); others cannot take it meanwhile, except the
    // owner's override under owner-priority.
    const grace = this.opts.seatGraceMs ?? 30_000;
    if (grace <= 0 || opts.keepSeat === false || this.shellState === 'exited' || this.closing) {
      this.setController(null, att.principal, 'release');
      return;
    }
    this.clearSeatReservation();
    const principal = att.principal;
    const timer = setTimeout(() => {
      this.seatReserved = undefined;
      if (this.controller === principal && ![...this.attachments.values()].some((a) => a.principal === principal)) this.setController(null, principal, 'release');
    }, grace);
    timer.unref();
    // The reservation's hold is `timer` (a setTimeout, which a wall-clock step never moves); `until`
    // is only the wall-clock instant it is shown and reported as (reservedNote, seatReservedUntil),
    // so it stays on `this.now()` — it is a displayed timestamp, never compared as an interval (the
    // house's read, #22 comment 6269901528).
    this.seatReserved = { principal, until: this.now() + grace, timer };
  }

  private clearSeatReservation(): void {
    if (this.seatReserved) clearTimeout(this.seatReserved.timer);
    this.seatReserved = undefined;
  }

  /**
   * Take the seat (G17): a free seat is anyone's; a held one only the owner's — the owner
   * override, under every policy, so the owner is never locked out (ux-10). `asOwner`: the
   * application layer lets this principal act with the owner's rights (the owner's own GUI
   * human, tsg-13).
   */
  takeControl(principal: Principal, opts: SeatOptions = {}): void {
    if (this.controller === principal) return this.clearSeatReservation();
    if (this.controller === null) return this.setController(principal, principal, 'take');
    if (principal === this.owner || opts.asOwner === true) return this.setController(principal, principal, 'override');
    throw err('not_controller', `seat held by ${this.controller}${this.reservedNote()}: ask ${this.controller} to release it, or the owner (${this.owner}) to take it over`, {
      controller: this.controller,
    });
  }

  releaseControl(principal: Principal): void {
    if (this.controller !== principal) return;
    this.setController(null, principal, 'release');
  }

  private setController(controller: Principal | null, by: Principal, how: 'take' | 'release' | 'override' | 'auto'): void {
    if (this.seatReserved && this.seatReserved.principal !== controller) this.clearSeatReservation();
    this.controller = controller;
    this.append({ type: 'control', controller, by, how });
    for (const a of this.attachments.values()) a.role = a.principal === controller ? 'controller' : 'observer';
  }

  get currentController(): Principal | null {
    return this.controller;
  }

  /**
   * The seat check for run, input, signal, resize and cancel (G17, §9). Nobody needs a
   * `control` call in the common flow (ux-10): a free seat is taken by whoever acts first
   * (journaled as control how:'auto'); the owner takes a held seat over under owner-priority,
   * and under any policy from a holder whose connection dropped (a reserved seat never locks
   * the owner out). A seat held by someone else refuses, saying who holds it and what to do.
   */
  private requireSeat(principal: Principal, verb: string, opts: SeatOptions = {}): void {
    if (this.controller === principal) return;
    if (this.controller === null) {
      this.setController(principal, principal, 'auto');
      return;
    }
    const owner = principal === this.owner || opts.asOwner === true;
    const holderAway = this.seatReserved !== undefined && this.seatReserved.principal === this.controller;
    if (owner && (this.control === 'owner-priority' || holderAway)) {
      this.setController(principal, principal, 'override');
      return;
    }
    const next = owner
      ? `as the owner you can take it over (control take), or ask ${this.controller} to release it`
      : `ask ${this.controller} to release it (control release), or wait until it is free`;
    throw err('not_controller', `${verb} requires the controller seat, held by ${this.controller}${this.reservedNote()}: ${next}`, {
      controller: this.controller,
      verb,
    });
  }

  private reservedNote(): string {
    return this.seatReserved ? ` (reserved while it reconnects, until ${new Date(this.seatReserved.until).toISOString()})` : '';
  }

  listAttachments(): Attachment[] {
    return [...this.attachments.values()];
  }

  // ───────────────────────────── cursors (G22, G28) ─────────────────────────────

  cursorsOf(principal: Principal): Cursors {
    let c = this.cursors.get(principal);
    if (!c) this.cursors.set(principal, (c = { delivered: 0, read: 0 }));
    return c;
  }

  markRead(principal: Principal, seq: Seq): void {
    const c = this.cursorsOf(principal);
    if (seq > c.read) {
      c.read = seq;
      this.opts.onCursors?.(principal, { ...c });
    }
  }

  markDelivered(principal: Principal, seq: Seq): void {
    const c = this.cursorsOf(principal);
    if (seq > c.delivered) {
      c.delivered = seq;
      this.opts.onCursors?.(principal, { ...c });
    }
  }

  /** Every principal's cursors, for persistence. */
  cursorsSnapshot(): Record<Principal, Cursors> {
    return Object.fromEntries([...this.cursors].map(([p, c]) => [p, { ...c }]));
  }

  /** Record that a synchronous call returned this Run's final outcome to `principal` (G28); for a service status a start result carried, the key is `serviceOutcomeKey`. */
  markOutcomeDelivered(runId: string, principal: Principal): void {
    let s = this.outcomeDelivered.get(runId);
    if (!s) this.outcomeDelivered.set(runId, (s = new Set()));
    s.add(principal);
  }

  outcomeDeliveredTo(runId: string, principal: Principal): boolean {
    return this.outcomeDelivered.get(runId)?.has(principal) ?? false;
  }

  // ───────────────────────────── info ─────────────────────────────

  get integration(): IntegrationLevel {
    return this.integrationLevel;
  }

  get state(): ShellState | 'tui' {
    if (this.shellState === 'busy' && this.screen.alt) return 'tui';
    return this.shellState;
  }

  get cwd(): string {
    return this.cwdPath;
  }

  get exit(): PtyExit | undefined {
    return this.exitInfo;
  }

  get pid(): number {
    return this.pty.pid;
  }

  info(): SessionInfo {
    const current = this.currentShellRun ?? this.pendingShellRun;
    const info: SessionInfo = {
      id: this.id,
      owner: this.owner,
      visibility: this.visibility,
      control: this.control,
      controller: this.controller,
      state: this.state,
      integration: this.integrationLevel,
      cwd: this.cwdPath,
      cols: this.screen.cols,
      rows: this.screen.rows,
      backend: this.backend.kind,
      pid: this.pty.pid,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      currentRun: current ? current.runId : null,
      queued: this.queue.length,
      attachments: this.attachments.size,
      lastSeq: this.journal.lastSeq,
    };
    if (this.seatReserved) info.seatReservedUntil = this.seatReserved.until;
    const layer = this.layers.at(-1);
    if (layer) info.declared = { shell: layer.shell, within: layer.within };
    return info;
  }

  private assertAlive(): void {
    if (this.shellState === 'exited') throw err('session_exited', `session ${this.id} has exited`);
  }
}

/** A real directory (not a link) of ours, closed to others: the only kind the daemon trusts in /tmp (§8.1). */
export function trustedDir(d: string, uid: number): boolean {
  try {
    const st = fs.lstatSync(d);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function isTerminal(state: RunState): boolean {
  return state === 'exited' || state === 'cancelled' || state === 'lost';
}

/**
 * The key under which the service status event (`seq`) a start result carried counts as delivered
 * (G28, mcpl-13): that one event, so a later return to the same status is announced as usual (the
 * house's read of 2f357bd, #22). Spelled here, once, for the App that marks it and the lane that asks.
 */
export const serviceOutcomeKey = (runId: string, status: string, seq: Seq): string => `${runId}:service=${status}@${seq}`;
