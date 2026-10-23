/**
 * Reading by cursor (G11, §6, §11 `read`) against a journal, the rules in
 * src/api/reader.ts one by one: head-first pages that never skip or repeat
 * (er-1, ux-1, ux-2), `more` and `splitLine` (er-7, er-12), tail (er-13,
 * atc-16, ux-21), sources (er-8), geometry (er-10), and gaps (jr2-11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as reader from '../src/api/reader.js';
import { gapNote, readJournal, searchJournal, type GapInfo, type ReadOptions, type ReadResult, type ReadSource } from '../src/api/reader.js';
import { Journal } from '../src/core/journal.js';
import { lineBytes, MemoryStore } from '../src/core/stores.js';
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

test('er-1: screens an erase kept, more lines than input bytes, page back whole in pages near maxBytes, none truncated', async () => {
  // A page cut to its maxLines counts the input of the lines it dropped as omitted, and the fit takes what is left: a count of
  // their text, longer than the input that drew them, took a third of what fits (the house's review of a8b6f28..4860d4c, PR
  // #22, comment 6341260318, on omittedInputBytes with keep 'head').
  const src = source();
  for (let i = 0; i < 200; i++) out(src.journal, `\x1b[24;1Hx${i}\x1b[2J`);
  const { text, pages } = await readAll(src, { since: 0, maxBytes: 1024 }, (r) => assert.ok(Buffer.byteLength(r.text!) <= 1024, `page of ${Buffer.byteLength(r.text!)} bytes`));
  assert.deepEqual(text.split('\n').filter((l) => l !== ''), Array.from({ length: 200 }, (_, i) => `x${i}`));
  assert.deepEqual(pages.filter((r) => r.truncated).length, 0);
  assert.ok(pages.length <= 8, `${pages.length} pages`);
});

test('er-1: a page whose screens an erase kept make many times its input in lines takes what fits, sized by the input its kept lines took', async () => {
  // A reviewer's read of the fixes for #22: the fit counts a page's dropped lines as omitted input, but no spec failed with that
  // count left out of the next attempt's size. Here each event of about 15 bytes keeps a screen of 100 rows, so a page cut to its
  // maxLines drops most of what it took. Sized by its whole input, each attempt shrank by a tenth, and the fit ran out of
  // attempts over budget; sized by the input its kept lines took, it fits.
  const src = source({ rows: 100 });
  for (let i = 0; i < 200; i++) out(src.journal, `\x1b[100;1Hx${i}\x1b[2J`);
  const { text, pages } = await readAll(src, { since: 0, maxBytes: 1024 }, (r) => assert.ok(Buffer.byteLength(r.text!) <= 1024, `page of ${Buffer.byteLength(r.text!)} bytes`));
  assert.deepEqual(text.split('\n').filter((l) => l !== ''), Array.from({ length: 200 }, (_, i) => `x${i}`));
  assert.deepEqual(pages.filter((r) => r.truncated).length, 0);
});

test('a tail says truncated where the projection lost rows, as a page does: a hole’s note or another source’s line scrolled a region not from row 1', async () => {
  // An independent read of the fixes for #22: the tail kept only the projection's text, so a scroll region's rows a gap note
  // or a Run's long line took went unreported in a tail, where a page said truncated.
  for (const mid of [
    (j: Journal) => j.append({ type: 'gap', from: 1, to: 1, reason: 'store-error', exact: true }),
    (j: Journal) => {
      startRun(j, 'r1');
      j.append({ type: 'output', stream: 'stdout', runId: 'r1', data: `${'L'.repeat(45)}\n` });
    },
  ]) {
    const j = new Journal({ sessionId: 's' });
    const src = source({ journal: j, cols: 20, rows: 10 });
    out(j, '\x1b[3;6r\x1b[1;1Htop1\r\ntop2\r\nr3\r\nr4\r\nr5\r\nr6');
    mid(j);
    out(j, 'X\r\n');
    const tail = await readJournal(src, { tail: 20 }, { resultBytes: 16384 });
    const page = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
    assert.deepEqual([tail.truncated, page.truncated], [true, true], JSON.stringify([tail.text, page.text]));
    assert.equal(tail.text, page.text);
  }
  // The program's own scrolls of its region lose what the terminal loses: nothing to say.
  const j = new Journal({ sessionId: 's' });
  const src = source({ journal: j, cols: 20, rows: 10 });
  out(j, '\x1b[3;6r\x1b[1;1Htop1\r\ntop2\r\nr3\r\nr4\r\nr5\r\nr6\r\nr7\r\n');
  const tail = await readJournal(src, { tail: 20 }, { resultBytes: 16384 });
  assert.deepEqual([tail.text, tail.truncated], ['top1\ntop2\nr5\nr6\nr7', false]);
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

// ───────────── 6357989601: splitLine follows the projection's lines ─────────────

test('6357989601: a projection says how its last line stands for the range that continues it', async () => {
  const opts = { cols: 20, rows: 5, keep: 'head' as const, open: true };
  const at = async (data: string) => (await project([data], opts)).lastLine;
  assert.equal(await at('abc'), 'unfinished', 'the cursor stands on the line past its start');
  assert.equal(await at('abc\r\n   '), 'unfinished', 'written indentation begins a line');
  assert.equal(await at('x'.repeat(20)), 'unfinished', 'a full row: the next character wraps, going on with the line');
  assert.equal(await at('abc\r'), 'returned', 'a CR took the cursor back over the line');
  assert.equal(await at('abc\r\n'), undefined, 'the line ended');
  assert.equal(await at('abc\x1b[2J'), undefined, 'the erase ended the line: the cursor keeps its column on a row holding nothing');
  assert.equal(await at('abc\x1b[2K'), undefined, 'the line was erased');
  assert.equal(await at('abc\r\n\x1b[4C'), undefined, 'a cursor motion onto an empty row begins no line');
  assert.equal(await at('abc\r\ndef\x1b[A'), undefined, 'the cursor stands above the last line');
  assert.equal((await project(['abc'], { ...opts, open: false })).lastLine, undefined, 'without open, no range continues this one');
  // A row the cursor only stands on is no line of the text: after the erase the text ends with the line it kept.
  assert.equal((await project(['abc\x1b[2J'], opts)).text, 'abc');
  assert.equal((await project(['abc\r\n\r\n\x1b[4C'], opts)).text, 'abc\n', 'the blank line a LF began is kept; the row the cursor was moved onto is not');
  assert.equal((await project(['abc\r\n   '], opts)).text, 'abc\n   ', 'an unfinished line keeps its trailing whitespace');
  // The head's cut of lines drops the line the cursor stands on: the last line shown is not it.
  assert.equal((await project(['a\r\nb\r\nc'], { ...opts, maxLines: 2 })).lastLine, undefined);
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
  // The lines begin inside the first event shown (the 1 KiB chunks do not fall on line ends): the page
  // before ends inside that event, right where they begin, so its earlier lines are in it and none twice.
  assert.equal(r.lines?.before?.until, r.seq[0]);
  assert.ok((r.lines?.before?.untilOffset ?? 0) > 0, JSON.stringify(r.lines));
  const earlier = await readJournal(src, { runId: 'r1', tail: 3, ...r.lines!.before! }, { resultBytes: 16384 });
  assert.equal(earlier.text, '4995\n4996\n4997');
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
  assert.deepEqual(r.lines, { requested: 5000, returned: lines.length, before: { until: r.seq[0] - 1 } });
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
  // A Run started at 100x50 in a session now 80x24 projects at 100x50: the geometry its journal record keeps (run.start).
  const resized = source({ cols: 80, rows: 24 });
  startRun(resized.journal, 'r1', 'shell', { cols: 100, rows: 50 });
  out(resized.journal, frame, 'pty', 'r1');
  assert.deepEqual([resized.run!('r1')!.cols, resized.run!('r1')!.rows], [100, 50]);
  const byRun = await readJournal(resized, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(byRun.text!.split('\n').filter((l) => l.startsWith('row-')).length, 50);
  const tail = await readJournal(resized, { runId: 'r1', tail: 60 }, { resultBytes: 16384 });
  assert.equal(tail.text!.split('\n').filter((l) => l.startsWith('row-')).length, 50);
});

// ───────────── jr2-11: gaps are visible ─────────────

test('jr2-11: a torn write or store failure inside the range is a gap in the result and a line in the text', async () => {
  const src = source();
  out(src.journal, 'line 1\r\n');
  out(src.journal, 'line 2\r\n');
  src.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write', exact: true });
  out(src.journal, 'line 3\r\n');
  const r = await readJournal(src, { since: 1 }, { resultBytes: 16384 });
  assert.deepEqual(r.gap, { from: 3, to: 3, reason: 'torn-write', exact: true });
  assert.equal(r.text, 'line 2\n[… 1 journal event missing (seq 3–3: a crash cut the journal short) …]\nline 3');
  // Two holes: both listed.
  src.journal.append({ type: 'gap', from: 6, to: 9, reason: 'store-error', exact: true });
  out(src.journal, 'line 4\r\n');
  const both = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.equal(both.gaps?.length, 2);
  assert.match(both.text!, /\[… 4 journal events missing \(seq 6–9: the journal store failed\) …\]\nline 4$/);
  // A Run's pages show the holes inside the Run.
  startRun(src.journal, 'r1');
  out(src.journal, 'run a\n', 'stdout', 'r1');
  // The hole lies inside the Run's range (a gap for a hole wholly outside it is not the Run's: the
  // house's read of the 33 commits, #22 comment 6307350477, item 7); here it is the gap event's own seq.
  const hole = src.journal.lastSeq + 1;
  src.journal.append({ type: 'gap', from: hole, to: hole, reason: 'torn-write', exact: true });
  out(src.journal, 'run b\n', 'stdout', 'r1');
  const run = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(run.text, `run a\n[… 1 journal event missing (seq ${hole}–${hole}: a crash cut the journal short) …]\nrun b`);
  // A gap the Run's events carry for a hole wholly outside the Run is not shown in its text.
  startRun(src.journal, 'r2');
  out(src.journal, 'run c\n', 'stdout', 'r2');
  src.journal.append({ type: 'gap', from: 1, to: 1, reason: 'torn-write' });
  out(src.journal, 'run d\n', 'stdout', 'r2');
  assert.equal((await readJournal(src, { runId: 'r2' }, { resultBytes: 16384 })).text, 'run c\nrun d');
});

test('a hole recorded after a Run ended, for seqs inside it, is a line in the Run\'s text where the hole is (the house\'s read of cc8c909..39787b3)', async () => {
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, 'run a\n', 'stdout', 'r1');
  const n1 = src.journal.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
  src.journal.append({ type: 'note', text: 'n', principal: 'agent:a@test' });
  const n3 = src.journal.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
  out(src.journal, 'run b\n', 'stdout', 'r1');
  endRun(src.journal, 'r1');
  assert.equal((await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 })).text, 'run a\nrun b');
  // The catch-up records, after the Run ended, that the seqs between its two outputs are gone.
  src.journal.append({ type: 'gap', from: n1, to: n3, reason: 'store-error', exact: true });
  const line = `[… 3 journal events missing (seq ${n1}–${n3}: the journal store failed) …]`;
  const r = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(r.text, `run a\n${line}\nrun b`);
  assert.deepEqual(r.gap, { from: n1, to: n3, reason: 'store-error', exact: true });
  const tail = await readJournal(src, { runId: 'r1', tail: 5 }, { resultBytes: 16384 });
  assert.equal(tail.text, `run a\n${line}\nrun b`);
  assert.deepEqual(tail.gap, { from: n1, to: n3, reason: 'store-error', exact: true });
});

test('jr2-11 / G11: a cursor older than retention starts the text with the hole it cannot show', async () => {
  const j = new Journal({ sessionId: 's' });
  const src = source({ journal: j });
  for (let i = 0; i < 40_000; i++) out(j, `${'x'.repeat(240)} ${i}\r\n`); // past the 8 MiB ring
  const oldest = j.oldestSeq!;
  assert.ok(oldest > 1);
  const r = await readJournal(src, { since: 0, maxBytes: 4096 }, { resultBytes: 16384 });
  assert.deepEqual(r.gap, { from: 1, to: oldest - 1, reason: 'retention', exact: true });
  assert.ok(r.text!.startsWith(`[… ${oldest - 1} journal events missing (seq 1–${oldest - 1}: past retention) …]`), r.text!.slice(0, 80));
});

test('every result reports the holes it spans the same way: events pages and events tails carry gap and gaps as text pages do, and store-failed is named', async () => {
  const src = source();
  out(src.journal, 'a\r\n'); // seq 1
  src.journal.append({ type: 'gap', from: 2, to: 2, reason: 'torn-write', exact: true }); // seq 2
  out(src.journal, 'b\r\n'); // seq 3
  src.journal.append({ type: 'gap', from: 4, to: 4, reason: 'store-failed', exact: true }); // seq 4
  out(src.journal, 'c\r\n'); // seq 5
  const text = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.equal(text.text, 'a\n[… 1 journal event missing (seq 2–2: a crash cut the journal short) …]\nb\n[… 1 journal event missing (seq 4–4: the journal store never took them) …]\nc');
  const page = await readJournal(src, { since: 0, as: 'events' }, { resultBytes: 16384 });
  assert.deepEqual(page.gap, { from: 2, to: 2, reason: 'torn-write', exact: true });
  assert.deepEqual(page.gaps, text.gaps, 'the same holes, reported the same way');
  assert.equal(page.gaps?.length, 2);
  const tail = await readJournal(src, { tail: 3, as: 'events' }, { resultBytes: 16384 });
  assert.deepEqual(tail.events!.map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(tail.gap, { from: 4, to: 4, reason: 'store-failed', exact: true }, 'the one hole the tail spans');
  assert.equal(tail.gaps, undefined);
  const cut = await readJournal(src, { since: 0, as: 'events', limit: 1 }, { resultBytes: 16384 });
  assert.equal(cut.gap, undefined, 'a page that ends before a hole does not span it');
  const after = await readJournal(src, { since: 4, as: 'events' }, { resultBytes: 16384 });
  assert.equal(after.gap, undefined);
});

test('an events page and an events tail keep to maxBytes in bytes, as the store writes the events, not in characters', async () => {
  const src = source();
  // About 1,060 characters an event, about 2,060 bytes stored: a budget counted in characters took three.
  for (let i = 0; i < 6; i++) out(src.journal, `${'é'.repeat(1000)} ${i}\n`);
  const budget = 4096;
  const tail = await readJournal(src, { tail: 6, as: 'events', maxBytes: budget }, { resultBytes: 16384 });
  assert.ok(tail.events!.reduce((a, e) => a + lineBytes(e), 0) <= budget, `${tail.events!.length} events`);
  assert.equal(tail.truncated, true);
  const page = await readJournal(src, { since: 0, as: 'events', maxBytes: budget }, { resultBytes: 16384 });
  assert.ok(page.events!.reduce((a, e) => a + lineBytes(e), 0) <= budget, `${page.events!.length} events`);
  assert.equal(page.more, true);
});

test('a text tail with `commands` heads each Run’s output with its line where it started, as 1.x logged commands', async () => {
  const src = source();
  src.journal.append({ type: 'run.admit', runId: 'r1', target: 'shell', principal: 'agent:a@test', origin: 'self', queued: false, line: 'echo one' });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/', line: 'echo one' });
  out(src.journal, 'one\r\n');
  endRun(src.journal, 'r1');
  startRun(src.journal, 'r2', 'shell'); // a start without a line heads nothing
  out(src.journal, 'two\r\n');
  endRun(src.journal, 'r2');
  const headed = await readJournal(src, { tail: 10, commands: true }, { resultBytes: 16384 });
  assert.equal(headed.text, '$ echo one\none\ntwo');
  assert.deepEqual(headed.lines, { requested: 10, returned: 3 });
  const plain = await readJournal(src, { tail: 10 }, { resultBytes: 16384 });
  assert.equal(plain.text, 'one\ntwo');
  const two = await readJournal(src, { tail: 2, commands: true }, { resultBytes: 16384 });
  assert.equal(two.text, 'one\ntwo', 'the heading is a line like any other: the last N lines');
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

// ───────────── the house's read of 1cabc6a (#22): holes, tails, long control strings, bounds ─────────────

const gapAt = (j: Journal) => {
  const g = j.lastSeq + 1;
  return j.append({ type: 'gap', from: g, to: g, reason: 'torn-write', exact: true }).seq;
};

test('1cabc6a 4: a Run\'s read and search show a hole wherever it lies: at a batch edge, after the last output, before the first, and 20,500 other events in', async () => {
  // Between the 2,048th and 2,049th outputs: where a walk's batch ends.
  const edge = source();
  startRun(edge.journal, 'r1');
  for (let i = 0; i < 2048; i++) out(edge.journal, `l${i}\n`, 'stdout', 'r1');
  const ge = gapAt(edge.journal);
  for (let i = 0; i < 10; i++) out(edge.journal, `m${i}\n`, 'stdout', 'r1');
  endRun(edge.journal, 'r1');
  const { text, pages } = await readAll(edge, { runId: 'r1', maxBytes: 1024 * 1024 });
  assert.match(text, /l2047\n\[… 1 journal event missing \(seq \d+–\d+: a crash cut the journal short\) …\]\nm0\n/);
  assert.deepEqual(pages.flatMap((p) => (p.gaps ?? (p.gap ? [p.gap] : [])).map((g) => g.from)), [ge]);
  assert.equal((await searchJournal(edge, { pattern: 'zzz', runId: 'r1' })).gap?.from, ge);
  // After the last output, and before the first.
  for (const where of ['after', 'before'] as const) {
    const src = source();
    startRun(src.journal, 'r1');
    if (where === 'before') gapAt(src.journal);
    out(src.journal, 'only\n', 'stdout', 'r1');
    if (where === 'after') gapAt(src.journal);
    endRun(src.journal, 'r1');
    const r = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
    assert.equal(r.gap?.reason, 'torn-write', where);
    assert.equal(r.text, where === 'before' ? '[… 1 journal event missing (seq 3–3: a crash cut the journal short) …]\nonly' : 'only\n[… 1 journal event missing (seq 4–4: a crash cut the journal short) …]', where);
    assert.equal(r.more, false, where);
    assert.equal((await searchJournal(src, { pattern: 'zzz', runId: 'r1' })).gap?.reason, 'torn-write', where);
  }
  // 20,500 other events after the first output: beyond any bounded scan of the range.
  const far = source();
  startRun(far.journal, 'r1');
  out(far.journal, 'a\n', 'stdout', 'r1');
  for (let i = 0; i < 20_500; i++) far.journal.append({ type: 'note', text: 'n', principal: 'agent:x@test' });
  const gf = gapAt(far.journal);
  out(far.journal, 'b\n', 'stdout', 'r1');
  endRun(far.journal, 'r1');
  const r = await readJournal(far, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(r.gap?.from, gf);
  assert.equal(r.text, `a\n[… 1 journal event missing (seq ${gf}–${gf}: a crash cut the journal short) …]\nb`);
  assert.equal((await searchJournal(far, { pattern: 'zzz', runId: 'r1' })).gap?.from, gf);
});

test('1cabc6a 5: a tail of one line longer than the old input cap keeps the whole line within maxBytes, and says truncated when it cannot', async () => {
  const line = `${'y'.repeat(307_201)}\n`;
  const src = source();
  startRun(src.journal, 'r1');
  for (let i = 0; i < line.length; i += 65536) out(src.journal, line.slice(i, i + 65536), 'stdout', 'r1');
  endRun(src.journal, 'r1');
  const whole = await readJournal(src, { runId: 'r1', tail: 1, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.equal(whole.text!.length, 307_201, 'the input cap is never below maxBytes');
  assert.equal(whole.truncated, false);
  const session = source();
  for (let i = 0; i < line.length; i += 1024) out(session.journal, line.slice(i, i + 1024));
  const s = await readJournal(session, { tail: 1, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.equal(s.text!.length, 307_201);
  assert.equal(s.truncated, false);
  // A line longer than the cap itself: its head is gone, and the result says so.
  const huge = source();
  startRun(huge.journal, 'r1');
  const big = `${'z'.repeat(1_300_000)}\n`;
  for (let i = 0; i < big.length; i += 65536) out(huge.journal, big.slice(i, i + 65536), 'stdout', 'r1');
  endRun(huge.journal, 'r1');
  const cut = await readJournal(huge, { runId: 'r1', tail: 1, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.ok(cut.text!.length > 0 && cut.text!.length < 1_300_000);
  assert.equal(cut.truncated, true, 'the line came back without its head');
  // The one line is shown with its head gone: said as such. It began before what was read, so the page
  // before ends with its head, and `head` reads it on from where what was read begins (`begunBefore`).
  assert.deepEqual(cut.lines, { requested: 1, returned: 1, cutHead: true, begunBefore: true, before: { until: cut.seq[0] - 1 }, head: { since: cut.seq[0] - 1 } });
});

test('1cabc6a 6: a control string longer than any lookback (an OSC 52 clipboard) never leaks its payload into a page, whatever the page size', async () => {
  const osc = (n: number) => `\x1b]52;c;${'Q'.repeat(n)}\x07`;
  for (const [payload, maxBytes, chunk] of [
    [20_000, 16384, 1024],
    [3000, 1024, 1024],
    [40_000, 4096, 100],
  ] as const) {
    const src = source();
    const data = `before\r\n${osc(payload)}after\r\nlast\r\n`;
    for (let i = 0; i < data.length; i += chunk) out(src.journal, data.slice(i, i + chunk));
    // A page that would begin inside the string takes it whole, even when it is longer than the page (readAll checks that every page makes progress).
    const { text, pages } = await readAll(src, { since: 0, maxBytes });
    assert.equal(text, 'before\nafter\nlast', `payload ${payload} in pages of ${maxBytes}`);
    assert.ok(pages.every((p) => !p.truncated));
  }
});

test('1cabc6a 7: an events tail and an events page keep to maxBytes, say when a cap cut them, and page every event once', async () => {
  const src = source();
  const seqs = Array.from({ length: 2500 }, (_, i) => out(src.journal, `${'z'.repeat(10_000)} ${i}\r\n`));
  const tail = await readJournal(src, { tail: 2000, as: 'events', maxBytes: 1024 }, { resultBytes: 16384 });
  assert.equal(tail.events!.length, 1, 'one event is over the budget by itself: it alone');
  assert.equal(tail.events![0]!.seq, seqs.at(-1));
  assert.equal(tail.truncated, true);
  const wide = await readJournal(src, { tail: 2400, as: 'events', maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
  assert.ok(wide.events!.length < 2400 && wide.events!.reduce((a, e) => a + JSON.stringify(e).length, 0) <= 1024 * 1024);
  assert.equal(wide.truncated, true, 'fewer than asked, by the budget: a cut');
  assert.deepEqual(wide.lines, { requested: 2400, returned: wide.events!.length });
  // Head-first events pages: at least one event, else within maxBytes; the cursor is the last event returned.
  const small = source();
  for (let i = 0; i < 30; i++) out(small.journal, `${'z'.repeat(700)} ${i}\r\n`);
  const got: number[] = [];
  let since = 0;
  for (let guard = 0; guard < 100; guard++) {
    const p = await readJournal(small, { since, as: 'events', maxBytes: 2048 }, { resultBytes: 16384 });
    assert.ok(p.events!.length >= 1 && (p.events!.length === 1 || p.events!.reduce((a, e) => a + JSON.stringify(e).length, 0) <= 2048));
    assert.equal(p.nextCursor, p.events!.at(-1)!.seq);
    got.push(...p.events!.map((e) => e.seq));
    since = p.nextCursor;
    if (!p.more) break;
  }
  assert.deepEqual(got, Array.from({ length: 30 }, (_, i) => i + 1));
});

test('1cabc6a: with every event of a range aged out, a Run\'s read and the session\'s tail say so', async () => {
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(64 * 1024) });
  const src = source({ journal: j });
  startRun(j, 'r1');
  for (let i = 0; i < 2000; i++) out(j, `${'x'.repeat(200)} ${i}\n`, 'stdout', 'r1');
  endRun(j, 'r1');
  const runEnd = j.lastSeq;
  for (let i = 0; i < 2000; i++) j.append({ type: 'note', text: 'n'.repeat(200), principal: 'agent:x@test' });
  assert.ok(j.oldestSeq! > runEnd, 'the Run is gone entirely');
  const r = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.deepEqual(r.gap, { from: 2, to: runEnd, reason: 'retention', exact: true });
  assert.equal(r.text, `[… ${runEnd - 1} journal events missing (seq 2–${runEnd}: past retention) …]`);
  assert.equal(r.more, false);
  const t = await readJournal(src, { tail: 5, until: runEnd }, { resultBytes: 16384 });
  assert.deepEqual(t.gap, { from: 1, to: runEnd, reason: 'retention', exact: true });
  assert.equal(t.truncated, true);
  assert.deepEqual(t.lines, { requested: 5, returned: 1 });
});

test('1cabc6a: lasting state set by a sequence split across two events still applies to pages deep in the output (er-2)', async () => {
  const src = source({ cols: 120, rows: 30 });
  const data = apt(400, 30);
  // The scroll region ESC[0;29r is cut after its `0;`: the first event ends inside it.
  const split = data.indexOf('\x1b[0;') + 4;
  assert.equal(data.slice(split, split + 3), '29r');
  out(src.journal, data.slice(0, split));
  for (let i = split; i < data.length; i += 1024) out(src.journal, data.slice(i, i + 1024));
  for (const maxBytes of [16384, 65536]) {
    const { text } = await readAll(src, { since: 0, maxBytes });
    const lines = text.split('\n');
    assert.deepEqual(lines.filter((l) => /Progress|#####|\.\.\.\.\.\]/.test(l) && !l.startsWith('Progress')), [], `maxBytes ${maxBytes}`);
    assert.equal(lines.filter((l) => l.startsWith('Setting up pkg-')).length, 400, `maxBytes ${maxBytes}`);
  }
});

test('1cabc6a: `until` bounds head-first pages, and a sealed journal\'s final unterminated line is final', async () => {
  const src = source();
  const seqs = Array.from({ length: 200 }, (_, i) => out(src.journal, `line ${String(i).padStart(3, '0')} ${'p'.repeat(40)}\r\n`));
  const { text, pages } = await readAll(src, { since: 0, until: seqs[99]!, maxBytes: 1024 });
  assert.equal(text.split('\n').length, 100);
  assert.ok(pages.length > 3);
  assert.ok(pages.every((p) => p.nextCursor <= seqs[99]!));
  assert.equal(pages.at(-1)!.nextCursor, seqs[99]);
  out(src.journal, 'no newline at the end');
  assert.equal((await readJournal(src, { since: seqs[199]! }, { resultBytes: 16384 })).splitLine, true, 'live: the line may go on');
  src.journal.seal();
  const sealed = await readJournal(src, { since: seqs[199]! }, { resultBytes: 16384 });
  assert.equal(sealed.text, 'no newline at the end');
  assert.equal(sealed.splitLine, undefined, 'sealed: nothing can continue it');
});

test('1cabc6a: every change of source in a page is headed, not only the first two', async () => {
  const src = source();
  startRun(src.journal, 'rA');
  startRun(src.journal, 'rB');
  for (let n = 1; n <= 4; n++) {
    out(src.journal, `A${n}\n`, 'stdout', 'rA');
    out(src.journal, `B${n}\n`, 'stdout', 'rB');
    out(src.journal, `T${n}\r\n`);
  }
  const r = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  const lines = r.text!.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('[')).length, 12, r.text);
  assert.deepEqual(lines.slice(0, 6), ['[run rA]', 'A1', '[run rB]', 'B1', '[terminal]', 'T1']);
});

test('ed4ecac 3: output that ends inside a control sequence before a hole hides neither the hole nor what follows it', async () => {
  for (const open of ['\x1b]0;my tit', '\x1b[', '\x1bPq1', '\x1b_x']) {
    const many = source();
    out(many.journal, 'line 1\r\n');
    out(many.journal, `prompt ${open}`);
    many.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write', exact: true });
    for (let i = 0; i < 1000; i++) out(many.journal, `after ${i}\r\n`);
    const { text, pages } = await readAll(many, { since: 0 });
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['line 1', 'prompt', '[… 1 journal event missing (seq 3–3: a crash cut the journal short) …]', 'after 0'], JSON.stringify(open));
    assert.equal(lines.length, 1003, JSON.stringify(open));
    assert.deepEqual(pages[0]!.gap, { from: 3, to: 3, reason: 'torn-write', exact: true });
    // Two lines after the hole, in a live range: nothing waits for the sequence's end, which is gone.
    const few = source();
    out(few.journal, 'line 1\r\n');
    out(few.journal, `prompt ${open}`);
    few.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write', exact: true });
    out(few.journal, 'a\r\nb\r\n');
    const r = await readJournal(few, { since: 0 }, { resultBytes: 16384 });
    assert.equal(r.text, 'line 1\nprompt\n[… 1 journal event missing (seq 3–3: a crash cut the journal short) …]\na\nb', JSON.stringify(open));
    assert.deepEqual(r.gap, { from: 3, to: 3, reason: 'torn-write', exact: true });
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
    // Two concurrent process Runs: every line whole, labelled by Run. The verdict means something only
    // when their output did interleave in the journal, so that is checked too.
    const start = (await app.read(A, { session: 'pg', tail: 1 })).nextCursor;
    const a = app.run(A, { session: 'pg', target: 'process', command: "for n in 1 2 3; do printf 'A%s-start ' $n; sleep 0.15; printf 'A%s-end\\n' $n; done", wait: 10_000 });
    const b = app.run(A, { session: 'pg', target: 'process', command: "for n in 1 2 3; do printf 'B%s-start ' $n; sleep 0.15; printf 'B%s-end\\n' $n; done", wait: 10_000 });
    await Promise.all([a, b]);
    const order: string[] = [];
    for (const e of (await app.read(A, { session: 'pg', since: start, as: 'events', limit: 2000, maxBytes: 1024 * 1024 })).events!) {
      if (e.type === 'output' && e.stream !== 'pty' && e.runId !== undefined) order.push(e.runId);
    }
    assert.ok(order.some((id, i) => i > 0 && id !== order[i - 1] && order.slice(i + 1).includes(order[i - 1]!)), `the Runs' output events interleaved: ${order.join(',')}`);
    const mixed = (await app.read(A, { session: 'pg', since: start })).text!.split('\n').filter((l) => /[AB]\d-/.test(l));
    assert.equal(mixed.length, 6);
    for (const l of mixed) assert.match(l, /^(A\d)-start \1-end$|^(B\d)-start \2-end$/, l);
  } finally {
    await registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── the house's read of 78c4d6e (#22): a leading recovery hole counted once; where a tail's earlier page ends ─────────────

test('78c4d6e 17: a recovery hole recorded as a store-failed gap event at the head of what is retained is one hole, under its recorded reason, in pages, tails and searches', async () => {
  // A ring that keeps about two events: the hole's own gap event comes to head what is retained, as a
  // recovered journal's does when the disk never took the events before it.
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  const src = source({ journal: j });
  for (let i = 1; i <= 4; i++) out(j, `gone ${i} ${'x'.repeat(1000)}\r\n`); // seq 1–4, each over the ring, dropped by it
  j.append({ type: 'gap', from: 1, to: 4, reason: 'store-failed' }); // seq 5
  out(j, 'kept\r\n'); // seq 6
  assert.equal(j.oldestSeq, 5, 'the gap event heads what is retained');
  const page = await readJournal(src, { since: 0, as: 'events' }, { resultBytes: 16384 });
  assert.deepEqual(page.gap, { from: 1, to: 4, reason: 'store-failed' }, 'the recorded hole, not a retention hole in front of it');
  assert.equal(page.gaps, undefined, 'one hole, not two');
  const text = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.deepEqual(text.gap, { from: 1, to: 4, reason: 'store-failed' });
  assert.equal(text.gaps, undefined);
  // A crash's hole is counted as up to its range (the store-failed seqs may never have been issued).
  assert.equal(text.text, '[… up to 4 journal events missing (seq 1–4: the journal store never took them) …]\nkept');
  const tail = await readJournal(src, { tail: 5 }, { resultBytes: 16384 });
  assert.deepEqual(tail.gap, { from: 1, to: 4, reason: 'store-failed' });
  assert.equal(tail.gaps, undefined);
  // A search with no cursor scans from the oldest event retained, which the hole precedes: one with `since` meets it.
  assert.equal((await searchJournal(src, { pattern: 'kept' })).gap, undefined);
  const found = await searchJournal(src, { pattern: 'kept', since: 0 });
  assert.deepEqual(found.gap, { from: 1, to: 4, reason: 'store-failed' });
  assert.equal(found.gaps, undefined);
  // A retention hole that reaches further back than the recorded one is reported for its own part only.
  const j2 = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  const src2 = source({ journal: j2 });
  for (let i = 1; i <= 4; i++) out(j2, `gone ${i} ${'x'.repeat(1000)}\r\n`); // seq 1–4
  j2.append({ type: 'gap', from: 3, to: 4, reason: 'store-failed' }); // seq 5: the disk refused 3–4 only
  out(j2, 'kept\r\n'); // seq 6
  const both = await readJournal(src2, { since: 0, as: 'events' }, { resultBytes: 16384 });
  assert.deepEqual(both.gaps, [
    { from: 1, to: 2, reason: 'retention', exact: true },
    { from: 3, to: 4, reason: 'store-failed' },
  ]);
});

test('78c4d6e 16: a tail says where a read of what came before it ends, and whether its first line has its head', async () => {
  const src = source();
  out(src.journal, 'one\r\ntwo\r\n'); // seq 1
  out(src.journal, 'three\r\nfour\r\n'); // seq 2
  out(src.journal, 'five\r\n'); // seq 3
  // The last three lines begin where seq 2 begins: what came before ends with seq 1.
  const aligned = await readJournal(src, { tail: 3 }, { resultBytes: 16384 });
  assert.equal(aligned.text, 'three\nfour\nfive');
  assert.equal(aligned.seq[0], 2);
  assert.deepEqual(aligned.lines, { requested: 3, returned: 3, before: { until: 1 } });
  // The first line shown begins inside seq 2: what came before ends there, after `three`'s 7 bytes.
  const inside = await readJournal(src, { tail: 2 }, { resultBytes: 16384 });
  assert.equal(inside.text, 'four\nfive');
  assert.deepEqual(inside.lines, { requested: 2, returned: 2, before: { until: 2, untilOffset: 7 } });
  assert.equal(inside.seq[0], 2);
  const back = await readJournal(src, { tail: 2, ...inside.lines!.before! }, { resultBytes: 16384 });
  assert.equal(back.text, 'two\nthree', 'the page before meets this one: nothing in neither, nothing twice');
  // Everything retained is shown whole: the lines have their heads, and nothing came before.
  const all = await readJournal(src, { tail: 9 }, { resultBytes: 16384 });
  assert.deepEqual(all.lines, { requested: 9, returned: 5 });
  // A whole line dropped from the head for bytes is not a cut line, and the one shown keeps its head.
  const long = source();
  out(long.journal, `${'a'.repeat(3000)}\r\n`); // seq 1
  out(long.journal, 'short\r\n'); // seq 2
  const cut = await readJournal(long, { tail: 2, maxBytes: 1024 }, { resultBytes: 16384 });
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.lines, { requested: 2, returned: 1, before: { until: 1 } }, 'a whole line dropped from the head is not a cut line');
  // One line over the cap comes back without its head: said so, and `head` reads it from its head. Nothing came before it.
  const one = await readJournal(long, { tail: 1, until: 1, maxBytes: 1024 }, { resultBytes: 16384 });
  assert.equal(one.text!.length, 1024);
  assert.deepEqual(one.lines, { requested: 1, returned: 1, cutHead: true, head: { since: 0 } });
  const head = await readJournal(long, { ...one.lines!.head! }, { resultBytes: 16384 });
  assert.ok(head.text!.startsWith('a'.repeat(3000)), 'the head-first read shows the line from its head');
});

// ───────────── the house's read of the 38 commits (#22, comment 6274935728) ─────────────

test('the 38 commits 1: a line the byte cap cut is said to be cut, and the reads the tail names reach its head and what came before', async () => {
  // The house's two cases: one short line then a 3,000-byte line at 1,024 bytes; three short lines then a
  // 5,000-byte line at 2,048. The short lines dropped for bytes set `truncated`, which said nothing of the
  // line kept, cut to its last bytes; each case in separate events and in one.
  for (const [shorts, long, maxBytes] of [[1, 3000, 1024], [3, 5000, 2048]] as const) {
    for (const oneEvent of [false, true]) {
      const src = source();
      const head = Array.from({ length: shorts }, (_, i) => `short ${i + 1}\r\n`).join('');
      const line = `HEAD${'a'.repeat(long - 8)}TAIL`;
      if (oneEvent) out(src.journal, `${head}${line}\r\n`);
      else {
        out(src.journal, head);
        out(src.journal, `${line}\r\n`);
      }
      const what = `${shorts} short, ${long} bytes at ${maxBytes}, ${oneEvent ? 'one event' : 'two events'}`;
      const r = await readJournal(src, { tail: shorts + 1, maxBytes }, { resultBytes: 16384 });
      assert.equal(r.lines!.returned, 1, what);
      assert.ok(r.text!.endsWith('TAIL') && !r.text!.includes('HEAD'), what);
      assert.equal(r.truncated, true, what);
      assert.equal(r.lines!.cutHead, true, `the line kept is the one cut: ${what}`);
      // From its head, head-first: the whole line, the default page holding it.
      const h = await readJournal(src, { ...r.lines!.head! }, { resultBytes: 16384 });
      assert.ok(h.text!.startsWith(line), `the head-first read shows the line from its head: ${what}`);
      // What came before is the short lines, the page before ending where the cut line begins.
      const b = await readJournal(src, { tail: shorts + 1, maxBytes, ...r.lines!.before! }, { resultBytes: 16384 });
      assert.equal(b.text, Array.from({ length: shorts }, (_, i) => `short ${i + 1}`).join('\n'), what);
      assert.equal(b.lines!.before, undefined, `nothing came before those: ${what}`);
    }
  }
});

test('the 38 commits 2: following the earlier-page hint pages back through one event of 500 lines, new lines every time', async () => {
  // Lines of two-, three- and four-byte characters, so an offset counted in UTF-16 units instead of
  // UTF-8 bytes lands elsewhere (the house's read of the 33 commits, #22, comment 6307350650, item 9).
  const src = source();
  startRun(src.journal, 'r1');
  const body = Array.from({ length: 500 }, (_, i) => `L${String(i + 1).padStart(6, '0')} Ł€😀 ünïcödé\n`).join('');
  const seq = out(src.journal, body, 'stdout', 'r1');
  endRun(src.journal, 'r1');
  const want = body.replace(/\n$/, '').split('\n');
  for (const o of [{}, { runId: 'r1' }]) {
    let r = await readJournal(src, { ...o, tail: 50 }, { resultBytes: 16384 });
    assert.deepEqual(r.text!.split('\n'), want.slice(450), JSON.stringify(o));
    const pages = [r.text!];
    for (let i = 1; i < 10; i++) {
      // Inside the one event, right where the lines shown begin: the page before is new lines, never this page again.
      assert.equal(r.lines!.before?.until, seq);
      assert.ok(r.lines!.before!.untilOffset! > 0);
      r = await readJournal(src, { ...o, tail: 50, ...r.lines!.before! }, { resultBytes: 16384 });
      assert.deepEqual(r.text!.split('\n'), want.slice(450 - 50 * i, 500 - 50 * i), `page ${i} back, ${JSON.stringify(o)}`);
      assert.equal(r.nextCursor, seq - 1, 'reading on continues inside the event');
      assert.ok(r.nextOffset! > 0);
      const on = await readJournal(src, { ...o, since: r.nextCursor, offset: r.nextOffset! }, { resultBytes: 16384 });
      assert.equal(on.text!.split('\n')[0], want[500 - 50 * i], `reading on starts with the line after page ${i} back`);
      pages.unshift(r.text!);
    }
    assert.equal(r.lines!.before, undefined, 'the first line of the event begins the range: nothing before it');
    assert.deepEqual(pages.join('\n').split('\n'), want, 'the pages joined are the event, nothing twice, nothing skipped');
  }
});

test('the 38 commits 3: a hole the reader infers keeps its pieces on both sides of a recorded gap inside it', async () => {
  // A store-error gap is issued after the events caught up from the ring, so its range sits inside what
  // retention later takes: retention took seq 1–4, and the gap event (seq 5) records only 2–3.
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  const src = source({ journal: j });
  for (let i = 1; i <= 4; i++) out(j, `gone ${i} ${'x'.repeat(1000)}\r\n`);
  j.append({ type: 'gap', from: 2, to: 3, reason: 'store-error', exact: true }); // seq 5
  out(j, 'kept\r\n'); // seq 6
  assert.equal(j.oldestSeq, 5);
  // In seq order, as the text shows them.
  const want = [
    { from: 1, to: 1, reason: 'retention', exact: true },
    { from: 2, to: 3, reason: 'store-error', exact: true },
    { from: 4, to: 4, reason: 'retention', exact: true },
  ];
  assert.deepEqual((await readJournal(src, { since: 0, as: 'events' }, { resultBytes: 16384 })).gaps, want, 'events page');
  const text = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.deepEqual(text.gaps, want, 'text page');
  assert.match(text.text!, /seq 4–4: past retention/);
  assert.deepEqual((await readJournal(src, { tail: 5 }, { resultBytes: 16384 })).gaps, want, 'tail');
  assert.deepEqual((await searchJournal(src, { pattern: 'kept', since: 0 })).gaps, want, 'search');
});

test('the 38 commits 4 / question 5: a page that stops before a recorded gap reports the hole it records where the hole is, and the leading hole less it', async () => {
  // Retention took seq 1–4; a recorded gap for 2–3 lies past what a small page returns. The page reported the whole
  // hole as past retention, and the recorded part only on the page that held its event; a page reports every hole that
  // meets the seqs it covers, wherever its event lies (the house's review of f3750e4..4f4c067, PR #22, comment
  // 6315636412, question 5).
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(2000) });
  const src = source({ journal: j });
  for (let i = 1; i <= 4; i++) out(j, `gone ${i} ${'x'.repeat(3000)}\r\n`);
  for (let i = 5; i <= 7; i++) out(j, `kept ${i} ${'k'.repeat(300)}\r\n`);
  j.append({ type: 'gap', from: 2, to: 3, reason: 'store-error', exact: true }); // seq 8
  out(j, 'last\r\n'); // seq 9
  assert.equal(j.oldestSeq, 5);
  const want = [
    { from: 1, to: 1, reason: 'retention', exact: true },
    { from: 2, to: 3, reason: 'store-error', exact: true },
    { from: 4, to: 4, reason: 'retention', exact: true },
  ];
  const events = await readJournal(src, { since: 0, as: 'events', limit: 2 }, { resultBytes: 16384 });
  assert.deepEqual(events.events!.map((e) => [e.seq, e.type]), [[3, 'gap'], [5, 'output']], 'the recorded hole where it is, its own event on a later page');
  assert.deepEqual(events.gaps, want);
  const text = await readJournal(src, { since: 0, maxBytes: 600 }, { resultBytes: 16384 });
  assert.ok(text.seq[1] < 8, `the page stops before the recorded gap: ${JSON.stringify(text.seq)}`);
  assert.deepEqual(text.gaps, want);
  assert.match(text.text!, /^\[… 1 journal event missing \(seq 1–1: past retention\) …\]\n\[… 2 journal events missing \(seq 2–3: the journal store failed\) …\]\n\[… 1 journal event missing \(seq 4–4: past retention\) …\]\nkept 5/);
  // The page that holds the recorded gap's own event does not report the hole again: it lies wholly before it.
  const later = await readJournal(src, { since: 7, as: 'events' }, { resultBytes: 16384 });
  assert.deepEqual(later.events!.map((e) => e.seq), [9]);
  assert.equal(later.gap, undefined);
});

test('untilOffset goes with a text tail and until, and is refused anywhere else', async () => {
  const src = source();
  out(src.journal, 'one\r\ntwo\r\n');
  for (const o of [{ untilOffset: 3 }, { untilOffset: 3, until: 1 }, { untilOffset: 3, tail: 2 }, { untilOffset: 3, tail: 2, until: 1, as: 'events' as const }]) {
    // It names the two numbers to pass, not lines.before itself, which read takes no argument for (the house's read of the 33 commits, #22, comment 6307350650, item 3).
    await assert.rejects(readJournal(src, o, { resultBytes: 16384 }), /untilOffset goes with a text tail and until: pass a tail result’s lines\.before\.until and lines\.before\.untilOffset as until and untilOffset, beside tail$/, JSON.stringify(o));
  }
  const r = await readJournal(src, { tail: 2, until: 1, untilOffset: 5 }, { resultBytes: 16384 });
  assert.equal(r.text, 'one');
});

// ───────────── a reviewer's read of the fixes for #22 ─────────────

test('a first line begun before the tail’s window is marked so, and its head-first read is said to go on from where the page before ends', async () => {
  // A line of 600 KB in 1 KB events after two short lines, longer than the tail's window: `head` was said
  // to show it from its head, and read its middle from the window's start (the read reaching those bytes).
  const src = source();
  out(src.journal, 'short 1\r\nshort 2\r\n');
  const line = `HEAD${'a'.repeat(600_000)}TAIL`;
  for (let i = 0; i < line.length; i += 1000) out(src.journal, line.slice(i, i + 1000));
  out(src.journal, '\r\n');
  const r = await readJournal(src, { tail: 3, maxBytes: 16384 }, { resultBytes: 16384 });
  assert.ok(r.text!.endsWith('TAIL'));
  assert.equal(r.lines!.cutHead, true);
  assert.equal(r.lines!.begunBefore, true, 'the line began before the lines read');
  assert.deepEqual(r.lines!.head, { since: r.lines!.before!.until }, 'the head-first read starts where the page before ends');
  const h = await readJournal(src, { ...r.lines!.head! }, { resultBytes: 16384 });
  assert.ok(!h.text!.startsWith('HEAD') && h.text!.startsWith('a'), 'on from there, not from its head');
  assert.equal(h.seq[0], r.seq[0], 'the window’s first event');
  // The page before ends right there, with the line's earlier part.
  const b = await readJournal(src, { tail: 3, maxBytes: 16384, ...r.lines!.before! }, { resultBytes: 16384 });
  assert.equal(b.seq[1], r.lines!.before!.until);
  assert.ok(b.text!.endsWith('a') && !b.text!.includes('TAIL'));
  // A line the byte cap cut whose head lies inside the window is shown from its head, as before.
  const inside = source();
  out(inside.journal, `short\r\n${'b'.repeat(3000)}\r\n`);
  const c = await readJournal(inside, { tail: 1, maxBytes: 1024 }, { resultBytes: 16384 });
  assert.equal(c.lines!.cutHead, true);
  assert.equal(c.lines!.begunBefore, undefined, 'the line begins inside what was read');
});

// ───────────── the house's read of the 33 commits (#22, comment 6307350650) ─────────────

/**
 * Follow a tail's `lines.before` until it is absent, as an agent pages back: every page, each read with the
 * same tail. Each page of what came before must end before the range it was read from, or following it
 * comes back to a page already read.
 */
