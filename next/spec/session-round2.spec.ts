/**
 * Session rules from the second review, against the scripted backend: daemon lines that
 * never merge or wedge (ss-1, ss-8), a replaced shell (ss-4), marker probes (ss-5), close
 * and process groups (ss-6, ss-10), the command directory (jr2-3), recorded geometry and
 * pids (er-4, jr2-4), bounded paging (er-11), the key that never leaves (atc-3), the seat
 * (ux-10, tsg-13, atc-12) and secret prompts (m2-2). Each test names its finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clocks } from '../src/core/clock.js';
import type { ScriptedProcess } from '../src/backends/scripted.js';
import type { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import { CLEAR_LINE_KEYS } from '../src/core/marks.js';
import { narrowOutput, pageOutput, type RunOutputRange } from '../src/core/runindex.js';
import { looksLikeSecretPrompt } from '../src/core/session.js';
import type { JournalEvent } from '../src/core/types.js';
import { AGENT, code, HUMAN, OSC, ofType, scriptedSession as harness, tick, until } from './fake-shell.js';

const TYPEAHEAD_GRACE_MS_IN_SPEC = 150; // mirrors session.ts
const fileOf = (written: string): string => /'([^']*tsm-cmd-\d+)'/.exec(written.slice(written.lastIndexOf('tsm-cmd-') - 200))![1]!;

// ───────────── ss-1, ss-8: a daemon line never merges, never wedges, never runs unawaited ─────────────

test('ss-1: under integration every daemon line starts with the clear keys; under the marker strategy it does not', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  assert.ok(h.pty.written.startsWith(`${CLEAR_LINE_KEYS} . '`), JSON.stringify(h.pty.written));
  assert.equal((await h.session.awaitRun(a.run.runId, 500)).state, 'exited');
  await h.session.close();
  const n = await harness({ marks: 'none' });
  const b = await n.session.admitWhenAvailable({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(b.admitted);
  assert.ok(!n.pty.written.includes('\x1b['), 'a shell without our bindings would take the keys as text');
  await n.session.close();
});

test('ss-1: a C whose line merged with text in the editor is still our Run (noted), and a pending Run never outlives a prompt start without evidence', async () => {
  const h = await harness();
  h.shell.pause(); // the line sits unread
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  const file = fileOf(h.pty.written);
  // The shell ran the daemon's line merged with a human's leftover text.
  h.pty.emit(h.shell.mark(`633;E;echo PARTIAL . '${file}'`) + h.shell.mark('133;C') + 'PARTIAL . x\r\n' + h.shell.mark('133;D;0'));
  const r = h.session.run(a.run.runId);
  assert.equal(r.state, 'exited', 'adopted, not left starting');
  assert.equal(h.session.listRuns().length, 1, 'no Run of somebody else');
  assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => e.text.includes(a.run.runId) && /merged/.test(e.text)));
  await h.session.close();

  // A foreign C (a line nobody typed ahead of ours) and its prompt: ours ends at that prompt.
  const g = await harness();
  g.shell.pause();
  const b = g.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(b.admitted);
  g.pty.emit(g.shell.mark('633;E;some-widget') + g.shell.mark('133;C') + g.shell.mark('133;D;0') + g.shell.mark('133;A') + '$ ' + g.shell.mark('133;B'));
  const rb = g.session.run(b.run.runId);
  assert.equal(rb.state, 'lost', 'never starting for good');
  assert.equal(rb.reason, 'no-pre-execution-mark');
  assert.ok(g.session.shellAvailable().ok);
  await g.session.close();
});

test('ss-1: typeahead the editor shows at the next prompt makes the line human editing; typeahead the program took does not', async () => {
  const h = await harness({ editingStaleMs: 5000 });
  const a = h.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(a.admitted);
  h.session.input('echo PARTIAL', { principal: AGENT });
  // The job ends; the editor reads the typeahead and echoes it after the prompt.
  h.shell.finishHung(0, undefined, { prompt: false });
  h.pty.emit(h.shell.mark('133;A') + '$ ' + h.shell.mark('133;B') + '\x1b[1mecho\x1b[0m PARTIAL');
  await tick();
  const busy = h.session.shellAvailable();
  assert.deepEqual(busy, { ok: false, reason: 'human-editing' });
  await h.session.close();

  const g = await harness();
  const b = g.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(b.admitted);
  g.session.input('q', { principal: AGENT }); // a pager's key, taken by the program
  g.shell.finishHung(0);
  await tick();
  assert.ok(g.session.shellAvailable().ok, 'nothing echoed: nothing is being edited');
  await g.session.close();
});

test('core-4: a Run queued behind a running one does not clear a line typed ahead: it waits until that line is submitted, and keys a program took delay it only briefly', async () => {
  const h = await harness({
    typeahead: true,
    editingStaleMs: 5000,
    setup: (s) => {
      s.on('echo typed-ahead-marker', () => ({ output: 'TYPED\r\n', exit: 0 }));
      s.on('echo queued-ran', () => ({ output: 'QUEUED\r\n', exit: 0 }));
    },
  });
  const a = h.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(a.admitted);
  // A person types their next command while the Run runs, and does not press Enter; an agent queues one.
  h.session.input('echo typed-ahead-marker', { principal: AGENT });
  const q = h.session.admit({ target: 'shell', line: 'echo queued-ran', principal: AGENT, queue: true });
  assert.ok(q.admitted);
  const clearsBefore = h.shell.clears;
  h.shell.finishHung(0); // the prompt; the editor shows the typed text after it
  await tick();
  await tick();
  assert.equal(h.session.run(q.run.runId).state, 'queued', 'the queued Run waits for the typed line');
  assert.deepEqual(h.session.shellAvailable(), { ok: false, reason: 'human-editing' });
  assert.equal(h.shell.clears, clearsBefore, 'nothing cleared the typed line');
  await tick(TYPEAHEAD_GRACE_MS_IN_SPEC + 50);
  assert.equal(h.session.run(q.run.runId).state, 'queued', 'and still waits once the grace is over: the line is being edited');
  h.session.input('\r', { principal: AGENT }); // the person submits it
  for (let i = 0; i < 200 && h.session.run(q.run.runId).state !== 'exited'; i++) await tick(10);
  assert.equal(h.session.run(q.run.runId).state, 'exited');
  const outs = ofType(h.journal.since(0).events, 'output').map((e) => e.data).join('');
  assert.ok(outs.includes('TYPED') && outs.indexOf('TYPED') < outs.indexOf('QUEUED'), `the typed line ran first: ${JSON.stringify(outs)}`);
  await h.session.close();

  // Keys the program took (nothing echoed at the prompt): the queued Run goes after the grace.
  const g = await harness({ setup: (s) => s.on('echo queued-ran', () => ({ output: 'QUEUED\r\n', exit: 0 })) });
  const b = g.session.admit({ target: 'shell', line: 'sleep 1', principal: AGENT });
  assert.ok(b.admitted);
  g.session.input('qq', { principal: AGENT }); // a pager's keys, taken by the program
  const q2 = g.session.admit({ target: 'shell', line: 'echo queued-ran', principal: AGENT, queue: true });
  assert.ok(q2.admitted);
  g.shell.finishHung(0);
  await tick();
  assert.equal(g.session.run(q2.run.runId).state, 'queued', 'not before the grace');
  assert.deepEqual(g.session.shellAvailable(), { ok: false, reason: 'prompt-pending' });
  for (let i = 0; i < 100 && g.session.run(q2.run.runId).state !== 'exited'; i++) await tick(10);
  assert.equal(g.session.run(q2.run.runId).state, 'exited', 'after the grace, with nothing echoed, it ran');
  await g.session.close();
});

test('ss-8: a prompt start that beats the daemon line removes its file before the Run is declared lost; the late line runs no command', async () => {
  const h = await harness({ setup: (s) => s.on('echo publish', () => ({ output: 'PUBLISHED\r\n', exit: 0 })) });
  h.shell.pause();
  const a = h.session.admit({ target: 'shell', line: 'echo publish', principal: AGENT });
  assert.ok(a.admitted);
  const file = fileOf(h.pty.written);
  let existedAtEnd: boolean | undefined;
  h.journal.subscribe((e) => {
    if (e.type === 'run.end' && e.runId === a.run.runId) existedAtEnd = fs.existsSync(file);
  });
  // A ^C raced the write: the shell prints a fresh prompt without reading the line…
  h.pty.emit(h.shell.mark('133;A') + '$ ' + h.shell.mark('133;B'));
  assert.equal(h.session.run(a.run.runId).state, 'lost');
  assert.equal(existedAtEnd, false, 'the file was gone before run.end');
  // …then reads it anyway.
  h.shell.resume();
  await tick();
  assert.ok(!h.shell.executed.includes('echo publish'), 'the command never ran');
  const late = h.session.listRuns().find((r) => r.runId !== a.run.runId);
  assert.ok(late, 'the late read is a Run of its own');
  assert.match(late.line ?? '', /tsm-cmd-/);
  assert.notEqual(late.exit, 0);
  await h.session.close();
});

// ───────────── ss-4: a shell replaced by another program ─────────────

test('ss-4: an armed exec whose program never re-integrates ends the Run lost (shell-replaced), drops to none, retires the key', async () => {
  // (fish is one of ours: its handshake is waited for up to the startup cap)
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 150 });
  h.shell.pause(); // the fake "execs": it stops answering as a shell of ours
  const a = h.session.admit({ target: 'shell', line: 'exec dash', principal: AGENT });
  assert.ok(a.admitted);
  const file = fileOf(h.pty.written);
  const oldMark = (p: string) => h.shell.mark(p);
  h.pty.emit(oldMark(`633;E; . '${file}'`) + oldMark('133;C') + oldMark('633;P;TsmExec=1'));
  assert.equal(h.session.run(a.run.runId).state, 'running');
  h.pty.commandLine = '/bin/fish -i';
  await tick(400);
  const r = h.session.run(a.run.runId);
  assert.deepEqual([r.state, r.reason], ['lost', 'shell-replaced']);
  assert.equal(h.session.integration, 'none');
  assert.equal(ofType(h.journal.since(0).events, 'integration').at(-1)!.level, 'none', 'the drop is journaled');
  // The old key is retired: marks carrying it are ordinary output now.
  const runs = h.session.listRuns().length;
  h.pty.emit(oldMark('133;A') + oldMark('633;E;x') + oldMark('133;C'));
  assert.equal(h.session.listRuns().length, runs, 'no Run from the retired key');
  // A process name is not prompt evidence. Even an apparent shell remains unavailable.
  const written = h.pty.written;
  const b = h.session.admit({ target: 'shell', line: 'echo hi', principal: AGENT });
  assert.equal(b.admitted, false);
  assert.equal(h.pty.written, written);
  assert.deepEqual(h.session.shellAvailable(), { ok: false, reason: 'shell-unavailable' });
  await h.session.close();
});

test('ss-4: a new shell that announces itself mid-Run ends it lost as shell-replaced; a cancel that finds the shell replaced ends it too', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 5', principal: AGENT });
  assert.ok(a.admitted);
  h.pty.emit(h.shell.mark('633;P;TsmHello=zsh') + h.shell.mark('133;A') + '% ' + h.shell.mark('133;B'));
  assert.deepEqual([h.session.run(a.run.runId).state, h.session.run(a.run.runId).reason], ['lost', 'shell-replaced']);
  await h.session.close();

  // No arm (an alias for exec): the cancel sees the terminal's program changed.
  const g = await harness({ ignoreSignals: true });
  const b = g.session.admit({ target: 'shell', line: 'sleep 5', principal: AGENT });
  assert.ok(b.admitted);
  g.pty.foregroundPgid = g.pty.pid; // nothing but the program in the foreground
  g.pty.commandLine = 'python3';
  const c = await g.session.cancel(b.run.runId, AGENT, { graceMs: 20 });
  assert.equal(c.state, 'lost');
  assert.equal(c.escalation, undefined);
  assert.ok(c.steps.some((s) => /replaced by python3/.test(s)), JSON.stringify(c.steps));
  assert.equal(g.session.integration, 'none');
  assert.deepEqual(g.session.shellAvailable(), { ok: false, reason: 'shell-unavailable' });
  assert.equal(g.session.admit({ target: 'shell', line: 'echo never', principal: AGENT, queue: true }).admitted, false);
  await g.session.close();
});

// ───────────── the reinit gate after exec bash: honest, and as narrow as it can be (#22 comment 6269901528) ─────────────

type Mode = { canonical: boolean; echo: boolean } | undefined;
const READLINE: Mode = { canonical: false, echo: false };

/**
 * Arm an exec into a bash whose rc replaced PROMPT_COMMAND (no second hello), with the terminal mode
 * and reader state the test scripts, then let the gate reach its decision after the startup cap.
 */
