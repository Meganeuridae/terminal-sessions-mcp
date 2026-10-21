/**
 * The segmenter's round-2 contract against a fake session source (no PTY):
 * completions survive a dispose within the settle, lifecycle messages are rebuilt
 * from the whole journal (any life, history, a restart's recovery), ids carry the
 * journal's epoch, digests cost what they show, human input is the edited line and
 * never a secret, needs-input is journaled and does not fire on progress bars, and
 * screens flow for programs that never stop redrawing.
 */
import { cleanLine } from '../src/core/ansi.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Journal } from '../src/core/journal.js';
import { FileStore, MemoryStore } from '../src/core/stores.js';
import {
  columnIndex,
  journalSource,
  liveSource,
  promptLine,
  renderPicked,
  replayNewest,
  scanLifecycle,
  segmentId,
  Segmenter,
  seqOfMessageId,
  tailBytes,
  type ReplaySource,
  type Segment,
  type SegmentSource,
} from '../src/core/segmenter.js';
import { clocks } from '../src/core/clock.js';
import type { JournalEvent, RunInfo, ScreenSnapshot } from '../src/core/types.js';
import { sleep, until } from './testhost.js';

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
    // A fake holds no monotonic stamps: a digest counts from when the segmenter began tracking.
    runDurationMs: () => undefined,
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
/** The output digest that counts `bytes` of the Run's output: the one a phase's appends produce, once it comes. */
async function digestOf(out: Segment[], bytes: number): Promise<Segment> {
  const of = () => out.find((s) => s.kind === 'output' && s.metadata.bytes === bytes);
  await until(() => of() !== undefined, 5000, `a digest of ${bytes} bytes`);
  return of()!;
}
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
  // The seq is read only from an id of this session and this journal's epoch: by the suffix's shape alone,
  // another session's or another epoch's id paged this journal (the house's read of 78c4d6e, #22).
  assert.equal(seqOfMessageId(e1, 's', j1), 17);
  assert.equal(seqOfMessageId(e2, 's', j1), undefined, 'another epoch of the name');
  assert.equal(seqOfMessageId(e1, 'other', j1), undefined, 'another session');
  assert.equal(seqOfMessageId(`node/${e1}`, 's', j1), undefined, 'a qualified id is the lane\'s to strip');
  assert.equal(seqOfMessageId('someone-else:42', 's', j1), undefined);
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

test('m2-22: human input is the edited line: erasures, ^U, ^W and ^C applied, not raw keystrokes; a line that met a cursor or history key is not shown', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  const typed = async (keys: string[], echoed: string, kind: 'keys' | 'text' = 'keys') => {
    out.length = 0;
    for (const k of keys) src.journal.append({ type: 'input', data: k, principal: H, kind });
    // The REPL echoed the edited line.
    src.screen.lines = [echoed, '', '', '', ''];
    src.screen.cursor = { x: echoed.length, y: 0 };
    src.journal.append({ type: 'input', data: '\r', principal: H, kind });
    await sleep(400);
    assert.equal(out.length, 1);
    return out[0]!.head;
  };
  const at = (prompt: string) => {
    src.screen.lines = [prompt, '', '', '', ''];
    src.screen.cursor = { x: prompt.length, y: 0 };
  };
  at('>>> ');
  assert.match(await typed(['s', 'e', 'c', 'r', 't', 'e', '\x7f', '\x7f', 'e', 't'], '>>> secret'), /typed: secret$/, 'erasures applied');
  at('>>> ');
  assert.match(await typed(['rm -rf \x15keep this'], '>>> keep this', 'text'), /typed: keep this$/, '^U alone clears the line');
  at('>>> ');
  assert.match(await typed(['drop this\x03keep that\x17this'], '>>> keep this', 'text'), /typed: keep this$/, '^C abandons, ^W erases a word');
  // Up recalled `x = 1`, then `0` was typed: the screen shows `x = 10`, the keystrokes alone say `0`
  // (the house's read of 3eade8a, #22: it was reported as `typed: 0`).
  at('>>> ');
  assert.match(await typed(['\x1b[A', '0'], '>>> x = 10'), /typed: \[input edited with cursor, history or completion keys — not shown\]$/);
  assert.doesNotMatch(JSON.stringify(out[0]), /typed: 0/);
  // Tab completion changed the line too; Left then typing likewise.
  at('$ ');
  assert.match(await typed(['ls /tm', '\t'], '$ ls /tmp/', 'text'), /not shown\]$/);
  at('$ ');
  assert.match(await typed(['ab', '\x1bOD', 'X'], '$ aXb'), /not shown\]$/);
  // ^U after such keys starts a clean line: what follows is known again.
  at('$ ');
  assert.match(await typed(['\x1b[A', '\x15', 'echo hi'], '$ echo hi', 'text'), /typed: echo hi$/);
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

// ───────────── the house's read of 3eade8a (#22): the segmenter ─────────────

test('an output chunk that starts with a bare newline is split like any other (it hung the journal append)', async () => {
  const src = fakeSource();
  startRun(src, 'nl');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  const out = collect(seg);
  src.journal.append({ type: 'output', data: 'abc\n', stream: 'pty', runId: 'nl' });
  src.journal.append({ type: 'output', data: '\nhello\n', stream: 'pty', runId: 'nl' });
  src.journal.append({ type: 'output', data: '\n', stream: 'pty', runId: 'nl' });
  src.journal.append({ type: 'output', data: '\n\n\nend', stream: 'pty', runId: 'nl' });
  await sleep(100);
  const digest = out.filter((s) => s.kind === 'output').at(-1);
  assert.deepEqual(digest?.body?.split('\n'), ['abc', 'hello', 'end']);
  seg.dispose();
});