async function pagesBack(src: ReadSource, o: ReadOptions, maxSteps = 1000): Promise<ReadResult[]> {
  const pages: ReadResult[] = [];
  let range: { until: number; untilOffset?: number } | undefined;
  for (let step = 0; step < maxSteps; step++) {
    const r = await readJournal(src, { ...o, ...(range ?? {}) }, { resultBytes: 16384 });
    pages.push(r);
    const b = r.lines?.before;
    if (!b) return pages;
    const end = range ?? { until: src.journal.lastSeq };
    const earlier = b.until < end.until || (b.until === end.until && (b.untilOffset ?? Infinity) < (end.untilOffset ?? Infinity));
    assert.ok(earlier, `the page before ends before ${JSON.stringify(end)}: ${JSON.stringify(b)}, after ${JSON.stringify(pages.map((p) => p.text))}`);
    range = b;
  }
  assert.fail(`following lines.before ends: ${JSON.stringify(pages.slice(-4).map((p) => p.text))}`);
}

test('the 33 commits 1: two sources that each end in an unfinished line page back through every line, and no page comes back', async () => {
  // The house's three layouts, with the pty's lines ended by bare LFs as they wrote them and by CRLF as a
  // tty writes them: following lines.before from tail 1 or 2 went back and forth between the two unfinished
  // lines, and tail 3 skipped lines (an unfinished line is shown after a line another source wrote later;
  // a bare LF leaves a blank line where the source changes).
  for (const eol of ['\n', '\r\n']) {
    const layouts: Record<string, { build: (j: Journal) => void; lines: string[] }> = {
      'the pty first': {
        build: (j) => {
          out(j, `p1${eol}p2${eol}PTY-UNFIN`);
          out(j, 'r1 line\nRUN-UNFIN', 'stdout', 'r1');
        },
        lines: ['p1', 'p2', 'r1 line', 'PTY-UNFIN', 'RUN-UNFIN'],
      },
      'the Run first': {
        build: (j) => {
          out(j, 'r1 line\nRUN-UNFIN', 'stdout', 'r1');
          out(j, `p1${eol}p2${eol}PTY-UNFIN`);
        },
        lines: ['r1 line', 'RUN-UNFIN', 'p1', 'p2', 'PTY-UNFIN'],
      },
      interleaved: {
        build: (j) => {
          out(j, 'PTY-A-head');
          out(j, 'r1 line\nRUN-UNFIN', 'stdout', 'r1');
          out(j, `-PTY-A-tail${eol}p1${eol}PTY-UNFIN`);
        },
        lines: ['PTY-A-head-PTY-A-tail', 'r1 line', 'p1', 'PTY-UNFIN', 'RUN-UNFIN'],
      },
    };
    for (const [name, { build, lines }] of Object.entries(layouts)) {
      for (const tail of [1, 2, 3, 4]) {
        const src = source();
        startRun(src.journal, 'r1');
        build(src.journal);
        const pages = await pagesBack(src, { tail });
        const text = pages.map((p) => p.text).join('\n');
        for (const l of lines) assert.ok(text.includes(l), `${name}, eol ${JSON.stringify(eol)}, tail ${tail}: ${l} in ${JSON.stringify(pages.map((p) => p.text))}`);
      }
    }
  }
  // The text reaches back to the line written last: tail 1 of the pty's unfinished line and the Run's later line.
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, 'p1\r\np2\r\nPTY-UNFIN');
  out(src.journal, 'r1 line\n', 'stdout', 'r1');
  const r = await readJournal(src, { tail: 1 }, { resultBytes: 16384 });
  // Two lines of output, each under the header naming its source: the headers come extra.
  assert.equal(r.text, '[run r1]\nr1 line\n[terminal]\nPTY-UNFIN');
  assert.deepEqual(r.lines, { requested: 1, returned: 2, before: { until: 3, untilOffset: 8 } });
  const before = await readJournal(src, { tail: 2, ...r.lines!.before! }, { resultBytes: 16384 });
  assert.equal(before.text, 'p1\np2');
});