async function armExecBash(h: Awaited<ReturnType<typeof harness>>, mode: Mode, reader: boolean | undefined) {
  h.shell.pause(); // the fake execs: it stops answering as a shell of ours
  const a = h.session.admit({ target: 'shell', line: 'exec bash', principal: AGENT });
  assert.ok(a.admitted);
  const file = fileOf(h.pty.written);
  const mark = (p: string) => h.shell.mark(p);
  h.pty.emit(mark(`633;E; . '${file}'`) + mark('133;C') + mark('633;P;TsmExec=1'));
  assert.equal(h.session.run(a.run.runId).state, 'running');
  h.pty.commandLine = '/bin/bash -i';
  h.pty.mode = mode;
  h.pty.reader = reader;
  return a.run.runId;
}

const notesOf = (h: Awaited<ReturnType<typeof harness>>) => ofType(h.journal.since(0).events, 'note').map((e) => e.text).join(' | ');

test('the reinit is typed only in readline’s mode (ICANON and ECHO off) with no other reader', async () => {
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  await armExecBash(h, READLINE, false);
  await until(() => h.pty.written.includes(' . "$TSM_BASH_RC" reinit typed\n'), 5000, 'the reinit typed');
  assert.ok(h.pty.written.includes(' . "$TSM_BASH_RC" reinit typed\n'), 'the reinit was typed at a readline prompt with no other reader');
  await h.session.close();
});

