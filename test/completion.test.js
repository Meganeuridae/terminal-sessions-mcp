/**
 * Regression tests for command-completion detection (the "doesn't notice the
 * command ended / waits for the full timeout" family of bugs).
 *
 * These run against the compiled build (npm test builds first) and use real
 * PTYs, so they are integration tests; each asserts on wall-clock behavior
 * with generous margins to stay robust on slow CI machines.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');

let server;

/** Command temp files this process's server has on disk right now. */
const ourTempFiles = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`tsm-cmd-${process.pid}-`));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

before(() => {
  server = new PersistentSessionServer();
});

after(async () => {
  await server.killAll(false);
});

test('fast command resolves promptly with clean output', async () => {
  await server.createSession('t-fast');
  const start = Date.now();
  const result = await server.execCommand('t-fast', 'echo hello-world', 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(Date.now() - start < 3000, 'should resolve well before the timeout');
  assert.match(result.output, /hello-world/);
  assert.ok(!result.output.includes('<<<EXIT'), 'markers must be stripped');
  assert.ok(!result.output.includes("tsm-cmd"), 'wrapper echo must be stripped');
});

test('exit codes propagate through the marker', async () => {
  const result = await server.execCommand('t-fast', 'sh -c "exit 42"', 10000);
  assert.strictEqual(result.exitCode, 42);
});

test('env and cwd persist across the temp-file exec path', async () => {
  await server.execCommand('t-fast', 'export TSMCP_TEST=persisted; cd /', 10000);
  const env = await server.execCommand('t-fast', 'echo "$TSMCP_TEST"', 10000);
  assert.match(env.output, /persisted/);
  const pwd = await server.execCommand('t-fast', 'pwd', 10000);
  assert.match(pwd.output, /^\/\s*$/m);
});

test('shell death resolves the in-flight command instead of hanging until timeout', async () => {
  await server.createSession('t-exit');
  const start = Date.now();
  const result = await server.execCommand('t-exit', 'exit 7', 8000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `resolved in ${elapsed}ms; must not wait out the 8s timeout`);
  assert.strictEqual(result.exitCode, 7, "the shell's own exit status, not the timeout's -1");
  assert.ok(!result.output.includes('<<<EXIT'));
});

test('a shell killed by a signal resolves its in-flight command with -1, not as a success', async () => {
  await server.createSession('t-killed');
  const started = waitForOutput('t-killed', 'KILLED_STARTED');
  const call = server.execCommand('t-killed', 'echo KILLED_STARTED; sleep 60', 30000);
  await started;
  const start = Date.now();
  server.sendSignal('t-killed', 'SIGKILL');
  const result = await call;
  assert.ok(Date.now() - start < 10000, 'resolved at the death, not at the 30s timeout');
  assert.strictEqual(result.exitCode, -1);
  assert.ok(server.getOutput('t-killed').includes('[Session terminated by SIGKILL]'), 'the log names the signal');
});

test('shell death fails queued commands instead of hanging', async () => {
  await server.createSession('t-exit-q');
  const [first, second] = await Promise.all([
    server.execCommand('t-exit-q', 'exit', 8000),
    server.execCommand('t-exit-q', 'echo never-runs', 8000)
  ]);
  assert.strictEqual(second.exitCode, -1);
  assert.match(second.output, /session exited/);
});

test('a stdin-reading command times out without the marker being fed to it', async () => {
  await server.createSession('t-read');
  const start = Date.now();
  const result = await server.execCommand('t-read', 'read x', 1500);
  const elapsed = Date.now() - start;
  assert.strictEqual(result.exitCode, -1, 'stdin reader cannot complete; must time out');
  assert.ok(elapsed >= 1400 && elapsed < 4000, `timed out at ${elapsed}ms`);
  // Nothing was typed into `read` behind the caller's back: it is still
  // waiting, and the session can be unblocked explicitly.
  server.sendInput('t-read', '', true); // plain Enter -> read returns
  // Before #7 the marker line typed 50ms after the command landed in `x`.
  // Its length is printed rather than its text, which the old output
  // filter would have stripped from the result.
  const follow = await server.execCommand('t-read', 'printf "read got %s characters\\n" "${#x}"', 8000);
  assert.strictEqual(follow.exitCode, 0);
  assert.match(follow.output, /read got 0 characters/, `read received only the Enter: ${JSON.stringify(follow.output)}`);
});

test('marker-shaped text in command/output cannot cause premature completion', async () => {
  await server.createSession('t-fake');
  const start = Date.now();
  const result = await server.execCommand(
    't-fake',
    'printf "see <<<EXIT:7>>> and <<<EXIT:abc:0>>> here\\n"; sleep 0.4; echo done',
    10000
  );
  const elapsed = Date.now() - start;
  assert.strictEqual(result.exitCode, 0);
  assert.ok(elapsed >= 380, `resolved at ${elapsed}ms; must wait for the real completion`);
  assert.match(result.output, /done/);
});

test('a timed-out command does not corrupt the next command (stale-marker cascade)', async () => {
  await server.createSession('t-cascade');
  const timedOut = await server.execCommand('t-cascade', 'sh -c "sleep 1; exit 3"', 300);
  assert.strictEqual(timedOut.exitCode, -1);
  // The predecessor is still running; the next command queues behind it in
  // the tty and must resolve with ITS OWN result (0), not the predecessor's
  // stale marker (3).
  const next = await server.execCommand('t-cascade', 'echo after-cascade', 8000);
  assert.strictEqual(next.exitCode, 0);
  assert.match(next.output, /after-cascade/);
  assert.ok(!next.output.includes('<<<EXIT'), 'stale markers must be stripped');
});

test('single-line commands longer than the tty canonical buffer survive', async () => {
  // macOS line discipline truncates canonical-mode input at 1024 bytes; the
  // temp-file path sidesteps the line editor entirely.
  await server.createSession('t-long');
  const payload = 'x'.repeat(3000);
  const result = await server.execCommand('t-long', `echo ${payload} | wc -c`, 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /3001/); // payload + newline
});

test('session logs stay free of exec plumbing lines', async () => {
  await server.createSession('t-logs');
  await server.execCommand('t-logs', 'echo log-hygiene', 10000);
  const logs = server.getOutput('t-logs');
  const joined = logs.join('\n');
  assert.match(joined, /\$ echo log-hygiene/, 'issued command should be logged');
  assert.match(joined, /^log-hygiene/m, 'command output should be logged');
  assert.ok(!joined.includes('tsm-cmd'), 'wrapper echoes must not be logged');
  assert.ok(!/<<<EXIT:[0-9a-z]+:\d+>>>/.test(joined), 'markers must not be logged');
});

test('multi-line commands (heredocs) still work through the temp-file path', async () => {
  await server.createSession('t-ml');
  const result = await server.execCommand('t-ml', 'cat <<EOF\nline-one\nline-two\nEOF', 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /line-one/);
  assert.match(result.output, /line-two/);
});

test('a command queued behind a timed-out one still runs: caller timeouts do not delete its file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-queued-'));
  try {
    await server.createSession('t-queued', { cwd: dir });
    const first = await server.execCommand('t-queued', 'sleep 1', 100);
    assert.strictEqual(first.exitCode, -1);
    // Written into the tty while sleep still owns it: typeahead, not yet sourced.
    const queued = await server.execCommand('t-queued', 'printf MUST_RUN > queued', 100);
    assert.strictEqual(queued.exitCode, -1);
    // Issuing a third command used to delete the second one's temp file before
    // the shell got to source it.
    const third = await server.execCommand('t-queued', 'printf after', 8000);
    assert.strictEqual(third.exitCode, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'queued'), 'utf8'), 'MUST_RUN');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a temp file is released by its own marker, including one that arrives after a caller timeout', async () => {
  await server.createSession('t-files');
  const before = new Set(ourTempFiles());
  const fresh = () => ourTempFiles().filter(f => !before.has(f));
  const done = await server.execCommand('t-files', 'echo done', 8000);
  assert.strictEqual(done.exitCode, 0);
  assert.deepStrictEqual(fresh(), [], 'a completed command leaves no temp file behind');
  const timedOut = await server.execCommand('t-files', 'sleep 0.6', 100);
  assert.strictEqual(timedOut.exitCode, -1);
  assert.strictEqual(fresh().length, 1, 'a timed-out command keeps its file while the shell may still source it');
  // No command is current when sleep ends; its late marker still releases the file.
  for (let i = 0; i < 100 && fresh().length > 0; i++) await sleep(50);
  assert.deepStrictEqual(fresh(), [], 'the late marker released the file');
});