test('the 33 commits 1 (property): the pty and two Runs in random events, with unfinished lines, holes, colours and titles: paging back by lines.before reaches every line', async () => {
  let seed = 0x6307;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let round = 0; round < 60; round++) {
    const src = source();
    const j = src.journal;
    startRun(j, 'r1');
    startRun(j, 'r2');
    const tokens: string[] = [];
    const events = 2 + Math.floor(rnd() * 12);
    for (let e = 0; e < events; e++) {
      const x = rnd();
      if (x < 0.08) {
        j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 1, reason: 'torn-write' });
        continue;
      }
      const runId = x < 0.5 ? undefined : x < 0.75 ? 'r1' : 'r2';
      const ends = Math.floor(rnd() * 4);
      let data = '';
      for (let l = 0; l <= ends; l++) {
        if (l < ends || rnd() < 0.6) {
          const t = `<t${tokens.length}>`;
          tokens.push(t);
          data += rnd() < 0.2 ? `\x1b[1m${t}\x1b[0m` : t;
        }
        if (l === ends) break;
        // A title whose payload holds a line end, which ends no line.
        if (rnd() < 0.15) data += '\x1b]0;a\r\nb\x07';
        data += runId === undefined && rnd() < 0.3 ? '\n' : runId === undefined ? '\r\n' : '\n';
      }
      if (data) out(j, data, runId === undefined ? 'pty' : 'stdout', runId);
    }
    for (const tail of [1, 2, 3, 5]) {
      const pages = await pagesBack(src, { tail });
      const text = pages.map((p) => p.text).join('\n');
      for (const t of tokens) assert.ok(text.includes(t), `round ${round}, tail ${tail}: ${t} in ${JSON.stringify(pages.map((p) => p.text))}`);
    }
  }
});