test('the reinit is not typed while a program the rc started is reading, even in readline’s mode', async () => {
  // A pager, editor or password tool the rc started holds the terminal for input; the mode does not
  // prove readline. Without the reader check the gate would type into that program (the house's read,
  // #22 comment 6269901528).
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  const runId = await armExecBash(h, READLINE, true);
  await until(() => h.session.run(runId).state === 'lost', 5000, 'the gate gave up');
  assert.ok(!h.pty.written.includes('reinit typed'), 'nothing was typed into the reader');
  assert.deepEqual([h.session.run(runId).state, h.session.run(runId).reason], ['lost', 'shell-replaced']);
  assert.match(notesOf(h), /a process other than the shell, in the terminal’s foreground process group, holds the terminal for input/, 'the note says what the check knows, no more');
  await h.session.close();
});

test('a reader check that cannot answer holds the reinit, and the note names that cause', async () => {
  // Unknown is not "no reader": with pgrep missing the old gate typed into an rc's reader (the house's
  // read of the 38 commits, #22 comment 6274841346, item 1).
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  const runId = await armExecBash(h, READLINE, undefined);
  await until(() => h.session.run(runId).state === 'lost', 5000, 'the gate gave up');
  assert.ok(!h.pty.written.includes('reinit typed'), 'nothing typed while the reader check could not answer');
  assert.deepEqual([h.session.run(runId).state, h.session.run(runId).reason], ['lost', 'shell-replaced']);
  assert.match(notesOf(h), /whether a process other than the shell is reading the terminal could not be checked/);
  await h.session.close();
});

test('non-canonical with echo on (read -n) holds the reinit, and the reader check is not run for it', async () => {
  // `read -n 1` leaves ECHO on where readline turns it off (the house's stty readings, item 3).
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  const runId = await armExecBash(h, { canonical: false, echo: true }, false);
  await until(() => h.session.run(runId).state === 'lost', 5000, 'the gate gave up');
  assert.ok(!h.pty.written.includes('reinit typed'), 'nothing typed into a read -n');
  assert.deepEqual([h.session.run(runId).state, h.session.run(runId).reason], ['lost', 'shell-replaced']);
  assert.match(notesOf(h), /non-canonical with echo on, as under `read -n`/);
  assert.equal(h.pty.readerChecks, 0, 'the mode alone decided: no reader check per tick');
  await h.session.close();
});