test('PTY exit releases the files of commands that can no longer run', async () => {
  await server.createSession('t-exit-files');
  const before = new Set(ourTempFiles());
  const timedOut = await server.execCommand('t-exit-files', 'sleep 5', 100);
  assert.strictEqual(timedOut.exitCode, -1);
  assert.strictEqual(ourTempFiles().filter(f => !before.has(f)).length, 1);
  server.sendSignal('t-exit-files', 'SIGKILL');
  for (let i = 0; i < 50 && server.listSessions().find(s => s.id === 't-exit-files')?.isAlive; i++) await sleep(50);
  assert.deepStrictEqual(ourTempFiles().filter(f => !before.has(f)), []);
});

test('the server process removes pending temp files when it exits', () => {
  const { execFileSync } = require('node:child_process');
  const serverModule = path.resolve(__dirname, '../dist/src/server/session-server-v3.js');
  const child = `
    const fs = require('node:fs');
    const os = require('node:os');
    const { PersistentSessionServer } = require(${JSON.stringify(serverModule)});
    const server = new PersistentSessionServer();
    (async () => {
      const exitCodes = [];
      for (const id of ['child-a', 'child-b']) {
        await server.createSession(id);
        exitCodes.push((await server.execCommand(id, 'sleep 30', 100)).exitCode);
      }
      const pending = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('tsm-cmd-' + process.pid + '-')).length;
      process.stdout.write(JSON.stringify({ pid: process.pid, exitCodes, pending }));
      process.exit(0);
    })();`;
  const report = JSON.parse(execFileSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 20000 }));
  assert.deepStrictEqual([report.exitCodes, report.pending], [[-1, -1], 2], "each session's timed-out command held its file when the process exited");
  assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`tsm-cmd-${report.pid}-`)), []);
});

