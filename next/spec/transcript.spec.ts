/**
 * The transcript projection (§6, G10, G11): the semantics stated in
 * src/core/transcript.ts, rule by rule, and floods (tg-4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { persistentState } from '../src/core/screen.js';
import { project, runChunks, transcript } from '../src/core/transcript.js';
import type { ProjectChunk } from '../src/core/transcript.js';
import { lineEnds, stripEscapes, unfinishedSequence } from '../src/core/text.js';
import { journalRunText } from '../src/core/segmenter.js';
import { scriptedSession } from './fake-shell.js';
import type { JournalEvent, RunInfo } from '../src/core/types.js';
import xterm from '@xterm/headless';

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

test('a kept-tail cut past the start of a control string still unfinished drops the rest of it as it comes: split across chunks, it reads as in one chunk', async () => {
  // The house's read of the 33 commits (#22, comment 6307351104), item 7: `head `, then an OSC 52 longer than twice a 4 KiB
  // budget, then its end in a later chunk, showed `QUJDQUJDtail-of-payload after`; in one chunk only ` after`.
  const pay = 'QUJD'.repeat(2600);
  const read = async (chunks: string[]) => (await project(chunks, { cols: 80, rows: 24, maxInputBytes: 4096 })).text;
  assert.equal(await read([`head \x1b]52;c;${pay}tail-of-payload\x07 after`]), ' after', 'one chunk');
  assert.equal(await read(['head ', `\x1b]52;c;${pay}`, 'tail-of-payload\x07 after']), ' after');
  assert.equal(await read(['head ', '\x1b]52;c;', ...Array.from({ length: 26 }, () => 'QUJD'.repeat(100)), 'tail-of-payload\x07 after']), ' after', 'the payload in pieces');
  assert.equal(await read(['head ', `\x1b]52;c;${pay}\x1b`, '\\ after']), ' after', 'the string terminator split between chunks');
  assert.equal(await read(['head ', `\x1b]52;c;${pay}`, 'tail\x1b[31mred\x1b[m after']), 'red after', 'a new sequence abandons the string');
  assert.equal(await read(['head ', `\x1bPq${pay}`, '#0~~\x1b\\ after']), ' after', 'a DCS');
  // A payload holding newlines (base64 in lines) is cut as an emitted run, and its rest goes the same way.
  const lines = `${'QUJD'.repeat(19)}\n`.repeat(150);
  assert.equal(await read(['head\r\n', `\x1b]52;c;${lines}`, `${lines}\x07 after`]), ' after', 'newlines inside the payload');
  assert.equal(await read([`out\r\n\x1b]52;c;${lines}${lines}\x07 after`]), ' after', 'the same in one chunk');
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
  // The cut never lands inside a control sequence: no half of one shows as text (the house's read of
  // 78c4d6e, #22: a cut inside ESC [ 31 m showed `31mHello`, one inside an OSC 8 link the link's tail).
  const red = await project([`${'A'.repeat(1000)}\x1b[31mHello\r\n`], { cols: 80, maxInputBytes: 8 });
  assert.equal(red.text, 'Hello');
  const link = await project([`${'x'.repeat(200)}\x1b]8;;https://example.com/a/very/long/link\x1b\\link\x1b]8;;\x1b\\ tail\r\n`], { cols: 80, maxInputBytes: 40 });
  assert.equal(link.text, 'link tail');
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

test('a note after output that ends inside a control sequence is a line of its own, and nothing after it is swallowed (the house\'s read of ed4ecac)', async () => {
  // The sequence's end was lost with the events the note stands for: the marker, and every line after it, must show.
  for (const open of ['\x1b]0;my tit', '\x1b[', '\x1bPq12', '\x1b_x', '\x1b']) {
    const after = Array.from({ length: 40 }, (_, i) => `after ${i}\r\n`).join('');
    const p = await project([{ data: `line 1\r\nprompt ${open}` }, { note: '[… 1 journal event missing (seq 3–3: a torn write) …]' }, { data: after }], { cols: 80, rows: 24, keep: 'head' });
    const lines = p.text.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['line 1', 'prompt', '[… 1 journal event missing (seq 3–3: a torn write) …]', 'after 0'], JSON.stringify(open));
    assert.equal(lines.length, 43, JSON.stringify(open));
    assert.equal(p.truncated, false);
  }
  // A header line (a change of source) is never part of a source either.
  const labelled = await project([{ data: 'shell \x1b]0;t', stream: 'pty' }, { data: 'proc line\n', stream: 'stdout', runId: 'r1' }], { cols: 80, rows: 24, label: (s) => (s.stream === 'pty' ? '[terminal]' : `[run ${s.runId}]`) });
  assert.deepEqual(labelled.text.split('\n'), ['[run r1]', 'proc line', '[terminal]', 'shell']);
});

test('transcript() is project().text with the old defaults', async () => {
  assert.equal(await transcript([{ data: 'a\nb\n', stream: 'stdout' }]), 'a\nb');
  assert.equal(await transcript([numbered(10)], { maxLines: 3 }), 'L7\nL8\nL9');
});

// ───────────── an independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650) ─────────────

const sourceLabel = (s: { stream: string; runId?: string }) => (s.stream === 'pty' ? '[terminal]' : `[run ${s.runId}]`);

test('the interleave cuts a source only at a line end: a LF inside a window title, with another source after it, splits nothing', async () => {
  // The pty's event was emitted through its last LF, inside the title; the Run's header then went out inside
  // the title, which a CAN ended, and the title's rest (`y`) showed as text, its line split in two.
  const p = await project([{ data: 'a\r\nT\x1b]0;x\r\n', stream: 'pty' }, { data: 'run line\n', stream: 'stdout', runId: 'r1' }, { data: 'y\x07rest\r\n', stream: 'pty' }], { cols: 80, rows: 24, label: sourceLabel });
  assert.equal(p.text, '[terminal]\na\n[run r1]\nrun line\n[terminal]\nTrest');
});

test('maxLines counts lines of output: the headers naming sources come extra, with the one naming the first line’s source', async () => {
  const chunks: ProjectChunk[] = [{ data: 'p1\r\np2\r\n', stream: 'pty' }, { data: 'r1\nr2\n', stream: 'stdout', runId: 'r1' }, { data: 'p3\r\n', stream: 'pty' }];
  assert.equal((await project(chunks, { cols: 80, rows: 24, label: sourceLabel, maxLines: 3 })).text, '[run r1]\nr1\nr2\n[terminal]\np3');
  assert.equal((await project(chunks, { cols: 80, rows: 24, label: sourceLabel, maxLines: 3, keep: 'head' })).text, '[terminal]\np1\np2\n[run r1]\nr1');
});

test('a tail names its first line’s source wherever the cut falls: past the source’s first line, or inside its data under a byte budget', async () => {
  // The header was kept only when it sat just before the cut: a tail of 3 over r1's three lines then the pty's read
  // `a2 a3 [terminal] p2`, and a budget whose cut fell inside r1's data dropped the header before the projection.
  const three: ProjectChunk[] = [{ data: 'p1\r\n', stream: 'pty' }, { data: 'a1\na2\na3\n', stream: 'stdout', runId: 'r1' }, { data: 'p2\r\n', stream: 'pty' }];
  assert.deepEqual((await project(three, { cols: 80, rows: 24, label: sourceLabel, maxLines: 3 })).text.split('\n'), ['[run r1]', 'a2', 'a3', '[terminal]', 'p2']);
  assert.deepEqual((await project(three, { cols: 80, rows: 24, label: sourceLabel, maxLines: 2 })).text.split('\n'), ['[run r1]', 'a3', '[terminal]', 'p2']);
  const long: ProjectChunk[] = [{ data: 'p1\r\n', stream: 'pty' }, { data: 'a1-long-long-long\na2-long-long-long\na3\n', stream: 'stdout', runId: 'r1' }, { data: 'p2\r\n', stream: 'pty' }];
  const cut = await project(long, { cols: 80, rows: 24, label: sourceLabel, maxLines: 10, maxInputBytes: 40 });
  assert.deepEqual(cut.text.split('\n'), ['[run r1]', 'a2-long-long-long', 'a3', '[terminal]', 'p2']);
  assert.equal(cut.omittedInputBytes, 'p1\r\na1-long-long-long\n'.length, 'the restored header is no input omitted, nor the dropped one');
  // A restored header is a header to the line count too: a tail of 2 counted it as a line of output and cut it
  // again (our read of the house's fixes for its review of f3750e4, PR #22).
  const two = await project(long, { cols: 80, rows: 24, label: sourceLabel, maxLines: 2, maxInputBytes: 40 });
  assert.deepEqual(two.text.split('\n'), ['[run r1]', 'a3', '[terminal]', 'p2']);
});

test('a byte budget whose cut falls inside a header keeps the header whole, and counts none of it as input omitted', async () => {
  // A reviewer's read of the fixes for #22: the restore put back a header the cut dropped whole, and a cut inside the
  // header kept its tail as the first line, `]` or `n r1]`. A header the cut dropped for good counted as input omitted:
  // a 6-byte budget reported 19 bytes, the pty's 8 and its `[terminal]` header's 11 (the house's review of
  // 4f4c067..a8b6f28, #22, comment 6323055715).
  const chunks: ProjectChunk[] = [{ data: 'p1\r\np2\r\n', stream: 'pty' }, { data: 'a1\na2\n', stream: 'stdout', runId: 'r1' }];
  const input = 'p1\r\np2\r\n'.length + 'a1\na2\n'.length;
  for (const max of [6, 8, 10, 12, 14]) {
    const p = await project(chunks, { cols: 80, rows: 24, label: sourceLabel, maxLines: 10, maxInputBytes: max });
    assert.deepEqual(p.text.split('\n'), ['[run r1]', 'a1', 'a2'], `a budget of ${max}`);
    assert.equal(p.omittedInputBytes, input - 'a1\na2\n'.length, `a budget of ${max}: the pty's lines, not their header`);
  }
  // Every budget: what is omitted is input, never more than all of it.
  for (let max = 0; max <= 30; max++) {
    const p = await project(chunks, { cols: 80, rows: 24, label: sourceLabel, maxLines: 10, maxInputBytes: max });
    assert.ok(p.omittedInputBytes <= input, `a budget of ${max}: ${p.omittedInputBytes} omitted of ${input}`);
  }
  // The head kept: a header past the cut is no input omitted either.
  const head = await project(chunks, { cols: 80, rows: 24, label: sourceLabel, maxLines: 10, maxInputBytes: 20, keep: 'head' });
  assert.deepEqual([head.text.split('\n'), head.omittedInputBytes], [['[terminal]', 'p1', 'p2'], 'a1\na2\n'.length]);
});

test('no cut counts a header as input omitted: a head kept to maxLines, and a tail past an unfinished line twice the budget', async () => {
  // A reviewer's read of the fixes for #22: b0fd9f2 left headers out of what each cut counts as input omitted, but two of its
  // four places failed no test with the exclusion undone: the head's rest past maxLines, and the emitted lines dropped before a
  // held line past twice the budget. Headers exist only with a label, so labelled or not, the same input is omitted.
  const omitted = async (chunks: ProjectChunk[], opts: Parameters<typeof project>[1]) => {
    const plain = await project(chunks, opts);
    const labelled = await project(chunks, { ...opts, label: sourceLabel });
    assert.ok(plain.omittedInputBytes > 0, JSON.stringify(plain));
    return [labelled.omittedInputBytes, plain.omittedInputBytes];
  };
  const lines = (p: string, n: number, end: string) => Array.from({ length: n }, (_, i) => `${p}${i + 1}${end}`).join('');
  const sources: ProjectChunk[] = [{ data: lines('p', 6, '\r\n'), stream: 'pty' }, { data: lines('a', 6, '\n'), stream: 'stdout', runId: 'r1' }, { data: lines('q', 3, '\r\n'), stream: 'pty' }];
  const [headL, headP] = await omitted(sources, { cols: 80, rows: 3, maxLines: 2, keep: 'head' });
  assert.equal(headL, headP, 'the rest past maxLines: no header counted');
  const long: ProjectChunk[] = [{ data: 'p1\r\n', stream: 'pty' }, { data: 'x'.repeat(300), stream: 'stdout', runId: 'r1' }];
  const [tailL, tailP] = await omitted(long, { cols: 80, rows: 24, maxLines: 10, maxInputBytes: 100 });
  assert.equal(tailL, tailP, 'what goes before a held line past twice the budget: no header counted');
});

test('a held line cut for the byte budget drops what was emitted before it: a title’s payload after a whole line keeps only the tail', async () => {
  // `head\r\n`, then an OSC 52 of 10 KB in a later chunk with no line end, under a 4 KiB budget: `head` survived
  // the payload between it and the end.
  const pay = 'QUJD'.repeat(2600);
  const read = async (chunks: string[]) => (await project(chunks, { cols: 80, rows: 24, maxInputBytes: 4096 })).text;
  assert.equal(await read(['head\r\n', `\x1b]52;c;${pay}`, 'tail-of-payload\x07 after']), ' after');
  assert.equal(await read([`head\r\n\x1b]52;c;${pay}tail-of-payload\x07 after`]), ' after', 'as in one chunk');
});

test('no source’s output is taken by another’s unfinished string: a title holding a LF, an OSC 52 over reads, and held ends at the range’s end', async () => {
  // The interleave cut a source at its last LF inside a title, and the string left open took the next source's
  // bytes as its payload: the Run's line was lost, labelled or not. Held ends flushed at the range's end with no
  // line end at all lost the Run's text too. Each case, with and without headers.
  const pty = (data: string): ProjectChunk => ({ data, stream: 'pty' });
  const run = (data: string): ProjectChunk => ({ data, stream: 'stdout', runId: 'r2' });
  for (const label of [undefined, sourceLabel]) {
    const read = async (chunks: ProjectChunk[]) => (await project(chunks, { cols: 80, rows: 10, ...(label ? { label } : {}) })).text.split('\n').filter((l) => !/^\[(terminal|run r2)\]$/.test(l));
    const named = label ? 'labelled' : 'plain';
    assert.deepEqual(await read([pty('hello\r\n\x1b]0;my\ntitle\x07world'), run('proc line\n'), pty('\r\n')]), ['hello', 'proc line', 'world'], named);
    assert.deepEqual(await read([pty('copy:\x1b]52;c;QUJD\nREVG\n'), run('build ok\n'), pty('SElK\x07 done\r\n')]), ['build ok', 'copy: done'], named);
    assert.deepEqual(await read([pty('p1\r\n\x1b]0;tit'), run('RUN-UNFIN')]), ['p1', 'RUN-UNFIN'], named);
  }
});

test('a tail cut’s open sequence stops dropping a source’s output at a hole: the note ends it', async () => {
  // `head `, a 12 KB OSC 52 a 4 KiB tail budget cut into, a note, then two lines: only the note showed, the
  // lines after the hole dropped as the string's rest.
  const pay = 'QUJD'.repeat(3000);
  const chunks: ProjectChunk[] = [{ data: `head \x1b]52;c;${pay}`, stream: 'pty' }, { note: '[a hole]' }, { data: 'after the gap\r\nnext line', stream: 'pty' }];
  assert.equal((await project(chunks, { cols: 80, rows: 10, maxInputBytes: 4096 })).text, '[a hole]\nafter the gap\nnext line');
  assert.equal((await project(chunks, { cols: 80, rows: 10 })).text, 'head\n[a hole]\nafter the gap\nnext line', 'without a budget');
});

test('a tail cut’s open string ended by a new sequence that begins with an ESC held back from the chunk before applies that sequence, not shows it', async () => {
  // The ESC at a chunk's end may be the first half of the string's ST, so the line-end carry holds it back; when the next
  // chunk shows it began a CSI instead, the string is over and the CSI applies. That branch of the cut's skip ran in no spec.
  const pay = 'QUJD'.repeat(3000);
  const chunks: ProjectChunk[] = [{ data: `head \x1b]52;c;${pay}\x1b`, stream: 'pty' }, { data: '[31mred\x1b[0m\r\nnext\r\n', stream: 'pty' }];
  assert.equal((await project(chunks, { cols: 80, rows: 10, maxInputBytes: 4096 })).text, 'red\nnext');
  assert.equal((await project(chunks, { cols: 80, rows: 10 })).text, 'head red\nnext', 'without the budget');
});

test('the line-end rule reads strings as the emulator does: CAN and SUB end one, and the C1 introducers open one', async () => {
  // text.ts read `ESC ] 0 ; my CAN` as still open, so the LF after it was no line end and the rest payload; and
  // knew no C1 string introducer, so the LF inside a U+009D OSC ended a line.
  for (const [data, text, ends, stripped] of [
    ['a\x1b]0;my\x18\nb\r\n', 'a\n b', [8, 11], 'a\nb\n'],
    ['a\x1b]0;my\x1a\nb\r\n', 'a\n b', [8, 11], 'a\nb\n'],
    ['a\u009d0;my\ntitle\u0007b\r\n', 'ab', [15], 'ab\n'],
    ['a\u0090q;x\ny\u009cb\r\n', 'ab', [10], 'ab\n'],
  ] as const) {
    assert.equal((await project([{ data, stream: 'pty' }], { cols: 80, rows: 10 })).text, text, JSON.stringify(data));
    assert.deepEqual(lineEnds(data), [...ends], JSON.stringify(data));
    assert.equal(stripEscapes(data).text, stripped, JSON.stringify(data));
  }
  assert.equal(unfinishedSequence('a\x1b]0;my\x18'), 'a\x1b]0;my\x18'.length, 'CAN ended it');
  assert.equal(unfinishedSequence('a\u009d0;my'), 1, 'a C1 OSC open at the end');
});

test('a string ends where the emulator ends it: BEL ends an OSC only, any C1 control ends a string, and an SOS, PM or APC ends at a code point from U+00A0', async () => {
  // text.ts ended every string at BEL, read on past a C1 control, and read an SOS, PM or APC on past U+00E9: the emulator
  // shows `A ESC _ pay BEL B` as `A` and its payload was text, hid `B` after `A ESC ] 0 ; ti U+009B 31m`, and showed the
  // text after an APC's `é`. What the grammar keeps as text is what the emulator shows, for every string kind, both
  // introducer forms, and each ender (a C1 control that moves the cursor, U+0084 and U+0085, moves it, so it stays out).
  const shown = async (data: string) => {
    const t = new xterm.Terminal({ cols: 40, rows: 4, allowProposedApi: true, logLevel: 'off' });
    await new Promise<void>((r) => t.write(data, r));
    const rows: string[] = [];
    for (let y = 0; y < 4; y++) rows.push(t.buffer.active.getLine(y)!.translateToString(true));
    t.dispose();
    return rows.join('');
  };
  const kinds = ['\x1b]0;', '\x1bPq', '\x1bX', '\x1b^', '\x1b_', '\u009d0;', '\u0090q', '\u0098', '\u009e', '\u009f'];
  const enders = ['\x07', '\u009c', '\u009b31m', '\u0080', '\u0099', '\u009d0;', '\u00e9', '\u00a0', '\u{1f600}', '\x18'];
  for (const intro of kinds)
    for (const ender of enders) {
      const data = `A${intro}pay${ender}B\x1b\\C`;
      assert.equal(stripEscapes(data).text, await shown(data), JSON.stringify(data));
    }
  // The line-end rule skips what the emulator holds as payload, and only that.
  assert.deepEqual(lineEnds('A\x1b_pay\x07B\r\nC\x1b\\D\r\n'), [15], 'a BEL inside an APC: its LF is payload');
  assert.deepEqual(lineEnds('A\x1b]0;ti\u009b31mB\r\nC\r\n'), [13, 16], 'U+009B ended the title: its LF ends a line');
  assert.deepEqual(lineEnds('A\x1bXpay\u00e9B\r\nC\r\n'), [9, 12], 'U+00E9 ended the SOS');
  assert.deepEqual(lineEnds('A\x1b]0;t\u00e9t\r\nB\x07\r\n'), [13], 'an OSC holds U+00E9 as payload');
});

test('a LF a CSI executes is a line end the interleave may cut at: the source’s next output reads the CSI on, so its rest is no text (the house’s review of the 40 commits through f3750e4, #22, comment 6310921374)', async () => {
  // `A ESC [ 3 LF`, a Run's `r1`, then `1mB`: the CAN at the source switch ended the CSI, and `1mB` read as text where
  // alone it reads ` B`. A bare LF leaves the cursor short of column 0, so the switch leaves a blank line, as for any.
  const run = (data: string): ProjectChunk => ({ data, stream: 'stdout', runId: 'r1' });
  assert.deepEqual((await project(['A\x1b[3\n', run('r1\n'), '1mB'], { cols: 40 })).text.split('\n'), ['A', '', 'r1', 'B']);
  assert.deepEqual((await project(['A\x1b[3\r\n', run('r1\n'), '1mB'], { cols: 40 })).text.split('\n'), ['A', 'r1', 'B']);
  assert.deepEqual((await project(['A\x1b[3\r\n', run('r1\n'), 'CB'], { cols: 40, label: sourceLabel })).text.split('\n'), ['[terminal]', 'A', '[run r1]', 'r1', '[terminal]', '   B']);
  // Every byte budget and both ends: no cut leaves the CSI's rest as text, and what is kept is the whole's own start or end,
  // so a budget that lost a line, or `B`, fails too (our review of the 40 commits through 4f4c067, PR #22: absence alone
  // was checked).
  const chunks: ProjectChunk[] = ['A\x1b[3\r\n', run('r1\n'), '1mB\r\n', run('r2\n'), 'p3\r\n'];
  const whole = (await project(chunks, { cols: 40 })).text;
  assert.equal(whole, 'A\nr1\nB\nr2\np3');
  for (let max = 0; max <= 40; max++) {
    for (const keep of ['head', 'tail'] as const) {
      const p = await project(chunks, { cols: 40, maxInputBytes: max, keep });
      assert.ok(!/1m|\[3/.test(p.text), `budget ${max}, ${keep}: ${JSON.stringify(p.text)}`);
      assert.ok(keep === 'head' ? whole.startsWith(p.text) : whole.endsWith(p.text), `budget ${max}, ${keep}: ${JSON.stringify(p.text)} is the whole's ${keep}`);
      if (max >= 21) assert.equal(p.text, whole, `budget ${max}, ${keep}: everything fits`);
    }
  }
  for (let maxLines = 1; maxLines <= 5; maxLines++) {
    const { text } = await project(chunks, { cols: 40, maxLines });
    assert.ok(!/1m/.test(text), `maxLines ${maxLines}`);
    assert.equal(text, whole.split('\n').slice(-maxLines).join('\n'), `maxLines ${maxLines}: the last lines`);
  }
});

test('a tail cut inside the rest of a CSI a LF split keeps what the CSI set (our review of the 40 commits through 4f4c067, PR #22)', async () => {
  // `ESC [ CR LF`, a Run's line, then `4hXY CR Z`: insert mode is set, so the terminal shows `ZXY`. A tail of 6 or 7
  // bytes was cut on the second part's data without the CSI's head: what it dropped set nothing, and the kept part began
  // with the head before a later part of the CSI, so `ZY` showed.
  const run = (data: string): ProjectChunk => ({ data, stream: 'stdout', runId: 'r1' });
  const chunks: ProjectChunk[] = ['A\x1b[\r\n', run('r1\n'), '4hXY\rZ\r\n'];
  for (let max = 6; max <= 14; max++) {
    const { text } = await project(chunks, { cols: 40, maxInputBytes: max, keep: 'tail' });
    assert.equal(text.split('\n').at(-1), 'ZXY', `budget ${max}: ${JSON.stringify(text)}`);
  }
  // A line past twice the budget is cut as it is read, by the same rule: its last 8 bytes, `....XY CR Z`, in insert mode
  // show `Z....XY`, where `Z` written over the first dot would show `Z...XY`.
  const long: ProjectChunk[] = ['A\x1b[\r\n', run('r1\n'), `4h${'.'.repeat(60)}XY\rZ`];
  assert.equal((await project(long, { cols: 80, maxInputBytes: 8, keep: 'tail' })).text.split('\n').at(-1), 'Z....XY');
});

test('a tail cut past an unfinished CSI keeps what the CSI sets when its rest comes later (our review of the 84 commits through a8b6f28, PR #22)', async () => {
  // A held line past twice the budget, ending in an open CSI: the cut moves past the CSI's start, and its rest `4h` comes
  // in the next chunk. It was dropped without the head the cut took, so insert mode was lost and `XY CR Z` showed `ZY`.
  const csi = `\x1b[${'0;'.repeat(12)}`;
  for (const max of [6, 8, 10, 12, 16]) {
    const split = await project([`${'A'.repeat(40)}${csi}`, '4hXY\rZ\r\n'], { cols: 80, maxInputBytes: max, keep: 'tail' });
    const whole = await project([`${'A'.repeat(40)}${csi}4hXY\rZ\r\n`], { cols: 80, maxInputBytes: max, keep: 'tail' });
    assert.equal(split.text.split('\n').at(-1), 'ZXY', `budget ${max}: ${JSON.stringify(split.text)}`);
    assert.equal(split.text.split('\n').at(-1), whole.text.split('\n').at(-1), `budget ${max}: as in one chunk`);
  }
});

test('a hole starts the projection afresh: no line, and no string, open before it takes what follows', async () => {
  // The Run renderers projected a Run's output without its gaps, so a title open before a hole took the lines after it.
  assert.deepEqual((await project(['ready \x1b]0;my title', { hole: true }, 'ERROR: boom\r\n'], { cols: 40 })).text.split('\n'), ['ready', 'ERROR: boom']);
  assert.deepEqual((await project(['abc', { hole: true }, 'def\r\n'], { cols: 40 })).text.split('\n'), ['abc', 'def']);
  assert.deepEqual((await project(['A\x1b[3\r\n', { hole: true }, 'CB\r\n'], { cols: 40 })).text.split('\n'), ['A', 'CB'], 'a CSI open before it is not read on');
  assert.equal((await project(['one\r\n', { hole: true }, 'two\r\n'], { cols: 40 })).text, 'one\ntwo', 'a line already ended: no blank line');
  assert.equal((await project([{ data: 'x', stream: 'stdout', runId: 'p' }, { hole: true }, { data: 'y\n', stream: 'stdout', runId: 'p' }], { cols: 40, label: sourceLabel })).text, '[run p]\nx\n[run p]\ny');
});

test('runChunks puts a hole between two of a Run’s events wherever a gap says output was lost, and through a cutter that reads the text whole', async () => {
  const ev = (seq: number, data: string) => ({ seq, data, stream: 'pty' as const });
  const events = [ev(2, 'ready \x1b]0;tit'), ev(3, 'le-ish'), ev(9, 'ERROR\r\n'), ev(12, 'tail\r\n')];
  const gaps = [{ from: 4, to: 8 }, { from: 20, to: 30 }];
  assert.deepEqual(runChunks(events, gaps), [{ data: 'ready \x1b]0;tit', stream: 'pty' }, { data: 'le-ish', stream: 'pty' }, { hole: true }, { data: 'ERROR\r\n', stream: 'pty' }, { data: 'tail\r\n', stream: 'pty' }]);
  // A gap seated after its hole (a store failure's, written when the disk takes writes again) still places it by its range.
  assert.deepEqual(runChunks([ev(2, 'a'), ev(9, 'b')], [{ from: 3, to: 5 }]), [{ data: 'a', stream: 'pty' }, { hole: true }, { data: 'b', stream: 'pty' }]);
  // Through a cutter: it sees one text, and the hole comes back where it was, whatever the cutter keeps around it.
  const seen: string[] = [];
  const cut = (raw: string) => (seen.push(raw), raw.replace(/^ECHO\r\n/, ''));
  const chunks = runChunks([ev(2, 'ECHO\r\nready \x1b]0;tit'), ev(9, 'ERROR\r\n')], [{ from: 3, to: 8 }], cut);
  assert.equal(seen.length, 1, 'the cutter reads the text once');
  assert.deepEqual(chunks, [{ data: 'ready \x1b]0;tit', stream: 'pty' }, { hole: true }, { data: 'ERROR\r\n', stream: 'pty' }]);
  assert.deepEqual((await project(chunks, { cols: 40 })).text.split('\n'), ['ready', 'ERROR']);
  // The mark is one the output does not hold.
  const own = runChunks([ev(2, 'x\x18﷐y'), ev(9, 'z')], [{ from: 3, to: 8 }], (raw) => raw);
  assert.deepEqual(own, [{ data: 'x\x18﷐y', stream: 'pty' }, { hole: true }, { data: 'z', stream: 'pty' }]);
});

test('a CSI holding many line feeds is taken whole by a batch: the projection reads as the emulator does, its rest no text', async () => {
  // A batch was cut at a LF inside the CSI, which the ED 3 between batches then ended: its final `m` showed.
  const inside = `${'l\r\n'.repeat(3000)}\x1b[${'\r\n'.repeat(2000)}mend\r\n`;
  const before = `${'l\r\n'.repeat(3000)}${'\r\n'.repeat(2000)}\x1b[mend\r\n`;
  const a = await project([inside], { cols: 80 });
  assert.equal(a.text, (await project([before], { cols: 80 })).text);
  assert.equal(a.truncated, false);
  assert.ok(a.text.endsWith('\nend'));
});

test('a Run of history renders its gaps as holes: a string or a line open before one takes nothing after it, its plumbing cut as before', async () => {
  const out = (seq: number, data: string): JournalEvent => ({ seq, ts: 0, type: 'output', stream: 'pty', runId: 'r', data });
  const gap: JournalEvent = { seq: 12, ts: 0, type: 'gap', from: 3, to: 8, reason: 'store-error' };
  const run = { runId: 'r', sessionId: 's', target: 'shell', origin: 'self', principal: 'agent:a@t', state: 'exited', admittedAt: 0, seq: { admit: 1, start: 1, end: 11 }, attribution: 'temporal', strategy: 'marker', nonce: 'n0nce' } as RunInfo;
  const events = [out(2, 'the typed line\r\n<<<START:n0nce:42>>>\r\nready \x1b]0;tit'), out(9, 'ERROR: boom\r\n'), out(10, 'abc'), out(11, 'def\r\n<<<EXIT:n0nce:0>>>\r\n')];
  const o = { events, from: 1, to: 11, truncated: true, gaps: [gap as Extract<JournalEvent, { type: 'gap' }>] };
  assert.deepEqual((await journalRunText(o, { cols: 40 }, run)).text.split('\n'), ['ready', 'ERROR: boom', 'abcdef'], 'the plumbing cut by the nonce; the title ended at the hole');
  const proc = { ...run, target: 'process' } as RunInfo;
  const pipes = { ...o, events: [out(2, 'ready \x1b]0;tit'), out(9, 'ERROR: boom\n'), out(10, 'abc'), out(11, 'def\n')].map((e) => ({ ...e, stream: 'stdout' }) as JournalEvent) };
  assert.deepEqual((await journalRunText(pipes, { cols: 40 }, proc)).text.split('\n'), ['ready', 'ERROR: boom', 'abcdef']);
});

test('a live Run’s transcript renders its gaps as holes too', async () => {
  const h = await scriptedSession();
  try {
    const a = h.session.admit({ target: 'shell', line: 'echo hello', principal: 'agent:a@test' });
    assert.ok(a.admitted);
    await h.session.awaitRun(a.run.runId, 1000);
    // What the Run's read returns when the disk refused a stretch of its output: its events, and the gap.
    const out = (seq: number, data: string): JournalEvent => ({ seq, ts: 0, type: 'output', stream: 'pty', runId: a.run.runId, data });
    const gap = { seq: 20, ts: 0, type: 'gap', from: 11, to: 15, reason: 'store-error' } as Extract<JournalEvent, { type: 'gap' }>;
    h.session.runOutput = () => ({ events: [out(10, 'ready \x1b]0;tit'), out(16, 'ERROR: boom\r\n')], from: 9, to: 17, truncated: true, gaps: [gap] });
    const t = await h.session.runTranscript(a.run.runId);
    assert.deepEqual(t.text.split('\n'), ['ready', 'ERROR: boom']);
    assert.equal(t.truncated, true);
  } finally {
    await h.session.close();
  }
});

test('a line a CR went back over is a line of its own at a boundary: a hole, a note, a header or another source starts a fresh line wherever the cursor stands (the house’s review of f3750e4..4f4c067, #22, comment 6315636412)', async () => {
  // `progress 50%`, a CR, a hole, then `done` read `doneress 50%`, since a boundary started a fresh line only past column 0.
  const run = (data: string): ProjectChunk => ({ data, stream: 'stdout', runId: 'r1' });
  const read = async (chunks: ProjectChunk[], label?: typeof sourceLabel) => (await project(chunks, { cols: 40, ...(label ? { label } : {}) })).text.split('\n');
  assert.deepEqual(await read(['progress 50%\r', { hole: true }, 'done\r\n']), ['progress 50%', 'done']);
  assert.deepEqual(await read(['progress 50%\r', { note: '[… lost …]' }, 'done\r\n']), ['progress 50%', '[… lost …]', 'done'], 'the note wrote over it');
  assert.deepEqual(await read([run('50%\r'), 'p1\r\n', run('done\n')]), ['p1', 'done'], 'one source: its own CR still goes back over its line');
  assert.deepEqual(await read(['progress 50%\r', run('r1 line\n')], sourceLabel), ['[run r1]', 'r1 line', '[terminal]', 'progress 50%'], 'a held line flushed at the end');
  assert.deepEqual(await read(['progress 50%\rdone\r\n']), ['doneress 50%'], 'with no boundary, as the terminal shows it');
  assert.deepEqual(await read(['one\r\n', { hole: true }, 'two\r\n']), ['one', 'two'], 'a line already ended: no blank line');
});

test('a boundary after a cursor moved up starts the next segment below every row with text, not on the row below the cursor', async () => {
  // A reviewer's read of the fixes for #22: a multi-line display redrawn with cursor-up, as docker's and cargo's progress is,
  // leaves the cursor above its own rows when a segment ends, and the boundary's one line end took the next segment onto the
  // row below, over its text: `line1`, then `Xine2`.
  const read = async (chunks: ProjectChunk[]) => (await project(chunks, { cols: 40 })).text.split('\n');
  assert.deepEqual(await read(['line1\r\nline2\r\n\x1b[2A', { hole: true }, 'X\r\n']), ['line1', 'line2', 'X']);
  assert.deepEqual(await read(['line1\r\nline2\r\nline3\r\n\x1b[3A', { note: '[… lost …]' }, 'X\r\n']), ['line1', 'line2', 'line3', '[… lost …]', 'X'], 'a note');
  assert.deepEqual(await read(['line1\r\nline2\r\n\x1b[2AX\r\n']), ['Xine1', 'line2'], 'with no boundary, as the terminal shows it');
  assert.deepEqual(await read(['one\r\n\r\n\r\n\x1b[2A', { hole: true }, 'two\r\n']), ['one', 'two'], 'blank rows below the cursor are no text');
});

test('a boundary on the alternate screen, after the cursor moved up, scrolls the frame’s top row away rather than writing over a row, and says nothing of it', async () => {
  // A reviewer's read of the fixes for #22: no spec put a boundary after an alternate-screen frame. freshLine goes past the
  // frame's last row, which is the screen's, and the alternate screen keeps no scrollback, so the top row goes; the next
  // segment's own line end there scrolls another. Nothing is written over, and the loss isn't reported.
  const frame = '\x1b[?1049h\x1b[H' + ['f1', 'f2', 'f3', 'f4', 'f5'].map((r, i) => `\x1b[${i + 1};1H${r}`).join('') + '\x1b[2;1H';
  const p = await project([frame, { hole: true }, 'X\r\n'], { cols: 20, rows: 5 });
  assert.deepEqual(p.text.split('\n'), ['f3', 'f4', 'f5', 'X']);
  assert.deepEqual([p.truncated, p.omittedInputBytes], [false, 0]);
});
