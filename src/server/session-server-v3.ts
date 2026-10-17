/**
 * Session Server v3 - Persistent Shell Sessions
 * 
 * Features:
 * - Real persistent shell sessions using node-pty
 * - Environment variable persistence
 * - Working directory persistence
 * - Interactive input support
 * - Temp-file cleanup at process exit (signals are left to the embedding
 *   program; start-session-server handles SIGINT and SIGTERM)
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
  commandQueue: Array<{
    command: string;
    resolve: (result: CommandResult) => void;
    startTime: number;
    timeout: number;
  }>;
  currentCommand?: {
    command: string;
    resolve: (result: CommandResult) => void;
    startTime: number;
    timeout: number;
  };
  lineBuffer: string; // Buffer for incomplete lines
  tempFiles: string[]; // Temp files backing multi-line commands, cleaned up lazily
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

export class PersistentSessionServer extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();
  private readonly maxLogSize = 10000; // lines per session
  private readonly maxOutputBufferSize = 100 * 1024 * 1024; // 100MB max buffer size
  private readonly defaultCommandTimeout = 30000; // 30 seconds default
  private readonly exitCodeMarker = '<<<EXIT:';
  private readonly exitCodeEnd = '>>>';
  private tempFileCounter = 0;

  /**
   * Auth token for the web GUI (same token as the session server).
   * Used by takeScreenshot so its headless browser can authenticate.
   */
  guiAuthToken?: string;

  constructor() {
    super();
    // When the program exits, remove the sessions' temp files. An 'exit'
    // listener can't await, so this is synchronous: the async graceful path
    // would be abandoned when the event loop stops.
    //
    // It sends the shells no signal. When the program ends, the kernel hangs
    // up each session's terminal once nothing else holds it open, and the
    // shell passes that hangup on to the jobs it started in the background.
    // (On Linux, node-pty 1.0.0 lets each later session's shell and jobs
    // inherit the earlier sessions' terminals, so a later session's job that
    // survives its own hangup keeps them open.) A signal sent from here gets
    // in the way: a SIGKILLed shell can't pass the hangup on, and in our runs
    // on Linux (bash 5.2), in a program that exited right after a command, a
    // SIGHUP sent here left the job running in 11 of 30 runs, against 1 of 60
    // with the kernel's hangup alone.
    //
    // The class registers no SIGINT handler: Ctrl+C belongs to the program
    // that embeds it. start-session-server handles SIGINT with its graceful
    // shutdown. A program that doesn't is ended by the signal, so no 'exit'
    // listener runs (this one and the program's own alike) and the temp files
    // stay; the kernel then hangs up its sessions' terminals as above.
    process.on('exit', () => this.cleanupOnExit());
  }

  /** Synchronous cleanup for process exit: removes every session's temp files. */
  private cleanupOnExit(): void {
    for (const session of this.sessions.values()) {
      this.cleanupTempFiles(session);
    }
    this.sessions.clear();
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
      tempFiles: []
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
      
      // All but the last element are complete lines
      for (let i = 0; i < segments.length - 1; i++) {
        const line = segments[i];
        if (line.length > 0) {
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
        this.notify('session:output', {
          sessionId: sessionInfo.id,
          chunk: data,
          lines: completedLines,
          timestamp: new Date()
        });
      }

      // Check if we're done with current command
      this.checkCommandCompletion(sessionInfo);
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode }) => {
      sessionInfo.isAlive = false;
      
      // Flush any remaining buffered line
      if (sessionInfo.lineBuffer.length > 0) {
        this.addLog(sessionInfo, sessionInfo.lineBuffer);
        sessionInfo.lineBuffer = '';
      }
      
      this.addLog(sessionInfo, `[Session terminated with code ${exitCode}]`);
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
      // Minimal setup, ending in a ready marker so we wait exactly as long as
      // the shell needs (slow rc files can outlive a fixed sleep and leak
      // startup noise into the first command's output). The echoed input
      // contains the literal `$$` (split so no echo can match), so only the
      // shell actually executing the line produces the digits the regex needs.
      session.shell.write('export TERM=xterm-256color; echo "<<<RD""Y:$$>>>"\n');
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !/<<<RDY:\d+>>>/.test(session.outputBuffer)) {
        await this.sleep(20);
      }
      // Small settle window for the prompt that follows the marker.
      await this.sleep(50);

      // Clear the startup output. The line buffer is kept, as on main: it
      // holds the prompt that followed the marker, and getOutput appends it to
      // the logs, so the GUI's first read of a fresh session shows the prompt.
      session.outputBuffer = '';
      session.logs = [];
    }
  }

  /**
   * Execute a command in a session and wait for it to finish.
   * Detects completion via an exit-code marker echoed after the command.
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
        timeout: timeout ?? this.defaultCommandTimeout
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

    session.isProcessingCommand = true;
    const currentCommand = session.commandQueue.shift()!;
    session.currentCommand = currentCommand;

    // Any temp files from previously-issued commands are safe to remove now:
    // a new command means the shell has finished sourcing the prior one.
    this.cleanupTempFiles(session);

    // Clear output buffer
    session.outputBuffer = '';

    // Add command to logs
    this.addLog(session, `$ ${currentCommand.command}`);

    this.notify('command:start', {
      sessionId: session.id,
      command: currentCommand.command,
      startedAt: new Date(currentCommand.startTime)
    });

    // Write the command followed by an exit-code marker so we can detect completion.
    //
    // Multi-line payloads (e.g. heredocs) must NOT be streamed into the
    // interactive PTY as if typed: the shell's line editor (readline) echoes
    // and redraws as it ingests each fragment, emitting CSI insert-character
    // (ESC[1@) runs that race the inbound bytes and transpose the text
    // (see issue #3). Instead, write the body to a temp file out-of-band and
    // source it — a single, side-effect-free line for the line editor. Using
    // `source` (not `bash <file>`) preserves cwd/env persistence and keeps the
    // `$?` marker meaningful; the approach is shell-agnostic (works on the
    // default macOS bash 3.2, which has no bracketed-paste support).
    if (currentCommand.command.includes('\n')) {
      session.shell.write(this.writeCommandViaTempFile(session, currentCommand.command) + '\n');
    } else {
      session.shell.write(currentCommand.command + '\n');
    }
    // Small delay to ensure the command starts before we write the marker echo
    setTimeout(() => {
      if (session.isAlive && session.currentCommand === currentCommand) {
        session.shell.write(`echo "${this.exitCodeMarker}$?${this.exitCodeEnd}"\n`);
      }
    }, 50);

    // Set up fallback timeout
    const fallbackTimeout = setTimeout(() => {
      this.resolveCommand(session, -1); // -1 = timed out
    }, currentCommand.timeout);

    // Store timeout so we can clear it on early completion
    (session as any).currentTimeout = fallbackTimeout;
  }

  /**
   * Resolve the current command with the given exit code
   */
  private resolveCommand(session: SessionInfo, exitCode: number): void {
    const currentCommand = session.currentCommand;
    if (!currentCommand) return;

    // Clear fallback timeout
    if ((session as any).currentTimeout) {
      clearTimeout((session as any).currentTimeout);
      (session as any).currentTimeout = undefined;
    }

    session.isProcessingCommand = false;

    // Surface (rather than silently strip) any sign that the line editor
    // mangled the input — otherwise ANSI cleaning can hide a corrupt write.
    this.warnIfInputCorrupted(session);

    // Clean output: remove the marker line and the echo command itself
    const markerRegex = new RegExp(
      `echo "${this.exitCodeMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\$\\?${this.exitCodeEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\r?\\n?`,
      'g'
    );
    const exitRegex = new RegExp(
      `${this.exitCodeMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+${this.exitCodeEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`,
      'g'
    );
    const cleanOutput = session.outputBuffer
      .replace(markerRegex, '')
      .replace(exitRegex, '')
      .trim();

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
   * Check if command execution is complete by scanning for the exit-code marker.
   * Uses a regex to match the resolved marker (digits only) and skip the
   * echo command itself which contains the literal `$?`.
   */
  private checkCommandCompletion(session: SessionInfo): void {
    if (!session.currentCommand) return;

    // Match the resolved marker: <<<EXIT:0>>> or <<<EXIT:127>>> etc.
    // This skips the echo command line which contains <<<EXIT:$?>>>
    const match = session.outputBuffer.match(/<<<EXIT:(\d+)>>>/);
    if (!match) return;

    const exitCode = parseInt(match[1], 10);
    this.resolveCommand(session, exitCode);
  }

  /**
   * Persist a multi-line command body to a temp file and return the single-line
   * shell command that runs it in the current shell (preserving cwd/env).
   * The file is tracked on the session and cleaned up lazily.
   */
  private writeCommandViaTempFile(session: SessionInfo, command: string): string {
    const file = path.join(
      os.tmpdir(),
      `term-sessions-cmd-${process.pid}-${++this.tempFileCounter}.sh`
    );
    // Trailing newline so the final line is terminated even if the caller omitted it.
    fs.writeFileSync(file, command.endsWith('\n') ? command : command + '\n', { mode: 0o600 });
    session.tempFiles.push(file);
    // `source` keeps execution in the interactive shell so env/cwd changes persist.
    // Single-quote the path to be safe against unusual tmpdir characters.
    return `source '${file.replace(/'/g, `'\\''`)}'`;
  }

  /**
   * Remove temp files backing already-issued commands. Safe to call between
   * commands: serialized execution guarantees the shell has finished sourcing.
   */
  private cleanupTempFiles(session: SessionInfo): void {
    if (session.tempFiles.length === 0) return;
    for (const file of session.tempFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort: file may already be gone, or tmpdir cleaned by the OS.
      }
    }
    session.tempFiles = [];
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
    if (session.lineBuffer.length > 0) {
      output.push(session.lineBuffer);
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
        // SIGHUP is the "terminal went away" signal: an interactive shell
        // exits on it and resends it to its jobs. (SIGINT, used previously, is
        // IGNORED by an interactive bash — every graceful kill burned the full
        // timeout and then SIGKILLed anyway.) bash can defer a SIGHUP that
        // lands between two commands until its next input, so it is sent
        // again every 500 ms while the shell is still there. In our runs on
        // Linux (bash 5.2), a SIGHUP sent right after a command left the shell
        // running 1.5 s later in 39 of 120 trials, and a second SIGHUP, or an
        // Enter, ended it within about 30 ms each time.
        session.shell.kill('SIGHUP');

        // Wait up to 3 seconds for the process to exit gracefully
        const timeout = 3000;
        const startTime = Date.now();
        let nextHangup = startTime + 500;

        while (session.isAlive && Date.now() - startTime < timeout) {
          await this.sleep(50);
          if (session.isAlive && Date.now() >= nextHangup) {
            session.shell.kill('SIGHUP');
            nextHangup += 500;
          }
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

    // Brief settle so the exit handler (log flush, event) runs before removal
    await this.sleep(50);
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