// A command left in the queue has no timer, so a drain that stopped would hang; the
// test's own timeout turns that into a failure.
test('commands whose temp files cannot be written fail alone, and the session stays usable', { timeout: 20000 }, async () => {
  await server.createSession('t-nowrite');
  // Its file is written now; the three below queue behind it while it runs.
  const running = server.execCommand('t-nowrite', 'sleep 0.3; printf RAN', 8000);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = path.join(os.tmpdir(), `tsm-missing-${process.pid}`);
  let failed;
  try {
    failed = await Promise.all(['printf ONE', 'printf TWO', 'printf THREE'].map(c => server.execCommand('t-nowrite', c, 8000)));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.strictEqual((await running).exitCode, 0);
  for (const result of failed) {
    assert.strictEqual(result.exitCode, -1);
    assert.match(result.output, /could not write its temp file/, 'it failed at its write, not at its timeout');
  }
  const after = await server.execCommand('t-nowrite', 'printf AFTER_OK', 8000);
  assert.strictEqual(after.exitCode, 0);
  assert.match(after.output, /AFTER_OK/);
});

/** Complete output lines the server emitted for one session, as output events carry them. */
function collectEventLines(sessionId) {
  const lines = [];
  server.on('session:output', (e) => { if (e.sessionId === sessionId) lines.push(...e.lines); });
  return lines;
}

/** Resolves once the session's raw output from now on contains the needle. */
function waitForOutput(sessionId, needle, ms = 5000) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const onOutput = (e) => {
      if (e.sessionId !== sessionId) return;
      seen += e.chunk;
      if (!seen.includes(needle)) return;
      clearTimeout(timer);
      server.off('session:output', onOutput);
      resolve();
    };
    const timer = setTimeout(() => {
      server.off('session:output', onOutput);
      reject(new Error(`${sessionId} printed no ${JSON.stringify(needle)} within ${ms}ms`));
    }, ms);
    server.on('session:output', onOutput);
  });
}

