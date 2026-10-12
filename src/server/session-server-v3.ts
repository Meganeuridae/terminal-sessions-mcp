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
  // wrapper echoes and printed start and exit markers are exec plumbing,
  // removed wherever they appear while the command is remembered (see
  // rememberIssued), so a command that prints them back (`history`, a reader
  // that received a typed wrapper) loses those spans too. Marker-shaped text
  // carrying any other nonce is output and is never filtered.
  issued: Map<string, string>;
  issuedPaths: Set<string>;
}

interface QueuedCommand {
  command: string;
  resolve: (result: CommandResult) => void;
  startTime: number;
  timeout: number;
  nonce: string;
  // Set when the shell prints this command's start marker: execution began.
  started?: boolean;
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
const EXIT_ECHO = new RegExp(
  wrapTolerant('echo "<<<EXI""T:') + NONCE + wrapTolerant(':$?>>>"') + `${WRAP}(\\r?\\n)?`, 'g');
const WRAP_ARTIFACT = new RegExp(WRAP_ONE, 'g');
/** A captured nonce or path with any wrap artifacts removed. */
const unwrap = (captured: string) => captured.replace(WRAP_ARTIFACT, '');

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
      issuedPaths: new Set()
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

      // Nothing written to this shell can be sourced any more.
      this.cleanupTempFiles(sessionInfo);

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
    let source = '';
    while (!currentCommand && session.commandQueue.length > 0) {
      const next = session.commandQueue.shift()!;
      try {
        source = this.writeCommandViaTempFile(session, next.nonce, next.command);
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
    //   - Nothing extra is typed into the PTY while the command runs, so a
    //     command that reads stdin (read, REPLs, ssh...) can't swallow the
    //     marker line and force a full-timeout wait.
    //   - The marker string is SPLIT in the echo command ("<<<EXI""T:...), so
    //     no echoed/redisplayed copy of the typed line ever contains a
    //     contiguous marker — only the shell executing the echo produces one.
    //     (Terminal echo comes back in several forms — tty echo, readline
    //     redisplay, soft wraps — which no exact-string filter survives.)
    //   - The per-command nonce means stale markers from a timed-out earlier
    //     command can't resolve (and corrupt) a later one.
    session.shell.write(this.wrapperLine(currentCommand.nonce, source) + '\n');

    // Set up fallback timeout
    session.currentTimeout = setTimeout(() => {
      this.resolveCommand(session, -1); // -1 = timed out
    }, currentCommand.timeout);
  }

  /**
   * The line typed for a command whose body `source` runs (see
   * processCommandQueue for why it looks like this).
   */
  private wrapperLine(nonce: string, source: string): string {
    return `echo "<<<STAR""T:${nonce}>>>"; ${source}; echo "<<<EXI""T:${nonce}:$?>>>"`;
  }

  /**
   * Resolve the current command with the given exit code
   */
  private resolveCommand(session: SessionInfo, exitCode: number): void {
    const currentCommand = session.currentCommand;
    if (!currentCommand) return;

    // Clear fallback timeout
    if (session.currentTimeout) {
      clearTimeout(session.currentTimeout);
      session.currentTimeout = undefined;
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
    // - It ends at its own exit marker. What follows is the shell's next
    //   prompt, not this command's output; a result is consumed as data. A
    //   command that times out has no exit marker yet, so its result runs to
    //   the end of the wait, which after an interrupted line can include the
    //   next prompt.
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
      const ownExitAt = output.search(new RegExp(`<<<EXIT:${currentCommand.nonce}:\\d+>>>`));
      if (ownExitAt !== -1) {
        output = output.slice(0, ownExitAt);
      }
    }
    const cleanOutput = this.stripPlumbingSpans(session, output).trim();

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
   * Runs whether or not a command is current, so a timed-out command that ends
   * while the session is idle still releases its file. Only the tail of the
   * buffer around the newest chunk is scanned: a full-buffer scan per chunk is
   * O(n²) on chatty commands.
   */
  private checkCommandCompletion(session: SessionInfo, latestChunk: string): void {
    if (session.pendingFiles.size === 0 && !session.currentCommand) return;

    // Overlap covers a marker split across chunk boundaries (marker is <48 chars).
    const scanWindow = session.outputBuffer.slice(-(latestChunk.length + 64));
    const markers = /<<<(?:START:([0-9a-z]+)|EXIT:([0-9a-z]+):(\d+))>>>/g;
    let match: RegExpExecArray | null;
    while ((match = markers.exec(scanWindow)) !== null) {
      const current = session.currentCommand;
      if (match[1] !== undefined) {
        const started = match[1];
        if (current && started === current.nonce) current.started = true;
        if (session.pendingFiles.has(started)) {
          for (const [earlier, file] of session.pendingFiles) {
            if (earlier === started) break;
            session.pendingFiles.delete(earlier);
            this.removeTempFile(file);
          }
        }
        continue;
      }
      const nonce = match[2];
      const file = session.pendingFiles.get(nonce);
      if (file !== undefined) {
        session.pendingFiles.delete(nonce);
        this.removeTempFile(file);
      }
      if (current && nonce === current.nonce) {
        current.started = true; // an exit marker implies the start, even if a trimmed buffer lost it
        this.resolveCommand(session, parseInt(match[3], 10));
        return;
      }
    }
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
   * `. '<file>'` and exit-echo parts are matched separately) and printed
   * start/exit markers together with the newline echo ends them with. Text
   * around a span stays. The echoed wrapper never contains a contiguous
   * marker (the marker strings are split in it), so the two cannot be
   * confused.
   */
  private stripPlumbingSpans(session: SessionInfo, text: string): string {
    const issued = (span: string, nonce: string) => (session.issued.has(unwrap(nonce)) ? '' : span);
    return text
      .replace(START_ECHO, issued)
      .replace(SOURCE_ECHO, (span, file: string) =>
        session.issuedPaths.has(unwrap(file)) ? '' : span)
      .replace(EXIT_ECHO, issued)
      .replace(/<<<START:([0-9a-z]+)>>>(\r?\n)?/g, issued)
      .replace(/<<<EXIT:([0-9a-z]+):(\d+)>>>(\r?\n)?/g, issued);
  }

  /**
   * Record an issued command's nonce and typed path for plumbing filters.
   * The map holds at most 1024 commands, forgetting the oldest settled ones
   * first. A pending command (a line the shell hasn't read past, see
   * pendingFiles) is never forgotten, since its echo and late markers must
   * still be recognized, so the map grows past 1024 only while more than that
   * are pending: commands keep being typed in behind one that hasn't
   * finished, such as a long-running job or a reader that takes them as its
   * input.
   */
  private rememberIssued(session: SessionInfo, nonce: string, typedPath: string): void {
    session.issued.set(nonce, typedPath);
    session.issuedPaths.add(typedPath);
    const limit = 1024;
    if (session.issued.size <= limit) return;
    for (const [old, oldPath] of session.issued) {
      if (session.issued.size <= limit) break;
      if (session.pendingFiles.has(old)) continue;
      session.issued.delete(old);
      session.issuedPaths.delete(oldPath);
    }
  }

  /**
   * Persist a command body to a temp file and return the single-line shell
   * command that runs it in the current shell (preserving cwd/env).
   * The file is tracked on the session under the command's nonce until the
   * shell is done with it (see pendingFiles).
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
    // `.` (POSIX source) keeps execution in the interactive shell so env/cwd
    // changes persist, and unlike `source` it also works in plain sh/dash.
    // Single-quote the path to be safe against unusual tmpdir characters.
    return `. '${shellPath.replace(/'/g, `'\\''`)}'`;
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
   */
  sendInput(sessionId: string, input: string, appendNewline?: boolean, keys?: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAlive) {
      throw new Error(`Session ${sessionId} not available`);
    }

    const dataToSend = buildInputData(input, appendNewline, keys);
    session.shell.write(dataToSend);
    session.lastActivity = new Date();

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
   * Send a signal to a session
   */
  sendSignal(sessionId: string, signal: string = 'SIGINT'): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAlive) {
      throw new Error(`Session ${sessionId} not available`);
    }

    // For SIGINT, send Ctrl+C
    if (signal === 'SIGINT') {
      session.shell.write('\x03');
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
