/**
 * The tool surface without a shell behind it (the house's read of 1cabc6a, #22): a search's
 * status line says what the scan skipped, the validator's checks each refuse what they are
 * for and name the declared parameters, reserved names are refused wherever they sit, the
 * compat `takeScreenshot` honours json mode, and `watch` says when notifications cannot arrive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App, Caller, SearchResult } from '../src/api/app.js';
import { callTool, TOOLS, type ResultText } from '../src/api/tools.js';
import { validate, ValidationError, type Schema } from '../src/api/validate.js';

const A: Caller = { principal: 'agent:a@test', connectionId: 'ct' };
/** An App with only the methods a tool calls. */
const stub = (methods: Record<string, unknown> = {}) => methods as unknown as App;
const ctx = (app: App, resultText: ResultText = 'transcript', notifications?: boolean) => ({ app, caller: A, resultText, ...(notifications === undefined ? {} : { notifications }) });

test('search: the status line names the gap the scan spanned and the lines it searched on their head only', async () => {
  const r: SearchResult = { session: 's', matches: [], scanned: [1, 4], more: false, bounded: false, gap: { from: 2, to: 40, reason: 'retention' }, clippedLines: 1 };
  const search = async (res: SearchResult, mode: ResultText = 'transcript') => callTool('search', { session: 's', pattern: 'needle' }, ctx(stub({ search: async () => res }), mode), TOOLS);
  const one = await search(r);
  assert.equal(one.text, '(no matches)\n[search s · 0 matches · scanned seq 1–4 · gap 2–40 not retained · 1 line longer than the match window, searched on its head only]');
  const several: SearchResult = { session: 's', matches: [], scanned: [1, 9], more: false, bounded: false, gaps: [{ from: 2, to: 3, reason: 'store-error' }, { from: 5, to: 5 }], clippedLines: 3 };
  assert.match((await search(several)).text, /scanned seq 1–9 · 2 gaps: gap 2–3 missing \(store-error\), gap 5–5 not retained · 3 lines longer than the match window, searched on their head only\]$/);
  const clean = await search({ session: 's', matches: [], scanned: [1, 4], more: false, bounded: false });
  assert.equal(clean.text, '(no matches)\n[search s · 0 matches · scanned seq 1–4]');
  assert.equal((JSON.parse((await search(r, 'json')).text) as SearchResult).clippedLines, 1, 'json mode is the envelope');
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