test('the 33 commits 2: a LF inside an OSC ends no line: a cut line’s head is read from its head, and the page before ends before it', async () => {
  // The house's case: the OSC's payload holds a CRLF, so the line's head hint pointed inside the OSC, and the
  // head-first read began `leBBBB…`: the payload shown, the line's head missing. In one event and split across two.
  const line = `AAA\x1b]0;tit\r\nle\x07${'B'.repeat(20_000)}\r\n`;
  for (const parts of [[`line1\r\n${line}`], [`line1\r\nAAA\x1b]0;tit\r\n`, `le\x07${'B'.repeat(20_000)}\r\n`]]) {
    const src = source();
    for (const p of parts) out(src.journal, p);
    const r = await readJournal(src, { tail: 1, maxBytes: 16384 }, { resultBytes: 16384 });
    assert.equal(r.lines!.cutHead, true, JSON.stringify(r.lines));
    assert.deepEqual(r.lines!.before, { until: 1, untilOffset: 7 }, `right after line1: ${parts.length} events`);
    const h = await readJournal(src, { ...r.lines!.head! }, { resultBytes: 16384 });
    assert.ok(h.text!.startsWith('AAABBB'), `from its head, no payload: ${JSON.stringify(h.text!.slice(0, 20))}`);
    const b = await readJournal(src, { tail: 1, ...r.lines!.before! }, { resultBytes: 16384 });
    assert.equal(b.text, 'line1');
  }
});

