/**
 * The transcript projection (§6, G10, G11): the semantics stated in
 * src/core/transcript.ts, rule by rule, and floods (tg-4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { persistentState } from '../src/core/screen.js';
import { project, transcript } from '../src/core/transcript.js';
import type { ProjectChunk } from '../src/core/transcript.js';

const MB = 1024 * 1024;
const text = async (chunks: ProjectChunk[], cols = 40, rows = 10) => (await project(chunks, { cols, rows })).text;

// ───────────── rule 6: pipe streams (emu-4, jr-5) ─────────────

test('emu-4 / jr-5: process stdout and stderr are pipes: a bare LF starts the next line at column 0', async () => {
  assert.equal(await text([{ data: 'alpha\nbeta\ngamma\n', stream: 'stdout' }]), 'alpha\nbeta\ngamma');
  assert.equal(await text([{ data: 'one\ntwo\n', stream: 'stdout' }, { data: 'err\n', stream: 'stderr' }, { data: 'three\n', stream: 'stdout' }]), 'one\ntwo\nerr\nthree');
  // Indentation survives (tracebacks, YAML, diffs).
  assert.equal(await text([{ data: 'Traceback:\n  File "x.py", line 1\n    boom()\n', stream: 'stderr' }]), 'Traceback:\n  File "x.py", line 1\n    boom()');
  // CR-driven progress in a pipe still resolves; CRLF from a pipe is not doubled.
  assert.equal(await text([{ data: 'progress 10%\rprogress 100%\ndone\r\n', stream: 'stdout' }]), 'progress 100%\ndone');
  // A chunk boundary between CR and LF changes nothing.
  assert.equal(await text([{ data: 'a\r', stream: 'stdout' }, { data: '\nb\n', stream: 'stdout' }]), 'a\nb');
});

test('emu-4 / jr-5: a real process Run of multi-line output projects without a staircase', async () => {
  const backend = new NodePtyBackend();
  const proc = backend.spawnProcess({ argv: ['/bin/sh', '-c', "printf 'one\\ntwo\\nthree\\n'; seq 1 12; printf 'err line\\n' >&2"], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
  const chunks: ProjectChunk[] = [];
  proc.onStdout((d) => chunks.push({ data: d, stream: 'stdout', runId: 'r1' }));
  proc.onStderr((d) => chunks.push({ data: d, stream: 'stderr', runId: 'r1' }));
  await new Promise<void>((r) => proc.onExit(() => r()));
  await new Promise((r) => setTimeout(r, 50)); // late pipe data after exit
  const lines = (await project(chunks, { cols: 20 })).text.split('\n');
  assert.deepEqual(lines.filter((l) => l !== 'err line'), ['one', 'two', 'three', ...Array.from({ length: 12 }, (_, i) => String(i + 1))]);
  assert.ok(lines.includes('err line'));
});

test('rule 6: when the source changes, the next source starts on a fresh line', async () => {
  // The prompt's unfinished line waits for the shell to end it, so the process lines do not split it.
  const t = await text(['$ cmd\r\n$ ', { data: 'p1\np2\n', stream: 'stdout', runId: 'r1' }, '\r\x1b[K$ ls\r\n']);
  assert.equal(t, '$ cmd\np1\np2\n$ ls');
  // No blank line is invented when the previous source ended its line.
  assert.equal(await text(['shell out\r\n', { data: 'proc out\n', stream: 'stdout' }]), 'shell out\nproc out');
  // A source's line that is never ended comes after the others, on a line of its own.
  assert.equal(await text([{ data: 'partial', stream: 'stdout', runId: 'r1' }, 'shell\r\n']), 'shell\npartial');
});

test('er-8 (rule 6): concurrent process Runs are interleaved by whole lines, never mid-line', async () => {
  const chunks: ProjectChunk[] = [
    { data: 'A1-start ', stream: 'stdout', runId: 'rA' },
    { data: 'B1-start ', stream: 'stdout', runId: 'rB' },
    { data: 'A1-end\nA2-start ', stream: 'stdout', runId: 'rA' },
    { data: 'B1-end\nB2-start ', stream: 'stdout', runId: 'rB' },
    { data: 'A2-end\n', stream: 'stdout', runId: 'rA' },
    { data: 'B2-end\n', stream: 'stdout', runId: 'rB' },
  ];
  assert.equal(await text(chunks, 60), 'A1-start A1-end\nB1-start B1-end\nA2-start A2-end\nB2-start B2-end');
  // One Run's stdout and stderr are one source, as a terminal would show them.
  assert.equal(await text([{ data: 'out ', stream: 'stdout', runId: 'r1' }, { data: 'err\n', stream: 'stderr', runId: 'r1' }], 60), 'out err');
  // A label heads each change of source.
  const labelled = await project(chunks, { cols: 60, label: (s) => (s.stream === 'pty' ? '[terminal]' : `[run ${s.runId}]`) });
  assert.equal(labelled.text, '[run rA]\nA1-start A1-end\n[run rB]\nB1-start B1-end\n[run rA]\nA2-start A2-end\n[run rB]\nB2-start B2-end');
});

test('jr2-11: a note is a line of its own, between the lines around it', async () => {
  assert.equal(await text(['before\r\n', { note: '[… 1 journal event missing …]' }, 'after\r\n']), 'before\n[… 1 journal event missing …]\nafter');
  // An unfinished line is not continued across the note: the hole may hold its end.
  assert.equal(await text(['half', { note: '[gap]' }, ' rest\r\n']), 'half\n[gap]\n rest');
});

test('rule 3: `open` keeps the trailing whitespace of the last line, which the next range continues', async () => {
  assert.equal((await project(['one\r\nsome '], { cols: 40, open: true })).text, 'one\nsome ');
  assert.equal((await project(['one\r\nsome '], { cols: 40 })).text, 'one\nsome');
  assert.equal((await project(['one   \r\ntwo '], { cols: 40, open: true })).text, 'one\ntwo ', 'only the last line stays open');
});

// ───────────── rule 3: logical lines (emu-5) ─────────────

test('emu-5: soft-wrapped rows are joined; the output has no newline the program did not write', async () => {
  const long = `${'x'.repeat(100)}END`;
  assert.equal(await text([`${long}\r\n`], 40), long);
  // A space that falls on the wrap point is kept.
  assert.equal(await text([`${'A'.repeat(39)} B\r\n`], 40), `${'A'.repeat(39)} B`);
  // Single-line JSON longer than the width still parses.
  const json = JSON.stringify({ url: `https://example.com/${'a'.repeat(150)}`, list: [1, 2, 3], s: 'x '.repeat(40) });
  assert.deepEqual(JSON.parse(await text([`${json}\r\n`], 40)), JSON.parse(json));
  // Wide characters that do not fit at the end of a row wrap without inventing a space.
  const cjk = '日本語テキスト'.repeat(10);
  assert.equal(await text([`${cjk}\r\n`], 21), cjk);
  // Pipe output wraps and joins the same way.
  assert.equal(await text([{ data: `${long}\n`, stream: 'stdout' }], 40), long);
});

test('emu-5: trailing whitespace is trimmed at the end of a logical line only', async () => {
  assert.equal(await text(['+foo   \r\n+bar\r\n']), '+foo\n+bar');
  const padded = `${'B'.repeat(38)}  C`; // two spaces straddle the wrap point
  assert.equal(await text([`${padded}\r\n`], 40), padded);
});

// ───────────── rules 2, 4, 5: what the projection keeps (emu-8) ─────────────

test('emu-8: every row up to the last non-empty one is kept, wherever the cursor ended', async () => {
  assert.equal(await text(['line1\r\nline2\r\nline3\r\n\x1b[2A']), 'line1\nline2\nline3');
  assert.equal(await text(['header\r\n\x1b7bar1\r\nbar2\x1b8']), 'header\nbar1\nbar2');
  // A multi-bar progress block with the cursor parked at its top.
  const bars = 'pull a: [==  ]\r\npull b: [=   ]\r\npull c: [    ]\r\n\x1b[3A';
  const redraw = '\rpull a: [====]\r\n\rpull b: [==  ]\r\n\rpull c: [=   ]\r\n\x1b[3A';
  assert.equal(await text([bars, redraw]), 'pull a: [====]\npull b: [==  ]\npull c: [=   ]');
  // In-range cursor motion still resolves.
  assert.equal(await text(['ABCDE', '\rXY']), 'XYCDE');
  assert.equal(await text(['50%\r\x1b[K100%\r\n']), '100%');
});

test('emu-8: an erase of the whole display keeps what it erased', async () => {
  assert.equal(await text(['before-clear\r\n\x1b[H\x1b[2J\x1b[3Jafter-clear\r\n']), 'before-clear\nafter-clear');
  assert.equal(await text(['before\r\n\x1b[2Jafter']), 'before\nafter');
  assert.equal(await text(['one\r\ntwo\r\n\x1b[H\x1b[Jthree\r\n']), 'one\ntwo\nthree');
  // npm install && npm run dev: the dev server clears the screen on start.
  const install = Array.from({ length: 30 }, (_, i) => `added package ${i}\r\n`).join('');
  const t = await text([install, '\x1b[2J\x1b[3J\x1b[H  VITE ready in 300 ms\r\n'], 60, 10);
  assert.equal(t.split('\n')[0], 'added package 0');
  assert.equal(t.split('\n').at(-1), '  VITE ready in 300 ms');
  assert.equal(t.split('\n').length, 31);
  // Clearing only the scrollback keeps it too.
  const many = Array.from({ length: 25 }, (_, i) => `row ${i}\r\n`).join('');
  assert.equal((await text([many, '\x1b[3Jend\r\n'], 40, 5)).split('\n').length, 26);
  // A full reset (RIS) keeps both buffers' content.
  assert.equal(await text(['kept\r\n\x1bcfresh']), 'kept\nfresh');
});

test('emu-8: partial erases are in-range redraws and resolve', async () => {
  assert.equal(await text(['a\r\nb\r\nc\x1b[2;1H\x1b[Jz']), 'a\nz'); // erase below, from row 2
  assert.equal(await text(['keep\r\nx\x1b[1K\x1b[2Ky']), 'keep\n y');
});

test('emu-8: a full-screen program leaves its final frame in the transcript', async () => {
  const range = ['$ htop\r\n', '\x1b[?1049h\x1b[H\x1b[2Jframe 1', '\x1b[H\x1b[2JCPU [||  ]\x1b[3;1Htasks: 3\x1b[?1049l', '$ '];
  assert.equal(await text(range), '$ htop\nCPU [||  ]\n\ntasks: 3\n$');
  // A range that ends while the program runs ends with its current frame, after what preceded it.
  assert.equal(await text(['$ vim f\r\n', '\x1b[?1049h\x1b[Hline one\r\n~\r\n~']), '$ vim f\nline one\n~\n~');
  // An empty last frame adds nothing.
  assert.equal(await text(['$ less\r\n\x1b[?1049h\x1b[H\x1b[2J\x1b[?1049l$ ']), '$ less\n$');
});

test('rule 4: a saved cursor is rebased when the screen clears, as after the scrollback is cleared', async () => {
  // 60 lines on 10 rows, DECSC, ED 2, `cleared`, DECRC, `RESTORED`: a terminal writes RESTORED over cleared.
  const sixty = Array.from({ length: 60 }, (_, i) => `line ${i}\r\n`).join('');
  const p = await project([`${sixty}\x1b7\x1b[2Jcleared\x1b8RESTORED`], { cols: 40, rows: 10 });
  const lines = p.text.split('\n');
  assert.equal(lines.length, 61);
  assert.equal(lines[59], 'line 59');
  assert.equal(lines[60], 'RESTORED');
  // The same across an alternate-screen entry that keeps the content (mode 47 saves no cursor of its own).
  const q = await project([`${sixty}\x1b7\x1b[?47hframe\x1b[?47l\x1b8OVER`], { cols: 40, rows: 10 });
  assert.ok(q.text.endsWith('line 59\nframe\nOVER'), q.text.split('\n').slice(-4).join('|'));
});

test('a batch never ends inside a control sequence: a long OSC payload across the batch cap does not print', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}\r\n`).join('');
  const payload = `\x1b]52;c;${'A'.repeat(600_000)}\x07`;
  for (const cols of [80, 120, 140, 200]) {
    const p = await project([`${lines}${payload}after\r\n`], { cols, rows: 30 });
    const out = p.text.split('\n');
    assert.equal(out.length, 101, `${cols} columns: ${out.length} lines`);
    assert.equal(out.at(-1), 'after', `${cols} columns`);
    assert.equal(p.truncated, false);
  }
  // Chunked as a PTY delivers it, and with the payload unterminated to the end of the range.
  const chunks: string[] = [];
  const data = `${lines}${payload}after\r\n`;
  for (let i = 0; i < data.length; i += 4096) chunks.push(data.slice(i, i + 4096));
  assert.equal((await project(chunks, { cols: 140, rows: 30 })).text.split('\n').at(-1), 'after');
  const open = await project([`${lines}\x1b]52;c;${'A'.repeat(600_000)}`], { cols: 140, rows: 30 });
  assert.equal(open.text.split('\n').length, 100, 'an unterminated payload prints nothing');
});

test('rule 7: the tail cut does not count the newlines of a full-screen program\'s frames, which project as one frame', async () => {
  const frame = (f: number) => `\x1b[H\x1b[2Jframe ${f}${'\r\n'.repeat(28)}`;
  const chunks = ['before\r\n', '\x1b[?1049h', ...[0, 1, 2, 3, 4].map(frame), '\x1b[?1049l', 'after\r\n'];
  const p = await project(chunks, { cols: 80, rows: 30, maxLines: 10 });
  assert.deepEqual(p.text.split('\n'), ['before', 'frame 4', 'after']);
  assert.equal(p.truncated, false);
  assert.equal(p.omittedInputBytes, 0);
  // A range that ends inside the program keeps the line it interrupted too.
  const inside = await project(['before\r\n', '\x1b[?1049h', ...[0, 1, 2].map(frame)], { cols: 80, rows: 30, maxLines: 10 });
  assert.deepEqual(inside.text.split('\n'), ['before', 'frame 2']);
  assert.equal(inside.truncated, false);
  // Lines outside the program still count, and the cut never lands inside the program's time.
  const many = Array.from({ length: 100 }, (_, i) => `L${i}\r\n`).join('');
  const r = await project([many, '\x1b[?1049h', frame(1), '\x1b[?1049l', 'after\r\n'], { cols: 80, rows: 30, maxLines: 10 });
  assert.equal(r.truncated, true);
  assert.ok(r.omittedInputBytes > 0);
  assert.deepEqual(r.text.split('\n').slice(-2), ['frame 1', 'after']);
  assert.equal(r.text.split('\n').length, 10);
});

test('rule 7: the lasting state of an omitted head still applies: a scroll region, a character set and a shift', async () => {
  // Eight lines from the top row into a region of rows 2–5: lines 1 to 4 scroll out of the region and are
  // gone, as a terminal shows it (a region from row 1 scrolls into the scrollback, which the projection keeps).
  // The budget lands in the omitted head's line, within reach of the boundary, so the kept input is the eight lines.
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i}\r\n`).join('');
  const region = await project([`\x1b[2;5r${'h'.repeat(300)}\r\n`, lines], { cols: 80, rows: 10, maxInputBytes: 100 });
  assert.deepEqual(region.text.split('\n'), ['line 0', 'line 5', 'line 6', 'line 7']);
  assert.equal(region.omittedInputBytes, 6 + 300 + 2);
  // G1 = DEC graphics and shift out, set in the omitted head, draw the box characters of the tail.
  const box = await project([`\x1b)0\x0e${'h'.repeat(30)}\r\n`, 'lqqk\r\n'], { cols: 80, rows: 10, maxInputBytes: 10 });
  assert.deepEqual(box.text.split('\n'), ['┌──┐']);
  assert.equal(box.omittedInputBytes, 3 + 1 + 30 + 2);
  // With keypad mode, a reset and a soft reset in the head's state (not visible in text; the state string shows them).
  assert.equal(persistentState('\x1b=\x1b[?1h'), '\x1b=\x1b[?1h');
  assert.equal(persistentState('\x1b[1;5r\x1bc\x1b='), '\x1bc\x1b=');
  assert.equal(persistentState('\x0e\x1b[!p'), '\x0e\x1b[!p');
});

// ───────────── rules 2 and 4 across batches: the saved cursor (er-2) ─────────────

/** A reference: xterm with a scrollback no range here can outrun, read out as logical lines. */
async function reference(data: string, cols: number, rows: number): Promise<string> {
  const xterm = (await import('@xterm/headless')).default;
  const t = new xterm.Terminal({ cols, rows, scrollback: 10_000_000, allowProposedApi: true });
  await new Promise<void>((r) => t.write(data, r));
  const b = t.buffer.active;
  let last = -1;
  for (let y = b.length - 1; y >= 0; y--) if (b.getLine(y)!.translateToString(true).trim()) { last = y; break; }
  const out: string[] = [];
  for (let y = 0; y <= last; y++) {
    const l = b.getLine(y)!;
    const s = l.translateToString(true);
    if (l.isWrapped && out.length) out[out.length - 1] += s;
    else out.push(s);
  }
  t.dispose();
  return out.map((s) => s.replace(/\s+$/, '')).join('\n');
}

