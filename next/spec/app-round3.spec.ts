/**
 * The house's read of the App in 1cabc6a (PR #22, comment 6261450333): a keyed run after a
 * declared shell ended must not run locally; wait_for's cursor continues from the match; a Run
 * id that is ambiguous is refused; the owner takes the seat with session_open as its run does;
 * a refused declare leaves no shell; a reopen keeps its watch ids; session_list counts the Runs
 * it leaves out; a closed session's history reads at its own width, with the daemon's wrapper cut.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, cutMarkerPlumbing, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { callTool, TOOLS, type ResultText, type ToolResult } from '../src/api/tools.js';
import { validate } from '../src/api/validate.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { until } from './testhost.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-the App read of 1cabc6a-'));
let registry: SessionRegistry;
let app: App;
const A: Caller = { principal: 'agent:a@test', connectionId: 'ca' };
const B: Caller = { principal: 'agent:b@test', connectionId: 'cb' };

async function tool(name: string, args: Record<string, unknown>, caller: Caller = A, mode: ResultText = 'transcript'): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name)!;
  const r = await callTool(name, args, { app, caller, resultText: mode }, TOOLS);
  if (r.isError) assert.equal(r.structured, undefined, `${name}: error results carry no envelope`);
  else if (def.outputSchema) validate(r.structured, def.outputSchema);
  return r;
}

before(() => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  app = new App({ registry, defaultWaitMs: 5000 });
});

after(async () => {
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('defect 1: a keyed run retried after the declared shell ended stays refused — it never runs in the local shell', async () => {
  const s = 'dse';
  const opener = await tool('run', { session: s, command: 'cat', wait: 0 });
  const encl = opener.structured?.runId as string;
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  await until(() => live.session.run(encl).state === 'running', 5000, 'cat is in front');
  await tool('session_declare_shell', { session: s, shell: 'sh' });
  // A command typed to the declared `cat` (not really a shell) just sits there; cancelling it sends ^C,
  // which ends cat too — an end the caller did not ask for, so the declaration fails closed.
  const inner = await tool('run', { session: s, command: 'echo would-run-in-cat', wait: 400 });
  await tool('cancel', { runId: inner.structured?.runId });
  await until(() => live.session.run(encl).state !== 'running', 5000, 'cat ends with the ^C');

  const first = await tool('run', { session: s, command: 'echo ran-in-the-local-shell', idempotencyKey: 'dse-k', wait: 3000 });
  assert.equal(first.structured?.state, 'busy', first.text);
  assert.equal((first.structured?.busy as { reason: string }).reason, 'declared-shell-ended');

  const retried = await tool('run', { session: s, command: 'echo ran-in-the-local-shell', idempotencyKey: 'dse-k', wait: 3000 });
  assert.equal(retried.structured?.state, 'busy', `the retry must not run locally: ${retried.text}`);
  assert.equal((retried.structured?.busy as { reason: string }).reason, 'declared-shell-ended');

  // A fresh key says "the session's own shell is what I mean now": it runs.
  const fresh = await tool('run', { session: s, command: 'echo ran-in-the-local-shell', idempotencyKey: 'dse-k2', wait: 3000 });
  assert.equal(fresh.structured?.state, 'exited', fresh.text);
  assert.match(fresh.structured?.output ? (fresh.structured.output as { text: string }).text : '', /ran-in-the-local-shell/);
});

test('defect 2: wait_for continues from the matching line — a chained wait sees the next line', async () => {
  const s = 'chain';
  await tool('session_open', { session: s });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const since = live.session.journal.lastSeq;
  await tool('run', { session: s, command: "printf 'MATCH\\n'" });
  await tool('run', { session: s, command: "printf 'DONE\\n'" });
  const match = await tool('wait_for', { session: s, pattern: '^MATCH', since, wait: 2000 });
  assert.equal(match.structured?.matched, true, match.text);
  const cursor = match.structured?.nextCursor as number;
  const done = await tool('wait_for', { session: s, pattern: '^DONE', since: cursor, wait: 2000 });
  assert.equal(done.structured?.matched, true, `the next wait must see DONE from the match cursor: ${done.text}`);
});

test('defect 4: the owner takes the seat with session_open role:controller, as its run does; a stranger is refused', async () => {
  const s = 'seat';
  // The owner opens as observer, so the seat is free for B to take.
  await tool('session_open', { session: s, visibility: 'shared', control: 'owner-priority', role: 'observer' });
  const b = await tool('session_open', { session: s, role: 'controller' }, B);
  assert.equal(b.structured?.role, 'controller', b.text);
  const owner = await tool('session_open', { session: s, role: 'controller' }, A);
  assert.equal(owner.structured?.role, 'controller', `the owner takes the held seat over: ${owner.text}`);
  assert.equal((owner.structured?.info as { controller: string }).controller, A.principal);
  const back = await tool('session_open', { session: s, role: 'controller' }, B);
  assert.equal(back.isError, true);
  assert.match(back.text, /^not_controller:/);
});

test('defect 6: a refused session_declare_shell on an unknown name starts no shell', async () => {
  const r = await tool('session_declare_shell', { session: 'ghost', shell: 'none' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /^session_not_found:/);
  assert.equal(registry.get('ghost'), undefined, 'no session was created by the refused declaration');
});

test('defect 8: a reopened session keeps each watch id, so the id the caller holds still unwatches', async () => {
  const s = 'relife';
  await tool('run', { session: s, command: 'echo one' });
  const w = await tool('watch', { session: s, pattern: 'DEPLOYED', label: 'deploy' });
  const watchId = w.structured?.watchId as string;
  await tool('run', { session: s, command: 'exit 7' });
  await until(() => registry.get(s)?.kind === 'live' && (registry.get(s) as { session: { exit?: unknown } }).session.exit !== undefined, 5000, 'shell exits');
  const next = await tool('run', { session: s, command: 'echo two' });
  assert.equal(next.structured?.created, true, 'a new life');
  const list = await tool('watches', { session: s });
  const ids = (list.structured?.watches as Array<{ watchId: string }>).map((x) => x.watchId);
  assert.deepEqual(ids, [watchId], `the watch kept its id across the new life: ${JSON.stringify(ids)}`);
  const rm = await tool('unwatch', { session: s, watchId });
  assert.equal(rm.structured?.removed, true, 'the id the caller holds removes the carried watch');
});

test('defect 9: session_list shows the 20 newest Runs and counts the rest', async () => {
  const s = 'many';
  await tool('session_open', { session: s });
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    const r = await tool('run', { session: s, command: 'sleep 30', target: 'process', wait: 0 });
    ids.push(r.structured?.runId as string);
  }
  const list = await tool('session_list', {});
  const summary = (list.structured?.sessions as Array<Record<string, unknown>>).find((x) => x.id === s)!;
  assert.equal((summary.runs as unknown[]).length, 20, 'the 20 newest');
  assert.equal(summary.runsOmitted, 3, 'the other three are counted, not dropped silently');
  assert.match(list.text, /\(\+3 older not listed\)/);
  for (const id of ids) await tool('cancel', { runId: id });
});

test('defect 11: a closed session’s page is drawn at the width it recorded, not the history default', async () => {
  // 60 columns recorded. 70 W's then a carriage return and an X: at 60 cols the X lands at column 60
  // (the start of the wrapped second row); at the history default 120 it would land at column 0.
  const narrow = 'narrow';
  await tool('session_open', { session: narrow, cols: 60, rows: 24 });
  await tool('run', { session: narrow, command: "printf 'W%.0s' $(seq 1 70); printf '\\rX\\n'" });
  await tool('session_close', { session: narrow });
  const afterClose = registry.get(narrow);
  assert.ok(afterClose?.kind === 'history', 'close left it as history');
  const page = await tool('read', { session: narrow, tail: 6 });
  const xLine = (page.structured?.text as string).split('\n').map((l) => l.replace(/\s+$/, '')).find((l) => /^W*XW*$/.test(l));
  assert.ok(xLine, `a W/X line is present: ${page.text}`);
  assert.equal(xLine.indexOf('X'), 60, `the X sits at column 60 (60-col width), not at the 120-col default: ${JSON.stringify(xLine)}`);
});

test('defect 10: a marker Run read from history has the daemon’s wrapper cut, as the live transcript does', () => {
  // The exact shape a marker-strategy Run leaves in the journal: the echoed wrapper line (ending in the
  // marker’s closing quote), the real output, the resolved end marker, and the next prompt.
  const fromHistory =
    ` command . '/tmp/tsm-501/abc/tsm-cmd-1'; echo "<<<EXI""T:74ef5182:$?>>>"\n` +
    'MARKED-OUTPUT\n' +
    '<<<EXIT:74ef5182:0>>>\n' +
    'bash-3.2$';
  assert.equal(cutMarkerPlumbing(fromHistory), 'MARKED-OUTPUT', 'wrapper, end marker and prompt are cut');
  // A probe line typed after a ^C (the marker split differently) and what follows it go too.
  const withProbe = 'OUT\n echo "<<<EX""IT:74ef5182:$?>>>"\nleftover\n<<<EXIT:74ef5182:130>>>\nbash-3.2$';
  assert.equal(cutMarkerPlumbing(withProbe), 'OUT');
  // Ordinary output with no marker in it is left whole.
  const plain = 'line one\nline two\n';
  assert.equal(cutMarkerPlumbing(plain), plain);
});

test('texts: session and run errors name a next step, and no guarantee label leaks into agent text', async () => {
  // await on a missing run names the next step; read on an unknown session names session_list.
  const missingRun = await tool('await', { runId: 'r1-000000' });
  assert.match(missingRun.text, /^run_not_found: run r1-000000 not found: /);
  const missingSession = await tool('read', { session: 'nope', tail: 1 });
  assert.match(missingSession.text, /^session_not_found: session nope not found: session_list/);
  // The owner-only reopen refusal is seen by someone who can observe (a shared session), and carries no (G30).
  await tool('session_open', { session: 'g30', visibility: 'shared' }, A);
  await tool('run', { session: 'g30', command: 'exit 0' }, A);
  await until(() => registry.get('g30')?.kind === 'live' && (registry.get('g30') as { session: { exit?: unknown } }).session.exit !== undefined, 5000);
  const refused = await tool('run', { session: 'g30', command: 'echo hi' }, B);
  assert.match(refused.text, /only its owner/);
  assert.doesNotMatch(refused.text, /\(G\d+\)/);

  // Defect 12: a shared observer of a *closed* session is not told to use session_open, which would then
  // refuse them: the ended-session message names who can reopen it instead.
  await tool('session_open', { session: 'closed-shared', visibility: 'shared' }, A);
  await tool('session_open', { session: 'closed-shared' }, B);
  await tool('session_close', { session: 'closed-shared' }, A);
  const obsWatch = await tool('watch', { session: 'closed-shared', pattern: 'x' }, B);
  assert.equal(obsWatch.isError, true);
  assert.match(obsWatch.text, /^session_exited:.*only its owner \(agent:a@test\) can start a new shell/);
  assert.doesNotMatch(obsWatch.text, /session_open starts a new shell/);
});

test('a read whose result is never delivered leaves the read cursor where it was (G22): the advance waits for the write', async () => {
  // A connection that drops before the result is written must count nothing read; the cursor advances
  // only when the transport runs the result's onSent (the house's read of 1cabc6a, #22, comment 6263057673).
  const s = 'deliver';
  // B's Run writes output A has not read, in a shared session A may observe.
  await callTool('session_open', { session: s, visibility: 'shared' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  await callTool('run', { session: s, command: 'echo from-B' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const before = live.session.cursorsOf(A.principal).read;
  assert.equal(before, 0, 'A has read nothing yet');
  // A reads over a connection that can drop: deferReadDelivery, as the transport sets it.
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws', deferReadDelivery: true };
  const r = await callTool('read', { session: s, since: 0 }, { app, caller: deferred, resultText: 'transcript' }, TOOLS);
  assert.match(r.text, /from-B/, 'the page carried the output');
  assert.equal(live.session.cursorsOf(A.principal).read, before, 'the result was not delivered: the cursor has not moved');
  assert.equal(typeof r.onSent, 'function');
  r.onSent!(); // the transport wrote the result
  assert.ok(live.session.cursorsOf(A.principal).read > before, 'once delivered, the cursor advances');
});
