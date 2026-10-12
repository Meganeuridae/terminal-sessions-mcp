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

/** The line the server types for a command, as processCommandQueue writes it. */
const typedLine = (nonce, file) => `echo "<<<STAR""T:${nonce}>>>"; . '${file}'; echo "<<<EXI""T:${nonce}:$?>>>"`;
// What readline writes where an echoed line soft-wraps: bash 3.2 on macOS
// writes a space and a carriage return; a cursor-moving escape stands for
// the other form the patterns allow.
const ARTIFACTS = [' \r', '\r', '\x1b[1C'];

test('a wrapper echo soft-wrapped at any point, seams included, is removed and the text beside it stays', () => {
  const server = bareServer();
  const session = bareSession();
  const nonce = 'k3x9q2a', file = '/tmp/tsm-cmd-4242-k3x9q2a.sh';
  server.rememberIssued(session, nonce, file);
  const line = typedLine(nonce, file);
  assert.equal(server.stripPlumbingSpans(session, `BEFORE${line}AFTER`), 'BEFOREAFTER');
  const missed = [];
  for (const artifact of ARTIFACTS) {
    for (let cut = 1; cut <= line.length; cut++) {
      const wrapped = line.slice(0, cut) + artifact + line.slice(cut);
      if (server.stripPlumbingSpans(session, `BEFORE${wrapped}AFTER`) !== 'BEFOREAFTER') missed.push({ artifact, cut, at: line.slice(cut - 3, cut + 3) });
    }
  }
  assert.deepEqual(missed, []);
  // A narrow terminal wraps the echo several times.
  for (const width of [17, 23, 30]) {
    let wrapped = '';
    for (let i = 0; i < line.length; i += width) wrapped += line.slice(i, i + width) + (i + width < line.length ? ' \r' : '');
    assert.equal(server.stripPlumbingSpans(session, `BEFORE${wrapped}AFTER`), 'BEFOREAFTER', `wrapped every ${width} columns`);
  }
});

test("a wrapper echo with a nonce and path the server never issued is output, wrapped or not", () => {
  const server = bareServer();
  const session = bareSession();
  server.rememberIssued(session, 'k3x9q2a', '/tmp/tsm-cmd-4242-k3x9q2a.sh');
  const other = typedLine('zz11yy2', '/tmp/tsm-cmd-4242-zz11yy2.sh');
  assert.equal(server.stripPlumbingSpans(session, other), other);
  const wrapped = other.slice(0, 20) + ' \r' + other.slice(20);
  assert.equal(server.stripPlumbingSpans(session, wrapped), wrapped);
});
