/**
 * Reads of one shell Run (`read {runId}`, its pages and its tails) show what the Run's own result
 * shows: the daemon's plumbing in its range cut by the core's one cutter, the typed line's echo, the
 * start and end marks, the prompt after the end and a cancel's probe lines, while the read's cursors and
 * `lines.before` stay journal positions that page on to every line (our read of the house's fixes for
 * its review of f3750e4, PR #22).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJournal, type ReadOptions, type ReadResult, type ReadSource } from '../src/api/reader.js';
import { markerProbe, sourceLine } from '../src/core/plumbing.js';
import type { Journal } from '../src/core/journal.js';
import { out, readAll, source, startRun } from './reader-fixture.spec.js';

const AGENT = 'agent:a@test';
const NONCE = 'ab12cd34';

/**
 * A marker Run (dash, an unknown sh) as the session journals it: the typed line's echo and the start mark in
 * its range, then `body`, then `end`, the end mark and the prompt the shell printed after it, each an event.
 */
function markerRun(j: Journal, body: string[], end: string[] = [`<<<EXIT:${NONCE}:0>>>\r\n$ `]): void {
  j.append({ type: 'output', data: '$ ', stream: 'pty' });
  j.append({ type: 'run.admit', runId: 'r1', target: 'shell', principal: AGENT, origin: 'self', queued: false, line: 'run-it' });
  j.append({ type: 'run.start', runId: 'r1', cwd: '/', line: 'run-it', strategy: 'marker', nonce: NONCE });
  out(j, `${sourceLine('/tmp/tsm-501/ab/tsm-cmd-1', 'posix', NONCE)}\r\n<<<START:${NONCE}:4242>>>\r\n`, 'pty', 'r1');
  for (const b of [...body, ...end]) out(j, b, 'pty', 'r1');
  j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 });
}

/** A declared shell's Run (the inline strategy): its start marker's chunk lies before its range, whose output begins with that line's end and ends with the end mark. */
function inlineRun(j: Journal, body: string): void {
  out(j, `<<<START:${NONCE}:777>>>`);
  j.append({ type: 'run.admit', runId: 'r1', target: 'shell', principal: AGENT, origin: 'self', queued: false, line: 'run-it' });
  j.append({ type: 'run.start', runId: 'r1', cwd: '', line: 'run-it', strategy: 'inline', nonce: NONCE, shellPid: 777 });
  out(j, `\r\n${body}<<<EXIT:${NONCE}:0>>>`, 'pty', 'r1');
  j.append({ type: 'run.end', runId: 'r1', state: 'exited', exit: 0, durationMs: 1 });
}

const plumbing = (t: string) => /<<<|tsm-cmd-|EXI""T|PRO""BE/.test(t);

/** Follow `lines.before` back from a tail of the Run to its first line, as an agent pages back. */
async function pagesBack(src: ReadSource, o: ReadOptions): Promise<ReadResult[]> {
  const pages: ReadResult[] = [];
  let range: { until: number; untilOffset?: number } | undefined;
  for (let step = 0; step < 1000; step++) {
    const r = await readJournal(src, { ...o, ...(range ?? {}) }, { resultBytes: 16384 });
    pages.push(r);
    if (!r.lines?.before) return pages;
    range = r.lines.before;
  }
  assert.fail('following lines.before ends');
}

