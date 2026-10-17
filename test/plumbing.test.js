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
  unfinished: new Map(), typedInline: new Set(), inlinePieces: new Map(), inlineQueue: [], typedCount: 0, lineSeq: new Map(), scanCarry: '', awaitingMarkers: [], logs: [],
  interruptedProbes: new Set()
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

test('an unfinished command is remembered past the limit, and a forgotten one takes its typed-inline mark with it', () => {
  const server = bareServer();
  const session = bareSession();
  // n0 started a shell that hasn't exited, so its exit marker is still to come.
  session.unfinished.set('n0', true);
  for (let i = 0; i < 1100; i++) {
    session.typedInline.add(`n${i}`);
    server.rememberIssued(session, `n${i}`, `/tmp/f${i}`);
  }
  assert.equal(session.issued.size, 1024);
  assert.ok(session.issued.has('n0'), 'an unfinished command is never forgotten');
  assert.equal(session.typedInline.size, 1024, 'the marks go with their commands');
  assert.ok(session.typedInline.has('n0') && !session.typedInline.has('n1'));
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
// typed for every command, and the lines typed for a shell that can't read
// the temp file: a body on one line, and the first, a middle and the last
// line of one typed in pieces.
const typedLines = (nonce, file) => ({
  wrapper: typedLine(nonce, file),
  probe: bareServer().probeLine(nonce, `'${file}'`),
  inline: bareServer().inlinePiece(nonce, ESCAPED_BODY, 'only', 0, 0),
  first: bareServer().inlinePiece(nonce, ESCAPED_BODY, 'first', 0, 0),
  middle: bareServer().inlinePiece(nonce, ESCAPED_BODY, 'middle', 885, 1),
  last: bareServer().inlinePiece(nonce, ESCAPED_BODY, 'last', 1770, 2)
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
    // A line ending exactly at the right edge: bash 5.2's readline moves the
    // cursor back up and writes the line's last character again.
    const atEdge = line + ' \r\x1b[A' + '\x1b[C'.repeat(119) + '\x1b[K' + line.at(-1) + '\r\n';
    assert.equal(server.stripPlumbingSpans(session, `BEFORE${atEdge}AFTER`), 'BEFOREAFTER', `${form} ending at the edge`);
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
// A command written to the shell: its file pending, its probe line typed now.
function pendingFile(session, nonce, body) {
  const file = path.join(os.tmpdir(), `tsm-test-${process.pid}-${nonce}.sh`);
  fs.writeFileSync(file, body);
  session.issued.set(nonce, file);
  session.pendingFiles.set(nonce, file);
  if (session.lineSeq) session.lineSeq.set(nonce, ++session.typedCount);
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
    // One line: in a shell where the pid variable named for the command holds
    // its own pid, the escaped body put in the body variable and the wrapper
    // around an eval of it. The body's characters are printable ASCII other
    // than the single quote (space to & and ( to ~), and the check after it
    // excludes `!` too.
    assert.match(written[0],
      /^if \[ "\$\{__tsm_n1-\}" = "\$\$" \]; then __tsm_n1_b='[ -&(-~]*'; echo "<<<STAR""T:n1>>>"; eval "unset __tsm_n1 __tsm_n1_b; \$\(printf '%b' "\$__tsm_n1_b"\)"; echo "<<<EXI""T:n1:\$\?>>>"; else echo "<<<GON""E:n1>>>"; fi\n$/);
    assert.ok(!written[0].includes('!'), 'no `!` for an older bash to history-expand');
    const left = 'echo "left:${__tsm_n1-unset}:${__tsm_n1_b-unset}"\n';
    // What the probe's else branch sets in the shell that couldn't read the file.
    const asked = '__tsm_n1=$$\n';
    for (const shell of ['sh', 'bash']) {
      const run = (script) => execFileSync(shell, ['-c', script], { encoding: 'utf8' });
      // In the shell that asked, it runs the body to its bytes and status, and
      // leaves no variable behind.
      assert.equal(run(asked + written[0] + left), `<<<START:n1>>>\n${content}\n<<<EXIT:n1:7>>>\nleft:unset:unset\n`, shell);
      // A shell without the variable, as when the one that asked has gone,
      // runs nothing.
      assert.equal(run(written[0] + left), '<<<GONE:n1>>>\nleft:unset:unset\n', shell);
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

test('a body that would pass one line of 1,000 bytes goes in lines of at most that, each typed once the shell has taken the one before, which sh and bash assemble and run once whole, and never with a line missing or cut', () => {
  const { execFileSync } = require('node:child_process');
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  // Non-ASCII text, whose five-character escapes the cuts land inside, a
  // heredoc, a long comment and a status.
  const text = 'x' + '\u00e9'.repeat(600) + ' \u00fc';
  const file = pendingFile(session, 'n2', `cat <<'TSM_END'\n${text}\nTSM_END\n# ${'z'.repeat(1500)}\n(exit 7)\n`);
  try {
    scan(server, session, '<<<NOFILE:n2>>>\r\n');
    assert.equal(written.length, 1, 'the first line is typed');
    // Each next line is typed when the shell prints the piece marker of the
    // one before, once: the marker printed again, or out of turn, types nothing.
    for (let index = 0; !written.at(-1).includes('eval "unset'); index++) {
      scan(server, session, `<<<PIECE:n2:${index + 3}>>>\r\n<<<PIECE:n2:${index}>>>\r\n`);
      assert.equal(written.length, index + 2, `line ${index + 1} typed on the marker of line ${index}`);
      scan(server, session, `<<<PIECE:n2:${index}>>>\r\n`);
      assert.equal(written.length, index + 2, 'and only once');
    }
    assert.ok(!session.inlinePieces.has('n2'), 'nothing left to type');
    const lines = written.map((line) => line.replace(/\n$/, ''));
    assert.ok(lines.length >= 8 && lines.length <= 10, `${lines.length} lines`);
    for (const line of lines) assert.ok(Buffer.byteLength(line) <= 1000 && /^[ -~]*$/.test(line), 'a line of at most 1,000 bytes of printable ASCII');
    for (const line of lines.slice(0, -1)) assert.ok(Buffer.byteLength(line) > 950, 'full, but for the last');
    // The first line sets the body variable, in a shell where the pid variable
    // holds its own pid, and prints its piece marker. The others add to it,
    // where it also holds as many characters as the lines before typed; the
    // last then runs it.
    assert.match(lines[0], /^if \[ "\$\{__tsm_n2-\}" = "\$\$" \]; then __tsm_n2_b='[ -&(-~]*'; echo "<<<PIEC""E:n2:0>>>"; else echo "<<<GON""E:n2>>>"; fi$/);
    const adding = /^if \[ "\$\{__tsm_n2-\}" = "\$\$" \] && \[ "\$\{__tsm_n2_b\+set\}" = set \] && \[ "\$\{#__tsm_n2_b\}" = "(\d+)" \]; then __tsm_n2_b="\$__tsm_n2_b"'([ -&(-~]*)'/;
    let typed = lines[0].match(/'([^']*)'/)[1].length;
    for (const line of lines.slice(1)) {
      const [, before, piece] = line.match(adding);
      assert.equal(Number(before), typed, 'each line checks the length of what was typed before it');
      typed += piece.length;
    }
    lines.slice(1, -1).forEach((line, i) => assert.match(line, new RegExp(`'; echo "<<<PIEC""E:n2:${i + 1}>>>"; else echo "<<<GON""E:n2>>>"; fi$`)));
    assert.match(lines.at(-1), /'; echo "<<<STAR""T:n2>>>"; eval "unset __tsm_n2 __tsm_n2_b; \$\(printf '%b' "\$__tsm_n2_b"\)"; echo "<<<EXI""T:n2:\$\?>>>"; else echo "<<<GON""E:n2>>>"; fi$/);
    const left = 'echo "left:${__tsm_n2-unset}:${__tsm_n2_b-unset}"\n';
    const asked = '__tsm_n2=$$\n';
    const pieces = (count) => Array.from({ length: count }, (_, i) => `<<<PIECE:n2:${i}>>>\n`).join('');
    for (const shell of ['sh', 'bash']) {
      // The shell's output and its exit status (the script's last command's).
      const run = (script) => {
        try { return { out: execFileSync(shell, ['-c', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }), status: 0 }; } catch (err) { return { out: err.stdout, status: err.status }; }
      };
      const gone = (count) => '<<<GONE:n2>>>\n'.repeat(count);
      assert.deepEqual(run(asked + written.join('') + left), { out: `${pieces(lines.length - 1)}<<<START:n2>>>\n${text}\n<<<EXIT:n2:7>>>\nleft:unset:unset\n`, status: 0 }, shell);
      // Without the pid, every line prints the gone marker, and nothing runs.
      assert.deepEqual(run(written.join('') + left), { out: gone(lines.length) + 'left:unset:unset\n', status: 0 }, `${shell}: no pid`);
      // A line that didn't reach the shell: the lines after it print the gone
      // marker, and the body never runs. Under `set -u` too, where reading the
      // length of the unset body variable would otherwise abort the line.
      assert.deepEqual(run(asked + [lines[0], ...lines.slice(2)].join('\n') + '\n'), { out: pieces(1) + gone(lines.length - 2), status: 0 }, `${shell}: a line missing`);
      assert.deepEqual(run('set -u\n' + asked + lines.slice(1).join('\n') + '\n'), { out: gone(lines.length - 1), status: 0 }, `${shell}: the first line missing, under set -u`);
      // A middle line that reached the shell short of some of its text, still
      // well-formed: it adds what it has and prints its piece marker, and
      // every line after it finds the body too short and prints the gone
      // marker. The body never runs. This is the check the length is for.
      const shortened = lines[1].replace(/'([ -&(-~]{100})/, "'");
      assert.deepEqual(run(asked + [lines[0], shortened, ...lines.slice(2)].join('\n') + '\n'), { out: pieces(2) + gone(lines.length - 2), status: 0 }, `${shell}: a middle line short of 100 characters`);
      // A line cut short, as a tty over its limit would: the open quote takes
      // in what follows, and the body never runs, whichever line is cut.
      for (const at of [0, 1, lines.length - 1]) {
        const cut = run(asked + lines.map((line, i) => (i === at ? line.slice(0, 400) : line)).join('\n') + '\n').out;
        assert.ok(!cut.includes('<<<START:n2>>>') && !cut.includes(text), `${shell}: line ${at} cut: ${JSON.stringify(cut.slice(0, 200))}`);
      }
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a gone marker while a body's lines are still to be typed drops them: a piece marker after it types nothing", () => {
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const file = pendingFile(session, 'n3', `# ${'z'.repeat(2500)}\n`);
  session.unfinished.set('n3', false);
  try {
    scan(server, session, '<<<NOFILE:n3>>>\r\n');
    assert.equal(written.length, 1);
    assert.ok(session.inlinePieces.get('n3').lines.length >= 3 && session.inlinePieces.get('n3').next === 1);
    scan(server, session, '<<<GONE:n3>>>\r\n');
    assert.ok(!session.inlinePieces.has('n3') && !session.unfinished.has('n3') && !fs.existsSync(file));
    assert.match(session.logs.at(-1), /a line of its body reached a shell other than the one that asked for it, or didn't reach it whole/);
    scan(server, session, '<<<PIECE:n3:0>>>\r\n');
    assert.equal(written.length, 1, 'nothing more is typed');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("bodies for the shell in front go in one at a time, in the order their no-file markers came: the next body's first line is typed on the start marker of the one before, or when that one is given up", () => {
  const { execFileSync } = require('node:child_process');
  const server = bareServer();
  const written = [];
  // The shell reads the typed lines in the order they reached its terminal.
  // For every line typed, how many lines typed before it the shell hadn't read
  // yet when it was typed: the line editor needs that to be none, for a
  // body's first line (typed on a start or gone marker) as for its others
  // (see INLINE_LINE_MAX).
  const unreadAtWrite = [];
  let read = 0;
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => { unreadAtWrite.push(written.length - read); written.push(text); } }, currentCommand: undefined };
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  // The shell reads every typed line it hasn't yet, printing each piece
  // marker as it goes; a body's last line prints its start marker, which the
  // test scans itself.
  const shellReads = () => {
    while (read < written.length) {
      const piece = written[read++].match(/echo "<<<PIEC""E:([0-9a-z]+):(\d+)>>>"/);
      if (piece) scan(server, session, `<<<PIECE:${piece[1]}:${piece[2]}>>>\r\n`);
    }
  };
  try {
    // Three commands typed in behind a timed-out one: the shell reads their
    // probe lines together, so their no-file markers come back to back. The
    // first body takes three lines, the second one, the third two.
    pending('na', `echo first # ${'z'.repeat(2500)}\n`);
    pending('nb', 'echo second\n');
    pending('nc', `echo third # ${'z'.repeat(1200)}\n`);
    scan(server, session, '<<<NOFILE:na>>>\r\n<<<NOFILE:nb>>>\r\n<<<NOFILE:nc>>>\r\n');
    assert.equal(written.length, 1, "only the first body's first line is typed");
    assert.deepEqual(session.inlineQueue, ['na', 'nb', 'nc']);
    shellReads();
    assert.ok(written.length >= 3 && written.every((line) => line.includes('__tsm_na')), 'the first body goes in whole before anything of the others');
    assert.match(written.at(-1), /eval "unset __tsm_na __tsm_na_b;/);
    const first = written.length;
    // Its markers printed again type nothing more.
    scan(server, session, '<<<NOFILE:nb>>>\r\n<<<PIECE:na:0>>>\r\n');
    assert.equal(written.length, first);
    // Its start marker: the shell has read its last line, and the second
    // body's only line follows.
    scan(server, session, '<<<START:na>>>\r\n');
    assert.equal(written.length, first + 1);
    assert.match(written.at(-1), /^if \[ "\$\{__tsm_nb-\}" = "\$\$" \]; then __tsm_nb_b='echo second\\n'; echo "<<<STAR""T:nb>>>"/);
    assert.deepEqual(session.inlineQueue, ['nb', 'nc']);
    // A command given up (here, the shell read its line and printed the gone
    // marker: it reached another shell) gives the next its turn at once.
    session.unfinished.set('nb', false);
    shellReads();
    scan(server, session, '<<<GONE:nb>>>\r\n');
    assert.equal(written.length, first + 2);
    assert.match(written.at(-1), /^if \[ "\$\{__tsm_nc-\}" = "\$\$" \]; then __tsm_nc_b='/);
    assert.deepEqual(session.inlineQueue, ['nc']);
    shellReads();
    assert.match(written.at(-1), /eval "unset __tsm_nc __tsm_nc_b;/);
    scan(server, session, '<<<START:nc>>>\r\n');
    assert.deepEqual(session.inlineQueue, []);
    assert.equal(unreadAtWrite.length, written.length, 'every typed line was measured');
    assert.deepEqual(unreadAtWrite, written.map(() => 0), 'every line, the first of each body included, was typed with nothing unread ahead of it');
    // The shell runs the lines as they reached its terminal: in the order the
    // commands were written.
    const out = execFileSync('sh', ['-c', '__tsm_na=$$\n__tsm_nb=$$\n__tsm_nc=$$\n' + written.join('')], { encoding: 'utf8' });
    assert.deepEqual(out.split('\n').filter((line) => /^(first|second|third)$/.test(line)), ['first', 'second', 'third']);
    // A body refused at its turn gives the next its turn too, and a no-file
    // marker for a command whose file is already released is passed over.
    pending('nd', 'a'.repeat(130000));
    pending('ne', 'echo fifth\n');
    session.issued.set('nf', path.join(os.tmpdir(), `tsm-test-${process.pid}-nf.sh`));
    const typed = written.length;
    scan(server, session, '<<<NOFILE:nf>>>\r\n<<<NOFILE:nd>>>\r\n<<<NOFILE:ne>>>\r\n');
    assert.equal(written.length, typed + 1);
    assert.match(written.at(-1), /__tsm_ne_b='echo fifth\\n'/);
    assert.deepEqual(session.inlineQueue, ['ne']);
    // Its exit marker releases its turn too, should the start have been lost.
    scan(server, session, '<<<EXIT:ne:0>>>\r\n');
    assert.deepEqual(session.inlineQueue, []);
    // A body whose typed line never prints its marker, because something
    // reading the terminal took it, holds the bodies behind it only until the
    // shell prints a marker for a line typed after that one: the shell reads
    // in order, so that line couldn't have been read first. Here ng, nh and
    // ni were written in behind a busy shell, so their probe lines were in
    // the terminal before ng's line: their markers prove nothing about it.
    pending('ng', 'echo sixth\n');
    pending('nh', `echo seventh # ${'z'.repeat(1200)}\n`);
    pending('ni', 'echo eighth\n');
    session.unfinished.set('ng', false);
    session.unfinished.set('nh', false);
    scan(server, session, '<<<NOFILE:ng>>>\r\n');
    let before = written.length;
    let logged = session.logs.length;
    scan(server, session, '<<<NOFILE:nh>>>\r\n<<<NOFILE:ni>>>\r\n');
    assert.deepEqual([session.inlineQueue, written.length, session.logs.length], [['ng', 'nh', 'ni'], before, logged], 'ng keeps its turn: those probes were typed before its line');
    // nj's probe was typed after ng's line (its command timed out meanwhile);
    // its marker shows the shell read on past where ng's line would have
    // been. ng is given up, and nh's turn comes.
    pending('nj', 'echo ninth\n');
    scan(server, session, '<<<NOFILE:nj>>>\r\n');
    assert.match(session.logs.at(-1), /^\[command given up: the shell in front printed a marker for a line typed after a line of its body, but none for that line, so its markers won't come\]$/);
    assert.ok(!session.pendingFiles.has('ng') && !session.unfinished.has('ng') && !session.typedInline.has('ng'), 'ng given up');
    assert.deepEqual(session.inlineQueue, ['nh', 'ni', 'nj']);
    assert.equal(written.length, before + 1);
    assert.match(written.at(-1), /__tsm_nh_b='/);
    scan(server, session, '<<<PIECE:nh:0>>>\r\n');
    assert.match(written.at(-1), /__tsm_nh_b="\$__tsm_nh_b"'/);
    // The same for a body cut off mid-way: its lines still to type go with it.
    pending('nk', 'echo tenth\n');
    before = written.length;
    scan(server, session, '<<<NOFILE:nk>>>\r\n');
    assert.ok(!session.inlinePieces.has('nh') && !session.pendingFiles.has('nh'), 'nh given up with its lines');
    assert.deepEqual(session.inlineQueue, ['ni', 'nj', 'nk']);
    assert.equal(written.length, before + 1);
    assert.match(written.at(-1), /__tsm_ni_b='echo eighth/);
    // Late markers of a body given up change nothing.
    before = written.length;
    logged = session.logs.length;
    scan(server, session, '<<<GONE:ng>>>\r\n<<<PIECE:nh:1>>>\r\n<<<NOFILE:nh>>>\r\n<<<START:ng>>>\r\n');
    assert.equal(written.length, before);
    assert.equal(session.logs.length, logged);
    assert.deepEqual(session.inlineQueue, ['ni', 'nj', 'nk']);
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test("a later command's start marker gives up the bodies still queued, typing no line for them and forgetting their lines, before anything starts a body", () => {
  // The shell in front (ssh's remote one) asked for e1 and e2; e1's first
  // line went; e2 waits its turn. Then that shell goes, and the session's own
  // shell reads x's probe line, can read x's file, and prints x's start
  // marker: it read on past every earlier line. e1 and e2 are given up with
  // their lines, and nothing is typed for them: a line typed for e2 here would
  // reach the shell that printed x's start marker, for nothing.
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  try {
    pending('e1', `echo one # ${'z'.repeat(1500)}\n`);
    pending('e2', 'echo two\n');
    pending('x', 'echo three\n');
    for (const n of ['e1', 'e2', 'x']) session.unfinished.set(n, false);
    scan(server, session, '<<<NOFILE:e1>>>\r\n<<<NOFILE:e2>>>\r\n');
    assert.equal(written.length, 1);
    const logged = session.logs.length;
    scan(server, session, '<<<START:x>>>\r\n');
    assert.equal(written.length, 1, 'no line typed for a body given up');
    assert.deepEqual(session.inlineQueue, []);
    for (const n of ['e1', 'e2']) {
      assert.ok(!session.inlinePieces.has(n) && !session.typedInline.has(n) && !session.unfinished.has(n) && !session.pendingFiles.has(n), `${n} forgotten whole`);
    }
    assert.equal(session.logs.length, logged + 2);
    for (const line of session.logs.slice(-2)) assert.match(line, /^\[command given up: the shell read on to a later command's line before this one's start marker came\]$/);
    assert.ok(session.pendingFiles.has('x') && session.unfinished.get('x') === true);
    // The same when x's probe was typed after the head's line, so the stuck
    // check would fire too: the start marker's releases come first, and no
    // body is started for the loop to give up (e2 and e3 each in pieces).
    pending('e2b', `echo two # ${'z'.repeat(1500)}\n`);
    pending('e3b', `echo three # ${'z'.repeat(1500)}\n`);
    pending('e1b', 'echo one\n');
    scan(server, session, '<<<NOFILE:e1b>>>\r\n<<<NOFILE:e2b>>>\r\n<<<NOFILE:e3b>>>\r\n');
    assert.equal(written.length, 2, "e1b's only line is typed");
    pending('xb', 'echo four\n'); // typed after e1b's line
    scan(server, session, '<<<START:xb>>>\r\n');
    assert.equal(written.length, 2, 'nothing typed for e2b or e3b');
    assert.deepEqual(session.inlineQueue, []);
    for (const n of ['e1b', 'e2b', 'e3b']) assert.ok(!session.inlinePieces.has(n) && !session.typedInline.has(n), `${n} forgotten`);
    // Late markers for them change nothing.
    scan(server, session, '<<<PIECE:e2b:0>>>\r\n<<<START:e1b>>>\r\n<<<GONE:e3b>>>\r\n');
    assert.equal(written.length, 2);
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test("a body whose file was released before its turn, and that nothing gave up, is passed over when its turn comes", () => {
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  try {
    pending('na', 'echo one\n');
    pending('nb', 'echo two\n');
    pending('nc', 'echo three\n');
    scan(server, session, '<<<NOFILE:na>>>\r\n<<<NOFILE:nb>>>\r\n<<<NOFILE:nc>>>\r\n');
    assert.deepEqual(session.inlineQueue, ['na', 'nb', 'nc']);
    session.pendingFiles.delete('nb'); // released by some other path, its lines kept
    scan(server, session, '<<<START:na>>>\r\n');
    assert.equal(written.length, 2, "na's line, then nc's: nb passed over");
    assert.match(written[1], /__tsm_nc_b=/);
    assert.deepEqual(session.inlineQueue, ['nc']);
    assert.ok(!session.inlinePieces.has('nb'));
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test("a waiting command given up is answered after the next body's first line is typed, so the next command's probe line lands behind that line", async () => {
  const server = bareServer();
  const written = [];
  const results = [];
  const session = {
    ...bareSession(), id: 's', outputBuffer: '', isProcessingCommand: true, isAlive: true, commandQueue: [],
    shell: { write: (text) => written.push(text) },
    currentCommand: undefined,
  };
  server.notify = () => {};
  server.emit = () => true;
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  try {
    pending('nh', `echo head # ${'z'.repeat(1500)}\n`);
    pending('nk', 'echo next\n');
    session.currentCommand = { command: 'echo head', nonce: 'nh', startTime: Date.now(), resolve: (result) => results.push(result) };
    session.unfinished.set('nh', false);
    session.unfinished.set('nk', false);
    // A command written behind nh, still queued in the server (nh is current).
    session.commandQueue.push({ command: 'echo later', nonce: 'nq1', resolve: () => {}, startTime: Date.now(), timeout: 1000 });
    scan(server, session, '<<<NOFILE:nh>>>\r\n<<<NOFILE:nk>>>\r\n');
    assert.equal(written.length, 1);
    // nh's line reached another shell: nh is given up, nk's line goes, and
    // only then is nh answered. The queued command's probe line is held while
    // nk goes in, and typed once nk's start marker shows the shell read nk's
    // line: nothing reaches the line editor while it handles a long line.
    scan(server, session, '<<<GONE:nh>>>\r\n');
    assert.deepEqual(results.map((r) => r.exitCode), [-1]);
    assert.match(results[0].output, /^\[command not run: a line of its body reached a shell other than/);
    assert.equal(written.length, 2);
    assert.match(written[1], /__tsm_nk_b='echo next\\n'/, "nk's first line, nothing behind it yet");
    assert.ok(session.currentCommand.probe !== undefined, 'the probe line is held');
    scan(server, session, '<<<START:nk>>>\r\n');
    assert.equal(written.length, 3);
    assert.match(written[2], /^if \[ -r '/, "the probe line, typed on nk's start marker");
    assert.equal(session.currentCommand.probe, undefined);
    // A probe held while a body goes in pieces, and the body's line taken: the
    // hold ends at the waiting command's own timeout, so the body can be found
    // stuck. nm's first line goes; the next command, timing out in 60 ms, has
    // its probe held, then typed, then is answered -1.
    clearTimeout(session.currentTimeout);
    session.currentCommand = undefined;
    session.isProcessingCommand = false;
    pending('nm', `echo more # ${'z'.repeat(1500)}\n`);
    scan(server, session, '<<<NOFILE:nm>>>\r\n');
    assert.equal(written.length, 4);
    const late = [];
    session.commandQueue.push({ command: 'echo late', nonce: 'nq2', resolve: (r) => late.push(r), startTime: Date.now(), timeout: 60 });
    server.processCommandQueue(session);
    assert.equal(written.length, 4, 'held while nm goes in');
    assert.ok(session.currentCommand.probe !== undefined);
    // Wait for the late command's answer, which its timeout brings.
    const deadline = Date.now() + 5000;
    while (late.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(written.length, 5, 'typed at the timeout');
    assert.match(written[4], /^if \[ -r '/);
    assert.deepEqual(late.map((r) => r.exitCode), [-1]);
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    if (session.currentTimeout) clearTimeout(session.currentTimeout);
  }
});

/** A bare session for the held probe's timer tests, writing into `written`. */
function holdSession(written) {
  return {
    ...bareSession(), id: 's', outputBuffer: '', isProcessingCommand: false, isAlive: true, commandQueue: [],
    shell: { write: (text) => written.push(text) },
    currentCommand: undefined,
  };
}

test('a held probe line is typed once the body going in has had no line typed for two seconds, and each line typed for it restarts the wait', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = bareServer();
  server.notify = () => {};
  server.emit = () => true;
  const written = [];
  const session = holdSession(written);
  try {
    pendingFile(session, 'na', `echo a # ${'z'.repeat(2500)}\n`);
    scan(server, session, '<<<NOFILE:na>>>\r\n');
    assert.equal(written.length, 1, "na's first line");
    session.commandQueue.push({ command: 'echo next', nonce: 'nq', resolve: () => {}, startTime: Date.now(), timeout: 60000 });
    server.processCommandQueue(session);
    assert.ok(session.currentCommand.probe !== undefined, 'the probe line is held while na goes in');
    t.mock.timers.tick(1999);
    assert.equal(written.length, 1, 'still held 1,999 ms after the hold began');
    scan(server, session, '<<<PIECE:na:0>>>\r\n');
    assert.equal(written.length, 2, "na's second line");
    t.mock.timers.tick(1999);
    assert.equal(written.length, 2, "still held 1,999 ms after na's second line");
    t.mock.timers.tick(1);
    assert.equal(written.length, 3, "typed 2,000 ms after na's second line");
    assert.match(written[2], /^if \[ -r '/);
    assert.equal(session.currentCommand.probe, undefined);
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test("a body's first line, typed at its turn, restarts the held probe's wait as its other lines do", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = bareServer();
  server.notify = () => {};
  server.emit = () => true;
  const written = [];
  const session = holdSession(written);
  try {
    pendingFile(session, 'na', `echo a # ${'z'.repeat(1500)}\n`);
    pendingFile(session, 'nb', `echo b # ${'z'.repeat(1500)}\n`);
    scan(server, session, '<<<NOFILE:na>>>\r\n<<<NOFILE:nb>>>\r\n');
    assert.equal(written.length, 1, "na's first line; nb waits its turn");
    session.commandQueue.push({ command: 'echo next', nonce: 'nq', resolve: () => {}, startTime: Date.now(), timeout: 60000 });
    server.processCommandQueue(session);
    assert.ok(session.currentCommand.probe !== undefined, 'the probe line is held while na goes in');
    t.mock.timers.tick(1000);
    scan(server, session, '<<<PIECE:na:0>>>\r\n');
    assert.equal(written.length, 2, "na's last line, at 1,000 ms");
    assert.ok(!session.inlinePieces.has('na'), 'na has no lines left to type');
    t.mock.timers.tick(1500);
    scan(server, session, '<<<START:na>>>\r\n');
    assert.equal(written.length, 3, "nb's first line, at 2,500 ms");
    assert.match(written[2], /__tsm_nb_b=/);
    t.mock.timers.tick(1999);
    assert.equal(written.length, 3, "still held 1,999 ms after nb's first line");
    t.mock.timers.tick(1);
    assert.equal(written.length, 4, "typed 2,000 ms after nb's first line");
    assert.match(written[3], /^if \[ -r '/);
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

/** A bare server and session for sendInput's refusal: the session is 's'. */
function inputServer(written) {
  const server = bareServer();
  server.notify = () => {};
  server.emit = () => true;
  const session = holdSession(written);
  session.typingProgressAt = 0;
  server.sessions = new Map([['s', session]]);
  return { server, session };
}
const refusal = /^Error: Input not sent: a command is still on its way into session s, and until it has started, input can reach the shell in front instead of the command\. Send it again in a moment: the refusal ends when the command starts, ends or is given up, or after two seconds in which the server has typed no line and read no marker\. To interrupt it, use sendSignal with SIGINT, its default, which isn't refused\.$/;
const queue = (session, nonce, command, resolve = () => {}) =>
  session.commandQueue.push({ command, nonce, resolve, startTime: Date.now(), timeout: 60000 });

test("sendInput refuses input, sending nothing, from the moment the last command's probe line is typed or held until that command starts", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const { server, session } = inputServer(written);
  try {
    server.sendInput('s', 'idle');
    assert.deepEqual(written, ['idle\r'], 'nothing written for a command yet: sent');
    queue(session, 'n1', 'echo one');
    server.processCommandQueue(session);
    assert.equal(written.length, 2, "n1's probe line");
    assert.throws(() => server.sendInput('s', 'early'), refusal);
    assert.equal(written.length, 2, 'nothing was sent');
    scan(server, session, '<<<START:n1>>>\r\n');
    server.sendInput('s', 'answer');
    assert.equal(written[2], 'answer\r', 'sent once n1 started');
    // An exit marker ends the refusal too, as when a trimmed buffer lost the start marker.
    clearTimeout(session.currentTimeout);
    session.currentCommand = undefined;
    session.isProcessingCommand = false;
    queue(session, 'n2', 'echo two');
    server.processCommandQueue(session);
    assert.throws(() => server.sendInput('s', 'early'), refusal);
    scan(server, session, '<<<EXIT:n2:0>>>\r\n');
    server.sendInput('s', 'after exit');
    assert.equal(written.at(-1), 'after exit\r');
    // A probe line held while a body goes in: refused from the hold, still
    // refused once the body starts and the held line is typed, and sent once
    // the held command starts.
    pendingFile(session, 'nb', `echo b # ${'z'.repeat(1500)}\n`);
    scan(server, session, '<<<NOFILE:nb>>>\r\n');
    queue(session, 'n3', 'echo three');
    server.processCommandQueue(session);
    assert.ok(session.currentCommand.probe !== undefined, "n3's probe line is held while nb goes in");
    assert.throws(() => server.sendInput('s', 'early'), refusal);
    scan(server, session, '<<<PIECE:nb:0>>>\r\n');
    scan(server, session, '<<<START:nb>>>\r\n');
    assert.match(written.at(-1), /^if \[ -r '/, "n3's probe line, typed on nb's start marker");
    assert.throws(() => server.sendInput('s', 'early'), refusal, 'nb started, but n3, the last command, has not');
    scan(server, session, '<<<START:n3>>>\r\n');
    server.sendInput('s', 'answer');
    assert.equal(written.at(-1), 'answer\r');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test("the refusal lapses two seconds after the server last typed a line or read a marker, and input sent then doesn't restart it", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const { server, session } = inputServer(written);
  try {
    t.mock.timers.tick(10000); // the session sat idle: only what comes after counts
    // A long body, so that its no-file marker types a line.
    queue(session, 'n1', `echo one # ${'z'.repeat(1500)}`);
    server.processCommandQueue(session);
    assert.equal(written.length, 1, "n1's probe line, which nothing answers");
    t.mock.timers.tick(1999);
    assert.throws(() => server.sendInput('s', 'early'), refusal, '1,999 ms after the probe line');
    t.mock.timers.tick(1);
    server.sendInput('s', 'to whatever took it');
    server.sendInput('s', 'and again');
    assert.deepEqual(written.slice(1), ['to whatever took it\r', 'and again\r'], "sent from 2,000 ms on, and sendInput's own writes don't restart the wait");
    scan(server, session, '<<<NOFILE:n1>>>\r\n');
    assert.match(written.at(-1), /__tsm_n1_b=/, "n1's first body line");
    assert.throws(() => server.sendInput('s', 'early'), refusal, 'the marker and the line typed for it restart the wait');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('a marker restarts the wait even when it types nothing, as when an earlier command ends and the shell goes on to the last one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n1', 'sleep 5');
    server.processCommandQueue(session);
    scan(server, session, '<<<START:n1>>>\r\n');
    t.mock.timers.tick(60000); // n1 times out, still running: n2's probe line waits in the tty behind it
    queue(session, 'n2', 'echo two');
    server.processCommandQueue(session);
    assert.match(written.at(-1), /^if \[ -r '/, "n2's probe line");
    t.mock.timers.tick(2000);
    server.sendInput('s', 'to n1');
    assert.equal(written.at(-1), 'to n1\r', 'two seconds with nothing typed or read: sent');
    scan(server, session, '<<<EXIT:n1:0>>>\r\n');
    assert.throws(() => server.sendInput('s', 'early'), refusal, "n1's exit marker: the shell goes on to n2's line");
    scan(server, session, '<<<START:n2>>>\r\n');
    server.sendInput('s', 'to n2');
    assert.equal(written.at(-1), 'to n2\r');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('a command given up before it starts ends the refusal at once: a body whose line reached another shell, and one too long to type', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n1', `echo one # ${'z'.repeat(1500)}`, (r) => results.push(r));
    server.processCommandQueue(session);
    scan(server, session, '<<<NOFILE:n1>>>\r\n');
    assert.throws(() => server.sendInput('s', 'early'), refusal, "n1's body going in");
    scan(server, session, '<<<GONE:n1>>>\r\n');
    assert.match(results.at(-1).output, /^\[command not run: a line of its body reached a shell other than/);
    server.sendInput('s', 'after gone');
    assert.equal(written.at(-1), 'after gone\r', 'sent with no time passing');
    queue(session, 'n2', `echo ${'x'.repeat(130000)}`, (r) => results.push(r));
    server.processCommandQueue(session);
    assert.throws(() => server.sendInput('s', 'early'), refusal);
    scan(server, session, '<<<NOFILE:n2>>>\r\n');
    assert.match(results.at(-1).output, /^\[command not run: the shell in front can't read this machine's temp files, and typed in, this command would take more than 128 lines/);
    server.sendInput('s', 'after too long');
    assert.equal(written.at(-1), 'after too long\r');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('the last command given up while an earlier body still goes in leaves input refused until that body starts, or two seconds pass with nothing typed or read', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    t.mock.timers.tick(10000); // the session sat idle: only what comes after counts
    // na's body goes in a line at a time. n2, too long to type, comes next:
    // its probe line is held while na goes in, until its 50 ms timeout types it.
    pendingFile(session, 'na', `echo a # ${'z'.repeat(2500)}\n`);
    scan(server, session, '<<<NOFILE:na>>>\r\n');
    assert.match(written.at(-1), /__tsm_na_b=/, "na's first line");
    session.commandQueue.push({ command: `echo ${'x'.repeat(130000)}`, nonce: 'n2', resolve: (r) => results.push(r), startTime: Date.now(), timeout: 50 });
    server.processCommandQueue(session);
    assert.ok(session.currentCommand.probe !== undefined, "n2's probe line is held while na goes in");
    t.mock.timers.tick(50);
    assert.match(written.at(-1), /^if \[ -r '/, "n2's probe line, typed at its timeout");
    assert.deepEqual(results.map((r) => r.exitCode), [-1]);
    // The shell reads na's first line, then n2's line, then na's second.
    scan(server, session, '<<<PIECE:na:0>>>\r\n');
    assert.match(written.at(-1), /__tsm_na_b="\$__tsm_na_b"/, "na's second line");
    assert.ok(session.inlinePieces.has('na'), 'na has a line still to type');
    scan(server, session, '<<<NOFILE:n2>>>\r\n');
    assert.match(session.logs.at(-1), /^\[command not run: .* would take more than 128 lines/, 'n2 is given up as too long');
    assert.equal(session.typingFor, undefined, 'n2 holds the refusal no longer');
    const before = written.length;
    assert.throws(() => server.sendInput('s', 'early'), refusal, "na's body is still going in");
    assert.equal(written.length, before, 'nothing was sent');
    t.mock.timers.tick(1999);
    assert.throws(() => server.sendInput('s', 'early'), refusal, "1,999 ms after n2's marker");
    t.mock.timers.tick(1);
    server.sendInput('s', 'to whatever took it');
    assert.equal(written.at(-1), 'to whatever took it\r', 'two seconds with nothing typed or read: sent');
    for (let i = 1; session.inlinePieces.has('na'); i++) scan(server, session, `<<<PIECE:na:${i}>>>\r\n`);
    assert.match(written.at(-1), /__tsm_na_b="\$__tsm_na_b"/, "na's last line");
    assert.throws(() => server.sendInput('s', 'early'), refusal, "na's lines are all typed, and it hasn't started");
    scan(server, session, '<<<START:na>>>\r\n');
    server.sendInput('s', 'after');
    assert.equal(written.at(-1), 'after\r', 'sent once na started');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

const INTERRUPTED_BODY = '[command not run: interrupted before its body was all typed in]';

test("a SIGINT gives up the body going in with lines left and the bodies waiting their turn, before its ^C: no more of their lines are typed, the command is answered, and input and the next command go in at once", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n1', `echo one # ${'z'.repeat(1500)}`, (r) => results.push(r));
    server.processCommandQueue(session);
    pendingFile(session, 'nw', `echo waits # ${'z'.repeat(1500)}\n`);
    scan(server, session, '<<<NOFILE:n1>>>\r\n<<<NOFILE:nw>>>\r\n');
    assert.match(written.at(-1), /__tsm_n1_b=/, "n1's first line; nw waits its turn");
    const before = written.length;
    server.sendSignal('s', 'SIGINT');
    assert.equal(written.length, before + 1);
    assert.equal(written.at(-1), '\x03', 'the ^C, and nothing typed for the bodies before it');
    assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[-1, INTERRUPTED_BODY]]);
    assert.equal(session.logs.filter((l) => l === INTERRUPTED_BODY).length, 2, 'both bodies, each once');
    assert.deepEqual(session.inlineQueue, []);
    assert.equal(session.unfinished.has('n1') || session.unfinished.has('nw'), false);
    scan(server, session, '<<<PIECE:n1:0>>>\r\n');
    assert.equal(written.length, before + 1, "n1's piece marker types nothing more");
    server.sendInput('s', 'after');
    assert.equal(written.at(-1), 'after\r', 'input goes in at once');
    queue(session, 'n2', 'echo two');
    server.processCommandQueue(session);
    assert.match(written.at(-1), /^if \[ -r '/, "the next command's probe line goes in with no hold");
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('a SIGINT leaves a body whose lines are all typed, which may be running, to the ^C', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n1', 'echo one', (r) => results.push(r));
    server.processCommandQueue(session);
    scan(server, session, '<<<NOFILE:n1>>>\r\n');
    assert.match(written.at(-1), /__tsm_n1_b='echo one\\n'/, "n1's only line, typed");
    server.sendSignal('s', 'SIGINT');
    assert.equal(written.at(-1), '\x03');
    assert.deepEqual(results, [], 'not given up');
    assert.deepEqual(session.inlineQueue, ['n1']);
    scan(server, session, '<<<START:n1>>>\r\n<<<EXIT:n1:130>>>\r\n');
    assert.deepEqual(results.map((r) => r.exitCode), [130], 'it ends as the shell says');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('a SIGINT gives up a command whose probe line is held, and that line is never typed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    // nb's only line is typed, so the ^C leaves nb; n3's probe line is held behind it.
    pendingFile(session, 'nb', 'echo b\n');
    scan(server, session, '<<<NOFILE:nb>>>\r\n');
    queue(session, 'n3', 'echo three', (r) => results.push(r));
    server.processCommandQueue(session);
    assert.ok(session.currentCommand.probe !== undefined, "n3's probe line is held");
    server.sendSignal('s', 'SIGINT');
    assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[-1, '[command not run: interrupted before its line was typed]']]);
    scan(server, session, '<<<START:nb>>>\r\n');
    t.mock.timers.tick(5000);
    assert.ok(!written.some((w) => /^if \[ -r '/.test(w)), "n3's probe line was never typed");
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('a SIGINT marks a command whose probe line is typed and unanswered: its no-file marker then types no body and gives it up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n4', 'echo four', (r) => results.push(r));
    server.processCommandQueue(session);
    server.sendSignal('s', 'SIGINT');
    assert.deepEqual(results, [], 'not answered yet: the shell may read its file');
    assert.ok(session.interruptedProbes.has('n4'));
    const before = written.length;
    scan(server, session, '<<<NOFILE:n4>>>\r\n');
    assert.equal(written.length, before, 'no body line typed');
    assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[-1, INTERRUPTED_BODY]]);
    assert.ok(!session.interruptedProbes.has('n4'), 'the mark went with it');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test("a marked command's start marker takes the mark away and changes nothing else", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n5', 'echo five', (r) => results.push(r));
    server.processCommandQueue(session);
    server.sendSignal('s', 'SIGINT');
    assert.ok(session.interruptedProbes.has('n5'));
    scan(server, session, '<<<START:n5>>>\r\n');
    assert.ok(!session.interruptedProbes.has('n5'), 'the shell read its file');
    assert.equal(session.currentCommand.started, true);
    scan(server, session, '<<<EXIT:n5:0>>>\r\n');
    assert.deepEqual(results.map((r) => r.exitCode), [0], 'answered as it ended');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test("a marked command's exit marker takes the mark away when its start marker was lost", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n6', 'echo six', (r) => results.push(r));
    server.processCommandQueue(session);
    server.sendSignal('s', 'SIGINT');
    assert.ok(session.interruptedProbes.has('n6'));
    scan(server, session, '<<<EXIT:n6:130>>>\r\n');
    assert.ok(!session.interruptedProbes.has('n6'), 'it ran in a shell that read its file');
    assert.deepEqual(results.map((r) => r.exitCode), [130], 'answered as it ended');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test("a marked command whose line the ^C discarded never answers: its own timeout answers its caller, with no reason of the SIGINT's, and it stays marked while it's unfinished", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n7', 'echo seven', (r) => results.push(r));
    server.processCommandQueue(session);
    server.sendSignal('s', 'SIGINT');
    assert.ok(session.interruptedProbes.has('n7'));
    // No marker comes back: the ^C's flush discarded the probe line.
    t.mock.timers.tick(59999);
    assert.deepEqual(results, [], 'nothing answers it before its timeout');
    t.mock.timers.tick(1);
    assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[-1, '']], "its timeout's -1");
    assert.ok(!session.logs.some((l) => /interrupted/.test(l)), "no reason of the SIGINT's in the log");
    assert.ok(session.unfinished.has('n7') && session.interruptedProbes.has('n7'), 'still unfinished, still marked');
    // Its line read after all, as under stty noflsh, by a shell that can't read the file: the mark gives it up.
    const before = written.length;
    scan(server, session, '<<<NOFILE:n7>>>\r\n');
    assert.equal(written.length, before, 'no body line typed');
    assert.ok(session.logs.includes(INTERRUPTED_BODY));
    assert.ok(!session.unfinished.has('n7') && !session.interruptedProbes.has('n7'), 'the mark went with it');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test("a Ctrl-C sent with sendInput, as the C-c key or a ^C in its text, is refused while a body goes in, and once the refusal has lapsed it gives the body up as sendSignal's SIGINT does", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // The C-c key writes '\x03' alone, as the GUI's terminal does for a Ctrl+C
  // keystroke; text holding a ^C gets the default Enter after it.
  for (const [form, args, data] of [
    ['the C-c key', ['', false, ['C-c']], '\x03'],
    ['a ^C in its text', ['x\x03'], 'x\x03\r'],
  ]) {
    const written = [];
    const results = [];
    const { server, session } = inputServer(written);
    try {
      queue(session, 'n1', `echo one # ${'z'.repeat(1500)}`, (r) => results.push(r));
      server.processCommandQueue(session);
      scan(server, session, '<<<NOFILE:n1>>>\r\n');
      assert.match(written.at(-1), /__tsm_n1_b=/, `${form}: n1's first line`);
      assert.throws(() => server.sendInput('s', ...args), refusal, `${form}: refused while the body goes in`);
      t.mock.timers.tick(2000); // the body's lines stall: nothing typed or read for two seconds
      const before = written.length;
      server.sendInput('s', ...args);
      assert.equal(written.length, before + 1, form);
      assert.equal(written.at(-1), data, `${form}: the ^C, and nothing typed for the body before it`);
      assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[-1, INTERRUPTED_BODY]], form);
      assert.deepEqual(session.inlineQueue, [], form);
      scan(server, session, '<<<PIECE:n1:0>>>\r\n');
      assert.equal(written.length, before + 1, `${form}: n1's piece marker types nothing more`);
    } finally {
      for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
      clearTimeout(session.currentTimeout);
    }
  }
});

test("a command waiting in the server's queue goes in after the ^C that gives up the one before it, through sendSignal and through sendInput", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // Answering the given-up command types the next queued command's probe line
  // at once (resolveCommand runs processCommandQueue), so the ^C has to be
  // written first: a probe line written before it would be typeahead its
  // flush discards.
  for (const [how, send, lapse, data] of [
    ['sendSignal', (server) => server.sendSignal('s', 'SIGINT'), false, '\x03'],
    ['sendInput', (server) => server.sendInput('s', '', false, ['C-c']), true, '\x03'],
  ]) {
    const written = [];
    const results = [];
    const { server, session } = inputServer(written);
    try {
      queue(session, 'n1', `echo one # ${'z'.repeat(1500)}`, (r) => results.push(r));
      queue(session, 'n2', 'echo two');
      server.processCommandQueue(session);
      scan(server, session, '<<<NOFILE:n1>>>\r\n');
      assert.match(written.at(-1), /__tsm_n1_b=/, `${how}: n1's first line, with n2 waiting in the queue`);
      assert.equal(session.commandQueue.length, 1, `${how}: n2 waits`);
      if (lapse) t.mock.timers.tick(2000);
      const before = written.length;
      send(server);
      assert.deepEqual(results.map((r) => [r.exitCode, r.output]), [[-1, INTERRUPTED_BODY]], how);
      assert.equal(written.length, before + 2, `${how}: the ^C, then n2's probe line`);
      assert.equal(written[before], data, `${how}: the ^C first`);
      assert.match(written[before + 1], /^if \[ -r '/, `${how}: n2's probe line after it`);
    } finally {
      for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
      clearTimeout(session.currentTimeout);
    }
  }
});

test('a C-c sent with sendInput to a command that has started is written to it, and the command is answered by its exit marker, as it would be without the server', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const written = [];
  const results = [];
  const { server, session } = inputServer(written);
  try {
    queue(session, 'n1', 'sleep 100', (r) => results.push(r));
    server.processCommandQueue(session);
    scan(server, session, '<<<START:n1>>>\r\n');
    const before = written.length;
    server.sendInput('s', '', false, ['C-c']);
    assert.deepEqual(written.slice(before), ['\x03'], 'the ^C goes in, and nothing else');
    assert.deepEqual(results, [], 'not answered: it is running, and the ^C is its to meet');
    scan(server, session, '<<<EXIT:n1:130>>>\r\n');
    assert.deepEqual(results.map((r) => r.exitCode), [130], 'it ends as the shell says');
  } finally {
    for (const file of session.pendingFiles.values()) fs.rmSync(file, { force: true });
    clearTimeout(session.currentTimeout);
  }
});

test('the 128-line cap at its edge: a body that takes exactly 128 lines is typed, each at most 1,000 bytes with a three-digit index and a six-digit length, and sh runs it; one character more is refused', () => {
  const { execFileSync } = require('node:child_process');
  const server = bareServer();
  const files = [];
  // A body of k ASCII characters that printf's escaping leaves as it is, and
  // that prints its own length when run.
  const body = (k) => `x=${'a'.repeat(k)}; echo "\${#x}"`;
  // How many lines a body of k characters takes, through the marker path; null
  // when it is refused.
  const linesFor = (k) => {
    const session = { ...bareSession(), outputBuffer: '', shell: { write: () => {} }, currentCommand: undefined };
    files.push(pendingFile(session, 'ne', body(k)));
    scan(server, session, '<<<NOFILE:ne>>>\r\n');
    const pieces = session.inlinePieces.get('ne');
    return session.typedInline.has('ne') ? (pieces ? pieces.lines.length : 1) : null;
  };
  try {
    // The largest body that takes 128 lines, by bisection.
    let lo = 100000, hi = 130000; // 128 lines hold about 104,000 characters
    assert.ok(linesFor(lo) !== null && linesFor(lo) <= 128 && linesFor(hi) === null);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (linesFor(mid) === null) hi = mid; else lo = mid;
    }
    assert.equal(linesFor(lo), 128, `the largest typed body takes 128 lines (${lo} characters)`);
    assert.equal(linesFor(hi), null, `one character more (${hi}) is refused`);
    // Type the 128-line body, one line per piece marker.
    const written = [];
    const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
    files.push(pendingFile(session, 'nf', body(lo)));
    scan(server, session, '<<<NOFILE:nf>>>\r\n');
    for (let index = 0; written.length < 128; index++) scan(server, session, `<<<PIECE:nf:${index}>>>\r\n`);
    assert.ok(!session.inlinePieces.has('nf'));
    const lines = written.map((line) => line.replace(/\n$/, ''));
    assert.equal(lines.length, 128);
    for (const line of lines) assert.ok(Buffer.byteLength(line) <= 1000, `a line of ${Buffer.byteLength(line)} bytes`);
    assert.match(lines[127], /^if \[ "\$\{__tsm_nf-\}" = "\$\$" \] && \[ "\$\{__tsm_nf_b\+set\}" = set \] && \[ "\$\{#__tsm_nf_b\}" = "(\d{6})" \]; then __tsm_nf_b="\$__tsm_nf_b"'[a-z=;" $#{}x]*'; echo "<<<STAR""T:nf>>>"; eval /);
    assert.match(lines[126], /'; echo "<<<PIEC""E:nf:126>>>"; else echo "<<<GON""E:nf>>>"; fi$/);
    assert.ok(lines.slice(1).every((line) => Buffer.byteLength(line) > 990), 'every line but the first is full to within ten bytes');
    // sh assembles and runs it: 127 piece markers, the start marker, the
    // body's own length, the exit marker.
    const pieces = Array.from({ length: 127 }, (_, i) => `<<<PIECE:nf:${i}>>>\n`).join('');
    const out = execFileSync('sh', ['-c', '__tsm_nf=$$\n' + written.join('')], { encoding: 'utf8', maxBuffer: 1 << 20 });
    assert.equal(out, `${pieces}<<<START:nf>>>\n${lo}\n<<<EXIT:nf:0>>>\n`);
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test('a body that would take more than 128 lines, whose file alone would, or whose file is gone, is not typed: its file goes, and the log says why once', () => {
  const server = bareServer();
  const written = [];
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  try {
    // The line's length past the body itself, for a nonce of this length.
    const overhead = server.inlinePiece('nb', '', 'only', 0, 0).length;
    pending('na', 'a'.repeat(1000 - overhead));
    pending('nb', 'a'.repeat(1001 - overhead));
    scan(server, session, '<<<NOFILE:na>>>\r\n<<<NOFILE:nb>>>\r\n');
    assert.equal(written.length, 1, "the second body waits for the first's start marker");
    assert.equal(written[0].length, 1001, 'a body that fits a line of exactly 1,000 bytes is typed as one, with its newline');
    assert.ok(!session.inlinePieces.has('na'));
    scan(server, session, '<<<START:na>>>\r\n');
    assert.equal(written.length, 2);
    assert.deepEqual([session.inlinePieces.get('nb').lines.length, session.inlinePieces.get('nb').next], [2, 1], 'one byte more takes two lines, the second still to type');
    // nb's second line goes in and the shell reads it: the next body's turn.
    scan(server, session, '<<<PIECE:nb:0>>>\r\n<<<START:nb>>>\r\n');
    assert.equal(written.length, 3);
    // Within the lines' total as bytes, over it escaped: each non-ASCII byte
    // takes five characters.
    session.unfinished.set('nc', false);
    pending('nc', 'echo ' + '\u00e9'.repeat(12000));
    scan(server, session, '<<<NOFILE:nc>>>\r\n');
    assert.equal(written.length, 3);
    assert.match(session.logs.at(-1), /would take more than 128 lines of 1000 bytes \(its body is 24005 bytes, 120005 escaped for printf\); send it as smaller commands/);
    assert.ok(!fs.existsSync(files.at(-1)) && !session.pendingFiles.has('nc') && !session.unfinished.has('nc'));
    // A newline takes two characters: as many as fit one line with `true`.
    pending('nd', 'true' + '\n'.repeat(Math.floor((1000 - overhead - 4) / 2)));
    scan(server, session, '<<<NOFILE:nd>>>\r\n');
    assert.equal(written.length, 4, 'a body of newlines that fits at two characters each is typed');
    assert.ok(written[3].length <= 1001 && !session.inlinePieces.has('nd'), 'as one line');
    scan(server, session, '<<<START:nd>>>\r\n');
    // A file over the lines' total on its own is refused with its size, unread.
    pending('nf', 'a'.repeat(130000));
    scan(server, session, '<<<NOFILE:nf>>>\r\n');
    assert.match(session.logs.at(-1), /would take more than 128 lines of 1000 bytes \(its body alone is 130000 bytes\)/);
    assert.ok(!fs.existsSync(files.at(-1)) && !session.pendingFiles.has('nf'));
    assert.equal(written.length, 4);
    session.issued.set('ne', path.join(os.tmpdir(), `tsm-test-${process.pid}-gone.sh`));
    session.pendingFiles.set('ne', path.join(os.tmpdir(), `tsm-test-${process.pid}-gone.sh`));
    scan(server, session, '<<<NOFILE:ne>>>\r\n');
    assert.ok(!session.pendingFiles.has('ne'));
    assert.match(session.logs.at(-1), /this command's temp file couldn't be read here either/);
    // Printed again, a refused command's marker finds its file released and
    // does nothing more.
    const logged = session.logs.length;
    scan(server, session, '<<<NOFILE:nc>>>\r\n<<<NOFILE:ne>>>\r\n');
    assert.equal(session.logs.length, logged);
    assert.equal(written.length, 4);
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
    assert.match(results[1].output, /^\[command not run: a line of its body reached a shell other than the one that asked for it, or didn't reach it whole, so nothing ran\]$/);
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
  const files = [];
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
    scan(server, session, '<<<START:nd>>>\r\n'); // read to its end: the next body's turn
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
    for (const [k, between] of [echo, 'x'.repeat(600), 'y'.repeat(5000)].entries()) {
      const nonce = `ng${k}`;
      files.push(pendingFile(session, nonce, 'echo G\n'));
      const typed = written.length;
      scan(server, session, `<<<NOFILE:${nonce}>>>`);
      scan(server, session, between);
      scan(server, session, '\r\n');
      assert.equal(written.length, typed + 1, `a no-file marker with ${between.length} characters before its newline`);
      scan(server, session, `<<<START:${nonce}>>>\r\n`);
    }
  } finally {
    for (const typedFile of [file, ...files]) fs.rmSync(typedFile, { force: true });
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
  session.unfinished.set('ng', false);
  session.typedInline.add('ng');
  // nk's file is gone already: a later command's start marker released it.
  session.unfinished.set('nk', false);
  session.typedInline.add('nk');
  session.issued.set('nk', '/tmp/nk');
  try {
    scan(server, session, '<<<GONE:ng>>>\r\n');
    assert.ok(!fs.existsSync(file) && !session.pendingFiles.has('ng') && !session.unfinished.has('ng'));
    assert.match(session.logs.at(-1), /a line of its body reached a shell other than the one that asked for it, or didn't reach it whole, so nothing ran/);
    scan(server, session, '<<<GONE:nk>>>\r\n');
    assert.ok(!session.unfinished.has('nk'));
    assert.equal(session.logs.length, 2);
    scan(server, session, '<<<GONE:ng>>>\r\n<<<GONE:nk>>>\r\n'); // printed again: nothing more
    assert.equal(session.logs.length, 2);
    server.rememberIssued(session, 'ng', file);
    assert.equal(server.stripPlumbingSpans(session, 'A<<<GONE:ng>>>\r\nB'), 'AB', 'the printed marker is plumbing');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("an exit marker takes its command, and the started ones written after it, out of the unfinished, with their files", () => {
  const server = bareServer();
  // w started a shell; x and c ran in it; y was written after w but hasn't
  // started, so the shell that printed w's marker may read it next.
  const session = { ...bareSession(), currentCommand: { nonce: 'c' } };
  session.unfinished = new Map([['a', true], ['w', true], ['x', true], ['y', false], ['c', true]]);
  const files = ['x', 'y', 'c'].map((nonce) => pendingFile(session, nonce, 'true\n'));
  try {
    assert.equal(server.finishUnfinished(session, 'w'), true, 'the current command ran in the shell that exited');
    assert.deepEqual([...session.unfinished.keys()], ['a', 'y']);
    assert.deepEqual([...session.pendingFiles.keys()], ['y'], 'the files of the commands that went go with them');
    assert.deepEqual(files.map((file) => fs.existsSync(file)), [false, true, false]);
    assert.equal(server.finishUnfinished(session, 'a'), false, 'the current command is no longer unfinished');
    assert.deepEqual([...session.unfinished.keys()], ['y']);
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});