test('a long output cut to its tail keeps a torn line that is most of the budget, marked; a short truncated transcript still says so', async () => {
  const noteish = `${'x'.repeat(5000)}\nEND`;
  const t1 = tailBytes(noteish, 4096);
  assert.ok(t1.startsWith('…xxx') && t1.endsWith('\nEND') && t1.length > 4000, `kept the torn line: ${t1.length} chars`);
  const oneLine = `${JSON.stringify({ k: 'v'.repeat(10_000) })}\n`;
  const t2 = tailBytes(oneLine, 4096);
  assert.ok(t2.startsWith('…') && t2.endsWith('"}\n') && t2.length > 4000, 'a single long line is not kept as nothing');
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const t3 = tailBytes(lines, 4096);
  assert.ok(t3.startsWith('line ') && !t3.includes('…'), 'whole lines when they fill the budget');
  // The Run's message: a transcript the session already cut gets the omission line and says so in its metadata.
  const src = fakeSource();
  src.runTranscript = async () => ({ text: 'tail only', truncated: true, seq: [1, 2], nextCursor: 2 });
  const seg = new Segmenter(src, { runSettleMs: 5 });
  const out = collect(seg);
  startRun(src, 'cut');
  endRun(src, 'cut');
  await sleep(60);
  assert.equal(out.length, 1);
  assert.match(out[0]!.body ?? '', /^\[… earlier output omitted · read session=s1 runId=cut for all of it\]\ntail only$/);
  assert.equal(out[0]!.metadata.truncated, true);
  // One 10 KB line ending in a newline: its tail is shown under the omission line, not nothing.
  src.runTranscript = async () => ({ text: oneLine, truncated: false, seq: [1, 2], nextCursor: 2 });
  out.length = 0;
  startRun(src, 'json');
  endRun(src, 'json');
  await sleep(60);
  assert.match(out[0]!.body ?? '', /omitted[^\n]*\n…v+"}\n$/);
  seg.dispose();
});

test('segments go out in seq order: a note journaled while a completion settles waits for it', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 60 });
  const out = collect(seg);
  startRun(src, 'r1');
  const end = endRun(src, 'r1');
  const note = src.journal.append({ type: 'note', text: 'meanwhile', principal: B });
  assert.equal(out.length, 0, 'the note waits');
  await sleep(150);
  assert.deepEqual(
    out.map((s) => [s.kind, s.seq]),
    [
      ['run', end.seq],
      ['note', note.seq],
    ],
  );
  // Two completions settling: the one whose text is slow still goes first. The segmenter asks for both texts at once, and the
  // wait is for the fast one's to have come back while the slow one's is pending: after a fixed sleep, nothing out could mean
  // nothing had been asked for yet (a reviewer's read of the fixes for #22).
  out.length = 0;
  let slow = true;
  const asked = new Set<string>();
  const answered = new Set<string>();
  src.runTranscript = async (runId) => {
    asked.add(runId);
    if (runId === 'slow') while (slow) await sleep(5);
    answered.add(runId);
    return { text: `output of ${runId}`, truncated: false, seq: [1, 2], nextCursor: 2 };
  };
  startRun(src, 'slow');
  startRun(src, 'fast');
  endRun(src, 'slow');
  endRun(src, 'fast');
  await until(() => asked.has('slow') && answered.has('fast'), 5000, "the fast one's text back while the slow one's is pending");
  await sleep(50);
  assert.equal(out.length, 0, 'the fast one waits behind the slow one');
  slow = false;
  await seg.drained();
  assert.deepEqual(
    out.map((s) => s.runId),
    ['slow', 'fast'],
  );
  seg.dispose();
});

test('typed text is shown only when the screen shows it after its prompt: a number already on the screen is not the echo of a number typed with echo off', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.screen.lines = ['Listening on 4821', 'Port to use: ', '', '', ''];
  src.screen.cursor = { x: 13, y: 1 };
  src.journal.append({ type: 'input', data: '4821\r', principal: H, kind: 'text' });
  await sleep(400);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed: \[input not echoed — not shown\]$/);
  assert.doesNotMatch(out[0]!.head, /4821/);
  // The same number echoed after the prompt is shown.
  out.length = 0;
  src.screen.lines = ['Listening on 4821', 'Port to use: ', 'Port to use: ', '', ''];
  src.screen.cursor = { x: 13, y: 2 };
  src.journal.append({ type: 'input', data: '4821', principal: H, kind: 'text' });
  src.screen.lines[2] = 'Port to use: 4821';
  src.screen.cursor = { x: 17, y: 2 };
  src.journal.append({ type: 'input', data: '\r', principal: H, kind: 'text' });
  await sleep(400);
  assert.match(out[0]!.head, /typed: 4821$/);
  seg.dispose();
});

