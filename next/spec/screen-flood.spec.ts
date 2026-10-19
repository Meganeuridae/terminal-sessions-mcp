/**
 * emu-2 / tg-4: output floods through the live Screen (§16 exit criterion:
 * output flooding). The screen keeps up at parser speed, stays in bounded
 * memory, answers queries promptly, and never claims output it has not parsed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pty from 'node-pty';
import { Screen } from '../src/core/screen.js';

const MB = 1024 * 1024;
const heap = () => process.memoryUsage().heapUsed;

/** Sample heapUsed every few ms while `fn` runs; returns the peak rise over the start. */
async function peakHeapRise<T>(fn: () => Promise<T>): Promise<{ value: T; rise: number }> {
  const start = heap();
  let peak = start;
  const iv = setInterval(() => (peak = Math.max(peak, heap())), 2);
  try {
    const value = await fn();
    peak = Math.max(peak, heap());
    return { value, rise: peak - start };
  } finally {
    clearInterval(iv);
  }
}

const line = (i: number) => `line ${String(i).padStart(8, '0')} ${'x'.repeat(60)}\r\n`;

test('emu-2: 20 MB paced by onPressure parses without loss, in parser time, in bounded memory', async () => {
  const s = new Screen({ cols: 120, rows: 30 });
  let paused = false;
  let wake: (() => void) | undefined;
  const transitions: boolean[] = [];
  s.onPressure((p) => {
    paused = p;
    transitions.push(p);
    if (!p) wake?.();
  });
  const started = Date.now();
  let seq = 0;
  let i = 0;
  const { rise } = await peakHeapRise(async () => {
    let written = 0;
    while (written < 20 * MB) {
      if (paused) await new Promise<void>((r) => (wake = r));
      let chunk = '';
      while (chunk.length < 4096) chunk += line(i++);
      s.write(chunk, ++seq);
      written += chunk.length;
      // A producer faster than the parser: it yields only when paused, or now and then.
      if (seq % 1024 === 0) await new Promise((r) => setImmediate(r));
    }
    s.write('END', ++seq);
    await s.settled();
  });
  const elapsed = Date.now() - started;
  assert.equal(s.droppedUnits, 0, 'flow control means nothing is discarded');
  assert.ok(transitions.includes(true) && transitions.at(-1) === false, `pressure raised and released: ${transitions.length}`);
  assert.equal(s.appliedSeq, seq);
  const snap = s.snapshot();
  assert.equal(snap.seq, seq);
  assert.equal(snap.lines.filter(Boolean).at(-1), 'END');
  assert.equal(snap.lines.filter(Boolean).at(-2), line(i - 1).trimEnd());
  assert.ok(elapsed < 15_000, `20 MB took ${elapsed} ms`);
  assert.ok(rise < 200 * MB, `heap rose ${Math.round(rise / MB)} MB`);
  s.dispose();
});

test('emu-2: a 100 MB burst nobody throttles stays in bounded memory; the latest output and modes survive', async () => {
  const s = new Screen({ cols: 120, rows: 30 });
  const modes: boolean[] = [];
  s.onMode((alt) => modes.push(alt));
  let seq = 0;
  let i = 0;
  const started = Date.now();
  const { rise } = await peakHeapRise(async () => {
    for (let written = 0; written < 100 * MB; ) {
      let chunk = '';
      while (chunk.length < 16 * 1024) chunk += line(i++);
      // Early in the flood: keypad mode on, and a full-screen program that comes and goes.
      if (seq === 10) chunk += '\x1b[?1h\x1b[?1049hTUI\x1b[?1049l';
      s.write(chunk, ++seq);
      written += chunk.length;
    }
    s.write('LAST', ++seq);
    await s.settled();
  });
  const elapsed = Date.now() - started;
  assert.ok(s.droppedUnits > 0, 'the backlog was compacted');
  assert.ok(rise < 300 * MB, `heap rose ${Math.round(rise / MB)} MB for a 100 MB burst`);
  assert.ok(elapsed < 20_000, `burst settled after ${elapsed} ms`);
  const snap = s.snapshot();
  assert.equal(snap.seq, seq);
  assert.equal(snap.lines.filter(Boolean).at(-1), 'LAST');
  assert.equal(s.applicationCursorKeys, true, 'DECCKM set inside discarded output is kept');
  assert.deepEqual(modes, [true, false], 'the alternate-screen visit inside discarded output is still reported');
  assert.equal(s.backlog, 0);
  s.dispose();
});