/**
 * apt's Dpkg::Progress-Fancy as apt-pkg/install-progress.cc writes it: a scroll
 * region above a status line drawn under DECSC/DECRC, set up and torn down by
 * SetupTerminalScrollArea (newline, DECSC, DECSTBM, DECRC, cursor up; then ED 0).
 */
function aptStream(packages: number, rows: number): string {
  let s = `\n\x1b7\x1b[0;${rows - 1}r\x1b8\x1b[1A`;
  for (let i = 1; i <= packages; i++) {
    for (const verb of ['Selecting previously unselected package', 'Preparing to unpack', 'Unpacking', 'Setting up']) {
      s += `${verb} pkg-${i} (1.${i}) ...\r\n`;
      const pct = Math.floor((100 * i) / packages);
      s += `\x1b7\x1b[${rows};0f\x1b[42m\x1b[30mProgress: [${String(pct).padStart(3)}%]\x1b[49m\x1b[39m [${'#'.repeat(pct >> 1)}${'.'.repeat(50 - (pct >> 1))}] \x1b8`;
    }
  }
  return `${s}\n\x1b7\x1b[0;${rows}r\x1b8\x1b[1A\x1b[JProcessing triggers for man-db ...\r\nDONE-APT\r\n`;
}

test('er-2: apt-style output (scroll region + DECSC/DECRC status line) keeps every line, as a real terminal does', async () => {
  const rows = 30;
  const data = aptStream(600, rows);
  const p = await project([data], { cols: 120, rows });
  const setUp = p.text.split('\n').filter((l) => l.startsWith('Setting up pkg-'));
  assert.equal(setUp.length, 600, `Setting up lines kept: ${setUp.length}`);
  assert.equal(setUp.at(-1), 'Setting up pkg-600 (1.600) ...');
  assert.ok(p.text.endsWith('Processing triggers for man-db ...\nDONE-APT'));
  assert.equal(p.truncated, false);
  assert.equal(p.text, await reference(data, 120, rows));
  // The same bytes as a PTY delivers them (1 KiB reads) project the same.
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 1024) chunks.push(data.slice(i, i + 1024));
  assert.equal((await project(chunks, { cols: 120, rows })).text, p.text);
});