test('a failed transcript read, an end without a status and leftovers are each said in the completion', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5 });
  const out = collect(seg);
  src.runTranscript = async () => {
    throw new Error('store unavailable');
  };
  const run = startRun(src, 'bad');
  src.journal.append({ type: 'output', data: 'some output\r\n', stream: 'pty', runId: 'bad' });
  endRun(src, 'bad');
  await sleep(60);
  assert.equal(out.length, 1);
  assert.match(out[0]!.body ?? '', /could not be read: store unavailable · read session=s1 runId=bad to try again\]$/, 'the read it advises names the session, which read requires');
  assert.match(out[0]!.head, new RegExp(`read since=${run.seq.start! - 1}$`), 'the read cursor starts at the Run, not past its output');
  assert.equal(out[0]!.metadata.outputError, 'store unavailable');
  src.runTranscript = async (runId) => ({ text: `output of ${runId}`, truncated: false, seq: [1, 2], nextCursor: 2 });
  out.length = 0;
  startRun(src, 'nostatus');
  src.journal.append({ type: 'run.end', runId: 'nostatus', state: 'exited', durationMs: 1 });
  src.runs.get('nostatus')!.state = 'exited';
  startRun(src, 'left');
  src.journal.append({ type: 'run.end', runId: 'left', state: 'exited', exit: 0, durationMs: 1, leftovers: true });
  src.runs.get('left')!.state = 'exited';
  await sleep(80);
  assert.equal(out.length, 2);
  assert.match(out[0]!.head, /→ exit \? in/);
  assert.ok(!out[0]!.tags.some((t) => t.startsWith('terminal:exit=')), `no exit tag for an unknown status: ${out[0]!.tags.join(' ')}`);
  assert.match(out[1]!.head, /→ exit 0 in [^·]+ · left processes running \(cancel the Run to end them\) · run left/);
  assert.equal(out[1]!.metadata.leftovers, true);
  seg.dispose();
});

test('a Run already in flight when the segmenter starts: its bytes so far are counted and a prompt it waits at is noticed', async () => {
  const src = fakeSource();
  startRun(src, 'ask', A, 'read name');
  src.screen.lines = ['Name? ', '', '', '', ''];
  src.screen.cursor = { x: 6, y: 0 };
  src.screen.seq = src.journal.append({ type: 'output', data: 'Name? ', stream: 'pty', runId: 'ask' }).seq;
  const seg = new Segmenter(src, { needsInputMs: 40, cadenceMs: 30 });
  const out = collect(seg);
  assert.equal(seg.unreadBytes('ask', 0), 6);
  await sleep(120);
  assert.equal(src.journal.since(0).events.filter((e) => e.type === 'run.waiting').length, 1, 'needs-input armed for a Run already waiting');
  assert.ok(out.some((s) => s.kind === 'needs-input'));
  seg.dispose();
});

test('digests render carriage returns and backspaces as the transcript does, see a process Run through a full-screen program, and join its pipes', async () => {
  assert.equal(cleanLine('spin |\b/\b-\b\\'), 'spin \\');
  assert.equal(cleanLine('ABCDE\rXY'), 'XYCDE');
  assert.equal(cleanLine('progress 10%\rprogress 90%'), 'progress 90%');
  const src = fakeSource();
  const admit = src.journal.append({ type: 'run.admit', runId: 'p', target: 'process', argv: ['node', 'x.js'], principal: A, origin: 'self', queued: false });
  const start = src.journal.append({ type: 'run.start', runId: 'p', cwd: '/w', envBasis: 'configured' });
  src.runs.set('p', { runId: 'p', sessionId: 's1', target: 'process', origin: 'self', principal: A, state: 'running', admittedAt: admit.ts, startedAt: start.ts, seq: { admit: admit.seq, start: start.seq }, attribution: 'exact', argv: ['node', 'x.js'] });
  const seg = new Segmenter(src, { cadenceMs: 40 });
  const out = collect(seg);
  src.screen.alt = true;
  src.journal.append({ type: 'screen.mode', alt: true });
  src.journal.append({ type: 'output', data: 'abc', stream: 'stdout', runId: 'p' });
  src.journal.append({ type: 'output', data: 'def\n', stream: 'stderr', runId: 'p' });
  await sleep(100);
  const digest = out.filter((s) => s.kind === 'output').at(-1);
  assert.deepEqual(digest?.body?.split('\n'), ['abcdef'], 'one line from two pipes, while the terminal shows a full-screen program');
  src.screen.alt = false;
  src.journal.append({ type: 'screen.mode', alt: false });
  src.journal.append({ type: 'output', data: 'more\n', stream: 'stdout', runId: 'p' });
  await sleep(100);
  assert.deepEqual(out.filter((s) => s.kind === 'output').at(-1)?.body?.split('\n'), ['abcdef', 'more'], 'leaving the alternate screen keeps a process Run’s lines');
  seg.dispose();
});

test('leaving the alternate screen starts a shell Run’s line-end rule afresh: a string open before the screen took no line after it', async () => {
  // The exit cleared the watch's lines and carry but not its line-end scan, which nothing fed while the screen was up,
  // so a title left open before the full-screen program (closed while it ran) kept every line after it inside the string.
  const src = fakeSource();
  startRun(src, 'vi');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  const out = collect(seg);
  try {
    src.journal.append({ type: 'output', data: 'before\r\n\x1b]0;title', stream: 'pty', runId: 'vi' });
    src.screen.alt = true;
    src.journal.append({ type: 'screen.mode', alt: true });
    src.journal.append({ type: 'output', data: ' still the title\x07a full-screen frame\r\n', stream: 'pty', runId: 'vi' });
    src.screen.alt = false;
    src.journal.append({ type: 'screen.mode', alt: false });
    src.journal.append({ type: 'output', data: 'after\r\nnext\r\n', stream: 'pty', runId: 'vi' });
    const bytes = 'before\r\n\x1b]0;title'.length + ' still the title\x07a full-screen frame\r\n'.length + 'after\r\nnext\r\n'.length;
    assert.deepEqual((await digestOf(out, bytes)).body?.split('\n'), ['after', 'next']);
  } finally {
    seg.dispose();
  }
});