test('emu-2 / G25: a cursor-position query behind 5000 queued chunks is answered promptly', async () => {
  const s = new Screen({ cols: 120, rows: 30 });
  let answeredAt = 0;
  s.onReply(() => (answeredAt = Date.now()));
  const started = Date.now();
  for (let k = 0; k < 5000; k++) s.write(`${'x'.repeat(150)}\r\n`, k + 1);
  s.write('\x1b[6n', 5001);
  await s.settled();
  assert.ok(answeredAt > 0);
  assert.ok(answeredAt - started < 1000, `answered after ${answeredAt - started} ms`);
  s.dispose();
});

test('emu-2: settled() after 25 000 small chunks takes parser time, not a timer per chunk', async () => {
  const s = new Screen({ cols: 120, rows: 30 });
  const started = Date.now();
  for (let k = 0; k < 25_000; k++) s.write(`${'y'.repeat(158)}\r\n`, k + 1);
  await s.settled();
  const elapsed = Date.now() - started;
  // Parsing 4 MB takes a few hundred ms; a timer per chunk would take 25 s or more. A runner under a
  // CPU quota was seen at 3 s (the house's read of ed4ecac), so the bound leaves room without blurring the point.
  assert.ok(elapsed < 5000, `settled after ${elapsed} ms`);
  assert.equal(s.appliedSeq, 25_000);
  s.dispose();
});

