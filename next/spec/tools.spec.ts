/**
 * The tool surface without a shell behind it (the house's read of 1cabc6a, #22): a search's
 * status line says what the scan skipped, the validator's checks each refuse what they are
 * for and name the declared parameters, reserved names are refused wherever they sit, the
 * compat `takeScreenshot` honours json mode, `watch` says when notifications cannot arrive, and a
 * tail's status line names the reads of what came before and of a cut line's head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App, Caller, ReadResult, SearchResult, SessionSummary } from '../src/api/app.js';
import { describeGap } from '../src/api/reader.js';
import { callTool, renderRead, TOOLS, type ResultText } from '../src/api/tools.js';
import { validate, ValidationError, type Schema } from '../src/api/validate.js';
import type { GapReason } from '../src/core/types.js';

const A: Caller = { principal: 'agent:a@test', connectionId: 'ct' };
/** An App with only the methods a tool calls. */
const stub = (methods: Record<string, unknown> = {}) => methods as unknown as App;
const ctx = (app: App, resultText: ResultText = 'transcript', notifications?: boolean) => ({ app, caller: A, resultText, ...(notifications === undefined ? {} : { notifications }) });

test('search: the status line names the gap the scan spanned and the lines it searched on their head only', async () => {
  const r: SearchResult = { session: 's', matches: [], scanned: [1, 4], more: false, bounded: false, gap: { from: 2, to: 40, reason: 'retention' }, clippedLines: 1 };
  const search = async (res: SearchResult, mode: ResultText = 'transcript') => callTool('search', { session: 's', pattern: 'needle' }, ctx(stub({ search: async () => res }), mode), TOOLS);
  const one = await search(r);
  assert.equal(one.text, '(no matches)\n[search s · 0 matches · scanned seq 1–4 · gap 2–40 (past retention) · 1 line longer than the match window, searched on its head only]');
  const several: SearchResult = { session: 's', matches: [], scanned: [1, 9], more: false, bounded: false, gaps: [{ from: 2, to: 3, reason: 'store-error' }, { from: 5, to: 5, reason: 'retention' }], clippedLines: 3 };
  assert.match((await search(several)).text, /scanned seq 1–9 · 2 gaps: gap 2–3 \(the journal store failed\), gap 5–5 \(past retention\) · 3 lines longer than the match window, searched on their head only\]$/);
  const clean = await search({ session: 's', matches: [], scanned: [1, 4], more: false, bounded: false });
  assert.equal(clean.text, '(no matches)\n[search s · 0 matches · scanned seq 1–4]');
  assert.equal((JSON.parse((await search(r, 'json')).text) as SearchResult).clippedLines, 1, 'json mode is the envelope');
});

test('wait_for: a match on a clipped line is said in the text, as search’s status says it, and the schema declares clipped', async () => {
  // Only `--json` showed `clipped` (the house's read of the 38 commits, #22 comment 6274806357).
  const wait = async (r: Record<string, unknown>, mode: ResultText = 'transcript') => callTool('wait_for', { session: 's', pattern: 'head' }, ctx(stub({ waitFor: async () => r }), mode), TOOLS);
  const clipped = { session: 's', matched: true, kind: 'pattern', line: 'head of a long line', seq: 7, elapsedMs: 12, nextCursor: 8, clipped: true };
  const out = await wait(clipped);
  assert.equal(out.text, '[pattern matched after 12ms: head of a long line · seq 7 · the line is longer than the match window: matched on its head only]');
  validate(out.structured, TOOLS.find((t) => t.name === 'wait_for')!.outputSchema!);
  const whole = await wait({ session: 's', matched: true, kind: 'pattern', line: 'a short line', seq: 7, elapsedMs: 12, nextCursor: 8 });
  assert.equal(whole.text, '[pattern matched after 12ms: a short line · seq 7]');
  assert.equal((JSON.parse((await wait(clipped, 'json')).text) as { clipped?: boolean }).clipped, true, 'json mode is the envelope');
});

