#!/usr/bin/env node

/**
 * Start the Session Server API (and optionally the GUI)
 */

import { SessionAPI } from './websocket-api';
import { WebGUIServer } from '../../gui/src/server';
import { ChildProcess, spawn } from 'child_process';
import { AccessOptions, accessFromEnv, splitList } from './request-guard';

// Parse command line arguments
const args = process.argv.slice(2);
const headless = args.includes('--headless') || process.env.HEADLESS === 'true';

// Parse --host option (e.g., --host 0.0.0.0 or --host=0.0.0.0)
function getArgValue(argName: string): string | undefined {
  const eqIndex = args.findIndex(a => a.startsWith(`--${argName}=`));
  if (eqIndex !== -1) {
    return args[eqIndex].split('=')[1];
  }
  const spaceIndex = args.indexOf(`--${argName}`);
  if (spaceIndex !== -1 && args[spaceIndex + 1] && !args[spaceIndex + 1].startsWith('--')) {
    return args[spaceIndex + 1];
  }
  return undefined;
}

// Every value of a repeatable option (--allow-host a --allow-host=b), each possibly comma-separated
function getArgValues(argName: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a.startsWith(`--${argName}=`)) out.push(a.slice(argName.length + 3));
    else if (a === `--${argName}` && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]);
  });
  return splitList(out);
}

const host = getArgValue('host') || process.env.SESSION_SERVER_HOST || 'localhost';
const port = parseInt(process.env.SESSION_SERVER_PORT || '3100');
const guiPort = parseInt(process.env.GUI_PORT || '3200');
const authToken = getArgValue('token') || process.env.SESSION_SERVER_TOKEN;
const envAccess = accessFromEnv();
const access: AccessOptions = {
  allowHosts: [...(envAccess.allowHosts ?? []), ...getArgValues('allow-host')],
  allowOrigins: [...(envAccess.allowOrigins ?? []), ...getArgValues('allow-origin')],
};

console.log(`
╔═══════════════════════════════════════╗
║    Terminal Sessions MCP Server       ║
║                                       ║
║  Persistent terminal sessions for     ║
║  collaborative AI testing             ║
╚═══════════════════════════════════════╝

Starting session server on ${host}:${port}...
${authToken ? '🔐 Token authentication enabled' : '⚠️  No authentication (use --token for security)'}
${authToken ? '' : '   Without a token, only localhost Host names' + (access.allowHosts?.length ? ` and ${access.allowHosts.join(', ')}` : '') + ' are served.\n'}${access.allowOrigins?.length ? `   Browser pages allowed besides the GUI: ${access.allowOrigins.join(', ')}\n` : ''}`);

const api = new SessionAPI(port, host, authToken, access);

const displayHost = host === '0.0.0.0' ? '<hostname>' : host;
console.log(`
✅ Session Server ready!

WebSocket URL: ws://${displayHost}:${port}
Health Check: http://${displayHost}:${port}/health

Available methods:
- session.create    Create a new terminal session
- session.exec      Execute a command
- session.output    Get session output
- session.search    Search logs with context
- session.list      List active sessions
- session.kill      Kill a session
- session.killAll   Kill all sessions
- session.input     Send input to interactive session
- session.signal    Send signal (SIGINT, etc)
- session.env       Get environment variables
- session.pwd       Get current directory
- service.start     Start a service with monitoring
`);

// Start GUI server unless in headless mode
let guiServer: WebGUIServer | null = null;
if (!headless) {
  try {
    console.log(`Starting web GUI on ${host}:${guiPort}...`);
    guiServer = new WebGUIServer(guiPort, host, authToken, access);
    const tokenHint = authToken ? `?token=...` : '';
    console.log(`✅ Web GUI ready at http://${displayHost}:${guiPort}${tokenHint}\n`);
  } catch (error: any) {
    console.error(`Failed to start GUI server: ${error.message}`);
    console.log('Continuing in headless mode...\n');
  }
} else {
  console.log('Running in headless mode (GUI disabled)\n');
}

console.log('Press Ctrl+C to stop\n');

// Graceful shutdown
const shutdown = async () => {
  console.log('\n\nShutting down gracefully...');
  await api.stop();
  if (guiServer) {
    await guiServer.stop();
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