test("a later command's start releases the files of lines the shell read past without finishing", async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  await server.createSession('t-interrupt');
  // `-noflsh` is the terminal's default, set here because the discard below
  // rests on it: with `noflsh` the lines typed in behind the sleep are kept,
  // and can still run after it.
  await server.execCommand('t-interrupt', "PS1='T_INTERRUPT_READY> '; stty -noflsh", 8000);
  const before = new Set(ourTempFiles());
  const fresh = () => ourTempFiles().filter(f => !before.has(f));
  const sleeping = waitForOutput('t-interrupt', 'SLEEP_STARTED');
  const timedOut = await server.execCommand('t-interrupt', 'echo SLEEP_STARTED; sleep 30', 200);
  assert.strictEqual(timedOut.exitCode, -1);
  await sleeping;
  assert.strictEqual(fresh().length, 1);
  const [sleepFile] = fresh();
  // Two more commands are typed in behind the running sleep and time out unread.
  for (const word of ['ONE', 'TWO']) {
    assert.strictEqual((await server.execCommand('t-interrupt', `printf FLUSHED_%s ${word}`, 100)).exitCode, -1);
  }
  assert.strictEqual(fresh().length, 3);
  const flushedFiles = fresh().filter(f => f !== sleepFile);
  // Ctrl-C ends sleep, and the tty, flushing its input on the interrupt,
  // discards the two lines typed in behind it. bash 4 and later then drop the
  // rest of the sleep's line, so its exit marker never prints; bash 3.2
  // (macOS's /bin/bash) runs it, printing the marker with status 130, which
  // releases the sleep's own file.
  const prompt = waitForOutput('t-interrupt', 'T_INTERRUPT_READY> ');
  server.sendSignal('t-interrupt', 'SIGINT');
  await prompt;
  assert.deepStrictEqual(fresh().filter(f => f !== sleepFile).sort(), flushedFiles.sort(),
    "nothing has released the discarded lines' files yet");
  const next = await server.execCommand('t-interrupt', 'printf NEXT_OK', 8000);
  assert.strictEqual(next.exitCode, 0);
  assert.strictEqual(cleanTerminalOutput(next.output).trim(), 'NEXT_OK');
  assert.deepStrictEqual(fresh(), [], "the next command's start released the earlier files, and its own exit marker its own file");
  assert.ok(!server.getOutput('t-interrupt').some(l => /FLUSHED_(ONE|TWO)/.test(l)), 'the discarded lines never ran');
});

test('output without a trailing newline survives in the result, the logs and output events', async () => {
  await server.createSession('t-nonl');
  const events = collectEventLines('t-nonl');
  const result = await server.execCommand('t-nonl', 'printf NO_NEWLINE', 8000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /NO_NEWLINE/);
  // It shares its line with the real marker; only the marker span may go.
  assert.ok(server.getOutput('t-nonl').some(l => l.includes('NO_NEWLINE')), 'logs keep the output');
  // Output events carry complete lines, and the command resolves at its exit
  // marker, which can arrive in a chunk before the newline ending its line.
  for (let i = 0; i < 100 && !events.some(l => l.includes('NO_NEWLINE')); i++) await sleep(20);
  assert.ok(events.some(l => l.includes('NO_NEWLINE')), 'output events keep the output');
  assert.ok(![...server.getOutput('t-nonl'), ...events].some(l => /<<<EXIT:[0-9a-z]+:\d+>>>/.test(l)), 'the marker span is removed');
});

test('marker-shaped text with a nonce the server never issued is output, everywhere', async () => {
  await server.createSession('t-literal');
  const events = collectEventLines('t-literal');
  const literal = 'prefix <<<EXIT:abc:0>>> suffix';
  const result = await server.execCommand('t-literal', `printf '${literal}\\n'; false`, 8000);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes(literal), `result keeps the literal: ${JSON.stringify(result.output)}`);
  assert.ok(server.getOutput('t-literal').some(l => l.includes(literal)), 'logs keep the literal line');
  assert.ok(events.some(l => l.includes(literal)), 'output events keep the literal line');
});

test("a timed-out predecessor's late marker is removed everywhere, and the text beside it stays", async () => {
  await server.createSession('t-late');
  const events = collectEventLines('t-late');
  const timedOut = await server.execCommand('t-late', 'sleep 0.4; printf LATE_TAIL', 100);
  assert.strictEqual(timedOut.exitCode, -1);
  // The predecessor prints LATE_TAIL and then its own marker on the same line
  // while this command waits behind it in the tty.
  const next = await server.execCommand('t-late', 'echo NEXT_OUT', 8000);
  assert.strictEqual(next.exitCode, 0);
  assert.match(next.output, /NEXT_OUT/);
  assert.ok(!/<<<EXIT:[0-9a-z]+:\d+>>>/.test(next.output), 'no issued marker in the result');
  const logs = server.getOutput('t-late');
  for (const [surface, lines] of [['logs', logs], ['events', events]]) {
    assert.ok(lines.some(l => l.includes('LATE_TAIL')), `${surface} keep the text beside the late marker`);
    assert.ok(!lines.some(l => /<<<EXIT:[0-9a-z]+:\d+>>>/.test(l)), `${surface} carry no issued marker`);
    assert.ok(!lines.some(l => l.includes('tsm-cmd')), `${surface} carry no wrapper echo`);
  }
});

