/**
 * The segmenter against a fake session source (no PTY): what becomes a message,
 * with which tags and interest, and what never does (§10.2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/core/journal.js';
import { MemoryStore } from '../src/core/stores.js';
import { sourceLine } from '../src/core/plumbing.js';
import { liveSource, oneLine, renderPicked, scanLifecycle, Segmenter, type Segment, type SegmentSource } from '../src/core/segmenter.js';
import type { RunInfo, ScreenSnapshot } from '../src/core/types.js';
import { sleep, until } from './testhost.js';

function fakeSource(journal = new Journal()): SegmentSource & { runs: Map<string, RunInfo>; screen: ScreenSnapshot } {
  const runs = new Map<string, RunInfo>();
  const screen: ScreenSnapshot = { cols: 80, rows: 5, alt: false, cursor: { x: 0, y: 0 }, lines: ['', '', '', '', ''], title: '', seq: 0 };
  return {
    id: 's1',
    owner: 'agent:owner@t',
    journal,
    state: 'idle',
    cwd: '/w',
    currentController: 'agent:owner@t',
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

const collect = (seg: Segmenter) => {
  const out: Segment[] = [];
  seg.subscribe((s) => out.push(s));
  return out;
};

test('a human typing into a program is a message; a human typing a command that runs is not (the Run is)', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5 });
  const out = collect(seg);
  src.journal.append({ type: 'input', data: 'y', principal: 'human:gui:aster', kind: 'text' });
  // The program echoes it (m2-2: only an echoed line is repeated to agents).
  src.screen.lines = ['Continue? [y/N] y', '', '', '', ''];
  src.screen.cursor = { x: 17, y: 0 };
  src.journal.append({ type: 'input', data: '\r', principal: 'human:gui:aster', kind: 'text' });
  await sleep(400);
  assert.equal(out.filter((s) => s.kind === 'human-input').length, 1);
  assert.match(out[0]!.head, /human:gui:aster typed: y$/);
  assert.ok(out[0]!.tags.includes('chat:from-human'));

  out.length = 0;
  src.journal.append({ type: 'input', data: 'ls\r', principal: 'human:gui:aster', kind: 'text' });
  const admit = src.journal.append({ type: 'run.admit', runId: 'r9', target: 'shell', principal: 'human:gui:aster', origin: 'human', queued: false });
  const start = src.journal.append({ type: 'run.start', runId: 'r9', cwd: '/w' });
  src.runs.set('r9', { runId: 'r9', sessionId: 's1', target: 'shell', origin: 'human', principal: 'human:gui:aster', state: 'running', admittedAt: admit.ts, seq: { admit: admit.seq, start: start.seq }, attribution: 'temporal', line: 'ls' });
  await sleep(400);
  assert.equal(out.filter((s) => s.kind === 'human-input').length, 0, 'the command became a Run; its end is the message');
  seg.dispose();
});

test('a line recalled from history or completed with Tab, then Enter, is a human-input message shown as a placeholder', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5 });
  const out = collect(seg);
  src.screen.lines = ['>>> ', '', '', '', ''];
  src.screen.cursor = { x: 4, y: 0 };
  // Up recalls a line this reconstruction never saw; Enter submits it from an empty buffer.
  src.journal.append({ type: 'input', data: '\x1b[A', principal: 'human:gui:aster', kind: 'keys' });
  src.journal.append({ type: 'input', data: '\r', principal: 'human:gui:aster', kind: 'text' });
  await sleep(400);
  assert.equal(out.filter((s) => s.kind === 'human-input').length, 1, 'the recalled line is reported');
  assert.match(out[0]!.head, /typed: \[input edited with cursor, history or completion keys — not shown\]$/);
  out.length = 0;
  // Tab alone completes something, then Enter.
  src.journal.append({ type: 'input', data: '\t', principal: 'human:gui:aster', kind: 'text' });
  src.journal.append({ type: 'input', data: '\r', principal: 'human:gui:aster', kind: 'text' });
  await sleep(400);
  assert.equal(out.filter((s) => s.kind === 'human-input').length, 1, 'the completed line is reported');
  out.length = 0;
  // A bare Enter with nothing recalled is still nothing.
  src.journal.append({ type: 'input', data: '\r', principal: 'human:gui:aster', kind: 'text' });
  await sleep(400);
  assert.equal(out.length, 0);
  seg.dispose();
});

test('protocol replies and agent input are never messages; sensitive input is a placeholder', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.journal.append({ type: 'input', data: '\x1b[1;1R', principal: 'system', kind: 'protocol-reply' });
  src.journal.append({ type: 'input', data: 'x\r', principal: 'agent:a@t', kind: 'text' });
  src.journal.append({ type: 'input', data: '[redacted]', principal: 'human:gui:aster', kind: 'text', sensitive: true });
  await sleep(450);
  assert.equal(out.length, 1);
  assert.match(out[0]!.head, /typed: \[sensitive input\]$/);
  seg.dispose();
});

test('a full-screen program sends its screen after a quiet period, then at most once per cadence, superseding the last', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src, { screenQuietMs: 30, cadenceMs: 200 });
  const out = collect(seg);
  src.screen.alt = true;
  src.screen.lines = ['htop frame 1', '', '', '', ''];
  src.journal.append({ type: 'screen.mode', alt: true });
  await sleep(80);
  assert.equal(out.filter((s) => s.kind === 'screen').length, 1);
  for (let i = 2; i < 6; i++) {
    src.screen.lines = [`htop frame ${i}`, '', '', '', ''];
    src.journal.append({ type: 'output', data: `frame ${i}`, stream: 'pty' });
    await sleep(20);
  }
  await sleep(300);
  const screens = out.filter((s) => s.kind === 'screen');
  assert.equal(screens.length, 2, `screens: ${screens.length}`);
  assert.equal(screens[1]!.supersedes, screens[0]!.messageId);
  assert.ok(!screens[0]!.lifecycle, 'screens are ambient');
  seg.dispose();
});

test('a watch segment says when the hit was on the line\'s head only, and carries clipped (the house\'s read of the 38 commits, #22)', () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 3, match: 'ERROR', line: 'ERROR: boom' });
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 5, match: 'ERROR', line: 'ERROR: long', clipped: true });
  assert.equal(out.length, 2);
  // In the words search's status and wait_for use (a reviewer's read of the fixes for #22: three wordings of one fact).
  assert.ok(!out[0]!.head.includes('match window') && out[0]!.metadata.clipped === undefined, out[0]!.head);
  assert.ok(out[1]!.head.endsWith('(the line is longer than the match window: matched on its head only) · read since=4'), out[1]!.head);
  assert.equal(out[1]!.metadata.clipped, true);
  seg.dispose();
});

test('service and watch events become lifecycle messages for the principal who set them up; replay rebuilds them', async () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'process', origin: 'self', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'npm run dev' });
  src.journal.append({ type: 'service', runId: 'r1', status: 'starting', probe: 'pattern /ready/', principal: 'agent:a@t' });
  src.journal.append({ type: 'service', runId: 'r1', status: 'ready', probe: 'pattern /ready/', principal: 'agent:a@t', evidence: 'ready on :3000' });
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 3, match: 'ERROR', line: 'ERROR: boom' });
  assert.equal(out.length, 2, 'starting is not a message');
  assert.deepEqual(out[0]!.tags, ['terminal:service-ready']);
  assert.deepEqual(out[0]!.interested, ['agent:a@t']);
  assert.ok(out[1]!.tags.includes('terminal:watch=errors') && out[1]!.tags.includes('terminal:watch') && out[1]!.tags.includes('terminal:pattern'));
  assert.deepEqual(out[1]!.interested, ['agent:b@t']);
  const replay = liveSource(src);
  const r = await renderPicked(replay, (await scanLifecycle(replay, 0)).picked);
  assert.deepEqual(r.map((s) => s.kind), ['service', 'watch']);
  assert.equal(r[0]!.messageId, out[0]!.messageId, 'replayed messages keep their ids, so hosts can deduplicate');
  seg.dispose();
});

test('G23: the other producers set tags too — a session exit, needs-input, a note, a progress digest and a screen — and none claims chat:addressed', async (t) => {
  // The house's read of 78c4d6e (#22): the test below covers four tag-setting producers; a chat:addressed added to any of these five passed it.
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'shell', origin: 'self', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'read name' });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/w' });
  src.journal.append({ type: 'output', data: 'Name? ', stream: 'pty', runId: 'r1' });
  src.journal.append({ type: 'run.waiting', runId: 'r1', lastLine: 'Name?', silentMs: 5000, state: 'busy' });
  src.journal.append({ type: 'note', text: 'please wait', principal: 'agent:b@t', channel: 'terminal:s1' });
  await sleep(120);
  src.screen.alt = true;
  src.screen.lines = ['htop', '', '', '', ''];
  src.journal.append({ type: 'screen.mode', alt: true });
  await sleep(80);
  src.journal.append({ type: 'session.exit', code: 0 });
  await sleep(20);
  const kinds = new Set<string>(out.map((s) => s.kind));
  for (const k of ['needs-input', 'note', 'output', 'screen', 'session-exit']) assert.ok(kinds.has(k), `a ${k} segment was produced: ${[...kinds].join(', ')}`);
  for (const s of out) {
    assert.ok(s.tags.length > 0, `${s.kind} carries tags`);
    assert.ok(!s.tags.includes('chat:addressed'), `${s.kind} claims chat:addressed: ${s.tags.join(', ')}`);
    for (const tag of s.tags) assert.ok(tag.startsWith('terminal:') || /^chat:from-(human|agent|self)$/.test(tag), `${s.kind}: ${tag} is neither a terminal:* tag nor a sender facet`);
  }
});

test('G23: no segment claims chat:addressed — a Run’s end, a service, a watch, a human’s input carry terminal:* tags and at most a chat:from-* sender', async () => {
  // Tags describe and never authorize (G23): whether a finished run deserves attention is the
  // consumer's rule. Nothing checked this, so a run message tagged chat:addressed passed the
  // suite (the house's read of 07ab3dd, #22).
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5 });
  const out = collect(seg);
  src.journal.append({ type: 'input', data: 'y', principal: 'human:gui:aster', kind: 'text' });
  src.screen.lines = ['Continue? [y/N] y', '', '', '', ''];
  src.screen.cursor = { x: 17, y: 0 };
  src.journal.append({ type: 'input', data: '\r', principal: 'human:gui:aster', kind: 'text' });
  await sleep(400);
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'process', origin: 'self', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'npm run dev' });
  src.journal.append({ type: 'service', runId: 'r1', status: 'ready', probe: 'pattern /ready/', principal: 'agent:a@t', evidence: 'ready on :3000' });
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 3, match: 'ERROR', line: 'ERROR: boom' });
  const admit = src.journal.append({ type: 'run.admit', runId: 'r2', target: 'shell', principal: 'human:gui:aster', origin: 'human', queued: false });
  const start = src.journal.append({ type: 'run.start', runId: 'r2', cwd: '/w' });
  src.runs.set('r2', { runId: 'r2', sessionId: 's1', target: 'shell', origin: 'human', principal: 'human:gui:aster', state: 'exited', exit: 1, admittedAt: admit.ts, startedAt: start.ts, seq: { admit: admit.seq, start: start.seq }, attribution: 'temporal', line: 'make' });
  src.journal.append({ type: 'run.end', runId: 'r2', state: 'exited', exit: 1, durationMs: 10 });
  await sleep(400);
  const kinds = new Set<string>(out.map((s) => s.kind));
  for (const k of ['human-input', 'service', 'watch', 'run']) assert.ok(kinds.has(k), `a ${k} segment was produced: ${[...kinds].join(', ')}`);
  for (const s of out) {
    assert.ok(!s.tags.includes('chat:addressed'), `${s.kind} claims chat:addressed: ${s.tags.join(', ')}`);
    for (const t of s.tags) assert.ok(t.startsWith('terminal:') || /^chat:from-(human|agent|self)$/.test(t), `${s.kind}: ${t} is neither a terminal:* tag nor a sender facet`);
  }
  seg.dispose();
});

test('a Run’s progress digest reads a LF inside a window title as no line end, as the transcript does', async (t) => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650): the digest's
  // lines split at the title's LF, and showed `leBBB` for the line the transcript reads `AAABBB`.
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'process', origin: 'self', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'build' });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/w' });
  src.journal.append({ type: 'output', data: 'AAA\x1b]0;tit\n', stream: 'stdout', runId: 'r1' });
  src.journal.append({ type: 'output', data: 'le\x07BBB\nnext\n', stream: 'stdout', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output' && s.body), 5000, 'a digest with lines');
  const digest = out.find((s) => s.kind === 'output' && s.body);
  assert.equal(digest?.body, 'AAABBB\nnext', JSON.stringify(out.map((s) => [s.kind, s.body])));
});

test('a marker Run’s progress digest shows neither the typed line’s echo nor its start mark: what the cut drops, the digest drops', async (t) => {
  // The house's review of the 40 commits through f3750e4 (PR #22, comment 6310921374): a marker Run's running digests showed
  // `<<<START:…>>>` beside the echo they already showed, until later lines pushed them out.
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  const nonce = 'a1b2c3d4';
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'shell', origin: 'agent', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'make', strategy: 'marker', nonce });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/w', strategy: 'marker', nonce });
  // A slow shell: the echo first, a digest while the file has not run yet, then its banner, its second echo and the start mark.
  src.journal.append({ type: 'output', data: `sh$ ${sourceLine('/tmp/tsm-501/ab/tsm-cmd-1', 'posix', nonce)}\r\nWelcome\r\n`, stream: 'pty', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output'), 5000, 'a digest before the start mark');
  const early = out.filter((s) => s.kind === 'output').at(-1)!;
  assert.equal(early.body, 'Welcome', `before the mark, the echo dropped: ${JSON.stringify(early.body)}`);
  src.journal.append({ type: 'output', data: `sh$ ${sourceLine('/tmp/tsm-501/ab/tsm-cmd-1', 'posix', nonce)}\r\n<<<START:${nonce}:4242>>>\r\nbuilding 1\r\nbuilding 2\r\nhalf`, stream: 'pty', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output' && /building/.test(s.body ?? '')), 5000, 'a digest after the start mark');
  assert.equal(out.filter((s) => s.kind === 'output').at(-1)!.body, 'building 1\nbuilding 2\nhalf');
});

test('a marker Run’s digest leaves out the typed line’s echo when it is the partial line, its line end still to come', async (t) => {
  // A reviewer's read of the fixes for #22: bash's readline writes the echo and then its line end, which can reach the daemon
  // in reads of their own (by run, 63 of 200 typed lines in bash 5). With no hold, a digest between them showed the echo.
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  const nonce = 'a1b2c3d4';
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'shell', origin: 'agent', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'make', strategy: 'marker', nonce });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/w', strategy: 'marker', nonce });
  src.journal.append({ type: 'output', data: `Welcome\r\nsh$ ${sourceLine('/tmp/tsm-501/ab/tsm-cmd-1', 'posix', nonce)}`, stream: 'pty', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output'), 5000, 'a digest with the echo still unended');
  const early = out.filter((s) => s.kind === 'output').at(-1)!;
  assert.equal(early.body, 'Welcome', `the echo's line is the shell's: ${JSON.stringify(early.body)}`);
  // A program's own partial line still shows, a password prompt included.
  src.journal.append({ type: 'output', data: `\r\n<<<START:${nonce}:4242>>>\r\nPassword: `, stream: 'pty', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output' && /Password/.test(s.body ?? '')), 5000, 'the program\'s partial line');
  assert.equal(out.filter((s) => s.kind === 'output').at(-1)!.body, 'Password:', 'after the mark: the lines before it go, the prompt shows');
});

test('a marker Run in flight when the segmenter begins: its digest drops the echo and the start mark when the read reaches them, and holds nothing back when it does not', async (t) => {
  // A reviewer's read of the fixes for #22: trackInflight gave a Run in flight no preamble, so a lane's first digest showed
  // the typed line's echo and `<<<START:…>>>`. A read the byte bound cut begins past the mark, which it must not wait for.
  const src = fakeSource();
  const nonce = 'a1b2c3d4';
  const echo = `sh$ ${sourceLine('/tmp/tsm-501/ab/tsm-cmd-1', 'posix', nonce)}\r\n<<<START:${nonce}:4242>>>\r\n`;
  for (const runId of ['near', 'far']) {
    src.runs.set(runId, { runId, sessionId: 's1', target: 'shell', origin: 'agent', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'temporal', line: 'make', strategy: 'marker', nonce });
    src.journal.append({ type: 'run.start', runId, cwd: '/w', strategy: 'marker', nonce });
  }
  src.journal.append({ type: 'output', data: `${echo}building 1\r\nhalf`, stream: 'pty', runId: 'near' });
  src.journal.append({ type: 'output', data: echo, stream: 'pty', runId: 'far' });
  for (let k = 0; k < 18; k++) src.journal.append({ type: 'output', data: `${'x'.repeat(65_534)}\r\n`, stream: 'pty', runId: 'far' });
  src.journal.append({ type: 'output', data: 'last\r\nhalf', stream: 'pty', runId: 'far' });
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  const digest = (runId: string) => out.filter((s) => s.kind === 'output' && s.runId === runId).at(-1);
  await until(() => digest('near') !== undefined && digest('far') !== undefined, 5000, 'a digest of each Run');
  assert.equal(digest('near')!.body, 'building 1\nhalf');
  assert.equal(digest('far')!.metadata.bytesAtLeast, true, 'the read was cut');
  assert.equal(digest('far')!.body?.split('\n').slice(-2).join('\n'), 'last\nhalf');
  // The house's review of bc4bc85..5d8ce0e (PR #22), I36: for a read before what the cut read began with, the count of what's new is a lower bound; from
  // there on, it isn't. A Run the read took whole counts exactly from its start.
  const far = seg.unreadBytes('far', 0)!;
  assert.equal(far.atLeast, true, `a read before the count began: ${JSON.stringify(far)}`);
  assert.equal(seg.unreadBytes('far', src.journal.lastSeq - 1)!.atLeast, false, 'a read inside what was counted');
  assert.equal(seg.unreadBytes('near', 0)!.atLeast, false);
});

test('a count of what is new is a lower bound for a read before a hole in the output it began with, and for every read when that output held none', async (t) => {
  const counted = async (runId: string, outputs: string[], journal?: Journal) => {
    const src = fakeSource(journal);
    src.runs.set(runId, { runId, sessionId: 's1', target: 'process', origin: 'agent', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact' });
    src.journal.append({ type: 'run.start', runId, cwd: '/w' });
    const seqs: number[] = [];
    for (const data of outputs) {
      if (data === 'HOLE') src.journal.append({ type: 'gap', from: src.journal.lastSeq + 1, to: src.journal.lastSeq + 1, reason: 'store-error' });
      else if (data === 'FLOOD') for (let i = 0; i < 80; i++) src.journal.append({ type: 'output', data: 'z'.repeat(100), stream: 'pty' });
      else seqs.push(src.journal.append({ type: 'output', data, stream: 'stdout', runId }).seq);
    }
    const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
    t.after(() => seg.dispose());
    await until(() => seg.unreadBytes(runId, 0) !== undefined, 5000, `${runId} counted`);
    return { seg, seqs };
  };
  const holed = await counted('holed', ['one\n', 'HOLE', 'two\n']);
  const [first, after] = holed.seqs as [number, number];
  assert.equal(holed.seg.unreadBytes('holed', first)!.atLeast, true, `a read before the hole: ${JSON.stringify(holed.seg.unreadBytes('holed', first))}`);
  assert.equal(holed.seg.unreadBytes('holed', after)!.atLeast, false, 'a read after the hole');
  const empty = await counted('empty', ['HOLE']);
  assert.equal(empty.seg.unreadBytes('empty', 0)!.atLeast, true, `no output counted: ${JSON.stringify(empty.seg.unreadBytes('empty', 0))}`);
  const gone = await counted('gone', ['one\n', 'FLOOD'], new Journal({ hot: new MemoryStore(4096) }));
  assert.equal(gone.seg.unreadBytes('gone', 0)!.atLeast, true, `all of it taken by retention: ${JSON.stringify(gone.seg.unreadBytes('gone', 0))}`);
});

test('a line shortened for a descriptor never splits a surrogate pair', () => {
  const short = oneLine(`${'y'.repeat(118)}\u{1F600}z`, 120);
  assert.equal(short, `${'y'.repeat(118)}…`);
});

test('an inline Run’s progress digest shows its partial line: its output begins after its start mark, so nothing waits for one', async (t) => {
  // A reviewer's read of the fixes for #22: the session journals the piece through an inline Run's start mark to the Run
  // around it, before the Run starts, so the Run's watch waited for a mark that never came and held back its partial line,
  // a declared shell's `Password: `, for the whole Run.
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  const nonce = 'a1b2c3d4';
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'shell', origin: 'agent', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'temporal', line: 'ssh host', strategy: 'inline', nonce });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '', strategy: 'inline', nonce });
  const data = 'connecting\r\nPassword: ';
  src.journal.append({ type: 'output', data, stream: 'pty', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output' && s.metadata.bytes === data.length), 5000, 'a digest of all the output');
  assert.equal(out.filter((s) => s.kind === 'output').at(-1)!.body, 'connecting\nPassword:');
});

test('a marker Run whose command file never ran shows its partial line in its first digest: a program read the typed line', async (t) => {
  // The house's review of f3750e4..4f4c067 (PR #22, comment 6315636412): with no start mark ever, the preamble held the digests'
  // partial line back for the whole Run, so a program's `Password: ` never showed. Its review of 4f4c067..a8b6f28 (PR #22, comment
  // 6323055715), question 4: the bound on that hold never held at the digests' cadence, and its release reused the held digest's
  // id; the preamble holds nothing back now.
  const src = fakeSource();
  const seg = new Segmenter(src, { runSettleMs: 5, cadenceMs: 40, screenQuietMs: 20 });
  t.after(() => seg.dispose());
  const out = collect(seg);
  const nonce = 'a1b2c3d4';
  src.runs.set('r1', { runId: 'r1', sessionId: 's1', target: 'shell', origin: 'agent', principal: 'agent:a@t', state: 'running', admittedAt: 0, seq: { admit: 1 }, attribution: 'exact', line: 'deploy', strategy: 'marker', nonce });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/w', strategy: 'marker', nonce });
  src.journal.append({ type: 'output', data: `${sourceLine('/tmp/tsm-501/ab/tsm-cmd-1', 'posix', nonce)}\r\nlogin as: deploy\r\nPassword: `, stream: 'pty', runId: 'r1' });
  await until(() => out.some((s) => s.kind === 'output' && s.body), 5000, 'a digest');
  assert.equal(out.find((s) => s.kind === 'output' && s.body)!.body, 'login as: deploy\nPassword:', 'the first digest: the echo still dropped, the partial line shown');
});

test("a watch segment names a process Run line's pipe, and `mixed` when it holds both (an independent read of the fixes for the review of the 40 commits, PR #22)", () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 3, match: 'ERROR', line: 'ERROR: both', stream: 'stderr', mixed: true });
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 5, match: 'ERROR', line: 'ERROR: out', stream: 'stdout' });
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 7, match: 'ERROR', line: 'ERROR: pty' });
  assert.equal(out.length, 3);
  assert.ok(out[0]!.head.includes('matched: ERROR: both (stderr, mixed) · read since=2'), out[0]!.head);
  assert.ok(out[1]!.head.includes('matched: ERROR: out (stdout) · read since=4'), out[1]!.head);
  assert.ok(out[2]!.head.includes('matched: ERROR: pty · read since=6'), out[2]!.head);
  seg.dispose();
});

test('a watch segment reads from where its line began, which an event before `at` may hold (the house’s review of 4f4c067..a8b6f28, #22, comment 6323055715, question 2)', () => {
  const src = fakeSource();
  const seg = new Segmenter(src);
  const out = collect(seg);
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 9, match: 'ERROR', line: 'ERROR: split', cursor: 4, offset: 7 });
  src.journal.append({ type: 'watch.fired', watchId: 'w1', label: 'errors', kind: 'pattern', principal: 'agent:b@t', at: 12, match: 'ERROR', line: 'ERROR: whole', cursor: 11 });
  src.journal.append({ type: 'watch.fired', watchId: 'w2', label: 'quiet', kind: 'silence', principal: 'agent:b@t', at: 12, match: 'no output for 500ms' });
  assert.equal(out.length, 3);
  assert.ok(out[0]!.head.endsWith('· read since=4 offset=7'), `not since=8, past the line's head: ${out[0]!.head}`);
  assert.deepEqual([out[0]!.metadata.cursor, out[0]!.metadata.offset, out[0]!.metadata.at], [4, 7, 9]);
  assert.ok(out[1]!.head.endsWith('· read since=11'), out[1]!.head);
  assert.ok(out[2]!.head.endsWith('· read since=11'), `a silence has no line: ${out[2]!.head}`);
  seg.dispose();
});
