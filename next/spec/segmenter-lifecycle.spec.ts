/**
 * The segmenter's round-2 contract against a fake session source (no PTY):
 * completions survive a dispose within the settle, lifecycle messages are rebuilt
 * from the whole journal (any life, history, a restart's recovery), ids carry the
 * journal's epoch, digests cost what they show, human input is the edited line and
 * never a secret, needs-input is journaled and does not fire on progress bars, and
 * screens flow for programs that never stop redrawing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/core/journal.js';
import { MemoryStore } from '../src/core/stores.js';
import {
  journalSource,
  liveSource,
  promptLine,
  renderPicked,
  replayNewest,
  scanLifecycle,
  segmentId,
  Segmenter,
  seqOfMessageId,
  type Segment,
  type SegmentSource,
} from '../src/core/segmenter.js';
import type { JournalEvent, RunInfo, ScreenSnapshot } from '../src/core/types.js';

const A = 'agent:a@t';
const B = 'agent:b@t';
const H = 'human:gui:aster';

type Fake = SegmentSource & { runs: Map<string, RunInfo>; screen: ScreenSnapshot };

function fakeSource(journal = new Journal({ hot: new MemoryStore(64 * 1024 * 1024) })): Fake {
  const runs = new Map<string, RunInfo>();
  const screen: ScreenSnapshot = { cols: 80, rows: 5, alt: false, cursor: { x: 0, y: 0 }, lines: ['', '', '', '', ''], title: '', seq: 0 };
  return {
    id: 's1',
    owner: A,
    journal,
    state: 'busy',
    cwd: '/w',
    currentController: A,
    runs,
    screen,
    run(runId) {
      const r = runs.get(runId);
      if (!r) throw new Error('run_not_found');
      return r;
    },
    listRuns: () => [...runs.values()],
    runTranscript: async (runId) => ({ text: `output of ${runId}`, truncated: false, seq: [1, 2], nextCursor: 2 }),
    snapshot: () => screen,
  };
}

/** Admit and start a Run in the fake: journal events plus the session's record. */
function startRun(src: Fake, runId: string, principal = A, line = `cmd-${runId}`): RunInfo {
  const admit = src.journal.append({ type: 'run.admit', runId, target: 'shell', line, principal, origin: principal.startsWith('human:') ? 'human' : 'self', queued: false });
  const start = src.journal.append({ type: 'run.start', runId, cwd: '/w', line });
  const r: RunInfo = { runId, sessionId: 's1', target: 'shell', origin: 'self', principal, state: 'running', admittedAt: admit.ts, startedAt: start.ts, seq: { admit: admit.seq, start: start.seq }, attribution: 'temporal', line };
  src.runs.set(runId, r);
  return r;
}

function endRun(src: Fake, runId: string, e: { state?: 'exited' | 'cancelled' | 'lost'; exit?: number; reason?: string } = {}): JournalEvent {
  const r = src.runs.get(runId)!;
  const ev = src.journal.append({ type: 'run.end', runId, state: e.state ?? 'exited', ...(e.exit !== undefined ? { exit: e.exit } : e.state ? {} : { exit: 0 }), ...(e.reason ? { reason: e.reason } : {}), durationMs: 5 });
  r.state = e.state ?? 'exited';
  r.seq.end = ev.seq;
  return ev;
}

const collect = (seg: Segmenter) => {
  const out: Segment[] = [];
  seg.subscribe((s) => out.push(s));
  return out;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snap = (lines: string[], x: number, y: number): ScreenSnapshot => ({ cols: 80, rows: lines.length, alt: false, cursor: { x, y }, lines, title: '', seq: 1 });
/** Catch-up over a live session: every lifecycle message after seq 0. */
const replay = async (src: Fake) => renderPicked(liveSource(src), (await scanLifecycle(liveSource(src), 0)).picked);

test('mcpl-6/m2-3: a completion still settling is emitted when the segmenter is disposed, not dropped', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 10_000 });
  const out = collect(seg);
  startRun(src, 'r1');
  const end = endRun(src, 'r1', { state: 'lost', reason: 'session-closed' });
  const disposed = seg.dispose();
  await seg.drained();
  await disposed;
  const runs = out.filter((s) => s.kind === 'run');
  assert.equal(runs.length, 1, 'the Run the close cut short is reported');
  assert.equal(runs[0]!.seq, end.seq);
  assert.ok(runs[0]!.tags.includes('terminal:run-lost'));
  src.journal.append({ type: 'note', text: 'after', principal: A });
  assert.equal(out.length, 1, 'nothing after dispose');
});