test('a digest never shows a string’s payload, though the carry is cut far inside it', async () => {
  // An OSC 52 over three events: past the second, the carry's cut (4,096 kept, safeCut's look-back the same) left
  // only the clipboard's base64, with the line-end rule still inside the string, and the digest's last line was 4,096
  // of it; the line it ended in, once the string closed, read the same way.
  const src = fakeSource();
  startRun(src, 'copy');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  const out = collect(seg);
  // Each phase reads the digest of everything appended so far, not whichever came last: a fixed sleep could read the
  // phase before's, which for "still open" says the same (a reviewer's read of the fixes for #22).
  let bytes = 0;
  const append = (data: string) => {
    bytes += data.length;
    src.journal.append({ type: 'output', data, stream: 'pty', runId: 'copy' });
  };
  const body = async () => (await digestOf(out, bytes)).body ?? '';
  try {
    append('start\r\ncopying \x1b]52;c;' + 'S'.repeat(3000));
    append('E'.repeat(6000));
    assert.equal(await body(), 'start', 'while the string is open');
    append('C'.repeat(6000));
    assert.equal(await body(), 'start', 'still open, after another cut');
    append('\x07done\r\n');
    assert.deepEqual((await body()).split('\n'), ['start', 'done'], 'the line it ended in');
  } finally {
    seg.dispose();
  }
});

test('a digest never shows the payload of a string that ended inside a long carry (our review of the 40 commits through 4f4c067, PR #22)', async () => {
  // A line that never ends, holding an OSC 52 that closed: the carry's cut, looking back 4,096 units, landed inside the
  // 9,000-byte payload without finding where the string began, and the carry, and the digest's last line, read as base64.
  const src = fakeSource();
  startRun(src, 'copy');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  const out = collect(seg);
  // Each phase reads the digest of everything appended so far, not whichever came last after a sleep, which under load could be
  // the phase before's, or none (a reviewer's read of the fixes for #22).
  let bytes = 0;
  const append = (data: string) => {
    bytes += data.length;
    src.journal.append({ type: 'output', data, stream: 'pty', runId: 'copy' });
  };
  const body = async () => (await digestOf(out, bytes)).body ?? '';
  try {
    append('start\r\ncopying \x1b]52;c;' + 'S'.repeat(9000) + '\x07 still copying');
    await body();
    append(' 50%');
    const mid = await body();
    assert.ok(!mid.includes('SSS'), JSON.stringify(mid.slice(-80)));
    assert.match(mid, /still copying 50%$/, 'the phase with ` 50%` is the one read');
    append(' done\r\n');
    // The line's tail: its first 4,096 units went with the cut, the clipboard among them.
    assert.deepEqual((await body()).split('\n'), ['start', ' still copying 50% done']);
  } finally {
    seg.dispose();
  }
});

test('unread bytes are never short of what arrived after the read, even once marks were thinned', async () => {
  const src = fakeSource();
  startRun(src, 'many');
  const seg = new Segmenter(src, { cadenceMs: 60_000 });
  const first = src.journal.append({ type: 'output', data: 'x', stream: 'pty', runId: 'many' });
  for (let i = 1; i < 1100; i++) src.journal.append({ type: 'output', data: 'x', stream: 'pty', runId: 'many' });
  assert.equal(seg.unreadBytes('many', first.seq), 1099);
  assert.equal(seg.unreadBytes('many', src.journal.lastSeq), 0);
  assert.equal(seg.unreadBytes('many', 0), 1100);
  seg.dispose();
});

test("a Run rendered from the journal loses the typed wrapper's echo and the end marker, and is projected at the width it started at", async () => {
  const src = fakeSource();
  src.journal.append({ type: 'run.admit', runId: 'old', target: 'shell', line: 'echo hello', principal: A, origin: 'self', queued: false });
  src.journal.append({ type: 'run.start', runId: 'old', cwd: '/w', cols: 20 });
  src.journal.append({ type: 'output', data: `. '/tmp/cmd-old'; echo "<<<EXI""T:abc123:$?>>>"\r\n`, stream: 'pty', runId: 'old' });
  src.journal.append({ type: 'output', data: `${'0123456789'.repeat(3)}\r\n<<<EXIT:abc123:0>>>\r\n$ `, stream: 'pty', runId: 'old' });
  src.journal.append({ type: 'run.end', runId: 'old', state: 'exited', exit: 0, durationMs: 3 });
  const r = await replay(src);
  assert.equal(r.length, 1);
  assert.doesNotMatch(r[0]!.body ?? '', /<<<EXI|cmd-old/);
  // The projection rejoins soft-wrapped rows, so the 20 columns the Run started with (now passed to it) leave a plain line whole.
  assert.equal(r[0]!.body, '0123456789'.repeat(3));
  // A declared shell's Run: start marker and the printf wrapper go too.
  src.journal.append({ type: 'run.admit', runId: 'inl', target: 'shell', line: 'uname', principal: A, origin: 'self', queued: false, shell: 'sh', within: 'ssh1' });
  src.journal.append({ type: 'run.start', runId: 'inl', cwd: '/w' });
  // The shapes the session prints today: the start marker names the shell's pid (the house's read of a6d0c35, #22).
  src.journal.append({ type: 'output', data: `printf '<<<STAR''T:n1:%s>>>\\n' "$$"; eval "$(printf '%b' "$__tsm_b")"; printf '<<<EXI''T:n1:%s>>>\\n' "$?"\r\n<<<START:n1:4242>>>\r\nLinux\r\n<<<EXIT:n1:0>>>\r\n`, stream: 'pty', runId: 'inl' });
  src.journal.append({ type: 'run.end', runId: 'inl', state: 'exited', exit: 0, durationMs: 3 });
  const r2 = await replay(src);
  assert.equal(r2.at(-1)?.body, 'Linux');
});

