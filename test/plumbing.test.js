// Unit tests for the server's bookkeeping of issued commands, without a PTY.
// Runs against the compiled output: `npm test` (builds first, then node --test).
// These call private methods on a bare server and a minimal session object;
// TypeScript's `private` doesn't exist at runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');

const bareServer = () => Object.create(PersistentSessionServer.prototype);
const bareSession = () => ({ issued: new Map(), issuedPaths: new Set(), pendingFiles: new Map() });

test('remembered commands: 1024 settled ones, oldest forgotten first, and every pending one', () => {
  const server = bareServer();
  const session = bareSession();
  // The first command never finishes: the shell hasn't read past its line.
  session.pendingFiles.set('n0', '/tmp/f0');
  for (let i = 0; i < 1100; i++) server.rememberIssued(session, `n${i}`, `/tmp/f${i}`);
  assert.equal(session.issued.size, 1024);
  assert.equal(session.issuedPaths.size, 1024);
  assert.ok(session.issued.has('n0') && session.issuedPaths.has('/tmp/f0'), 'a pending command is never forgotten');
  assert.ok(!session.issued.has('n1') && !session.issuedPaths.has('/tmp/f1'), 'the oldest settled command goes first');
  assert.ok(session.issued.has('n77') && !session.issued.has('n76'), 'exactly the 76 oldest settled commands went');
  assert.ok(session.issued.has('n1099'));
});
