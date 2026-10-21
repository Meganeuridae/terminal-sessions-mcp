/**
 * The guarantee suite, core layer, against the scripted backend. Each test is
 * named for the guarantee it encodes (DESIGN.md §5). The rules added by the
 * review fixes (Runs that never start, authenticated marks, cancel steps, the seat
 * across reconnects, …) are in session-rules.spec.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScriptedProcess } from '../src/backends/scripted.js';
import type { Journal } from '../src/core/journal.js';
import type { JournalEvent } from '../src/core/types.js';
import { clocks } from '../src/core/clock.js';
import { Segmenter, type Segment } from '../src/core/segmenter.js';
import { AGENT, HUMAN, scriptedSession as harness, until } from './fake-shell.js';

const types = (j: Journal, from = 0) => j.since(from).events.map((e) => e.type);
const outputs = (j: Journal) => j.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output');
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test('G1/G2/G12: a shell Run has an id before anything is written, an observed exit, and temporally attributed output', async () => {
  const h = await harness();
  const before = h.pty.writes.length;
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  const admitEv = h.journal.since(0).events.find((e) => e.type === 'run.admit')!;
  assert.ok(admitEv, 'admit journaled');
  assert.ok(h.pty.writes.length > before, 'line written after admission');
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 0);
  assert.equal(r.line, 'echo hello');
  const attributed = outputs(h.journal).filter((e) => e.runId === r.runId);
  assert.ok(attributed.length > 0);
  assert.ok(attributed.every((e) => e.attribution === 'temporal'));
  const t = await h.session.runTranscript(r.runId);
  assert.equal(t.text, 'hello');
  assert.deepEqual(types(h.journal).filter((x) => x.startsWith('run.')), ['run.admit', 'run.start', 'run.end']);
  await h.session.close();
});

test('G3: a caller\'s deadline never changes a Run\'s state', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  const r1 = await h.session.awaitRun(a.run.runId, 30);
  assert.equal(r1.state, 'running');
  assert.equal(h.session.run(a.run.runId).state, 'running');
  h.shell.finishHung(0, 'done\r\n');
  const r2 = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r2.state, 'exited');
  await h.session.close();
});

test('G4: a shell Run is admitted only when the shell is available; process Runs never occupy it', async () => {
  const h = await harness();
  const first = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(first.admitted);
  const second = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(!second.admitted);
  if (!second.admitted) {
    assert.equal(second.reason, 'running');
    assert.equal(second.busy?.runId, first.run.runId);
  }
  h.backend.onSpawnProcess = (p) => queueMicrotask(() => p.exit({ exitCode: 0 }));
  const proc = h.session.admit({ target: 'process', argv: ['true'], principal: AGENT });
  assert.ok(proc.admitted, 'process Run admitted while the shell is busy');
  h.shell.finishHung(0);
  await h.session.close();
});

test('G4: a queued Run advances only after the Run ahead ended AND a prompt confirmed the shell', async () => {
  const h = await harness({ setup: (s) => s.on('echo second', () => ({ hang: true })) });
  const first = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(first.admitted);
  const queued = h.session.admit({ target: 'shell', line: 'echo second', principal: AGENT, queue: true });
  assert.ok(queued.admitted);
  assert.equal(queued.run.state, 'queued');
  h.shell.finishHung(0, undefined, { prompt: false }); // end mark, no prompt yet
  await tick();
  assert.equal(h.session.run(first.run.runId).state, 'exited');
  assert.equal(h.session.run(queued.run.runId).state, 'queued', 'must not start before a prompt');
  h.shell.promptNow();
  await tick();
  assert.equal(h.session.run(queued.run.runId).state, 'running');
  h.shell.finishHung(0);
  await h.session.close();
});

test('G4: a queued Run is dated from its start, not its admission: what reads its duration as its run.start is dispatched (the segmenter) counts none of the time it queued', async (t) => {
  // The house's read of the 33 commits (#22, comment 6307351104), item 10: run.start was appended before the start's monotonic
  // stamp was set, so the segmenter's digests said "running … Ns" counting the time the Run waited for the shell.
  const realMono = clocks.monotonic;
  let queuedFor = 0;
  t.mock.method(clocks, 'monotonic', () => realMono() + queuedFor);
  const h = await harness({ setup: (s) => s.on('echo second', () => ({ hang: true })) });
  try {
    const first = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
    const queued = h.session.admit({ target: 'shell', line: 'echo second', principal: AGENT, queue: true });
    assert.ok(first.admitted && queued.admitted);
    let atStart: number | undefined;
    const off = h.journal.subscribe((ev) => {
      if (ev.type === 'run.start' && ev.runId === queued.run.runId) atStart = h.session.runDurationMs(ev.runId);
    });
    queuedFor = 60_000;
    h.shell.finishHung(0);
    await until(() => atStart !== undefined, 3000, 'the queued Run started');
    off();
    assert.ok(atStart! < 1000, `${atStart} ms at its start`);
    h.shell.finishHung(0);
  } finally {
    await h.session.close();
  }
});

test('G3/G4: a prompt without an end mark makes the Run `lost`, never `exited`', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  h.pty.emit(h.shell.mark('133;A') + '$ ' + h.shell.mark('133;B'));
  const r = h.session.run(a.run.runId);
  assert.equal(r.state, 'lost');
  assert.equal(r.reason, 'prompt-without-end-mark');
  assert.equal(r.exit, undefined);
  assert.ok(h.session.shellAvailable().ok, 'the prompt confirmed availability');
  await h.session.close();
});

test('G5: integration level is observed: rich, basic, none', async () => {
  const rich = await harness({ marks: 'rich' });
  assert.equal(rich.session.integration, 'rich');
  await rich.session.close();
  const basic = await harness({ marks: 'basic' });
  const a = basic.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  await basic.session.awaitRun(a.run.runId, 1000);
  assert.equal(basic.session.integration, 'basic');
  await basic.session.close();
  const none = await harness({ marks: 'none' });
  assert.equal(none.session.integration, 'none');
  await none.session.close();
});

test('G5/§8.1 fallback: without marks the marker strategy still yields an observed exit and a clean transcript', async () => {
  // A line that returns 7 without exiting the shell (the house's read of a6d0c35, #22: the test used
  // `exit 7`, which a real shell would obey by exiting, and relied on the FakeShell treating it as a return).
  const h = await harness({ marks: 'none', setup: (s) => s.on('printf hi', () => ({ output: 'hi', exit: 0 })).on('status7', () => ({ exit: 7 })) });
  const a = h.session.admit({ target: 'shell', line: 'printf hi', principal: AGENT });
  assert.ok(a.admitted);
  const written = h.pty.written;
  // ss-5: `command .`, so a syntax or special-builtin error in the file cannot abandon the marker.
  assert.match(written, /^ command \. '.*tsm-cmd.*'; echo "<<<EXI""T:[0-9a-f]+:\$\?>>>"\n$/);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 0);
  const t = await h.session.runTranscript(r.runId);
  assert.equal(t.text, 'hi');
  const b = h.session.admit({ target: 'shell', line: 'status7', principal: AGENT });
  assert.ok(b.admitted);
  assert.equal((await h.session.awaitRun(b.run.runId, 1000)).exit, 7);
  await h.session.close();
});

test('G6: multi-line bodies are delivered intact through the temp-file route', async () => {
  const body = 'cat <<EOF\nline-one\nline-two\nEOF';
  const h = await harness({ setup: (s) => s.on(body, () => ({ output: 'line-one\r\nline-two\r\n', exit: 0 })) });
  const a = h.session.admit({ target: 'shell', line: body, principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.exit, 0);
  assert.deepEqual(h.shell.executed, [body]);
  assert.match(h.pty.written, /^(?:\x1b\[2[34];8~)+ \. '/, 'the clear keys, then the source line');
  assert.equal((await h.session.runTranscript(r.runId)).text, 'line-one\nline-two');
  await h.session.close();
});

test('G7: process Runs name their environment basis, observe exit directly, and keep streams separate', async () => {
  const h = await harness();
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
    p.emitStdout('out\n');
    p.emitStderr('err\n');
    p.exit({ exitCode: 3 });
  };
  const a = h.session.admit({ target: 'process', argv: ['thing', '--x'], principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(r.state, 'exited');
  assert.equal(r.exit, 3);
  assert.equal(r.envBasis, 'configured');
  assert.equal(r.attribution, 'exact');
  assert.equal(proc.opts.cwd, '/home/t');
  assert.equal(proc.opts.env.SESSION_VAR, 'yes');
  assert.equal(proc.opts.env.PATH, '/bin');
  const evs = outputs(h.journal).filter((e) => e.runId === r.runId);
  assert.deepEqual(
    evs.map((e) => [e.stream, e.data, e.attribution]),
    [
      ['stdout', 'out\n', 'exact'],
      ['stderr', 'err\n', 'exact'],
    ],
  );
  // Snapshot basis after an explicit capture.
  const snap = await h.session.captureEnv(AGENT);
  assert.deepEqual(snap.vars, { A: '1', B: 'two' });
  h.backend.onSpawnProcess = (p) => {
    proc = p;
    p.exit({ exitCode: 0 });
  };
  const b = h.session.admit({ target: 'process', argv: ['thing'], principal: AGENT, envBasis: 'snapshot' });
  assert.ok(b.admitted);
  const rb = await h.session.awaitRun(b.run.runId, 1000);
  assert.equal(rb.envBasis, 'snapshot');
  assert.equal(proc.opts.env.A, '1');
  assert.equal(proc.opts.env.SESSION_VAR, undefined);
  await h.session.close();
});

test('G4/G8: a principal typing at the prompt makes the shell unavailable; their command becomes a Run with their origin', async () => {
  const h = await harness({ control: 'open', setup: (s) => s.on('ls', () => ({ output: 'a b\r\n', exit: 0 })) });
  h.session.releaseControl(AGENT);
  h.session.attach(HUMAN, 'c2', 'controller'); // typing needs the seat even under `open` (§9)
  h.session.input('ls', { principal: HUMAN });
  const blocked = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(!blocked.admitted);
  if (!blocked.admitted) assert.equal(blocked.reason, 'human-editing');
  h.session.input('\n', { principal: HUMAN });
  await tick();
  const human = h.session.listRuns().find((r) => r.origin === 'human');
  assert.ok(human, 'a Run was created for the typed command');
  assert.equal(human.line, 'ls');
  assert.equal(human.principal, HUMAN);
  assert.equal(human.state, 'exited');
  const ok = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(ok.admitted, 'available again after the prompt');
  await h.session.awaitRun(ok.run.runId, 1000);
  await h.session.close();
});

test('G14: the screen is read without touching the PTY', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted);
  await h.session.awaitRun(a.run.runId, 1000);
  await h.session.screen.settled();
  const writes = h.pty.writes.length;
  const snap = h.session.snapshot();
  assert.equal(h.pty.writes.length, writes);
  assert.ok(snap.lines.some((l) => l.includes('hello')));
  assert.equal(snap.seq, h.journal.lastSeq);
  await h.session.close();
});

test('G16–G18: one controller; observers cannot type; the owner takes the free seat; explicit release and detach free it', async () => {
  const h = await harness({ seatGraceMs: 0 });
  assert.equal(h.session.currentController, AGENT);
  const obs = h.session.attach(HUMAN, 'c2');
  assert.equal(obs.role, 'observer');
  assert.throws(() => h.session.input('x', { principal: HUMAN }), /controller seat/);
  assert.throws(() => h.session.takeControl(HUMAN), /seat held/);
  h.session.releaseControl(AGENT);
  h.session.takeControl(HUMAN);
  assert.equal(h.session.currentController, HUMAN);
  h.session.input('y', { principal: HUMAN });
  h.session.detach(obs.attachmentId);
  assert.equal(h.session.currentController, null, 'with no grace, detaching the seat holder releases the seat');
  const control = h.journal.since(0).events.filter((e) => e.type === 'control');
  assert.deepEqual(
    control.map((e) => (e as Extract<JournalEvent, { type: 'control' }>).how),
    ['auto', 'release', 'take', 'release'],
  );
  await h.session.close();
});

test('G17 (ux-10): the owner may always take the seat over explicitly; owner-priority also overrides on run and input, seat does not', async () => {
  const seat = await harness({ control: 'seat' });
  seat.session.releaseControl(AGENT);
  seat.session.attach(HUMAN, 'c2', 'controller');
  assert.throws(() => seat.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT }), /held by human:test:1.*as the owner you can take it over/);
  seat.session.takeControl(AGENT);
  assert.equal(seat.session.currentController, AGENT, 'the owner override (control take)');
  await seat.session.close();
  const op = await harness({ control: 'owner-priority' });
  op.session.releaseControl(AGENT);
  op.session.attach(HUMAN, 'c2', 'controller');
  const a = op.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(a.admitted, 'under owner-priority the owner\'s run takes the seat');
  assert.equal(op.session.currentController, AGENT);
  const control = op.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'control' }> => e.type === 'control');
  assert.equal(control[control.length - 1]!.how, 'override');
  await op.session.close();
});

test('G22/G28: cursors are per principal and monotonic; outcome delivery is recorded per Run', async () => {
  const h = await harness();
  h.session.markRead(AGENT, 10);
  h.session.markRead(AGENT, 4);
  h.session.markDelivered(AGENT, 7);
  assert.deepEqual(h.session.cursorsOf(AGENT), { delivered: 7, read: 10 });
  assert.deepEqual(h.session.cursorsOf(HUMAN), { delivered: 0, read: 0 });
  h.session.markOutcomeDelivered('r1', AGENT);
  assert.equal(h.session.outcomeDeliveredTo('r1', AGENT), true);
  assert.equal(h.session.outcomeDeliveredTo('r1', HUMAN), false);
  await h.session.close();
});

test('G25: the daemon answers terminal queries itself and journals the reply as system input', async () => {
  const h = await harness();
  h.pty.emit('\x1b[6n');
  await h.session.screen.settled();
  await tick();
  assert.ok(h.pty.writes.some((w) => /^\x1b\[\d+;\d+R$/.test(w)), 'cursor position report written to the PTY');
  const reply = h.journal.since(0).events.find((e) => e.type === 'input' && e.kind === 'protocol-reply');
  assert.ok(reply);
  assert.equal((reply as Extract<JournalEvent, { type: 'input' }>).principal, 'system');
  await h.session.close();
});

test('G26: sensitive input is journaled redacted and still reaches the PTY', async () => {
  const h = await harness();
  h.session.input('hunter2\n', { principal: AGENT, sensitive: true });
  const ev = h.journal.since(0).events.find((e) => e.type === 'input' && e.principal === AGENT) as Extract<JournalEvent, { type: 'input' }>;
  assert.equal(ev.data, '[redacted]');
  assert.equal(ev.sensitive, true);
  assert.ok(h.pty.written.includes('hunter2'));
  await h.session.close();
});

test('G29: process cancel signals the group on a schedule and observes the exit', async () => {
  const h = await harness();
  let proc!: ScriptedProcess;
  h.backend.onSpawnProcess = (p) => {
    proc = p;
    const orig = p.kill.bind(p);
    p.kill = (sig) => {
      orig(sig);
      if (sig === 'SIGTERM') p.exit({ exitCode: null, signal: 'SIGTERM' });
    };
  };
  const a = h.session.admit({ target: 'process', argv: ['sleep', '100'], principal: AGENT });
  assert.ok(a.admitted);
  await tick();
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 20 });
  assert.equal(c.contract, 'process');
  assert.equal(c.state, 'cancelled');
  assert.deepEqual(proc.kills, ['SIGINT', 'SIGTERM']);
  assert.deepEqual(c.steps, ['SIGINT → process group', 'SIGTERM → process group']);
  assert.equal(h.session.run(a.run.runId).signal, 'SIGTERM');
  await h.session.close();
});

test('G29: shell cancel types ^C, reports cancelled only on the end mark, and escalates explicitly otherwise', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(a.admitted);
  const c = await h.session.cancel(a.run.runId, AGENT, { graceMs: 50 });
  assert.equal(c.contract, 'shell');
  assert.equal(c.state, 'cancelled');
  assert.equal(h.session.run(a.run.runId).exit, 130);
  assert.equal(c.escalation, undefined);
  assert.deepEqual(c.steps, ['^C']);
  await h.session.close();

  // A job that ignores ^C, ^\ and even its group's SIGTERM/SIGKILL: cancel: failed.
  const stubborn = await harness({ ignoreSignals: true, ignoreGroupSignals: true });
  const b = stubborn.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  assert.ok(b.admitted);
  const cb = await stubborn.session.cancel(b.run.runId, AGENT, { graceMs: 20 });
  assert.equal(cb.state, 'running');
  assert.equal(cb.escalation, 'session_close');
  assert.deepEqual(cb.steps, ['^C', '^\\', `SIGTERM → foreground process group ${stubborn.shell.jobPgid}`, `SIGKILL → foreground process group ${stubborn.shell.jobPgid}`]);
  assert.ok(stubborn.pty.written.includes('\x03') && stubborn.pty.written.includes('\x1c'));
  assert.ok(!stubborn.pty.kills.length, 'the daemon never kills the shell to cancel a job');
  assert.ok(stubborn.pty.groupKills.every(([pgid]) => pgid !== stubborn.pty.pid), 'nor signals the shell\'s own group');
  await stubborn.session.close();
});

test('G3/G20: shell death makes in-flight and queued Runs `lost`, never `exited`', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 10', principal: AGENT });
  const q = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
  assert.ok(a.admitted && q.admitted);
  h.pty.exit({ exitCode: 1 });
  assert.equal(h.session.run(a.run.runId).state, 'lost');
  assert.equal(h.session.run(a.run.runId).reason, 'shell-exited (status 1)', "the shell's own status, the clue to set -e");
  assert.equal(h.session.run(q.run.runId).state, 'lost');
  assert.equal(h.session.state, 'exited');
  const exitEv = h.journal.since(0).events.find((e) => e.type === 'session.exit');
  assert.ok(exitEv);
  const after = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(!after.admitted);
  if (!after.admitted) assert.equal(after.reason, 'exited');
  await h.session.close();
});

test('cwd follows the shell (633;P;Cwd); close sends SIGHUP', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'cd /tmp', principal: AGENT });
  assert.ok(a.admitted);
  await h.session.awaitRun(a.run.runId, 1000);
  assert.equal(h.session.cwd, '/tmp');
  await h.session.close();
  assert.deepEqual(h.pty.kills, ['SIGHUP']);
  assert.equal(h.session.state, 'exited');
});

test('a Run\'s output is exactly the output events with its runId, with cursors for paging', async () => {
  const h = await harness({ setup: (s) => s.on('big', () => ({ output: 'x'.repeat(100) + '\r\n', exit: 0 })) });
  const a = h.session.admit({ target: 'shell', line: 'big', principal: AGENT });
  assert.ok(a.admitted);
  const r = await h.session.awaitRun(a.run.runId, 1000);
  const out = h.session.runOutput(r.runId);
  assert.ok(out.events.every((e) => e.type === 'output' && e.runId === r.runId));
  assert.equal(out.truncated, false);
  const t = await h.session.runTranscript(r.runId);
  assert.equal(t.nextCursor, r.seq.end);
  await h.session.close();
});

test('a session keeps at most 1,000 ended Runs in memory; older ones are read from the journal\'s run index, and a process Run with a living group stays', async () => {
  const h = await harness();
  h.backend.onSpawnProcess = (p) => queueMicrotask(() => p.exit({ exitCode: 0 }));
  const ids: string[] = [];
  for (let i = 0; i < 1100; i++) {
    const a = h.session.admit({ target: 'process', argv: ['true'], principal: AGENT });
    assert.ok(a.admitted);
    ids.push(a.run.runId);
  }
  await until(() => h.session.run(ids.at(-1)!).state === 'exited', 5000, 'the last Run to end');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(h.session.listRuns().length <= 1000, `in memory: ${h.session.listRuns().length}`);
  assert.throws(() => h.session.run(ids[0]!), (e: { code?: string }) => e.code === 'run_not_found');
  const fromIndex = h.journal.runs.run(ids[0]!);
  assert.deepEqual([fromIndex.runId, fromIndex.state, fromIndex.exit], [ids[0], 'exited', 0]);
  assert.equal(h.session.run(ids.at(-1)!).state, 'exited', 'the newest stays');
  // A process Run whose leader exited but whose group still has a member is kept, whatever its age.
  let keep!: { groupMembers?: number; exit(e: { exitCode: number }): void };
  h.backend.onSpawnProcess = (p) => { keep = p as never; p.groupMembers = 1; queueMicrotask(() => p.exit({ exitCode: 0 })); };
  const orphaned = h.session.admit({ target: 'process', argv: ['sh', '-c', 'sleep 300 &'], principal: AGENT });
  assert.ok(orphaned.admitted);
  await until(() => h.session.run(orphaned.run.runId).state === 'exited', 3000);
  h.backend.onSpawnProcess = (p) => queueMicrotask(() => p.exit({ exitCode: 0 }));
  for (let i = 0; i < 1100; i++) h.session.admit({ target: 'process', argv: ['true'], principal: AGENT });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.session.run(orphaned.run.runId).state, 'exited', 'kept: its group still has a member');
  keep.groupMembers = 0;
  for (let i = 0; i < 10; i++) h.session.admit({ target: 'process', argv: ['true'], principal: AGENT });
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => h.session.run(orphaned.run.runId), (e: { code?: string }) => e.code === 'run_not_found', 'gone once its group is');
  await h.session.close();
});

test('a Run’s duration is measured on the monotonic clock: a wall-clock step back between its start and end journals no negative duration', async (t) => {
  // The house's read of the 38 commits (#22, comment 6274773484): endRun took durationMs from Date.now, so a step back made
  // the completion read `exit 0 in -3.0s`. Here the wall clock steps back 3 s while the Run runs, and 2.5 s pass on the
  // monotonic clock. The session reads Date.now as it was when it was built, so the stub goes in first.
  const realNow = Date.now;
  const realMono = clocks.monotonic;
  let wallStep = 0;
  let monoStep = 0;
  Date.now = () => realNow() + wallStep;
  clocks.monotonic = () => realMono() + monoStep;
  t.after(() => {
    Date.now = realNow;
    clocks.monotonic = realMono;
  });
  const h = await harness();
  try {
    const a = h.session.admit({ target: 'shell', line: 'sleep 3', principal: AGENT });
    assert.ok(a.admitted);
    await until(() => h.session.run(a.run.runId).state === 'running', 5000, 'the Run to start');
    wallStep -= 3000;
    monoStep += 2500;
    h.shell.finishHung(0, 'ok\r\n');
    assert.equal((await h.session.awaitRun(a.run.runId, 5000)).state, 'exited');
    const end = h.journal.since(0).events.find((e): e is Extract<JournalEvent, { type: 'run.end' }> => e.type === 'run.end')!;
    // The lower bound alone rules out the wall clock's measure; an upper one would fail only a stalled runner (the house's read of the 33 commits, #22, comment 6307351806).
    assert.ok(end.durationMs >= 2500, `the monotonic interval, not the wall clock's: ${end.durationMs} ms`);
  } finally {
    await h.session.close();
  }
});

test('one rule for a Run’s duration across a wall-clock step back: so far, at its end, in the run index, and in the digests of a segmenter that began after the step', async (t) => {
  // A reviewer's read of the fixes for #22: the journaled duration was monotonic, but a run result read `endedAt - startedAt`
  // (`exited 0 in -2999ms` beside a completion's 2.5s), and a segmenter that began after the step dated the Run's digests
  // from the wall-clock age of its journaled start, clamped to zero.
  const realNow = Date.now;
  const realMono = clocks.monotonic;
  let wallStep = 0;
  let monoStep = 0;
  Date.now = () => realNow() + wallStep;
  clocks.monotonic = () => realMono() + monoStep;
  t.after(() => {
    Date.now = realNow;
    clocks.monotonic = realMono;
  });
  const h = await harness();
  try {
    const a = h.session.admit({ target: 'shell', line: 'sleep 3', principal: AGENT });
    assert.ok(a.admitted);
    const id = a.run.runId;
    await until(() => h.session.run(id).state === 'running', 5000, 'the Run to start');
    wallStep -= 3000;
    monoStep += 2500;
    const seg = new Segmenter(h.session, { cadenceMs: 40 });
    t.after(() => seg.dispose());
    const out: Segment[] = [];
    seg.subscribe((s) => out.push(s));
    h.pty.emit('tick\r\n');
    await until(() => out.some((s) => s.kind === 'output'), 5000, 'a digest');
    const elapsed = out.find((s) => s.kind === 'output')!.metadata.elapsedMs as number;
    // The lower bound alone rules out the wall clock's measure; an upper one would fail only a stalled runner (the house's read of the 33 commits, #22, comment 6307351806).
    assert.ok(elapsed >= 2500, `the digest counts from the session's measure: ${elapsed} ms`);
    const sofar = h.session.runDurationMs(id)!;
    assert.ok(sofar >= 2500, `so far, on the monotonic clock: ${sofar} ms`);
    assert.equal(h.session.run(id).durationMs, undefined, 'a Run in flight carries no duration of its own');
    h.shell.finishHung(0, 'ok\r\n');
    assert.equal((await h.session.awaitRun(id, 5000)).state, 'exited');
    const end = h.journal.since(0).events.find((e): e is Extract<JournalEvent, { type: 'run.end' }> => e.type === 'run.end')!;
    assert.ok(end.durationMs >= 2500, `${end.durationMs} ms`);
    assert.equal(h.session.run(id).durationMs, end.durationMs, 'the ended Run carries the journaled duration');
    assert.equal(h.session.runDurationMs(id), end.durationMs, 'and the rule answers with it');
    assert.equal(h.session.listRuns().find((r) => r.runId === id)!.durationMs, end.durationMs, 'a listing carries it (the GUI shows it)');
    assert.equal(h.journal.runs.run(id)!.durationMs, end.durationMs, 'history’s Run, from the journal, carries the same one');
  } finally {
    await h.session.close();
  }
});
