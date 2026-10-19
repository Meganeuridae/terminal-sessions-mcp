/**
 * Reading by cursor (G11, §6, §11 `read`) against a journal, the rules in
 * src/api/reader.ts one by one: head-first pages that never skip or repeat
 * (er-1, ux-1, ux-2), `more` and `splitLine` (er-7, er-12), tail (er-13,
 * atc-16, ux-21), sources (er-8), geometry (er-10), and gaps (jr2-11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJournal, type ReadResult, type ReadSource } from '../src/api/reader.js';
import { Journal } from '../src/core/journal.js';
import { project } from '../src/core/transcript.js';
import { endRun, out, readAll, source, startRun } from './reader-fixture.spec.js';

const numbered = (n: number, eol = '\n', from = 1) => Array.from({ length: n }, (_, i) => `L${String(i + from).padStart(6, '0')} some text here${eol}`).join('');

// ───────────── er-1 / ux-1: pages never skip, whatever the event size ─────────────

test('er-1 / ux-1: a multi-MB single-event process Run pages back exactly, page by page, within maxBytes', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  const body = numbered(150_000); // 4 MB in one event
  out(src.journal, body, 'stdout', 'r1');
  endRun(src.journal, 'r1');
  const { text, pages } = await readAll(src, { runId: 'r1' }, (r) => assert.ok(Buffer.byteLength(r.text!) <= 16384, `page of ${Buffer.byteLength(r.text!)} bytes`));
  assert.equal(text, body.replace(/\n$/, ''));
  assert.ok(pages.length > 200, `${pages.length} pages`);
  assert.ok(pages.slice(0, -1).every((p) => p.nextOffset !== undefined && !p.truncated && !p.splitLine), 'cut inside the event, at line ends');
  assert.equal(pages.at(-1)!.more, false);
});

test('er-1 / ux-1: 64 KiB pipe reads (the process target) page back exactly with the default and the smallest page', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  const body = numbered(20_000);
  for (let i = 0; i < body.length; i += 65536) out(src.journal, body.slice(i, i + 65536), 'stdout', 'r1');
  endRun(src.journal, 'r1');
  for (const maxBytes of [16384, 1024]) {
    const { text } = await readAll(src, { runId: 'r1', maxBytes });
    assert.equal(text, body.replace(/\n$/, ''), `maxBytes ${maxBytes}`);
  }
});

test('er-1: tab-heavy and cursor-addressed output (the projection is larger than its input) pages back exactly, never over maxBytes', async () => {
  const src = source();
  let raw = '';
  for (let i = 1; i <= 3000; i++) raw += `L${String(i).padStart(5, '0')}\t\t\t\t\t\t\tX\r\n`;
  for (let i = 0; i < raw.length; i += 1024) out(src.journal, raw.slice(i, i + 1024));
  const want = (await project([raw], { cols: 80, rows: 24, keep: 'head', maxLines: 1e6 })).text;
  const { text } = await readAll(src, { since: 0, maxBytes: 4096 }, (r) => assert.ok(Buffer.byteLength(r.text!) <= 4096, `page of ${Buffer.byteLength(r.text!)} bytes`));
  assert.equal(text, want);
  assert.equal(text.split('\n').length, 3000);
});

/** A small seeded PRNG, so a failing case reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('er-1 (property): random output in random chunkings, paged with small budgets, reconstructs the whole projection exactly', async () => {
  const words = ['alpha', 'beta', 'γάμμα', '日本語', 'emoji😀', 'x', '', '0123456789'];
  const sgr = ['\x1b[31m', '\x1b[0m', '\x1b[1;32m', '\x1b]0;title\x07', '\x1b[K'];
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const pipe = seed % 2 === 0;
    const eol = pipe ? '\n' : pick(['\r\n', '\r\n', '\r\r\n']);
    // Lines shorter than the smallest page (a longer line is cut mid-line, which a tab would not survive).
    let data = '';
    const lines = 200 + Math.floor(r() * 600);
    for (let l = 0; l < lines; l++) {
      let line = '';
      for (let w = Math.floor(r() * 12); w > 0; w--) line += (r() < 0.2 ? pick(sgr) : '') + pick(words) + (r() < 0.1 ? '\t' : ' ');
      data += line + eol;
    }
    // A few long lines, without tabs: they are cut at a safe point, mid-line.
    for (let l = 0; l < 3; l++) data += `${'long-'.repeat(400 + Math.floor(r() * 400))}${pick(sgr)}end${eol}`;
    const src = source({ cols: 60 + Math.floor(r() * 80) });
    const runId = pipe ? 'r1' : undefined;
    if (runId) startRun(src.journal, runId);
    // Chunks cut anywhere but inside a surrogate pair (a decoder never splits one): CRLF, escapes and characters split.
    for (let i = 0; i < data.length; ) {
      let n = 1 + Math.floor(r() * (r() < 0.5 ? 64 : 3000));
      if (i + n < data.length && (data.charCodeAt(i + n) & 0xfc00) === 0xdc00) n++;
      out(src.journal, data.slice(i, i + n), pipe ? 'stdout' : 'pty', runId);
      i += n;
    }
    if (runId) endRun(src.journal, runId);
    const want = (await project([{ data, stream: pipe ? 'stdout' : 'pty' }], { cols: src.cols, rows: 24, keep: 'head', maxLines: 1e6 })).text;
    const maxBytes = 1024 + Math.floor(r() * 3000);
    const { text } = await readAll(src, runId ? { runId, maxBytes } : { since: 0, maxBytes });
    assert.equal(text, want, `seed ${seed} (${pipe ? 'pipe' : 'pty'}, maxBytes ${maxBytes})`);
  }
});

test('er-1 / er-12 (property): paged by since and offset while output arrives, a Run reads back as its whole projection', async () => {
  const words = ['alpha', 'γάμμα', 'emoji😀', 'x', '\x1b[31m', '\x1b[0m', '\x1b]0;t\x07'];
  // Trailing blanks of a line a live page ended on stay on it (the line might have gone on): not compared.
  const norm = (t: string) => t.replace(/[ \t]+$/gm, '');
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const stream = seed % 2 === 0 ? 'stdout' : 'pty';
    let data = '';
    for (let l = 0; l < 300; l++) data += `${Array.from({ length: Math.floor(r() * 8) }, () => words[Math.floor(r() * words.length)]).join(' ')}${stream === 'pty' ? '\r\n' : '\n'}`;
    const src = source();
    startRun(src.journal, 'r1', stream === 'pty' ? 'shell' : 'process');
    const maxBytes = 1024 + Math.floor(r() * 2000);
    let text = '';
    let at = 0;
    let prev: ReadResult | undefined;
    let cursor: { since?: number; offset?: number } = {};
    for (let guard = 0; guard < 10_000; guard++) {
      // A few chunks arrive between reads, cut anywhere but inside a surrogate pair.
      for (let b = Math.floor(r() * 4); b > 0 && at < data.length; b--) {
        let n = 1 + Math.floor(r() * 700);
        if ((data.charCodeAt(at + n) & 0xfc00) === 0xdc00) n++;
        out(src.journal, data.slice(at, at + n), stream, 'r1');
        at += n;
        if (at >= data.length) endRun(src.journal, 'r1');
      }
      const p = await readJournal(src, { runId: 'r1', maxBytes, ...cursor }, { resultBytes: 16384 });
      if (prev && !prev.splitLine && p.text) text += '\n';
      text += p.text;
      if (p.text) prev = p;
      cursor = { since: p.nextCursor, ...(p.nextOffset !== undefined ? { offset: p.nextOffset } : {}) };
      if (at >= data.length && !p.more) break;
    }
    const want = (await project([{ data, stream }], { cols: src.cols, rows: 24, keep: 'head', maxLines: 1e6 })).text;
    assert.equal(norm(text), norm(want), `seed ${seed} (${stream}, maxBytes ${maxBytes})`);
  }
});

test('ux-2: a page never loses lines to maxLines: 120 000 short lines with a 1 MiB page are all read, with truthful more', async () => {
  const src = source();
  const body = Array.from({ length: 120_000 }, (_, i) => `${i + 1}\r\n`).join('');
  for (let i = 0; i < body.length; i += 1024) out(src.journal, body.slice(i, i + 1024));
  const { text, pages } = await readAll(src, { since: 0, maxBytes: 1024 * 1024 });
  const nums = text.split('\n').map(Number);
  assert.equal(nums.length, 120_000);
  assert.ok(nums.every((n, i) => n === i + 1));
  assert.ok(pages.every((p) => !p.truncated));
});

// ───────────── er-7, er-12: more and splitLine ─────────────

test('er-7: more is true while retained events remain, even when the page budget was not spent', async () => {
  const src = source();
  for (let i = 1; i <= 25_000; i++) out(src.journal, `request ${i}\r\n`);
  const first = await readJournal(src, { since: 0, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.equal(first.more, true, 'the page stopped at its scan bound: more remain');
  const { text } = await readAll(src, { since: 0, maxBytes: 1024 * 1024 });
  assert.equal(text.split('\n').length, 25_000);
  // as: events says the same.
  const ev = await readJournal(src, { since: 0, as: 'events', limit: 2000, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.equal(ev.more, true);
  assert.equal(ev.events!.length, 2000);
});

test('er-12: a page that ends mid-line in an open range says so; a final unterminated line of an ended Run does not', async () => {
  const src = source();
  startRun(src.journal, 'r1', 'shell');
  out(src.journal, 'ERROR: build fa', 'pty', 'r1');
  const live = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(live.text, 'ERROR: build fa');
  assert.equal(live.more, false);
  assert.equal(live.splitLine, true, 'the running command may go on with this line');
  out(src.journal, 'iled in step 3\r\n', 'pty', 'r1');
  const next = await readJournal(src, { runId: 'r1', since: live.nextCursor }, { resultBytes: 16384 });
  assert.equal(next.text, 'iled in step 3');
  out(src.journal, 'no newline at the end', 'pty', 'r1');
  endRun(src.journal, 'r1');
  const ended = await readJournal(src, { runId: 'r1', since: next.nextCursor }, { resultBytes: 16384 });
  assert.equal(ended.text, 'no newline at the end');
  assert.equal(ended.splitLine, undefined, 'the Run ended: its last line is final');
  // A live read of the whole session that ends mid-line is flagged too.
  assert.equal((await readJournal(src, { since: 0 }, { resultBytes: 16384 })).splitLine, true);
});

test('er-12: an unfinished control sequence at the end of a live page waits for the next page', async () => {
  const src = source();
  out(src.journal, 'plain\r\n\x1b[3');
  const a = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.equal(a.text, 'plain');
  assert.equal(a.more, false, 'nothing visible waits');
  assert.ok(a.nextOffset !== undefined);
  out(src.journal, '1mERROR\x1b[0m\r\n');
  const b = await readJournal(src, { since: a.nextCursor, offset: a.nextOffset! }, { resultBytes: 16384 });
  assert.equal(b.text, 'ERROR', 'no "1m" from a sequence cut in two');
});

test('er-12: a live page that can take nothing new keeps the offset it was given, so nothing is read twice', async () => {
  const src = source();
  out(src.journal, 'plain\r\n\x1b[3');
  const a = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  const b = await readJournal(src, { since: a.nextCursor, offset: a.nextOffset! }, { resultBytes: 16384 });
  assert.deepEqual([b.text, b.nextCursor, b.nextOffset], ['', a.nextCursor, a.nextOffset], 'still waiting at the same place');
  out(src.journal, '1mERROR\x1b[0m\r\n');
  assert.equal((await readJournal(src, { since: b.nextCursor, offset: b.nextOffset! }, { resultBytes: 16384 })).text, 'ERROR');
});

test('er-12: a live page that ends a line and then only control sequences does not say the line goes on', async () => {
  const src = source();
  out(src.journal, 'first line\r\n\x1b[31m');
  const a = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.equal(a.text, 'first line');
  assert.equal(a.splitLine, undefined, 'joined with the next page, the two lines would run together');
  out(src.journal, 'second line\x1b[0m\r\n');
  assert.equal((await readJournal(src, { since: a.nextCursor }, { resultBytes: 16384 })).text, 'second line');
});

// ───────────── er-13 / atc-16 / ux-21: tail ─────────────

test('er-13 / atc-16: tail with runId gives the last lines of that Run', async () => {
  const src = source();
  startRun(src.journal, 'r1', 'shell');
  const body = Array.from({ length: 5000 }, (_, i) => `${i + 1}\r\n`).join('');
  for (let i = 0; i < body.length; i += 1024) out(src.journal, body.slice(i, i + 1024), 'pty', 'r1');
  endRun(src.journal, 'r1');
  out(src.journal, 'after the run\r\n');
  const r = await readJournal(src, { runId: 'r1', tail: 3 }, { resultBytes: 16384 });
  assert.equal(r.text, '4998\n4999\n5000');
  assert.deepEqual(r.lines, { requested: 3, returned: 3 });
  assert.equal(r.truncated, false, 'exactly what was asked is not a cut');
  assert.equal(r.runId, 'r1');
});

test('er-13: tail with until reaches ranges older than the last few thousand events', async () => {
  const src = source();
  out(src.journal, 'old line 1\r\nold line 2\r\n');
  const until = out(src.journal, 'old line 3\r\n');
  for (let i = 0; i < 5000; i++) out(src.journal, `new ${i}\r\n`);
  const r = await readJournal(src, { tail: 2, until }, { resultBytes: 16384 });
  assert.equal(r.text, 'old line 2\nold line 3');
  assert.equal(r.nextCursor, until);
  // tail within since/until.
  const s = await readJournal(src, { tail: 10, since: 1, until }, { resultBytes: 16384 });
  assert.equal(s.text, 'old line 3');
  assert.deepEqual(s.lines, { requested: 10, returned: 1 });
  assert.equal(s.truncated, false, 'the range holds one line: fewer is not a cut');
});

test('ux-21: tail returns up to N lines, says when maxBytes cut them, and reports the range the text covers', async () => {
  const src = source();
  const seqs: number[] = [];
  for (let i = 1; i <= 20_000; i++) seqs.push(out(src.journal, `line ${String(i).padStart(6, '0')}\r\n`));
  const r = await readJournal(src, { tail: 5000 }, { resultBytes: 16384 });
  const lines = r.text!.split('\n');
  assert.ok(lines.length < 5000 && Buffer.byteLength(r.text!) <= 16384);
  assert.equal(lines.at(-1), 'line 020000');
  assert.equal(r.truncated, true, 'maxBytes cut lines that were asked for');
  assert.deepEqual(r.lines, { requested: 5000, returned: lines.length });
  assert.equal(r.seq[0], seqs[20_000 - lines.length], 'seq starts at the first line shown');
  const all = await readJournal(src, { tail: 5000, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.equal(all.text!.split('\n').length, 5000);
  assert.equal(all.truncated, false);
  // Fewer lines than asked, because there are no more: not truncated.
  const small = source();
  out(small.journal, 'only\r\ntwo\r\n');
  const few = await readJournal(small, { tail: 50 }, { resultBytes: 16384 });
  assert.equal(few.text, 'only\ntwo');
  assert.deepEqual(few.lines, { requested: 50, returned: 2 });
  assert.equal(few.truncated, false);
});

// ───────────── er-8: sources ─────────────

test('er-8: concurrent process Runs read through `since` never mix mid-line, and each change of source is labelled', async () => {
  const src = source();
  startRun(src.journal, 'rA');
  startRun(src.journal, 'rB');
  for (let n = 1; n <= 3; n++) {
    out(src.journal, `A${n}-start `, 'stdout', 'rA');
    out(src.journal, `B${n}-start `, 'stdout', 'rB');
    out(src.journal, `A${n}-end\n`, 'stdout', 'rA');
    out(src.journal, `B${n}-end\n`, 'stdout', 'rB');
  }
  const r = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  const lines = r.text!.split('\n');
  for (const l of lines.filter((x) => !x.startsWith('['))) assert.match(l, /^(A\d)-start \1-end$|^(B\d)-start \2-end$/, l);
  assert.deepEqual(lines.slice(0, 4), ['[run rA]', 'A1-start A1-end', '[run rB]', 'B1-start B1-end']);
  // One Run alone reads without labels.
  assert.equal((await readJournal(src, { runId: 'rA' }, { resultBytes: 16384 })).text, 'A1-start A1-end\nA2-start A2-end\nA3-start A3-end');
});

// ───────────── er-10: geometry ─────────────

test('er-10: pages project at the session\'s rows, and a Run\'s at the geometry it started with', async () => {
  const frame = '\x1b[?1049h' + Array.from({ length: 50 }, (_, i) => `\x1b[${i + 1};1Hrow-${String(i + 1).padStart(2, '0')}`).join('') + '\x1b[?1049l';
  const tall = source({ cols: 100, rows: 50 });
  out(tall.journal, frame);
  const r = await readJournal(tall, { since: 0 }, { resultBytes: 16384 });
  assert.equal(r.text!.split('\n').filter((l) => l.startsWith('row-')).length, 50);
  // A Run started at 100x50 in a session now 80x24 projects at 100x50.
  const resized = source({ cols: 80, rows: 24 });
  startRun(resized.journal, 'r1', 'shell', { cols: 100, rows: 50 });
  out(resized.journal, frame, 'pty', 'r1');
  const src: ReadSource = { ...resized, run: () => ({ ...resized.journal.runs.get('r1')!, cols: 100, rows: 50 }) };
  const byRun = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(byRun.text!.split('\n').filter((l) => l.startsWith('row-')).length, 50);
  const tail = await readJournal(src, { runId: 'r1', tail: 60 }, { resultBytes: 16384 });
  assert.equal(tail.text!.split('\n').filter((l) => l.startsWith('row-')).length, 50);
});

// ───────────── jr2-11: gaps are visible ─────────────

test('jr2-11: a torn write or store failure inside the range is a gap in the result and a line in the text', async () => {
  const src = source();
  out(src.journal, 'line 1\r\n');
  out(src.journal, 'line 2\r\n');
  src.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write' });
  out(src.journal, 'line 3\r\n');
  const r = await readJournal(src, { since: 1 }, { resultBytes: 16384 });
  assert.deepEqual(r.gap, { from: 3, to: 3, reason: 'torn-write' });
  assert.equal(r.text, 'line 2\n[… 1 journal event missing (seq 3–3: a torn write) …]\nline 3');
  // Two holes: both listed.
  src.journal.append({ type: 'gap', from: 6, to: 9, reason: 'store-error' });
  out(src.journal, 'line 4\r\n');
  const both = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.equal(both.gaps?.length, 2);
  assert.match(both.text!, /\[… 4 journal events missing \(seq 6–9: the journal store failed\) …\]\nline 4$/);
  // A Run's pages show the holes inside the Run.
  startRun(src.journal, 'r1');
  out(src.journal, 'run a\n', 'stdout', 'r1');
  src.journal.append({ type: 'gap', from: 99, to: 99, reason: 'torn-write' });
  out(src.journal, 'run b\n', 'stdout', 'r1');
  const run = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(run.text, 'run a\n[… 1 journal event missing (seq 99–99: a torn write) …]\nrun b');
});

test('jr2-11 / G11: a cursor older than retention starts the text with the hole it cannot show', async () => {
  const j = new Journal({ sessionId: 's' });
  const src = source({ journal: j });
  for (let i = 0; i < 40_000; i++) out(j, `${'x'.repeat(240)} ${i}\r\n`); // past the 8 MiB ring
  const oldest = j.oldestSeq!;
  assert.ok(oldest > 1);
  const r = await readJournal(src, { since: 0, maxBytes: 4096 }, { resultBytes: 16384 });
  assert.deepEqual(r.gap, { from: 1, to: oldest - 1, reason: 'retention' });
  assert.ok(r.text!.startsWith(`[… ${oldest - 1} journal events missing (seq 1–${oldest - 1}: past retention) …]`), r.text!.slice(0, 80));
});

// ───────────── er-2: apt-style output read by tail and by pages ─────────────

/** apt's Dpkg::Progress-Fancy as apt-pkg/install-progress.cc writes it (see transcript.spec.ts). */
function apt(packages: number, rows: number): string {
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

test('er-2: the tail of apt-style output reads as the terminal shows it, though its scroll region was set long before', async () => {
  const src = source({ cols: 120, rows: 30 });
  const data = apt(400, 30);
  for (let i = 0; i < data.length; i += 1024) out(src.journal, data.slice(i, i + 1024));
  const t = await readJournal(src, { tail: 6 }, { resultBytes: 16384 });
  assert.deepEqual(t.text!.split('\n'), [
    'Selecting previously unselected package pkg-400 (1.400) ...',
    'Preparing to unpack pkg-400 (1.400) ...',
    'Unpacking pkg-400 (1.400) ...',
    'Setting up pkg-400 (1.400) ...',
    'Processing triggers for man-db ...',
    'DONE-APT',
  ]);
  // Paged head first, every package's lines are there once, in order: a page deep in the output
  // keeps the scroll region set at its start, so the status line never mixes into a log line.
  for (const maxBytes of [4096, 16384, 65536]) {
    const { text } = await readAll(src, { since: 0, maxBytes });
    const lines = text.split('\n');
    const setUp = lines.filter((l) => l.startsWith('Setting up pkg-'));
    assert.deepEqual(setUp, Array.from({ length: 400 }, (_, i) => `Setting up pkg-${i + 1} (1.${i + 1}) ...`), `maxBytes ${maxBytes}`);
    assert.deepEqual(lines.filter((l) => /Progress|#####|\.\.\.\.\.\]/.test(l) && !l.startsWith('Progress')), [], `maxBytes ${maxBytes}`);
  }
});

// ───────────── the house's read of ed4ecac (#22): a hole ends an open sequence ─────────────

test('ed4ecac 3: output that ends inside a control sequence before a hole hides neither the hole nor what follows it', async () => {
  for (const open of ['\x1b]0;my tit', '\x1b[', '\x1bPq1', '\x1b_x']) {
    const many = source();
    out(many.journal, 'line 1\r\n');
    out(many.journal, `prompt ${open}`);
    many.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write' });
    for (let i = 0; i < 1000; i++) out(many.journal, `after ${i}\r\n`);
    const { text, pages } = await readAll(many, { since: 0 });
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['line 1', 'prompt', '[… 1 journal event missing (seq 3–3: a torn write) …]', 'after 0'], JSON.stringify(open));
    assert.equal(lines.length, 1003, JSON.stringify(open));
    assert.deepEqual(pages[0]!.gap, { from: 3, to: 3, reason: 'torn-write' });
    // Two lines after the hole, in a live range: nothing waits for the sequence's end, which is gone.
    const few = source();
    out(few.journal, 'line 1\r\n');
    out(few.journal, `prompt ${open}`);
    few.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write' });
    out(few.journal, 'a\r\nb\r\n');
    const r = await readJournal(few, { since: 0 }, { resultBytes: 16384 });
    assert.equal(r.text, 'line 1\nprompt\n[… 1 journal event missing (seq 3–3: a torn write) …]\na\nb', JSON.stringify(open));
    assert.deepEqual(r.gap, { from: 3, to: 3, reason: 'torn-write' });
    assert.equal(r.more, false);
    assert.equal(r.nextCursor, 4);
  }
});

// ───────────── through the App, against real bash ─────────────

test('G11 / er-1 / er-8 / er-12 through the App and a real shell: pages by since/offset read every line once; process Runs never mix mid-line', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { App } = await import('../src/api/app.js');
  const { SessionRegistry } = await import('../src/api/registry.js');
  const { NodePtyBackend } = await import('../src/backends/node-pty.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-reader-'));
  const registry = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 10_000 });
  const A = { principal: 'agent:a@test', connectionId: 'ca' };
  const follow = async (args: { session: string; runId?: string; maxBytes?: number }) => {
    let since: number | undefined;
    let offset: number | undefined;
    let text = '';
    let prev: { splitLine?: boolean } | undefined;
    for (let i = 0; i < 10_000; i++) {
      const r = await app.read(A, { ...args, ...(since !== undefined ? { since } : {}), ...(offset !== undefined ? { offset } : {}) });
      if (prev && !prev.splitLine && r.text) text += '\n';
      text += r.text ?? '';
      prev = r;
      since = r.nextCursor;
      offset = r.nextOffset;
      if (!r.more) break;
    }
    return text;
  };
  try {
    // A shell Run through the PTY (1 KiB reads), and a process Run (64 KiB pipe reads), paged small.
    const shell = await app.run(A, { session: 'pg', command: 'for i in $(seq 1 3000); do echo "line-$i-padding-padding-padding"; done', wait: 20_000 });
    const want = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}-padding-padding-padding`);
    assert.deepEqual((await follow({ session: 'pg', runId: shell.runId!, maxBytes: 8192 })).split('\n'), want);
    const proc = await app.run(A, { session: 'pg', target: 'process', command: `seq -f 'L%05g some text here' 1 20000`, wait: 20_000 });
    const got = (await follow({ session: 'pg', runId: proc.runId! })).split('\n');
    assert.deepEqual(got, Array.from({ length: 20_000 }, (_, i) => `L${String(i + 1).padStart(5, '0')} some text here`));
    // Two concurrent process Runs: every line whole, labelled by Run.
    const start = (await app.read(A, { session: 'pg', tail: 1 })).nextCursor;
    const a = app.run(A, { session: 'pg', target: 'process', command: "for n in 1 2 3; do printf 'A%s-start ' $n; sleep 0.05; printf 'A%s-end\\n' $n; done", wait: 10_000 });
    const b = app.run(A, { session: 'pg', target: 'process', command: "for n in 1 2 3; do printf 'B%s-start ' $n; sleep 0.05; printf 'B%s-end\\n' $n; done", wait: 10_000 });
    await Promise.all([a, b]);
    const mixed = (await app.read(A, { session: 'pg', since: start })).text!.split('\n').filter((l) => /[AB]\d-/.test(l));
    assert.equal(mixed.length, 6);
    for (const l of mixed) assert.match(l, /^(A\d)-start \1-end$|^(B\d)-start \2-end$/, l);
  } finally {
    await registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
