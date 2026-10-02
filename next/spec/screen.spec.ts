import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';
import { Screen } from '../src/core/screen.js';
import { transcript } from '../src/core/transcript.js';

test('G14: the screen is emulator state; snapshot reads it without side effects', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  await s.write('ABCDE\rXY');
  const snap = s.snapshot(7);
  assert.equal(snap.lines[0], 'XYCDE');
  assert.deepEqual(snap.cursor, { x: 2, y: 0 });
  assert.equal(snap.alt, false);
  assert.equal(snap.seq, 7);
  s.dispose();
});

test('G25: terminal queries produce replies through onReply, and only there', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  const replies: string[] = [];
  s.onReply((d) => replies.push(d));
  await s.write('\x1b[6n');
  assert.deepEqual(replies, ['\x1b[1;1R']);
  s.dispose();
});

test('alternate-screen transitions are observed at chunk granularity', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  const modes: boolean[] = [];
  s.onMode((alt) => modes.push(alt));
  await s.write('\x1b[?1049h');
  await s.write('inside');
  await s.write('\x1b[?1049l');
  assert.deepEqual(modes, [true, false]);
  assert.equal(s.alt, false);
  s.dispose();
});

test('transcript is a projection of the range, not what a human saw (§6)', async () => {
  assert.equal(await transcript(['ABCDE', '\rXY'], { cols: 20 }), 'XYCDE');
  assert.equal(await transcript(['\rXY'], { cols: 20 }), 'XY');
  assert.equal(await transcript(['line1\r\nline2\r\n\r\n\r\n'], { cols: 20 }), 'line1\nline2');
  assert.equal(await transcript(['\x1b[31mred\x1b[0m'], { cols: 20 }), 'red');
});

test('transcript renders alternate-screen content as its final frame', async () => {
  const t = await transcript(['\x1b[?1049h', '\x1b[2J\x1b[Hframe\x1b[2;1Hbottom'], { cols: 20, rows: 3 });
  assert.equal(t, 'frame\nbottom');
});

// ───────────── emu-2 / emu-10: batching and the applied position ─────────────

test('emu-2: an alternate-screen enter and exit inside one batch are both observed, in order', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  const modes: boolean[] = [];
  s.onMode((alt) => modes.push(alt));
  // Not awaited one by one: all three land in the same xterm write.
  void s.write('\x1b[?1049h');
  void s.write('inside');
  await s.write('\x1b[?1049l');
  assert.deepEqual(modes, [true, false]);
  s.dispose();
});

test('emu-2: writes queued in one turn share one promise and one parse', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  const a = s.write('a', 1);
  const b = s.write('b', 2);
  assert.equal(a, b, 'one promise per batch, not per chunk');
  await b;
  assert.equal(s.snapshot().lines[0], 'ab');
  assert.equal(s.appliedSeq, 2);
  s.dispose();
});

test('emu-10 / G13: a snapshot claims only the position the emulator has parsed', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  await s.write('FIRST', 9);
  // SECOND is journaled (seq 10) and queued, but not parsed yet.
  const pending = s.write('\rSECOND', 10);
  const early = s.snapshot();
  assert.equal(early.seq, 9);
  assert.equal(early.lines[0], 'FIRST');
  await pending;
  const late = s.snapshot();
  assert.equal(late.seq, 10);
  assert.equal(late.lines[0], 'SECOND');
  s.dispose();
});

test('emu-10 / G14: at every observation point the snapshot seq matches the screen, never ahead of it', async () => {
  const s = new Screen({ cols: 40, rows: 6 });
  const seen: Array<{ seq: number; last: string }> = [];
  const observe = () => {
    const snap = s.snapshot();
    seen.push({ seq: snap.seq, last: snap.lines.filter((l) => l !== '').at(-1) ?? '' });
  };
  let seq = 0;
  for (let round = 0; round < 200; round++) {
    const n = 1 + (round % 7);
    for (let k = 0; k < n; k++) {
      seq++;
      void s.write(`${seq}\r\n`, seq);
      if (k % 3 === 0) observe();
    }
    if (round % 2 === 0) await new Promise((r) => setImmediate(r));
    else await Promise.resolve();
    observe();
  }
  await s.settled();
  observe();
  for (const o of seen) assert.equal(o.last, o.seq === 0 ? '' : String(o.seq), `snapshot at seq ${o.seq} showed ${o.last}`);
  assert.equal(seen.at(-1)!.seq, seq);
  s.dispose();
});

