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
    description: 'Run a command in a session (auto-creates the session if it does not exist). It runs in the shell in front, which can be one an earlier command started, such as ssh\'s; that shell has to be a POSIX shell (sh, bash, dash, zsh, ksh). Where it can\'t read this machine\'s temp files, the command is typed in escaped, in lines of at most 1,000 bytes; one that would take more than 128 such lines (about 100 KB) is not run: its result has exitCode -1 and the reason if it is still waiting, and the session log says why either way. The transport relies on the standard behavior of that shell\'s `.`, `eval`, `[`, `echo`, `printf` and `unset`: a function or alias that changes one of them can make a command report a status its body didn\'t produce.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session name (will be created automatically if it does not exist)' },
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory (used when auto-creating a new session)' },
        timeout: { type: 'number', description: 'Command timeout in ms (default: 30000). Use -1 to return immediately without waiting. A timed-out command keeps running in the session (exitCode -1 in the result), and commands sent meanwhile are typed in behind it: a long command typed into a shell that can\'t read this machine\'s files goes in a line at a time, each a round trip that counts against the timeout, and one still going in when its timeout passes is typed to its end and then runs; they run when it ends, or become its input if it reads any, and a shell it started, such as ssh\'s, runs them. Use tailLogs to check on it, sendInput to answer it, or sendSignal with SIGINT (the default, sent as Ctrl-C) to interrupt it, which under the terminal\'s default settings also discards the commands typed in behind it (with `stty noflsh` they are kept, and can still run after it); other signals go to the session\'s shell itself.' },
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
    description: 'Send input to an interactive session. Text is sent verbatim; use `keys` for special keys (Enter, Ctrl+C, arrows, ...) since raw control characters cannot pass through the JSON layer.',
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
    description: 'Send a signal to a session (e.g., SIGINT for Ctrl+C)',
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

// Send response
function sendResponse(id: string | number, result?: any, error?: any) {
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
            version: '1.0.0'
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

// Handle graceful shutdown
process.on('SIGINT', () => {
  if (mcp) {
    // Close WebSocket connection if it exists
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  if (mcp) {
    // Close WebSocket connection if it exists
    process.exit(0);
  }
});
