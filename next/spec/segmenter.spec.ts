/**
 * The segmenter against a fake session source (no PTY): what becomes a message,
 * with which tags and interest, and what never does (§10.2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/core/journal.js';
import { liveSource, renderPicked, scanLifecycle, Segmenter, type Segment, type SegmentSource } from '../src/core/segmenter.js';
import type { RunInfo, ScreenSnapshot } from '../src/core/types.js';
import { sleep } from './testhost.js';

function fakeSource(): SegmentSource & { runs: Map<string, RunInfo>; screen: ScreenSnapshot } {
  const journal = new Journal();
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
