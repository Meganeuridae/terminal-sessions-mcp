/**
 * Declared shells (§8.1): the caller says once that the program in front of the terminal is a
 * shell — a nested `sh`, the remote end of `ssh`, what replaced the session's shell — and plain
 * shell Runs go to it inline, bounded by markers, until the Run that opened it ends. Real shells
 * throughout: bash hosts the session; the declared shell is sh, zsh, dash or fish.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../src/core/session.js';
import type { TermError } from '../src/core/errors.js';
import { looksLikeShellOpener, renderRun } from '../src/api/tools.js';
import type { RunResult } from '../src/api/app.js';
import { AGENT, hasShell, realSession, until, type Real } from './fake-shell.js';

test('the result of a command that looks like it opened a shell points at the declaration; others do not', () => {
  const running = (line: string): RunResult => ({ runId: 'r1', session: 's', target: 'shell', state: 'running', cwd: '/', attribution: 'temporal', line, durationMs: 1500, output: { text: '', truncated: false, seq: [1, 2], nextCursor: 2 } });
  for (const line of ['ssh workbox', 'sudo -i', 'sudo docker exec -it app bash', 'kubectl exec -it pod -- sh', 'bash', '/usr/local/bin/fish', 'env FOO=1 ssh -tt host', 'limactl shell tsm-debian']) {
    assert.ok(looksLikeShellOpener(line), line);
    assert.match(renderRun(running(line), 'transcript').text, /declare that with session_declare_shell/);
  }
  for (const line of ['sleep 30', 'npm test', 'tail -f log', 'bashful', 'cat shell.txt', 'sudo apt install']) {
    assert.ok(!looksLikeShellOpener(line), line);
    assert.doesNotMatch(renderRun(running(line), 'transcript').text, /session_declare_shell/);
  }
  assert.doesNotMatch(renderRun({ ...running('ssh host'), shell: 'sh', within: 'r0' }, 'transcript').text, /it looks like it did/, 'no hint on a Run already inside a declared shell');
});

const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);
const PAYLOAD = `it's "quoted" \\back\\slash %d\ttab ünïcødé 😀 $HOME \`x\` !bang`;
const LINES = Array.from({ length: 120 }, (_, i) => `  echo line-${i}-${'x'.repeat(40)}`).join('\n');

const declare = (s: Session, shell: string, within?: string) => s.declareShell({ shell, principal: AGENT, ...(within !== undefined && { within }) });
const notes = (x: Real) => x.journal.since(0).events.filter((e) => e.type === 'note').map((e) => (e as { text: string }).text);
const invalid = (re: RegExp) => (e: TermError) => e.code === 'invalid_argument' && re.test(e.message);

/** Start a program in the session's shell as a Run and wait until its line started. */
async function open(session: Session, line: string): Promise<string> {
  const a = session.admit({ target: 'shell', line, principal: AGENT });
  assert.ok(a.admitted);
  await until(() => session.run(a.run.runId).state === 'running', 5000, `${line} to start`);
  return a.run.runId;
}

const SHELLS: Array<{ name: string; shell: string; open: string; status: string; exit: number; exact: string; long: string }> = [
  { name: 'sh', shell: 'sh', open: 'sh', status: 'echo "in=$0"; (exit 5)', exit: 5, exact: `cat <<'TSM_EOF'\n${PAYLOAD}\nTSM_EOF`, long: `f() {\n${LINES}\n}\nf | wc -l` },
  { name: 'zsh', shell: 'zsh', open: 'zsh -f', status: 'echo "in=$0"; (exit 5)', exit: 5, exact: `cat <<'TSM_EOF'\n${PAYLOAD}\nTSM_EOF`, long: `f() {\n${LINES}\n}\nf | wc -l` },
  ...(FISH
    ? [{ name: 'fish', shell: 'fish', open: `${FISH} --no-config`, status: 'echo in=fish; false', exit: 1, exact: `printf '%s\\n' 'it\\'s "quoted" \\\\back\\\\slash %d\ttab ünïcødé 😀 $HOME \`x\` !bang'`, long: `function f\n${LINES}\nend\nf | wc -l` }]
    : []),
];