test('mcpl-4: message ids carry the journal epoch, so a re-created name never repeats one; ids parse back to their seq', async () => {
  const j1 = new Journal();
  const j2 = new Journal();
  const e1 = segmentId('s', j1, 'run', 17);
  const e2 = segmentId('s', j2, 'run', 17);
  assert.notEqual(e1, e2, 'two journals (a forgotten name and its successor) never share an id');
  assert.equal(segmentId('s', j1, 'run', 17), e1, 'stable for one journal');
  assert.match(e1, /^s~[0-9a-f]+:run:17$/);
  const withEpoch = new Journal();
  Object.defineProperty(withEpoch, 'epoch', { value: 'e9f00d', enumerable: true });
  assert.equal(segmentId('s', withEpoch, 'session-exit', 3), 's~e9f00d:session-exit:3', "the journal's own epoch wins");
  assert.equal(seqOfMessageId(`node/${e1}`), 17);
  assert.equal(seqOfMessageId('someone-else:42'), undefined);
});

test('mcpl-3: a completion after more than 50,000 other events is found (the scan pages to the end)', async () => {
  const src = fakeSource();
  startRun(src, 'bg', A, 'make build');
  for (let i = 0; i < 60_000; i++) src.journal.append({ type: 'output', data: 'x', stream: 'pty' });
  const end = endRun(src, 'bg');
  const scan = await scanLifecycle(journalSource({ id: 's1', journal: src.journal, owner: A, run: (id) => src.journal.runs.run(id) }), 0, { keep: 20 });
  assert.deepEqual(
    scan.picked.map((p) => p.ev.seq),
    [end.seq],
  );
});

test('mcpl-3: the scan keeps the newest owed events and counts the rest', async () => {
  const src = fakeSource();
  for (let i = 0; i < 30; i++) {
    startRun(src, `r${i}`);
    endRun(src, `r${i}`);
  }
  const scan = await scanLifecycle(journalSource({ id: 's1', journal: src.journal, owner: A, run: (id) => src.journal.runs.run(id) }), 0, { keep: 5 });
  assert.equal(scan.picked.length, 5);
  assert.deepEqual(
    scan.picked.map((p) => (p.ev as { runId: string }).runId),
    ['r25', 'r26', 'r27', 'r28', 'r29'],
  );
  assert.equal(scan.omitted?.count, 25);
  assert.equal(scan.omitted?.kinds.run, 25);
  assert.equal(scan.end, src.journal.lastSeq);
});

test('m2-4/mcpl-2: a restart is one recovery message with the exit it cut short folded in; the Run it made lost is a completion', async () => {
  const src = fakeSource();
  startRun(src, 'long', B, 'sleep 60');
  src.journal.append({ type: 'session.exit', code: 1 });
  endRun(src, 'long', { state: 'lost', reason: 'daemon-shutdown' });
  const rec = src.journal.append({ type: 'recovered', class: 'history-only' });
  // As a history entry sees it after the restart: the journal and its run index only.
  const history = journalSource({ id: 's1', journal: src.journal, owner: A, run: (id) => src.journal.runs.run(id) });
  const scan = await scanLifecycle(history, 0);
  const segs = await renderPicked(history, scan.picked);
  assert.deepEqual(
    segs.map((s) => s.kind),
    ['run', 'recovered'],
    'no separate session-exit: the recovery carries it',
  );
  const [lost, recovery] = segs as [Segment, Segment];
  assert.ok(lost.tags.includes('terminal:run-lost'));
  assert.match(lost.head, /`sleep 60` → outcome unknown \(daemon-shutdown\)/);
  assert.deepEqual(lost.interested, [B]);
  assert.equal(recovery.seq, rec.seq);
  assert.ok(recovery.lifecycle);
  for (const t of ['terminal:session-exited', 'terminal:recovered', 'terminal:recovered=history-only']) assert.ok(recovery.tags.includes(t), `${t} in ${recovery.tags}`);
  assert.match(recovery.head, /daemon restarted.*history only \(the shell had ended with code 1\) · 1 Run lost/);
  assert.deepEqual(recovery.interested, [B], 'the owner (added by the lane) and whoever lost a Run');
  // Channel history (backwards) folds the same way.
  const h = await replayNewest(history, { limit: 10 });
  assert.deepEqual(
    h.segments.map((s) => s.kind),
    ['run', 'recovered'],
  );
  assert.match(h.segments[1]!.head, /the shell had ended with code 1/);
});