test('a hole is worded once: read’s status line says of it what the text’s gap line says, for every reason the journal records', async () => {
  const reasons: GapReason[] = ['retention', 'keeper-overflow', 'torn-write', 'store-error', 'store-failed'];
  for (const reason of reasons) {
    const why = describeGap(reason);
    assert.notEqual(why, 'lost', reason);
    const r: ReadResult = { session: 's', seq: [1, 9], nextCursor: 9, more: false, truncated: false, text: `[… 3 journal events missing (seq 4–6: ${why}) …]`, gap: { from: 4, to: 6, reason } };
    const out = await callTool('read', { session: 's', since: 0 }, ctx(stub({ read: async () => r })), TOOLS);
    assert.ok(out.text.endsWith(` · gap 4–6 (${why})]`), out.text);
    validate(out.structured, TOOLS.find((t) => t.name === 'read')!.outputSchema!);
  }
});

test('the session_list schema declares every field a summary may carry, services’ evidence included', () => {
  const full: Required<SessionSummary> = {
    id: 's', owner: 'agent:a@test', visibility: 'private', state: 'idle', controller: null, cwd: '/', integration: 'rich', backend: 'node-pty', pid: 1, currentRun: null, lastSeq: 9, oldestSeq: 1,
    retention: { maxBytes: 1 << 20 }, pendingRetention: { maxAgeMs: 1000 }, recovered: 'continuous', closed: false, createdAt: 0, lastActivity: 0, declared: { shell: 'sh', within: null }, cols: 80, rows: 24,
    services: [{ runId: 'r1', name: 'svc', status: 'ready', evidence: 'listening' }], servicesOmitted: 0, watches: 1, runs: [{ runId: 'r1', target: 'shell', state: 'running', principal: 'agent:a@test', line: 'x', admittedAt: 0 }], runsOmitted: 0,
  };
  const schema = TOOLS.find((t) => t.name === 'session_list')!.outputSchema!;
  validate({ sessions: [full] }, schema);
  const summary = (schema.properties!.sessions as Schema).items!;
  assert.deepEqual(Object.keys(full).filter((k) => !(k in summary.properties!)), [], 'a summary field the schema does not name');
  const service = (summary.properties!.services as Schema).items!.properties!;
  assert.deepEqual(Object.keys(full.services[0]!).filter((k) => !(k in service)), [], 'a service field the schema does not name');
});

test('the validator refuses what each check is for: enum, minLength, integer, minimum, maximum, boolean, array, items', () => {
  const bad = (value: unknown, schema: Schema, re: RegExp) => assert.throws(() => validate(value, schema), (e: unknown) => e instanceof ValidationError && re.test(e.message), JSON.stringify(value));
  bad('c', { type: 'string', enum: ['a', 'b'] }, /must be one of a, b/);
  bad('', { type: 'string', minLength: 1 }, /at least 1 character/);
  bad(1.5, { type: 'integer' }, /must be an integer/);
  bad(0, { type: 'integer', minimum: 1 }, /must be >= 1/);
  bad(6, { type: 'integer', maximum: 5 }, /must be <= 5/);
  bad('yes', { type: 'boolean' }, /must be a boolean/);
  bad('a', { type: 'array', items: { type: 'string' } }, /must be an array/);
  bad(['a', 1], { type: 'array', items: { type: 'string' } }, /\[1\]: must be a string/);
  validate(['a'], { type: 'array', items: { type: 'string' } });
  validate(1, { type: 'integer', minimum: 1, maximum: 5 });
});

test('an unknown parameter is answered with the close declared names, or with all of them', async () => {
  const call = (name: string, args: Record<string, unknown>) => callTool(name, args, ctx(stub()), TOOLS);
  const typo = await call('run', { session: 's', command: 'x', wiat: 1 });
  assert.equal(typo.isError, true);
  assert.equal(typo.text, 'invalid_argument: .wiat: is not a known parameter; did you mean `wait`?');
  assert.match((await call('read', { session: 's', sinse: 3 })).text, /did you mean `since`\?/);
  assert.match((await call('screen', { session: 's', bogus: 1 })).text, /\.bogus: is not a known parameter; the parameters are session$/);
  assert.match((await call('session_list', { x: 1 })).text, /is not a known parameter; this tool takes none$/);
});