test('screens: a blank first frame is a screen, dropped output is said, and a wall-clock step moves no schedule', async (t) => {
  const src = fakeSource();
  const seg = new Segmenter(src, { screenQuietMs: 30, cadenceMs: 100 });
  const out = collect(seg);
  src.screen.alt = true;
  src.screen.lines = ['', '', '', '', ''];
  src.journal.append({ type: 'screen.mode', alt: true });
  await sleep(80);
  assert.equal(out.filter((s) => s.kind === 'screen').length, 1, 'a blank first frame is still the program’s first screen');
  const wall = Date.now();
  t.mock.method(Date, 'now', () => wall - 60_000);
  src.screen.lines = ['frame 2', '', '', '', ''];
  src.screen.droppedUnits = 7;
  src.journal.append({ type: 'output', data: 'frame 2', stream: 'pty' });
  await sleep(200);
  const screens = out.filter((s) => s.kind === 'screen');
  assert.equal(screens.length, 2, 'the next screen came within the cadence despite the step');
  assert.match(screens[1]!.head, /7 output units were dropped under pressure/);
  assert.equal(screens[1]!.metadata.droppedUnits, 7);
  seg.dispose();
});

test('a compaction that leaves the visible text unchanged is a new screen: the last one no longer stands as exact (G11)', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { screenQuietMs: 20, cadenceMs: 50 });
  const out = collect(seg);
  src.screen.alt = true;
  src.screen.lines = ['frame', '', '', '', ''];
  src.journal.append({ type: 'screen.mode', alt: true });
  await sleep(120);
  assert.equal(out.filter((s) => s.kind === 'screen').length, 1);
  // Output arrives and is dropped under pressure; what the screen shows did not change.
  src.screen.droppedUnits = 3;
  src.journal.append({ type: 'output', data: 'dropped', stream: 'pty' });
  await sleep(150);
  const screens = out.filter((s) => s.kind === 'screen');
  assert.equal(screens.length, 2, 'the unchanged frame is sent again, now saying what it misses');
  assert.equal(screens[1]!.metadata.droppedUnits, 3);
  assert.equal(screens[1]!.supersedes, screens[0]!.messageId);
  // Taken at the same seq, it has an id of its own: a repeated id is one the lane's sent-set drops (the house's read of 78c4d6e, #22).
  assert.notEqual(screens[1]!.messageId, screens[0]!.messageId);
  assert.equal(seqOfMessageId(screens[1]!.messageId, src.id, src.journal), screens[1]!.seq, 'the seq still reads from the id');
  // Nothing else changed: no third screen.
  src.journal.append({ type: 'output', data: 'same', stream: 'pty' });
  await sleep(150);
  assert.equal(out.filter((s) => s.kind === 'screen').length, 2);
  seg.dispose();
});

test('a Run whose start recorded its strategy and nonce is cut by them from history: a program line in the wrapper’s shape is output', async () => {
  const src = fakeSource();
  src.journal.append({ type: 'run.admit', runId: 'nonced', target: 'shell', line: 'history', principal: A, origin: 'self', queued: false });
  src.journal.append({ type: 'run.start', runId: 'nonced', cwd: '/w', strategy: 'marker', nonce: 'abc123' });
  src.journal.append({ type: 'output', data: `. '/tmp/cmd-1'; echo "<<<EXI""T:abc123:$?>>>"\r\n`, stream: 'pty', runId: 'nonced' });
  src.journal.append({ type: 'output', data: `line1\r\n  2  . '/tmp/cmd-0'; echo "<<<EXI""T:0badf00d:$?>>>"\r\nline3\r\n<<<EXIT:abc123:0>>>\r\n$ `, stream: 'pty', runId: 'nonced' });
  src.journal.append({ type: 'run.end', runId: 'nonced', state: 'exited', exit: 0, durationMs: 3 });
  assert.deepEqual([src.journal.runs.run('nonced').strategy, src.journal.runs.run('nonced').nonce], ['marker', 'abc123'], 'the run index carries both');
  const r = await replay(src);
  assert.equal(r.at(-1)?.body, `line1\n  2  . '/tmp/cmd-0'; echo "<<<EXI""T:0badf00d:$?>>>"\nline3`);
  // A rich Run's output is never cut, whatever shape it holds.
  src.journal.append({ type: 'run.admit', runId: 'rich', target: 'shell', line: 'cat log', principal: A, origin: 'self', queued: false });
  src.journal.append({ type: 'run.start', runId: 'rich', cwd: '/w', strategy: 'rich' });
  src.journal.append({ type: 'output', data: `<<<EXIT:abc123:0>>>\r\nkept\r\n`, stream: 'pty', runId: 'rich' });
  src.journal.append({ type: 'run.end', runId: 'rich', state: 'exited', exit: 0, durationMs: 3 });
  assert.equal((await replay(src)).at(-1)?.body, '<<<EXIT:abc123:0>>>\nkept');
});

