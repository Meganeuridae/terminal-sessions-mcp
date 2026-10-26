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
import { looksLikeShellOpener } from '../src/api/hints.js';
import { renderRun } from '../src/api/tools.js';
import type { RunResult } from '../src/api/app.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inlineProbe } from '../src/core/plumbing.js';
import { inlineLines } from '../src/core/session.js';
import { journalRunText } from '../src/core/segmenter.js';
import { AGENT, hasShell, realSession, scriptedSession, until, type Real } from './fake-shell.js';

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
const notes = (x: { journal: Real['journal'] }) => x.journal.since(0).events.filter((e) => e.type === 'note').map((e) => (e as { text: string }).text);
/** The start marker now names the shell's pid (so a cancel's probe answer is keyed to the shell): drop it to compare the shape. */
const stripStartPid = (s: string, nonce: string) => s.replace(new RegExp(`(<<<START:${nonce}):\\d+>>>`, 'g'), '$1>>>');
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

test('a declared shell is the way back from `unavailable`: exec into dash, declare, run there, leave', { skip: !hasShell('/bin/dash') || !hasShell('/bin/zsh') }, async () => {
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
    // Cancelling the inner command did not ask to leave its declared shell. Since cat
    // was not a shell, that interrupt also ended the opener; the changed destination needs acknowledgement.
    const refused = x.session.admit({ target: 'shell', line: 'echo back', principal: AGENT });
    assert.ok(!refused.admitted && refused.reason === 'declared-shell-ended');
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

/** A shell runs a script and gives its stdout, whatever its status. */
const runScript = (shell: string, script: string): string => {
  try {
    return execFileSync(shell, ['-c', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? '';
  }
};

test('a typed line prints its marker only where the shell holds exactly the text typed so far: text already at the prompt, or a piece missing or changed, prints the gone marker and runs nothing', () => {
  const n = 'abcd1234';
  const short = `printf '%s\\n' CONTROL; (exit 3)`;
  const long = `f() {\n${LINES}\n}\nf | wc -l`;
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(hasShell)) {
    const one = inlineLines(short, n, false);
    assert.equal(one.length, 1, shell);
    assert.equal(stripStartPid(runScript(shell, `${one[0]}\n`), n), `<<<START:${n}>>>\nCONTROL\n<<<EXIT:${n}:3>>>\n`, `${shell}: a clean prompt`);
    // Text someone had typed at the prompt swallows the assignment (the review's case): the
    // variable is unset or not the text, so the gone marker prints, no start, and nothing runs.
    for (const prefix of ['echo partial ', 'set -u\necho partial ']) {
      // (The prefix's own echo repeats the assignment's text; what matters is that no start or
      // end marker prints and the body's command never runs: CONTROL appears once, in that echo.)
      const out = runScript(shell, `${prefix}${one[0]!.trimStart()}\n`);
      assert.ok(!out.includes('<<<START') && !out.includes('<<<EXIT') && out.split('CONTROL').length === 2, `${shell}: nothing ran under a prefix: ${JSON.stringify(out)}`);
      assert.match(out, new RegExp(`<<<GONE:${n}>>>\\n$`), shell);
    }
    const many = inlineLines(long, n, false);
    assert.ok(many.length >= 3, `${shell}: ${many.length} lines`);
    for (const line of many) assert.ok(Buffer.byteLength(line) <= 900, `a line of ${Buffer.byteLength(line)} bytes`);
    const acks = Array.from({ length: many.length - 1 }, (_, i) => `<<<ACK:${n}:${i + 1}>>>\n`).join('');
    assert.equal(stripStartPid(runScript(shell, `${many.join('\n')}\n`), n).replace(/\n +120\n/, '\n120\n'), `${acks}<<<START:${n}>>>\n120\n<<<EXIT:${n}:0>>>\n`, `${shell}: pieces (wc pads its count on macOS)`);
    // A piece missing: every line after it finds the text short and prints the gone marker.
    const missing = runScript(shell, `${[many[0], ...many.slice(2)].join('\n')}\n`);
    assert.equal(missing, `<<<ACK:${n}:1>>>\n` + `<<<GONE:${n}>>>\n`.repeat(many.length - 2), `${shell}: a piece missing`);
    // A piece changed by text typed at the prompt between two pieces: the same, from that piece on.
    const changed = runScript(shell, `${[many[0], `echo partial ${many[1]!.trimStart()}`, ...many.slice(2)].join('\n')}\n`);
    assert.ok(!changed.includes('<<<START') && (changed.match(new RegExp(`<<<GONE:${n}>>>`, 'g')) ?? []).length === many.length - 1, `${shell}: a piece changed: ${JSON.stringify(changed.slice(-200))}`);
  }
  if (FISH) {
    const one = inlineLines(`printf '%s\\n' CONTROL; false`, n, true);
    assert.equal(stripStartPid(runScript(FISH, `${one[0]}\n`), n), `<<<START:${n}>>>\nCONTROL\n<<<EXIT:${n}:1>>>\n`, 'fish: a clean prompt');
    const out = runScript(FISH, `echo partial ${one[0]!.trimStart()}\n`);
    assert.ok(!out.includes('<<<START') && out.includes(`<<<GONE:${n}>>>`), `fish: a prefix: ${JSON.stringify(out)}`);
  }
});

test('the cancel probe answers with the token the Run’s line set: a shell that ran the line prints it, one that did not prints none', () => {
  const n = 'abcd1234';
  const shells = [...['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter(hasShell).map((s) => ({ shell: s, fish: false })), ...(FISH ? [{ shell: FISH, fish: true }] : [])];
  for (const { shell, fish } of shells) {
    const line = inlineLines(`true`, n, fish)[0]!;
    const own = runScript(shell, `${line}\n${inlineProbe(n, fish)}\n`);
    assert.match(own, new RegExp(`<<<EXIT:${n}:0>>>\n<<<PROBE:${n}:\\d+:${n}>>>\n$`), `${shell}: the shell the line ran in: ${JSON.stringify(own)}`);
    // A fresh shell that never ran the line has no such variable: an empty token, and (POSIX) nounset-safe.
    const other = runScript(shell, `${fish ? '' : 'set -u; '}${inlineProbe(n, fish).trimStart()}\n`);
    assert.match(other, new RegExp(`^<<<PROBE:${n}:\\d+:>>>\n$`), `${shell}: a shell that never saw the line: ${JSON.stringify(other)}`);
    // The variable is not exported: a shell the line's shell starts has none of it.
    const nested = runScript(shell, `${line}\n${shell} -c '${inlineProbe(n, fish).trimStart().replace(/'/g, `'\\''`)}'\n`);
    assert.match(nested, new RegExp(`<<<PROBE:${n}:\\d+:>>>\n$`), `${shell}: a nested shell: ${JSON.stringify(nested)}`);
    // A subshell keeps the shell's `$$` and the variable: the probe names the pid of the process that evaluates it,
    // the shell's in the shell and the subshell's own in a subshell (the house's review of a8b6f28..4860d4c, PR #22).
    // A command follows the subshell: zsh runs a `( … )` that ends a `-c` script in the shell's own process, with no
    // fork, and there the probe rightly names the shell (zsh 5.9, CI's and by run).
    if (!fish) {
      const sub = runScript(shell, `${line}\necho "shell=$$"\n${inlineProbe(n, fish)}\n( ${inlineProbe(n, fish).trimStart()} )\n:\n`);
      const m = new RegExp(`shell=(\\d+)\n<<<PROBE:${n}:(\\d+):${n}>>>\n<<<PROBE:${n}:(\\d+):${n}>>>\n$`).exec(sub);
      assert.ok(m, `${shell}: ${JSON.stringify(sub)}`);
      assert.equal(m[2], m[1], `${shell}: the shell names itself`);
      assert.notEqual(m[3], m[1], `${shell}: a subshell names its own pid, not the shell's`);
    }
  }
});

test('the cancel probe answers in bash’s restricted mode, with the shell’s own pid, where its child cannot start', { skip: !hasShell('/bin/bash') }, () => {
  // rbash refuses a command name with a slash and an output redirect: the probe printed `exec: restricted` and an empty pid,
  // so a cancel in a restricted declared shell could not end by the probe (the house's review of 4860d4c..bc4bc85, PR #22).
  const n = 'abcd1234';
  let out = '';
  try {
    out = execFileSync('/bin/bash', ['-r', '-c', `echo "shell=$$"\n${inlineProbe(n, false).trimStart()}\n`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
  }
  const m = new RegExp(`^shell=(\\d+)\n<<<PROBE:${n}:(\\d+):>>>\n$`).exec(out);
  assert.ok(m, JSON.stringify(out));
  assert.equal(m[2], m[1], 'the restricted shell names itself');
});

test('a cancel answered by a nested shell leaves the Run running; its result, live and from history, keeps what followed and none of the probes', { skip: !hasShell('/bin/sh') }, async () => {
  const x = await realSession('/bin/bash');
  try {
    const enclosing = await open(x.session, 'sh');
    declare(x.session, 'sh');
    // The nested shell's prompt is waited for in the output, not on a timer (the house's read of the 33
    // commits, #22 comment 6307351617, item 8); its text is split in the line so the echo never holds it.
    const nested = x.session.admit({ target: 'shell', line: "PS1='NEST''ED> ' sh", principal: AGENT });
    assert.ok(nested.admitted);
    const runId = nested.run.runId;
    const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' && e.runId === runId ? [e.data] : [])).join('');
    await until(() => x.session.run(runId).state === 'running', 5000, 'the nested sh to start');
    await until(() => output().includes('NESTED> '), 5000, 'the nested sh’s prompt');
    // ^C and ^\ reach the nested shell's prompt; both probes are answered by it, with its pid and no token.
    const c = await x.session.cancel(runId, AGENT, { graceMs: 400 });
    assert.equal(c.state, 'running', JSON.stringify(c));
    assert.ok(c.steps.includes('end-marker probe') && c.steps.includes('end-marker probe after ^\\'), c.steps.join(', '));
    assert.equal(c.escalation, `cancel ${enclosing}`);
    // A slow nested shell may answer after the cancel's grace: wait for the answers this test reads.
    await until(() => new RegExp(`<<<PROBE:[0-9a-f]+:\\d+:>>>`).test(output()), 5000, 'the journal holds the nested shell’s answers');
    await until(() => notes(x).some((t) => /answered by another shell/.test(t)), 5000, 'the session judged the answer');
    // The Run goes on in the nested shell: a typed line runs there, then it exits and the declared shell prints the end marker.
    x.session.input('echo after-probe-$((7*6))\n', { principal: AGENT });
    await until(() => output().includes('after-probe-42'), 5000, 'the typed line to run');
    x.session.input('exit\n', { principal: AGENT });
    const r = await x.session.awaitRun(runId, 5000);
    assert.deepEqual([r.state, r.exit], ['exited', 0]);
    const live = await x.session.runTranscript(runId);
    assert.match(live.text, /after-probe-42/);
    assert.doesNotMatch(live.text, /PROBE|printf/, `no probe plumbing in the live result: ${JSON.stringify(live.text)}`);
    assert.equal(live.truncated, false);
    const info = x.journal.runs.run(runId);
    assert.equal(info.strategy, 'inline');
    assert.ok(info.nonce, 'the nonce is journaled');
    const history = await journalRunText(x.journal.runs.output(x.journal, runId), {}, info);
    assert.match(history.text, /after-probe-42/);
    assert.doesNotMatch(history.text, /PROBE|printf/, `no probe plumbing from history: ${JSON.stringify(history.text)}`);
    assert.equal(x.session.run(enclosing).state, 'running', 'the declared shell is still there');
  } finally {
    await x.close();
  }
});

test('a nested shell that inherited the Run’s token answers the cancel on its own pid: the Run goes on, and history, cut by the pid run.start recorded, keeps what followed', { skip: !hasShell('/bin/sh') }, async () => {
  // The house's read of the 38 commits (#22, comment 6274773484): with `set -a` in the declared sh, the nested sh inherits
  // the token and answers the probe with it; the session rejected the answer by its pid, but history had no pid to judge
  // by and ended the result at the stranger's answer.
  const x = await realSession('/bin/bash');
  try {
    const enclosing = await open(x.session, 'sh');
    declare(x.session, 'sh');
    const exportAll = x.session.admit({ target: 'shell', line: 'set -a', principal: AGENT });
    assert.ok(exportAll.admitted);
    assert.equal((await x.session.awaitRun(exportAll.run.runId, 5000)).state, 'exited');
    const nested = x.session.admit({ target: 'shell', line: "PS1='NEST''ED> ' sh", principal: AGENT });
    assert.ok(nested.admitted);
    const runId = nested.run.runId;
    const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' && e.runId === runId ? [e.data] : [])).join('');
    await until(() => x.session.run(runId).state === 'running', 5000, 'the nested sh to start');
    const shellPid = x.journal.runs.run(runId).shellPid;
    assert.ok(shellPid !== undefined && shellPid > 0, 'run.start records the pid the start marker named');
    await until(() => output().includes('NESTED> '), 5000, 'the nested sh’s prompt'); // not a timer (item 8)
    const c = await x.session.cancel(runId, AGENT, { graceMs: 400 });
    assert.equal(c.state, 'running', JSON.stringify(c));
    const nonce = x.journal.runs.run(runId).nonce!;
    const answer = new RegExp(`<<<PROBE:${nonce}:(\\d+):${nonce}>>>`);
    await until(() => answer.test(output()), 5000, 'the nested shell’s answer'); // it may come after the cancel's grace
    const stranger = answer.exec(output());
    assert.ok(stranger && Number(stranger[1]) !== shellPid, `the nested shell answered with the token on its own pid: ${JSON.stringify(output())}`);
    x.session.input('echo after-probe-$((7*6))\n', { principal: AGENT });
    await until(() => output().includes('after-probe-42'), 5000, 'the typed line to run');
    x.session.input('exit\n', { principal: AGENT });
    const r = await x.session.awaitRun(runId, 5000);
    assert.deepEqual([r.state, r.exit], ['exited', 0]);
    assert.match((await x.session.runTranscript(runId)).text, /after-probe-42/, 'live');
    const history = await journalRunText(x.journal.runs.output(x.journal, runId), {}, x.journal.runs.run(runId));
    assert.match(history.text, /after-probe-42/, `history keeps what followed the stranger's answer: ${JSON.stringify(history.text)}`);
    assert.doesNotMatch(history.text, /PROBE|printf/);
    assert.equal(x.session.run(enclosing).state, 'running');
  } finally {
    await x.close();
  }
});

test('a declared shell preserves a half-typed prompt, refusing or queueing until it is cleared', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash');
  try {
    const enclosing = await open(x.session, 'bash --norc --noprofile');
    declare(x.session, 'bash');
    // A person began typing at the nested shell's prompt and never pressed Enter.
    x.session.input('echo partial ', { principal: AGENT });
    await until(() => x.journal.since(0).events.filter((e) => e.type === 'output' && e.runId === enclosing).map((e) => (e as { data: string }).data).join('').includes('echo partial'), 8000, 'the typed text echoed');
    const line = `printf '%s\\n' CLEAN; (exit 3)`;
    const refused = x.session.admit({ target: 'shell', line, principal: AGENT });
    assert.ok(!refused.admitted && refused.reason === 'human-editing');
    const queued = x.session.admit({ target: 'shell', line, principal: AGENT, queue: true });
    assert.ok(queued.admitted && queued.run.state === 'queued');
    x.session.input('\x15', { principal: AGENT });
    const r = await x.session.awaitRun(queued.run.runId, 8000);
    assert.deepEqual([r.state, r.exit, (await x.session.runTranscript(r.runId)).text.trim()], ['exited', 3, 'CLEAN'], 'the half-typed line did not change the command');
  } finally {
    await x.close();
  }
});

test('a gone marker from the declared shell ends the Run lost: line-not-whole, nothing more is typed for it, and the Run queued behind it gets its turn', async () => {
  const h = await scriptedSession();
  try {
    const typed: string[] = [];
    h.pty.onWrite((d) => typed.push(d));
    const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
    assert.ok(front.admitted);
    await until(() => h.session.run(front.run.runId).state === 'running');
    h.session.declareShell({ principal: AGENT });
    const one = h.session.admit({ target: 'shell', line: 'echo one', principal: AGENT });
    const two = h.session.admit({ target: 'shell', line: 'echo two', principal: AGENT, queue: true });
    assert.ok(one.admitted && two.admitted);
    await until(() => typed.some((t) => t.includes("__tsm_b='echo one'")), 3000, "the first Run's line");
    const line = typed.find((t) => t.includes("__tsm_b='echo one'"))!;
    assert.ok(line.startsWith('\x05\x15'), 'the line is preceded by ^E ^U, which clears a pending line wherever its cursor is');
    assert.match(line, /if \[ "\$\{__tsm_b\+set\}" = set \] && \[ "\$\{#__tsm_b\}" = "8" \]; then __tsm_r=[0-9a-f]+; printf '<<<STAR''T:/);
    const nonce = /<<<GON''E:([0-9a-f]+)>>>/.exec(line)![1]!;
    const before = typed.length;
    // The shell answers with the gone marker: the line reached it changed.
    h.pty.emit(`<<<GONE:${nonce}>>>\r\n`);
    await until(() => h.session.run(one.run.runId).state === 'lost', 3000, 'the Run ends lost');
    assert.equal(h.session.run(one.run.runId).reason, 'line-not-whole');
    assert.match(renderRun({ ...(h.session.run(one.run.runId) as unknown as RunResult), session: 's', output: { text: '', truncated: false, seq: [1, 2], nextCursor: 2 } }, 'transcript').text, /reached it changed or cut/);
    await until(() => typed.slice(before).some((t) => t.includes("__tsm_b='echo two'")), 3000, "the queued Run's line");
    assert.equal(typed.slice(before).filter((t) => t.includes("__tsm_b='echo one'")).length, 0, 'nothing more typed for the lost Run');
  } finally {
    await h.session.close();
  }
});

/** A declared shell in front, and a Run long enough to be typed in pieces, with a Run queued behind it; the first piece is typed. */
async function piecesUnderway() {
  const h = await scriptedSession();
  const typed: string[] = [];
  h.pty.onWrite((d) => typed.push(d));
  const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
  assert.ok(front.admitted);
  await until(() => h.session.run(front.run.runId).state === 'running');
  h.session.declareShell({ principal: AGENT });
  const long = h.session.admit({ target: 'shell', line: `: ${'x'.repeat(2600)}`, principal: AGENT });
  const next = h.session.admit({ target: 'shell', line: 'echo next', principal: AGENT, queue: true });
  assert.ok(long.admitted && next.admitted);
  await until(() => typed.some((t) => t.includes("__tsm_b='")), 3000, 'the first piece');
  const nonce = /<<<AC''K:([0-9a-f]+):1>>>/.exec(typed.find((t) => t.includes("__tsm_b='"))!)![1]!;
  return { h, typed, long: long.run.runId, next: next.run.runId, nonce };
}

test('a line typed between two pieces of a declared Run stops it: nothing more is typed for it, it ends lost (line-not-whole), and the Run queued behind it waits', async () => {
  const { h, typed, long, next, nonce } = await piecesUnderway();
  try {
    h.session.input('cat > notes\r', { principal: AGENT });
    const before = typed.length;
    h.pty.emit(`<<<ACK:${nonce}:1>>>\r\n`);
    await until(() => h.session.run(long).state === 'lost', 3000, 'the Run ends lost');
    assert.equal(h.session.run(long).reason, 'line-not-whole');
    assert.match(renderRun({ ...(h.session.run(long) as unknown as RunResult), session: 's', output: { text: '', truncated: false, seq: [1, 2], nextCursor: 2 } }, 'transcript').text, /a line was submitted between its pieces, so the command never ran/);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(typed.slice(before).filter((t) => t.includes('__tsm_b')), [], 'neither its next piece nor the queued Run was typed into the command that line started');
    assert.equal(h.session.run(next).state, 'queued');
  } finally {
    await h.session.close();
  }
});

test('keys typed between two pieces of a declared Run without a newline do not stop it: the next piece is typed', async () => {
  const { h, typed, long, nonce } = await piecesUnderway();
  try {
    h.session.input('cat', { principal: AGENT });
    const before = typed.length;
    h.pty.emit(`<<<ACK:${nonce}:1>>>\r\n`);
    await until(() => typed.slice(before).some((t) => t.includes('__tsm_b=${__tsm_b-}')), 3000, 'the next piece');
    assert.equal(h.session.run(long).state, 'starting');
  } finally {
    await h.session.close();
  }
});

test('in a declared bash, a command submitted while a Run is typed in pieces gets none of them: the Run ends lost, and a Run queued behind it waits until that command ends', { skip: !hasShell('/bin/bash') }, async () => {
  // A short stale period: the queued Run must wait on cat being in front, not on the period.
  const x = await realSession('/bin/bash', { editingStaleMs: 600 });
  try {
    await open(x.session, 'bash --norc --noprofile');
    declare(x.session, 'bash');
    // Each piece's assignment first sleeps 0.3 s, so a line can be submitted while a piece runs.
    assert.equal((await x.run(`trap '[[ $BASH_COMMAND == __tsm_b=* ]] && sleep 0.3' DEBUG`, 10000)).exit, 0);
    const file = path.join(x.tmp, 'notes');
    const before = x.journal.lastSeq;
    const output = () => x.journal.since(before).events.flatMap((e) => (e.type === 'output' ? [(e as { data: string }).data] : [])).join('');
    const long = x.session.admit({ target: 'shell', line: `: ${'x'.repeat(2600)}; echo RAN-$((40+2))`, principal: AGENT });
    assert.ok(long.admitted);
    await until(() => /<<<ACK:[0-9a-f]+:1>>>/.test(output()), 10000, 'the first piece acknowledged');
    x.session.input(`cat > ${file}\r`, { principal: AGENT });
    const queued = x.session.admit({ target: 'shell', line: 'echo QUEUED', principal: AGENT, queue: true });
    assert.ok(queued.admitted);
    const r = await x.session.awaitRun(long.run.runId, 10000);
    assert.deepEqual([r.state, r.reason], ['lost', 'line-not-whole']);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'cat received none of the Run');
    assert.equal(x.session.run(queued.run.runId).state, 'queued', 'the queued Run waits while cat holds the terminal');
    x.session.input('\x03', { principal: AGENT, kind: 'keys' });
    const q = await x.session.awaitRun(queued.run.runId, 10000);
    assert.deepEqual([q.state, q.exit, (await x.session.runTranscript(q.runId)).text.trim()], ['exited', 0, 'QUEUED']);
    assert.doesNotMatch(output(), /RAN-42/);
  } finally {
    await x.close();
  }
});

test('declared cancellation probes again after quit flushes an earlier probe', async () => {
  const h = await scriptedSession();
  const write = h.pty.write.bind(h.pty);
  try {
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    const admitted = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(admitted.admitted);
    const nonce = /<<<GON''E:([0-9a-f]+)>>>/.exec(h.pty.writes.at(-1)!)![1]!;
    h.pty.emit(`<<<START:${nonce}:900>>>\r\n`);
    let quit = false;
    h.pty.write = (data) => {
      if (data === '\x03') return; // this job ignores interrupt
      if (data === '\x1c') { quit = true; return; }
      if (data.includes(`<<<PRO''BE:${nonce}`)) {
        // Its first probe was flushed by quit; only one typed afterwards can answer, from the declared shell itself (pid 900, with the Run's token).
        if (quit) h.pty.emit(`<<<PROBE:${nonce}:900:${nonce}>>>\r\n`);
        return;
      }
      write(data);
    };
    const result = await h.session.cancel(admitted.run.runId, AGENT, { graceMs: 5 });
    assert.equal(result.state, 'cancelled');
    assert.ok(result.steps.includes('end-marker probe after ^\\'));
  } finally {
    h.pty.write = write;
    await h.session.close();
  }
});

test('an earlier cancelled command does not make a later declared-shell disconnect intentional', async () => {
  const x = await realSession('/bin/bash');
  try {
    const opener = await open(x.session, 'bash --noprofile --norc');
    declare(x.session, 'bash');
    const pid = Number((await x.run('echo $$')).text.trim());
    assert.ok(pid > 1 && pid !== x.session.pid);
    const slow = x.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(slow.admitted);
    await until(() => x.session.run(slow.run.runId).state === 'running');
    assert.equal((await x.session.cancel(slow.run.runId, AGENT)).state, 'cancelled');
    process.kill(pid, 'SIGKILL');
    await x.session.awaitRun(opener, 5000);
    assert.throws(() => declare(x.session, 'not-a-shell'), invalid(/not a shell/));
    const processRun = x.session.admit({ target: 'process', argv: ['/bin/true'], principal: AGENT });
    assert.ok(processRun.admitted);
    await x.session.awaitRun(processRun.run.runId, 5000);
    const refused = x.session.admit({ target: 'shell', line: 'echo wrong-machine', principal: AGENT });
    assert.ok(!refused.admitted && refused.reason === 'declared-shell-ended');
    assert.equal((await x.run('echo local-after-ack')).text, 'local-after-ack');
  } finally {
    await x.close();
  }
});

test('a declared shell that ends without its caller asking refuses the next shell Run once (fail closed); `exit` typed into it does not', async () => {
  const h = await scriptedSession();
  try {
    const typed: string[] = [];
    h.pty.onWrite((d) => typed.push(d));
    const open = async () => {
      const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
      assert.ok(front.admitted);
      await until(() => h.session.run(front.run.runId).state === 'running');
      h.session.declareShell({ principal: AGENT });
      return front.run.runId;
    };
    const notes = () => h.journal.since(0).events.filter((e) => e.type === 'note').map((e) => (e as { text: string }).text).join('\n');
    // The connection drops: ssh ends with 255 while a line is typed into the remote shell.
    const first = await open();
    const inFlight = h.session.admit({ target: 'shell', line: 'make deploy', principal: AGENT });
    assert.ok(inFlight.admitted);
    await until(() => typed.some((t) => t.includes("__tsm_b='make deploy'")), 3000, 'the line typed into the declared shell');
    h.shell.finishHung(255);
    await until(() => h.session.run(first).state === 'exited', 3000, 'the opener ended');
    assert.deepEqual([h.session.run(inFlight.run.runId).state, h.session.run(inFlight.run.runId).reason], ['lost', `enclosing-run-ended: ${first} exited`]);
    assert.equal(h.session.info().declared, undefined);
    const refused = h.session.admit({ target: 'shell', line: 'make deploy', principal: AGENT, queue: true });
    assert.ok(!refused.admitted);
    assert.equal(refused.reason, 'declared-shell-ended');
    assert.equal(refused.busy?.runId, first, 'the refusal names the Run whose shell ended');
    assert.match(notes(), /without its caller asking: the next shell Run is refused once/);
    const again = await h.session.admitWhenAvailable({ target: 'shell', line: 'echo hello', principal: AGENT });
    assert.ok(again.admitted, `the Run after the refusal goes to the session's own shell: ${JSON.stringify(again)}`);
    assert.equal((await h.session.awaitRun(again.run.runId, 3000)).exit, 0);
    await h.session.waitAvailable(2000);
    // The caller leaves the remote shell itself: nothing is refused.
    const second = await open();
    const leave = h.session.admit({ target: 'shell', line: 'exit', principal: AGENT });
    assert.ok(leave.admitted);
    await until(() => typed.some((t) => t.includes("__tsm_b='exit'")), 3000, 'exit typed into the declared shell');
    const exitLine = typed.find((t) => t.includes("__tsm_b='exit'"))!;
    const exitNonce = /<<<STAR''T:([0-9a-f]+):/.exec(exitLine)![1]!;
    h.pty.emit(`<<<START:${exitNonce}:900>>>\r\n`);
    h.shell.finishHung(0);
    await until(() => h.session.run(second).state === 'exited', 3000, 'the opener ended');
    assert.doesNotMatch(notes().split('\n').at(-1) ?? '', /refused/, 'the note after the caller’s own exit');
    const local = await h.session.admitWhenAvailable({ target: 'shell', line: 'echo hello', principal: AGENT });
    assert.ok(local.admitted, `after the caller's own exit the next Run is admitted: ${JSON.stringify(local)}`);
    assert.equal((await h.session.awaitRun(local.run.runId, 3000)).exit, 0);
  } finally {
    await h.session.close();
  }
});

test('a Run queued for the session’s own shell before a declaration runs when the declared shell ends unexpectedly; only the next new Run is refused once', async () => {
  const h = await scriptedSession();
  try {
    const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
    assert.ok(front.admitted);
    await until(() => h.session.run(front.run.runId).state === 'running');
    // Admitted while the opener ran, before any declaration: this Run is for the session's own shell.
    const own = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
    assert.ok(own.admitted && own.run.state === 'queued');
    h.session.declareShell({ principal: AGENT });
    h.shell.finishHung(255);
    const ran = await h.session.awaitRun(own.run.runId, 3000);
    assert.deepEqual([ran.state, ran.exit], ['exited', 0], 'the fail-closed hold has nothing to protect in a Run admitted before the declaration');
    const refused = h.session.admit({ target: 'shell', line: 'echo next', principal: AGENT });
    assert.ok(!refused.admitted && refused.reason === 'declared-shell-ended');
  } finally {
    await h.session.close();
  }
});

test('at a shell declared through a client that holds the foreground (ssh), a submitted line holds the next Run until it goes stale, not after 200 ms', async () => {
  // Through ssh the client's group holds the terminal for the whole remote session, so the group
  // learned at the declaration never gives way: the shell's own group is never seen to come back,
  // and the hold must not end on that alone (the house's read of a6d0c35, #22). The hung opener
  // models it: the terminal's foreground stays its group throughout.
  const h = await scriptedSession({ editingStaleMs: 700 });
  try {
    const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
    assert.ok(front.admitted);
    await until(() => h.session.run(front.run.runId).state === 'running');
    h.session.declareShell({ principal: AGENT });
    h.session.input('make deploy\n', { principal: AGENT });
    const held = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!held.admitted && held.reason === 'human-submitted', JSON.stringify(held));
    await new Promise((r) => setTimeout(r, 350)); // past the 200 ms foreground-settle window
    const still = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!still.admitted && still.reason === 'human-submitted', `held past 200 ms with no evidence the command ended: ${JSON.stringify(still)}`);
    await new Promise((r) => setTimeout(r, 450)); // now past the stale period
    const after = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(after.admitted, `admitted once stale, with no evidence either way: ${JSON.stringify(after)}`);
  } finally {
    await h.session.close();
  }
});

test('a fresh declaration at the same context starts with nothing proven: the foreground it had proven does not carry over', async () => {
  // A local sh proven to run here (a job came and went) reads its own group in front as `free`, so a
  // submitted line's hold ends after the 200 ms settle. Redeclaring the same context (e.g. the program
  // became `ssh host`) must forget that: a remote shell whose client holds the foreground throughout
  // would otherwise read as free whenever its own group is in front, and the hold would end early,
  // typing the queued Run into the person's program (the house's read, #22 comment 6269901528).
  const h = await scriptedSession();
  try {
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    const own = h.pty.foregroundPgid!; // the group in front while the declared shell is at its prompt, as the declaration recorded it
    // Prove it: a job runs in front (a different group), then ends back to the shell's own group.
    h.pty.foregroundPgid = own + 1000;
    h.session.input('do-local-thing\n', { principal: AGENT });
    const busy = h.session.admit({ target: 'shell', line: 'x', principal: AGENT });
    assert.ok(!busy.admitted && busy.reason === 'human-submitted', `busy while the job runs: ${JSON.stringify(busy)}`);
    h.pty.foregroundPgid = own; // the job ended
    await new Promise((r) => setTimeout(r, 150)); // the 100 ms foreground cache expires
    h.session.input('another-local\n', { principal: AGENT });
    await new Promise((r) => setTimeout(r, 350)); // past the 200 ms settle: `free` ends the hold
    const free = h.session.admit({ target: 'shell', line: 'echo f', principal: AGENT });
    assert.ok(free.admitted, `proven + own group in front reads free, so the hold ended: ${JSON.stringify(free)}`);
    // Finish that declared Run so it no longer occupies the shell; its end keeps `proven`.
    const fn = /<<<STAR''T:([0-9a-f]+):/.exec(h.pty.writes.at(-1)!)![1]!;
    h.pty.emit(`<<<START:${fn}:${own}>>>\r\n<<<EXIT:${fn}:0>>>\r\n`);
    await until(() => h.session.run(free.run.runId).state === 'exited', 2000, 'the free Run finished');
    // Redeclare the same context: proven is forgotten.
    declare(h.session, 'sh', opener);
    h.pty.foregroundPgid = own;
    h.session.input('remote-thing\n', { principal: AGENT });
    await new Promise((r) => setTimeout(r, 350)); // past the settle, but nothing is proven now
    const held = h.session.admit({ target: 'shell', line: 'x', principal: AGENT });
    assert.ok(!held.admitted && held.reason === 'human-submitted', `after redeclaration the own group is not proof of free: ${JSON.stringify(held)}`);
  } finally {
    await h.session.close();
  }
});

test('at a shell declared through ssh, a submitted line holds the next Run while its program prints: the stale period is one of quiet, counted from the last output', async () => {
  // The person's line printed a tick every second and read stdin; counted from the submission,
  // the hold ended at +31 s and a Run's wrapper was typed into that program (the house's read of
  // 07ab3dd, #22). §8.1 and the README say the hold ends after the stale period of quiet.
  const h = await scriptedSession({ editingStaleMs: 500 });
  try {
    const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
    assert.ok(front.admitted);
    await until(() => h.session.run(front.run.runId).state === 'running');
    h.session.declareShell({ principal: AGENT });
    h.session.input('./ticker\n', { principal: AGENT });
    const held = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!held.admitted && held.reason === 'human-submitted', JSON.stringify(held));
    const queued = h.session.admit({ target: 'shell', line: 'echo queued', principal: AGENT, queue: true });
    assert.ok(queued.admitted && queued.run.state === 'queued', JSON.stringify(queued));
    // The program prints for 900 ms: well past a 500 ms stale period counted from the submission.
    const ticker = setInterval(() => h.pty.emit('tick\r\n'), 150);
    await new Promise((r) => setTimeout(r, 900));
    clearInterval(ticker);
    const still = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!still.admitted && still.reason === 'human-submitted', `held while the program prints: ${JSON.stringify(still)}`);
    assert.equal(h.session.run(queued.run.runId).state, 'queued', 'the queued Run waited too');
    await new Promise((r) => setTimeout(r, 750)); // a stale period of quiet, with no call to look again: the re-armed timer drains
    assert.notEqual(h.session.run(queued.run.runId).state, 'queued', 'the queued Run got its turn once the quiet ran out');
    const after = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!after.admitted && after.reason === 'running', `the hold is over; the queued Run has the declared shell now: ${JSON.stringify(after)}`);
  } finally {
    await h.session.close();
  }
});

test('a cancel probe answered with the declared shell’s own pid but another Run’s token is rejected by the token check', async () => {
  // The only answer the token check alone rejects: the declared shell's pid (which the pid check
  // accepts) carrying a token that is not this Run's. A shell in another PID namespace with the same
  // pid, set up to print some other Run's token, must not end this Run (the house's read, #22 comment
  // 6269901528: without the token check the pid alone accepted it).
  const h = await scriptedSession();
  const write = h.pty.write.bind(h.pty);
  try {
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    const admitted = h.session.admit({ target: 'shell', line: 'echo hi', principal: AGENT });
    assert.ok(admitted.admitted);
    const nonce = /<<<STAR''T:([0-9a-f]+):/.exec(h.pty.writes.at(-1)!)![1]!;
    h.pty.emit(`<<<START:${nonce}:1000>>>\r\n`);
    await until(() => h.session.run(admitted.run.runId).state === 'running', 2000);
    h.pty.write = (data) => {
      if (data === '\x03' || data === '\x1c') return;
      if (data.includes(`<<<PRO''BE:${nonce}`)) {
        h.pty.emit(`<<<PROBE:${nonce}:1000:deadbeefdeadbeef>>>\r\n`); // the declared shell's pid, another Run's token
        return;
      }
      write(data);
    };
    const result = await h.session.cancel(admitted.run.runId, AGENT, { graceMs: 5 });
    assert.equal(result.state, 'running', 'the foreign-token answer did not end the Run');
    const rejected = notes(h).filter((n) => /answered by another shell/.test(n));
    assert.equal(rejected.length, 1, 'the answer was rejected');
    assert.match(rejected[0]!, /pid 1000 like the declared shell's, but with another Run's token/);
  } finally {
    h.pty.write = write;
    await h.session.close();
  }
});

test('a cancel is answered only by the shell the Run was typed into: a nested shell’s probe answer does not end it, and a later natural end reads as itself', async () => {
  const h = await scriptedSession();
  const write = h.pty.write.bind(h.pty);
  try {
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    const admitted = h.session.admit({ target: 'shell', line: 'bash', principal: AGENT });
    assert.ok(admitted.admitted);
    const nonce = /<<<STAR''T:([0-9a-f]+):/.exec(h.pty.writes.at(-1)!)![1]!;
    // The declared shell (pid 1000) printed the start marker; a nested bash it started is in front of it now.
    h.pty.emit(`<<<START:${nonce}:1000>>>\r\n`);
    await until(() => h.session.run(admitted.run.runId).state === 'running', 2000);
    let probes = 0;
    h.pty.write = (data) => {
      if (data === '\x03' || data === '\x1c') return; // the nested bash at its own prompt ignores them
      if (data.includes(`<<<PRO''BE:${nonce}`)) {
        probes++;
        // The first probe is answered by the nested bash with the declared shell's own pid but no
        // token: pid alone would have accepted it (the old bug), the missing variable the Run's
        // line set rejects it (a shell in another PID namespace). A later probe (after ^\) goes
        // unanswered, as the nested bash at its own prompt would leave it.
        if (probes === 1) h.pty.emit(`<<<PROBE:${nonce}:2000:>>>\r\n`); // a nested shell: its own pid, no token
        return;
      }
      write(data);
    };
    const result = await h.session.cancel(admitted.run.runId, AGENT, { graceMs: 5 });
    assert.equal(result.state, 'running', 'the nested shell’s probe answer did not end the Run');
    assert.ok(probes >= 1, 'a probe was typed');
    assert.equal(result.escalation, `cancel ${opener}`, 'cancel names the enclosing Run as the next thing to cancel');
    const rejected = notes(h).filter((n) => /answered by another shell/.test(n));
    assert.equal(rejected.length, 1, 'the answered probe was rejected');
    assert.match(rejected[0]!, /pid 2000; the declared shell's is 1000/);
    // The nested bash exits and the declared shell prints the Run's own end marker: reported as itself (core-14).
    h.pty.write = write;
    h.pty.emit(`<<<EXIT:${nonce}:42>>>\r\n`);
    await until(() => h.session.run(admitted.run.runId).state !== 'running', 2000);
    assert.deepEqual([h.session.run(admitted.run.runId).state, h.session.run(admitted.run.runId).exit], ['exited', 42]);
  } finally {
    h.pty.write = write;
    await h.session.close();
  }
});

test('redeclaring the outer shell ends the inner layer’s Runs, in flight and queued', async () => {
  const h = await scriptedSession();
  try {
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    // A nested shell, declared in turn (a second hop).
    const innerOpen = h.session.admit({ target: 'shell', line: 'bash', principal: AGENT });
    assert.ok(innerOpen.admitted);
    const n1 = /<<<STAR''T:([0-9a-f]+):/.exec(h.pty.writes.at(-1)!)![1]!;
    h.pty.emit(`<<<START:${n1}:1000>>>\r\n`);
    await until(() => h.session.run(innerOpen.run.runId).state === 'running', 2000);
    declare(h.session, 'sh', innerOpen.run.runId);
    // A Run running in the inner shell, and one queued behind it.
    const deep = h.session.admit({ target: 'shell', line: 'sleep 50', principal: AGENT });
    assert.ok(deep.admitted);
    const n2 = /<<<STAR''T:([0-9a-f]+):/.exec(h.pty.writes.at(-1)!)![1]!;
    h.pty.emit(`<<<START:${n2}:2000>>>\r\n`);
    await until(() => h.session.run(deep.run.runId).state === 'running', 2000);
    const queued = h.session.admit({ target: 'shell', line: 'echo inner-queued', principal: AGENT, queue: true });
    assert.ok(queued.admitted && queued.run.state === 'queued');
    // Redeclaring the program the outer layer is on: the inner layer and its Runs go with the old word.
    declare(h.session, 'sh', opener);
    assert.equal(h.session.run(deep.run.runId).state, 'lost', 'the inner shell’s in-flight Run ended');
    assert.equal(h.session.run(deep.run.runId).reason, 'undeclared');
    assert.equal(h.session.run(queued.run.runId).state, 'lost', 'the inner shell’s queued Run ended');
    assert.match(h.session.run(queued.run.runId).reason ?? '', /undeclared/);
    assert.deepEqual(h.session.info().declared, { shell: 'sh', within: opener }, 'back to the outer declaration');
    assert.equal(h.session.run(innerOpen.run.runId).state, 'running', 'the nested bash itself is untouched');
    assert.ok(notes(h).some((t) => /inside .* goes with the new declaration/.test(t)));
  } finally {
    await h.session.close();
  }
});

test('each piece of a multi-piece inline Run is cleared before it is typed, so keys typed between pieces do not join the next one', async () => {
  const h = await scriptedSession();
  try {
    const typed: string[] = [];
    h.pty.onWrite((d) => typed.push(d));
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    const body = Array.from({ length: 120 }, (_, i) => `echo line-${i}-${'x'.repeat(40)}`).join('\n');
    const a = h.session.admit({ target: 'shell', line: body, principal: AGENT });
    assert.ok(a.admitted);
    await until(() => typed.some((t) => /<<<GON''E:[0-9a-f]+>>>/.test(t)), 2000, "the first piece");
    const nonce = /<<<GON''E:([0-9a-f]+)>>>/.exec(typed.find((t) => /<<<GON''E:[0-9a-f]+>>>/.test(t))!)![1]!;
    assert.ok(typed.at(-1)!.startsWith('\x05\x15'), 'the first piece is preceded by the clear keys');
    const before = typed.length;
    h.pty.emit(`<<<ACK:${nonce}:1>>>\r\n`);
    await until(() => typed.length > before, 2000, 'the next piece');
    assert.ok(typed.slice(before).some((t) => t.startsWith('\x05\x15')), 'the next piece is cleared before it is typed');
  } finally {
    await h.session.close();
  }
});

test('spending the one-shot fail-closed refusal restarts a declared queue the refusal had held', async () => {
  // A Run queued for a surviving outer layer is held while declaredEnded stands (drainDeclared returns
  // early then); spending the refusal did not restart it (the house's read of a6d0c35, #22).
  const h = await scriptedSession();
  try {
    const typed: string[] = [];
    h.pty.onWrite((d) => typed.push(d));
    const opener = await open(h.session, 'sleep 100');
    declare(h.session, 'sh', opener);
    const run1 = h.session.admit({ target: 'shell', line: 'sleep 50', principal: AGENT });
    assert.ok(run1.admitted);
    const n1 = /<<<STAR''T:([0-9a-f]+):/.exec(h.pty.writes.at(-1)!)![1]!;
    h.pty.emit(`<<<START:${n1}:1000>>>\r\n`);
    await until(() => h.session.run(run1.run.runId).state === 'running', 2000);
    // A Run queued behind it, for this same (outer) declared shell.
    const held = h.session.admit({ target: 'shell', line: 'echo later-A', principal: AGENT, queue: true });
    assert.ok(held.admitted && held.run.state === 'queued');
    // A second hop is declared on run1; run1 then ends by itself (an end the caller did not ask for),
    // so that inner layer fails closed while the outer layer and its queued Run survive.
    declare(h.session, 'sh', run1.run.runId);
    h.pty.emit(`<<<EXIT:${n1}:0>>>\r\n`);
    await until(() => h.session.run(run1.run.runId).state !== 'running', 2000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.session.run(held.run.runId).state, 'queued', 'held while the fail-closed refusal stands');
    const before = typed.length;
    const refused = h.session.admit({ target: 'shell', line: 'echo new', principal: AGENT });
    assert.ok(!refused.admitted && refused.reason === 'declared-shell-ended');
    await until(() => h.session.run(held.run.runId).state !== 'queued', 2000, 'the held Run launched');
    assert.ok(typed.slice(before).some((t) => t.includes("__tsm_b='echo later-A'")), 'the held Run was finally typed');
  } finally {
    await h.session.close();
  }
});

test('a line submitted at a declared prompt holds the next Run as human-submitted (not human-editing); a ^U does not end that hold; going stale does', async () => {
  const h = await scriptedSession({ editingStaleMs: 400 });
  try {
    const front = h.session.admit({ target: 'shell', line: 'sleep 100', principal: AGENT });
    assert.ok(front.admitted);
    await until(() => h.session.run(front.run.runId).state === 'running');
    h.session.declareShell({ principal: AGENT });
    h.session.input('make deploy\n', { principal: AGENT });
    const held = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!held.admitted && held.reason === 'human-submitted', JSON.stringify(held));
    h.session.input('\x15', { principal: AGENT });
    const still = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(!still.admitted && still.reason === 'human-submitted', 'a ^U says nothing about a command already submitted');
    await new Promise((r) => setTimeout(r, 450));
    const after = h.session.admit({ target: 'shell', line: 'echo agent', principal: AGENT });
    assert.ok(after.admitted, `stale, with no evidence either way: ${JSON.stringify(after)}`);
  } finally {
    await h.session.close();
  }
});

test('a stale partial line is cleared whole, wherever its cursor was left', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { editingStaleMs: 300 });
  try {
    const enclosing = await open(x.session, 'bash --norc --noprofile');
    declare(x.session, 'bash');
    // Typed, then the cursor moved four places back; left to go stale. ^U alone would keep "+3))".
    x.session.input('echo partial $((1+3))', { principal: AGENT });
    await until(() => x.journal.since(0).events.filter((e) => e.type === 'output' && e.runId === enclosing).map((e) => (e as { data: string }).data).join('').includes('echo partial'), 8000, 'the typed text echoed');
    x.session.input('\x1b[D\x1b[D\x1b[D\x1b[D', { principal: AGENT, kind: 'keys' });
    await new Promise((r) => setTimeout(r, 350));
    const r = await x.run(`printf '%s\\n' CLEAN; (exit 3)`, 8000);
    assert.deepEqual([r.state, r.exit, r.text.trim()], ['exited', 3, 'CLEAN']);
    assert.ok(notes(x).some((t) => /stale partial line/.test(t)));
  } finally {
    await x.close();
  }
});