test('er-2: DECSC/DECRC straddling a batch boundary, with and without a scroll region, matches the reference', async () => {
  const rows = 10;
  const cols = 37;
  let plain = '';
  for (let i = 1; i <= 6000; i++) plain += `line ${i}\r\n\x1b7\x1b[${rows};1H\x1b[42mstatus ${i}\x1b[0m\x1b8`;
  let region = `\x1b[1;${rows - 1}r`;
  for (let i = 1; i <= 6000; i++) region += `row ${i}\r\n\x1b[s\x1b[${rows};1Hstat ${i}\x1b[u`;
  for (const data of [plain, region]) assert.equal((await project([data], { cols, rows })).text, await reference(data, cols, rows));
});

// ───────────── rule 1: geometry (emu-13) ─────────────

test('emu-13: rows are the caller\'s, so a tall alternate-screen frame keeps its rows', async () => {
  const frame = '\x1b[?1049h\x1b[1;1Hrow1\x1b[40;1Hrow40\x1b[45;1Hstatus';
  const tall = (await project([frame], { cols: 40, rows: 50 })).text.split('\n');
  assert.equal(tall.length, 45);
  assert.equal(tall[39], 'row40');
  assert.equal(tall[44], 'status');
  // At the old default of 30 rows the lower rows collapse onto the last one.
  const short = (await project([frame], { cols: 40, rows: 30 })).text.split('\n');
  assert.equal(short.length, 30);
  assert.ok(!short.includes('row40'));
});