test("a timed-out command's partial tail survives the next wrapper's echo in logs and output events", async () => {
  await server.createSession('t-tail');
  const events = collectEventLines('t-tail');
  let arrived = false;
  server.on('session:output', (e) => { if (e.sessionId === 't-tail' && e.chunk.includes('AFTER_TIMEOUT')) arrived = true; });
  const first = await server.execCommand('t-tail', 'sleep 0.2; printf AFTER_TIMEOUT; sleep 0.6', 50);
  assert.strictEqual(first.exitCode, -1);
  for (let i = 0; i < 200 && !arrived; i++) await sleep(10);
  assert.ok(arrived, 'the timed-out command printed its tail');
  // The tty echoes the next typed wrapper onto the tail's unterminated line.
  const next = await server.execCommand('t-tail', 'echo NEXT', 8000);
  assert.strictEqual(next.exitCode, 0);
  for (const [surface, lines] of [['logs', server.getOutput('t-tail')], ['events', events]]) {
    assert.ok(lines.some(l => l.includes('AFTER_TIMEOUT')), `${surface} keep the timed-out command's tail`);
    assert.ok(!lines.some(l => l.includes('tsm-cmd') || l.includes('<<<EXI""T')), `${surface} carry no wrapper echo`);
  }
});

test('a wrapper echo soft-wrapped mid-part leaves no plumbing in logs or output events', async () => {
  // A narrow terminal makes the shell's echo of the typed wrapper wrap inside
  // its parts (on macOS a long temp directory does this even at 120 columns).
  // Where bash writes no wrap artifact, as on Linux, this passes without the
  // patterns' tolerance too; the plumbing unit tests feed the artifacts
  // directly. The session starts in / so that a prompt showing a checkout
  // path with "tsm-" in it can't look like a wrapper fragment.
  await server.createSession('t-wrap', { cwd: '/' });
  server.resizeSession('t-wrap', 30, 30);
  const events = collectEventLines('t-wrap');
  const result = await server.execCommand('t-wrap', 'echo WRAPPED', 8000);
  assert.strictEqual(result.exitCode, 0);
  for (const [surface, lines] of [['logs', server.getOutput('t-wrap')], ['events', events]]) {
    assert.ok(lines.some(l => l.includes('WRAPPED')), `${surface} keep the output`);
    for (const fragment of ['<<', '""', 'tsm-', ". '"]) {
      assert.ok(!lines.some(l => l.includes(fragment)), `${surface} carry no wrapper fragment ${JSON.stringify(fragment)}: ${JSON.stringify(lines)}`);
    }
  }
});

test('a result begins after its own start marker and ends at its own exit marker', async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  await server.createSession('t-bounds');
  // What follows the marker is the shell's next prompt, not the command's output.
  const number = await server.execCommand('t-bounds', 'printf 42', 8000);
  assert.strictEqual(number.exitCode, 0);
  assert.strictEqual(cleanTerminalOutput(number.output).trim(), '42');
  // A timed-out predecessor's late tail belongs to the predecessor (and stays
  // in the logs), not to the command written while it was still running.
  const timedOut = await server.execCommand('t-bounds', 'sleep 0.3; printf LATE_TAIL', 100);
  assert.strictEqual(timedOut.exitCode, -1);
  const next = await server.execCommand('t-bounds', 'echo NEXT_OUT', 8000);
  assert.strictEqual(next.exitCode, 0);
  assert.strictEqual(cleanTerminalOutput(next.output).trim(), 'NEXT_OUT');
  assert.ok(server.getOutput('t-bounds').some(l => l.includes('LATE_TAIL')), 'the tail stays recoverable from the logs');
});

for (const [label, setup] of [['terminal echo off', 'stty -echo'], ['no line editor', 'set +o emacs; set +o vi']]) {
  test(`result bounds come from execution markers, not echo (${label})`, async () => {
    const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
    const id = `t-bounds-${label.replace(/\W+/g, '-')}`;
    await server.createSession(id);
    await server.execCommand(id, setup, 8000);
    const timedOut = await server.execCommand(id, 'sleep 0.3; printf LATE_TAIL', 50);
    assert.strictEqual(timedOut.exitCode, -1);
    const next = await server.execCommand(id, 'printf NEXT_OUT', 8000);
    assert.strictEqual(next.exitCode, 0);
    assert.strictEqual(cleanTerminalOutput(next.output).trim(), 'NEXT_OUT');
    assert.ok(server.getOutput(id).some(l => l.includes('LATE_TAIL')), 'the tail stays recoverable from the logs');
    assert.ok(!server.getOutput(id).some(l => /<<<(START|EXIT):/.test(l)), 'no issued marker in the logs');
  });
}