test('ux-25: an exit a later life superseded is not caught up', async () => {
  const src = fakeSource();
  src.journal.append({ type: 'session.exit', code: 0 });
  src.journal.append({ type: 'integration', level: 'rich' }); // a new life
  startRun(src, 'n1');
  endRun(src, 'n1');
  const s = journalSource({ id: 's1', journal: src.journal, owner: A, run: (id) => src.journal.runs.run(id) });
  const skip = await scanLifecycle(s, 0);
  assert.deepEqual(
    skip.picked.map((p) => p.ev.type),
    ['run.end'],
  );
  // The current life's own exit is news.
  src.journal.append({ type: 'session.exit', code: 3 });
  const now = await scanLifecycle(s, 0);
  assert.deepEqual(
    now.picked.map((p) => p.ev.type),
    ['run.end', 'session.exit'],
  );
});

test("mcpl-18/mcpl-6: a live session's replay renders Runs of an earlier life from the journal", async () => {
  const src = fakeSource();
  // An earlier life's Run: in the journal, unknown to the current Session.
  src.journal.append({ type: 'run.admit', runId: 'old', target: 'shell', line: 'echo from-before', principal: A, origin: 'self', queued: false });
  src.journal.append({ type: 'run.start', runId: 'old', cwd: '/w' });
  src.journal.append({ type: 'output', data: 'from-before\r\n', stream: 'pty', runId: 'old' });
  src.journal.append({ type: 'run.end', runId: 'old', state: 'exited', exit: 0, durationMs: 3 });
  const r = await replay(src);
  assert.equal(r.length, 1);
  assert.match(r[0]!.head, /`echo from-before` → exit 0/);
  assert.match(r[0]!.body ?? '', /from-before/);
});

test('er-3/mcpl-11/m2-17: a digest never reads the journal; it shows the last lines as they arrived, escapes split across chunks stripped', async () => {
  const src = fakeSource();
  startRun(src, 'svc', A, 'npm run dev');
  const seg = new Segmenter(src, { cadenceMs: 60 });
  const out = collect(seg);
  let reads = 0;
  for (const m of ['since', 'range', 'tail'] as const) {
    const orig = src.journal[m].bind(src.journal) as (...a: unknown[]) => unknown;
    (src.journal as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
      reads++;
      return orig(...a);
    };
  }
  let big = '';
  for (let i = 0; i < 20_000; i++) big += `log line ${i}\n`;
  src.journal.append({ type: 'output', data: big, stream: 'pty', runId: 'svc' });
  src.journal.append({ type: 'output', data: 'tick \x1b[3', stream: 'pty', runId: 'svc' });
  src.journal.append({ type: 'output', data: '2mgreen\x1b[0m\r\nprogress 10%\rprogress 90%', stream: 'pty', runId: 'svc' });
  await sleep(150);
  const digest = out.filter((s) => s.kind === 'output').at(-1);
  assert.ok(digest, 'a digest');
  assert.equal(reads, 0, 'no journal read for a digest');
  const lines = digest.body!.split('\n');
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.slice(-3), ['log line 19999', 'tick green', 'progress 90%']);
  assert.equal(seg.unreadBytes('svc', 0), Buffer.byteLength(big) + 'tick \x1b[3'.length + '2mgreen\x1b[0m\r\nprogress 10%\rprogress 90%'.length);
  const second = src.journal.lastSeq;
  assert.equal(seg.unreadBytes('svc', second), 0);
  seg.dispose();
});