test('a catch-up scan that starts inside a retention gap says what range is gone', async () => {
  const src = fakeSource(new Journal({ hot: new MemoryStore(4096) }));
  for (let i = 0; i < 40; i++) {
    startRun(src, `r${i}`);
    src.journal.append({ type: 'output', data: 'x'.repeat(100), stream: 'pty', runId: `r${i}` });
    endRun(src, `r${i}`);
  }
  const scan = await scanLifecycle(liveSource(src), 0);
  assert.ok(scan.picked.length < 40, `the ring kept only some: ${scan.picked.length}`);
  assert.ok(scan.lost && scan.lost[0]!.from === 1 && scan.lost[0]!.to >= 1, `the gap is reported: ${JSON.stringify(scan.lost)}`);
  assert.equal(scan.lost[scan.lost.length - 1]!.to, (src.journal.oldestSeq ?? 1) - 1);
});

test("a human's line is a command only when a Run of their own follows it; lines pasted together each take a Run", async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.screen.lines = ['>>> exit()', '', '', '', ''];
  src.screen.cursor = { x: 4, y: 0 };
  src.journal.append({ type: 'input', data: 'exit()', principal: H, kind: 'text' });
  src.screen.cursor = { x: 10, y: 0 };
  src.journal.append({ type: 'input', data: '\r', principal: H, kind: 'text' });
  // Another principal's queued Run starts right after: not the human's command.
  startRun(src, 'agent-run', A, 'ls');
  await sleep(400);
  assert.equal(out.length, 1, 'the REPL line is reported');
  assert.match(out[0]!.head, /typed: exit\(\)$/);
  out.length = 0;
  src.screen.lines = ['$ echo a', 'a', '$ echo b', 'b', '$ '];
  src.screen.cursor = { x: 2, y: 4 };
  src.journal.append({ type: 'input', data: 'echo a\recho b\r', principal: H, kind: 'paste' });
  startRun(src, 'h1', H, 'echo a');
  startRun(src, 'h2', H, 'echo b');
  await sleep(400);
  assert.equal(out.length, 0, 'both pasted lines became Runs');
  seg.dispose();
});

test('a prompt with a combining mark is found at the cursor; needs-input does not fire on a progress bar at the producer', async () => {
  const decomposed = 'Café?';
  assert.equal(columnIndex(decomposed, 5), decomposed.length);
  assert.equal(promptLine(snap([decomposed, ''], 5, 0)), decomposed);
  assert.equal(promptLine(snap(['Café crème? ', ''], 13, 0)), 'Café crème?');
  assert.equal(columnIndex('日本語?', 7), 4, 'wide characters take two cells');
  // The emulator's table gives an emoji one cell; the segmenter's own table gave it two and cut the row one character short
  // (the house's read of the 38 commits, #22, comment 6274773484, on the width table cleanLine now shares).
  assert.equal(columnIndex('😀 ok?', 5), '😀 ok?'.length, 'an emoji is one cell, as the screen lays it out');
  const src = fakeSource();
  const seg = new Segmenter(src, { needsInputMs: 30 });
  startRun(src, 'bar');
  src.screen.lines = ['[#####     ]', '', '', '', ''];
  src.screen.cursor = { x: 12, y: 0 };
  src.screen.seq = src.journal.append({ type: 'output', data: '[#####     ]', stream: 'pty', runId: 'bar' }).seq;
  await sleep(100);
  assert.equal(src.journal.since(0).events.filter((e) => e.type === 'run.waiting').length, 0);
  seg.dispose();
});

test('a digest holds a partial line that ends inside a control sequence until the sequence completes', async (t) => {
  // The house's read of 78c4d6e (#22): `done\r\nworking ESC [ 3`, then quiet, digested as `done\nworking [3`.
  const src = fakeSource();
  startRun(src, 'seq');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  // Each step waits for the digest it asserts, with a deadline, not a fixed sleep a stalled event loop could outlast
  // (the house's read of the 38 commits, #22, comment 6274773484). A digest goes only when bytes arrived since the last.
  const digests = () => out.filter((s) => s.kind === 'output');
  src.journal.append({ type: 'output', data: 'done\r\nworking \x1b[3', stream: 'pty', runId: 'seq' });
  await until(() => digests().length === 1, 5000, 'the first digest');
  assert.equal(digests()[0]!.body, 'done', 'the partial line waits: what the sequence does to it is not known yet');
  src.journal.append({ type: 'output', data: '2mon it', stream: 'pty', runId: 'seq' });
  await until(() => digests().length === 2, 5000, 'the second digest');
  assert.equal(digests()[1]!.body, 'done\nworking on it');
});

test('the carry is cut on a safe boundary: a digest never begins with half a surrogate pair or the tail of a control sequence', async (t) => {
  // The house's read of 78c4d6e (#22): the cut at 4,096 units put a lone low surrogate at a digest's head, and `;5;196m` at another's.
  const src = fakeSource();
  startRun(src, 'pair');
  startRun(src, 'csi');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  // 4,301 units with no newline: the last 4,096 begin inside a pair.
  src.journal.append({ type: 'output', data: `${'a'.repeat(100)}${'😀'.repeat(2100)}z`, stream: 'pty', runId: 'pair' });
  // The last 4,096 units begin inside ESC [ 38 ; 5 ; 196 m.
  src.journal.append({ type: 'output', data: `${'b'.repeat(5000)}\x1b[38;5;196m${'z'.repeat(4090)}`, stream: 'pty', runId: 'csi' });
  await until(() => ['pair', 'csi'].every((id) => out.some((s) => s.kind === 'output' && s.runId === id)), 5000, 'a digest of each');
  const pair = out.find((s) => s.kind === 'output' && s.runId === 'pair');
  assert.ok(pair?.body?.startsWith('😀'), `whole pairs only: ${JSON.stringify(pair?.body?.slice(0, 4))}`);
  assert.ok(!/[\ud800-\udfff]/.test(pair!.body!.replace(/😀/g, '')), 'no lone surrogate anywhere');
  const csi = out.find((s) => s.kind === 'output' && s.runId === 'csi');
  assert.match(csi!.body!, /^z+$/, `the colour is applied, not shown: ${JSON.stringify(csi?.body?.slice(0, 12))}`);
});