// ───────────── an independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650) ─────────────

test('one line-end rule: head-first pages and search read a LF inside a window title as no line end, as the tail does', async () => {
  // Only the tail kept the rule: on `AAA…ESC]0;tit\r\nle BEL BBB…` a page of 1,024 bytes ended at the title's
  // LF, and the next began `leBBB…`, the title's rest shown; search found `leBBB` and not the line the tail showed.
  const line = `${'A'.repeat(600)}\x1b]0;tit\r\nle\x07${'B'.repeat(2000)}`;
  const src = source();
  out(src.journal, `${line}\r\nend\r\n`);
  const { text, pages } = await readAll(src, { since: 0, maxBytes: 1024 });
  assert.equal(text, `${'A'.repeat(600)}${'B'.repeat(2000)}\nend`, 'the pages joined are the line as the terminal shows it');
  assert.ok(pages.every((p) => !p.text!.startsWith('le')), JSON.stringify(pages.map((p) => p.text!.slice(0, 12))));
  assert.equal((await searchJournal(src, { pattern: 'AAABBB', since: 0 })).matches.length, 1, 'search finds the line the tail shows');
  assert.equal((await searchJournal(src, { pattern: '^leB', since: 0 })).matches.length, 0, 'and no line of the title’s rest');
  // The title split across two events reads the same.
  const split = source();
  out(split.journal, `${'A'.repeat(600)}\x1b]0;tit\r\n`);
  out(split.journal, `le\x07${'B'.repeat(2000)}\r\nend\r\n`);
  assert.equal((await readAll(split, { since: 0, maxBytes: 1024 })).text, `${'A'.repeat(600)}${'B'.repeat(2000)}\nend`);
  assert.equal((await searchJournal(split, { pattern: 'AAABBB', since: 0 })).matches.length, 1);
});

test('tail: N counts lines of output, and the headers naming sources come extra', async () => {
  // A tail of 5 across two sources showed 4 lines of output and a header, and said "5 of 5".
  const src = source();
  startRun(src.journal, 'r1');
  for (let i = 1; i <= 4; i++) {
    out(src.journal, `p${i}\r\n`);
    out(src.journal, `r${i}\n`, 'stdout', 'r1');
  }
  const r = await readJournal(src, { tail: 5 }, { resultBytes: 16384 });
  assert.equal(r.text, '[run r1]\nr2\n[terminal]\np3\n[run r1]\nr3\n[terminal]\np4\n[run r1]\nr4');
  assert.equal(r.lines!.requested, 5);
  assert.equal(r.lines!.returned, 5);
  // The page before ends where the first line shown begins.
  const b = await readJournal(src, { tail: 3, ...r.lines!.before! }, { resultBytes: 16384 });
  assert.equal(b.text, '[terminal]\np1\n[run r1]\nr1\n[terminal]\np2');
});

test('a hole is counted by what the journal knows: exactly when every seq of it was issued, as "up to" otherwise, and so is a gap an earlier build wrote', async () => {
  // Worded by the hole's reason, a new life's hole of events every one of which was issued read "up to", and a
  // reservation one seq ahead "1 journal event" for a seq that may never have been issued (the house's review of
  // the 40 commits through f3750e4, PR #22, comment 6310921374, question 4).
  assert.equal(gapNote({ from: 2, to: 9998, reason: 'torn-write' }), '[… up to 9997 journal events missing (seq 2–9998: a crash cut the journal short) …]', 'a crash above a reservation');
  assert.equal(gapNote({ from: 10_000, to: 10_000, reason: 'torn-write' }), '[… up to 1 journal event missing (seq 10000–10000: a crash cut the journal short) …]', 'a reservation one seq ahead');
  assert.equal(gapNote({ from: 10_002, to: 10_004, reason: 'store-failed', exact: true }), '[… 3 journal events missing (seq 10002–10004: the journal store never took them) …]', "a new life's unwritten events");
  assert.equal(gapNote({ from: 10_006, to: 10_006, reason: 'store-error', exact: true }), '[… 1 journal event missing (seq 10006–10006: the journal store failed) …]', 'what the ring dropped');
  // Through a read, each gap event recorded after its hole (notes stand for the seqs no store holds).
  const src = source();
  const hole = (n: number) => Array.from({ length: n }, () => src.journal.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq);
  out(src.journal, 'before\r\n');
  const a = hole(3);
  src.journal.append({ type: 'gap', from: a[0]!, to: a[2]!, reason: 'torn-write' });
  const b = hole(1);
  src.journal.append({ type: 'gap', from: b[0]!, to: b[0]!, reason: 'store-error', exact: true });
  out(src.journal, 'after\r\n');
  const r = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.equal(r.text, ['before', `[… up to 3 journal events missing (seq ${a[0]}–${a[2]}: a crash cut the journal short) …]`, `[… 1 journal event missing (seq ${b[0]}–${b[0]}: the journal store failed) …]`, 'after'].join('\n'));
  assert.deepEqual(r.gaps?.map((g) => g.exact), [undefined, true], 'each result carries the count’s kind');
  // A store-error gap an earlier build wrote says nothing of its count: a bound.
  const older = source();
  const c = Array.from({ length: 3 }, () => older.journal.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq);
  older.journal.append({ type: 'gap', from: c[0]!, to: c[2]!, reason: 'store-error' });
  assert.equal((await readJournal(older, { since: 0 }, { resultBytes: 16384 })).text, '[… up to 3 journal events missing (seq 1–3: the journal store failed) …]');
});

test('a hole retention took is counted exactly when the journal saw every gap below it, and as "up to" when a reservation\'s skipped seqs may lie in it', async () => {
  // A memory ring that keeps a few events: retention takes the start, the journal saw all of it.
  const plain = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  for (let i = 1; i <= 4; i++) out(plain, `gone ${i} ${'x'.repeat(1000)}\r\n`);
  out(plain, 'kept\r\n');
  const exact = await readJournal(source({ journal: plain }), { since: 0 }, { resultBytes: 16384 });
  assert.deepEqual(exact.gap, { from: 1, to: 4, reason: 'retention', exact: true });
  assert.match(exact.text!, /^\[… 4 journal events missing \(seq 1–4: past retention\) …\]/);
  // A gap whose count is a bound aged out with the events around it: its seqs are among the retention hole's.
  // (As a fixture its range holds events; the journal records one only for seqs no event has.)
  const skipped = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  for (let i = 1; i <= 2; i++) out(skipped, `gone ${'x'.repeat(1000)}\r\n`); // seq 1–2
  skipped.append({ type: 'gap', from: 1, to: 2, reason: 'torn-write' }); // seq 3: a reservation's range, a bound
  for (let i = 0; i < 3; i++) out(skipped, `gone ${'x'.repeat(1000)}\r\n`); // seq 4–6
  out(skipped, 'kept\r\n'); // seq 7
  assert.ok(skipped.oldestSeq! > 3, 'the bound gap aged out too');
  // The journal still knows the gap, so the read reports its hole itself, a bound, and retention's rest exactly.
  const bound = await readJournal(source({ journal: skipped }), { since: 0 }, { resultBytes: 16384 });
  assert.deepEqual(bound.gaps, [
    { from: 1, to: 2, reason: 'torn-write' },
    { from: 3, to: skipped.oldestSeq! - 1, reason: 'retention', exact: true },
  ]);
  assert.match(bound.text!, /^\[… up to 2 journal events missing \(seq 1–2: a crash cut the journal short\) …\]\n\[… \d+ journal events missing \(seq 3–\d+: past retention\) …\]/);
  // A journal that no longer knows of anything below what it holds (it opened after retention took those files) vouches for none of it.
  const blind = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  for (let i = 0; i < 5; i++) out(blind, `gone ${'x'.repeat(1000)}\r\n`);
  out(blind, 'kept\r\n');
  blind.runs.knownFrom = blind.oldestSeq!;
  assert.deepEqual((await readJournal(source({ journal: blind }), { since: 0 }, { resultBytes: 16384 })).gap, { from: 1, to: blind.oldestSeq! - 1, reason: 'retention' });
});

test('a read across a stretch the ring dropped while the disk refuses shows the hole where it is: the session\'s tail and pages, the Run\'s tail and pages', async () => {
  // Joined across it, the tails and the Run's pages read as whole (the house's review of the 40 commits through
  // f3750e4, PR #22, comment 6310921374: the journal's tail across an unhealed store failure).
  class Refusing extends MemoryStore {
    broken = false;
    override append(e: Parameters<MemoryStore['append']>[0]): void {
      if (this.broken) throw new Error('ENOSPC: no space left on device, write');
      super.append(e);
    }
  }
  const cold = new Refusing();
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(1500), cold });
  const src = source({ journal: j });
  startRun(j, 'r1');
  for (let i = 0; i < 3; i++) out(j, `early-${i}\n`, 'stdout', 'r1');
  cold.broken = true;
  for (let i = 0; i < 40; i++) out(j, `late-${i}-${'m'.repeat(30)}\n`, 'stdout', 'r1');
  endRun(j, 'r1');
  const lost = j.tail(1000).find((e) => e.type === 'gap');
  assert.ok(lost && lost.type === 'gap' && lost.from === 6 && lost.reason === 'store-error' && lost.exact === true, JSON.stringify(lost));
  const first = j.tail(1000).find((e) => e.type === 'output' && e.seq > 5)!.seq;
  const line = `[… ${first - 6} journal events missing (seq 6–${first - 1}: the journal store failed) …]`;
  const hole = { from: 6, to: first - 1, reason: 'store-error', exact: true };
  const runTail = await readJournal(src, { runId: 'r1', tail: 40 }, { resultBytes: 16384 });
  assert.ok(runTail.text!.includes(`early-2\n${line}\nlate-`), runTail.text);
  assert.deepEqual(runTail.gap, hole);
  const runPage = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.ok(runPage.text!.includes(`early-2\n${line}\nlate-`), runPage.text);
  assert.deepEqual(runPage.gap, hole);
  const tail = await readJournal(src, { tail: 40 }, { resultBytes: 16384 });
  assert.ok(tail.text!.includes(`early-2\n${line}\nlate-`), tail.text);
  assert.deepEqual(tail.gap, hole);
  assert.equal(tail.truncated, true, 'lines asked for were lost where the hole is');
  assert.equal(runTail.truncated, true);
  const events = await readJournal(src, { tail: 40, as: 'events' }, { resultBytes: 16384 });
  assert.ok(events.events!.some((e) => e.type === 'gap' && e.from === 6), 'the events tail holds its gap');
  assert.equal(events.truncated, true);
  // A tail whose lines all follow the hole is whole: the hole is in its window, not among what it shows.
  const after = await readJournal(src, { tail: 3 }, { resultBytes: 16384 });
  assert.equal(after.truncated, false);
  const page = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.ok(page.text!.includes(`early-2\n${line}\nlate-`), page.text);
  assert.deepEqual(page.gap, hole, 'under the reason the catch-up records, not as past retention');
  // Once the disk takes writes, the catch-up records the same hole, and reads name it as before.
  cold.broken = false;
  assert.equal(j.retryCold(), true);
  const healed = await readJournal(src, { runId: 'r1', tail: 40 }, { resultBytes: 16384 });
  assert.ok(healed.text!.includes(`early-2\n${line}\nlate-`), healed.text);
});

