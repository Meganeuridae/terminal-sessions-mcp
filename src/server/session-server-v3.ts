/**
 * Session Server v3 - Persistent Shell Sessions
 * 
 * Features:
 * - Real persistent shell sessions using node-pty
 * - Environment variable persistence
 * - Working directory persistence
 * - Interactive input support
 * - Signal handling (SIGINT, SIGTERM)
 */

import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildInputData } from './keys';

interface SessionInfo {
  id: string;
  name: string;
  shell: IPty;
  logs: string[];
  cwd: string;
  env: Record<string, string>;
  isAlive: boolean;
  createdAt: Date;
  lastActivity: Date;
  outputBuffer: string;
  isProcessingCommand: boolean;
  commandQueue: Array<QueuedCommand>;
  currentCommand?: QueuedCommand;
  currentTimeout?: NodeJS.Timeout;
  lineBuffer: string; // Buffer for incomplete lines
  // Temp files of commands written to the shell that it may still source, by
  // nonce, in the order they were written. A file is deleted when its own exit
  // marker arrives, when a later command's start marker shows the shell has
  // read past its line, or when the shell or the session goes away. A caller
  // timeout proves nothing about the file: the timed-out command may still be
  // running, and commands written after it wait in the tty as typeahead until
  // the shell reads and sources them.
  pendingFiles: Map<string, string>;
  // Every command written to this shell: its nonce → its temp-file path as
  // typed (and the set of those paths, for lookup). Exactly these commands'
  // typed lines' echoes (probe, wrapper and inline parts) and printed start,
  // exit, no-file and gone markers are exec plumbing, removed wherever they
  // appear while the command is remembered (see
  // rememberIssued), so a command that prints them back (`history`, a reader
  // that received a typed wrapper) loses those spans too. Marker-shaped text
  // carrying any other nonce is output and is never filtered.
  issued: Map<string, string>;
  issuedPaths: Set<string>;
  // Commands written to this shell whose exit marker hasn't arrived, in the
  // order they were written, each with whether it has started. An earlier
  // command's exit marker ends the started ones written after it, which ran
  // in a shell it started (see finishUnfinished). A command given up before
  // its body ran leaves too (see dropUntyped). One whose exit marker never
  // prints stays: a line cut short by Ctrl-C (bash 4 and later drop the rest
  // of it) until an earlier command's exit marker takes it out, and a
  // typed-ahead line the interrupt discarded, which never started, for the
  // rest of the session.
  unfinished: Map<string, boolean>;
  // Commands whose body has been typed inline (see typeBodyInline), so a
  // marker scanned again can't type it twice; forgotten with their command
  // (see rememberIssued).
  typedInline: Set<string>;
  // The lines of a body typed inline still to type, by command, with the
  // index of the next: 0 while the body waits its turn (see inlineQueue),
  // then each is typed once the shell has printed the piece marker of the
  // one before (see typeNextPiece); forgotten with their command, or when it
  // is given up.
  inlinePieces: Map<string, { lines: string[]; next: number }>;
  // Commands whose no-file marker has arrived and whose body hasn't yet
  // started in the shell in front, or been given up, in the order the
  // markers arrived. The first has its lines being typed, the rest wait
  // their turn (see typeBodyInline), so that shell gets one body at a time,
  // the bodies in the order their commands were written.
  inlineQueue: string[];
  // How many lines the server has typed for its commands (probe lines and
  // the lines of bodies typed inline), and for each command still
  // remembered, the number of the last line typed for it (see typeLine). The
  // shell reads its terminal in order, so a marker printed by a line typed
  // after another shows that the other was read, or taken, first (see
  // releaseStuckInline).
  typedCount: number;
  lineSeq: Map<string, number>;
  // The last characters checkCommandCompletion scanned after its last marker
  // or newline, at most 63, enough to hold the start of a marker split across
  // chunks. They're kept apart from outputBuffer, which is cleared whenever a
  // command is written, so a marker split across that moment is recognized.
  scanCarry: string;
  // This session's commands' markers recognized whose line hasn't ended yet,
  // in the order printed, each kind and nonce once.
  awaitingMarkers: Marker[];
  // The latest command whose probe line the server has typed or holds, until
  // it starts (its start or exit marker) or is given up (see dropUntyped).
  // Until then, input written to the terminal can reach the shell in front
  // instead of the command: a shell that can't read the temp file reads
  // input typed after the probe line, or between the lines of the body typed
  // for it, as part of its own command lines. So sendInput refuses input
  // meanwhile, as it does while any body goes in (see typingHolds).
  typingFor?: string;
  // When the server last typed a line for a command (see typeLine) or acted
  // on a marker (see actOnMarker). Input written by sendInput doesn't count.
  typingProgressAt: number;
  // Commands that hadn't started when a ^C was written, and that it didn't
  // give up (see interruptTyping). A mark acts only at a no-file marker, which
  // then gives the command up rather than typing its body (see
  // typeBodyInline): its shell needed the body typed, and the ^C came first.
  // A command whose shell reads its file starts and runs, and its start
  // marker takes the mark away. One whose line the ^C discarded never
  // answers, and its own timeout answers its caller. A mark goes at its
  // command's start or exit marker, or when the command is given up (see
  // dropUntyped).
  interruptedProbes: Set<string>;
}

// A start, exit, no-file, gone or piece marker the shell printed (see
// checkCommandCompletion), with the exit marker's status or the piece
// marker's index.
type Marker = { kind: 'start' | 'exit' | 'nofile' | 'gone' | 'piece'; nonce: string; code?: number; index?: number };

// What one marker's handling gave up (see actOnMarker): the reason the waiting
// command, if it was among them, is answered with afterwards.
type GivenUp = { current?: string };

interface QueuedCommand {
  command: string;
  resolve: (result: CommandResult) => void;
  startTime: number;
  timeout: number;
  nonce: string;
  // Set when the shell prints this command's start marker: execution began.
  started?: boolean;
  // Its probe line, held back while a body for the shell in front is going in
  // (see typeHeldProbe); typed once that body is in, when it makes no
  // progress for HELD_PROBE_MAX_MS (probeTimer), or at this command's timeout.
  probe?: string;
  probeTimer?: NodeJS.Timeout;
}

interface CommandResult {
  output: string;
  exitCode: number;
  duration: number;
}

interface ServiceStartOptions {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  readyPatterns?: string[];
  errorPatterns?: string[];
  shell?: string;
}

type PublicSessionInfo = {
  id: string;
  name: string;
  cwd: string;
  env: Record<string, string>;
  isAlive: boolean;
  createdAt: Date;
  lastActivity: Date;
  logSize: number;
};

type SessionEventMap = {
  'session:created': {
    sessionId: string;
    info: PublicSessionInfo;
  };
  'session:output': {
    sessionId: string;
    chunk: string;
    lines: string[];
    timestamp: Date;
  };
  'session:exit': {
    sessionId: string;
    exitCode: number | null;
    timestamp: Date;
  };
  'command:start': {
    sessionId: string;
    command: string;
    startedAt: Date;
  };
  'command:finished': {
    sessionId: string;
    command: string;
    duration: number;
    exitCode: number;
    output: string;
    finishedAt: Date;
  };
  'session:input': {
    sessionId: string;
    input: string;
    appendNewline: boolean;
    keys?: string[];
    timestamp: Date;
  };
  'session:signal': {
    sessionId: string;
    signal: string;
    timestamp: Date;
  };
};

/**
 * The shell's echo of a typed wrapper can be soft-wrapped anywhere, not only
 * between its parts: where the echoed line reaches the terminal's right edge,
 * readline writes a wrap artifact (bash 3.2 on macOS: a space and a carriage
 * return; other versions may move the cursor with an escape sequence). The
 * wrapper-echo patterns therefore allow such an artifact between any two
 * characters of the typed line, at the seams between its parts, and after its
 * last character. Printed markers are program output, which the terminal
 * wraps without inserting anything, so they need no such tolerance.
 */
const WRAP_ONE = ' ?\\r|\\x1b\\[[0-9;]*[A-Za-z]';
const WRAP = `(?:${WRAP_ONE})*`;
const wrapTolerant = (literal: string) =>
  [...literal].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(WRAP);
const NONCE = `((?:[0-9a-z]|${WRAP_ONE})+)`;
const START_ECHO = new RegExp(
  wrapTolerant('echo "<<<STAR""T:') + NONCE + wrapTolerant('>>>"') + `(?:${WRAP};)?(?:${WRAP} )?${WRAP}`, 'g');
const SOURCE_ECHO = new RegExp(
  wrapTolerant(". '") + "([^']*)'" + `(?:${WRAP};)?(?:${WRAP} )?${WRAP}`, 'g');
// A typed line that ends exactly at the terminal's right edge is followed by
// readline moving the cursor back and writing the line's last character again
// (bash 5.2: ` \r`, ESC[A, ESC[C repeated, ESC[K, then the character), so the
// patterns for a line's last part take that character once more.
const lastAgain = (character: string) => `(?:(?:${WRAP_ONE})+${character})?`;
const EXIT_ECHO = new RegExp(
  wrapTolerant('echo "<<<EXI""T:') + NONCE + wrapTolerant(':$?>>>"') + lastAgain('"') + `${WRAP}(\\r?\\n)?`, 'g');
// The parts a probe line (see probeLine) and an inline line (see inlinePiece)
// add around a wrapper. A nonce after the one a pattern captures.
const NONCE_AGAIN = `(?:[0-9a-z]|${WRAP_ONE})+`;
const PROBE_HEAD = new RegExp(
  wrapTolerant("if [ -r '") + "([^']*)'" + WRAP + wrapTolerant(' ]; then ') + WRAP, 'g');
const PROBE_TAIL = new RegExp(
  wrapTolerant('; else __tsm_') + NONCE + wrapTolerant('=$$; echo "<<<NOFIL""E:') + NONCE_AGAIN +
  wrapTolerant('>>>"; fi') + lastAgain('i') + `${WRAP}(\\r?\\n)?`, 'g');