// ───────────── rule 7: budgets (emu-9, jr-17, api-20) ─────────────

const numbered = (n: number, eol = '\r\n') => Array.from({ length: n }, (_, i) => `L${i}`).join(eol) + eol;

test('emu-9 / jr-17: more lines than maxLines: the tail is kept and truncated is true', async () => {
  const r = await project([numbered(100_000)], { cols: 80 });
  const lines = r.text.split('\n');
  assert.equal(r.truncated, true);
  assert.equal(lines.length, 50_000);
  assert.equal(lines[0], 'L50000');
  assert.equal(lines.at(-1), 'L99999');
  const head = await project([numbered(100_000)], { cols: 80, maxLines: 1000, keep: 'head' });
  assert.equal(head.truncated, true);
  assert.deepEqual(head.text.split('\n'), Array.from({ length: 1000 }, (_, i) => `L${i}`));
  assert.ok(head.omittedInputBytes > 0);
});

test('emu-9 / jr-17: under maxLines nothing is dropped and truncated is false, even far past the scratch scrollback', async () => {
  const r = await project([numbered(100_000)], { cols: 80, maxLines: 100_000 });
  assert.equal(r.truncated, false);
  assert.equal(r.omittedInputBytes, 0);
  const lines = r.text.split('\n');
  assert.equal(lines.length, 100_000);
  assert.ok(lines.every((l, i) => l === `L${i}`));
  // Exactly at the limit is not truncation either.
  const exact = await project([numbered(500)], { cols: 80, maxLines: 500 });
  assert.equal(exact.truncated, false);
  const over = await project([numbered(501)], { cols: 80, maxLines: 500 });
  assert.equal(over.truncated, true);
  assert.equal(over.text.split('\n')[0], 'L1');
});

