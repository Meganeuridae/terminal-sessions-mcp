// Unit tests for the server's bookkeeping of issued commands, without a PTY.
// Runs against the compiled output: `npm test` (builds first, then node --test).
// These call private methods on a bare server and a minimal session object;
// TypeScript's `private` doesn't exist at runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test("a command's file is created exclusively: never through a link, never into a file that exists", () => {
  const server = bareServer();
  const session = bareSession();
  const nonce = `excl${process.pid}`;
  const file = path.join(os.tmpdir(), `tsm-cmd-${process.pid}-${nonce}.sh`);
  const target = path.join(os.tmpdir(), `tsm-link-target-${process.pid}`);
  fs.writeFileSync(target, 'ORIGINAL');
  fs.symlinkSync(target, file);
  try {
    assert.throws(() => server.writeCommandViaTempFile(session, nonce, 'echo redirected'), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'nothing was written through the link');
    assert.ok(fs.lstatSync(file).isSymbolicLink(), 'a file someone else made is left alone');
    assert.equal(session.pendingFiles.size, 0);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(target, { force: true });
  }
});