test('a canonical prompt gets the honest note (read -p and --noediting cannot be told apart), not a false canonical-mode give-up', async () => {
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  const runId = await armExecBash(h, { canonical: true, echo: true }, false);
  await until(() => h.session.run(runId).state === 'lost', 5000, 'the gate gave up');
  assert.ok(!h.pty.written.includes('reinit typed'), 'nothing typed into a canonical reader or prompt');
  assert.deepEqual([h.session.run(runId).state, h.session.run(runId).reason], ['lost', 'shell-replaced']);
  const note = notesOf(h);
  assert.match(note, /canonical mode/);
  assert.match(note, /--noediting is unsupported for the handoff/);
  assert.match(note, /TSM_BASH_RC" reinit typed/, 'the manual recovery is given');
  assert.equal(h.pty.readerChecks, 0);
  await h.session.close();
});

test('an unreadable terminal mode (stty failed) gets its own note, and nothing is typed', async () => {
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  const runId = await armExecBash(h, undefined, false);
  await until(() => h.session.run(runId).state === 'lost', 5000, 'the gate gave up');
  assert.ok(!h.pty.written.includes('reinit typed'));
  assert.deepEqual([h.session.run(runId).state, h.session.run(runId).reason], ['lost', 'shell-replaced']);
  assert.match(notesOf(h), /terminal mode could not be read \(stty failed\)/, 'the note names the stty cause');
  await h.session.close();
});

test('after the gate gives up, the recovery its note gives works: the bash’s marks are still accepted', async () => {
  // The give-up retired the mark key, so the advised reinit, sent as input, re-sourced the rc with the
  // key the exec left and every mark was refused: the session stayed unavailable (the house's read of
  // the 38 commits, #22 comment 6274841346, item 5).
  const h = await harness({ integrationGraceMs: 60, startupCapMs: 80 });
  await armExecBash(h, { canonical: false, echo: true }, false);
  await until(() => h.session.info().state === 'unavailable', 3000, 'the gate gave up');
  assert.match(notesOf(h), /send ` \. "\$TSM_BASH_RC" reinit typed` with input/);
  h.session.input(' . "$TSM_BASH_RC" reinit typed\n', { principal: AGENT });
  // What the rc does when that line runs: its hello under the key it read, then a prompt.
  h.pty.emit(h.shell.mark('633;P;TsmHello=bash') + h.shell.mark('133;A') + '$ ' + h.shell.mark('133;B'));
  await until(() => h.session.shellAvailable().ok, 3000, 'available again');
  assert.equal(h.session.integration, 'rich');
  assert.equal(h.session.admit({ target: 'shell', line: 'echo back', principal: AGENT }).admitted, true);
  await h.session.close();
});

// ───────────── holds and waits are measured on the monotonic clock, not the wall clock (#22 comment 6269901528) ─────────────

test('an editing hold neither ends early on a forward wall-clock step nor stretches on a backward one', async (t) => {
  const real = performance.now.bind(performance);
  let mono = 0;
  t.mock.method(clocks, 'monotonic', () => real() + mono);
  const h = await harness({ editingStaleMs: 1000 });
  const reason = () => {
    const a = h.session.shellAvailable();
    return a.ok ? 'ok' : a.reason;
  };
  try {
    // A partial line is being edited at the rich idle prompt: the shell is held until it goes stale.
    h.session.input('sle', { principal: AGENT });
    assert.equal(reason(), 'human-editing');
    // The wall clock jumps forward an hour; the monotonic clock has not moved: the hold stands.
    const wall = Date.now();
    t.mock.method(Date, 'now', () => wall + 3_600_000);
    assert.equal(reason(), 'human-editing', 'a forward wall-clock step does not end the hold early');
    // The wall clock jumps back; still held.
    t.mock.method(Date, 'now', () => wall - 3_600_000);
    assert.equal(reason(), 'human-editing', 'a backward wall-clock step does not change it');
    // Only the monotonic clock passing the stale period ends it.
    mono = 1500;
    assert.equal(reason(), 'ok', 'the hold ends when the monotonic quiet period passes');
  } finally {
    await h.session.close();
  }
});

// ───────────── a cancel right after admit, before the line started (CI at cb603a8 on #22) ─────────────

test('a cancel whose ^C flushed the line before the shell read it, at a shell that prints no prompt for a ^C on an empty line, ends the Run cancelled rather than leaving it starting', async () => {
  // The tty flushes unread input on SIGINT, so the line is gone; fish prints nothing for a ^C at an
  // empty line, so no prompt mark says so. The cancel answered `starting` with escalation
  // session_close on a loaded macOS runner (CI at cb603a8 on #22).
  const h = await harness({ quietEmptyInterrupt: true });
  h.shell.pause(); // the shell has not read the line when the ^C arrives
  const a = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(a.admitted && a.run.state === 'starting', JSON.stringify(a));
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 30 });
  assert.equal(c.state, 'cancelled', JSON.stringify(c));
  assert.equal(c.escalation, undefined);
  assert.deepEqual(c.steps, ['^C', '^C', 'the line was discarded before it started']);
  const r = h.session.run(a.run.runId);
  assert.deepEqual([r.state, r.reason], ['cancelled', 'cancelled-before-start']);
  assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => /discarded before it started/.test(e.text)), 'the reason is said');
  assert.ok(h.session.shellAvailable().ok, 'the shell is at the prompt it never left');
  await h.session.close();
});

