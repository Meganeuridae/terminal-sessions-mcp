import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';
import { persistentState, Screen } from '../src/core/screen.js';
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

// ───────────── persistentState: the lasting state of discarded output ─────────────

test('persistentState keeps the last setting of each thing, in order, so its size is bounded by the state, not the output', () => {
  const frame = `\x1b[?25l${'z'.repeat(100)}\x1b[?25h`;
  // A mode keeps its last set and its last reset, in their order: the final state is the later one, and a
  // visit (set, then reset) is still a visit when replayed.
  assert.equal(persistentState(frame.repeat(400)), '\x1b[?25l\x1b[?25h');
  assert.equal(persistentState(`${frame.repeat(3)}\x1b[?25l`), '\x1b[?25h\x1b[?25l');
  assert.equal(persistentState('\x1b[?1h\x1b[?2004h\x1b[?1l\x1b[?1h'), '\x1b[?2004h\x1b[?1l\x1b[?1h');
  // Several modes in one sequence are split.
  assert.equal(persistentState('\x1b[?1;2004h\x1b[?1l'), '\x1b[?1h\x1b[?2004h\x1b[?1l');
  assert.equal(persistentState('\x1b[4h\x1b[?4h\x1b[4h'), '\x1b[?4h\x1b[4h', 'an ANSI mode and the private mode of the same number are different modes');
  // Keypad mode, the scroll region and each character set's designation keep their last value.
  assert.equal(persistentState('\x1b=\x1b>\x1b='), '\x1b=');
  assert.equal(persistentState('\x1b[1;5r\x1b[2;8r'), '\x1b[2;8r');
  assert.equal(persistentState('\x1b(0\x1b)0\x1b(B'), '\x1b)0\x1b(B');
  assert.equal(persistentState('\x0e\x0f\x0e'), '\x0e');
  // A full reset discards what came before it, and only that.
  assert.equal(persistentState('\x1b[?1h\x1b[1;5r\x1bc\x1b[?2004h'), '\x1bc\x1b[?2004h');
  // Idempotent: the state of a state is itself.
  const once = persistentState(`${frame.repeat(5)}\x1b[?1h\x1b=\x1b[2;8r\x1b)0\x0e\x1b]2;t\x07`);
  assert.equal(persistentState(once), once);
});

test('persistentState: a soft reset stays where it was, so the shift and designations before it are reset as a terminal resets them', async () => {
  // SO, DECSTR, then G1 = DEC graphics: a terminal shows `lqqk` as text (DECSTR shifted back in).
  assert.equal(persistentState('\x0e\x1b[!p\x1b)0'), '\x0e\x1b[!p\x1b)0');
  assert.equal(persistentState('\x1b[!p\x0e\x1b)0'), '\x1b[!p\x0e\x1b)0');
  // The terminal agrees: the kept state replayed, then `lqqk`.
  const check = async (data: string) => {
    const t = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true });
    await new Promise<void>((r) => t.write(`${data}lqqk`, r));
    const text = t.buffer.active.getLine(0)!.translateToString(true);
    t.dispose();
    return text;
  };
  assert.equal(await check('\x0e\x1b[!p\x1b)0'), 'lqqk');
  assert.equal(await check(persistentState('\x0e\x1b[!p\x1b)0')), 'lqqk');
  assert.equal(await check(persistentState('\x1b[!p\x1b)0\x0e')), '┌──┐', 'a shift after the soft reset holds');
});

test('persistentState: a title and an icon name are both kept; OSC 0 sets both', () => {
  assert.equal(persistentState('\x1b]2;title\x07\x1b]1;icon\x07'), '\x1b]2;title\x07\x1b]1;icon\x07');
  assert.equal(persistentState('\x1b]1;icon\x07\x1b]2;title\x07'), '\x1b]1;icon\x07\x1b]2;title\x07');
  assert.equal(persistentState('\x1b]0;both\x07'), '\x1b]0;both\x07');
  assert.equal(persistentState('\x1b]2;old\x07\x1b]0;both\x07'), '\x1b]0;both\x07');
  // OSC 0 then OSC 2: the title is the later one, the icon still OSC 0's, which therefore goes first.
  assert.equal(persistentState('\x1b]0;both\x07\x1b]2;title\x07'), '\x1b]0;both\x07\x1b]2;title\x07');
  assert.equal(persistentState('\x1b]2;title\x07\x1b]0;both\x07\x1b]1;icon\x1b\\'), '\x1b]0;both\x07\x1b]1;icon\x1b\\');
});

