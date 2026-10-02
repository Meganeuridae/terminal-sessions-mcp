#!/usr/bin/env node
/**
 * The 1.x bin name (`terminal-sessions-mcp`, atc-19): the stdio shim serving the 1.x
 * tools. A dedicated entry, because wrapper installs (pnpm, cmd-shim, `node …/compat.js`)
 * do not pass the invoked name on to node.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for('term-sessions.shim.invokedAs')] = 'terminal-sessions-mcp';
await import('./stdio.js');
