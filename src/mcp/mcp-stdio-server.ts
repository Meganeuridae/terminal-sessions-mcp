#!/usr/bin/env node

/**
 * Minimal MCP Server Implementation for Terminal Sessions MCP
 * 
 * Implements just enough of the MCP protocol to work with Cursor
 */

import * as readline from 'readline';
import { ConnectomeTestingMCP } from './mcp-server';

// Create readline interface for stdio communication
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Initialize our MCP wrapper (lazy - connection will be established on first use)
let mcp: ConnectomeTestingMCP | null = null;

// Resolve the package version for the initialize handshake. Path differs
// between ts-node (src/mcp/) and the compiled build (dist/src/mcp/).
function getPackageVersion(): string {
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = require(rel);
      if (pkg?.name?.includes('term-sessions-mcp') || pkg?.name?.includes('terminal-sessions')) {
        return pkg.version;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return 'unknown';
}

function getMCP() {
  if (!mcp) {
    // Support full URL, or host+port separately
    const token = process.env.SESSION_SERVER_TOKEN;
    const url = process.env.SESSION_SERVER_URL;
    
    // Always log connection info for debugging
    console.error(`[MCP] SESSION_SERVER_URL env: ${url || '(not set)'}`);
    console.error(`[MCP] SESSION_SERVER_PORT env: ${process.env.SESSION_SERVER_PORT || '(not set)'}`);
    console.error(`[MCP] SESSION_SERVER_HOST env: ${process.env.SESSION_SERVER_HOST || '(not set)'}`);
    
    if (url) {
      console.error(`[MCP] Using URL: ${url}`);
      mcp = new ConnectomeTestingMCP(url, token);
    } else {
      const host = process.env.SESSION_SERVER_HOST || 'localhost';
      const port = process.env.SESSION_SERVER_PORT || '3100';
      const fallbackUrl = `ws://${host}:${port}`;
      console.error(`[MCP] Using fallback URL: ${fallbackUrl}`);
      mcp = new ConnectomeTestingMCP(fallbackUrl, token);
    }
  }
  return mcp;
}

// Tool definitions
const TOOLS = {
  launch: {
    description: 'Launch a process and optionally wait for readiness patterns in its output. Use runCommand for commands that finish on their own.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name' },
        command: { type: 'string', description: 'Command to run' },
        cwd: { type: 'string', description: 'Working directory' },
        readyPatterns: { type: 'array', items: { type: 'string' } },
        errorPatterns: { type: 'array', items: { type: 'string' } },
        raw: { type: 'boolean', description: 'If true, preserve raw ANSI escape codes in output (default: false, returns clean text)' }
      },
      required: ['name', 'command']
    }
  },
  runCommand: {
    description: 'Run a command in a session (auto-creates the session if it does not exist). It runs in the shell in front, which can be one an earlier command started, such as ssh\'s, and has to be a POSIX shell (sh, bash, dash, zsh, ksh). Where that shell can\'t read this machine\'s temp files, a command over about 100 KB (near 20 KB if mostly non-ASCII, single quotes, `!` or control characters other than newline and tab) isn\'t run: its result has exitCode -1 and the reason if you\'re still waiting, and the session log says why. A function or alias in the shell in front that changes `.`, `eval`, `[`, `echo`, `printf` or `unset` can make a command report a status its body didn\'t produce, or keep the body from running.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session name (will be created automatically if it does not exist)' },
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory (used when auto-creating a new session)' },
        timeout: { type: 'number', description: 'Command timeout in ms (default: 30000). Use -1 to return immediately without waiting. A timed-out command, one still being typed in included, goes on to run (exitCode -1 in the result) unless its body is given up, which the session log says, or a Ctrl-C discarded its line, and commands sent meanwhile are typed in behind it: they run when it ends, or become its input if it reads any. Where the shell in front can\'t read this machine\'s temp files, a long command goes in a line at a time, and the round trips count against its timeout. Use tailLogs to check on a running command, sendInput to answer it (refused while a command is still on its way in, since the shell in front could read the input instead, so input sent straight after a return with -1, or while commands sent meanwhile go in, may need sending again), or sendSignal with SIGINT (the default) to interrupt it. Its Ctrl-C gives up a command whose body is still being typed in, which then never runs, and can discard or give up the commands typed in behind it; sendSignal\'s description says which. Other signals go to the session\'s shell itself.' },
        raw: { type: 'boolean', description: 'If true, preserve raw ANSI escape codes in output (default: false, returns clean text)' }
      },
      required: ['session', 'command']
    }
  },
  listSessions: {
    description: 'List all active sessions',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  tailLogs: {
    description: 'Get recent logs from a session',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        lines: { type: 'number' },
        raw: { type: 'boolean', description: 'If true, preserve raw ANSI escape codes in output (default: false, returns clean text)' }
      },
      required: ['session']
    }
  },
  sendInput: {
    description: 'Send input to an interactive session. Text is sent verbatim; use `keys` for special keys (Enter, C-c for Ctrl+C, arrows, ...) since raw control characters cannot pass through the JSON layer. Refused, with nothing sent, while a command is still on its way in, since until it has started, the shell in front could read the input instead of the command. The refusal ends when the command starts, ends or is given up, or after two seconds in which the server has typed no line and read no marker, as when a program took the command\'s line or a busy shell hasn\'t read it yet; that lapse doesn\'t mean the command has started. Send refused input again in a moment. To interrupt a command, use sendSignal with SIGINT, its default, or send the C-c key alone here (empty text, keys ["C-c"]): neither is refused, and both give up the commands still being typed in before the Ctrl+C. A ^C in the text among other characters does the same once input is accepted.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        input: { type: 'string', description: 'Literal text to type (can be empty when only sending keys)' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Named keys sent after the text, tmux send-keys style: Enter, Tab, Shift-Tab, Esc, Space, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12, C-a..C-z (Ctrl), M-<char> (Alt). E.g. ["Enter"] to submit in a TUI, ["C-c"] for Ctrl+C, ["Esc"] to dismiss.'
        },
        appendNewline: { type: 'boolean', description: 'Append Enter (\\r) after input. Default: true when `keys` is absent, false when `keys` is given.' }
      },
      required: ['session', 'input']
    }
  },
  sendSignal: {
    description: 'Send a signal to a session. SIGINT, the default, is sent as Ctrl+C; other signals go to the session\'s shell itself. SIGINT first gives up any command whose body is still being typed in, or waits its turn to be, and a command whose line is held back behind a body, so these never run. A command whose line is already typed is given up only if its shell turns out to need its body typed. The rest is the shell\'s and the terminal\'s, as without the server: the Ctrl+C can stop a command as it runs, and a line nothing has read yet is discarded with it under the terminal\'s default settings, or, under `stty noflsh`, left to be read after it. A caller still waiting gets the give-up\'s -1, the command\'s own exit code, or its timeout\'s -1, whichever comes first; a command the Ctrl+C kills can end without its exit marker, since bash 4 and later drop the rest of the line. Commands waiting in the server\'s queue aren\'t given up: each goes in after the Ctrl+C in its turn.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        signal: { type: 'string', description: 'Signal to send (default: SIGINT)' }
      },
      required: ['session']
    }
  },
  killSession: {
    description: 'Kill a specific session',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        graceful: { type: 'boolean', description: 'If false, force kills immediately. Default true for graceful shutdown with 3s timeout' }
      },
      required: ['session']
    }
  },
  killAll: {
    description: 'Kill all active sessions',
    parameters: {
      type: 'object',
      properties: {
        graceful: { type: 'boolean', description: 'If false, force kills immediately. Default true for graceful shutdown with 3s timeout' }
      }
    }
  },
  searchLogs: {
    description: 'Search for patterns in session logs',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to search in' },
        pattern: { type: 'string', description: 'Pattern to search for (regex supported)' },
        context: { type: 'number', description: 'Number of context lines to show (default: 3)' },
        raw: { type: 'boolean', description: 'If true, preserve raw ANSI escape codes in output (default: false, returns clean text)' }
      },
      required: ['session', 'pattern']
    }
  },
  takeScreenshot: {
    description: 'Take a screenshot of the terminal session (useful for visually rich TUIs, ANSI art, progress bars)',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to screenshot' },
        lines: { type: 'number', description: 'Number of recent lines to capture (default: 50)' },
        outputPath: { type: 'string', description: 'Optional file path to save screenshot (returns base64 if omitted)' },
        width: { type: 'number', description: 'Screenshot width in pixels (default: 1200)' },
        height: { type: 'number', description: 'Screenshot height in pixels (default: 800)' }
      },
      required: ['session']
    }
  }
};

