# Terminal Sessions MCP Setup Guide

This guide explains how to set up the Terminal Sessions MCP server with AI assistants like Cursor, Claude Desktop, or any other MCP-compatible client.

## Quick Setup

### Step 1: Install

```bash
npm install -g terminal-sessions-mcp
```

Or use it directly with npx (no installation needed):

```bash
npx terminal-sessions-mcp
```

### Step 2: Start the Session Server

In one terminal, start the WebSocket session server:

```bash
SESSION_SERVER_PORT=3100 npx session-server
```

Keep this running in the background.

### Step 3: Configure MCP Client

#### For Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "servers": {
    "terminal-sessions": {
      "command": "npx",
      "args": ["terminal-sessions-mcp"],
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

#### For Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "terminal-sessions": {
      "command": "npx",
      "args": ["terminal-sessions-mcp"],
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

### Step 4: Restart Your AI Assistant

Restart Cursor or Claude Desktop to load the new MCP server.

## Available Tools

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

### Log Operations
- **tailLogs** - Get recent logs from a session
- **searchLogs** - Search logs with regex patterns and context

## Usage Examples

Once set up, you can ask your AI assistant to:

- "Start the dev server and wait for it to be ready"
- "Run the tests in a persistent session"
- "Search the logs for any errors"
- "List all active sessions"
- "Send Ctrl+C to the running server"

## Troubleshooting

### MCP server not loading

1. Ensure the session server is running on the configured port
2. Check that all paths in the configuration are absolute
3. Restart your AI assistant after configuration changes
4. Check for errors in the AI assistant's logs

### Connection refused errors

Make sure the session server is running before the MCP server tries to connect:

```bash
# Terminal 1: Start session server
SESSION_SERVER_PORT=3100 npx session-server

# Terminal 2: Or use MCP directly (it will connect to the server)
```

### Debug mode

Enable debug logging:

```bash
MCP_DEBUG=1 npx terminal-sessions-mcp
```

Or for the session server:

```bash
DEBUG_SESSION_API=1 SESSION_SERVER_PORT=3100 npx session-server
```

## Advanced Configuration

### Custom Port

Change the default port (3100) by setting the environment variable:

```json
{
  "servers": {
    "terminal-sessions": {
      "command": "npx",
      "args": ["terminal-sessions-mcp"],
      "env": {
        "SESSION_SERVER_PORT": "3200"
      }
    }
  }
}
```

### Using with Local Development

If you're developing on the package locally:

```json
{
  "servers": {
    "terminal-sessions": {
      "command": "/path/to/node",
      "args": ["/path/to/terminal-sessions-mcp/dist/mcp/mcp-stdio-server.js"],
      "cwd": "/path/to/terminal-sessions-mcp",
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

## Security Considerations

- The session server has **full terminal access** on your system
- Only run it in trusted environments
- Be cautious about what commands you allow AI assistants to execute
- Consider running in a containerized environment for additional isolation

## Learn More

- [Main README](../README.md) - Package overview and API reference
- [SUMMARY.md](SUMMARY.md) - Development history and architecture decisions
- [Examples](../examples/) - Code examples for various use cases