test('an end mark that arrives for a line under cancel whose start mark never came ends the Run cancelled at that mark', async () => {
  // The ^C landed in the hook before it printed the C mark; the command ran and its D came with no
  // Run running. The pending Run ends cancelled there (its exit is not attributed to it), without
  // waiting for a prompt (CI at cb603a8 on #22).
  const h = await harness({ ignoreSignals: true, setup: (s) => s.on(/^nostart/, () => ({ hang: true, noStartMark: true })) });
  const a = h.session.admit({ target: 'shell', line: 'nostart 1', principal: AGENT });
  assert.ok(a.admitted && a.run.state === 'starting', JSON.stringify(a));
  await tick(20);
  assert.equal(h.session.run(a.run.runId).state, 'starting', 'no start mark came');
  // The first ^C (ignored by the job) marks the cancel as requested: the end mark follows it.
  let fired = false;
  h.pty.onWrite((d) => {
    if (d !== '\x03' || fired) return;
    fired = true;
    queueMicrotask(() => h.shell.finishHung(130, undefined, { prompt: false }));
  });
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 200 });
  assert.equal(c.state, 'cancelled', JSON.stringify(c));
  assert.deepEqual(c.steps, ['^C'], 'the end mark ended it before a second ^C');
  const r = h.session.run(a.run.runId);
  assert.deepEqual([r.state, r.reason, r.exit], ['cancelled', 'cancelled-before-start', undefined]);
  assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => /end mark arrived with no start mark/.test(e.text)), 'the reason is said');
  h.shell.promptNow();
  await h.session.close();
});

// ───────────── ss-6, ss-10: nothing the session started outlives it unowned ─────────────

test('ss-6: close sends SIGTERM, then SIGKILL, to a foreground job that survived its hangup, and journals it', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 60', principal: AGENT });
  assert.ok(a.admitted);
  const job = h.shell.jobPgid;
  h.pty.liveGroups.add(job);
  const sent: string[] = [];
  h.pty.onGroupSignal = (pgid, sig) => {
    if (pgid !== job) return;
    sent.push(sig);
    if (sig === 'SIGKILL') h.pty.liveGroups.delete(job);
  };
  await h.session.close({ timeoutMs: 600 });
  assert.deepEqual(sent, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
  assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => e.text.includes(`process group ${job}`) && /SIGTERM, then SIGKILL/.test(e.text)));
});

test('ss-10: a process group outliving its leader writes unattributed output; cancel of the ended Run and close still reach the group', async () => {
  const h = await harness();
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
    p.emitStdout('started\n');
    p.groupMembers = 1;
    p.exit({ exitCode: 0 });
  };
  const a = h.session.admit({ target: 'process', argv: ['sh', '-c', 'server & echo started'], principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 500);
  assert.equal(r.state, 'exited');
  proc.emitStdout('late-output\n');
  const late = ofType(h.journal.since(0).events, 'output').find((e) => e.data === 'late-output\n')!;
  assert.equal(late.runId, undefined, 'not the ended Run\'s (G12)');
  assert.equal(late.stream, 'stdout');
  assert.equal((await h.session.runTranscript(r.runId)).text, 'started');
  const c = await h.session.cancel(r.runId, AGENT, { graceMs: 10 });
  assert.equal(c.state, 'exited', 'the recorded outcome stands');
  assert.deepEqual(c.steps, ['SIGINT → process group', 'SIGTERM → process group', 'SIGKILL → process group']);
  assert.deepEqual(proc.kills, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  proc.groupMembers = 0; // the SIGKILL took them
  // Close tears down a group that still lives, whatever its Run's state.
  const b = h.session.admit({ target: 'process', argv: ['sh', '-c', 'x & y'], principal: AGENT });
  assert.ok(b.admitted);
  await h.session.awaitRun(b.run.runId, 200);
  const second = proc;
  second.kills.length = 0;
  second.groupMembers = 1;
  const closing = h.session.close({ timeoutMs: 200 });
  await tick(20);
  second.groupMembers = 0;
  await closing;
  assert.equal(second.kills[0], 'SIGINT', 'close signalled the outliving group');
});

// ───────────── jr2-3: the /tmp command directory is re-checked before every write ─────────────

test('jr2-3: a command directory replaced by someone else\'s is never written through; the session falls back to its own', { skip: process.platform === 'win32' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-jr23-'));
  fs.chmodSync(base, 0o700);
  const cmd = path.join(base, 'cmd');
  fs.mkdirSync(cmd, { mode: 0o700 });
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-jr23-own-'));
  const h = await harness({ tempDir: own });
  // (the harness has no commandDir option: set the session's the way the registry does)
  (h.session as unknown as { commandDir: string }).commandDir = cmd;
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  assert.ok(h.pty.written.includes(`'${cmd}/tsm-cmd-1'`));
  await h.session.awaitRun(a.run.runId, 500);
  // A cleaner removes it; another user plants a world-writable directory with a symlink.
  fs.rmSync(cmd, { recursive: true, force: true });
  fs.mkdirSync(cmd, { mode: 0o777 });
  fs.chmodSync(cmd, 0o777);
  const victim = path.join(base, 'victim');
  fs.writeFileSync(victim, 'untouched\n');
  fs.symlinkSync(victim, path.join(cmd, 'tsm-cmd-2'));
  const b = await h.session.admitWhenAvailable({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(b.admitted);
  assert.equal((await h.session.awaitRun(b.run.runId, 500)).state, 'exited');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n', 'nothing was written through the symlink');
  assert.ok(h.pty.written.includes(`'${own}/tsm-cmd-2'`), 'the session\'s own directory served');
  assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => /no longer private/.test(e.text)));
  await h.session.close();
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(own, { recursive: true, force: true });
});

test('jr2-3: close takes its command directory along, even while Runs that just ended still have files being removed', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-jr23-close-'));
  fs.chmodSync(base, 0o700);
  const cmd = path.join(base, 'cmd');
  fs.mkdirSync(cmd, { mode: 0o700 });
  const h = await harness();
  (h.session as unknown as { commandDir: string }).commandDir = cmd;
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.equal(a.admitted && h.session.run(a.run.runId).state, 'exited');
  h.shell.promptNow();
  const b = h.session.admit({ target: 'shell', line: 'sleep 5', principal: AGENT }); // in flight: close ends it
  assert.ok(b.admitted);
  h.session.admit({ target: 'shell', line: 'echo queued', principal: AGENT, queue: true });
  await h.session.close();
  assert.equal(fs.existsSync(cmd), false, 'no command directory left behind');
  fs.rmSync(base, { recursive: true, force: true });
});