test('mcpl-14/mcpl-15: a note is an ambient segment authored by its publisher; human input is ambient too', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  const n = src.journal.append({ type: 'note', text: 'please do not deploy', principal: B, channel: 'terminal:s1' });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'note');
  assert.equal(out[0]!.lifecycle, false);
  assert.equal(out[0]!.author, B);
  assert.equal(out[0]!.seq, n.seq);
  assert.match(out[0]!.head, /note from agent:b@t: please do not deploy/);
  src.screen.lines = ['> hi', '', '', '', ''];
  src.screen.cursor = { x: 4, y: 0 };
  src.journal.append({ type: 'input', data: 'hi\r', principal: H, kind: 'text' });
  await sleep(400);
  const human = out.find((s) => s.kind === 'human-input');
  assert.ok(human);
  assert.equal(human.lifecycle, false, 'human input never wakes a closed channel');
  seg.dispose();
});

test('m2-22: human input is the edited line: erasures, ^U, ^W, ^C and cursor keys applied, not raw keystrokes', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.screen.lines = ['>>> ', '', '', '', ''];
  src.screen.cursor = { x: 4, y: 0 };
  for (const k of ['s', 'e', 'c', 'r', 't', 'e', '\x7f', '\x7f', 'e', 't', '\x1bOA', '\x1b[D']) src.journal.append({ type: 'input', data: k, principal: H, kind: 'keys' });
  // The REPL echoed the edited line.
  src.screen.lines = ['>>> secret', '', '', '', ''];
  src.screen.cursor = { x: 10, y: 0 };
  src.journal.append({ type: 'input', data: '\r', principal: H, kind: 'keys' });
  await sleep(400);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed: secret$/);
  out.length = 0;
  src.screen.lines = ['>>> keep this', '>>> ', '', '', ''];
  src.screen.cursor = { x: 4, y: 1 };
  src.journal.append({ type: 'input', data: 'rm -rf \x15drop this\x03keep that\x17this\r', principal: H, kind: 'text' });
  await sleep(400);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed: keep this$/);
  seg.dispose();
});

test('m2-2: an answer to a password prompt, or a line the program never echoed, is never shown', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.screen.lines = ['[sudo] password for aster: ', '', '', '', ''];
  src.screen.cursor = { x: 27, y: 0 };
  src.journal.append({ type: 'input', data: 'hunter2-S3cret\r', principal: H, kind: 'text' });
  await sleep(400);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed: \[sensitive input\]$/);
  assert.doesNotMatch(JSON.stringify(out[0]), /hunter2/);
  out.length = 0;
  // `read -s` with a prompt that says nothing: the program does not echo, so the text is not on the screen.
  src.screen.lines = ['Answer? ', '', '', '', ''];
  src.screen.cursor = { x: 8, y: 0 };
  src.journal.append({ type: 'input', data: 'tok-123456\r', principal: H, kind: 'text' });
  await sleep(400);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed: \[input not echoed — not shown\]$/);
  assert.doesNotMatch(JSON.stringify(out[0]), /tok-123456/);
  seg.dispose();
});

test('mcpl-15: several lines typed in a burst are one message', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.screen.lines = ['> one', '> two', '> three', '> ', ''];
  src.screen.cursor = { x: 2, y: 3 };
  for (const l of ['one\r', 'two\r', 'three\r']) {
    src.journal.append({ type: 'input', data: l, principal: H, kind: 'text' });
    await sleep(50);
  }
  await sleep(450);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed 3 lines: one ⏎ two ⏎ three$/);
  seg.dispose();
});