test('a Run’s tail across a hole marks its first line cut or begun before only when older output precedes the window, not for the hole (our read of the house’s fixes for its review of f3750e4, PR #22)', async () => {
  // The Run path took the Run's `truncated`, which a hole inside the Run sets too, for "older output exists": a tail
  // of 2 after the hole marked its whole first line `cutHead` and `begunBefore`, and called the tail truncated.
  for (const at of ['before the first line', 'between the lines'] as const) {
    const src = source();
    const j = src.journal;
    startRun(j, 'r1');
    const hole = () => j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 1, reason: 'store-error' });
    if (at === 'before the first line') hole();
    out(j, 'one\n', 'stdout', 'r1');
    if (at === 'between the lines') hole();
    out(j, 'two\n', 'stdout', 'r1');
    endRun(j, 'r1');
    for (const tail of [2, 3]) {
      const r = await readJournal(src, { runId: 'r1', tail }, { resultBytes: 16384 });
      const said = `${at}, tail ${tail}: ${JSON.stringify(r.text)} ${JSON.stringify(r.lines)}`;
      assert.equal(r.lines?.cutHead, undefined, said);
      assert.equal(r.lines?.begunBefore, undefined, said);
      // Incomplete exactly when the hole's line is among those shown (e5a55cd's rule).
      assert.equal(r.truncated, r.text!.includes('missing'), said);
    }
  }
  // Older output before the window still marks a first line begun before it.
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, `${'x'.repeat(300_000)}`, 'stdout', 'r1');
  out(src.journal, 'end\n', 'stdout', 'r1');
  endRun(src.journal, 'r1');
  const long = await readJournal(src, { runId: 'r1', tail: 1, maxBytes: 4096 }, { resultBytes: 16384 });
  assert.equal(long.lines?.cutHead, true, JSON.stringify(long.lines));
});

test('a Run’s tail with since, past what retention took of the Run’s start, is whole: older output is the range’s, as the session’s tail reads it (an independent read of the fixes for the review of f3750e4, PR #22)', async () => {
  // `older` came from retention over the Run's whole range: the tail said truncated, cutHead, begunBefore and a head
  // read on a whole first line, and grew its window to the cap, while the session's tail of the same range was whole.
  for (const small of [false, true]) {
    const journal = new Journal({ hot: new MemoryStore(small ? 3000 : 1 << 20), sessionId: 's' });
    const src = source({ journal });
    startRun(journal, 'p1');
    for (let i = 0; i < 60; i++) out(journal, `old ${i} ${'x'.repeat(40)}\n`, 'stdout', 'p1');
    const since = journal.lastSeq;
    for (let i = 0; i < 5; i++) out(journal, `new ${i}\n`, 'stdout', 'p1');
    endRun(journal, 'p1');
    assert.equal(journal.oldestSeq! > 1, small, 'retention took the Run’s start only when the ring is small');
    const run = await readJournal(src, { runId: 'p1', since, tail: 10 }, { resultBytes: 16384 });
    const session = await readJournal(src, { since, tail: 10 }, { resultBytes: 16384 });
    const said = `small ${small}: ${JSON.stringify(run.lines)} ${run.truncated}`;
    assert.equal(run.text, 'new 0\nnew 1\nnew 2\nnew 3\nnew 4', said);
    assert.deepEqual([run.truncated, run.lines], [session.truncated, session.lines], said);
    assert.deepEqual([run.truncated, run.lines], [false, { requested: 10, returned: 5 }], said);
  }
});

test('a tail whose first line the byte cap cuts keeps the header naming its source, and says the line lost its head, for every count asked', async () => {
  // The byte fit dropped the header ahead of a line longer than the cap and counted it as a line dropped ahead
  // of it: `tail: 3` and the compat pack's `tail: 54` read `zzz…`, nobody's, with no cutHead; `tail: 2` lost the
  // header in the projection (our read of the house's fixes for its review of f3750e4, PR #22).
  const src = source();
  out(src.journal, 'p1\r\n');
  startRun(src.journal, 'rx');
  out(src.journal, 'a1\na2\na3\n', 'stdout', 'rx');
  out(src.journal, 'p2\r\n');
  out(src.journal, `HEAD-${'z'.repeat(1_200_000)}-TAIL\n`, 'stdout', 'rx');
  out(src.journal, 'p3\r\n');
  for (const tail of [2, 3, 54]) {
    const r = await readJournal(src, { tail, commands: true, maxBytes: 1024 * 1024 }, { resultBytes: 16384 });
    const lines = r.text!.split('\n');
    const said = `tail ${tail}: ${JSON.stringify(lines.map((l) => l.slice(0, 12)))} ${JSON.stringify(r.lines)}`;
    assert.equal(lines[0], '[run rx]', said);
    assert.ok(lines[1]!.startsWith('zzz') && lines[1]!.endsWith('-TAIL'), said);
    assert.deepEqual(lines.slice(2), ['[terminal]', 'p3'], said);
    assert.equal(r.lines?.cutHead, true, said);
    assert.ok(Buffer.byteLength(r.text!) <= 1024 * 1024, said);
  }
});

test('a page read from an offset inside a CSI that a LF ran through applies the CSI’s head: search’s match reads on as the line it matched', async () => {
  // `A ESC [ 3 LF 1mB here`: the LF is executed inside the CSI, and `1m` ends it. Search reports `B here` with an
  // offset inside the CSI, and the page from there showed `1mB here` (the fix that taught the line-end rule a CSI a LF runs through).
  const src = source();
  out(src.journal, 'start\r\n');
  out(src.journal, 'A\x1b[3\n1mB here\r\nafter\r\n');
  const m = (await searchJournal(src, { pattern: 'B here', since: 0 })).matches[0]!;
  assert.ok(m.offset !== undefined && m.offset > 0, JSON.stringify(m));
  const page = await readJournal(src, { since: m.cursor, offset: m.offset }, { resultBytes: 16384 });
  assert.equal(page.text, 'B here\nafter');
});

test('a search that reads across the store healing reports a lost stretch once: the gap a read showed before the heal and the one the catch-up records are one hole', async () => {
  // Before the heal a read shows the stretch as a gap seated at its last seq; the catch-up records it at a new seq,
  // and a search that yields between its batches met both (an independent read of the fixes for the review of f3750e4, PR #22, its question 1).
  class Refusing extends MemoryStore {
    broken = false;
    override append(e: Parameters<MemoryStore['append']>[0]): void {
      if (this.broken) throw new Error('ENOSPC: no space left on device, write');
      super.append(e);
    }
  }
  /** Heals the disk right after the read its first batch makes, as a heal between a search's batches would. */
  class HealsAfterFirstRead extends Journal {
    heal: (() => void) | undefined;
    override range(from: number, to?: number, limit?: number): ReturnType<Journal['range']> {
      const r = super.range(from, to, limit);
      const heal = this.heal;
      this.heal = undefined;
      heal?.();
      return r;
    }
  }
  const cold = new Refusing();
  const j = new HealsAfterFirstRead({ sessionId: 's', hot: new MemoryStore(400_000), cold });
  for (let i = 0; i < 3; i++) out(j, `ok ${i}\r\n`);
  cold.broken = true;
  for (let i = 0; i < 100; i++) out(j, `big ${i} ${'b'.repeat(5000)}\r\n`);
  for (let i = 0; i < 2500; i++) out(j, `small ${i}\r\n`);
  const lost = j.since(0, 4).events[3]!;
  assert.ok(lost.type === 'gap' && lost.from === 4, JSON.stringify(lost));
  j.heal = () => {
    cold.broken = false;
    assert.equal(j.retryCold(), true);
  };
  const r = await searchJournal(source({ journal: j }), { pattern: 'no such line', since: 0 });
  assert.equal(r.more, false);
  assert.ok(j.since(lost.seq).events.some((e) => e.type === 'gap' && e.from === 4 && e.seq > lost.seq), 'the catch-up recorded it at a new seq');
  assert.deepEqual(r.gap, { from: 4, to: lost.to, reason: 'store-error', exact: true });
  assert.equal(r.gaps, undefined, 'one hole');
});

test('question 5: a page, a tail, an events page and a search that end inside a hole, or stop before its recorded gap, report it where it is', async () => {
  // With 11–38 lost, each read of 4..20 came back whole: no note, no gap (the house's review of f3750e4..4f4c067, PR
  // #22, comment 6315636412, question 5).
  class Refusing extends MemoryStore {
    broken = false;
    override append(e: Parameters<MemoryStore['append']>[0]): void {
      if (this.broken) throw new Error('ENOSPC: no space left on device, write');
      super.append(e);
    }
  }
  const cold = new Refusing();
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(1500), cold });
  const src = source({ journal: j });
  for (let i = 1; i <= 10; i++) out(j, `line ${i}\r\n`);
  cold.broken = true;
  for (let i = 11; i <= 50; i++) out(j, `line ${i} ${'z'.repeat(40)}\r\n`);
  const held = j.tail(1000).find((e) => e.type === 'output' && e.seq > 10)!.seq;
  const hole = { from: 11, to: held - 1, reason: 'store-error', exact: true };
  const line = `[… ${held - 11} journal events missing (seq 11–${held - 1}: the journal store failed) …]`;
  for (const when of ['before the heal', 'after it']) {
    const page = await readJournal(src, { since: 4, until: 20 }, { resultBytes: 16384 });
    assert.equal(page.text, `line 5\nline 6\nline 7\nline 8\nline 9\nline 10\n${line}`, when);
    assert.deepEqual(page.gap, hole, when);
    const tail = await readJournal(src, { tail: 3, until: 20 }, { resultBytes: 16384 });
    assert.equal(tail.text, `line 9\nline 10\n${line}`, when);
    assert.deepEqual(tail.gap, hole, when);
    assert.deepEqual((await readJournal(src, { since: 4, until: 20, as: 'events' }, { resultBytes: 16384 })).gap, hole, when);
    assert.deepEqual((await searchJournal(src, { pattern: 'line', since: 4, until: 20 })).gap, hole, when);
    if (when === 'before the heal') {
      cold.broken = false;
      assert.equal(j.retryCold(), true);
    }
  }
  // After the heal the gap is recorded past every line: an events page that stops before it reports the hole where it is,
  // and the one holding the gap's own event, which lies wholly after the hole, does not report it again.
  const first = await readJournal(src, { since: 0, as: 'events', limit: 12 }, { resultBytes: 16384 });
  assert.deepEqual(first.gap, hole);
  assert.ok(first.events!.some((e) => e.type === 'gap' && e.seq === held - 1), 'seated where the hole ends');
  const recorded = j.since(held).events.find((e) => e.type === 'gap')!.seq;
  const last = await readJournal(src, { since: recorded - 1, as: 'events' }, { resultBytes: 16384 });
  assert.equal(last.gap, undefined);
  assert.deepEqual(last.events!.map((e) => e.seq), [], 'the gap event names a hole elsewhere, reported there');
});

test('a text tail reports the holes that meet the lines it returns, not every hole of the window it read, a session\'s tail and a Run\'s', async () => {
  // A tail of 3 whose lines all follow a hole reported the hole, 34 seqs before its first line, and a tail of 60 over 61
  // holes listed all 61 where it showed 8 (an independent read, PR #22).
  class Refusing extends MemoryStore {
    broken = false;
    override append(e: Parameters<MemoryStore['append']>[0]): void {
      if (this.broken) throw new Error('ENOSPC: no space left on device, write');
      super.append(e);
    }
  }
  for (const runId of [undefined, 'r1']) {
    const cold = new Refusing();
    const j = new Journal({ sessionId: 's', hot: new MemoryStore(700), cold });
    const src = source({ journal: j });
    const write = (data: string) => (runId === undefined ? out(j, `${data}\r\n`) : out(j, `${data}\n`, 'stdout', runId));
    if (runId !== undefined) startRun(j, runId);
    write('first');
    cold.broken = true;
    for (let i = 0; i < 12; i++) write(`lost ${i} ${'z'.repeat(40)}`);
    cold.broken = false;
    assert.equal(j.retryCold(), true);
    for (let i = 0; i < 30; i++) write(`after ${i}`);
    const at = (o: ReadOptions) => readJournal(src, { ...o, ...(runId !== undefined && { runId }) }, { resultBytes: 65536 });
    const short = await at({ tail: 3 });
    assert.equal(short.text, 'after 27\nafter 28\nafter 29', String(runId));
    assert.equal(short.gap, undefined, `${runId}: no hole meets the lines it returns`);
    assert.equal(short.gaps, undefined);
    assert.equal(short.truncated, false);
    const long = await at({ tail: 40 });
    const shown = long.text!.split('\n').filter((l) => /journal events? missing/.test(l));
    assert.equal(shown.length, 1, `${runId}: ${long.text}`);
    assert.equal(long.gap?.reason, 'store-error', `${runId}: the hole whose line it shows`);
    assert.equal(long.gaps, undefined);
  }
});