test('G11: output that outruns the scratch emulator\'s row bound (REP) is still reported as truncated', async () => {
  // CSI 99999 b repeats the last character 99 999 times: 5000 rows from 9 bytes.
  const r = await project(['start\r\nx\x1b[99999b\r\nend\r\n'], { cols: 20 });
  assert.equal(r.truncated, true);
  assert.ok(!r.text.startsWith('start'));
  assert.ok(r.text.endsWith('x\nend'));
  const small = await project(['start\r\nx\x1b[999b\r\nend\r\n'], { cols: 20 });
  assert.deepEqual(small, { text: `start\n${'x'.repeat(1000)}\nend`, truncated: false, omittedInputBytes: 0 });
});

test('api-20: maxInputBytes keeps the tail or head, never splits a character, and says what it omitted', async () => {
  const accents = 'é'.repeat(3000); // 2 bytes each
  const tail = await project([accents], { cols: 80, maxInputBytes: 1025 });
  assert.equal(tail.truncated, true);
  assert.ok(!tail.text.includes('�'));
  assert.equal(tail.text.replace(/\n/g, ''), 'é'.repeat(512));
  assert.equal(tail.omittedInputBytes, 6000 - 1024);
  const emoji = '🙂'.repeat(500); // 4 bytes each, surrogate pairs in UTF-16
  const head = await project([emoji], { cols: 80, maxInputBytes: 1023, keep: 'head' });
  assert.equal(head.text.replace(/\n/g, ''), '🙂'.repeat(255));
  assert.equal(head.omittedInputBytes, 2000 - 1020);
  // A line boundary within reach is preferred, so the kept text starts with a whole line.
  const logs = Array.from({ length: 200 }, (_, i) => `log line ${i} ${'.'.repeat(20)}`).join('\r\n') + '\r\n';
  const cut = await project([logs], { cols: 80, maxInputBytes: 1000 });
  assert.match(cut.text.split('\n')[0]!, /^log line \d+ \.{20}$/);
  assert.equal(cut.text.split('\n').at(-1), `log line 199 ${'.'.repeat(20)}`);
  // Under the cap nothing is omitted.
  const small = await project(['short\r\n'], { cols: 80, maxInputBytes: 100 });
  assert.deepEqual(small, { text: 'short', truncated: false, omittedInputBytes: 0 });
});