test('a marker Run read in pages of every size shows its own lines alone, and the pages join to them', async () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(1 + (i % 40))}`);
  for (const maxBytes of [1024, 2048, 16384]) {
    const src = source();
    markerRun(src.journal, lines.map((l) => `${l}\r\n`));
    const { text, pages } = await readAll(src, { runId: 'r1', maxBytes });
    assert.equal(text, lines.join('\n'), `pages of ${maxBytes}`);
    for (const p of pages) assert.ok(!plumbing(p.text ?? ''), `no plumbing on a page of ${maxBytes}: ${JSON.stringify(p.text?.slice(0, 80))}`);
  }
});

test('an end mark that a page ends inside, after a last line with no newline, is cut whole: no fragment of it on either page', async () => {
  // The line and the mark in one event, longer than a page: the page cuts fall at its budget, some inside the mark.
  for (let n = 1925; n < 1955; n++) {
    const src = source();
    const long = 'z'.repeat(n);
    markerRun(src.journal, ['first\r\n'], [`${long}<<<EXIT:${NONCE}:0>>>\r\n$ `]);
    const { text, pages } = await readAll(src, { runId: 'r1', maxBytes: 1024 });
    assert.ok(pages.length > 2, `the long line is split across pages: ${pages.length}`);
    assert.equal(text, `first\n${long}`, `a line of ${n}`);
  }
});

test('an end mark split across two events, where a page stops between them, is cut whole on both pages', async () => {
  // A page examines at most 20,000 events: the head's event, 19,998 of the body, then the mark's first half.
  const src = source();
  const body = Array.from({ length: 19_998 }, (_, i) => `${i}\r\n`);
  markerRun(src.journal, body, [`tail-end<<<EX`, `IT:${NONCE}:0>>>\r\n$ `]);
  const { text, pages } = await readAll(src, { runId: 'r1', maxBytes: 1024 * 1024 });
  assert.equal(pages.length, 2, 'the scan bound ends the first page between the halves');
  assert.ok(pages[0]!.text!.endsWith('tail-end'), JSON.stringify(pages[0]!.text!.slice(-20)));
  assert.equal(text, [...body.map((l) => l.trim()), 'tail-end'].join('\n'));
});

test('a page read from after the end mark holds nothing of the Run: the prompt the shell printed after it is not the Run’s', async () => {
  const src = source();
  markerRun(src.journal, ['out\r\n'], [`<<<EXIT:${NONCE}:0>>>\r\n`, 'prompt$ ']);
  const prompt = src.journal.lastSeq - 1;
  const page = await readJournal(src, { runId: 'r1', since: prompt - 1 }, { resultBytes: 16384 });
  assert.equal(page.text, '', JSON.stringify(page.text));
  assert.equal((await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 })).text, 'out');
});

test('a tail of a marker Run shows its last lines without the end mark, and paging back by lines.before reaches every line once and no plumbing', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `row ${i}`);
  const src = source();
  // Several lines per event, so the cut and where the lines shown begin fall inside events.
  const body: string[] = [];
  for (let i = 0; i < lines.length; i += 3) body.push(lines.slice(i, i + 3).map((l) => `${l}\r\n`).join(''));
  markerRun(src.journal, body);
  const last = await readJournal(src, { runId: 'r1', tail: 3 }, { resultBytes: 16384 });
  assert.equal(last.text, lines.slice(-3).join('\n'));
  for (const tail of [1, 2, 5]) {
    const pages = await pagesBack(src, { runId: 'r1', tail });
    // Oldest page first: the pages join to the Run's lines, each once and in order. A set of them, sorted, let a
    // page repeated or out of order pass (our read of the 40 commits, PR #22).
    const seen = [...pages].reverse().flatMap((p) => (p.text ? p.text.split('\n') : []));
    assert.ok(!seen.some(plumbing), `tail ${tail}: ${JSON.stringify(seen.filter(plumbing))}`);
    assert.deepEqual(seen, lines, `tail ${tail}: every line once, in order, and nothing else`);
  }
});

test('a declared shell’s Run reads without its end mark, and a page that begins with a blank line keeps it', async () => {
  const src = source();
  const body = Array.from({ length: 62 }, (_, i) => (i % 7 === 3 ? '' : `l${i} ${'y'.repeat(30)}`));
  inlineRun(src.journal, body.map((l) => `${l}\r\n`).join(''));
  assert.equal((await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 })).text, body.join('\n'));
  for (const maxBytes of [1024, 1500]) {
    const { text, pages } = await readAll(src, { runId: 'r1', maxBytes });
    assert.ok(pages.length > 1);
    assert.equal(text, body.join('\n'), `pages of ${maxBytes}`);
  }
  const tail = await readJournal(src, { runId: 'r1', tail: 2 }, { resultBytes: 16384 });
  assert.equal(tail.text, body.slice(-2).join('\n'));
});

test('a cancelled marker Run reads without the probe line its cancel typed or the answer that ended it', async () => {
  const src = source();
  markerRun(src.journal, ['working\r\n', '^C\r\n'], [`$${markerProbe(NONCE)}\r\n<<<PROBE:${NONCE}>>>\r\n$ `]);
  assert.equal((await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 })).text, 'working\n^C');
  assert.equal((await readJournal(src, { runId: 'r1', tail: 5 }, { resultBytes: 16384 })).text, 'working\n^C');
});

test('a raw read of a marker Run, paged by events, joins to its own output with its escape codes, the plumbing cut even where a page falls between a mark’s halves (an independent read of the fixes for the review of f3750e4, PR #22)', async () => {
  // The compat pack's raw output ran its own cutter over the whole Run; it reads these pages now.
  const body = ['\x1b[1mbold\x1b[0m\r\n', 'two\r\n', 'no-newline'];
  for (const limit of [1, 2, 3, 2000]) {
    const src = source();
    markerRun(src.journal, body, [`<<<EX`, `IT:${NONCE}:0>>>\r\n$ `]);
    let text = '';
    let since: number | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const r = await readJournal(src, { runId: 'r1', as: 'raw', limit, ...(since !== undefined ? { since } : {}) }, { resultBytes: 16384 });
      text += r.text ?? '';
      if (!r.more) break;
      since = r.nextCursor;
    }
    assert.equal(text, body.join(''), `pages of ${limit} events`);
  }
  // A process Run's raw output is its data as written.
  const src = source();
  startRun(src.journal, 'p1');
  out(src.journal, '\x1b[31mred\x1b[0m\n<<<EXIT:x:0>>>\n', 'stdout', 'p1');
  assert.equal((await readJournal(src, { runId: 'p1', as: 'raw' }, { resultBytes: 16384 })).text, '\x1b[31mred\x1b[0m\n<<<EXIT:x:0>>>\n');
  await assert.rejects(readJournal(src, { runId: 'p1', as: 'raw', tail: 2 }, { resultBytes: 16384 }), /raw read pages head first/);
});

test('a raw page puts each hole’s note on a line of its own where the hole lies, as a text page does (an independent read of the fixes for the review of f3750e4, PR #22)', async () => {
  const src = source();
  startRun(src.journal, 'p1');
  out(src.journal, 'one\nhalf', 'stdout', 'p1');
  const hole = src.journal.lastSeq + 1;
  src.journal.append({ type: 'gap', from: hole, to: hole, reason: 'torn-write' });
  out(src.journal, 'two\n', 'stdout', 'p1');
  const note = `[… up to 1 journal event missing (seq ${hole}–${hole}: a crash cut the journal short) …]`;
  assert.equal((await readJournal(src, { runId: 'p1', as: 'raw' }, { resultBytes: 16384 })).text, `one\nhalf\n${note}\ntwo\n`);
  // A page that begins with the hole puts a line end before its note: the page before may have ended mid-line.
  const from = await readJournal(src, { runId: 'p1', as: 'raw', since: hole - 1 }, { resultBytes: 16384 });
  assert.equal(from.text, `\n${note}\ntwo\n`);
});

test('a read of the session still shows everything the terminal showed, plumbing included', async () => {
  const src = source();
  markerRun(src.journal, ['out\r\n']);
  const page = await readJournal(src, { since: 0 }, { resultBytes: 16384 });
  assert.ok(page.text?.includes(`<<<EXIT:${NONCE}:0>>>`), JSON.stringify(page.text));
});

test("a page that ends inside a cancel's probe echo that came a character at a time strikes all of it (our read of the 40 commits, PR #22)", async () => {
  // The cutter saw 32 events past a page's end: the echo's rest, in more events than that, was not there to tell
  // it from output, and the page showed the echo's head.
  const probe = `${markerProbe(NONCE)}\r\n`;
  const src = source();
  markerRun(src.journal, ['abc\r\n', ...probe.split(''), 'def\r\n']);
  const whole = await readJournal(src, { runId: 'r1' }, { resultBytes: 16384 });
  assert.equal(whole.text, 'abc\ndef');
  const abc = src.journal.tail(10_000).find((e) => e.type === 'output' && e.data === 'abc\r\n')!.seq;
  for (const k of [1, 5, 10, 20]) {
    const page = await readJournal(src, { runId: 'r1', until: abc + k }, { resultBytes: 16384 });
    assert.equal(page.text, 'abc', `ending ${k} characters into the echo: ${JSON.stringify(page.text)}`);
  }
});