test('jr2-3: command files are created exclusively — a file an earlier life left under the name is replaced, never followed', async () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-jr23-excl-'));
  const victim = path.join(own, 'victim');
  fs.writeFileSync(victim, 'untouched\n');
  fs.symlinkSync(victim, path.join(own, 'tsm-cmd-1'));
  const h = await harness({ tempDir: own });
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  assert.equal((await h.session.awaitRun(a.run.runId, 500)).state, 'exited');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n');
  await h.session.close();
  fs.rmSync(own, { recursive: true, force: true });
});

// ───────────── er-4, jr2-4: what run.start records ─────────────

test('er-4: a Run records its geometry at start and its transcript is projected at it, whatever the session was resized to later', async () => {
  // A pip-style progress line, redrawn with CR: longer than 60 columns, shorter than 120.
  const bar = (n: number) => `\rDownloading torch-2.4.0-cp312-none-macosx_11_0_arm64.whl [${'#'.repeat(n).padEnd(40, '.')}] ${Math.round((n / 40) * 100)}%`;
  const line = [10, 20, 40].map(bar).join('');
  const h = await harness({ setup: (s) => s.on('pip install torch', () => ({ output: `${line}\r\n`, exit: 0 })) });
  const a = h.session.admit({ target: 'shell', line: 'pip install torch', principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 500);
  assert.deepEqual([r.cols, r.rows], [120, 30]);
  const start = ofType(h.journal.since(0).events, 'run.start').find((e) => e.runId === r.runId)!;
  assert.deepEqual([start.cols, start.rows], [120, 30]);
  const before = (await h.session.runTranscript(r.runId)).text;
  assert.equal(before, bar(40).slice(1), 'at the width it started with, the redraws resolve to the last bar');
  h.session.resize(60, 20, AGENT);
  assert.equal((await h.session.runTranscript(r.runId)).text, before, 'the transcript is a function of the range (G10)');
  await h.session.close();
});

test('jr2-4: a process Run records its pid and process group on run.start', async () => {
  const h = await harness();
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
  };
  const a = h.session.admit({ target: 'process', argv: ['sleep', '9'], principal: AGENT });
  assert.ok(a.admitted);
  await tick();
  const start = ofType(h.journal.since(0).events, 'run.start').find((e) => e.runId === a.run.runId)!;
  assert.deepEqual([start.pid, start.pgid], [proc.pid, proc.pgid]);
  proc.exit({ exitCode: 0 });
  await h.session.close();
});

// ───────────── er-11: paging a Run costs a page ─────────────

test('er-11: pageOutput equals narrowOutput over the whole Run for random ranges (property)', () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 60; round++) {
    const j = new Journal();
    const runId = 'r1-aaaaaa';
    const n = 50 + rand(1500);
    j.append({ type: 'run.start', runId, cwd: '/' });
    const from = j.lastSeq;
    for (let i = 0; i < n; i++) {
      const k = rand(5);
      if (k === 0) j.append({ type: 'note', text: `n${i}`, principal: 'system' });
      else if (k === 1) j.append({ type: 'output', data: `other-${i}`, stream: 'stdout', runId: 'r2-bbbbbb' });
      else j.append({ type: 'output', data: 'x'.repeat(1 + rand(40)), stream: 'pty', runId, attribution: 'temporal' });
    }
    const to = j.lastSeq;
    const all = { events: j.range(from, to).events.filter((e) => e.type === 'output' && e.runId === runId), from, to, truncated: false };
    for (let q = 0; q < 12; q++) {
      const range: RunOutputRange = {};
      if (rand(2)) range.since = from - 2 + rand(n + 4);
      if (rand(3) === 0) range.until = from + rand(n + 2);
      if (rand(2)) range.limit = rand(40);
      if (rand(2)) range.maxBytes = 1 + rand(400);
      const got = pageOutput(j, runId, from, to, range);
      const want = narrowOutput(all, range);
      const seqs = (o: { events: JournalEvent[] }) => o.events.map((e) => e.seq).join(',');
      assert.equal(seqs(got), seqs(want), `round ${round} ${JSON.stringify(range)}`);
      assert.deepEqual([got.from, got.to, got.truncated, got.more], [want.from, want.to, want.truncated, want.more], `round ${round} ${JSON.stringify(range)}`);
    }
  }
});