test('persistentState keeps what the emulator applies of a sequence with C0 controls inside it, and of the C1 forms (our review of the 40 commits through 4f4c067, PR #22)', async () => {
  // The filter matched spellings: `ESC [ ? 10 CR 49 h` and `ESC [ BEL 4 h` kept nothing, where the emulator executes the
  // CR and the BEL inside the CSI and then switches to the alternate screen and sets insert mode.
  const state = async (data: string) => {
    const t = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true, logLevel: 'off' });
    await new Promise<void>((r) => t.write(data, r));
    const s = { alt: t.buffer.active.type === 'alternate', insert: t.modes.insertMode };
    t.dispose();
    return s;
  };
  for (const [data, kept] of [
    ['x\x1b[?10\r49hy', '\x1b[?1049h'],
    ['x\x1b[\x074hy', '\x1b[4h'],
    ['x\x1b\n[4h', '\x1b[4h'],
    ['x\x9b4hy', '\x1b[4h'],
    ['\x1b[\x0e4h', '\x0e\x1b[4h'],
    ['\x9d2;title\x9cz', '\x1b]2;title\x1b\\'],
    // A DEL inside, which the emulator ignores, with no C0 beside it.
    ['x\x1b[4\x7fhy', '\x1b[4h'],
    ['x\x1b[?10\x7f49hy', '\x1b[?1049h'],
  ] as const) {
    assert.equal(persistentState(data), kept, JSON.stringify(data));
    const whole = await state(data);
    const replayed = await state(persistentState(data));
    assert.deepEqual([replayed.alt, replayed.insert], [whole.alt, whole.insert], `the replay reaches the emulator's state: ${JSON.stringify(data)}`);
  }
  // A title ended where an ESC begins another sequence is set, as the emulator sets it; CAN, SUB or another C1 control
  // ends it unset.
  const title = async (data: string) => {
    const t = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true, logLevel: 'off' });
    let s = '';
    t.onTitleChange((x) => (s = x));
    await new Promise<void>((r) => t.write(data, r));
    t.dispose();
    return s;
  };
  for (const [ender, set] of [
    ['\x1b[0m', true],
    ['\x1b7', true],
    ['\x1b]2;b\x07', true],
    ['\x07', true],
    ['\x9c', true],
    ['\x18', false],
    ['\x1a', false],
    ['\x9b0m', false],
    ['\x85', false],
  ] as const) {
    const data = `\x1b]2;hello${ender}`;
    assert.equal(await title(data), set ? (ender.startsWith('\x1b]') ? 'b' : 'hello') : '', `the emulator: ${JSON.stringify(data)}`);
    assert.equal(await title(persistentState(data)), await title(data), `the replay: ${JSON.stringify(data)}`);
  }
  // A shift inside a control string's payload is payload, and sets nothing, as the emulator shows: with G1 the DEC
  // graphics set, `lqqk` after SO inside a title, a clipboard, a DCS or an APC is still `lqqk`. Before a string's
  // kind, or inside a CSI, a shift acts.
  const shown = async (data: string) => {
    const t = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true, logLevel: 'off' });
    await new Promise<void>((r) => t.write(`\x1b)0${data}lqqk`, r));
    const text = t.buffer.active.getLine(0)!.translateToString(true);
    t.dispose();
    return text;
  };
  for (const [data, acts] of [
    ['\x1b]2;a\x0eb\x07', false],
    ['\x1b]52;c;\x0e\x07', false],
    ['\x1bPq\x0e\x1b\\', false],
    ['\x1b_x\x0e\x1b\\', false],
    ['\x1b\x0e]2;t\x07', true],
    ['\x1b[\x0e4h', true],
  ] as const) {
    assert.equal(await shown(data), acts ? '\u250c\u2500\u2500\u2510' : 'lqqk', `the emulator: ${JSON.stringify(data)}`);
    assert.equal(await shown(persistentState(data)), await shown(data), `the replay: ${JSON.stringify(data)}`);
  }
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

test('G13: serialize carries the scroll region, so a replica scrolls where the original does', async () => {
  const s = new Screen({ cols: 20, rows: 8 });
  await s.write('\x1b[1;5r\x1b[5;1Hone\r\n', 1);
  const ser = s.serialize();
  assert.match(ser.data, /\x1b\[1;5r/);
  const t = await replay(ser.data, ser.cols, ser.rows);
  const src = (s as unknown as { term: TerminalType }).term;
  assert.deepEqual({ x: t.buffer.active.cursorX, y: t.buffer.active.cursorY }, { x: src.buffer.active.cursorX, y: src.buffer.active.cursorY }, 'DECSTBM homed nothing');
  await new Promise<void>((r) => t.write('two\r\nthree\r\nfour\r\n', r));
  await s.write('two\r\nthree\r\nfour\r\n', 2);
  const rows = (term: TerminalType) => Array.from({ length: term.rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)!.translateToString(true));
  assert.deepEqual(rows(t), rows(src));
  assert.deepEqual(rows(t).slice(0, 5), ['one', 'two', 'three', 'four', ''], 'the lines scrolled within rows 1–5, the cursor on row 5');
  assert.equal(rows(t)[5], '', 'nothing below the region');
  t.dispose();
  s.dispose();
  // A full-screen region is not emitted.
  const plain = new Screen({ cols: 20, rows: 8 });
  await plain.write('x', 1);
  assert.doesNotMatch(plain.serialize().data, /\d*;\d*r/);
  plain.dispose();
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