// Set once stdin has closed: no answer is written after that (see the close
// handler at the end of this file).
let closing = false;

// Send response
function sendResponse(id: string | number, result?: any, error?: any) {
  if (closing) return;
  const response = {
    jsonrpc: '2.0',
    id,
    ...(error ? { error } : { result })
  };
  const output = JSON.stringify(response);
  
  // Debug: log what we're sending
  if (process.env.MCP_DEBUG) {
    console.error('[SEND]', output);
  }
  
  console.log(output);
}

// Handle incoming messages
rl.on('line', async (line) => {
  let messageId: string | number | undefined;
  
  try {
    const message = JSON.parse(line);
    const { id, method, params } = message;
    messageId = id;
    
    // Log to stderr for debugging
    if (process.env.MCP_DEBUG) {
      console.error('Received:', method, 'id:', id, 'params:', params);
    }
    
    // Handle notifications (messages without id) - these don't need responses
    if (id === undefined || id === null) {
      if (process.env.MCP_DEBUG) {
        console.error('Ignoring notification:', method);
      }
      return;
    }
    
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: '2025-06-18',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'terminal-sessions-mcp',
            version: getPackageVersion()
          }
        });
        break;
        
      case 'tools/list':
        sendResponse(id, {
          tools: Object.entries(TOOLS).map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: def.parameters
          }))
        });
        break;
        
      case 'tools/call':
        try {
          const { name, arguments: args } = params;
          let result;
          
          // Call the appropriate method
          const mcpInstance = getMCP();
          switch (name) {
            case 'launch':
              result = await mcpInstance.launch(args);
              break;
            case 'runCommand':
              result = await mcpInstance.runCommand(args);
              break;
            case 'listSessions':
              result = await mcpInstance.listSessions();
              break;
            case 'tailLogs':
              result = await mcpInstance.tailLogs(args);
              break;
            case 'sendInput':
              result = await mcpInstance.sendInput(args);
              break;
            case 'sendSignal':
              result = await mcpInstance.sendSignal(args);
              break;
            case 'killSession':
              result = await mcpInstance.killSession(args);
              break;
            case 'killAll':
              result = await mcpInstance.killAll(args);
              break;
            case 'searchLogs':
              result = await mcpInstance.searchLogs(args);
              break;
            case 'takeScreenshot':
              result = await mcpInstance.takeScreenshot(args);
              break;
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
          
          // Special handling for screenshot - return image content
          if (name === 'takeScreenshot' && 
              typeof result === 'object' && 
              result !== null && 
              'success' in result && 
              result.success && 
              'base64' in result) {
            sendResponse(id, {
              content: [
                {
                  type: 'image',
                  data: result.base64,
                  mimeType: 'image/png'
                },
                {
                  type: 'text',
                  text: 'path' in result && result.path ? `Saved to: ${result.path}` : 'Screenshot captured'
                }
              ]
            });
          } else {
            sendResponse(id, {
              content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }]
            });
          }
        } catch (err: any) {
          sendResponse(id, null, {
            code: -32000,
            message: err.message
          });
        }
        break;
        
      default:
        sendResponse(id, null, {
          code: -32601,
          message: `Method not found: ${method}`
        });
    }
  } catch (err: any) {
    console.error('Error processing message:', err);
    // Send proper JSON-RPC error response if we have an id
    if (messageId !== undefined) {
      sendResponse(messageId, null, {
        code: -32603,
        message: `Internal error: ${err.message}`
      });
    }
  }
});

// Minimal startup - don't pollute stderr unless debugging
if (process.env.MCP_DEBUG) {
  console.error('Terminal Sessions MCP Server started');
  const url = process.env.SESSION_SERVER_URL || 
    `ws://${process.env.SESSION_SERVER_HOST || 'localhost'}:${process.env.SESSION_SERVER_PORT || '3100'}`;
  console.error(`Connecting to session server at: ${url}`);
}

// Keep process alive
process.stdin.resume();

// Exit on SIGINT or SIGTERM, and when the client closes stdin (MCP's stdio
// shutdown), whether or not a tool call has opened the session server
// connection. Installing a signal listener removes Node's default exit for
// that signal, so the handler must exit in every state; and once a tool call
// has opened the WebSocket, a closed stdin alone would not end the process.
const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// On a closed stdin, write no more answers, and exit once those already
// written have left: writes to a pipe are asynchronous on POSIX, and
// process.exit() drops any still queued. A signal still exits at once.
rl.on('close', () => {
  closing = true;
  process.stdout.write('', shutdown);
});
