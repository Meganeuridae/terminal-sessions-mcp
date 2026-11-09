# Terminal Sessions MCP

**Interactive, persistent terminal sessions for AI assistants via Model Context Protocol**

## Terminal sessions 2.0, beside 1.x

This package also ships **2.0**, persistent shells for agents: one daemon (`termd`) per user keeps each session's login shell alive between calls and connections, an agent types into it only through explicit calls and gets the exit status, duration and directory of each command `run` types in an integrated shell (or the shell's exit, for a command that ends the shell), with its output, and an MCPL host is woken only when a command ends, a program waits for input, a shell dies or a pattern it asked for appears. It is in [`next/`](next/README.md). Its binaries are `termd`, `tsm` and `tsm-relay`. Everything below is about the 1.x binaries (`terminal-sessions-mcp`, `session-server`, `session-cli`), which run 1.x. 2.0 changes one thing they do: a graceful kill hangs up every process on the session's terminal once the shell is gone, as 2.0's `close` does, so a disowned job no longer outlives it. Otherwise, what reaches them is the package they share with 2.0: a narrower Node range (`engines`), `npm run build` and `npm test` building 2.0 too, and 2.0's dependencies installing with it.

## Why This Matters

While many AI tools offer basic command execution, Terminal Sessions MCP provides unique capabilities:

**What makes this different:**
- **Sessions survive IDE restarts** - Unlike typical tools, your sessions persist even when you close Cursor/Claude Desktop
- **Background tasks with log access** - Run dev servers, builds, or tests in background while retaining full access to their output
- **True interactivity** - Send input to prompts, handle confirmations, respond to interactive tools
- **Process control** - Send signals (Ctrl+C, Ctrl+Z) to gracefully manage long-running processes
- **Stateful environment** - `cd`, `export`, and environment changes persist across commands
- **Context search** - Search through command history and output with regex

Your AI assistant can now run servers in the background while working on other tasks, maintain persistent development environments, and handle interactive workflows.

## MCP Features

✅ **Truly Persistent Sessions** - Sessions survive Cursor/IDE restarts, keeping all state  
✅ **Interactive Workflows** - Handle password prompts, confirmations, and interactive tools  
✅ **Process Control** - Send signals (SIGINT, SIGTERM, SIGTSTP) to running processes  
✅ **Stateful Shell** - `cd`, `export`, and other state changes persist across AI responses  
✅ **Log Search** - Search through command history and output with regex and context  
✅ **Service Management** - Start services with intelligent readiness detection  
✅ **Smart Command Execution** - Detects when commands complete, handles long-running processes  
✅ **Multi-Session Management** - Track multiple services/sessions by name  
✅ **Real-Time Streaming** - Watch output as it happens, not just final results  

## Quick Start for AI Assistants

### 1. Install

**Option A: Global install (recommended)**
```bash
npm install -g term-sessions-mcp
```

**Option B: Local install**
```bash
npm install term-sessions-mcp
```

### 2. Start the Terminal Session Server

This is the backend server that actually manages your terminal sessions:

**If installed globally:**
```bash
session-server
# Starts session server on port 3100
```

**If installed locally:**
```bash
npx session-server
```

**Remote access (bind to all interfaces):**
```bash
session-server --host 0.0.0.0 --token your-secret-token
```

**Who may connect.** The session server refuses browser pages from other
sites: a request that carries an `Origin` must name the host and port the
request was sent to, or an origin you list with `--allow-origin`. Without a
token, it also serves only requests addressed to `localhost`,
`127.0.0.1`, `[::1]` or the bind address; to reach a token-less server by any
other name, list it with `--allow-host` (or, better, use `--token`):
```bash
session-server --allow-origin https://dashboard.example   # a page that drives the API from a browser
session-server --host 0.0.0.0 --allow-host mybox.local    # token-less, LAN name (prefer --token)
```
Both flags take comma-separated values and may repeat.

**Keep this server running** in the background - your AI assistant will connect to it.

### 3. Configure the MCP Bridge for Your AI

This connects your AI assistant (Cursor/Claude) to the session server:

**For Cursor:**
1. Open Cursor Settings
2. Go to **Cursor Settings** → **MCP**  
3. Click **"Add Custom MCP"**
4. This will open an editor for your MCP configuration
5. Add the following:

```json
{
  "mcpServers": {
    "terminal-sessions": {
      "command": "terminal-sessions-mcp",
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

**For Claude Desktop:**
Add to your `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "terminal-sessions": {
      "command": "terminal-sessions-mcp",
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

**If the above doesn't work**, you may need to use the full path. Find it with:
```bash
which terminal-sessions-mcp
```

Then use that path in your config:
```json
{
  "mcpServers": {
    "terminal-sessions": {
      "command": "/full/path/to/terminal-sessions-mcp",
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

**Important Notes:** 
- **Make sure `session-server` is running** on port 3100 before starting Cursor/Claude
- The `terminal-sessions-mcp` executable is the MCP bridge - Cursor/Claude runs it automatically
- You don't need to run `terminal-sessions-mcp` manually - only run `session-server`

### 4. Use with Your AI Assistant

Your AI assistant now has access to these MCP tools:

- `startService` - Start a service with readiness detection
- `runCommand` - Execute a command in a session
- `tailLogs` - Get recent output from a session  
- `searchLogs` - Search through output with regex
- `sendInput` - Send input to interactive prompts (with named-key support for TUIs)
- `sendSignal` - Send signals (Ctrl+C, etc.) to processes
- `listSessions` - See all active sessions
- `killSession` - Stop a session gracefully or forcefully

## TUI Applications

Each session runs in a pseudo-terminal, so TUI applications (htop, vim, tmux,
progress bars) run as they would in a terminal. Their output carries its escape
sequences for colors, cursor positioning and screen clearing: `raw: true`
returns them as written, and without it they're removed.

## API Usage

### From TypeScript/JavaScript

```typescript
import { SessionClient } from 'term-sessions-mcp';

const client = new SessionClient('ws://localhost:3100');

// Create a session
await client.createSession({ id: 'my-session' });

// Execute commands
const result = await client.exec('my-session', 'npm test');
console.log(result.output);

// Search logs
const matches = await client.searchLogs('my-session', 'error|warning', 5);
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│    Session Server (ws://localhost:3100)         │
│  - PTY-based persistent sessions                │
│  - WebSocket API                                │
│  - Event streaming                              │
└─────────────────────────────────────────────────┘
                     ↕ MCP Protocol
┌─────────────────────────────────────────────────┐
│       AI Assistant (Cursor, Claude, etc.)       │
│  - 9 MCP tools for session management           │
│  - Start services, run commands                 │
└─────────────────────────────────────────────────┘
```

## Available Tools (MCP)

Once configured, your AI assistant will have access to these tools:

### Session Management
- **startService** - Start a long-running service with startup detection
- **runCommand** - Execute a command and wait for completion
- **listSessions** - Get all active sessions
- **killSession** - Terminate a specific session (graceful by default). A graceful kill hangs up the shell and every process on its terminal. A process started with `setsid` or `nohup` outlives it.
- **killAll** - Terminate all active sessions

### Interactive Operations
- **sendInput** - Send input to a running process
- **sendSignal** - Send a signal (SIGINT, SIGTERM, etc)

#### sendInput: text, Enter, and named keys

`sendInput` sends the `input` text to the session PTY **verbatim**. Raw control
characters cannot pass through the JSON tool layer, so special keys are
expressed as **named keys** (tmux `send-keys` style) via the `keys` parameter:

```jsonc
// Type a message into a TUI composer, without submitting
{ "session": "codex", "input": "Hello there", "appendNewline": false }

// Press Enter (as a separate write — some TUIs treat text+CR in one
// write as a paste and won't submit)
{ "session": "codex", "input": "", "keys": ["Enter"] }

// Ctrl+C, Escape, arrow keys...
{ "session": "codex", "input": "", "keys": ["C-c"] }
{ "session": "vim",   "input": "", "keys": ["Esc", "Down", "Down"] }
```

Supported key names (case-insensitive): `Enter`, `Tab`, `Shift-Tab`, `Esc`/`Escape`,
`Space`, `Backspace`, `Delete`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`,
`PageUp`, `PageDown`, `F1`–`F12`, `C-a`..`C-z` (Ctrl+letter), `M-<char>` (Alt/Meta).
Unknown key names return an error listing the valid vocabulary.

`appendNewline` appends a carriage return (`\r`, what a real Enter key sends —
correct for both canonical-mode shells and raw-mode TUIs). It defaults to
**true** when `keys` is absent, and **false** when `keys` is given (the caller
controls the exact bytes; pass `appendNewline: true` explicitly to add Enter).

While a command is on its way in, `sendInput` refuses input other than a lone
`C-c` and sends nothing, since until the command has started, the shell in
front could read the input instead. A command is on its way in from the moment
its line is typed, or held behind a body still going in, until it starts, ends
or is given up, and a body typed in for a shell that can't read the temp file
is on its way in until it starts. A command waiting in the server's queue,
behind one that hasn't ended or timed out, isn't on its way in yet, so input
then goes to the running one. The refusal also ends after two seconds in which
the server has typed no line and read no marker, as when a program rather than
a shell took the command's line, or a busy shell hasn't read it yet; that
doesn't mean the command has started. Send refused input again in a moment. To
interrupt a command, use `sendSignal` with SIGINT, its default, or send the
`C-c` key alone (empty text, `keys: ["C-c"]`); neither is refused. When either
gives up a body that a shell which can't read the temp file is partway through
reading, while that shell is at its prompt and the body's line is the last the
server typed, the server writes no Ctrl-C: the shell is reading only the
server's own typing, which giving the body up stops, and a Ctrl-C reaching it
partway through one of the body's lines can leave the shell holding part of that
line. That line goes in whole, since each of a body's lines but its last only
stores part of the body, and input and the next command wait until the shell has
read it, as they wait between a body's lines; a Ctrl-C sent meanwhile isn't
written either. Like the refusal, the wait ends after two seconds in which the
server has typed no line and read no marker, and a Ctrl-C sent after that is
written, since the line may have gone to something other than the shell. The
server takes the shell to be at its prompt while the latest marker it printed
isn't a command's start marker, unless other input has been sent since and no
marker has come for a line the server typed after it. A shell that exits without
a marker, as when an ssh connection drops, goes unseen, so a Ctrl-C sent within
two seconds of the server's last line or marker may not be written, though a
program run after ssh on the same command line may be reading: send it again two
seconds later. A body whose lines are all typed may be running, and gets the
Ctrl-C, as does a body partway typed in when the server has typed another
command's line after the body's, since that line may run its command. So does a
body partway typed in after a command's start marker, since that command reads
the terminal and may have read the body's first line, and after other input sent
with `sendInput`, which may have started a command.

### Log Operations
- **tailLogs** - Get recent logs from a session
- **searchLogs** - Search logs with regex patterns and context

## CLI Usage

The package includes a CLI tool for manual session management:

```bash
# List sessions
npx session-cli list

# Create a session
npx session-cli create my-session --cwd=/path/to/dir

# Execute a command
npx session-cli exec my-session "npm test"

# Tail logs
npx session-cli tail my-session --lines=100

# Subscribe to live events
npx session-cli subscribe my-session --replay=50
```

## Use Cases

### 1. AI-Assisted Development

Enable AI assistants to manage development services, run tests, and interact with terminal sessions without losing context between responses.

### 2. Multi-Service Testing

Start and monitor multiple services simultaneously, with intelligent startup detection and log search.

### 3. Interactive Debugging

AI assistants can interact with running processes, send input, and observe output in real-time.

### 4. Team Collaboration

Share terminal sessions between multiple agents or humans.

## Development

```bash
# Clone the repository
git clone https://github.com/antra-tess/terminal-sessions-mcp.git
cd terminal-sessions-mcp

# Install dependencies
npm install

# Build
npm run build

# Start session server
npm run start-server

# Run CLI
npm run cli -- list

# Run demos
npx ts-node examples/service-management.ts
```

## Requirements

- **Node.js** 22.12 or later, below 25 (`engines`: `>=22.12.0 <25.0.0`; Node 20 reached its end of life on 2026-04-30; `session-cli` requires an ES-module-only dependency, which `require` loads from 22.12 on; Node 21 and 22.0 to 22.11 are out; Node 25+ not yet supported due to node-pty compatibility)

## Configuration

### Environment Variables

**Server:**
- `SESSION_SERVER_PORT` - WebSocket session server port (default: 3100)
- `SESSION_SERVER_HOST` - Host to bind to (default: localhost)
- `SESSION_SERVER_TOKEN` - Authentication token (optional, required for remote access by other names unless listed with `SESSION_SERVER_ALLOW_HOSTS`)
- `SESSION_SERVER_ALLOW_HOSTS` - Comma-separated Host names (optionally `name:port`) a token-less server serves besides the loopback names (same as `--allow-host`)
- `SESSION_SERVER_ALLOW_ORIGINS` - Comma-separated browser origins allowed besides the server's own (same as `--allow-origin`)

**MCP Client:**
- `SESSION_SERVER_URL` - Full WebSocket URL (e.g., `ws://192.168.1.100:3100`)
- `SESSION_SERVER_HOST` - Remote host (alternative to full URL)
- `SESSION_SERVER_PORT` - Remote port (default: 3100)
- `SESSION_SERVER_TOKEN` - Authentication token (must match server)
- `MCP_DEBUG` - Enable debug logging (set to "1")

### Remote Connections

You can connect to a session server running on a different machine:

**On the remote machine:**
```bash
session-server --host 0.0.0.0 --token mysecrettoken
```

**In your MCP config (local machine):**
```json
{
  "mcpServers": {
    "terminal-sessions-remote": {
      "command": "terminal-sessions-mcp",
      "env": {
        "SESSION_SERVER_URL": "ws://192.168.1.100:3100",
        "SESSION_SERVER_TOKEN": "mysecrettoken"
      }
    }
  }
}
```

You can configure multiple MCP servers to connect to different machines simultaneously.

## Troubleshooting

### MCP server not loading

1. Ensure the session server is running: `npx session-server`
2. Check that paths in mcp.json are absolute
3. Restart your AI assistant after configuration changes
4. Enable debug mode: `MCP_DEBUG=1`

## License

MIT

## Credits

Developed by [Anima Labs](https://github.com/anima-labs) as part of the Connectome project.

Extracted as a standalone package because terminal session management with proper TUI support is universally useful for AI-assisted development workflows.

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

---

**Star ⭐ this repo if you find it useful!**
