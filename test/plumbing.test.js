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
const bareSession = () => ({
  issued: new Map(), issuedPaths: new Set(), pendingFiles: new Map(),
  typedInline: new Set(), scanCarry: '', awaitingMarkers: [], logs: []
});

test('remembered commands: at most 1024, the oldest settled ones forgotten first, never a pending one', () => {
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

test('a forgotten command takes its typed-inline mark with it', () => {
  const server = bareServer();
  const session = bareSession();
  for (let i = 0; i < 1100; i++) {
    session.typedInline.add(`n${i}`);
    server.rememberIssued(session, `n${i}`, `/tmp/f${i}`);
  }
  assert.equal(session.issued.size, 1024);
  assert.equal(session.typedInline.size, 1024, 'the marks go with their commands');
  assert.ok(!session.typedInline.has('n75') && session.typedInline.has('n76'));
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
    assert.equal(session.issued.size, 0, 'a command whose file failed is not remembered as issued');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(target, { force: true });
  }
});

/** The line the server types for a command (writeCommandViaTempFile makes the `. '<file>'` part). */
const typedLine = (nonce, file) => bareServer().wrapperLine(nonce, `. '${file}'`);
// A body as printfBody escapes it: `cat <<'E'`, a line with a tab, a
// backslash, `%d` and a `!`, and `E`.
const ESCAPED_BODY = 'cat <<\\0047E\\0047\\na\\tb \\\\ %d \\0041\\nE';
// Each line the server types: the wrapper (inside the others), the probe line
// typed for every command, and the inline line typed for a shell that can't
// read the temp file.
const typedLines = (nonce, file) => ({
  wrapper: typedLine(nonce, file),
  probe: bareServer().probeLine(nonce, `'${file}'`),
  inline: bareServer().inlineLine(nonce, ESCAPED_BODY)
});
// What readline writes where an echoed line soft-wraps: bash 3.2 on macOS
// writes a space and a carriage return; a cursor-moving escape stands for
// the other form the patterns allow.
const ARTIFACTS = [' \r', '\r', '\x1b[1C'];

test('every typed line, soft-wrapped at any point, seams included, is removed and the text beside it stays', () => {
  const server = bareServer();
  const session = bareSession();
  // A path with a space too, as a WSL user name can give: a bare carriage
  // return after its space may be an artifact of its own or the end of bash
  // 3.2's space-and-return.
  const commands = [['k3x9q2a', '/tmp/tsm-cmd-4242-k3x9q2a.sh'], ['k3x9q2b', '/mnt/c/Users/Jo Doe/Temp/tsm-cmd-4242-k3x9q2b.sh']];
  for (const [nonce, file] of commands) server.rememberIssued(session, nonce, file);
  for (const [form, line] of commands.flatMap(([nonce, file]) => Object.entries(typedLines(nonce, file)).map(([form, line]) => [`${form} ${nonce}`, line]))) {
    assert.equal(server.stripPlumbingSpans(session, `BEFORE${line}AFTER`), 'BEFOREAFTER', form);
    assert.equal(server.stripPlumbingSpans(session, `BEFORE${line}\r\nAFTER`), 'BEFOREAFTER', `${form}: the newline that ends the echo goes with it`);
    const missed = [];
    for (const artifact of ARTIFACTS) {
      for (let cut = 1; cut <= line.length; cut++) {
        const wrapped = line.slice(0, cut) + artifact + line.slice(cut);
        if (server.stripPlumbingSpans(session, `BEFORE${wrapped}AFTER`) !== 'BEFOREAFTER') missed.push({ form, artifact, cut, at: line.slice(cut - 3, cut + 3) });
      }
    }
    assert.deepEqual(missed, []);
    // A narrow terminal wraps the echo several times.
    for (const width of [17, 23, 30]) {
      let wrapped = '';
      for (let i = 0; i < line.length; i += width) wrapped += line.slice(i, i + width) + (i + width < line.length ? ' \r' : '');
      assert.equal(server.stripPlumbingSpans(session, `BEFORE${wrapped}AFTER`), 'BEFOREAFTER', `${form} wrapped every ${width} columns`);
    }
  }
});

test("a typed line or marker with a nonce and path the server never issued is output, wrapped or not", () => {
  const server = bareServer();
  const session = bareSession();
  server.rememberIssued(session, 'k3x9q2a', '/tmp/tsm-cmd-4242-k3x9q2a.sh');
  for (const other of Object.values(typedLines('zz11yy2', '/tmp/tsm-cmd-4242-zz11yy2.sh'))) {
    assert.equal(server.stripPlumbingSpans(session, other), other);
    const wrapped = other.slice(0, 20) + ' \r' + other.slice(20);
    assert.equal(server.stripPlumbingSpans(session, wrapped), wrapped);
  }
  for (const marker of ['<<<NOFILE:zz11yy2>>>', '<<<GONE:zz11yy2>>>']) {
    assert.equal(server.stripPlumbingSpans(session, marker), marker);
  }
});

/** checkCommandCompletion on a session whose newest output is `chunk`. */
function scan(server, session, chunk) {
  session.outputBuffer += chunk;
  server.checkCommandCompletion(session, chunk);
}

test("a start marker releases every earlier command's file, and none after it", () => {
  const server = bareServer();
  const session = { ...bareSession(), outputBuffer: '', currentCommand: undefined };
  // Fake paths: removeTempFile is best-effort, so only the bookkeeping is checked.
  for (const n of ['n1', 'n2', 'n3', 'n4']) {
    session.issued.set(n, `/nonexistent/${n}.sh`);
    session.pendingFiles.set(n, `/nonexistent/${n}.sh`);
  }
  scan(server, session, 'output\r\n<<<START:n3>>>\r\n');
  assert.deepEqual([...session.pendingFiles.keys()], ['n3', 'n4']);
});

test('a start marker for a command no longer pending releases nothing', () => {
  const server = bareServer();
  const session = { ...bareSession(), outputBuffer: '', currentCommand: undefined };
  for (const n of ['n3', 'n4', 'n5']) session.issued.set(n, `/nonexistent/${n}.sh`);
  for (const n of ['n4', 'n5']) session.pendingFiles.set(n, `/nonexistent/${n}.sh`);
  // n3 started and finished earlier; its start marker printed again must not
  // release n4 or n5.
  scan(server, session, '<<<START:n3>>>\r\nok\r\n');
  assert.deepEqual([...session.pendingFiles.keys()], ['n4', 'n5']);
});

test("the probe reads the temp file in a shell with a function of its own named test", () => {
  const { execFileSync } = require('node:child_process');
  const server = bareServer();
  const file = path.join(os.tmpdir(), `tsm-test-${process.pid}-probe.sh`);
  fs.writeFileSync(file, 'echo RAN\n');
  try {
    // People name a function `test` for running a project's tests; the probe
    // tests the file with `[`, so such a function doesn't send it the body.
    const line = server.probeLine('np', `'${file}'`);
    for (const shell of ['sh', 'bash']) {
      const out = execFileSync(shell, ['-c', `test() { return 1; }\n${line}\n`], { encoding: 'utf8' });
      assert.equal(out, '<<<START:np>>>\nRAN\n<<<EXIT:np:0>>>\n', shell);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});

/** A command written to `session` under `nonce`, its temp file holding `body` and pending. */
function pendingFile(session, nonce, body) {
  const file = path.join(os.tmpdir(), `tsm-test-${process.pid}-${nonce}.sh`);
  fs.writeFileSync(file, body);
  session.issued.set(nonce, file);
  session.pendingFiles.set(nonce, file);
  return file;
}

test('a no-file marker types the body from its temp file inline, once, even for a command that has timed out, and sh and bash run it', () => {
  const { execFileSync } = require('node:child_process');
  const server = bareServer();
  const written = [];
  // Quotes, backslashes (one before c, which printf's %b would act on), a
  // format directive, a `!`, a tab, non-ASCII text and an escape character.
  const content = `it's "quoted" \\ back\\slash \\c %d!x\ttab \u00fcn\u00ef \x1b[0m`;
  // n1 timed out, so no command is current: its line was typed in behind a
  // busy shell that has only now read it.
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const file = pendingFile(session, 'n1', `cat <<'TSM_END'\n${content}\nTSM_END\n(exit 7)\n`);
  try {
    scan(server, session, 'prompt$ <<<NOFILE:n1>>>\r\n');
    // The marker printed again, as a reader that took the line might.
    scan(server, session, 'prompt$ <<<NOFILE:n1>>>\r\n');
    assert.equal(written.length, 1, 'typed once');
    // One line: in a shell where the variable named for the command holds
    // its own pid, the escaped body put in that variable and the wrapper
    // around an eval of it. The body's characters are printable ASCII other
    // than the single quote (space to & and ( to ~), and the check after it
    // excludes `!` too.
    assert.match(written[0],
      /^if \[ "\$\{__tsm_n1-\}" = "\$\$" \]; then __tsm_n1='[ -&(-~]*'; echo "<<<STAR""T:n1>>>"; eval "unset __tsm_n1; \$\(printf '%b' "\$__tsm_n1"\)"; echo "<<<EXI""T:n1:\$\?>>>"; else echo "<<<GON""E:n1>>>"; fi\n$/);
    assert.ok(!written[0].includes('!'), 'no `!` for an older bash to history-expand');
    const left = 'echo "left:${__tsm_n1-unset}"\n';
    // What the probe's else branch sets in the shell that couldn't read the file.
    const asked = '__tsm_n1=$$\n';
    for (const shell of ['sh', 'bash']) {
      const run = (script) => execFileSync(shell, ['-c', script], { encoding: 'utf8' });
      // In the shell that asked, it runs the body to its bytes and status, and
      // leaves no variable behind.
      assert.equal(run(asked + written[0] + left), `<<<START:n1>>>\n${content}\n<<<EXIT:n1:7>>>\nleft:unset\n`, shell);
      // A shell without the variable, as when the one that asked has gone,
      // runs nothing.
      assert.equal(run(written[0] + left), '<<<GONE:n1>>>\nleft:unset\n', shell);
      // Nor does a child that inherited it, exported under `set -a`. (The
      // `true` after it keeps the outer shell from exec'ing the child in its
      // own place, with its own pid, as bash does with a last command.)
      const quoted = `'${written[0].replace(/'/g, `'\\''`)}'`;
      assert.equal(run(`set -a; ${asked}${shell} -c ${quoted}; true\n`), '<<<GONE:n1>>>\n', `${shell}: a child`);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a body whose line would pass 1,000 bytes, whose file alone does, or whose file is gone, is not typed: its file goes, and the log says why once', () => {
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  try {
    // The line's length past the body itself, for a nonce of this length.
    const overhead = server.inlineLine('nb', '').length;
    pending('na', 'a'.repeat(1000 - overhead));
    pending('nb', 'a'.repeat(1001 - overhead));
    scan(server, session, '<<<NOFILE:na>>>\r\n<<<NOFILE:nb>>>\r\n');
    assert.equal(written.length, 1, 'a line of exactly 1,000 bytes is typed');
    assert.equal(written[0].length, 1001, 'with its newline');
    assert.match(session.logs.at(-1), /a line over 1000 bytes \(1001 bytes, \d+ of them the body escaped for printf\), which a shell can cut short/, 'one byte more is refused');
    assert.ok(!fs.existsSync(files[1]) && !session.pendingFiles.has('nb'));
    // Under the limit as bytes, over it escaped: each non-ASCII byte takes five.
    pending('nc', 'echo ' + '\u00e9'.repeat(200));
    scan(server, session, '<<<NOFILE:nc>>>\r\n');
    assert.ok(!session.pendingFiles.has('nc'));
    // A newline takes two: 400 of them fit.
    pending('nd', 'true' + '\n'.repeat(400));
    scan(server, session, '<<<NOFILE:nd>>>\r\n');
    assert.equal(written.length, 2, 'a body of newlines that fits at two characters each is typed');
    // A file over the limit on its own is refused with its size, unread.
    pending('nf', 'a'.repeat(2000));
    scan(server, session, '<<<NOFILE:nf>>>\r\n');
    assert.match(session.logs.at(-1), /a line over 1000 bytes \(its body alone is 2000 bytes\), which a shell can cut short/);
    assert.ok(!fs.existsSync(files.at(-1)) && !session.pendingFiles.has('nf'));
    assert.equal(written.length, 2);
    session.issued.set('ne', path.join(os.tmpdir(), `tsm-test-${process.pid}-gone.sh`));
    session.pendingFiles.set('ne', path.join(os.tmpdir(), `tsm-test-${process.pid}-gone.sh`));
    scan(server, session, '<<<NOFILE:ne>>>\r\n');
    assert.ok(!session.pendingFiles.has('ne'));
    assert.match(session.logs.at(-1), /this command's temp file couldn't be read here either/);
    // Printed again, a refused command's marker finds its file released and
    // does nothing more.
    const logged = session.logs.length;
    scan(server, session, '<<<NOFILE:nb>>>\r\n<<<NOFILE:ne>>>\r\n');
    assert.equal(session.logs.length, logged);
    assert.equal(written.length, 2);
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test("a no-file marker split across a command's write, which clears the output buffer, is still seen", () => {
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const file = pendingFile(session, 'na', 'echo A\n');
  try {
    scan(server, session, 'prompt$ <<<NOFI');
    session.outputBuffer = ''; // processCommandQueue clears it when it writes the next command
    scan(server, session, 'LE:na>>>\r\n');
    assert.equal(written.length, 1, "A's body is typed");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("markers after one that ends the waiting command are still handled, and a gone marker ends a waiting command with -1 and the reason", () => {
  const server = bareServer();
  const written = [];
  const results = [];
  const waiting = (nonce) => ({ command: `command ${nonce}`, nonce, startTime: Date.now(), resolve: (result) => results.push(result) });
  const session = {
    ...bareSession(), id: 's', outputBuffer: '', isProcessingCommand: true, commandQueue: [],
    shell: { write: (text) => written.push(text) }, currentCommand: waiting('nc')
  };
  session.issued.set('nc', '/tmp/nc');
  const file = pendingFile(session, 'nd', 'echo D\n');
  try {
    // nc's exit marker, then nd's no-file marker, in one chunk.
    scan(server, session, '<<<START:nc>>>\r\nC\r\n<<<EXIT:nc:0>>>\r\n<<<NOFILE:nd>>>\r\n');
    assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[0, 'C']]);
    assert.equal(written.length, 1, "nd's body is typed after nc ended");
    session.currentCommand = waiting('nd');
    session.isProcessingCommand = true;
    scan(server, session, '<<<GONE:nd>>>\r\n');
    assert.equal(results.length, 2);
    assert.equal(results[1].exitCode, -1);
    assert.match(results[1].output, /^\[command not run: its body's line reached a shell other than the one that asked for it, so nothing ran\]$/);
    assert.equal(session.currentCommand, undefined);
    // Printed again, the markers do nothing more.
    scan(server, session, '<<<EXIT:nc:0>>>\r\n<<<NOFILE:nd>>>\r\n<<<GONE:nd>>>\r\n');
    assert.equal(results.length, 2);
    assert.equal(written.length, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a marker counts only once its line has ended, so nothing is typed between it and its newline, even when an echo lands there", () => {
  const server = bareServer();
  const written = [];
  const results = [];
  const session = {
    ...bareSession(), id: 's', outputBuffer: '', isProcessingCommand: true, commandQueue: [],
    shell: { write: (text) => written.push(text) },
    currentCommand: { command: 'c', nonce: 'nc', startTime: Date.now(), resolve: (result) => results.push(result) }
  };
  for (const nonce of ['nc', 'nf']) session.issued.set(nonce, `/tmp/${nonce}`);
  const file = pendingFile(session, 'nd', 'echo D\n');
  try {
    scan(server, session, '<<<START:nc>>>\r\nC\r\n<<<EXIT:nc:0>>>');
    assert.equal(results.length, 0, 'not ended before its exit marker\'s newline');
    scan(server, session, '\r');
    assert.equal(results.length, 0);
    scan(server, session, '\n');
    assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[0, 'C']]);
    scan(server, session, '<<<NOFILE:nd>>>');
    assert.equal(written.length, 0, 'no body typed before the no-file marker\'s newline');
    scan(server, session, '\r\n');
    assert.equal(written.length, 1);
    // Input typed at that moment, here a line's echo or 600 or 5,000
    // characters, can land between a marker and its newline; the marker
    // counts once its line ends all the same.
    const echo = typedLines('ne', '/tmp/tsm-cmd-4242-ne.sh').probe;
    for (const between of [echo, 'x'.repeat(600), 'y'.repeat(5000)]) {
      results.length = 0;
      session.currentCommand = { command: 'c', nonce: 'nf', startTime: Date.now(), resolve: (result) => results.push(result) };
      session.isProcessingCommand = true;
      scan(server, session, '<<<START:nf>>>\r\nF\r\n<<<EXIT:nf:0>>>');
      scan(server, session, between);
      assert.equal(results.length, 0);
      scan(server, session, '\r\n');
      assert.deepEqual(results.map((r) => r.exitCode), [0], `an exit marker with ${between.length} characters before its newline`);
    }
    const files = [];
    for (const [k, between] of [echo, 'x'.repeat(600), 'y'.repeat(5000)].entries()) {
      const nonce = `ng${k}`;
      files.push(pendingFile(session, nonce, 'echo G\n'));
      const typed = written.length;
      scan(server, session, `<<<NOFILE:${nonce}>>>`);
      scan(server, session, between);
      scan(server, session, '\r\n');
      assert.equal(written.length, typed + 1, `a no-file marker with ${between.length} characters before its newline`);
    }
    for (const typedFile of files) fs.rmSync(typedFile, { force: true });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("only this session's commands' markers wait for their line to end, each once, and the next newline acts on them", () => {
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const file = pendingFile(session, 'nm', 'echo M\n');
  try {
    // A command's output: markers with a nonce this session never issued.
    scan(server, session, '<<<NOFILE:unknown>>>'.repeat(10000));
    assert.equal(session.awaitingMarkers.length, 0);
    // A marker of this session's printed back three times on one line.
    scan(server, session, '<<<NOFILE:nm>>>'.repeat(3));
    assert.equal(session.awaitingMarkers.length, 1);
    scan(server, session, '\r\n');
    assert.equal(session.awaitingMarkers.length, 0);
    assert.equal(written.length, 1, 'its body is typed once');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a gone marker gives up on its command once, its file pending or already released", () => {
  const server = bareServer();
  const session = { ...bareSession(), outputBuffer: '', shell: { write() {} }, currentCommand: undefined };
  const file = pendingFile(session, 'ng', 'echo G\n');
  session.typedInline.add('ng');
  // nk's file is gone already: a later command's start marker released it.
  session.typedInline.add('nk');
  session.issued.set('nk', '/tmp/nk');
  try {
    scan(server, session, '<<<GONE:ng>>>\r\n');
    assert.ok(!fs.existsSync(file) && !session.pendingFiles.has('ng'));
    assert.match(session.logs.at(-1), /its body's line reached a shell other than the one that asked for it, so nothing ran/);
    scan(server, session, '<<<GONE:nk>>>\r\n');
    assert.equal(session.logs.length, 2);
    scan(server, session, '<<<GONE:ng>>>\r\n<<<GONE:nk>>>\r\n'); // printed again: nothing more
    assert.equal(session.logs.length, 2);
    server.rememberIssued(session, 'ng', file);
    assert.equal(server.stripPlumbingSpans(session, 'A<<<GONE:ng>>>\r\nB'), 'AB', 'the printed marker is plumbing');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