test('paging back past a title left open before a hole reaches every line: the title shows nothing, and the row its LF left counts', async () => {
  // `one`, `two` ended by a bare LF, a title the hole leaves open, then the hole: the hole's line starts after a
  // blank row, which the tail had read as `two`, so the page before ended after `one`.
  for (const tail of [1, 2, 3]) {
    const src = source();
    out(src.journal, 'one\r\ntwo\n\x1b]0;q\r\n');
    src.journal.append({ type: 'gap', from: 2, to: 2, reason: 'torn-write' });
    src.journal.append({ type: 'gap', from: 3, to: 3, reason: 'torn-write' });
    const pages = await pagesBack(src, { tail });
    const text = pages.map((p) => p.text).join('\n');
    for (const l of ['one', 'two']) assert.ok(text.includes(l), `tail ${tail}: ${l} in ${JSON.stringify(pages.map((p) => p.text))}`);
  }
});

test('search reads a C1 OSC as a string and a CAN as its end, as the projection does', async () => {
  // The cleaner and the line-end rule share text.ts's grammar: a U+009D OSC's LF ended a line, and its payload
  // was text; a string CAN ended read on.
  const c1 = source();
  out(c1.journal, 'a\u009d0;my\ntitle\u0007b\r\n');
  assert.deepEqual((await searchJournal(c1, { pattern: '^ab$', since: 0 })).matches.map((m) => m.line), ['ab']);
  assert.equal((await searchJournal(c1, { pattern: 'title', since: 0 })).matches.length, 0, 'the payload is not text');
  const can = source();
  out(can.journal, 'a\x1b]0;my\x18\nb\r\n');
  assert.deepEqual((await searchJournal(can, { pattern: '^b$', since: 0 })).matches.map((m) => m.line), ['b']);
});

test('paging back past a command of several lines reaches every line: its `$ <line>` note is as many lines as it shows, and no page begins inside it', async () => {
  // A note was one line to the display, while the text shows a command's line of three as three: a tail of 5
  // followed back never showed `$ echo one` or `echo two`, and one of 6 never `prompt$` or `$ echo one`. A page
  // whose lines would begin inside the note shows it whole.
  const src = source();
  out(src.journal, 'prompt$ \r\n');
  src.journal.append({ type: 'run.admit', runId: 'r1', target: 'shell', principal: 'agent:a@test', origin: 'self', queued: false });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/', line: 'echo one\necho two\necho three' });
  out(src.journal, 'one\r\ntwo\r\nthree\r\n');
  endRun(src.journal, 'r1');
  out(src.journal, 'after\r\n');
  const all = (await readJournal(src, { tail: 50, commands: true }, { resultBytes: 16384 })).text!.split('\n');
  assert.deepEqual(all, ['prompt$', '$ echo one', 'echo two', 'echo three', 'one', 'two', 'three', 'after']);
  for (const tail of [1, 2, 3, 4, 5, 6, 7]) {
    const pages = await pagesBack(src, { tail, commands: true });
    const seen = new Set(pages.flatMap((p) => p.text!.split('\n')));
    for (const l of all) assert.ok(seen.has(l), `tail ${tail}: ${l} in ${JSON.stringify(pages.map((p) => p.text))}`);
  }
});

test('a head-cut first line that reads like a later line of a command note is still said to be cut: only a note’s first line can begin the lines shown (our read of the house’s fixes for its review of f3750e4, PR #22: fbadcf1)', async () => {
  // One progress line longer than the tail's input cap, under a three-line command: its last part, `done`, is the
  // first line shown, and it matched the note's third line, so the tail dropped cutHead and the read of its head.
  for (const line of ['for i in 1 2; do\n  step $i\ndone', 'for i in 1 2; do step $i; done']) {
    const src = source();
    out(src.journal, 'p$ \r\n');
    src.journal.append({ type: 'run.admit', runId: 'r1', target: 'shell', principal: 'agent:a@test', origin: 'self', queued: false });
    src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/', line });
    let progress = '';
    for (let i = 0; i < 25_000; i++) progress += `\r${String(i).padStart(12)}`;
    out(src.journal, progress);
    out(src.journal, '\rdone        \r\n');
    const r = await readJournal(src, { tail: 1, commands: true }, { resultBytes: 16384 });
    assert.equal(r.text, 'done', JSON.stringify(line));
    assert.equal(r.lines?.cutHead, true, `${JSON.stringify(line)}: ${JSON.stringify(r.lines)}`);
    assert.ok(r.lines?.head, `${JSON.stringify(line)}: the read of its head`);
  }
  // A note's first line still begins the lines shown without a head to cut.
  const src = source();
  src.journal.append({ type: 'run.admit', runId: 'r1', target: 'shell', principal: 'agent:a@test', origin: 'self', queued: false });
  src.journal.append({ type: 'run.start', runId: 'r1', cwd: '/', line: 'echo one\necho two' });
  out(src.journal, 'one\r\ntwo\r\n');
  const whole = await readJournal(src, { tail: 4, commands: true }, { resultBytes: 16384 });
  assert.equal(whole.text, '$ echo one\necho two\none\ntwo');
  assert.equal(whole.lines?.cutHead, undefined);
});