test('m2-23: needs-input fires on prompts, not on stalled progress bars or labels', () => {
  const at = (line: string) => promptLine(snap([line, ''], line.length, 0));
  for (const p of ['Continue? [y/N] ', 'Enter your name: ', 'Password:', '>>> ', 'mysql> ', 'sh-3.2$ ', 'Overwrite config (yes/no) ', 'In [3]: ', '(Pdb) ']) assert.ok(at(p) !== undefined, `prompt: ${JSON.stringify(p)}`);
  for (const n of ['[#####     ]', 'Downloading assets:', '45% [====>     ] ETA 3s', '100%', 'Building...', 'Step 3/10 : RUN npm ci']) assert.equal(at(n), undefined, `not a prompt: ${JSON.stringify(n)}`);
  assert.equal(promptLine(snap(['Name?', ''], 0, 1)), 'Name?', 'a question followed by a newline, cursor on the empty line under it');
  assert.equal(promptLine(snap(['Continue? [y/N] more text', ''], 5, 0)), undefined, 'the cursor is not at the end of the line');
});

test('m2-18: needs-input is journaled as run.waiting with its evidence, and replayed while the Run still waits', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { needsInputMs: 40 });
  const out = collect(seg);
  startRun(src, 'ask', A, "read -p 'Overwrite? [y/N] ' a");
  src.screen.lines = ['Overwrite? [y/N] ', '', '', '', ''];
  src.screen.cursor = { x: 17, y: 0 };
  src.screen.seq = src.journal.append({ type: 'output', data: 'Overwrite? [y/N] ', stream: 'pty', runId: 'ask' }).seq;
  await sleep(150);
  const waiting = src.journal.since(0).events.filter((e) => e.type === 'run.waiting');
  assert.equal(waiting.length, 1, 'journaled once');
  assert.deepEqual({ ...waiting[0], seq: 0, ts: 0 }, { type: 'run.waiting', runId: 'ask', lastLine: 'Overwrite? [y/N]', silentMs: 40, state: 'busy', seq: 0, ts: 0 });
  const live = out.filter((s) => s.kind === 'needs-input');
  assert.equal(live.length, 1);
  assert.equal(live[0]!.seq, waiting[0]!.seq, 'the message reports the journaled event');
  assert.ok(live[0]!.lifecycle);
  const replayed = await replay(src);
  assert.deepEqual(
    replayed.map((s) => s.kind),
    ['needs-input'],
  );
  endRun(src, 'ask');
  const after = await replay(src);
  assert.deepEqual(
    after.map((s) => s.kind),
    ['run'],
    'once the Run ended, the question is stale',
  );
  seg.dispose();
});

test('m2-13: a program that redraws all the time still gets screens, at most one per cadence', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { screenQuietMs: 50, cadenceMs: 200, screenMaxWaitMs: 100 });
  const out = collect(seg);
  src.screen.alt = true;
  src.journal.append({ type: 'screen.mode', alt: true });
  const started = Date.now();
  let frame = 0;
  while (Date.now() - started < 750) {
    src.screen.lines = [`clock ${frame++}`, '', '', '', ''];
    src.journal.append({ type: 'output', data: `frame ${frame}`, stream: 'pty' });
    await sleep(20);
  }
  const screens = out.filter((s) => s.kind === 'screen');
  assert.ok(screens.length >= 3 && screens.length <= 5, `screens: ${screens.length}`);
  for (let i = 1; i < screens.length; i++) assert.ok(screens[i]!.ts - screens[i - 1]!.ts >= 190, 'rate-limited to the cadence');
  seg.dispose();
});

test('m2-19: a segmenter created while a full-screen program is up sends its screen', async () => {
  const src = fakeSource();
  src.screen.alt = true;
  src.screen.lines = ['htop', '', '', '', ''];
  const seg = new Segmenter(src, { screenQuietMs: 30 });
  const out = collect(seg);
  await sleep(120);
  assert.deepEqual(
    out.map((s) => s.kind),
    ['screen'],
  );
  assert.match(out[0]!.body ?? '', /htop/);
  seg.dispose();
});