test('emu-2: a real PTY flood (`yes`) with the reader paused on pressure: bounded heap, nothing dropped, screen current at exit', async () => {
  // Low watermarks so the reader is certainly paused and resumed along the way.
  const s = new Screen({ cols: 100, rows: 30, highWater: 16 * 1024, lowWater: 4 * 1024 });
  // node-pty can lose unread Linux PTY output if its producer exits while reading is paused.
  // Keep the producer alive until its final marker reaches this reader to test Screen backpressure,
  // rather than node-pty's separate exit/drain race. No timing grace or reduced flood.
  const p = pty.spawn('/bin/sh', ['-c', 'stty -echo; yes 0123456789abcdef | head -c 20000000; echo; echo FLOOD-END; IFS= read -r received'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  let seq = 0;
  let pauses = 0;
  let tail = '';
  let acknowledged = false;
  s.onPressure((paused) => {
    if (paused) {
      pauses++;
      p.pause();
    } else p.resume();
  });
  // Under load the emulator can keep up with the producer, and then no pause is needed:
  // what must hold is that pressure engaged whenever the backlog passed the high watermark.
  let maxBacklog = 0;
  p.onData((d) => {
    void s.write(d, ++seq);
    maxBacklog = Math.max(maxBacklog, s.backlog);
    tail = (tail + d).slice(-32);
    if (!acknowledged && tail.includes('FLOOD-END')) {
      acknowledged = true;
      p.write('\n');
    }
  });
  const started = Date.now();
  const { value: exitedAt, rise } = await peakHeapRise(async () => {
    await new Promise<void>((r) => p.onExit(() => r()));
    return Date.now();
  });
  await s.settled();
  const caughtUp = Date.now() - exitedAt;
  assert.equal(s.droppedUnits, 0);
  assert.ok(acknowledged, 'the complete flood reached the reader before its producer exited');
  assert.ok(pauses > 0 || maxBacklog <= 16 * 1024, `backlog peaked at ${maxBacklog} bytes without pausing the reader`);
  assert.ok(rise < 200 * MB, `heap rose ${Math.round(rise / MB)} MB`);
  assert.ok(caughtUp < 2000, `screen caught up ${caughtUp} ms after exit`);
  assert.ok(Date.now() - started < 30_000);
  const lines = s.snapshot().lines.filter(Boolean);
  assert.equal(lines.at(-1), 'FLOOD-END');
  assert.equal(s.snapshot().seq, seq);
  s.dispose();
});

test('emu-2 / G25: compaction keeps the title and modes, drops stale queries unanswered, and later queries are answered', async () => {
  const s = new Screen({ cols: 80, rows: 10, maxBacklog: 512 * 1024 });
  const replies: string[] = [];
  const titles: string[] = [];
  s.onReply((d) => replies.push(d));
  s.onTitle((t) => titles.push(t));
  let seq = 0;
  // Everything below is written in one turn, far past maxBacklog, so the head is compacted.
  s.write('\x1b]2;building\x07\x1b[?2004h\x1b[6n', ++seq);
  for (let k = 0; k < 400; k++) s.write(`${'q'.repeat(5000)}\r\n`, ++seq);
  s.write('tail line\x1b[6n', ++seq);
  await s.settled();
  assert.ok(s.droppedUnits > 0);
  assert.equal(s.title, 'building');
  assert.deepEqual(titles, ['building']);
  assert.equal(replies.length, 1, `only the query after the discarded output is answered: ${JSON.stringify(replies)}`);
  assert.equal(s.snapshot().lines.filter(Boolean).at(-1)?.endsWith('tail line'), true);
  const t = (s as unknown as { term: { modes: { bracketedPasteMode: boolean } } }).term;
  assert.equal(t.modes.bracketedPasteMode, true);
  s.dispose();
});

test('the backlog cap holds behind a queued resize: output on each side of it is compacted on its own', async () => {
  const cap = 512 * 1024;
  const s = new Screen({ cols: 80, rows: 10, maxBacklog: cap });
  s.write('x'.repeat(1000), 1);
  s.resize(100, 10);
  let seq = 1;
  let peak = 0;
  for (let k = 0; k < 100; k++) {
    s.write('y'.repeat(64 * 1024), ++seq);
    peak = Math.max(peak, s.backlog);
  }
  assert.ok(peak <= cap, `backlog peaked at ${peak} against a cap of ${cap}`);
  await s.settled();
  assert.ok(s.droppedUnits > 0);
  assert.equal(s.snapshot().cols, 100);
  assert.ok(s.snapshot().lines.some((l) => l.length === 100), 'the output after the resize was parsed at the new width');
  s.dispose();
});

test('compaction keeps a mode whose sequence the cut splits, at either end of the discarded output', async () => {
  const cap = 512 * 1024;
  const chunk = 64 * 1024;
  // Inside the queue: the cut between the fifth and sixth chunk (half the cap is four chunks) splits ESC [ ? 1 | h.
  {
    const s = new Screen({ cols: 80, rows: 10, maxBacklog: cap });
    let seq = 0;
    for (let k = 1; k <= 20; k++) {
      let data = 'q'.repeat(chunk - 4);
      if (k === 5) data += '\x1b[?1';
      if (k === 6) data = `h${data}`;
      s.write(data, ++seq);
    }
    await s.settled();
    assert.ok(s.droppedUnits > 0);
    assert.equal(s.applicationCursorKeys, true, 'DECCKM set across the cut inside the queue');
    s.dispose();
  }
  // At the head: the last batch written ended inside the sequence, the discarded output finished it.
  {
    const s = new Screen({ cols: 80, rows: 10, maxBacklog: cap });
    await s.write(`${'a'.repeat(1000)}\x1b[?1`, 1);
    let seq = 1;
    for (let k = 0; k < 12; k++) s.write(`${k === 0 ? 'h' : ''}${'b'.repeat(chunk)}`, ++seq);
    await s.settled();
    assert.ok(s.droppedUnits > 0);
    assert.equal(s.applicationCursorKeys, true, 'DECCKM set across the cut at the parsed batch');
    s.dispose();
  }
  // At the tail: the discarded output ends inside the sequence, and what finishes it has not arrived yet.
  {
    const s = new Screen({ cols: 80, rows: 10, maxBacklog: cap });
    s.write('a'.repeat(300_000), 1);
    s.write(`${'b'.repeat(300_000)}\x1b[?1`, 2);
    assert.ok(s.droppedUnits > 0, 'compacted before the rest arrived');
    s.write(`h${'c'.repeat(1000)}`, 3);
    await s.settled();
    assert.equal(s.applicationCursorKeys, true, 'DECCKM set across the cut at the end of the discarded output');
    assert.equal(s.snapshot().lines.filter(Boolean).at(-1)?.includes('h'), false, 'the h was the sequence\'s, not text');
    s.dispose();
  }
});

test('the kept head of discarded output is bounded by the state it holds, not by the output', async () => {
  const cap = 512 * 1024;
  const s = new Screen({ cols: 80, rows: 10, maxBacklog: cap });
  const frame = `\x1b[?25l${'f'.repeat(67_000)}\x1b[?25h`;
  let seq = 0;
  let peak = 0;
  for (let k = 0; k < 400; k++) {
    s.write(frame, ++seq);
    peak = Math.max(peak, s.backlog);
  }
  assert.ok(peak <= cap, `backlog peaked at ${peak} units against a cap of ${cap}`);
  await s.settled();
  assert.ok(s.droppedUnits > 0);
  s.dispose();
});

test('er-15 (§6 Backpressure): a snapshot after compaction reports droppedUnits; one without compaction does not', async () => {
  const s = new Screen({ cols: 80, rows: 10, maxBacklog: 512 * 1024 });
  s.write('calm\r\n', 1);
  await s.settled();
  assert.equal(s.snapshot().droppedUnits, undefined, 'an exact screen claims nothing dropped');
  let seq = 1;
  for (let k = 0; k < 400; k++) s.write(`${'q'.repeat(5000)}\r\n`, ++seq);
  s.write('after\r\n', ++seq);
  await s.settled();
  const snap = s.snapshot();
  assert.ok(s.droppedUnits > 0);
  assert.equal(snap.droppedUnits, s.droppedUnits, 'the snapshot says the screen is approximate, and by how much');
  s.dispose();
});
