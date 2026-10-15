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
  unfinished: new Map(), typedInline: new Set(), inlinePieces: new Map(), inlineQueue: [], typedCount: 0, lineSeq: new Map(), scanCarry: '', awaitingMarkers: [], logs: []
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
    // where it also holds exactly what was typed before; the last then runs it.
    assert.match(lines[0], /^if \[ "\$\{__tsm_n2-\}" = "\$\$" \]; then __tsm_n2_b='[ -&(-~]*'; echo "<<<PIEC""E:n2:0>>>"; else echo "<<<GON""E:n2>>>"; fi$/);
    const adding = /^if \[ "\$\{__tsm_n2-\}" = "\$\$" \] && \[ "\$\{#__tsm_n2_b\}" = "(\d+)" \]; then __tsm_n2_b="\$__tsm_n2_b"'([ -&(-~]*)'/;
    let typed = lines[0].match(/'([^']*)'/)[1].length;
    for (const line of lines.slice(1)) {
      const [, before, piece] = line.match(adding);
      assert.equal(Number(before), typed, 'each line checks for the text typed before it');
      typed += piece.length;
    }
    lines.slice(1, -1).forEach((line, i) => assert.match(line, new RegExp(`'; echo "<<<PIEC""E:n2:${i + 1}>>>"; else echo "<<<GON""E:n2>>>"; fi$`)));
    assert.match(lines.at(-1), /'; echo "<<<STAR""T:n2>>>"; eval "unset __tsm_n2 __tsm_n2_b; \$\(printf '%b' "\$__tsm_n2_b"\)"; echo "<<<EXI""T:n2:\$\?>>>"; else echo "<<<GON""E:n2>>>"; fi$/);
    const left = 'echo "left:${__tsm_n2-unset}:${__tsm_n2_b-unset}"\n';
    const asked = '__tsm_n2=$$\n';
    const pieces = (count) => Array.from({ length: count }, (_, i) => `<<<PIECE:n2:${i}>>>\n`).join('');
    for (const shell of ['sh', 'bash']) {
      const run = (script) => {
        try { return execFileSync(shell, ['-c', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (err) { return err.stdout; }
      };
      assert.equal(run(asked + written.join('') + left), `${pieces(lines.length - 1)}<<<START:n2>>>\n${text}\n<<<EXIT:n2:7>>>\nleft:unset:unset\n`, shell);
      // Without the pid, every line prints the gone marker, and nothing runs.
      assert.equal(run(written.join('') + left), '<<<GONE:n2>>>\n'.repeat(lines.length) + 'left:unset:unset\n', `${shell}: no pid`);
      // A line that didn't reach the shell: the lines after it print the gone
      // marker, and the body never runs.
      const missing = run(asked + [lines[0], ...lines.slice(2)].join('\n') + '\n');
      assert.equal(missing, pieces(1) + '<<<GONE:n2>>>\n'.repeat(lines.length - 2), `${shell}: a line missing`);
      // A line cut short, as a tty over its limit would: the open quote takes
      // in what follows, and the body never runs.
      const cut = run(asked + [lines[0].slice(0, 400), ...lines.slice(1)].join('\n') + '\n');
      assert.ok(!cut.includes('<<<START:n2>>>') && !cut.includes(text), `${shell}: a line cut: ${JSON.stringify(cut.slice(0, 200))}`);
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
  const session = { ...bareSession(), outputBuffer: '', shell: { write: (text) => written.push(text) }, currentCommand: undefined };
  const files = [];
  const pending = (nonce, body) => files.push(pendingFile(session, nonce, body));
  // The shell reads the typed lines in the order they reached its terminal,
  // one per marker it prints. For each line typed after the first, how many
  // lines typed before it the shell hadn't read yet when it was typed; the
  // line editor needs that to be none (see INLINE_LINE_MAX).
  const unreadAtWrite = [];
  let read = 0;
  const shellReads = () => {
    for (; read < written.length; read++) {
      const piece = written[read].match(/echo "<<<PIEC""E:([0-9a-z]+):(\d+)>>>"/);
      if (!piece) continue;
      const before = written.length;
      scan(server, session, `<<<PIECE:${piece[1]}:${piece[2]}>>>\r\n`);
      if (written.length > before) unreadAtWrite.push(written.length - 1 - (read + 1));
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
    // A command given up (here, its line reached another shell) gives the
    // next its turn at once.
    session.unfinished.set('nb', false);
    scan(server, session, '<<<GONE:nb>>>\r\n');
    assert.equal(written.length, first + 2);
    assert.match(written.at(-1), /^if \[ "\$\{__tsm_nc-\}" = "\$\$" \]; then __tsm_nc_b='/);
    assert.deepEqual(session.inlineQueue, ['nc']);
    shellReads();
    assert.match(written.at(-1), /eval "unset __tsm_nc __tsm_nc_b;/);
    scan(server, session, '<<<START:nc>>>\r\n');
    assert.deepEqual(session.inlineQueue, []);
    assert.deepEqual(unreadAtWrite, unreadAtWrite.map(() => 0), 'each line was typed with nothing unread ahead of it');
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
    assert.match(session.logs.at(-1), /a line of its body never reached the shell in front, which has since read a line typed after it/);
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