test('reserved names are refused inside values the schema does not describe', () => {
  const def = TOOLS.find((t) => t.name === 'takeScreenshot')!;
  assert.throws(() => validate(JSON.parse('{"session":"s","extra":{"__proto__":{"x":1},"constructor":2}}'), def.inputSchema), /\.extra\.__proto__: is a reserved name/);
  assert.throws(() => validate(JSON.parse('{"session":"s","list":[{"prototype":1}]}'), def.inputSchema), /\.list\[0\]\.prototype: is a reserved name/);
  assert.throws(() => validate(JSON.parse('{"constructor":1}'), { type: 'object', properties: { constructor: {} } }), /is a reserved name/, 'a declared property without a type');
  validate(JSON.parse('{"session":"s","extra":{"fine":[1,{"ok":true}]}}'), def.inputSchema);
});

test('compat takeScreenshot: in json mode the text is the envelope, parseable; in transcript mode the screen', async () => {
  const screen = { cols: 80, rows: 24, alt: false, cursor: { x: 0, y: 1 }, lines: ['$ ls', 'a  b', '', ''], title: '', seq: 3 };
  const call = (mode: ResultText) => callTool('takeScreenshot', { session: 's' }, ctx(stub({ screen: async () => screen }), mode), TOOLS);
  const j = await call('json');
  const parsed = JSON.parse(j.text) as { success: boolean; text: string; cols: number };
  assert.equal(parsed.success, true);
  assert.equal(parsed.text, '$ ls\na  b');
  assert.equal(parsed.cols, 80);
  assert.equal((await call('transcript')).text, '$ ls\na  b');
});

test('watch says when this connection cannot receive notifications', async () => {
  const info = { watchId: 'w1', kind: 'pattern', label: 'w1', owner: A.principal, spec: { pattern: 'x' }, createdAt: 0, fired: 0 };
  const call = (notifications?: boolean) => callTool('watch', { session: 's', pattern: 'x' }, ctx(stub({ watch: async () => info }), 'transcript', notifications), TOOLS);
  assert.match((await call(false)).text, /\[watch w1 "w1" armed \(pattern\) — this connection cannot receive notifications: poll `watches` or use `wait_for`\]/);
  assert.doesNotMatch((await call(true)).text, /cannot receive/);
  assert.doesNotMatch((await call()).text, /cannot receive/);
});

test('renderRead: a tail marks a first line cut at its head, with the read from its head, and the read of what came before, every argument given', () => {
  // The house's read of the 38 commits (#22, comment 6274935728): neither mark had a test, and nothing called renderRead directly.
  const base: ReadResult = { session: 's', seq: [7, 9], nextCursor: 9, more: false, truncated: true, text: 'xyz' };
  const cut = renderRead({ ...base, lines: { requested: 2, returned: 1, cutHead: true, head: { since: 6, offset: 12 }, before: { until: 7, untilOffset: 12 } } }, 'transcript');
  assert.equal(cut.text, 'xyz\n[read s seq 7–9 · 1 of 2 lines (the first cut at its head; from its head: read since=6 offset=12) · earlier: read tail=2 until=7 untilOffset=12 · next: since=9 · truncated]');
  const whole = renderRead({ ...base, truncated: false, lines: { requested: 3, returned: 3, before: { until: 6 } } }, 'transcript');
  assert.equal(whole.text, 'xyz\n[read s seq 7–9 · 3 of 3 lines · earlier: read tail=3 until=6 · next: since=9]');
  const first = renderRead({ ...base, truncated: false, lines: { requested: 5, returned: 2 } }, 'transcript');
  assert.equal(first.text, 'xyz\n[read s seq 7–9 · 2 of 5 lines · next: since=9]', 'nothing came before: no earlier read');
  const headOnly = renderRead({ ...base, lines: { requested: 1, returned: 1, cutHead: true, head: { since: 0 } } }, 'transcript');
  assert.match(headOnly.text, / · 1 of 1 lines \(the first cut at its head; from its head: read since=0\) · next: since=9 · truncated\]$/);
  for (const r of [cut, whole, first, headOnly]) validate(r.structured, TOOLS.find((t) => t.name === 'read')!.outputSchema!);
  assert.deepEqual((JSON.parse(renderRead({ ...base, lines: { requested: 2, returned: 1, before: { until: 7, untilOffset: 12 } } }, 'json').text) as ReadResult).lines!.before, { until: 7, untilOffset: 12 });
});