// The check that opens every inline line, with the length check a line after
// the body's first adds (see inlinePiece).
const INLINE_IF = new RegExp(
  wrapTolerant('if [ "${__tsm_') + NONCE + wrapTolerant('-}" = "$$" ]') + WRAP +
  `(?:${wrapTolerant(' && [ "${__tsm_')}${NONCE_AGAIN}${wrapTolerant('_b+set}" = set ] && [ "${#__tsm_')}${NONCE_AGAIN}${wrapTolerant('_b}" = "')}(?:[0-9]|${WRAP_ONE})+${wrapTolerant('" ]')}${WRAP})?` +
  wrapTolerant('; then ') + WRAP, 'g');
const PIECE_ECHO = new RegExp(
  wrapTolerant('echo "<<<PIEC""E:') + NONCE + wrapTolerant(':') + `(?:[0-9]|${WRAP_ONE})+` + wrapTolerant('>>>"') +
  `(?:${WRAP};)?(?:${WRAP} )?${WRAP}`, 'g');
// The tail's `; ` may already have gone with the assignment or piece echo
// before it, on a line that only adds to the body.
const INLINE_TAIL = new RegExp(
  `(?:${WRAP};)?(?:${WRAP} )?${WRAP}` + wrapTolerant('else echo "<<<GON""E:') + NONCE + wrapTolerant('>>>"; fi') +
  lastAgain('i') + `${WRAP}(\\r?\\n)?`, 'g');
// The body variable set to a piece of the escaped body, or to what it held
// followed by one.
const ASSIGN_ECHO = new RegExp(
  wrapTolerant('__tsm_') + NONCE + wrapTolerant('_b') + WRAP + '=' + WRAP +
  `(?:${wrapTolerant('"$__tsm_')}${NONCE_AGAIN}${wrapTolerant('_b"')}${WRAP})?` + "'[^']*'" + `(?:${WRAP};)?(?:${WRAP} )?${WRAP}`, 'g');
const EVAL_ECHO = new RegExp(
  wrapTolerant('eval "unset __tsm_') + NONCE + wrapTolerant(' __tsm_') + NONCE_AGAIN + wrapTolerant(`_b; $(printf '%b' "$__tsm_`) +
  NONCE_AGAIN + wrapTolerant('_b")"') + `(?:${WRAP};)?(?:${WRAP} )?${WRAP}`, 'g');
const WRAP_ARTIFACT = new RegExp(WRAP_ONE, 'g');
/** A captured nonce or path with any wrap artifacts removed. */
const unwrap = (captured: string) => captured.replace(WRAP_ARTIFACT, '');
/**
 * Whether a captured path, wrap artifacts removed, is one `issued` holds.
 * Where it has spaces, a bare carriage return after one of them could be an
 * artifact on its own or the end of bash 3.2's space-and-return, so both
 * readings are tried.
 */