// ───────────── floods (emu-3, tg-4) ─────────────

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number; heapRise: number }> {
  const start = process.memoryUsage().heapUsed;
  let peak = start;
  const iv = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 2);
  const t0 = Date.now();
  try {
    const value = await fn();
    return { value, ms: Date.now() - t0, heapRise: Math.max(peak, process.memoryUsage().heapUsed) - start };
  } finally {
    clearInterval(iv);
  }
}

function* chunksOf(s: string, n: number): Generator<string> {
  for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n);
}

test('emu-3 / tg-4: 20 MB in 5000 chunks projects in bounded time; the tail is exact and truncated is true', async () => {
  let i = 0;
  const lines: string[] = [];
  while (lines.length * 80 < 20 * MB) lines.push(`line ${String(i++).padStart(8, '0')} ${'x'.repeat(66)}`);
  const body = `${lines.join('\r\n')}\r\nEND\r\n`;
  const chunks = [...chunksOf(body, Math.ceil(body.length / 5000))];
  const { value: r, ms, heapRise } = await timed(() => project(chunks, { cols: 120, rows: 30 }));
  assert.ok(ms < 5000, `20 MB took ${ms} ms`);
  assert.ok(heapRise < 300 * MB, `heap rose ${Math.round(heapRise / MB)} MB`);
  assert.equal(r.truncated, true);
  const out = r.text.split('\n');
  assert.equal(out.length, 50_000);
  assert.equal(out.at(-1), 'END');
  assert.equal(out.at(-2), lines.at(-1));
  assert.equal(out[0], lines[lines.length - 49_999]);
});