test('a hole a cold-store failure left on a later page of the scan is reported, not silently skipped (the house\'s read of the 36 commits, #22)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-seg-gap-'));
  try {
    const cold = new FileStore(dir);
    const journal = new Journal({ hot: new MemoryStore(2048), cold });
    const src = fakeSource(journal);
    // A prefix persists to disk.
    for (let i = 0; i < 3; i++) {
      startRun(src, `a${i}`);
      endRun(src, `a${i}`, { state: 'lost', reason: 'daemon-shutdown' });
    }
    const persisted = journal.lastSeq;
    // The disk refuses; later events go to the ring only, and the small ring drops the oldest, leaving
    // a hole between what the disk has and what the ring still holds — reported on a page after the first.
    const orig = cold.append.bind(cold);
    cold.append = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    try {
      for (let i = 0; i < 60; i++) {
        startRun(src, `b${i}`);
        endRun(src, `b${i}`, { state: 'lost', reason: 'daemon-shutdown' });
      }
    } finally {
      cold.append = orig;
    }
    const scan = await scanLifecycle(liveSource(src), 0);
    assert.ok(scan.lost && scan.lost.length >= 1, `a gap is reported: ${JSON.stringify(scan.lost)}`);
    assert.ok(scan.lost!.some((g) => g.from > persisted), `the later-page hole is kept: ${JSON.stringify(scan.lost)} (persisted ${persisted})`);
    // The disk comes back: the journal writes what the ring still held and records the hole as a gap event, and no page
    // reports a gap any more. The scan reads the event; it reported no lost range (the house's read of the 38 commits,
    // #22, comment 6274773484).
    assert.ok(journal.retryCold(), 'the disk is back');
    const recorded = journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
    assert.ok(recorded.some((g) => g.from > persisted), `the journal recorded the hole: ${JSON.stringify(recorded)}`);
    const healed = await scanLifecycle(liveSource(src), 0);
    // Under the reason the journal recorded: every range was taken for retention (a reviewer's read of the fixes for #22).
    for (const g of recorded.filter((x) => x.from > persisted)) {
      assert.ok(healed.lost?.some((x) => x.from <= g.from && x.to >= g.to && x.reason === g.reason), `the recorded hole ${g.from}–${g.to} (${g.reason}) is named: ${JSON.stringify(healed.lost)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hole the store heals while a scan reads is named by that scan: its gap event lies past the scan\'s end, and the pages read after the heal report none', async () => {
  // The house's read of the 33 commits (#22, comment 6307351104), item 5: the scan stopped at the end it froze, so it never
  // read the gap event, and the next scan clipped the range to its own span.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-seg-heal-'));
  try {
    const cold = new FileStore(dir);
    const journal = new Journal({ hot: new MemoryStore(2048), cold });
    const src = fakeSource(journal);
    // More than a scan page persists to disk, so the scan yields before it reaches the hole.
    for (let i = 0; i < 5100; i++) journal.append({ type: 'output', data: 'x\r\n', stream: 'pty' });
    const persisted = journal.lastSeq;
    const orig = cold.append.bind(cold);
    cold.append = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    try {
      for (let i = 0; i < 60; i++) {
        startRun(src, `b${i}`);
        endRun(src, `b${i}`, { state: 'lost', reason: 'daemon-shutdown' });
      }
    } finally {
      cold.append = orig;
    }
    const scanning = scanLifecycle(liveSource(src), 0);
    // The scan read its first page and yielded; the disk comes back before it reads on.
    assert.ok(journal.retryCold(), 'the disk is back');
    const recorded = journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap' && e.from > persisted);
    assert.ok(recorded.length >= 1, 'the journal recorded the hole');
    const scan = await scanning;
    for (const g of recorded) {
      assert.ok(g.seq > scan.end && g.to <= scan.end, `the hole ${g.from}–${g.to} is in the scan’s span, its event past it (end ${scan.end}, event ${g.seq})`);
      assert.ok(scan.lost?.some((x) => x.from <= g.from && x.to >= g.to && x.reason === g.reason), `named: ${JSON.stringify(scan.lost)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a scan clips each gone range to the seqs it covers, names a hole reported twice once, and keeps each range\'s reason', async () => {
  // The house's read of the 38 commits (#22, comment 6274773484): a page's gap was copied whole, and the lane pinned its
  // summary at the last gap's end, which can lie past the scan's end when the ring drops events during a paged scan.
  let page: { events: JournalEvent[]; gap?: { from: number; to: number; reason: 'retention' }; gaps?: JournalEvent[]; nextCursor: number; more: boolean } = { events: [], gap: { from: 1, to: 150, reason: 'retention' }, nextCursor: 0, more: false };
  const journal = { lastSeq: 100, runs: { gapsWithin: () => [] }, *pages() { yield page; } } as unknown as Journal;
  const src = { id: 's', journal, owner: A, state: 'idle', cwd: undefined, controller: null, run: () => { throw new Error('run_not_found'); }, runText: async () => ({ text: '', truncated: false, seq: [0, 0], nextCursor: 0 }) } as unknown as ReplaySource;
  assert.deepEqual((await scanLifecycle(src, 0)).lost, [{ from: 1, to: 100, reason: 'retention' }], 'clipped to the scan’s end');
  assert.deepEqual((await scanLifecycle(src, 40)).lost, [{ from: 41, to: 100, reason: 'retention' }], 'and to its start');
  // One hole as a page's gap and as the journal's gap event, with other bounds; a second hole apart; an old one before the scan.
  // The recorded reason holds where the journal recorded the hole, and a page, which cannot tell why, says retention only for
  // the rest, as a read does: every range was called past retention (a reviewer's read of the fixes for #22).
  const gap = (seq: number, from: number, to: number, reason: 'store-failed' | 'torn-write' = 'store-failed'): JournalEvent => ({ type: 'gap', seq, ts: 0, from, to, reason });
  // A page's holes are its `gaps`, as the journal reports them: every hole that meets the seqs it covers.
  const known = [gap(31, 10, 30), gap(91, 80, 90), gap(92, 1, 4), gap(93, 91, 92, 'torn-write')];
  page = { events: [...known, { type: 'note', seq: 95, ts: 0, text: 'x' } as JournalEvent], gaps: known, gap: { from: 6, to: 20, reason: 'retention' }, nextCursor: 95, more: false };
  assert.deepEqual((await scanLifecycle(src, 5)).lost, [
    { from: 6, to: 9, reason: 'retention' },
    { from: 10, to: 30, reason: 'store-failed' },
    { from: 80, to: 90, reason: 'store-failed' },
    { from: 91, to: 92, reason: 'torn-write' },
  ]);
});

test('a completion reads a negative journaled duration as no time, and a digest counts its elapsed time on the monotonic clock', async (t) => {
  // The house's read of the 38 commits (#22, comment 6274773484): a run.end with durationMs -3000 read `→ exit 0 in -3.0s`,
  // and a digest's elapsed time took a wall-clock step back as zero and a step forward as time.
  const src = fakeSource();
  startRun(src, 'neg');
  src.journal.append({ type: 'run.end', runId: 'neg', state: 'exited', exit: 0, durationMs: -3000 });
  src.runs.get('neg')!.state = 'exited';
  const [done] = await replay(src);
  assert.match(done!.head, /→ exit 0 in 0\.0s/, done!.head);
  assert.equal(done!.metadata.durationMs, 0);
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
  startRun(src, 'long');
  const seg = new Segmenter(src, { cadenceMs: 40 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  // The wall clock steps back a minute while a minute and a half pass.
  wallStep -= 60_000;
  monoStep += 90_000;
  src.journal.append({ type: 'output', data: 'tick\n', stream: 'pty', runId: 'long' });
  await until(() => out.some((s) => s.kind === 'output'), 5000, 'a digest');
  const digest = out.find((s) => s.kind === 'output')!;
  const elapsed = digest.metadata.elapsedMs as number;
  // The lower bound alone rules out the wall clock's measure; an upper one would fail only a stalled runner (the house's read of the 33 commits, #22, comment 6307351806).
  assert.ok(elapsed >= 90_000, `the monotonic interval: ${elapsed} ms`);
  assert.match(digest.head, /running `cmd-long` \d+m\d\ds/, digest.head);
});

test('a digest reads a LF a CSI executes as a line end, and the line after it reads the CSI on: its rest is no text (the house’s review of the 40 commits through f3750e4, #22, comment 6310921374)', async () => {
  const src = fakeSource();
  startRun(src, 'r');
  const seg = new Segmenter(src, { cadenceMs: 30 });
  try {
    const seen = collect(seg);
    src.journal.append({ type: 'output', data: 'A\x1b[3\r\n', stream: 'pty', runId: 'r' });
    src.journal.append({ type: 'output', data: '1mB here\r\n', stream: 'pty', runId: 'r' });
    await until(() => seen.some((s) => s.kind === 'output'), 2000, 'a digest');
    assert.deepEqual(seen.filter((s) => s.kind === 'output').at(-1)!.body?.split('\n'), ['A', 'B here']);
  } finally {
    await seg.dispose();
  }
});

test('a Run already in flight reads its lines so far afresh across a hole in them: a title or a line open before it takes nothing after it (the house’s review of the 40 commits through f3750e4, #22, comment 6310921374)', async () => {
  const src = fakeSource();
  startRun(src, 'r');
  const out = (data: string) => src.journal.append({ type: 'output', data, stream: 'pty', runId: 'r' }).seq;
  out('ready \x1b]0;my title');
  const lost = [out('the rest\x07\n')];
  out('ERROR: boom\n');
  out('abc');
  lost.push(out('XYZ'));
  out('def\n');
  // What the disk refused: the Run's read has no events for those seqs, and its gaps say so.
  const runs = src.journal.runs;
  const read = runs.output.bind(runs);
  runs.output = (journal, runId, range) => {
    const o = read(journal, runId, range);
    const gaps = lost.map((seq) => ({ seq: seq + 100, ts: 0, type: 'gap' as const, from: seq, to: seq, reason: 'store-error' as const }));
    return { ...o, events: o.events.filter((e) => !lost.includes(e.seq)), truncated: true, gaps };
  };
  const seg = new Segmenter(src, { cadenceMs: 30 });
  try {
    const seen = collect(seg);
    await until(() => seen.some((s) => s.kind === 'output'), 2000, 'a digest');
    assert.deepEqual(seen.find((s) => s.kind === 'output')!.body?.split('\n'), ['ready', 'ERROR: boom', 'abc', 'def']);
  } finally {
    await seg.dispose();
  }
});
