/**
 * Core rules added by the review fixes, against the scripted backend: Runs that
 * never start, authenticated marks, the temp-file route, cancel steps and scope,
 * human editing that never wedges, environment hygiene, the seat across
 * reconnects, G28 await tracking, close. Each test names the rule or finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScriptedProcess } from '../src/backends/scripted.js';
import { configuredEnv, redactSnapshot } from '../src/core/env.js';
import { CLEAR_LINE_KEYS } from '../src/core/marks.js';
import { AGENT, code, HUMAN, OSC, ofType, scriptedSession as harness, tick } from './fake-shell.js';


test('G3/G4 (core-1, tg-3, api-8): a prompt that follows our line without a pre-execution mark ends the Run lost; the session is not wedged', async () => {
  const h = await harness({ setup: (s) => s.on('# a comment', () => ({ noPreexec: true })) });
  const a = h.session.admit({ target: 'shell', line: '# a comment', principal: AGENT });
  assert.ok(a.admitted);
  const r = h.session.run(a.run.runId);
  assert.equal(r.state, 'lost');
  assert.equal(r.reason, 'no-pre-execution-mark');
  assert.equal(r.exit, undefined, 'never an invented exit');
  assert.ok(h.session.shellAvailable().ok, 'the prompt confirmed availability');
  const next = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(next.admitted);
  assert.equal((await h.session.awaitRun(next.run.runId, 1000)).state, 'exited');
  await h.session.close();
});

test('G6 (core-2, shell-4, tg-14): every daemon line is typed as ` . \'<file>\'`, never as its own text', async () => {
  const line = "printf '[%s]\\n' 'a\tb' && echo \"Done!\" # x";
  const h = await harness({ setup: (s) => s.on(line, () => ({ output: '[a\tb]\r\nDone!\r\n', exit: 0 })) });
  const a = h.session.admit({ target: 'shell', line, principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.line, line, 'the Run records the requested text');
  assert.equal(h.shell.typed.length, 1);
  assert.match(h.shell.typed[0]!, /^ \. '[^\t!]*tsm-cmd-[^\t!]*'$/, 'only the source line reached the line editor');
  assert.deepEqual(h.shell.executed, [line]);
  await h.session.close();
});

test('G1/G2 (core-3, emu-6, shell-3): unkeyed or wrongly keyed marks and OSC 7 in output neither end a Run nor move the cwd', async () => {
  const forged =
    OSC('133;D;0') + OSC('133;A') + OSC('7;file://remote/srv/app') + OSC('633;P;Cwd=/srv/app') + OSC('133;D;0;k=not-the-key') + OSC('133;C') + OSC('633;E;rm -rf /');
  const h = await harness({ setup: (s) => s.on('cat rec.log', () => ({ output: `recorded ${forged}\r\n`, hang: true })) });
  const a = h.session.admit({ target: 'shell', line: 'cat rec.log', principal: AGENT });
  assert.ok(a.admitted);
  await tick();
  assert.equal(h.session.run(a.run.runId).state, 'running', 'the job is still running');
  assert.equal(h.session.cwd, '/home/t', 'the cwd did not move');
  assert.equal(h.session.listRuns().length, 1, 'no phantom Run');
  const busy = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(!busy.admitted, 'nothing is typed into the running job');
  // The bytes are kept faithfully in the raw output (G10).
  assert.ok(h.session.runOutput(a.run.runId).events.some((e) => e.type === 'output' && e.data.includes('133;D;0')));
  h.shell.finishHung(3);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 3, 'the exit is the one the shell observed');
  await h.session.close();
});

test('G1 (tg-2, shell-2): a C mark never replaces a running Run', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 5', principal: AGENT });
  assert.ok(a.admitted);
  // A keyed C while the Run runs (e.g. a bind -x widget on bash 3.2) is noted, not a new Run.
  h.pty.emit(h.shell.mark('633;E;widget') + h.shell.mark('133;C'));
  assert.equal(h.session.listRuns().length, 1);
  assert.ok(h.journal.since(0).events.some((e) => e.type === 'note' && /pre-execution mark while/.test(e.text)));
  h.shell.finishHung(0);
  assert.equal((await h.session.awaitRun(a.run.runId, 1000)).state, 'exited');
  await h.session.close();
});

test('G1/G12 (core-10): a C whose 633;E line is not ours is somebody else\'s Run; ours waits for its own', async () => {
  const h = await harness({ typeahead: true, setup: (s) => s.on('echo typed-ahead', () => ({ output: 'typed-ahead\r\n', exit: 1 })).on('echo queued-line', () => ({ output: 'queued\r\n', exit: 0 })) });
  const first = h.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(first.admitted);
  h.session.input('echo typed-ahead\n', { principal: AGENT }); // typeahead, read after sleep ends
  const queued = h.session.admit({ target: 'shell', line: 'echo queued-line', principal: AGENT, queue: true });
  assert.ok(queued.admitted);
  h.shell.finishHung(0);
  const q = await h.session.awaitRun(queued.run.runId, 1000);
  assert.equal(q.state, 'exited');
  assert.equal(q.exit, 0, 'the queued Run got its own exit, not the typeahead\'s');
  assert.equal((await h.session.runTranscript(q.runId)).text, 'queued');
  const other = h.session.listRuns().find((r) => r.line === 'echo typed-ahead');
  assert.ok(other, 'the typeahead became a Run of its own');
  assert.equal(other.principal, AGENT, 'attributed to whoever typed it (input while busy counts)');
  assert.equal(other.origin, 'agent');
  assert.equal(other.exit, 1);
  assert.ok(!h.session.listRuns().some((r) => r.principal === 'human'), 'no bare "human" principal');
  await h.session.close();
});

test('G1, ss-8 (orphan lines): a line read after its Run was declared lost sources a removed file — the command never runs unawaited', async () => {
  const h = await harness({ typeahead: true, setup: (s) => s.on('echo late', () => ({ output: 'late\r\n', exit: 0 })) });
  const first = h.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(first.admitted);
  h.session.input('\n', { principal: AGENT }); // an empty line typed ahead
  const queued = h.session.admit({ target: 'shell', line: 'echo late', principal: AGENT, queue: true });
  assert.ok(queued.admitted);
  h.shell.finishHung(0);
  await tick();
  const q = h.session.run(queued.run.runId);
  assert.equal(q.state, 'lost', 'the empty line\'s prompt came first: no C for ours');
  assert.equal(q.reason, 'no-pre-execution-mark');
  assert.ok(!h.shell.executed.includes('echo late'), 'the command never ran: its file was removed before the Run was declared lost');
  const late = h.session.listRuns().find((r) => r.runId !== q.runId && r.runId !== first.run.runId);
  assert.ok(late, 'the late read of the line is a Run of its own');
  assert.equal(late.principal, AGENT, 'attributed to the lost Run\'s principal');
  assert.match(late.line ?? '', /tsm-cmd-/, 'what ran is the plumbing line, not the command');
  assert.ok(h.journal.since(0).events.some((e) => e.type === 'note' && e.text.includes(q.runId) && /did not run/.test(e.text)));
  await h.session.close();
});

test('G29 (core-4, tg-6): cancelling a queued Run removes it and leaves the terminal alone', async () => {
  const h = await harness();
  const first = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  const queued = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
  assert.ok(first.admitted && queued.admitted);
  const writes = h.pty.written;
  const c = await h.session.cancel(queued.run.runId, AGENT, { graceMs: 20 });
  assert.equal(c.state, 'cancelled');
  assert.deepEqual(c.steps, ['removed from the queue']);
  assert.equal(h.pty.written, writes, 'no ^C: the Run ahead is untouched');
  assert.equal(h.session.run(first.run.runId).state, 'running');
  h.shell.finishHung(0);
  await tick();
  assert.deepEqual(h.shell.executed, ['sleep 10'], 'the cancelled line never ran');
  assert.equal(h.session.run(queued.run.runId).exit, undefined);
  assert.equal(ofType(h.journal.since(0).events, 'signal').length, 0);
  await h.session.close();
});

test('G29 (core-1): cancelling a Run the shell has not started yet (^C discards the line) ends it cancelled at the prompt', async () => {
  const h = await harness();
  h.shell.pause(); // the line sits unread in the tty buffer
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  assert.equal(a.run.state, 'starting');
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 20 });
  assert.equal(c.state, 'cancelled');
  assert.equal(c.escalation, undefined);
  assert.equal(h.session.run(a.run.runId).reason, 'cancelled-before-start');
  h.shell.resume();
  assert.deepEqual(h.shell.executed, [], 'the tty flush discarded the line');
  assert.ok(h.session.shellAvailable().ok);
  await h.session.close();
});

test('G29 (core-14): a failed cancel does not label the Run\'s later natural end as cancelled', async () => {
  const h = await harness({ ignoreSignals: true, ignoreGroupSignals: true });
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 10 });
  assert.equal(c.escalation, 'session_close');
  h.shell.finishHung(4);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 4);
  await h.session.close();
});

test('G29: SIGTERM then SIGKILL go to the terminal\'s foreground group when ^C and ^\\ fail, never to the shell', async () => {
  const h = await harness({ ignoreSignals: true });
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 10 });
  assert.equal(c.state, 'cancelled');
  assert.equal(h.session.run(a.run.runId).exit, 143);
  assert.deepEqual(c.steps, ['^C', '^\\', `SIGTERM → foreground process group ${h.shell.jobPgid}`]);
  assert.deepEqual(h.pty.groupKills, [[h.shell.jobPgid, 'SIGTERM']]);
  assert.deepEqual(h.pty.kills, []);
  await h.session.close();
});

test('G29 (api-10): cancel is allowed to the seat holder, the Run\'s own principal and the owner — not to an observer', async () => {
  const h = await harness({ owner: 'agent:owner@test', attachOwner: false, control: 'seat' });
  h.session.attach(AGENT, 'c1', 'controller');
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  h.session.releaseControl(AGENT); // the Run's principal no longer holds the seat
  h.session.attach(HUMAN, 'c2', 'controller');
  const observer = 'agent:observer@test';
  h.session.attach(observer, 'c3');
  await assert.rejects(h.session.cancel(a.run.runId, observer, { graceMs: 10 }), /cancel requires/);
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 10 });
  assert.equal(c.state, 'cancelled', 'the Run\'s own principal may cancel it without the seat');
  const b = h.session.admit({ target: 'shell', line: 'sleep 10', principal: HUMAN });
  assert.ok(b.admitted);
  const cb = await h.session.cancel(b.run.runId, 'agent:owner@test', { graceMs: 10 });
  assert.equal(cb.state, 'cancelled', 'the owner may cancel');
  await h.session.close();
});

test('G5 (core-5, api-18): human editing never wedges: C-u clears it, a stale line stops blocking and is cleared before our line; empty input is invalid', async () => {
  const h = await harness({ editingStaleMs: 60 });
  assert.equal(code(() => h.session.input('', { principal: AGENT })), 'invalid_argument');
  h.session.input('ls -la', { principal: AGENT });
  let a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(!a.admitted && a.reason === 'human-editing');
  h.session.input('\x15', { principal: AGENT });
  assert.ok(h.session.shellAvailable().ok, 'C-u cleared the line');
  h.session.input('half typed', { principal: AGENT });
  assert.ok(!h.session.shellAvailable().ok);
  const q = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
  assert.ok(q.admitted);
  await tick(90);
  assert.equal(h.session.run(q.run.runId).state, 'exited', 'the queued Run advanced once the line went stale');
  assert.ok(h.pty.written.includes(`${CLEAR_LINE_KEYS} . '`), 'the stale partial line was cleared before our line');
  assert.ok(h.shell.clears > 0);
  await h.session.close();
  // A ^C at an empty prompt discards nothing, and fish answers it with nothing: it
  // must not leave the shell waiting for an answer. A ^C that discards a line is
  // answered with a prompt start, which ends the wait.
  const f = await harness({ quietEmptyInterrupt: true });
  f.session.input('\x03', { principal: AGENT });
  assert.ok(f.session.shellAvailable().ok, 'a ^C at an empty prompt blocks nothing');
  f.session.input('partial', { principal: AGENT });
  f.session.input('\x03', { principal: AGENT });
  assert.ok(f.session.shellAvailable().ok, 'the prompt that answered the ^C ended the wait');
  const b = f.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(b.admitted);
  assert.equal((await f.session.awaitRun(b.run.runId, 500)).state, 'exited');
  await f.session.close();
});

test('G5 (core-5, core-8): under `none` a marker Run makes the session busy, and answering a reader never blocks later runs', async () => {
  const h = await harness({ marks: 'none', setup: (s) => s.on('read x', () => ({ hang: true })) });
  const a = h.session.admit({ target: 'shell', line: 'read x', principal: AGENT });
  assert.ok(a.admitted);
  assert.equal(h.session.state, 'busy');
  assert.equal(h.session.info().state, 'busy');
  h.session.input('value\n', { principal: AGENT });
  h.shell.finishHung(0);
  await h.session.awaitRun(a.run.runId, 1000);
  await tick();
  assert.equal(h.session.state, 'idle');
  const b = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(b.admitted, 'no human-editing state under none');
  await h.session.close();
});

test('G29 (core-6): under `none`, a ^C that aborts the marker echo is resolved by the end-marker probe', async () => {
  const h = await harness({ marks: 'none', abortListOnInterrupt: true });
  const a = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(a.admitted);
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 20 });
  assert.equal(c.state, 'cancelled');
  assert.equal(c.escalation, undefined);
  assert.deepEqual(c.steps, ['^C', 'end-marker probe']);
  // ss-5: the probe's $? belongs to its own line (after a ^C at an empty prompt, the ^C's):
  // it confirms the shell is back, and the exit stays unobserved (G2, G3).
  assert.equal(h.session.run(a.run.runId).exit, undefined, 'the probe\'s $? is never the Run\'s exit');
  assert.equal(h.session.run(a.run.runId).reason, 'exit-unobserved');
  assert.equal((await h.session.runTranscript(a.run.runId)).text, '^C', 'the probe line is not in the transcript');
  await tick();
  assert.ok(h.session.shellAvailable().ok);
  await h.session.close();
});

test('G5 (core-9, shell-7): marks that appear while a marker Run is in flight neither lose it nor invent a human Run', async () => {
  const h = await harness({ promptAtStart: false, hello: false, setup: (s) => s.on('echo first', () => ({ output: 'first\r\n', exit: 5 })) });
  assert.equal(h.session.integration, 'none');
  h.shell.pause(); // the rc is still running: the line waits in the tty
  const a = h.session.admit({ target: 'shell', line: 'echo first', principal: AGENT });
  assert.ok(a.admitted);
  h.shell.start(); // the first prompt, with marks: the level rises to rich
  assert.equal(h.session.integration, 'rich');
  assert.equal(h.session.run(a.run.runId).state, 'running');
  h.shell.resume();
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 5);
  assert.equal(h.session.listRuns().length, 1, 'no phantom Run from the marker line\'s own C');
  await tick();
  assert.ok(h.session.shellAvailable().ok);
  await h.session.close();
});

test('G5 (handshake): after the integration\'s hello, start waits for the first prompt (bounded) instead of declaring none', async () => {
  const t0 = Date.now();
  const h = await harness({ promptAtStart: false, integrationGraceMs: 30, startupCapMs: 250 });
  h.shell.start();
  assert.equal(h.session.integration, 'rich');
  await h.session.close();
  // Hello, then no prompt at all: start resolves at the cap, still `starting`; admission says so.
  const slow = await harness({ promptAtStart: false, integrationGraceMs: 30, startupCapMs: 150, setup: (s) => queueMicrotask(() => s.pty.emit(s.mark('633;P;TsmHello=fake'))) });
  assert.ok(Date.now() - t0 >= 150);
  assert.equal(slow.session.state, 'starting');
  assert.equal(slow.session.integration, 'unknown');
  const a = slow.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(!a.admitted && a.reason === 'starting');
  const q = slow.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
  assert.ok(q.admitted);
  slow.shell.start(); // the prompt, finally
  assert.equal(slow.session.integration, 'rich');
  assert.equal((await slow.session.awaitRun(q.run.runId, 1000)).state, 'exited', 'the queue drained at the first prompt');
  await slow.session.close();
});

test('G26 (shell-9): a command typed as sensitive input is not promoted into the Run\'s line', async () => {
  const h = await harness({ setup: (s) => s.on(/^export /, () => ({ exit: 0 })) });
  h.session.input('export API_TOKEN=sk-live-SECRET123\n', { principal: AGENT, sensitive: true });
  await tick();
  const r = h.session.listRuns().find((x) => x.origin === 'agent');
  assert.ok(r);
  assert.equal(r.line, '[redacted]');
  const text = JSON.stringify(h.journal.since(0).events.filter((e) => e.type !== 'output'));
  assert.ok(!text.includes('SECRET123'), 'no structured event carries the secret');
  await h.session.close();
});

test('G7/G26 (core-7, api-4, jr-6, sec-4): shells and process Runs never see the daemon\'s credentials or the launching terminal\'s identity', async () => {
  const daemonEnv = {
    PATH: '/bin',
    HOME: '/home/t',
    TSM_TOKEN: 'daemon-secret',
    TSM_TOKENS_FILE: '/etc/tsm/tokens.json',
    TSM_URL: 'ws://127.0.0.1:3100',
    GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources/ghostty',
    TERM_PROGRAM: 'ghostty',
    TERM_PROGRAM_VERSION: '1.2',
    TMUX: '/tmp/tmux-501/default,1,0',
    TMUX_PANE: '%1',
    ITERM_SESSION_ID: 'w0t0p0',
    VSCODE_INJECTION: '1',
    KITTY_WINDOW_ID: '3',
    LC_TERMINAL: 'iTerm2',
    COLORTERM: '24bit',
  };
  const env = configuredEnv(daemonEnv, { TSM_URL: 'ws://explicit' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/t', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'tsm', TSM_URL: 'ws://explicit' }, 'the session\'s own env still wins');
  const h = await harness({ daemonEnv, env: {} });
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
    p.exit({ exitCode: 0 });
  };
  const a = h.session.admit({ target: 'process', argv: ['env'], principal: AGENT });
  assert.ok(a.admitted);
  await h.session.awaitRun(a.run.runId, 1000);
  for (const e of [proc.opts.env, h.pty.opts.env]) {
    for (const k of ['TSM_TOKEN', 'TSM_TOKENS_FILE', 'TSM_URL', 'GHOSTTY_RESOURCES_DIR', 'TMUX', 'TMUX_PANE', 'ITERM_SESSION_ID', 'VSCODE_INJECTION', 'KITTY_WINDOW_ID', 'LC_TERMINAL', 'TERM_PROGRAM_VERSION']) assert.equal(e[k], undefined, k);
    assert.equal(e.TERM_PROGRAM, 'tsm');
    assert.equal(e.COLORTERM, 'truecolor');
    assert.equal(e.TERM, 'xterm-256color');
  }
  assert.ok(h.pty.opts.bootstrap?.key, 'the shell gets its mark key out of band');
  assert.equal(h.pty.opts.env.TSM_MARK_KEY, undefined, 'never through the environment');
  assert.equal(proc.opts.env.TSM_MARK_KEY, undefined);
  assert.deepEqual(redactSnapshot({ TSM_TOKEN: 'x', TSM_MARK_KEY: 'k', TSM_API_SECRET: 's', TSM_SNAP: 'yes', PATH: '/bin' }), { TSM_SNAP: 'yes', PATH: '/bin' });
  await h.session.close();
  // The session's creation-time env wins over the terminal defaults, for the shell too.
  const dumb = await harness({ daemonEnv, env: { TERM: 'dumb' } });
  assert.equal(dumb.pty.opts.env.TERM, 'dumb');
  assert.equal(dumb.pty.opts.env.TERM_PROGRAM, 'tsm');
  await dumb.session.close();
});

test('G26/G17 (api-3, core-7): env capture needs the seat, keeps values out of raw output, and never journals credentials', async () => {
  const h = await harness({
    setup: (s) =>
      s.on(/^env -0 > '(.*)'$/, (l) => {
        fs.writeFileSync(/^env -0 > '(.*)'$/.exec(l)![1]!, 'A=1\0TSM_TOKEN=user-exported-secret\0PATH=/bin\0');
        return { exit: 0 };
      }),
  });
  h.session.attach(HUMAN, 'c2'); // an observer
  await assert.rejects(h.session.captureEnv(HUMAN), /requires the controller seat/);
  const snap = await h.session.captureEnv(AGENT);
  assert.deepEqual(snap.vars, { A: '1', PATH: '/bin' });
  assert.ok(!JSON.stringify(h.journal.since(0).events).includes('user-exported-secret'));
  await h.session.close();
});

test('G17 (api-14): signal validates names; control characters for INT/TSTP/QUIT; others to the foreground job, never the shell', async () => {
  const h = await harness();
  const before = h.journal.lastSeq;
  assert.equal(code(() => h.session.signal('', AGENT)), 'invalid_argument');
  assert.equal(code(() => h.session.signal('SIGFOO', AGENT)), 'invalid_argument');
  assert.equal(code(() => h.session.signal('SIGTERM', AGENT)), 'invalid_argument', 'no job: it would signal the shell itself');
  assert.equal(h.journal.lastSeq, before, 'nothing journaled for a refused signal');
  assert.deepEqual(h.pty.kills, []);
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  h.session.signal('term', AGENT);
  assert.deepEqual(h.pty.groupKills, [[h.shell.jobPgid, 'SIGTERM']]);
  assert.equal((await h.session.awaitRun(a.run.runId, 1000)).exit, 143);
  h.session.signal('SIGINT', AGENT);
  assert.ok(h.pty.written.endsWith('\x03'));
  const sig = ofType(h.journal.since(0).events, 'signal');
  assert.deepEqual(sig.map((e) => e.signal), ['SIGTERM', 'SIGINT']);
  await h.session.close();
});

test('G15/G2 (core-15): a process that never spawned is lost with the reason, with no invented signal', async () => {
  const h = await harness();
  h.backend.onSpawnProcess = (p) => p.exit({ exitCode: null, spawnError: 'ENOENT spawn /nonexistent/binary ENOENT' });
  const a = h.session.admit({ target: 'process', argv: ['/nonexistent/binary'], principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'lost');
  assert.equal(r.signal, undefined);
  assert.equal(r.exit, undefined);
  assert.match(r.reason ?? '', /^spawn-failed: ENOENT/);
  await h.session.close();
});

test('core-16: a temp-file failure ends the Run lost with the reason and leaves the shell available', async () => {
  const h = await harness({ tempDir: path.join(os.tmpdir(), 'tsm-no-such-dir-for-test', String(process.pid)) });
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  const r = h.session.run(a.run.runId);
  assert.equal(r.state, 'lost');
  assert.match(r.reason ?? '', /^temp-file: ENOENT/);
  assert.ok(h.session.shellAvailable().ok);
  await h.session.close();
});

test('G28: awaitRun records the waiting principal until its waiter resolves; run.end is journaled while it is recorded', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  const seenAtEnd: boolean[] = [];
  h.journal.subscribe((e) => {
    if (e.type === 'run.end' && e.runId === a.run.runId) seenAtEnd.push(h.session.isAwaitedBy(a.run.runId, AGENT), h.session.isAwaitedBy(a.run.runId, HUMAN));
  });
  const timedOut = await h.session.awaitRun(a.run.runId, 20, HUMAN);
  assert.equal(timedOut.state, 'running');
  assert.equal(h.session.isAwaitedBy(a.run.runId, HUMAN), false, 'removed when its wait timed out');
  const waiting = h.session.awaitRun(a.run.runId, 2000, AGENT);
  assert.equal(h.session.isAwaitedBy(a.run.runId, AGENT), true);
  h.shell.finishHung(0);
  assert.equal((await waiting).state, 'exited');
  assert.deepEqual(seenAtEnd, [true, false]);
  assert.equal(h.session.isAwaitedBy(a.run.runId, AGENT), false, 'removed after the waiter resolved');
  await h.session.close();
});

test('G17 (mcpl-3, api-10): the seat is kept for a disconnected holder through a grace; it gets it back on reconnect', async () => {
  const h = await harness({ seatGraceMs: 80 });
  const first = h.session.listAttachments()[0]!;
  h.session.attach(HUMAN, 'c2');
  h.session.detach(first.attachmentId); // the owner's connection dropped
  assert.equal(h.session.currentController, AGENT, 'still reserved');
  assert.ok(h.session.info().seatReservedUntil);
  assert.throws(() => h.session.takeControl(HUMAN), /reserved/);
  const back = h.session.attach(AGENT, 'c3', 'auto');
  assert.equal(back.role, 'controller');
  assert.equal(h.session.info().seatReservedUntil, undefined);
  await tick(120);
  assert.equal(h.session.currentController, AGENT, 'the reconnect cancelled the lapse');
  // Gone for longer than the grace: released.
  h.session.detach(back.attachmentId);
  await tick(120);
  assert.equal(h.session.currentController, null);
  const how = ofType(h.journal.since(0).events, 'control').map((e) => e.how);
  assert.deepEqual(how, ['auto', 'release']);
  await h.session.close();
  // The owner's override under owner-priority works during another holder's grace.
  const op = await harness({ control: 'owner-priority', seatGraceMs: 1000 });
  op.session.releaseControl(AGENT);
  const hum = op.session.attach(HUMAN, 'c2', 'controller');
  op.session.detach(hum.attachmentId);
  assert.equal(op.session.currentController, HUMAN);
  op.session.takeControl(AGENT);
  assert.equal(op.session.currentController, AGENT);
  await op.session.close();
});

test('G19/G29 (core-11, tg-12, jr-11, sec-6): close awaits process-Run teardown, signals the group until empty, and appends nothing after', async () => {
  const h = await harness();
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
    p.groupMembers = 2; // the leader and a child that ignores SIGINT
    const orig = p.kill.bind(p);
    p.kill = (sig) => {
      orig(sig);
      if (sig === 'SIGINT') p.exit({ exitCode: null, signal: 'SIGINT' }), (p.groupMembers = 1);
      if (sig === 'SIGTERM') p.groupMembers = 0;
    };
  };
  const a = h.session.admit({ target: 'process', argv: ['sh', '-c', 'x & y'], principal: AGENT });
  assert.ok(a.admitted);
  const s = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(s.admitted);
  await tick(); // the scripted spawn hook runs
  await h.session.close({ reason: 'daemon-shutdown' });
  assert.deepEqual(proc.kills, ['SIGINT', 'SIGTERM'], 'the group was signalled after the leader exited');
  const pr = h.session.run(a.run.runId);
  assert.equal(pr.state, 'cancelled');
  assert.equal(pr.reason, 'daemon-shutdown');
  const sr = h.session.run(s.run.runId);
  assert.equal(sr.state, 'lost');
  assert.equal(sr.reason, 'daemon-shutdown');
  const last = h.journal.lastSeq;
  proc.emitStdout('late output\n');
  assert.equal(h.journal.lastSeq, last, 'nothing is journaled after close resolved');
});

test('marks split at every offset, including byte by byte, still end Runs (emu-1)', async () => {
  const h = await harness({ setup: (s) => s.on('sleep 1', () => ({ hang: true })) });
  const a = h.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(a.admitted);
  // Finish the job by hand, feeding the end mark and prompt one character at a time.
  const bytes = 'done\r\n' + h.shell.mark('133;D;7') + h.shell.mark('133;A') + '$ ' + h.shell.mark('133;B');
  (h.shell as unknown as { running: unknown }).running = undefined;
  for (const ch of bytes) h.pty.emit(ch);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 7);
  assert.ok(h.session.shellAvailable().ok);
  await h.session.close();
});

test('G27: a public RunInfo carries only its declared fields (no launch strategy, nonce, temp file or waiters)', async () => {
  const allowed = new Set(['runId', 'sessionId', 'target', 'origin', 'principal', 'state', 'line', 'argv', 'cwd', 'envBasis', 'admittedAt', 'startedAt', 'endedAt', 'exit', 'signal', 'reason', 'seq', 'attribution', 'cols', 'rows', 'idem']);
  for (const marks of ['rich', 'basic', 'none'] as const) {
    const h = await harness({ marks });
    const a = await h.session.admitWhenAvailable({ target: 'shell', line: 'echo hello', principal: AGENT });
    assert.ok(a.admitted);
    const r = await h.session.awaitRun(a.run.runId, 1000);
    assert.equal(r.state, 'exited', marks);
    for (const info of [a.run, r, h.session.run(r.runId), ...h.session.listRuns()]) {
      const extra = Object.keys(info).filter((k) => !allowed.has(k));
      assert.deepEqual(extra, [], `${marks}: internal fields leaked`);
    }
    await h.session.close();
  }
});