test('tg-4: 20 MB under maxLines keeps every line, in bounded time and memory', async () => {
  // 20 MB in 250 000 lines of 83 bytes (20 000 chunks), projected at a width that holds each line.
  const lines = Array.from({ length: 250_000 }, (_, i) => `row ${String(i).padStart(7, '0')} ${'y'.repeat(70)}`);
  const body = `${lines.join('\r\n')}\r\n`;
  const { value: r, ms, heapRise } = await timed(() => project(chunksOf(body, 1024), { cols: 120, maxLines: 300_000 }));
  assert.ok(ms < 8000, `took ${ms} ms`);
  assert.ok(heapRise < 400 * MB, `heap rose ${Math.round(heapRise / MB)} MB`);
  assert.equal(r.truncated, false);
  const out = r.text.split('\n');
  assert.equal(out.length, lines.length);
  assert.ok(out.every((l, k) => l === lines[k]), 'no line dropped or altered');
});

test('tg-4: a 20 MB single line and a 18 MB full-screen redraw flood both project in bounded time', async () => {
  const long = await timed(() => project([`${'z'.repeat(20 * MB)}\r\n`], { cols: 120 }));
  assert.ok(long.ms < 5000, `long line took ${long.ms} ms`);
  assert.equal(long.value.text.length, 20 * MB);
  assert.equal(long.value.truncated, false);
  let tui = '$ top\r\n\x1b[?1049h';
  for (let f = 0; f < 40_000; f++) tui += `\x1b[H\x1b[2J\x1b[1;1Hframe ${f}\x1b[10;5H${'status '.repeat(60)}\x1b[20;1H${f}`;
  tui += '\x1b[?1049l$ ';
  const redraw = await timed(() => project(chunksOf(tui, 4096), { cols: 120, rows: 30 }));
  assert.ok(redraw.ms < 8000, `redraw flood took ${redraw.ms} ms`);
  const out = redraw.value.text.split('\n');
  assert.equal(out[0], '$ top');
  assert.equal(out[1], 'frame 39999');
  assert.equal(out.at(-1), '$');
});