for (const s of SHELLS) {
  test(`declared ${s.name} inside a bash session: plain Runs go to it, exactly; it ends with the Run that opened it`, { skip: s.name !== 'fish' && !hasShell(`/bin/${s.name}`) }, async () => {
    const x = await realSession('/bin/bash');
    try {
      // Nothing in front: nothing to declare.
      assert.throws(() => declare(x.session, s.shell), invalid(/nothing is running in front/));
      const enclosing = await open(x.session, s.open);
      const plain = x.session.admit({ target: 'shell', line: 'echo WRONG', principal: AGENT });
      assert.ok(!plain.admitted && plain.reason === 'running', 'the nested shell occupies the session’s shell');
      // The kind need not be named for a POSIX shell: `sh` is the default (fish is the one that types differently).
      const declared = s.name === 'sh' ? x.session.declareShell({ principal: AGENT }) : declare(x.session, s.shell);
      assert.deepEqual(declared, { shell: s.shell, within: enclosing, depth: 1 });
      assert.deepEqual(x.session.info().declared, { shell: s.shell, within: enclosing });
      assert.ok(notes(x).some((n) => n.startsWith(`declared: ${enclosing}`)));
      // A plain Run now goes to the declared shell: its status and output, no cwd.
      const st = await x.run(s.status);
      assert.deepEqual([st.state, st.exit, st.shell, st.within, st.cwd], ['exited', s.exit, s.shell, enclosing, '']);
      assert.match(st.text, /^in=/);
      // Quoting, backslashes, a tab, a bang, UTF-8: the text arrives as written (the transcript renders the tab as spaces).
      const ex = await x.run(s.exact);
      assert.deepEqual([ex.state, ex.exit], ['exited', 0]);
      assert.equal(ex.text.replace(/\s+/g, ' '), PAYLOAD.replace(/\s+/g, ' '));
      // A body far over one line's worth goes in acknowledged pieces; the shell sees all of it.
      const before = x.journal.lastSeq;
      const long = await x.run(s.long, 8000);
      assert.deepEqual([long.state, long.exit, long.text.trim()], ['exited', 0, '120']);
      const acks = x.journal.since(before).events.flatMap((e) => (e.type === 'output' && e.runId === enclosing ? [e.data] : [])).join('').match(/<<<ACK:[0-9a-f]+:\d+>>>/g) ?? [];
      assert.ok(acks.length >= 2, `the pieces were typed one by one (${acks.length} acknowledged)`);
      // The declared shell keeps its state between Runs, as a typed shell would.
      assert.equal((await x.run('cd /tmp')).exit, 0);
      assert.equal((await x.run('pwd')).text.trim(), '/tmp');
      // Leaving it: the exit ends the enclosing Run with the shell's status; the Run that typed `exit`
      // cannot report and says why; the declaration ends with the Run and a note says so.
      const bye = await x.run('exit 3');
      assert.equal(bye.state, 'lost');
      assert.match(bye.reason ?? '', /enclosing-run-ended/);
      const r = await x.session.awaitRun(enclosing, 3000);
      assert.deepEqual([r.state, r.exit], ['exited', 3]);
      assert.equal(x.session.info().declared, undefined);
      assert.ok(notes(x).some((n) => /declared .* shell ended with .*: shell Runs go to the session's own shell again/.test(n)));
      const back = await x.run('echo back');
      assert.deepEqual([back.text, back.shell], ['back', undefined]);
    } finally {
      await x.close();
    }
  });
}

test('a declared shell is the way back from `unavailable`: exec into dash, declare, run there, leave', { skip: !hasShell('/bin/dash') }, async () => {
  const x = await realSession('/bin/zsh', { integrationGraceMs: 800 });
  try {
    const r = await x.run('exec /bin/dash', 6000);
    assert.deepEqual([r.state, r.reason], ['lost', 'shell-replaced']);
    assert.deepEqual(x.session.shellAvailable(), { ok: false, reason: 'shell-unavailable' });
    assert.equal(x.session.admit({ target: 'shell', line: 'echo never', principal: AGENT, queue: true }).admitted, false);
    assert.deepEqual(declare(x.session, 'sh'), { shell: 'sh', within: null, depth: 1 });
    const st = await x.run('echo "in=$0"; (exit 4)');
    assert.deepEqual([st.state, st.exit, st.within], ['exited', 4, null]);
    assert.match(st.text, /^in=.*dash$/);
    assert.equal((await x.run('cd /tmp; pwd')).text.trim(), '/tmp');
    // One Run at a time in front; a second waits its turn when asked to.
    const slow = x.session.admit({ target: 'shell', line: 'sleep 0.4; echo first', principal: AGENT });
    const refused = x.session.admit({ target: 'shell', line: 'echo second', principal: AGENT });
    const queued = x.session.admit({ target: 'shell', line: 'echo second', principal: AGENT, queue: true });
    assert.ok(slow.admitted && queued.admitted && !refused.admitted && refused.reason === 'running' && refused.busy?.runId === slow.run.runId);
    assert.equal(queued.run.state, 'queued');
    const [a, b] = await Promise.all([x.session.awaitRun(slow.run.runId, 5000), x.session.awaitRun(queued.run.runId, 5000)]);
    assert.deepEqual([a.state, b.state], ['exited', 'exited']);
    assert.ok(b.seq.start! > a.seq.end!, 'the queued Run started after the first ended');
    // Leaving the replacement ends the terminal: the Run that typed `exit` cannot report.
    assert.equal((await x.run('exit')).state, 'lost');
    await until(() => x.session.info().state === 'exited', 3000);
    assert.equal(x.session.info().declared, undefined);
  } finally {
    await x.close();
  }
});

test('cancel in a declared shell: ^C reaches its job and the shell answers the next Run; a queued Run is just dropped', async () => {
  const x = await realSession('/bin/bash');
  try {
    const enclosing = await open(x.session, 'sh');
    declare(x.session, 'sh');
    const slow = x.session.admit({ target: 'shell', line: 'sleep 30; echo never', principal: AGENT });
    assert.ok(slow.admitted);
    await until(() => x.session.run(slow.run.runId).state === 'running', 3000);
    const c = await x.session.cancel(slow.run.runId, AGENT);
    assert.equal(c.state, 'cancelled', JSON.stringify(c));
    assert.ok(c.steps.includes('^C'));
    assert.equal((await x.run('echo after')).text, 'after');
    assert.equal(x.session.run(enclosing).state, 'running', 'the nested shell is untouched');
    const busy = x.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
    const q = x.session.admit({ target: 'shell', line: 'echo queued', principal: AGENT, queue: true });
    assert.ok(busy.admitted && q.admitted);
    assert.deepEqual((await x.session.cancel(q.run.runId, AGENT)).steps, ['removed from the queue']);
    assert.equal(x.session.run(q.run.runId).state, 'cancelled');
    assert.equal((await x.session.cancel(busy.run.runId, AGENT)).state, 'cancelled');
  } finally {
    await x.close();
  }
});

test('a program that is not a shell leaves a declared Run starting; cancel settles it and the declaration goes with the program', async () => {
  const x = await realSession('/bin/bash');
  try {
    const cat = await open(x.session, 'cat');
    declare(x.session, 'sh');
    const a = x.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
    assert.ok(a.admitted);
    const r = await x.session.awaitRun(a.run.runId, 800);
    assert.equal(r.state, 'starting', 'no start marker came back: the text was not run by a shell');
    const c = await x.session.cancel(a.run.runId, AGENT);
    assert.ok(c.state === 'cancelled' || c.state === 'lost', JSON.stringify(c));
    // The ^C ended cat (the enclosing Run), and with it the Run and the declaration made for it.
    await until(() => x.session.run(cat).state !== 'running', 3000);
    assert.equal(x.session.info().declared, undefined);
    assert.equal((await x.run('echo back')).text, 'back');
  } finally {
    await x.close();
  }
});

test('a second hop is declared again; `none` takes a declaration back; bad declarations are refused', async () => {
  const x = await realSession('/bin/bash');
  try {
    assert.throws(() => declare(x.session, 'none'), invalid(/no declared shell/));
    const outer = await open(x.session, 'sh');
    assert.throws(() => declare(x.session, 'csh'), invalid(/not a shell the daemon can type for/));
    assert.throws(() => declare(x.session, 'sh', 'r99-nope'), invalid(/not a shell Run/));
    declare(x.session, 'sh');
    // A shell opened from the declared shell is a running Run inside it: plain Runs are refused until it is declared too.
    const inner = x.session.admit({ target: 'shell', line: 'sh', principal: AGENT });
    assert.ok(inner.admitted);
    await until(() => x.session.run(inner.run.runId).state === 'running', 3000);
    const refused = x.session.admit({ target: 'shell', line: 'echo x', principal: AGENT });
    assert.ok(!refused.admitted && refused.reason === 'running' && refused.busy?.runId === inner.run.runId);
    assert.deepEqual(declare(x.session, 'sh'), { shell: 'sh', within: inner.run.runId, depth: 2 });
    const deep = await x.run('echo "deep=$$"');
    assert.deepEqual([deep.state, deep.exit, deep.within], ['exited', 0, inner.run.runId]);
    assert.equal((await x.run('exit 7')).state, 'lost');
    const r = await x.session.awaitRun(inner.run.runId, 3000);
    assert.deepEqual([r.state, r.exit], ['exited', 7], 'the inner shell’s status reaches the Run that opened it');
    assert.deepEqual(x.session.info().declared, { shell: 'sh', within: outer }, 'back to the outer declaration');
    assert.equal((await x.run('echo outer-again')).text, 'outer-again');
    // Taking the declaration back: the outer shell is in front but undeclared, so plain Runs are refused again.
    assert.deepEqual(declare(x.session, 'none'), { shell: null, within: null, depth: 0 });
    const again = x.session.admit({ target: 'shell', line: 'echo x', principal: AGENT });
    assert.ok(!again.admitted && again.reason === 'running' && again.busy?.runId === outer);
    assert.throws(() => declare(x.session, 'sh', inner.run.runId), invalid(/is exited/));
    declare(x.session, 'sh');
    assert.equal((await x.run('exit')).state, 'lost');
    await x.session.awaitRun(outer, 3000);
    assert.equal((await x.run('echo back')).text, 'back');
  } finally {
    await x.close();
  }
});

test('the job under a declared Run is killed: the Run settles, queued Runs are not typed into the shell that comes back', async () => {
  const x = await realSession('/bin/bash');
  try {
    const enclosing = await open(x.session, 'sh');
    declare(x.session, 'sh');
    const slow = x.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
    const queued = x.session.admit({ target: 'shell', line: 'echo QUEUED-LATER', principal: AGENT, queue: true });
    assert.ok(slow.admitted && queued.admitted);
    await until(() => x.session.run(slow.run.runId).state === 'running', 3000);
    x.session.signal('SIGKILL', AGENT); // the foreground process group: the sleep, under the nested sh
    await until(() => x.session.run(slow.run.runId).state !== 'running', 5000, 'the Run to settle');
    const done = x.session.run(slow.run.runId);
    assert.ok(done.state === 'exited' || done.state === 'lost', JSON.stringify(done));
    const q = await x.session.awaitRun(queued.run.runId, 5000);
    if (q.state === 'exited') assert.equal((await x.session.runTranscript(q.runId)).text, 'QUEUED-LATER');
    else assert.match(q.reason ?? '', /enclosing-run-ended/);
    assert.equal(x.session.run(enclosing).state, 'running', 'the nested shell survived its job');
    assert.equal((await x.run('exit')).state, 'lost');
    await x.session.awaitRun(enclosing, 3000);
    assert.equal((await x.run('echo back')).text, 'back');
    assert.ok(!x.journal.since(0).events.some((e) => e.type === 'output' && e.runId !== queued.run.runId && e.runId !== enclosing && e.data.includes('QUEUED-LATER')), 'nothing queued was typed into the session’s own shell');
  } finally {
    await x.close();
  }
});