test('where the declared shell runs on this terminal, a submitted line’s hold ends when the person’s command ends, and lasts while their program is in front', { skip: !hasShell('/bin/bash') }, async () => {
  // The default stale period (30 s) stands: the evidence must be what ends the hold.
  const x = await realSession('/bin/bash');
  try {
    await open(x.session, 'bash --norc --noprofile');
    declare(x.session, 'bash');
    assert.equal((await x.run('echo ready')).text.trim(), 'ready');
    const t0 = Date.now();
    x.session.input('sleep 1.2\n', { principal: AGENT });
    await new Promise((r) => setTimeout(r, 100));
    const held = x.session.admit({ target: 'shell', line: `printf '%s\\n' CLEAN; (exit 3)`, principal: AGENT });
    assert.ok(!held.admitted && held.reason === 'human-submitted', JSON.stringify(held));
    const queued = x.session.admit({ target: 'shell', line: `printf '%s\\n' CLEAN; (exit 3)`, principal: AGENT, queue: true });
    assert.ok(queued.admitted);
    const r = await x.session.awaitRun(queued.run.runId, 8000);
    assert.deepEqual([r.state, r.exit, (await x.session.runTranscript(r.runId)).text.trim()], ['exited', 3, 'CLEAN']);
    assert.ok(Date.now() - t0 < 5000, `the hold ended with the sleep, not after 30 s: ${Date.now() - t0} ms`);
  } finally {
    await x.close();
  }
  const y = await realSession('/bin/bash', { editingStaleMs: 600 });
  try {
    await open(y.session, 'bash --norc --noprofile');
    declare(y.session, 'bash');
    assert.equal((await y.run('echo ready')).text.trim(), 'ready');
    // A program that reads the terminal, in front past the stale period: the Run waits for it.
    y.session.input('cat\n', { principal: AGENT });
    await new Promise((r) => setTimeout(r, 100));
    const queued = y.session.admit({ target: 'shell', line: `printf '%s\\n' CLEAN; (exit 3)`, principal: AGENT, queue: true });
    assert.ok(queued.admitted);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(y.session.run(queued.run.runId).state, 'queued', 'not typed into cat, stale or not');
    y.session.input('\x03', { principal: AGENT, kind: 'keys' });
    const r = await y.session.awaitRun(queued.run.runId, 8000);
    assert.deepEqual([r.state, r.exit, (await y.session.runTranscript(r.runId)).text.trim()], ['exited', 3, 'CLEAN']);
  } finally {
    await y.close();
  }
});

test('the note a declaration leaves shortens the line that opened the shell without splitting a surrogate pair', async () => {
  const x = await realSession('/bin/bash');
  try {
    const head = `sh #${'x'.repeat(55)}`;
    const enclosing = await open(x.session, `${head}\u{1F600} tail`);
    declare(x.session, 'sh');
    const note = notes(x).find((n) => n.startsWith(`declared: ${enclosing}`));
    assert.equal(note, `declared: ${enclosing} (${head}) is a sh shell; shell Runs go to it until ${enclosing} ends`);
  } finally {
    await x.close();
  }
});