test('emu-10: a write carrying only a position advances appliedSeq in order', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  void s.write('x', 3);
  await s.write('', 4);
  assert.equal(s.appliedSeq, 4);
  assert.equal(s.snapshot().lines[0], 'x');
  s.dispose();
});

test('emu-2: resize goes through the queue: output written before it is parsed at the old size', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  void s.write('\x1b[999C*'); // to the last column, then a star
  s.resize(40, 4);
  assert.equal(s.cols, 40, 'the requested size is visible at once');
  await s.settled();
  const snap = s.snapshot();
  assert.equal(snap.lines[0], `${' '.repeat(19)}*`);
  assert.equal(snap.cols, 40);
  s.dispose();
});

test('dispose resolves everything still queued', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  const p = s.write('x'.repeat(10_000), 1);
  s.dispose();
  await p;
  await s.settled();
  assert.equal(await s.write('after'), undefined);
});

test('emu-7: applicationCursorKeys follows DECCKM as parsed', async () => {
  const s = new Screen({ cols: 20, rows: 4 });
  assert.equal(s.applicationCursorKeys, false);
  await s.write('\x1b[?1h\x1b=');
  assert.equal(s.applicationCursorKeys, true);
  await s.write('\x1b[?1l\x1b>');
  assert.equal(s.applicationCursorKeys, false);
  s.dispose();
});

// ───────────── G13: serialize reproduces the screen ─────────────

function cells(t: TerminalType, which: 'normal' | 'alternate') {
  const buf = t.buffer[which];
  const out: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)!;
    let row = `${line.isWrapped ? '~' : ' '}`;
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x)!;
      row += `${c.getChars() || ' '}${c.getWidth()}${c.getFgColorMode()}:${c.getFgColor()}/${c.isBold()}${c.isInverse()}|`;
    }
    out.push(row);
  }
  return out;
}

async function replay(data: string, cols: number, rows: number): Promise<TerminalType> {
  const t = new xterm.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((r) => t.write(data, r));
  return t;
}

test('G13: serialize → a fresh emulator reproduces cells, cursor and modes (normal screen)', async () => {
  const s = new Screen({ cols: 30, rows: 5 });
  await s.write('plain line\r\n\x1b[1;31mbold red\x1b[0m and \x1b[7minverse\x1b[0m\r\n', 5);
  await s.write(`${'w'.repeat(45)}\r\n日本語 wide\r\npartial`, 6);
  await s.write('\x1b[?1h\x1b[?2004h', 7);
  const ser = s.serialize();
  assert.equal(ser.seq, 7);
  assert.equal(ser.seq, s.appliedSeq);
  assert.equal(ser.alt, false);
  const t = await replay(ser.data, ser.cols, ser.rows);
  const src = (s as unknown as { term: TerminalType }).term;
  assert.deepEqual(cells(t, 'normal'), cells(src, 'normal'));
  assert.deepEqual({ x: t.buffer.active.cursorX, y: t.buffer.active.cursorY }, { x: src.buffer.active.cursorX, y: src.buffer.active.cursorY });
  assert.equal(t.modes.applicationCursorKeysMode, true);
  assert.equal(t.modes.bracketedPasteMode, true);
  t.dispose();
  s.dispose();
});

test('G13: serialize reproduces the alternate screen, the normal screen under it, and the cursor', async () => {
  const s = new Screen({ cols: 30, rows: 6 });
  await s.write('$ htop\r\n', 1);
  await s.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[1;1H\x1b[32mCPU [|||   ]\x1b[0m\x1b[3;5Htasks: 12\x1b[6;1H\x1b[7mF10 Quit\x1b[0m\x1b[2;3H', 2);
  const ser = s.serialize();
  assert.equal(ser.alt, true);
  const t = await replay(ser.data, ser.cols, ser.rows);
  const src = (s as unknown as { term: TerminalType }).term;
  assert.equal(t.buffer.active.type, 'alternate');
  assert.deepEqual(cells(t, 'alternate'), cells(src, 'alternate'));
  assert.deepEqual({ x: t.buffer.active.cursorX, y: t.buffer.active.cursorY }, { x: 2, y: 1 });
  // Leaving the alternate screen in the replica restores the same normal screen.
  await new Promise<void>((r) => t.write('\x1b[?1049l', r));
  await s.write('\x1b[?1049l', 3);
  assert.deepEqual(t.buffer.active.getLine(0)!.translateToString(true), '$ htop');
  assert.deepEqual(cells(t, 'normal').slice(0, 6), cells(src, 'normal').slice(0, 6));
  t.dispose();
  s.dispose();
});