test('a command that times out before it starts has no output of its own', async () => {
  await server.createSession('t-unstarted');
  await server.execCommand('t-unstarted', 'sleep 0.2; printf BUSY_%s TAIL; sleep 5', 50);
  // Written while the predecessor owns the tty; the predecessor prints its
  // tail after this command was written (about 0.2s in, leaving nearly 3s of
  // margin), and this one times out before the shell ever reads it.
  const queued = await server.execCommand('t-unstarted', 'echo QUEUED_OUT', 3000);
  assert.strictEqual(queued.exitCode, -1);
  assert.ok(server.getOutput('t-unstarted').some(l => l.includes('BUSY_TAIL')), 'the predecessor printed while this command waited');
  assert.strictEqual(queued.output, '', 'nothing the predecessor printed is attributed to it');
});

test('commands queued behind a running one each get their own output and status, in order', async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  await server.createSession('t-queue');
  const results = await Promise.all([
    server.execCommand('t-queue', 'sleep 0.3; printf FIRST', 8000),
    server.execCommand('t-queue', 'printf SECOND; (exit 2)', 8000),
    server.execCommand('t-queue', 'printf THIRD; (exit 3)', 8000)
  ]);
  assert.deepStrictEqual(
    results.map(r => [cleanTerminalOutput(r.output).trim(), r.exitCode]),
    [['FIRST', 0], ['SECOND', 2], ['THIRD', 3]]
  );
});

test('a plain sh session runs commands through the same path', async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  await server.createSession('t-sh', { shell: '/bin/sh', cwd: '/' });
  const result = await server.execCommand('t-sh', 'printf "%s\\n" "$((6 * 7))"; (exit 5)', 8000);
  assert.strictEqual(result.exitCode, 5);
  assert.strictEqual(cleanTerminalOutput(result.output).trim(), '42');
});

test('a shell that dies with a marker still waiting for its newline leaves nothing waiting in the session', async () => {
  await server.createSession('t-dead-marker', { cwd: '/' });
  assert.strictEqual((await server.execCommand('t-dead-marker', 'true', 8000)).exitCode, 0);
  const session = server.sessions.get('t-dead-marker');
  const nonce = [...session.issued.keys()].at(-1);
  // The shell prints that command's start marker again, and the start of
  // another, with no newline after them, and dies.
  const died = await server.execCommand('t-dead-marker', `printf '<<<STAR''T:%s>>><<<EX' ${nonce}; kill -9 $$`, 8000);
  assert.strictEqual(died.exitCode, -1);
  assert.deepStrictEqual(session.awaitingMarkers, []);
  assert.strictEqual(session.scanCarry, '');
  assert.deepStrictEqual([session.inlineQueue, session.inlinePieces.size, session.typedInline.size], [[], 0, 0]);
});