const capturedIn = (issued: Set<string>, captured: string) =>
  issued.has(unwrap(captured)) || issued.has(captured.replace(/\r|\x1b\[[0-9;]*[A-Za-z]/g, ''));

/**
 * A command body as the single-quoted argument of `printf '%b'`, which POSIX
 * shells decode back to the body's bytes (a command substitution then drops
 * its trailing newlines; see inlinePiece): backslashes doubled, newlines
 * and tabs as \n and \t, and single quotes, `!`, other control characters
 * and non-ASCII bytes as \0NNN octal. The typed lines are then lines of
 * printable ASCII with no single quote in the argument, so readline has
 * nothing to act on (a tab would start completion, a newline would end the
 * line, and older bash may expand a `!`), and nothing ends the argument early.
 * The escaped text can be cut anywhere, inside an escape too, since the shell
 * decodes it only once it is whole again (see inlineLines).
 */
const printfBody = (body: string): string => {
  let escaped = '';
  for (const byte of Buffer.from(body, 'utf8')) {
    if (byte === 0x5c) escaped += '\\\\';
    else if (byte === 0x0a) escaped += '\\n';
    else if (byte === 0x09) escaped += '\\t';
    else if (byte === 0x27 || byte === 0x21 || byte < 0x20 || byte >= 0x7f) escaped += '\\0' + byte.toString(8).padStart(3, '0');
    else escaped += String.fromCharCode(byte);
  }
  return escaped;
};

/**
 * The longest line typed into a shell that can't read the temp files, in
 * bytes. A shell reading without a line editor gets a line cut at its tty's
 * canonical limit (1,024 bytes on macOS, 4,095 on Linux), and so does a line
 * typed before readline is back at its prompt. A cut line loses its end, and
 * can leave the shell inside an open quote that takes in what is typed next.
 * A body whose line would be longer goes in pieces, each a line under this
 * limit (see inlineLines), typed one at a time: each line after the first is
 * typed once the shell has printed the piece marker of the one before, so
 * the shell is at its prompt, with none of the body's other lines queued,
 * whenever one reaches it (see typeNextPiece), and the next command's probe
 * line, due when a command times out, is held back until the body is in, has
 * gone two seconds without a line typed, or the waiting command's own timeout
 * passes (see typeHeldProbe): a probe typed between two pieces left zsh's and
 * bash 3.2's line editors redrawing a piece without reading it to its end,
 * now and then. The tty itself would take the lines
 * together, making the writer wait when its queue is full rather than
 * cutting a complete line, but a line editor fed several long lines at once
 * is not safe: bash 3.2's readline, given the fourth of a body's lines while
 * still redrawing the third, redrew that line's start over and over without
 * ever reading it to its end.
 */
const INLINE_LINE_MAX = 1000;
/**
 * The most lines a body typed inline may take, so a body passed in by
 * mistake, such as a whole file, isn't fed to the shell in front for
 * minutes with no way to stop it short of killing the session. A body that
 * would take more isn't typed (see typeBodyInline).
 */
const INLINE_PIECES_MAX = 128;
/**
 * How long a held probe line (see typeHeldProbe) waits for the body going in
 * to make progress, in ms, counted from the hold's start, or from the last
 * line typed for a body since then (see armHeldProbe). A shell reading a
 * body's lines answers each within a round trip, so a body silent this long
 * is taken to have lost its line to something else reading the terminal,
 * and the probe is typed: its marker
 * is what shows the body stuck (see releaseStuckInline), and the commands
 * behind it keep their order. Over a link whose round trip is longer than
 * this, the probe is typed between the body's lines, the case the hold is
 * there to avoid. sendInput's refusal of input while a command is on its way
 * in lapses after the same time with no line typed and no marker read (see
 * typingHolds), and over such a link it lapses between the body's lines too.
 */
const HELD_PROBE_MAX_MS = 2000;
/**
 * The reason a ^C gives up a command with when its body isn't all typed in
 * (see interruptTyping).
 */
const INTERRUPTED_BODY = '[command not run: interrupted before its body was all typed in]';

export class PersistentSessionServer extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();
  private readonly maxLogSize = 10000; // lines per session
  private readonly maxOutputBufferSize = 100 * 1024 * 1024; // 100MB max buffer size
  private readonly defaultCommandTimeout = 30000; // 30 seconds default
  private tempFileCounter = 0;

  /**
   * Auth token for the web GUI (same token as the session server).
   * Used by takeScreenshot so its headless browser can authenticate.
   */
  guiAuthToken?: string;

  constructor() {
    super();
    // Clean up on exit. An 'exit' listener runs only synchronous code, so the
    // pending temp files are removed here: killAll's own cleanup waits on a
    // timer that never fires once the process is exiting.
    process.on('exit', () => {
      for (const session of this.sessions.values()) this.cleanupTempFiles(session);
      this.killAll();
    });
    process.on('SIGINT', () => {
      this.killAll();
      process.exit(0);
    });
  }

  /**
   * Create a new shell session
   */
  async createSession(id: string, options: { cwd?: string; env?: Record<string, string>; shell?: string } = {}): Promise<string> {
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }

    const shell = options.shell || (process.platform === 'win32' ? 'wsl.exe' : '/bin/bash');
    const cwd = options.cwd || process.cwd();
    const env = { ...process.env, ...options.env };

    // For WSL, we need to tell it to run bash in Ubuntu specifically
    const shellArgs = shell === 'wsl.exe' ? ['-d', 'Ubuntu', 'bash'] : [];

    // Create PTY instance
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',  // Modern terminal with full mouse tracking support
      cwd,
      env,
      cols: 120,
      rows: 30
    });

    const sessionInfo: SessionInfo = {
      id,
      name: id,
      shell: ptyProcess,
      logs: [],
      cwd,
      env: options.env || {},
      isAlive: true,
      createdAt: new Date(),
      lastActivity: new Date(),
      outputBuffer: '',
      isProcessingCommand: false,
      commandQueue: [],
      lineBuffer: '',
      pendingFiles: new Map(),
      issued: new Map(),
      issuedPaths: new Set(),
      unfinished: new Map(),
      typedInline: new Set(),
      inlinePieces: new Map(),
      inlineQueue: [],
      typedCount: 0,
      lineSeq: new Map(),
      scanCarry: '',
      awaitingMarkers: [],
      typingProgressAt: 0,
      interruptedProbes: new Set()
    };

    // Handle output
    ptyProcess.onData((data: string) => {
      sessionInfo.lastActivity = new Date();
      sessionInfo.outputBuffer += data;
      
      // Prevent unbounded buffer growth - trim to last portion if too large
      if (sessionInfo.outputBuffer.length > this.maxOutputBufferSize) {
        // Keep the last half of the max size to avoid constant trimming
        sessionInfo.outputBuffer = sessionInfo.outputBuffer.slice(
          -Math.floor(this.maxOutputBufferSize / 2)
        );
      }
      
      // Buffer characters and only log complete lines
      sessionInfo.lineBuffer += data;
      
      // Process any complete lines in the buffer
      const segments = sessionInfo.lineBuffer.split(/\r?\n/);
      const completedLines: string[] = [];
      
      // All but the last element are complete lines. Exec plumbing (the
      // echoed `. '<tempfile>'; echo ...` wrapper of an issued command, and
      // issued commands' resolved markers) is kept out of the logs — the
      // command itself is already logged as `$ <command>` when it is issued.
      for (let i = 0; i < segments.length - 1; i++) {
        const line = this.withoutPlumbing(sessionInfo, segments[i]);
        if (line !== null) {
          this.addLog(sessionInfo, line);
          completedLines.push(line);
        }
      }
      
      // The last element is either empty (if data ended with newline) or incomplete
      sessionInfo.lineBuffer = segments[segments.length - 1];
      
      // Safeguard: if lineBuffer gets too large (pathological case of no newlines), truncate it
      if (sessionInfo.lineBuffer.length > 100000) {
        sessionInfo.lineBuffer = sessionInfo.lineBuffer.slice(-50000);
      }

      if (data.length > 0) {
        // `chunk` is the terminal stream as the PTY wrote it, plumbing
        // included, for terminal renderers (the GUI writes it to xterm);
        // `lines` are its complete lines with the plumbing removed.
        this.notify('session:output', {
          sessionId: sessionInfo.id,
          chunk: data,
          lines: completedLines,
          timestamp: new Date()
        });
      }

      // Check if we're done with current command
      this.checkCommandCompletion(sessionInfo, data);
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      sessionInfo.isAlive = false;

      // Flush any remaining buffered line
      const lastLine = this.withoutPlumbing(sessionInfo, sessionInfo.lineBuffer);
      if (lastLine !== null) this.addLog(sessionInfo, lastLine);
      sessionInfo.lineBuffer = '';

      // node-pty gives the signal as a number; the log names it (SIGKILL).
      const signalName = signal
        ? Object.keys(os.constants.signals).find(
            (name) => os.constants.signals[name as keyof typeof os.constants.signals] === signal
          ) ?? `signal ${signal}`
        : undefined;
      this.addLog(sessionInfo, signalName
        ? `[Session terminated by ${signalName}]`
        : `[Session terminated with code ${exitCode}]`);

      // A dying shell can never echo the completion marker, so resolve the
      // in-flight command instead of letting callers hang until their
      // fallback timeout (e.g. exec("exit")): with the shell's exit status
      // when it exited, and with -1 when a signal killed it, since the command
      // then has no status of its own (node-pty reports that death as
      // exitCode 0, with the signal beside it). Queued commands drain via
      // processCommandQueue, which refuses to write to a dead PTY.
      if (sessionInfo.currentCommand) {
        this.resolveCommand(sessionInfo, signal ? -1 : exitCode ?? -1);
      }

      // Nothing written to this shell can be sourced or print a marker any
      // more. A dead session stays listable, so its temp files go, and so do
      // the markers still waiting for a newline, what the scan carried, and
      // the bodies still being typed or waiting their turn.
      this.cleanupTempFiles(sessionInfo);
      sessionInfo.awaitingMarkers.length = 0;
      sessionInfo.scanCarry = '';
      sessionInfo.inlineQueue.length = 0;
      sessionInfo.inlinePieces.clear();
      sessionInfo.typedInline.clear();

      this.notify('session:exit', {
        sessionId: sessionInfo.id,
        exitCode,
        timestamp: new Date()
      });
    });

    this.sessions.set(id, sessionInfo);

    // Initialize the shell and wait for it to be ready
    await this.initializeShell(sessionInfo);

    this.notify('session:created', {
      sessionId: id,
      info: this.toPublicInfo(sessionInfo)
    });

    return id;
  }

  /**
   * Initialize shell with minimal setup
   */
  private async initializeShell(session: SessionInfo): Promise<void> {
    // Just set basic environment, no custom prompts
    const isWindows = process.platform === 'win32';

    if (!isWindows) {
      // Minimal setup - just ensure a clean environment
      session.shell.write('export TERM=xterm-256color\n');
      await this.sleep(200); // Give shell time to initialize

      // Clear any initial output/warnings
      session.outputBuffer = '';
      session.logs = [];
    }
  }

  /**
   * Execute a command in a session and wait for it to finish.
   * Detects completion by the exit marker the shell prints after running the
   * command's line.
   */
  async execCommand(sessionId: string, command: string, timeout?: number): Promise<CommandResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.isAlive) {
      throw new Error(`Session ${sessionId} is not alive`);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();

      // Queue the command
      session.commandQueue.push({
        command,
        resolve,
        startTime,
        timeout: timeout ?? this.defaultCommandTimeout,
        nonce: `${(++this.tempFileCounter).toString(36)}${Math.random().toString(36).slice(2, 8)}`
      });

      // Process queue if not already processing
      if (!session.isProcessingCommand) {
        this.processCommandQueue(session);
      }
    });
  }

  /**
   * Process queued commands
   */
  private async processCommandQueue(session: SessionInfo): Promise<void> {
    if (session.commandQueue.length === 0 || session.isProcessingCommand) {
      return;
    }

    // A dead PTY can't run anything — fail queued commands instead of writing
    // into the void and hanging until their timeouts.
    if (!session.isAlive) {
      while (session.commandQueue.length > 0) {
        const queued = session.commandQueue.shift()!;
        queued.resolve({
          output: '[session exited before command ran]',
          exitCode: -1,
          duration: Date.now() - queued.startTime
        });
      }
      return;
    }

    // Write the next command's body to its temp file before anything marks the
    // session busy. A write that fails (a missing temp directory, a full disk,
    // a name that's taken) fails that command alone, and the next is tried.
    let currentCommand: QueuedCommand | undefined;
    let quotedPath = '';
    while (!currentCommand && session.commandQueue.length > 0) {
      const next = session.commandQueue.shift()!;
      try {
        quotedPath = this.writeCommandViaTempFile(session, next.nonce, next.command);
        currentCommand = next;
      } catch (err) {
        const reason = `[command not run: could not write its temp file: ${(err as Error).message}]`;
        this.addLog(session, `$ ${next.command}`);
        this.addLog(session, reason);
        next.resolve({
          output: reason,
          exitCode: -1,
          duration: Date.now() - next.startTime
        });
      }
    }
    if (!currentCommand) return;

    session.isProcessingCommand = true;
    session.currentCommand = currentCommand;

    // Clear output buffer
    session.outputBuffer = '';

    // Add command to logs
    this.addLog(session, `$ ${currentCommand.command}`);

    this.notify('command:start', {
      sessionId: session.id,
      command: currentCommand.command,
      startedAt: new Date(currentCommand.startTime)
    });

    // Write the command and its start and exit-code markers as ONE line,
    //   echo "<<<STAR""T:<nonce>>>"; . '<tempfile>'; echo "<<<EXI""T:<nonce>:$?>>>"
    // which the shell runs to print <<<START:<nonce>>> and <<<EXIT:<nonce>:<status>>>.
    //
    // The two markers bound the command's own output by execution evidence:
    // the shell prints the start marker immediately before sourcing the file
    // and the exit marker immediately after. Terminal echo of the typed line
    // can't bound it — echo can be off (`stty -echo`), and a timed-out
    // predecessor's late output arrives between the typed line's echo and the
    // moment the shell actually reads it.
    //
    // Every command body goes through a temp file (not just multi-line ones —
    // see issue #3 for the readline paste-corruption rationale; single-line
    // commands additionally overflow the tty's canonical line buffer, 1024
    // bytes on macOS). Sourcing with `.` keeps execution in the interactive
    // shell so cwd/env changes persist and `$?` is the command's exit code.
    //
    // Chaining the marker on the same line — instead of typing it into the
    // PTY after a delay — is what makes completion detection robust:
    //   - The shell echoes the marker only after the command actually exits,
    //     so completion is detected at true completion, never early or late.
    //   - No marker line is typed into the PTY while the command runs, so a
    //     command that reads stdin (read, REPLs, ssh...) can't swallow the
    //     marker line and force a full-timeout wait.
    //   - The marker string is SPLIT in the echo command ("<<<EXI""T:...), so
    //     no echoed/redisplayed copy of the typed line ever contains a
    //     contiguous marker — only the shell executing the echo produces one.
    //     (Terminal echo comes back in several forms — tty echo, readline
    //     redisplay, soft wraps — which no exact-string filter survives.)
    //   - The per-command nonce means stale markers from a timed-out earlier
    //     command can't resolve (and corrupt) a later one.
    //
    // The line runs that wrapper only if the shell in front can read the temp
    // file, and otherwise asks for the body typed inline (see probeLine). The
    // server can't know which shell is in front: an earlier command, or input
    // sent with sendInput, may have started another one, such as a remote
    // shell ssh opened, which can't read this machine's files.
    session.unfinished.set(currentCommand.nonce, false);
    const probe = this.probeLine(currentCommand.nonce, quotedPath);
    session.typingFor = currentCommand.nonce;
    if (this.bodyGoingIn(session)) {
      currentCommand.probe = probe; // held: see typeHeldProbe
      this.armHeldProbe(session);
    } else {
      this.typeLine(session, currentCommand.nonce, probe);
    }

    // Set up fallback timeout
    session.currentTimeout = setTimeout(() => {
      // The hold ends with the wait: a probe still held is typed now, so that
      // the commands behind keep their order, and so that its marker can show
      // a body whose line was taken to be stuck (see releaseStuckInline).
      this.typeHeldProbe(session, true);
      this.resolveCommand(session, -1); // -1 = timed out
    }, currentCommand.timeout);
  }

  /**
   * Is a body for the shell in front going in: the head of inlineQueue typed
   * and its start marker not yet seen (see typeBodyInline)?
   */
  private bodyGoingIn(session: SessionInfo): boolean {
    const head = session.inlineQueue[0];
    return head !== undefined && session.typedInline.has(head);
  }

  /**
   * Is a command still on its way in, the session's latest one until it
   * starts (typingFor) or a body going in for the shell in front (see
   * bodyGoingIn), with the server's typing still moving: a line typed for any
   * command, or a marker acted on, within HELD_PROBE_MAX_MS? Input written
   * then can reach the shell in front instead of the command, or go in
   * between a body's lines, so sendInput refuses it. The body counts on its
   * own because the latest command can be given up while an earlier body
   * still goes in. A line that something other than a shell took, which
   * never answers, stops refusing input after that long, and so does one a
   * busy shell hasn't read yet.
   */
  private typingHolds(session: SessionInfo): boolean {
    return (session.typingFor !== undefined || this.bodyGoingIn(session)) &&
      Date.now() - session.typingProgressAt < HELD_PROBE_MAX_MS;
  }

  /**
   * Before a ^C is written (sendSignal's SIGINT, or a C-c sent with
   * sendInput), give up the commands on their way in that can't have
   * started: a body going in with lines left and the bodies waiting their
   * turn (inlineQueue), since a body's last line is what runs it, and a held
   * probe line, which is then never typed. Over a link, a ^C typed while a
   * body goes in mostly reaches the shell at its prompt between two lines and
   * takes nothing with it, and the server would type the rest and run it.
   * These are the inline form of the typeahead a ^C discards. Every other
   * command that hasn't started is marked (interruptedProbes). A mark acts
   * only at a no-file marker: it gives up a command whose shell then asks
   * for its body, and does nothing for one whose body is typed in whole
   * already. A body whose lines are all typed may be running, and is left to
   * the ^C. Commands still in the server's queue have no line typed
   * and aren't touched: they go in after the ^C. Returns the reason the
   * current command is to be answered with, if it was given up.
   */
  private interruptTyping(session: SessionInfo): string | undefined {
    const given: GivenUp = {};
    for (const nonce of [...session.inlineQueue]) {
      if (session.typedInline.has(nonce) && !session.inlinePieces.has(nonce)) continue; // all its lines typed
      this.dropUntyped(session, nonce, given, INTERRUPTED_BODY);
    }
    const current = session.currentCommand;
    if (current?.probe !== undefined) {
      delete current.probe;
      if (current.probeTimer) clearTimeout(current.probeTimer);
      delete current.probeTimer;
      this.dropUntyped(session, current.nonce, given, '[command not run: interrupted before its line was typed]');
    }
    for (const [nonce, started] of session.unfinished) {
      if (!started) session.interruptedProbes.add(nonce);
    }
    return given.current;
  }

  /**
   * Type the current command's probe line if it was held (see
   * processCommandQueue) and the body that held it is in, or `force`. A line
   * typed while a line editor is still handling a long line is what sets off
   * the failure INLINE_LINE_MAX describes, so while a body goes in, the probe
   * waits for the body's start marker, which shows the shell has read the
   * body's last line. Two things end the wait sooner, with `force`: no line
   * typed for the body for HELD_PROBE_MAX_MS (see armHeldProbe), and the
   * waiting command's own timeout (see processCommandQueue).
   */
  private typeHeldProbe(session: SessionInfo, force = false): void {
    const current = session.currentCommand;
    if (current?.probe === undefined) return;
    if (!force && this.bodyGoingIn(session)) return;
    const probe = current.probe;
    delete current.probe;
    if (current.probeTimer) clearTimeout(current.probeTimer);
    delete current.probeTimer;
    this.typeLine(session, current.nonce, probe);
  }

  /**
   * (Re)start the held probe's progress timer (see HELD_PROBE_MAX_MS): called
   * when the hold starts and whenever a line of a body going in is typed, its
   * first line (advanceInline) or a next one (typeNextPiece).
   */
  private armHeldProbe(session: SessionInfo): void {
    const current = session.currentCommand;
    if (current?.probe === undefined) return;
    if (current.probeTimer) clearTimeout(current.probeTimer);
    current.probeTimer = setTimeout(() => this.typeHeldProbe(session, true), HELD_PROBE_MAX_MS);
  }

  /**
   * The line typed for a command whose body `source` runs (see
   * processCommandQueue for why it looks like this).
   */
  private wrapperLine(nonce: string, source: string): string {
    return `echo "<<<STAR""T:${nonce}>>>"; ${source}; echo "<<<EXI""T:${nonce}:$?>>>"`;
  }

  /**
   * The line typed for every command: the wrapper, run only if the shell in
   * front can read the temp file. A shell that can, such as the session's own
   * or a nested one run on this machine as the same user, keeps the file, so
   * a long or multi-line body is never typed into it. A shell that can't,
   * such as a remote one ssh opened, sets a variable named for the command to
   * its own pid and prints a no-file marker instead, and typeBodyInline then
   * types the body for that shell (see inlineLines).
   *
   * The typed lines rely on the standard behavior of the shell's `.`, `eval`,
   * `[`, `echo`, `printf` and `unset`, which they call by name. A function or
   * alias in the shell in front that changes how one of them behaves is
   * outside what the transport supports, since it can make a command end with
   * a status the body didn't produce. `.() { builtin . "$@"; true; }` runs
   * every command that sources its file but ends it with 0, and a function
   * named `eval` that returns 0 ends every command typed inline with 0
   * without running it. runCommand's description tells callers. This
   * boundary was chosen over a prefix that picks the builtin by shell, to
   * keep the inline line's bytes for bodies and the echo filters to the forms
   * they know. An unconditional `command` fails for special builtins in zsh's
   * default mode, where it runs only programs, and dash has no `builtin`. The
   * file is tested with `[` rather than `test`, a name people do give a
   * function of their own, for running a project's tests.
   */
  private probeLine(nonce: string, quotedPath: string): string {
    return `if [ -r ${quotedPath} ]; then ${this.wrapperLine(nonce, `. ${quotedPath}`)}; ` +
      `else __tsm_${nonce}=$$; echo "<<<NOFIL""E:${nonce}>>>"; fi`;
  }

  /**
   * The lines typed for a shell in front that can't read the temp file: the
   * escaped body (see printfBody) put in a shell variable named for the
   * command, in pieces when it doesn't fit one line (see inlinePiece), then
   * the wrapper around an `eval` of it on the last line. Each line is at most
   * INLINE_LINE_MAX bytes; a body that would take more than INLINE_PIECES_MAX
   * lines gives null, and isn't typed.
   */
  private inlineLines(nonce: string, escapedBody: string): string[] | null {
    const lines: string[] = [];
    let at = 0;
    for (;;) {
      // The rest fits the line that runs the body: that line ends them.
      const closing = lines.length === 0 ? 'only' : 'last';
      if (escapedBody.length - at <= INLINE_LINE_MAX - this.inlinePiece(nonce, '', closing, at, lines.length).length) {
        lines.push(this.inlinePiece(nonce, escapedBody.slice(at), closing, at, lines.length));
        return lines;
      }
      if (lines.length + 1 >= INLINE_PIECES_MAX) return null;
      const adding = lines.length === 0 ? 'first' : 'middle';
      const text = escapedBody.slice(at, at + INLINE_LINE_MAX - this.inlinePiece(nonce, '', adding, at, lines.length).length);
      lines.push(this.inlinePiece(nonce, text, adding, at, lines.length));
      at += text.length;
    }
  }

  /**
   * One line of a body typed inline (see inlineLines): the escaped text it
   * carries put in the body variable, named for the command, on the body's
   * `first` line, or added to what the variable holds on a `middle` or the
   * `last` one; on the `last` line, or the `only` one, the wrapper around an
   * `eval` of the variable follows, and on any other a piece marker carrying
   * the line's `index` is printed, which asks for the next line (see
   * typeNextPiece). The command substitution expands before `eval` runs, so
   * both variables are unset before the body runs, and the status is the
   * body's.
   *
   * Every line runs only in a shell where the pid variable named for the
   * command holds that shell's own pid, which the probe set in the shell that
   * couldn't read the file. A shell without it prints a gone marker and runs
   * nothing: the shell behind the one that asked, when that one has gone, as
   * when an ssh connection drops between the marker and the lines, or a shell
   * an earlier command started in front of it meanwhile. So does a child
   * that inherited the variable (exported under `set -a`), since its pid
   * differs. A shell that replaced the asking one with `exec` keeps its pid,
   * and the variables too if they were exported, as under `set -a`, and then
   * runs the body, as does a subshell of the asking one, which keeps both. A
   * line after the first also runs only where the body variable is set and
   * holds as many characters as the lines before it typed, `typed` (the text
   * is ASCII, so a shell counting characters or bytes agrees; the check is of
   * the length, not the text), and prints the gone marker otherwise: a line
   * that reached another shell, or was cut or taken by something else
   * reading the terminal, leaves a body that is never run, instead of one
   * with a gap. The variable is tested for being set before its length is
   * read, so under `set -u` a line whose first line never arrived prints the
   * gone marker too, where reading the length of an unset variable would
   * abort the line with neither marker. A command whose body isn't typed, or
   * doesn't all reach the asking shell, leaves the variables set there,
   * where nothing reads them. Every part of a line carries the nonce, so
   * plumbing filters know its echo.
   *
   * `eval` runs the body as `.` would in most respects, not all: what only a
   * sourced file has differs, such as `return` at the body's top level (`.`
   * ends the file there, and an interactive shell refuses it outside one and
   * goes on) and BASH_SOURCE, and so does a body whose last line ends in a
   * backslash, since the command substitution drops the trailing newline it
   * continues onto.
   */
  private inlinePiece(nonce: string, text: string, place: 'only' | 'first' | 'middle' | 'last', typed: number, index: number): string {
    const pid = `__tsm_${nonce}`;
    const body = `${pid}_b`;
    const adds = place === 'middle' || place === 'last';
    const check = adds ? ` && [ "\${${body}+set}" = set ] && [ "\${#${body}}" = "${typed}" ]` : '';
    const assign = adds ? `${body}="$${body}"'${text}'` : `${body}='${text}'`;
    const then = place === 'only' || place === 'last'
      ? this.wrapperLine(nonce, `eval "unset ${pid} ${body}; $(printf '%b' "$${body}")"`)
      : `echo "<<<PIEC""E:${nonce}:${index}>>>"`;
    return `if [ "\${${pid}-}" = "$$" ]${check}; then ${assign}; ${then}; else echo "<<<GON""E:${nonce}>>>"; fi`;
  }

  /**
   * Resolve the current command with the given exit code. `endedBy` names the
   * command whose exit marker ended it: its own, or that of the earlier
   * command whose shell it ran in, when that shell exited under it. `reason`
   * is the result's output for a command that never ran.
   */
  private resolveCommand(
    session: SessionInfo,
    exitCode: number,
    how: { endedBy?: string; reason?: string } = {}
  ): void {
    const currentCommand = session.currentCommand;
    if (!currentCommand) return;

    // Clear fallback timeout
    if (session.currentTimeout) {
      clearTimeout(session.currentTimeout);
      session.currentTimeout = undefined;
    }
    if (currentCommand.probeTimer) {
      clearTimeout(currentCommand.probeTimer);
      delete currentCommand.probeTimer;
    }

    session.isProcessingCommand = false;

    // Surface (rather than silently strip) any sign that the line editor
    // mangled the input — otherwise ANSI cleaning can hide a corrupt write.
    this.warnIfInputCorrupted(session);

    // Clean output. The command's own markers bound its result, by execution
    // evidence rather than terminal echo:
    // - It begins after its own start marker. Earlier text is the typed line's
    //   echo, the previous prompt, or the late output of a timed-out
    //   predecessor still running when this command was written (which stays
    //   in the logs, where its caller can recover it). A background job the
    //   predecessor left running can still print inside these bounds. If no
    //   start marker was observed before the wait ended, the result has no
    //   output of its own; the command may still begin later, and what it
    //   prints then reaches the logs and output events.
    // - It ends at its own exit marker, or, for a command that exited the shell
    //   it ran in (`exit` typed into ssh), at the exit marker of the command
    //   that started that shell. What follows is the shell's next prompt, not
    //   this command's output; a result is consumed as data. A command that
    //   times out has no exit marker yet, so its result runs to the end of the
    //   wait, which after an interrupted line can include the next prompt.
    // Inside those bounds only issued commands' plumbing spans are removed;
    // text beside them stays, and marker-shaped text with an unknown nonce is
    // the command's own output.
    let output = '';
    if (currentCommand.started) {
      output = session.outputBuffer;
      // A buffer trimmed past its start (>100MB of output) lacks it; the
      // result then starts where the buffer does.
      const start = output.match(new RegExp(`<<<START:${currentCommand.nonce}>>>(\\r?\\n)?`));
      if (start && start.index !== undefined) {
        output = output.slice(start.index + start[0].length);
      }
      const exitAt = output.search(new RegExp(`<<<EXIT:${how.endedBy ?? currentCommand.nonce}:\\d+>>>`));
      if (exitAt !== -1) {
        output = output.slice(0, exitAt);
      }
    }
    const cleanOutput = how.reason ?? this.stripPlumbingSpans(session, output).trim();

    const duration = Date.now() - currentCommand.startTime;

    this.notify('command:finished', {
      sessionId: session.id,
      command: currentCommand.command,
      duration,
      exitCode,
      output: cleanOutput,
      finishedAt: new Date()
    });

    currentCommand.resolve({
      output: cleanOutput,
      exitCode,
      duration
    });

    session.currentCommand = undefined;
    this.processCommandQueue(session);
  }

  /**
   * Scan the newest output for printed start and exit markers (matched by
   * nonce, so marker-shaped output from other sources is ignored), whether
   * they belong to the CURRENT command or to an earlier one that timed out.
   * - A start marker means the shell has read that command's line and is about
   *   to source its file. It marks the current command as started, and it
   *   releases the files of every command written before it: the shell has
   *   read past their lines, which ran (their files already sourced),
   *   were cut short by an interrupt, or were taken as input by a reader. None
   *   of those files can be sourced again.
   * - An exit marker means the shell has finished sourcing that command's
   *   file, which is released; the current command then completes.
   * - A no-file marker means the shell in front can't read that command's
   *   file, and typeBodyInline types its body.
   * Runs whether or not a command is current, so a timed-out command that ends
   * while the session is idle still releases its file. Only the newest chunk,
   * joined to what the last scan carried (scanCarry), is scanned: a
   * full-buffer scan per chunk is O(n²) on chatty commands.
   */
  private checkCommandCompletion(session: SessionInfo, latestChunk: string): void {
    // A marker counts once its line has ended. The tty can put out a marker
    // and its newline separately, and a line typed in between, such as the
    // next command's or a body for the shell in front, is echoed between
    // them, which splits that echo across two lines of the log. Input typed
    // then by anything else, such as sendInput, can still land there, so the
    // newline can come after more text on the marker's line. Each marker is
    // recognized once and kept in awaitingMarkers until a newline follows it.
    // The window starts with what the last one carried: its last characters
    // after its last marker or newline, kept on the session rather than read
    // back from outputBuffer, which a command's write clears between two
    // chunks. So a marker split across chunks is still recognized, and none
    // is recognized twice.
    const scanWindow = session.scanCarry + latestChunk;
    const tokens = /<<<(?:START:([0-9a-z]+)|EXIT:([0-9a-z]+):(\d+)|NOFILE:([0-9a-z]+)|GONE:([0-9a-z]+)|PIECE:([0-9a-z]+):(\d+))>>>|\n/g;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(scanWindow)) !== null) {
      consumed = tokens.lastIndex;
      if (match[0] !== '\n') {
        const marker: Marker = match[1] !== undefined ? { kind: 'start', nonce: match[1] }
          : match[2] !== undefined ? { kind: 'exit', nonce: match[2], code: parseInt(match[3], 10) }
            : match[4] !== undefined ? { kind: 'nofile', nonce: match[4] }
              : match[5] !== undefined ? { kind: 'gone', nonce: match[5] }
                : { kind: 'piece', nonce: match[6], index: parseInt(match[7], 10) };
        // Only this session's commands' markers can act (the plumbing filters'
        // rule too); any other is output. A copy of one already waiting adds
        // nothing, so a line of repeated markers can't grow the queue.
        if (session.issued.has(marker.nonce) &&
            !session.awaitingMarkers.some((m) => m.kind === marker.kind && m.nonce === marker.nonce && m.index === marker.index)) {
          session.awaitingMarkers.push(marker);
        }
        continue;
      }
      for (const marker of session.awaitingMarkers.splice(0)) this.actOnMarker(session, marker);
    }
    // Markers are under 48 characters, so 63 hold the start of any of them.
    session.scanCarry = scanWindow.slice(Math.max(consumed, scanWindow.length - 63));
  }

  /**
   * Act on a marker whose line has ended (see checkCommandCompletion). Within
   * one marker, every release and give-up happens first (handleMarker), then
   * at most one body starts (advanceInline), and a waiting command given up
   * meanwhile is answered last: its answer types the next command's probe
   * line, which then lands behind the body's first line, not ahead of it. A
   * command whose exit marker this is is answered in handleMarker, before the
   * body waiting behind it starts, so there the next command's probe line goes
   * ahead of that body's first line: a short line ahead of a long one, not the
   * line typed behind a long one that INLINE_LINE_MAX describes.
   */
  private actOnMarker(session: SessionInfo, marker: Marker): void {
    const given: GivenUp = {};
    session.typingProgressAt = Date.now();
    this.handleMarker(session, marker, given);
    this.advanceInline(session);
    this.typeHeldProbe(session);
    if (given.current !== undefined) this.resolveCommand(session, -1, { reason: given.current });
  }

  private handleMarker(session: SessionInfo, marker: Marker, given: GivenUp): void {
    const current = session.currentCommand;
    const { nonce } = marker;
    if (marker.kind === 'start') {
      if (current && nonce === current.nonce) current.started = true;
      if (nonce === session.typingFor) delete session.typingFor;
      session.interruptedProbes.delete(nonce); // it read its file: nothing to give up
      if (session.unfinished.has(nonce)) session.unfinished.set(nonce, true);
      // The shell read on to this command's line, so every earlier line it had
      // was read too: the earlier files go, and a body among them still
      // waiting its turn, or typed without its start marker, is given up (as
      // when the shell in front went and the session's own shell read what
      // was typed for it). This comes before the stuck check, so nothing
      // starts a body that goes here.
      if (session.pendingFiles.has(nonce)) {
        for (const [earlier, file] of session.pendingFiles) {
          if (earlier === nonce) break;
          session.pendingFiles.delete(earlier);
          this.removeTempFile(file);
          if (session.inlineQueue.includes(earlier)) {
            this.dropUntyped(session, earlier, given,
              `[command given up: the shell read on to a later command's line before this one's start marker came]`);
          }
        }
      }
      this.releaseStuckInline(session, nonce, given);
      // The shell has read this body to its end: the next may be typed.
      this.releaseInline(session, nonce);
      return;
    }
    this.releaseStuckInline(session, nonce, given);
    if (marker.kind === 'nofile') {
      this.typeBodyInline(session, nonce, given);
      return;
    }
    if (marker.kind === 'piece') {
      this.typeNextPiece(session, nonce, marker.index ?? -1);
      return;
    }
    if (marker.kind === 'gone') {
      // A line of the body reached a shell other than the one that asked for
      // it, or didn't reach that one whole (see inlinePiece). Taking the mark
      // makes the gone markers of the body's other lines do nothing.
      if (session.typedInline.delete(nonce)) {
        session.inlinePieces.delete(nonce);
        this.dropUntyped(session, nonce, given,
          `[command not run: a line of its body reached a shell other than the one that asked for it, ` +
          `or didn't reach it whole, so nothing ran]`);
      }
      return;
    }
    const file = session.pendingFiles.get(nonce);
    if (file !== undefined) {
      session.pendingFiles.delete(nonce);
      this.removeTempFile(file);
    }
    this.releaseInline(session, nonce); // in case its start marker was lost
    if (nonce === session.typingFor) delete session.typingFor; // so it started too
    session.interruptedProbes.delete(nonce);
    const endsCurrent = session.unfinished.has(nonce) && this.finishUnfinished(session, nonce);
    if (current && (nonce === current.nonce || endsCurrent)) {
      current.started = true; // an exit marker implies the start, even if a trimmed buffer lost it
      this.resolveCommand(session, marker.code ?? -1, { endedBy: nonce });
    }
  }

  /**
   * The shell in front printed a command's no-file marker: it can't read the
   * command's temp file, so it is another shell, such as a remote one ssh
   * opened. Type the body there inline, once, whether or not the command is
   * still waiting for its result, so that commands typed in behind a
   * timed-out one run in the order they were written, as they do in a shell
   * that reads the file. The body comes from the temp file, which is still
   * pending, since this marker comes from the command's own line.
   *
   * Bodies go in one at a time, in the order their markers arrived
   * (inlineQueue). Commands typed in behind a busy shell have their probe
   * lines read together, so their no-file markers come back to back; were
   * each body's first line typed on its own marker, a body in pieces would
   * have the line of a body written after it ahead of its own second line,
   * which would run first, and a long line would reach the line editor with
   * another long line still queued ahead of it (see INLINE_LINE_MAX). So a
   * body's first line is typed only once the body before it has started (its
   * start marker, which shows the shell has read it to its end), or been
   * given up (see releaseInline). The next command's probe line, due when
   * the one before times out, is held while a body goes in and typed once
   * the body's start marker has come, once no line has been typed for the
   * body for HELD_PROBE_MAX_MS, or at that command's own timeout (see
   * typeHeldProbe); where it does land between a body's lines, it only sets
   * its variable and prints its marker, and the body it asks for waits its
   * turn. A body still waiting when its command times out keeps its place.
   *
   * A body whose typed line never prints its marker, as when something else
   * reading the terminal took it, such as a program the body before it
   * started, would hold the bodies behind it. It can't hold them past the
   * shell's next line: the shell reads its terminal in order, so a marker
   * printed by a line typed after that body's line shows the line never
   * reached the shell, and never will. That body is given up then, with the
   * reason in the log, and the next one goes (see releaseStuckInline).
   *
   * The lines run only in the shell that asked for them (see inlinePiece);
   * the first is typed at the body's turn (see advanceInline) and each next
   * one when the shell has printed the piece marker of the one before (see
   * typeNextPiece). A body that would take more than INLINE_PIECES_MAX lines,
   * or whose file can't be read, isn't typed, and is given up here, at its
   * marker, rather than at its turn (see dropUntyped).
   */
  private typeBodyInline(session: SessionInfo, nonce: string, given: GivenUp): void {
    const file = session.pendingFiles.get(nonce);
    if (file === undefined || session.typedInline.has(nonce) || session.inlineQueue.includes(nonce)) {
      return; // released, typed already, or waiting its turn
    }
    if (session.interruptedProbes.has(nonce)) {
      this.dropUntyped(session, nonce, given, INTERRUPTED_BODY); // a SIGINT came first (see interruptTyping)
      return;
    }
    const tooLong = (size: string) => `[command not run: the shell in front can't read this machine's temp files, ` +
      `and typed in, this command would take more than ${INLINE_PIECES_MAX} lines of ${INLINE_LINE_MAX} bytes (${size}); ` +
      `send it as smaller commands]`;
    let lines: string[] | null = null;
    let refusal = '';
    try {
      // Escaping only lengthens a body, so a file over the lines' total isn't read.
      const size = fs.statSync(file).size;
      if (size > INLINE_PIECES_MAX * INLINE_LINE_MAX) {
        refusal = tooLong(`its body alone is ${size} bytes`);
      } else {
        const escapedBody = printfBody(fs.readFileSync(file, 'utf8'));
        lines = this.inlineLines(nonce, escapedBody);
        if (lines === null) refusal = tooLong(`its body is ${size} bytes, ${escapedBody.length} escaped for printf`);
      }
    } catch (err) {
      refusal = `[command not run: the shell in front can't read this machine's temp files, ` +
        `and this command's temp file couldn't be read here either: ${(err as Error).message}]`;
    }
    if (refusal || lines === null) {
      this.dropUntyped(session, nonce, given, refusal);
      return;
    }
    session.inlinePieces.set(nonce, { lines, next: 0 });
    session.inlineQueue.push(nonce); // its turn comes in advanceInline, after this marker's releases
  }

  /**
   * Start the body at the head of inlineQueue if its turn has come (see
   * typeBodyInline): type its first line, once, and restart a held probe's
   * wait (see armHeldProbe). Called once per marker, after
   * every release and give-up the marker brought (see actOnMarker), so a body
   * given up in the same breath is never typed for. A body whose file was
   * released before its turn, and that nothing gave up, is passed over.
   */
  private advanceInline(session: SessionInfo): void {
    for (;;) {
      const head = session.inlineQueue[0];
      if (head === undefined || session.typedInline.has(head)) return;
      const pieces = session.inlinePieces.get(head);
      if (pieces === undefined || !session.pendingFiles.has(head)) {
        session.inlineQueue.shift();
        session.inlinePieces.delete(head);
        continue;
      }
      session.typedInline.add(head);
      pieces.next = 1;
      if (pieces.lines.length === 1) session.inlinePieces.delete(head);
      this.typeLine(session, head, pieces.lines[0]);
      this.armHeldProbe(session); // a body's first line is progress too
      return;
    }
  }

  /**
   * Type a line for a command into the shell, and number it (see lineSeq).
   */
  private typeLine(session: SessionInfo, nonce: string, line: string): void {
    session.lineSeq.set(nonce, ++session.typedCount);
    session.typingProgressAt = Date.now();
    session.shell.write(line + '\n');
  }

  /**
   * A marker for `nonce` has arrived: the shell has read the last line typed
   * for that command. If the body being typed (the head of inlineQueue) is
   * another command whose last line was typed before that one, the shell has
   * read past where that line would have been without printing its marker:
   * something else reading the terminal took it, and will take nothing more,
   * since the shell is reading again. The body is given up, with the reason,
   * and the next one's turn comes (see advanceInline). A line typed before
   * the head's proves nothing: a probe line typed in behind a busy shell
   * waits in the terminal ahead of the head's lines, and its no-file marker
   * comes while they're still to be read.
   */
  private releaseStuckInline(session: SessionInfo, nonce: string, given: GivenUp): void {
    const head = session.inlineQueue[0];
    if (head === undefined || head === nonce || !session.typedInline.has(head)) return;
    const headLine = session.lineSeq.get(head);
    const thisLine = session.lineSeq.get(nonce);
    if (headLine === undefined || thisLine === undefined || thisLine < headLine) return;
    // Whether the taken line ran anywhere is unknown: a first or middle line
    // runs nothing on its own, but a last line taken by an ssh whose
    // connection then dropped may have run on the remote side, its markers
    // lost. The reason says only what is known.
    this.dropUntyped(session, head, given,
      `[command given up: the shell in front printed a marker for a line typed after a line of its body, but none for that line, ` +
      `so its markers won't come]`);
  }

  /**
   * A body's turn in inlineQueue is over: the shell has read it to its end
   * (its start marker, or its exit marker when the start was lost), or the
   * command was given up or released. Take it out, wherever it stands; the
   * body behind it starts when the marker's handling ends (see advanceInline).
   */
  private releaseInline(session: SessionInfo, nonce: string): void {
    const at = session.inlineQueue.indexOf(nonce);
    if (at >= 0) session.inlineQueue.splice(at, 1);
  }

  /**
   * The shell in front printed the piece marker of a body's line, `index`:
   * that line is in the body variable, and the shell is at its prompt again.
   * Type the next line, once. A marker printed again, out of turn, or for a
   * command given up or without lines left types nothing: a line typed twice
   * would find the body variable longer than it checks for and print the
   * gone marker (see inlinePiece), ending a command that could still run. A
   * line whose marker never comes, as when something reading the terminal
   * took it, leaves the rest untyped, and the command waits for its timeout;
   * the bodies behind it wait too, until a marker for a line typed after it
   * shows the shell is reading again (see releaseStuckInline). The next
   * command's probe line, held while this body goes in, is typed once no line
   * has been typed for it for HELD_PROBE_MAX_MS, or at that command's own
   * timeout, and goes to that reader if it is still reading, as any
   * typed-ahead line does.
   */
  private typeNextPiece(session: SessionInfo, nonce: string, index: number): void {
    const pieces = session.inlinePieces.get(nonce);
    if (pieces === undefined || index !== pieces.next - 1) return;
    const line = pieces.lines[pieces.next++];
    if (pieces.next === pieces.lines.length) session.inlinePieces.delete(nonce);
    this.typeLine(session, nonce, line);
    this.armHeldProbe(session); // the body made progress
  }

  /**
   * Give up on a command whose body won't run: release its file, take it out
   * of `unfinished`, since it will print no exit marker, forget its lines and
   * its turn, and say why: to the log here, and to the caller if it is still
   * waiting, once the marker's handling ends (see actOnMarker), through
   * `given`.
   */
  private dropUntyped(session: SessionInfo, nonce: string, given: GivenUp, reason: string): void {
    const file = session.pendingFiles.get(nonce);
    if (file !== undefined) {
      session.pendingFiles.delete(nonce);
      this.removeTempFile(file);
    }
    session.unfinished.delete(nonce);
    session.inlinePieces.delete(nonce);
    session.typedInline.delete(nonce);
    session.interruptedProbes.delete(nonce);
    if (session.typingFor === nonce) delete session.typingFor;
    this.addLog(session, reason);
    if (session.currentCommand?.nonce === nonce) given.current = reason;
    this.releaseInline(session, nonce);
  }

  /**
   * Take a command whose exit marker just arrived out of `unfinished`: its
   * line has finished in the shell that read it. A command written after it
   * that has started ran in a shell this one started, which has exited too,
   * as when `exit` is typed into ssh, so it goes as well, with its file. One
   * that hasn't started stays, since the shell that printed the marker may
   * read it next. Returns whether the current command was among those that
   * went with it.
   */
  private finishUnfinished(session: SessionInfo, nonce: string): boolean {
    let later = false;
    let endsCurrent = false;
    for (const [written, started] of session.unfinished) {
      if (written === nonce) {
        later = true;
        session.unfinished.delete(written);
      } else if (later && started) {
        session.unfinished.delete(written);
        const file = session.pendingFiles.get(written);
        if (file !== undefined) {
          session.pendingFiles.delete(written);
          this.removeTempFile(file);
        }
        if (written === session.currentCommand?.nonce) endsCurrent = true;
      }
    }
    return endsCurrent;
  }

  /**
   * A complete output line as logs and output events should show it, or null
   * to leave it out. Only issued commands' plumbing spans are removed: the
   * echo of a typed wrapper and start/exit markers. Everything else on the line
   * stays, because a line can carry real output beside them — output printed
   * without a trailing newline shares its line with the marker, and a
   * timed-out command's partial output shares its line with the tty echo of
   * the next typed wrapper; logs are the only way left to recover that tail.
   * Marker-shaped text with a nonce this session never issued is output and is
   * untouched. A line that held nothing but plumbing is left out.
   */
  private withoutPlumbing(session: SessionInfo, line: string): string | null {
    if (line.length === 0) return null;
    const kept = this.stripPlumbingSpans(session, line);
    if (kept === line) return line;
    return kept.trim().length > 0 ? kept : null;
  }

  /**
   * Remove issued commands' plumbing spans from command output: wrapper
   * fragments (soft wraps can split the echoed line, so its start-echo,
   * `. '<file>'` or inline `eval`, and exit-echo parts are matched separately,
   * as are a probe line's head and tail and an inline line's check,
   * assignment and tail) and printed start, exit, no-file and gone markers
   * together with the newline echo ends them with. Text
   * around a span stays. The echoed wrapper never contains a contiguous
   * marker (the marker strings are split in it), so the two cannot be
   * confused.
   */
  private stripPlumbingSpans(session: SessionInfo, text: string): string {
    const issued = (span: string, nonce: string) => (session.issued.has(unwrap(nonce)) ? '' : span);
    const issuedPath = (span: string, file: string) => (capturedIn(session.issuedPaths, file) ? '' : span);
    return text
      .replace(PROBE_HEAD, issuedPath)
      .replace(START_ECHO, issued)
      .replace(SOURCE_ECHO, issuedPath)
      .replace(ASSIGN_ECHO, issued)
      .replace(INLINE_IF, issued)
      .replace(EVAL_ECHO, issued)
      .replace(PIECE_ECHO, issued)
      .replace(EXIT_ECHO, issued)
      .replace(PROBE_TAIL, issued)
      .replace(INLINE_TAIL, issued)
      .replace(/<<<START:([0-9a-z]+)>>>(\r?\n)?/g, issued)
      .replace(/<<<NOFILE:([0-9a-z]+)>>>(\r?\n)?/g, issued)
      .replace(/<<<GONE:([0-9a-z]+)>>>(\r?\n)?/g, issued)
      .replace(/<<<PIECE:([0-9a-z]+):\d+>>>(\r?\n)?/g, issued)
      .replace(/<<<EXIT:([0-9a-z]+):(\d+)>>>(\r?\n)?/g, issued);
  }

  /**
   * Record an issued command's nonce and typed path for plumbing filters.
   * The map holds at most 1024 commands, forgetting the oldest settled ones
   * first. A pending command (a line the shell hasn't read past, see
   * pendingFiles) or an unfinished one (no exit marker yet, see unfinished)
   * is never forgotten, since its echo and late markers must still be
   * recognized, so the map grows past 1024 only while more than that are
   * pending or unfinished: commands keep being typed in behind one that
   * hasn't finished, such as a long-running job, a reader that takes them as
   * its input, or a shell that an earlier command started. A command whose
   * exit marker never prints stays unfinished, and remembered, for the rest of
   * the session.
   */
  private rememberIssued(session: SessionInfo, nonce: string, typedPath: string): void {
    session.issued.set(nonce, typedPath);
    session.issuedPaths.add(typedPath);
    const limit = 1024;
    if (session.issued.size <= limit) return;
    for (const [old, oldPath] of session.issued) {
      if (session.issued.size <= limit) break;
      if (session.pendingFiles.has(old) || session.unfinished.has(old)) continue;
      session.issued.delete(old);
      session.issuedPaths.delete(oldPath);
      session.typedInline.delete(old);
      session.inlinePieces.delete(old);
      session.lineSeq.delete(old);
      this.releaseInline(session, old);
    }
  }

  /**
   * Persist a command body to a temp file and return its path as the shell
   * sees it, quoted for the typed line, which sources it in the current shell
   * (preserving cwd/env). The file is tracked on the session under the
   * command's nonce until the shell is done with it (see pendingFiles).
   */
  private writeCommandViaTempFile(session: SessionInfo, nonce: string, command: string): string {
    // 'wx' creates the file exclusively: it never follows a link or reuses a
    // file someone else made, and a name that's taken fails the command
    // instead. That is the protection; the name carries the command's nonce,
    // which is no secret (it is typed into the session, and its random part is
    // Math.random's). The name is short to keep the echoed wrapper short; with
    // a long temp directory (macOS's) the echo still wraps at 120 columns,
    // which the wrap-tolerant patterns above allow for.
    const file = path.join(os.tmpdir(), `tsm-cmd-${process.pid}-${nonce}.sh`);
    try {
      // Trailing newline so the final line is terminated even if the caller omitted it.
      fs.writeFileSync(file, command.endsWith('\n') ? command : command + '\n', { mode: 0o600, flag: 'wx' });
    } catch (err) {
      // A write that failed after creating the file (a full disk) leaves a
      // partial file that is ours to remove; a file that already existed isn't.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') this.removeTempFile(file);
      throw err;
    }
    session.pendingFiles.set(nonce, file);
    // On Windows the shell is WSL but the temp file lives on the host
    // filesystem — translate C:\Users\... to /mnt/c/Users/... so the shell
    // can actually source it.
    const shellPath = process.platform === 'win32'
      ? file.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/')
      : file;
    this.rememberIssued(session, nonce, shellPath);
    // Single-quote the path to be safe against unusual tmpdir characters. The
    // line runs it with `.` (POSIX source), which keeps execution in the
    // interactive shell so env/cwd changes persist, and unlike `source` it
    // also works in plain sh/dash.
    return `'${shellPath.replace(/'/g, `'\\''`)}'`;
  }

  /**
   * Remove every temp file still pending on the session. Only for when the
   * shell can no longer source them: the PTY has exited, or the session or the
   * server is going away. Before that, a command whose exit marker never
   * appears (an interrupted line, an `exit` inside a nested shell) keeps its
   * file until a later command starts.
   */
  private cleanupTempFiles(session: SessionInfo): void {
    for (const file of session.pendingFiles.values()) this.removeTempFile(file);
    session.pendingFiles.clear();
  }

  private removeTempFile(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      // Best-effort: file may already be gone, or tmpdir cleaned by the OS.
    }
  }

  /**
   * Detect the line-editor corruption signature (runs of CSI insert/delete
   * character — ESC[<n>@ / ESC[<n>P) in the raw output and log a warning, so a
   * mangled write is observable rather than hidden by downstream ANSI cleaning.
   */
  private warnIfInputCorrupted(session: SessionInfo): void {
    const insertCharRuns = (session.outputBuffer.match(/\x1b\[[0-9]*[@P]/g) || []).length;
    // A couple of these can occur from benign redraws; a run of them is the
    // hallmark of the paste-corruption bug.
    if (insertCharRuns >= 5) {
      this.addLog(
        session,
        `[warning] detected ${insertCharRuns} CSI insert/delete-char sequences in output — ` +
        `possible input corruption from the terminal line editor`
      );
    }
  }

  /**
   * Send input to a session (for interactive programs).
   *
   * @param input   Literal text, sent verbatim.
   * @param appendNewline  If true (default), append a carriage return (\r) —
   *   what a real Enter key sends. Works both for canonical-mode shells and
   *   raw-mode TUIs (which typically ignore \n for submission).
   *   Ignored (treated as false) when `keys` is provided, unless explicitly true.
   * @param keys    Optional named keys sent after the text, tmux send-keys
   *   style: Enter, Tab, Esc, Up/Down/Left/Right, Backspace, C-c, M-x, F1...
   *   See src/server/keys.ts for decoding.
   *
   * Throws, writing nothing, while a command is on its way in and the
   * server's typing is still moving (see typingHolds): the session's latest
   * command until it starts, ends or is given up, and a body going in for a
   * shell that can't read the temp file, which starts only once it is all in
   * and reads input sent before then itself. The caller sends it again in a
   * moment. Input holding a ^C, as the C-c key or in its text, first gives up
   * the commands still being typed in, as sendSignal's SIGINT does (see
   * interruptTyping).
   */
  sendInput(sessionId: string, input: string, appendNewline?: boolean, keys?: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAlive) {
      throw new Error(`Session ${sessionId} not available`);
    }
    if (this.typingHolds(session)) {
      throw new Error(`Input not sent: a command is still on its way into session ${sessionId}, ` +
        `and until it has started, input can reach the shell in front instead of the command. ` +
        `Send it again in a moment: the refusal ends when the command starts, ends or is given up, ` +
        `or after two seconds in which the server has typed no line and read no marker. ` +
        `To interrupt it, use sendSignal with SIGINT, its default, which isn't refused.`);
    }

    const dataToSend = buildInputData(input, appendNewline, keys);
    // A ^C is the same event whichever call writes it (see sendSignal).
    const givenUp = dataToSend.includes('\x03') ? this.interruptTyping(session) : undefined;
    session.shell.write(dataToSend);
    session.lastActivity = new Date();
    if (givenUp !== undefined) this.resolveCommand(session, -1, { reason: givenUp });

    const hasKeys = !!(keys && keys.length > 0);
    this.notify('session:input', {
      sessionId,
      input,
      appendNewline: hasKeys ? appendNewline === true : appendNewline !== false,
      keys,
      timestamp: new Date()
    });
  }

  /**
   * Send a signal to a session. SIGINT is sent as Ctrl-C, after the commands
   * still being typed in are given up and the others that haven't started
   * are marked (see interruptTyping).
   */
  sendSignal(sessionId: string, signal: string = 'SIGINT'): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAlive) {
      throw new Error(`Session ${sessionId} not available`);
    }

    // For SIGINT, send Ctrl+C, once the commands it must stop that are still
    // on their way in are given up (see interruptTyping)
    if (signal === 'SIGINT') {
      const givenUp = this.interruptTyping(session);
      session.shell.write('\x03');
      if (givenUp !== undefined) this.resolveCommand(session, -1, { reason: givenUp });
    } else if (signal === 'SIGTERM') {
      session.shell.kill('SIGTERM');
    } else {
      session.shell.kill(signal as any);
    }

    this.notify('session:signal', {
      sessionId,
      signal,
      timestamp: new Date()
    });
  }

  /**
   * Launch a process — write the command and optionally poll for ready/error patterns.
   * Unlike execCommand, this does NOT wait for the command to exit.
   */
  async startService(options: ServiceStartOptions): Promise<{
    status: 'ready' | 'running' | 'error';
    logs: string[];
    sessionId: string;
  }> {
    // Create session
    const sessionId = await this.createSession(options.name, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell
    });

    const session = this.sessions.get(sessionId)!;

    // Write the command (no exit-code marker — process is meant to keep running)
    session.shell.write(options.command + '\n');
    this.addLog(session, `$ ${options.command}`);

    // Poll for ready/error patterns, or return after a brief wait
    const hasPatterns = (options.readyPatterns && options.readyPatterns.length > 0) ||
                        (options.errorPatterns && options.errorPatterns.length > 0);
    const pollTimeout = hasPatterns ? 15000 : 2000; // 15s if patterns, 2s otherwise
    const pollInterval = 200;
    const startTime = Date.now();

    while (Date.now() - startTime < pollTimeout) {
      await this.sleep(pollInterval);

      const output = session.outputBuffer;

      if (options.errorPatterns) {
        for (const pattern of options.errorPatterns) {
          if (output.includes(pattern)) {
            return { status: 'error', logs: session.logs.slice(-20), sessionId };
          }
        }
      }

      if (options.readyPatterns) {
        for (const pattern of options.readyPatterns) {
          if (output.includes(pattern)) {
            return { status: 'ready', logs: session.logs.slice(-20), sessionId };
          }
        }
      }

      // If process died, no point waiting
      if (!session.isAlive) {
        return { status: 'error', logs: session.logs.slice(-20), sessionId };
      }
    }

    return {
      status: 'running',
      logs: session.logs.slice(-20),
      sessionId
    };
  }

  /**
   * Get session output/logs
   */
  getOutput(sessionId: string, lines?: number): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Include any incomplete line still in the buffer (like the initial prompt)
    let output = [...session.logs];
    const partial = this.withoutPlumbing(session, session.lineBuffer);
    if (partial !== null) {
      output.push(partial);
    }

    if (lines) {
      return output.slice(-lines);
    }
    return output;
  }

  /**
   * Search logs with optional regex
   */
  searchLogs(sessionId: string, pattern: string | RegExp, options?: {
    limit?: number;
    context?: number;
  }): Array<{ line: string; lineNumber: number; context?: string[] }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const regex = typeof pattern === 'string' ? 
      new RegExp(pattern, 'i') : pattern;

    const results: Array<{ line: string; lineNumber: number; context?: string[] }> = [];
    const limit = options?.limit || 100;
    const contextLines = options?.context || 0;

    for (let i = 0; i < session.logs.length && results.length < limit; i++) {
      if (regex.test(session.logs[i])) {
        const result: any = {
          line: session.logs[i],
          lineNumber: i + 1
        };

        if (contextLines > 0) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(session.logs.length, i + contextLines + 1);
          result.context = session.logs.slice(start, end);
        }

        results.push(result);
      }
    }

    return results;
  }

  /**
   * List all sessions
   */
  listSessions(): Array<{
    id: string;
    name: string;
    isAlive: boolean;
    createdAt: Date;
    lastActivity: Date;
    logSize: number;
  }> {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      name: session.name,
      isAlive: session.isAlive,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      logSize: session.logs.length
    }));
  }

  /**
   * Resize a session's PTY (important for mouse support in TUI apps)
   */
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAlive) {
      throw new Error(`Session ${sessionId} not found or not alive`);
    }

    try {
      session.shell.resize(cols, rows);
    } catch (error: any) {
      throw new Error(`Failed to resize session: ${error.message}`);
    }
  }

  /**
   * Kill a session with optional graceful shutdown
   */
  async killSession(sessionId: string, graceful: boolean = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.isAlive) {
      if (graceful) {
        // Send SIGINT for graceful shutdown
        session.shell.kill('SIGINT');

        // Wait up to 5 seconds for process to exit gracefully
        const timeout = 3000;
        const startTime = Date.now();

        while (session.isAlive && Date.now() - startTime < timeout) {
          await this.sleep(100);
        }

        // If still alive after timeout, force kill
        if (session.isAlive) {
          this.addLog(session, '[Process did not exit gracefully, forcing termination]');
          session.shell.kill('SIGKILL');
        }
      } else {
        // Force kill immediately
        session.shell.kill('SIGKILL');
      }
    }

    // Wait a bit to ensure the process has fully terminated
    await this.sleep(100);
    this.cleanupTempFiles(session);
    this.sessions.delete(sessionId);
  }

  /**
   * Kill all sessions with optional graceful shutdown
   */
  async killAll(graceful: boolean = true): Promise<void> {
    const killPromises = Array.from(this.sessions.keys()).map(id => 
      this.killSession(id, graceful)
    );
    await Promise.all(killPromises);
    this.sessions.clear();
  }

  /**
   * Get environment variables for a session
   */
  async getEnvironment(sessionId: string): Promise<Record<string, string>> {
    const result = await this.execCommand(sessionId, 'env');
    const env: Record<string, string> = {};
    
    const lines = result.output.split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) {
        env[match[1]] = match[2];
      }
    }
    
    return env;
  }

  /**
   * Get current working directory
   */
  async getCurrentDirectory(sessionId: string): Promise<string> {
    const result = await this.execCommand(sessionId, 'pwd');
    return result.output.trim();
  }

  /**
   * Take a screenshot of the terminal session via xterm.js GUI
   * This properly captures TUIs like htop, vim, etc.
   */
  async takeScreenshot(sessionId: string, options?: {
    lines?: number;
    outputPath?: string;
    width?: number;
    height?: number;
    guiPort?: number;
  }): Promise<{ success: boolean; path?: string; base64?: string; error?: string }> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      const guiPort = options?.guiPort || 3200;
      const width = options?.width || 1400;
      const height = options?.height || 900;

      // Use puppeteer to navigate to the xterm.js GUI
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      try {
        const page = await browser.newPage();
        
        // Set viewport size
        await page.setViewport({
          width,
          height
        });
        
        // Navigate to the GUI (with auth token if the GUI requires one)
        const tokenParam = this.guiAuthToken ? `?token=${encodeURIComponent(this.guiAuthToken)}` : '';
        const guiUrl = `http://localhost:${guiPort}${tokenParam}`;
        await page.goto(guiUrl, { waitUntil: 'networkidle0', timeout: 10000 });
        
        // Wait for the session list to load
        await page.waitForSelector('.session-item', { timeout: 5000 });
        
        // Find and click the session - use $$eval to avoid DOM type issues
        const sessionClicked = await page.$$eval(
          '.session-item',
          (items: any[], targetId: string) => {
            for (const item of items) {
              const nameEl = item.querySelector('.session-name');
              if (nameEl && nameEl.textContent === targetId) {
                (item as any).click();
                return true;
              }
            }
            return false;
          },
          sessionId
        );
        
        if (!sessionClicked) {
          throw new Error(`Session ${sessionId} not found in GUI`);
        }
        
        // Wait for terminal container to be ready
        await page.waitForSelector('#terminal', { timeout: 5000 });
        
        // Give xterm.js plenty of time to process and render all escape sequences
        // TUIs like htop send many cursor positioning commands that need time to render
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Force xterm.js to refresh if it's available
        await page.evaluate(() => {
          try {
            const w = (globalThis as any);
            if (w.currentTerminal) {
              w.currentTerminal.refresh(0, w.currentTerminal.rows - 1);
            }
          } catch (e) {
            // Ignore if terminal refresh fails
          }
        });
        
        // Final wait after refresh
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Screenshot the terminal canvas container which has the rendered output
        const terminalElement = await page.$('#terminal');
        if (!terminalElement) {
          throw new Error('Terminal element not found in GUI');
        }
        
        const screenshotBuffer = await terminalElement.screenshot({
          type: 'png'
        });
        
        await browser.close();

        // Always return base64 for MCP, optionally save to file too
        const base64 = screenshotBuffer.toString('base64');
        
        if (options?.outputPath) {
          const fullPath = path.resolve(options.outputPath);
          await fs.promises.writeFile(fullPath, screenshotBuffer);
          return { success: true, base64, path: fullPath };
        } else {
          return { success: true, base64 };
        }
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (error: any) {
      return { success: false, error: `Failed to screenshot via GUI: ${error.message}` };
    }
  }

  // Helper methods
  private addLog(session: SessionInfo, line: string): void {
    session.logs.push(line);
    if (session.logs.length > this.maxLogSize) {
      session.logs.shift();
    }
  }

  private toPublicInfo(session: SessionInfo): PublicSessionInfo {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      env: session.env,
      isAlive: session.isAlive,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      logSize: session.logs.length
    };
  }

  private notify<K extends keyof SessionEventMap>(
    event: K,
    payload: SessionEventMap[K]
  ): void {
    this.emit(event, payload);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