test('er-11: a page of a large Run reads a page of the journal, not the Run', async () => {
  const h = await harness();
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
  };
  const a = h.session.admit({ target: 'process', argv: ['flood'], principal: AGENT });
  assert.ok(a.admitted);
  await tick();
  for (let i = 0; i < 20_000; i++) proc.emitStdout(`line ${i}\n`);
  proc.exit({ exitCode: 0 });
  await h.session.awaitRun(a.run.runId, 500);
  let read = 0;
  const j = h.journal as unknown as { range: Journal['range']; tail: Journal['tail'] };
  const range = j.range.bind(h.journal);
  const tailFn = j.tail.bind(h.journal);
  j.range = (f, t, l) => {
    const r = range(f, t, l);
    read += r.events.length;
    return r;
  };
  j.tail = (n, t) => {
    const r = tailFn(n, t);
    read += r.length;
    return r;
  };
  const start = h.session.run(a.run.runId).seq.start!;
  const page = h.session.runOutput(a.run.runId, { since: start + 10_000, limit: 50 });
  assert.equal(page.events.length, 50);
  assert.equal(page.more, true);
  assert.ok(read < 2_000, `a head page read ${read} events`);
  read = 0;
  const tail = h.session.runOutput(a.run.runId, { maxBytes: 1024 });
  assert.ok(tail.truncated);
  assert.ok(read < 2_000, `a tail page read ${read} events`);
  await h.session.close();
});

// ───────────── atc-3: the mark key never leaves the daemon ─────────────

test('atc-3: no event and no screen carries the key; a mark forged from everything an observer can read does nothing', async () => {
  const h = await harness({
    setup: (s) =>
      s.on('set', (_l, sh) => ({ output: `__tsm_key=${sh.key}\r\n__tsm_b='\\[\\e]133;B;k=${sh.key}\\a\\]'\r\n`, exit: 0 })).on(/^cat evil/, () => ({ output: 'evil\r\n', hang: true })),
  });
  const key = h.shell.key;
  const a = h.session.admit({ target: 'shell', line: 'set', principal: AGENT });
  assert.ok(a.admitted);
  assert.equal((await h.session.awaitRun(a.run.runId, 500)).state, 'exited');
  await h.session.screen.settled();
  const events = h.journal.since(0).events;
  assert.deepEqual(events.filter((e) => JSON.stringify(e).includes(key)).map((e) => e.type), [], 'the key is in no journaled event');
  assert.ok(!h.session.snapshot().lines.join('\n').includes(key), 'nor on the screen');
  assert.ok(events.some((e) => e.type === 'output' && e.data.includes('__tsm_key=[redacted]')));
  // An observer takes every k= value it can find in the events and prints marks with them.
  const seen = new Set<string>();
  for (const e of events) for (const m of JSON.stringify(e).matchAll(/k=([0-9a-z[\]]+)/g)) seen.add(m[1]!);
  const b = await h.session.admitWhenAvailable({ target: 'shell', line: 'cat evil.txt', principal: AGENT });
  assert.ok(b.admitted);
  for (const k of seen) h.pty.emit(OSC(`133;D;0;k=${k}`) + OSC(`133;A;k=${k}`));
  assert.equal(h.session.run(b.run.runId).state, 'running', 'no forged end');
  h.shell.finishHung(7);
  assert.equal((await h.session.awaitRun(b.run.runId, 500)).exit, 7);
  await h.session.close();
});

// ───────────── ux-10, tsg-13, atc-12: the seat ─────────────

test('ux-10: a free seat is taken by whoever acts first — run, input, signal, cancel — journaled as how:auto', async () => {
  for (const act of ['run', 'input', 'signal', 'cancel'] as const) {
    const h = await harness({ attachOwner: false, control: 'seat' });
    h.session.attach(HUMAN, 'c9');
    let other: string | undefined;
    if (act === 'cancel') {
      const a = h.session.admit({ target: 'shell', line: 'sleep 9', principal: 'system', internal: true, origin: 'system' });
      assert.ok(a.admitted);
      other = a.run.runId;
    }
    assert.equal(h.session.currentController, null);
    if (act === 'run') assert.ok(h.session.admit({ target: 'shell', line: 'echo hello', principal: HUMAN }).admitted);
    if (act === 'input') h.session.input('x', { principal: HUMAN });
    if (act === 'signal') h.session.signal('SIGINT', HUMAN);
    if (act === 'cancel') await h.session.cancel(other!, HUMAN, { graceMs: 10 });
    assert.equal(h.session.currentController, HUMAN, act);
    const control = ofType(h.journal.since(0).events, 'control');
    assert.deepEqual(control.map((e) => [e.controller, e.how]), [[HUMAN, 'auto']], act);
    await h.session.close();
  }
});

test('ux-10: a held seat refuses with the holder and the way forward; a seat reserved for a dropped holder never locks the owner out', async () => {
  const h = await harness({ control: 'seat', seatGraceMs: 10_000, attachOwner: false });
  const hum = h.session.attach(HUMAN, 'c2');
  h.session.input('\x15', { principal: HUMAN }); // takes the free seat (and edits nothing)
  const refusal = (() => {
    try {
      h.session.admit({ target: 'shell', line: 'echo hello', principal: 'agent:b@test' });
    } catch (e) {
      return (e as TermError).message;
    }
    return '';
  })();
  assert.match(refusal, /held by human:test:1: ask human:test:1 to release it/);
  const ownerRefusal = (() => {
    try {
      h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
    } catch (e) {
      return (e as TermError).message;
    }
    return '';
  })();
  assert.match(ownerRefusal, /as the owner you can take it over \(control take\)/);
  // The holder's connection drops: the seat is reserved for it, but not against the owner.
  h.session.detach(hum.attachmentId);
  assert.equal(code(() => h.session.input('y', { principal: 'agent:b@test' })), 'not_controller');
  const reserved = (() => {
    try {
      h.session.input('y', { principal: 'agent:b@test' });
    } catch (e) {
      return (e as TermError).message;
    }
    return '';
  })();
  assert.match(reserved, /reserved while it reconnects/);
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted, 'the owner\'s run overrides a reserved seat');
  assert.equal(h.session.currentController, AGENT);
  assert.equal(ofType(h.journal.since(0).events, 'control').at(-1)!.how, 'override');
  await h.session.close();
});