test('a tail that reaches back to the line written last, cut by the byte cap, counts the lines it shows and reads on from where the page before ends', async () => {
  // The pty's line, begun before a Run's and written last, is held behind it (rule 6), so a tail of 1 reaches back
  // to it. At 1,024 bytes the cut dropped it whole while `returned` said 2, and at 2,048 it cut its head, which
  // lies in the page before, while `head` promised it from its head.
  const header = /^\[(terminal|run .+)\]$/;
  for (const maxBytes of [1024, 2048]) {
    const src = source({ cols: 4000 });
    out(src.journal, 'p1\r\n' + 'P'.repeat(700));
    startRun(src.journal, 'r1');
    out(src.journal, 'r0\r\n' + 'R'.repeat(700), 'stdout', 'r1');
    out(src.journal, 'S'.repeat(700));
    const r = await readJournal(src, { tail: 1, maxBytes }, { resultBytes: 16384 });
    const shown = r.text!.split('\n').filter((l) => !header.test(l));
    assert.equal(r.lines!.returned, shown.length, `maxBytes ${maxBytes}: ${JSON.stringify(r.lines)}`);
    assert.ok(r.lines!.cutHead && r.lines!.begunBefore && r.lines!.head && r.lines!.before, `maxBytes ${maxBytes}: ${JSON.stringify(r.lines)}`);
    const earlier = await readJournal(src, { tail: 1, maxBytes: 1 << 20, ...r.lines!.before! }, { resultBytes: 1 << 20 });
    const on = await readJournal(src, { ...r.lines!.head!, maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
    const seen = [earlier.text, r.text, on.text].join('\n');
    // The line written last (its part before the Run's line and its part after) and the Run's line: none is in neither read.
    for (const part of ['P'.repeat(700), 'R'.repeat(700), 'S'.repeat(700)]) assert.ok(seen.includes(part), `maxBytes ${maxBytes}: ${part.slice(0, 4)}… in ${JSON.stringify([earlier.text, r.text, on.text].map((t) => t?.length))}`);
  }
});

test('a tail counts the line ends a string payload holds as none: its window goes back far enough, and a window that begins inside the string shows none of it', async () => {
  // The walk counted raw LFs: past an OSC whose payload holds 800, a tail of 600 came back with 511 lines, cut, and
  // a Run's tail whose window began inside a long OSC 52 showed its base64 as lines of output.
  const s = source();
  for (let i = 0; i < 1000; i++) out(s.journal, `line ${i}\r\n`);
  out(s.journal, '\x1b]52;c;' + 'QUFB\n'.repeat(800) + '\x07');
  out(s.journal, 'last\r\n');
  const t = await readJournal(s, { tail: 600 }, { resultBytes: 1 << 20 });
  const shown = t.text!.split('\n');
  assert.equal(shown.length, 600, JSON.stringify({ first: shown[0], lines: t.lines }));
  assert.equal(shown[0], 'line 401');
  assert.ok(!t.truncated && !t.lines!.cutHead, JSON.stringify(t.lines));
  // A Run's OSC 52 of 2,000 and of 4,000 lines of base64: the second is longer than the window's cap, so the window
  // begins inside it, and what the output before it left open is read from there.
  for (const payload of [2000, 4000]) {
    const src = source();
    startRun(src.journal, 'r1');
    out(src.journal, 'before\r\n\x1b]52;c;', 'stdout', 'r1');
    for (let i = 0; i < payload; i++) out(src.journal, `${'QUFB'.repeat(19)}\n`, 'stdout', 'r1');
    out(src.journal, '\x07done\r\n', 'stdout', 'r1');
    endRun(src.journal, 'r1');
    for (const tail of [1, 3]) {
      const r = await readJournal(src, { runId: 'r1', tail }, { resultBytes: 1 << 20 });
      const lines = r.text!.split('\n');
      assert.ok(!lines.some((l) => l.includes('QUFB')), `payload ${payload}, tail ${tail}: ${JSON.stringify(lines.map((l) => l.slice(0, 12)))}`);
      assert.equal(lines[lines.length - 1], 'done');
    }
  }
});

test('a head-first page over a string left open across thousands of small events reads in linear time', async () => {
  // Each event that might have ended the string ran the collected output's open-sequence scan again: 20,000
  // events holding a BEL inside a DCS (which a BEL does not end), or each opening a string of its own, held
  // the event loop for about two minutes (an independent read of the house's fixes for #22).
  for (const each of [(i: number) => `p${i}\x07`, (i: number) => `\x1b]0;p${i}`]) {
    const s = source();
    out(s.journal, 'x'.repeat(15000) + '\r\n\x1bPq');
    for (let i = 0; i < 20000; i++) out(s.journal, each(i));
    out(s.journal, '\x1b\\done\r\n');
    const t0 = performance.now();
    const r = await readJournal(s, { since: 0 }, { resultBytes: 16384 });
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${Math.round(ms)} ms`);
    assert.equal(r.more, true);
    assert.equal(r.nextOffset, 15002, JSON.stringify({ next: r.nextCursor, off: r.nextOffset }));
  }
});

test('an events tail stops walking back once it holds the events it returns (our read of the 40 commits, PR #22)', async () => {
  // Sized by line ends, a tail of 10 over events with none walked to MAX_SCAN: 40 batches for 10 events.
  const src = source();
  for (let i = 0; i < 30_000; i++) out(src.journal, 'x');
  let calls = 0;
  const tail = src.journal.tail.bind(src.journal);
  src.journal.tail = (n: number, to?: number) => {
    calls++;
    return tail(n, to);
  };
  const r = await readJournal(src, { tail: 10, as: 'events' }, { resultBytes: 16384 });
  assert.equal(r.events!.length, 10);
  assert.deepEqual(r.events!.map((e) => e.seq), Array.from({ length: 10 }, (_, i) => 29_991 + i));
  assert.ok(calls <= 2, `${calls} batches read`);
});

test('search reports a hole once when its recorded range spans several the reads showed (our read of the 40 commits, PR #22)', async () => {
  // Before the store heals, reads show a lost stretch in pieces; the catch-up's record can span more than one of
  // them. The journal's page gives them as the one hole (the merge in search itself is pinned below, by addHole).
  const src = source();
  out(src.journal, 'one\r\n');
  src.journal.append({ type: 'gap', from: 5, to: 5, reason: 'store-error' });
  src.journal.append({ type: 'gap', from: 8, to: 8, reason: 'store-error' });
  out(src.journal, 'two\r\n');
  src.journal.append({ type: 'gap', from: 4, to: 9, reason: 'store-error' });
  out(src.journal, 'three\r\n');
  const r = await searchJournal(src, { pattern: 'two', since: 0 });
  const holes = r.gaps ?? (r.gap ? [r.gap] : []);
  assert.deepEqual(holes.map((g) => [g.from, g.to, g.reason]), [[4, 9, 'store-error']], JSON.stringify(holes));
});

test("a Run's tail after a hole is not read as inside a string left open before the hole (our read of the 40 commits, PR #22)", async () => {
  // The look-back looked for the Run's holes among its events, which are outputs: a title left open before a hole
  // took every line after it, and a tail of 3 came back empty and truncated.
  const src = source();
  startRun(src.journal, 'r1');
  out(src.journal, 'a\r\n\x1b]0;title-left-open', 'stdout', 'r1');
  const hole = src.journal.lastSeq + 1;
  src.journal.append({ type: 'gap', from: hole, to: hole, reason: 'torn-write' });
  for (let i = 0; i < 8000; i++) out(src.journal, `line ${String(i).padStart(4, '0')} ${'x'.repeat(30)}\r\n`, 'stdout', 'r1');
  endRun(src.journal, 'r1');
  for (const tail of [1, 3]) {
    const r = await readJournal(src, { runId: 'r1', tail }, { resultBytes: 16384 });
    const want = Array.from({ length: tail }, (_, i) => `line ${String(8000 - tail + i).padStart(4, '0')} ${'x'.repeat(30)}`);
    assert.deepEqual(r.text!.split('\n'), want, JSON.stringify(r.lines));
  }
});

test("a tail's window reads each source's string left open before it as that string, not only the first source's (our read of the 40 commits, PR #22)", async () => {
  // The pty's title, open before the window; a Run's 600 lines; then the pty's payload, its BEL and a line. Seeded for
  // the window's first source alone, the pty's payload showed as two lines of output.
  const src = source();
  out(src.journal, 'p0\r\n\x1b]0;pty-title ');
  startRun(src.journal, 'r1');
  for (let i = 0; i < 600; i++) out(src.journal, `r-line ${i}\r\n`, 'stdout', 'r1');
  out(src.journal, 'payload-one\npayload-two\n\x07p-after\r\n');
  for (const tail of [3, 5]) {
    const r = await readJournal(src, { tail }, { resultBytes: 16384 });
    const lines = r.text!.split('\n');
    assert.ok(!lines.some((l) => l.includes('payload')), `tail ${tail}: ${JSON.stringify(lines)}`);
    assert.equal(lines[lines.length - 1], 'p-after');
  }
});

test('a tail cut by the byte cap across a change of source names the source of the first line it shows (our read of the 40 commits, PR #22)', async () => {
  // The pty's line written last is held behind a Run's long line, and the tail reaches back to it; the cut drops
  // the pty's part and begins inside the Run's line, which read under `[terminal]`.
  for (const maxBytes of [1024, 1800]) {
    const src = source({ cols: 4000 });
    out(src.journal, 'p1\r\n' + 'P'.repeat(300));
    startRun(src.journal, 'r1');
    out(src.journal, 'r0\r\n' + 'R'.repeat(2000), 'stdout', 'r1');
    out(src.journal, 'S'.repeat(300));
    const r = await readJournal(src, { tail: 1, maxBytes }, { resultBytes: 16384 });
    const lines = r.text!.split('\n');
    assert.equal(lines[0], '[run r1]', `maxBytes ${maxBytes}: ${JSON.stringify(lines.map((l) => l.slice(0, 12)))}`);
    assert.ok(lines[1]!.startsWith('R'), JSON.stringify(lines.map((l) => l.slice(0, 12))));
    assert.ok(Buffer.byteLength(r.text!) <= maxBytes, `${Buffer.byteLength(r.text!)} bytes`);
  }
});

test('a tail over many Runs reads what the sources left open in one walk back (an independent read of the fixes for the review of the 40 commits, PR #22)', async () => {
  // A walk back for every source of the window: a tail of 2,000 over 40,000 lines and 1,000 Runs of two lines took
  // 17 s. The pty is read once, with the Runs that began before the window.
  const src = source();
  for (let i = 0; i < 40_000; i++) out(src.journal, `pty line ${i}\r\n`);
  for (let r = 0; r < 200; r++) {
    startRun(src.journal, `r${r}`);
    out(src.journal, `r${r} one\r\nr${r} two\r\n`, 'stdout', `r${r}`);
    endRun(src.journal, `r${r}`);
  }
  let calls = 0;
  const tail = src.journal.tail.bind(src.journal);
  src.journal.tail = (n: number, to?: number) => {
    calls++;
    return tail(n, to);
  };
  const r = await readJournal(src, { tail: 2000 }, { resultBytes: 1 << 20 });
  assert.ok(r.text!.endsWith('r199 two'), r.text!.slice(-40));
  assert.ok(calls < 1000, `${calls} batches read`);
});

test("a tail that ends at offset 0 of the journal's first event is empty (an independent read of the fixes for the review of the 40 commits, PR #22)", async () => {
  // Clipped to nothing, the walk's only batch was seated by its first event, which it doesn't have: a TypeError.
  const src = source();
  const first = out(src.journal, 'abc\r\n');
  out(src.journal, 'def\r\n');
  const r = await readJournal(src, { tail: 5, until: first, untilOffset: 0 }, { resultBytes: 16384 });
  assert.equal(r.text, '');
  assert.equal(r.lines?.returned, 0);
  const next = await readJournal(src, { tail: 5, until: first, untilOffset: 2 }, { resultBytes: 16384 });
  assert.equal(next.text, 'ab');
});

test('a read that ends inside what retention took reports the hole only as far as its own end (an independent read of the fixes for the review of the 40 commits, PR #22)', async () => {
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  const src = source({ journal: j });
  for (let i = 0; i < 60; i++) out(j, `line ${i}\r\n`);
  const oldest = j.oldestSeq!;
  assert.ok(oldest > 10, `oldest ${oldest}`);
  for (const until of [3, oldest - 2]) {
    const r = await readJournal(src, { since: 0, until, maxBytes: 1 << 20 }, { resultBytes: 16384 });
    assert.deepEqual(r.gap, { from: 1, to: until, reason: 'retention', exact: true }, `until ${until}`);
    const s = await searchJournal(src, { pattern: 'line', since: 0, until });
    assert.deepEqual(s.gap, { from: 1, to: until, reason: 'retention', exact: true }, `search until ${until}`);
    const ev = await readJournal(src, { since: 0, until, as: 'events' }, { resultBytes: 16384 });
    assert.deepEqual(ev.gap, { from: 1, to: until, reason: 'retention', exact: true }, `events until ${until}`);
  }
});

test('a batch of gap events that adds nothing new does not end a read or a search (an independent read of the fixes for the review of the 40 commits, PR #22)', async () => {
  // A whole batch of gap events naming a hole already reported filters to nothing, and the callers took an empty batch
  // for the range's end: "after" was in no read or search.
  const src = source();
  out(src.journal, 'before\r\n');
  const h = src.journal.lastSeq + 1;
  for (let i = 0; i < 4200; i++) src.journal.append({ type: 'gap', from: h, to: h, reason: 'store-error' });
  out(src.journal, 'after\r\n');
  const text = await readJournal(src, { since: 0, maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
  assert.ok(text.text!.endsWith('after'), text.text!.slice(-80));
  const raw = await readJournal(src, { since: 0, as: 'raw', maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
  assert.ok(raw.text!.includes('after'), raw.text!.slice(-80));
  const found = await searchJournal(src, { pattern: 'after', since: 0 });
  assert.equal(found.matches.length, 1);
});

test("a raw page notes the parts of a retention hole in order among the gaps it records (an independent read of the fixes for the review of the 40 commits, PR #22)", async () => {
  // A recorded hole inside what retention took splits the inferred hole in two; both parts were noted ahead of it.
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  const src = source({ journal: j });
  for (let i = 0; i < 60; i++) out(j, `line ${i}\r\n`);
  j.append({ type: 'gap', from: 5, to: 8, reason: 'store-error' });
  out(j, 'tail\r\n');
  const notes = (t: string) => t.split('\n').filter((l) => l.startsWith('[…')).map((l) => /seq (\d+)–(\d+)/.exec(l)!.slice(1).map(Number));
  const raw = await readJournal(src, { since: 0, as: 'raw', maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
  const text = await readJournal(src, { since: 0, maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
  const order = notes(raw.text!);
  assert.equal(order.length, 3, raw.text!.slice(0, 300));
  assert.deepEqual(order.slice(0, 2), [[1, 4], [5, 8]]);
  assert.deepEqual(order, notes(text.text!), 'as a text page orders them');
});

test('a two-source tail that fits its cap is not cut, and one that is cut says so (an independent read of the fixes for the review of the 40 commits, PR #22)', async () => {
  // Room kept for the longest header among the lines kept, `[run r123456789]`, cut a tail that fit 1,024 bytes with its
  // first header, `[terminal]`, and `truncated` stayed false.
  for (const [x, y] of [[490, 492], [700, 282]] as const) {
    const src = source({ cols: 4000 });
    out(src.journal, 'p'.repeat(x) + '\r\n');
    startRun(src.journal, 'r123456789');
    out(src.journal, 'r'.repeat(y) + '\r\n', 'stdout', 'r123456789');
    out(src.journal, 'q\r\n');
    const full = await readJournal(src, { tail: 3, maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
    assert.equal(Buffer.byteLength(full.text!), 1024);
    const r = await readJournal(src, { tail: 3, maxBytes: 1024 }, { resultBytes: 1 << 20 });
    assert.equal(r.text, full.text, `${x}/${y}`);
    assert.equal(r.truncated, false);
    assert.equal(r.lines?.returned, 3);
    // One byte more than the cap: now it's cut, and says so.
    const src2 = source({ cols: 4000 });
    out(src2.journal, 'p'.repeat(x + 1) + '\r\n');
    startRun(src2.journal, 'r123456789');
    out(src2.journal, 'r'.repeat(y) + '\r\n', 'stdout', 'r123456789');
    out(src2.journal, 'q\r\n');
    const cut = await readJournal(src2, { tail: 3, maxBytes: 1024 }, { resultBytes: 1 << 20 });
    assert.ok(Buffer.byteLength(cut.text!) <= 1024, `${Buffer.byteLength(cut.text!)} bytes`);
    assert.equal(cut.truncated, true, `${x + 1}/${y}: ${JSON.stringify(cut.lines)}`);
  }
});

test('a tail whose window holds only Runs that start in it walks back for none of them (an independent read of the fixes for the review of the 40 commits, PR #22)', async () => {
  // A process Run whose run.admit lies in the window has nothing before it. With the pty's output in the window too, a
  // walk back ran for the pty anyway, so the spec above passed with the skip removed. Here 256 Runs of four events are
  // the window's two batches exactly, after 40,000 lines of the pty's: looked for, they walk back to the event bound.
  const src = source();
  for (let i = 0; i < 40_000; i++) out(src.journal, `pty line ${i}\r\n`);
  for (let r = 0; r < 256; r++) {
    startRun(src.journal, `r${r}`);
    out(src.journal, `r${r} one\r\nr${r} two\r\n`, 'stdout', `r${r}`);
    endRun(src.journal, `r${r}`);
  }
  // The look-back's batches, told from the window's and the lasting state's by the function that reads them.
  let lookBack = 0;
  const tail = src.journal.tail.bind(src.journal);
  src.journal.tail = (n: number, to?: number) => {
    if ((new Error().stack ?? '').includes('opensBefore')) lookBack++;
    return tail(n, to);
  };
  const r = await readJournal(src, { tail: 300 }, { resultBytes: 1 << 20 });
  assert.ok(r.text!.endsWith('r255 two'), r.text!.slice(-40));
  assert.equal(lookBack, 0, `${lookBack} batches read looking back`);
});

test('a hole a scan adds merges with every entry of its reason it overlaps (an independent read of the fixes for the review of the 40 commits, PR #22)', () => {
  // The search spec above passes with the merge into the first entry alone: the journal hands over a page's holes
  // already merged and seats each by its range, and neither that layout nor one with the holes a page apart reached
  // search's own merge. It's pinned here.
  // By the module, not a named import: an older reader.ts without it fails this spec, not the file.
  const { addHole } = reader;
  const gaps: GapInfo[] = [];
  addHole(gaps, { from: 5, to: 5, reason: 'store-error' });
  addHole(gaps, { from: 8, to: 8, reason: 'store-error' });
  addHole(gaps, { from: 20, to: 20, reason: 'retention' });
  addHole(gaps, { from: 4, to: 9, reason: 'store-error', exact: true });
  assert.deepEqual(gaps, [{ from: 4, to: 9, reason: 'store-error' }, { from: 20, to: 20, reason: 'retention' }]);
});

test('a raw page whose retention hole trails every event it holds is that hole\'s note (an independent read of the fixes for the review of 4f4c067..a8b6f28, PR #22)', async () => {
  // A raw read ending inside what retention took holds no event to put the note before: the parts left after the last
  // event are noted after it, and here that is the page.
  const j = new Journal({ sessionId: 's', hot: new MemoryStore(600) });
  const src = source({ journal: j });
  for (let i = 0; i < 60; i++) out(j, `line ${i}\r\n`);
  const r = await readJournal(src, { since: 0, until: 3, as: 'raw', maxBytes: 1 << 20 }, { resultBytes: 1 << 20 });
  assert.equal(r.text, '\n[… 3 journal events missing (seq 1–3: past retention) …]\n');
});