test("a shell in front that can't read the temp files gets each body typed inline, and its exit ends the command that exited it", async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  // A nested bash whose `.` and `[ -r` fail as they would in a shell that
  // can't see this machine's temp directory, such as a remote one ssh opened.
  const rc = path.join(os.tmpdir(), `tsm-test-rc-${process.pid}`);
  fs.writeFileSync(rc, '.() { echo "bash: $1: No such file or directory" >&2; return 1; }\n' +
    '[() { if builtin test "$1" = -r; then return 1; fi; builtin [ "$@"; }\nPS1="NESTED> "\n');
  try {
    await server.createSession('t-remote', { cwd: '/' });
    const raw = [];
    server.on('session:output', (e) => { if (e.sessionId === 't-remote') raw.push(e.chunk); });
    const level = Number(cleanTerminalOutput((await server.execCommand('t-remote', 'echo "$SHLVL"', 8000)).output).trim());
    const nested = waitForOutput('t-remote', 'NESTED> ');
    assert.strictEqual((await server.execCommand('t-remote', `bash --rcfile '${rc}'`, 500)).exitCode, -1);
    await nested;
    const content = `it's "quoted" \\ %d\ttab`;
    const heredoc = await server.execCommand('t-remote', `cat <<'END'\n${content}\nEND\necho "level=$SHLVL"`, 8000);
    assert.strictEqual(heredoc.exitCode, 0);
    assert.deepStrictEqual(cleanTerminalOutput(heredoc.output).trim().split(/\r?\n/), [content, `level=${level + 1}`]);
    assert.strictEqual((await server.execCommand('t-remote', '(exit 3)', 8000)).exitCode, 3);
    // A body too long for one line goes in lines of at most 1,000 bytes, and
    // runs whole.
    const long = await server.execCommand('t-remote', `x='${'B'.repeat(5000)}'; echo "length=\${#x}"`, 8000);
    assert.strictEqual(long.exitCode, 0);
    assert.strictEqual(cleanTerminalOutput(long.output).trim(), 'length=5000');
    // One that would take more than 128 such lines isn't typed, and says why.
    const tooLong = await server.execCommand('t-remote', `x='${'B'.repeat(130000)}'; echo "length=\${#x}"`, 8000);
    assert.strictEqual(tooLong.exitCode, -1);
    assert.match(tooLong.output, /^\[command not run: the shell in front can't read this machine's temp files, and typed in, this command would take more than 128 lines of 1000 bytes \(its body alone is 1300\d\d bytes\)/);
    assert.ok(!raw.join('').includes('B'.repeat(6000)), 'the refused body never reached the terminal');
    assert.strictEqual(cleanTerminalOutput((await server.execCommand('t-remote', 'echo "level=$SHLVL"', 8000)).output).trim(), `level=${level + 1}`);
    // `exit` prints no exit marker of its own; the line that started the
    // nested shell prints one when it ends, with the status that ends it.
    // A timeout would give -1.
    const exited = await server.execCommand('t-remote', 'exit 4', 8000);
    assert.strictEqual(exited.exitCode, 4);
    const back = await server.execCommand('t-remote', 'echo "level=$SHLVL"', 8000);
    assert.strictEqual(cleanTerminalOutput(back.output).trim(), `level=${level}`);
    assert.ok(raw.join('').includes('eval "unset __tsm_'), 'the bodies were typed inline');
    // The `$ <command>` lines show each command as the caller sent it.
    const logs = server.getOutput('t-remote').filter(l => !l.startsWith('$ '));
    for (const fragment of ['<<', '""', 'tsm-', ". '", "printf '%b'", '[ -r', '__tsm_', 'NOFIL', 'GON']) {
      assert.ok(!logs.some(l => l.includes(fragment)), `logs carry no plumbing fragment ${JSON.stringify(fragment)}: ${JSON.stringify(logs)}`);
    }
  } finally {
    fs.rmSync(rc, { force: true });
  }
});

test("a body whose line a program took holds the bodies behind it only until the shell reads a line typed later; then it is given up and they run", async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  const rc = path.join(os.tmpdir(), `tsm-test-rc2-${process.pid}`);
  fs.writeFileSync(rc, '.() { echo "bash: $1: No such file or directory" >&2; return 1; }\n' +
    '[() { if builtin test "$1" = -r; then return 1; fi; builtin [ "$@"; }\nPS1="NESTED> "\n');
  try {
    await server.createSession('t-stuck', { cwd: '/' });
    const nested = waitForOutput('t-stuck', 'NESTED> ');
    assert.strictEqual((await server.execCommand('t-stuck', `bash --rcfile '${rc}'`, 500)).exitCode, -1);
    await nested;
    // Four commands typed in behind a sleeping one. Their probe lines wait
    // in the terminal together, so their no-file markers come back to back,
    // and their bodies go in one at a time. The first body reads one line
    // from the terminal when it runs, and takes the second body's line.
    const done = waitForOutput('t-stuck', 'B_DONE', 8000);
    // The three probe lines below are typed at three 300 ms timeouts; the sleep outlasts them with margin.
    assert.strictEqual((await server.execCommand('t-stuck', 'sleep 3', 300)).exitCode, -1);
    assert.strictEqual((await server.execCommand('t-stuck', 'head -n 1 >/dev/null; echo B_DONE', 300)).exitCode, -1);
    assert.strictEqual((await server.execCommand('t-stuck', 'echo C_RAN', 300)).exitCode, -1);
    assert.strictEqual((await server.execCommand('t-stuck', 'echo D_RAN', 300)).exitCode, -1);
    await done;
    await new Promise((r) => setTimeout(r, 300));
    const printed = (logs) => logs.map((l) => cleanTerminalOutput(l).trim()).filter((l) => /^(B_DONE|C_RAN|D_RAN|E_RAN)$/.test(l));
    assert.deepStrictEqual(printed(server.getOutput('t-stuck')), ['B_DONE'], 'the third body waits behind the taken one');
    // The next command's probe line is typed after the taken line, and its
    // marker shows the shell has read past it: the taken body is given up,
    // and the bodies behind it run, in order.
    const e = await server.execCommand('t-stuck', 'echo E_RAN', 8000);
    assert.strictEqual(e.exitCode, 0);
    assert.strictEqual(cleanTerminalOutput(e.output).trim(), 'E_RAN');
    const logs = server.getOutput('t-stuck');
    assert.deepStrictEqual(printed(logs), ['B_DONE', 'D_RAN', 'E_RAN']);
    assert.ok(logs.some((l) => l.includes('command given up: a line of its body never reached the shell in front, which has since read a line typed after it')), 'the log says why');
    assert.strictEqual((await server.execCommand('t-stuck', 'exit', 8000)).exitCode, 0);
  } finally {
    fs.rmSync(rc, { force: true });
  }
});