test('tsg-13/atc-12: asOwner gives the owner\'s GUI human exactly the owner\'s seat and cancel rights', async () => {
  const GUI = `human:gui:${AGENT}`;
  const h = await harness({ control: 'owner-priority' });
  const a = h.session.admit({ target: 'shell', line: 'sleep 9', principal: AGENT });
  assert.ok(a.admitted);
  h.session.attach(GUI, 'gui');
  assert.equal(code(() => h.session.signal('SIGINT', GUI)), 'not_controller', 'without asOwner the GUI is an observer');
  h.session.signal('SIGINT', GUI, { asOwner: true });
  assert.equal(h.session.currentController, GUI, 'owner-priority: the owner\'s override');
  await h.session.close();

  const s = await harness({ control: 'seat' });
  const b = s.session.admit({ target: 'shell', line: 'sleep 9', principal: AGENT });
  assert.ok(b.admitted);
  assert.equal(code(() => s.session.takeControl(GUI)), 'not_controller');
  s.session.takeControl(GUI, { asOwner: true });
  assert.equal(s.session.currentController, GUI);
  s.session.input('\x03', { principal: GUI });
  s.session.resize(100, 30, GUI, { asOwner: true });
  s.session.releaseControl(GUI);
  s.session.takeControl(AGENT);
  const c = await s.session.cancel(b.run.runId, GUI, { graceMs: 20, asOwner: true });
  assert.ok(['cancelled', 'exited'].includes(c.state), JSON.stringify(c));
  assert.equal(s.session.currentController, AGENT, 'cancelling with the owner\'s rights takes no seat');
  await s.session.close();
});

// ───────────── m2-2: secrets typed at a password prompt ─────────────

test('m2-2: input typed at a prompt asking for a secret is journaled redacted until Enter, and never becomes a Run\'s line', async () => {
  const h = await harness({ setup: (s) => s.on(/^sudo/, () => ({ output: '[sudo] password for aster: ', hang: true })) });
  const a = h.session.admit({ target: 'shell', line: 'sudo make install', principal: AGENT });
  assert.ok(a.admitted);
  await h.session.screen.settled();
  h.session.releaseControl(AGENT);
  for (const ch of 'hunter2-S3cret') h.session.input(ch, { principal: HUMAN });
  h.session.input('\r', { principal: HUMAN });
  const inputs = ofType(h.journal.since(0).events, 'input').filter((e) => e.principal === HUMAN);
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every((e) => e.data === '[redacted]' && e.sensitive === true), JSON.stringify(inputs.map((e) => e.data)));
  assert.ok(!JSON.stringify(h.journal.since(0).events).includes('hunter2'));
  h.shell.finishHung(0, '\r\ninstalled\r\n');
  await tick();
  h.session.input('ls', { principal: HUMAN });
  const after = ofType(h.journal.since(0).events, 'input').at(-1)!;
  assert.equal(after.data, 'ls', 'after Enter and a new prompt, typing is ordinary again');
  await h.session.close();
});

test('m2-2: the secret-prompt test on realistic prompts (false positives measured)', () => {
  const secret = [
    'Password:',
    '[sudo] password for aster: ',
    "aster@build-01's password: ",
    "Enter passphrase for key '/Users/aster/.ssh/id_ed25519': ",
    'Passphrase: ',
    "Password for 'https://aster@github.com': ",
    'Enter password: ',
    'Password for user postgres: ',
    'Enter one-time password: ',
    'Enter PIN for PIV Card Holder pin (PIV_II): ',
    'Token (will be hidden): ',
    'AWS Secret Access Key [None]: ',
    'Enter your API key: ',
    'Verification code: ',
    'New password: ',
    'Retype new password: ',
    'Enter the password for aster@example.com at my.1password.com: ',
    '│ Passphrase: ',
  ];
  const ordinary = [
    'Username: ',
    "Username for 'https://github.com': ",
    'login: ',
    'Name: ',
    'Continue? [y/N] ',
    'Proceed (y/n)? ',
    '>>> ',
    'mysql> ',
    '$ ',
    'aster@host ~/src/token-service % ',
    'Enter file name: ',
    'Shipping address: ',
    'Pinned version: ',
    'Tokenizer mode: ',
    'Spinning up workers: ',
    'error: unexpected token',
    'Choose an option [1-3]: ',
    'Enter commit message: ',
    'Select a pinned tab: ',
    'Description: ',
  ];
  const missed = secret.filter((l) => !looksLikeSecretPrompt(l));
  const falsePositives = ordinary.filter((l) => looksLikeSecretPrompt(l));
  assert.deepEqual(missed, [], 'every secret prompt is recognised');
  assert.deepEqual(falsePositives, [], `false positives: ${falsePositives.length}/${ordinary.length}`);
});