test('renderRead: an events tail counts events on its status line, not lines (our read of the 40 commits, PR #22)', () => {
  const r: ReadResult = { session: 's', seq: [7, 9], nextCursor: 9, more: false, truncated: false, events: [], lines: { requested: 5, returned: 3 } };
  assert.match(renderRead(r, 'transcript').text, / · 3 of 5 events · /);
  const text: ReadResult = { session: 's', seq: [7, 9], nextCursor: 9, more: false, truncated: false, text: 'a', lines: { requested: 5, returned: 3 } };
  assert.match(renderRead(text, 'transcript').text, / · 3 of 5 lines · /);
});

test('renderRead: a Run tail’s advice names the Run and the tail’s since, and a line begun before the page is read on from where the earlier page ends', () => {
  // A reviewer's read of the fixes for #22: the marks left out runId and since, so following a Run tail's
  // `earlier` or `from its head` advice read the session, and an earlier page left the tail's range; and
  // `head` promised the line's head for a line begun before the window, whose head-first read starts mid-line.
  const base: ReadResult = { session: 's', runId: 'r1-ab', seq: [7, 9], nextCursor: 9, more: false, truncated: true, text: 'xyz' };
  const lines = { requested: 2, returned: 1, cutHead: true as const, head: { since: 6, offset: 12 }, before: { until: 7, untilOffset: 12 } };
  const run = renderRead({ ...base, lines }, 'transcript', { since: 3 });
  assert.equal(run.text, 'xyz\n[read s run r1-ab seq 7–9 · 1 of 2 lines (the first cut at its head; from its head: read since=6 offset=12 runId=r1-ab) · earlier: read tail=2 until=7 untilOffset=12 since=3 runId=r1-ab · next: since=9 · truncated]');
  const { runId: _, ...session } = base;
  const begun = renderRead({ ...session, lines: { ...lines, begunBefore: true, head: { since: 6 }, before: { until: 6 } } }, 'transcript');
  assert.equal(begun.text, 'xyz\n[read s seq 7–9 · 1 of 2 lines (the first cut at its head, begun before this page; on from where the earlier page ends: read since=6) · earlier: read tail=2 until=6 · next: since=9 · truncated]');
  // A head-first page of a Run with more after it, inside `until`: reading on keeps both.
  const page = renderRead({ ...base, truncated: false, more: true }, 'transcript', { since: 3, until: 40 });
  assert.equal(page.text, 'xyz\n[read s run r1-ab seq 7–9 · next: since=9 · more: read since=9 until=40 runId=r1-ab]');
  for (const r of [run, begun, page]) validate(r.structured, TOOLS.find((t) => t.name === 'read')!.outputSchema!);
});

// ───────────── the house's read of the 33 commits (#22, comment 6307350650) ─────────────