test("a command that times out while its body is still going in pieces goes in to the end and runs, and the command typed in behind it runs after it", async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  const rc = path.join(os.tmpdir(), `tsm-test-rc3-${process.pid}`);
  fs.writeFileSync(rc, '.() { echo "bash: $1: No such file or directory" >&2; return 1; }\n' +
    '[() { if builtin test "$1" = -r; then return 1; fi; builtin [ "$@"; }\nPS1="NESTED> "\n');
  try {
    await server.createSession('t-pieces', { cwd: '/' });
    const nested = waitForOutput('t-pieces', 'NESTED> ');
    assert.strictEqual((await server.execCommand('t-pieces', `bash --rcfile '${rc}'`, 500)).exitCode, -1);
    await nested;
    // About 22 lines, each a round trip: the 100 ms timeout passes while they go in,
    // and the next command's probe line is typed then, between two pieces.
    const long = await server.execCommand('t-pieces', `x='${'y'.repeat(20000)}'; echo "len=\${#x}"`, 100);
    assert.strictEqual(long.exitCode, -1, 'timed out while its body was going in');
    const after = await server.execCommand('t-pieces', 'echo AFTER', 8000);
    assert.strictEqual(after.exitCode, 0);
    assert.strictEqual(cleanTerminalOutput(after.output).trim(), 'AFTER');
    const printed = server.getOutput('t-pieces').map((l) => cleanTerminalOutput(l).trim()).filter((l) => l === 'len=20000' || l === 'AFTER');
    assert.deepStrictEqual(printed, ['len=20000', 'AFTER'], 'the long body ran whole, then the command behind it');
    assert.strictEqual((await server.execCommand('t-pieces', 'exit', 8000)).exitCode, 0);
  } finally {
    fs.rmSync(rc, { force: true });
  }
});

test('a nested shell that can read the temp files runs each command from its file, so a long body is never typed', async () => {
  const { cleanTerminalOutput } = require('../dist/src/utils/ansi-clean.js');
  await server.createSession('t-local-nested', { cwd: '/' });
  const raw = [];
  server.on('session:output', (e) => { if (e.sessionId === 't-local-nested') raw.push(e.chunk); });
  // The prompt is built when the line runs, so its echo can't match it.
  const nested = waitForOutput('t-local-nested', 'LOCAL_NESTED> ');
  assert.strictEqual((await server.execCommand('t-local-nested', 'PS1="LOCAL_$(printf NESTED)> " bash --norc --noprofile', 500)).exitCode, -1);
  await nested;
  const long = await server.execCommand('t-local-nested', `x='${'A'.repeat(20000)}'; echo "length=\${#x}"`, 8000);
  assert.strictEqual(long.exitCode, 0);
  assert.strictEqual(cleanTerminalOutput(long.output).trim(), 'length=20000');
  assert.ok(!raw.join('').includes('A'.repeat(200)), 'the body never reached the terminal');
  // Its exit ends with the nested shell; a timeout would give -1.
  assert.strictEqual((await server.execCommand('t-local-nested', 'exit', 8000)).exitCode, 0);
});