test('Cost: with maxInputBytes, memory follows the budget, not the range (chunks are cut as they are gathered)', async () => {
  // 128 MiB of lines, made as they are read, under a 1 KiB budget.
  function* big(): Generator<string> {
    for (let i = 0; i < 2048; i++) yield `${'x'.repeat(64 * 1024 - 1)}\n`;
  }
  const { value: r, heapRise } = await timed(() => project(big(), { cols: 80, maxInputBytes: 1024 }));
  assert.ok(heapRise < 48 * MB, `heap rose ${Math.round(heapRise / MB)} MB for 128 MiB of input`);
  assert.equal(r.truncated, true);
  assert.ok(r.omittedInputBytes >= 2048 * 64 * 1024 - 1024);
  assert.match(r.text, /^x+$/);
  // The omitted head's lasting state still applies, and the exact cut is unchanged: a line boundary is preferred.
  const logs = Array.from({ length: 200 }, (_, i) => `log line ${i} ${'.'.repeat(20)}\r\n`);
  const cut = await project(['\x1b[2;5r', ...logs], { cols: 80, rows: 10, maxInputBytes: 1000 });
  assert.match(cut.text.split('\n')[0]!, /^log line \d+ \.{20}$/);
  assert.equal(cut.text.split('\n').length, 4, 'the region from the omitted head holds: the first kept line above it, the last three in it');
  assert.equal(cut.text.split('\n').at(-1), `log line 199 ${'.'.repeat(20)}`);
  // Kept head: a single source past the budget keeps its start, and later chunks cost nothing.
  function* head(): Generator<string> {
    yield 'first line\r\n';
    for (let i = 0; i < 512; i++) yield `${'y'.repeat(64 * 1024 - 1)}\n`;
  }
  const h = await timed(() => project(head(), { cols: 80, maxInputBytes: 1024, keep: 'head' }));
  assert.ok(h.heapRise < 48 * MB, `heap rose ${Math.round(h.heapRise / MB)} MB`);
  assert.equal(h.value.text.split('\n')[0], 'first line');
  assert.equal(h.value.truncated, true);
});

test('emu-3: many tiny chunks cost parser time, not a timer each', async () => {
  const chunks = Array.from({ length: 20_000 }, (_, i) => `${i}\r\n`);
  const { value: r, ms } = await timed(() => project(chunks, { cols: 80, maxLines: 20_000 }));
  assert.ok(ms < 2000, `20 000 chunks took ${ms} ms`);
  assert.equal(r.text.split('\n').length, 20_000);
  assert.equal(r.truncated, false);
});

test('transcript() is project().text with the old defaults', async () => {
  assert.equal(await transcript([{ data: 'a\nb\n', stream: 'stdout' }]), 'a\nb');
  assert.equal(await transcript([numbered(10)], { maxLines: 3 }), 'L7\nL8\nL9');
});