test('the 33 commits 3: read’s description says to pass lines.before’s until and untilOffset, which read takes, not lines.before itself', () => {
  const read = TOOLS.find((t) => t.name === 'read')!;
  assert.doesNotMatch(read.description, /lines\.before`, passed/, 'read has no argument that takes lines.before whole');
  assert.match(read.description, /`lines\.before\.until` as `until`, and its `lines\.before\.untilOffset`, when given, as `untilOffset`, with the same tail/);
  const props = (read.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.equal(props.before, undefined);
  assert.match(props.untilOffset!.description!, /lines\.before\.untilOffset/);
});

test('the 33 commits 8: the read tool hands the request’s range to the status line, so its advice keeps since, until and the Run', async () => {
  // The advice tests called renderRead with a range directly; dropping it at the tool's call site left every test green.
  const asked: Array<Record<string, unknown>> = [];
  const read = (r: ReadResult) => async (_c: Caller, o: Record<string, unknown>) => {
    asked.push(o);
    return r;
  };
  const base: ReadResult = { session: 's', runId: 'r1-ab', seq: [7, 9], nextCursor: 9, more: false, truncated: false, text: 'xyz' };
  const tail = await callTool('read', { session: 's', runId: 'r1-ab', tail: 2, since: 3 }, ctx(stub({ read: read({ ...base, lines: { requested: 2, returned: 2, before: { until: 7, untilOffset: 12 } } }) })), TOOLS);
  assert.equal(tail.text, 'xyz\n[read s run r1-ab seq 7–9 · 2 of 2 lines · earlier: read tail=2 until=7 untilOffset=12 since=3 runId=r1-ab · next: since=9]');
  const page = await callTool('read', { session: 's', runId: 'r1-ab', since: 3, until: 40 }, ctx(stub({ read: read({ ...base, more: true }) })), TOOLS);
  assert.equal(page.text, 'xyz\n[read s run r1-ab seq 7–9 · next: since=9 · more: read since=9 until=40 runId=r1-ab]');
  assert.deepEqual(asked.map((o) => [o.since, o.until, o.tail, o.runId]), [[3, undefined, 2, 'r1-ab'], [3, 40, undefined, 'r1-ab']]);
});

test('read’s status says when a tail reached back past the lines asked for, to the line written last', () => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650): "3 of 1 lines" said nothing of why.
  const base: ReadResult = { session: 's', seq: [3, 4], nextCursor: 4, more: false, truncated: false, text: '[run r1]\nr1 line\n[terminal]\nPTY-UNFIN' };
  const r = renderRead({ ...base, lines: { requested: 1, returned: 2, before: { until: 3, untilOffset: 8 } } }, 'transcript');
  assert.match(r.text, / · 2 of 1 lines, back to the line written last · earlier: read tail=1 until=3 untilOffset=8 · next: since=4\]$/);
  assert.doesNotMatch(renderRead({ ...base, lines: { requested: 2, returned: 2 } }, 'transcript').text, /back to/);
});

test("search and wait_for name a process Run line's pipe, and `mixed` when it holds both, in their text (an independent read of the fixes for the review of the 40 commits, PR #22)", async () => {
  const search = async (res: SearchResult) => callTool('search', { session: 's', pattern: 'x' }, ctx(stub({ search: async () => res })), TOOLS);
  const hit = (line: string, cursor: number, more: Record<string, unknown> = {}) => ({ seq: cursor + 1, lineNumber: 1, line, before: [], after: [], cursor, ...more });
  const r = { session: 's', matches: [hit('both', 7, { stream: 'stderr', mixed: true }), hit('out', 9, { stream: 'stdout' }), hit('pty', 11)], scanned: [1, 12], more: false, bounded: false } as SearchResult;
  const lines = (await search(r)).text.split('\n').filter((l) => l.startsWith('> '));
  assert.deepEqual(lines, ['> both   [stderr · mixed · read since=7]', '> out   [stdout · read since=9]', '> pty   [read since=11]']);
  const wait = async (w: Record<string, unknown>) => (await callTool('wait_for', { session: 's', pattern: 'x' }, ctx(stub({ waitFor: async () => w })), TOOLS)).text;
  const base = { session: 's', matched: true, kind: 'pattern', line: 'boom', seq: 7, elapsedMs: 12, nextCursor: 8 };
  assert.equal(await wait({ ...base, stream: 'stderr', mixed: true }), '[pattern matched after 12ms: boom · stderr · mixed · seq 7]');
  assert.equal(await wait({ ...base, stream: 'stdout' }), '[pattern matched after 12ms: boom · stdout · seq 7]');
  assert.equal(await wait(base), '[pattern matched after 12ms: boom · seq 7]');
});
