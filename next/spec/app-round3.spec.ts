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
import { App, commitReadDelivery, takeReadCommit, type Caller, type RunResult } from '../src/api/app.js';
import { clocks } from '../src/core/clock.js';
import { cutPlumbing } from '../src/core/plumbing.js';
import { serviceOutcomeKey } from '../src/core/session.js';
import { SessionRegistry } from '../src/api/registry.js';
import { callTool, TOOLS, type ResultText, type ToolResult } from '../src/api/tools.js';
import { validate } from '../src/api/validate.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { until } from './testhost.js';
import { fakeShellBackend } from './fake-shell.js';

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
  assert.deepEqual((summary.runs as Array<{ runId: string }>).map((x) => x.runId), ids.slice(-20), 'the last 20 admitted, in order');
  assert.equal(summary.runsOmitted, 3, 'the other three are counted, not dropped silently');
  assert.match(list.text, /\(\+3 older not listed\)/);
  for (const id of ids) await tool('cancel', { runId: id });
});

test('session_list shows the 20 newest services and counts the rest (the house\'s read of the 36 commits, #22, comment 6269992150)', async () => {
  const s = 'manysvc';
  await tool('session_open', { session: s });
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    // A readiness pattern that never matches keeps each service in `starting` with no polling; the
    // process stays alive, so the monitor is retained. ServiceManager grows without bound before the fix.
    const r = await tool('start', { session: s, command: 'sleep 30', target: 'process', ready: { pattern: 'never-matches-xyz' }, wait: 0 });
    ids.push(r.structured?.runId as string);
  }
  const list = await tool('session_list', {});
  const summary = (list.structured?.sessions as Array<Record<string, unknown>>).find((x) => x.id === s)!;
  assert.equal((summary.services as unknown[]).length, 20, 'the 20 newest');
  // The newest by id, not any 20: returning the oldest 20 passed a count (the house's read of the 38 commits, #22, comment 6274935728).
  assert.deepEqual((summary.services as Array<{ runId: string }>).map((x) => x.runId), ids.slice(-20), 'the last 20 started, in order');
  assert.equal(summary.servicesOmitted, 3, 'the other three are counted, not dropped silently');
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
  assert.equal(cutPlumbing(fromHistory), 'MARKED-OUTPUT\n', 'wrapper, end marker and prompt are cut');
  // The end-marker probe typed after a ^C (its own mark, split in the echo), its answer and what follows
  // the answer go too. Output between the echo and the answer is the program's (its last words, flushed
  // after the probe was typed ahead) and stays (the house's read of 78c4d6e, #22: the cut from the echo lost it).
  const withProbe = 'OUT\n echo "<<<PRO""BE:74ef5182>>>"\nleftover\n<<<PROBE:74ef5182>>>\n<<<EXIT:74ef5182:130>>>\nbash-3.2$';
  assert.equal(cutPlumbing(withProbe), 'OUT\nleftover\n');
  // Ordinary output with no marker in it is left whole.
  const plain = 'line one\nline two\n';
  assert.equal(cutPlumbing(plain), plain);
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

test('a Run of an earlier life, awaited on the new life, moves the read cursor by the one rule run and read follow: not past another Run’s unread output', async () => {
  const s = 'oldlife';
  const r1 = await app.run(A, { session: s, command: 'echo one', wait: 5000 });
  assert.equal(r1.state, 'exited');
  // r2's output comes after its own result returned, and no transport ever marks its outcome delivered: unread by A.
  const r2 = await app.run(A, { session: s, command: 'sleep 0.3; echo two', wait: 0 });
  assert.ok(r2.runId !== undefined && (r2.state === 'starting' || r2.state === 'running'), r2.state);
  const r3 = await app.run(A, { session: s, command: 'echo three', wait: 5000, queue: true });
  assert.equal(r3.state, 'exited');
  const life1 = registry.get(s);
  assert.ok(life1?.kind === 'live');
  const twoAt = life1.session.runOutput(r2.runId).events.find((e) => e.type === 'output')!.seq;
  const cursor = life1.session.cursorsOf(A.principal).read;
  assert.equal(cursor, twoAt - 1, 'the live rule: r3’s result left the cursor before r2’s unread output');
  // The shell ends and the name starts a new life: r3 is a Run of the earlier life now, answered from the journal.
  await app.sessionClose(A, { session: s });
  await app.sessionOpen(A, { id: s });
  const life2 = registry.get(s);
  assert.ok(life2?.kind === 'live' && life2.session !== life1.session);
  assert.equal(life2.session.cursorsOf(A.principal).read, cursor, 'the cursor came over to the new life');
  const again = await app.awaitRun(A, { session: s, runId: r3.runId!, wait: 1000 });
  assert.equal(again.state, 'exited');
  assert.match(again.output.text, /three/);
  assert.equal(life2.session.cursorsOf(A.principal).read, cursor, 'r2’s output is still unread: the earlier life’s Run did not move the cursor past it');
  // Reading r2 bridges to r3, whose result was already delivered before this same-daemon reopen.
  const rd = await app.read(A, { session: s, runId: r2.runId });
  assert.ok(rd.nextCursor < r3.output.nextCursor, 'r3’s already-delivered output is above r2');
  assert.equal(life2.session.cursorsOf(A.principal).read, r3.output.nextCursor);
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

// ───────────── the house's read of 78c4d6e (#22): the read cursor ─────────────

test('78c4d6e 6: two deferred results outstanding at once leave the cursor at the later Run’s end, not frozen below it', async () => {
  // B runs X then Y in a shared session; a deferred A reads each by its runId. Staged together and
  // then committed together, A ends at Y's end — the target is decided at the commit, not when the
  // result was staged, where each froze a target below the other's unread output.
  const s = 'two-deferred';
  await callTool('session_open', { session: s, visibility: 'shared' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  const x = await app.run(B, { session: s, command: 'echo X', wait: 5000 });
  const y = await app.run(B, { session: s, command: 'echo Y', wait: 5000 });
  assert.equal(x.state, 'exited');
  assert.equal(y.state, 'exited');
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  assert.equal(live.session.cursorsOf(A.principal).read, 0, 'A has read nothing');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws6', deferReadDelivery: true };
  const rx = await app.read(deferred, { session: s, runId: x.runId! });
  const ry = await app.read(deferred, { session: s, runId: y.runId! });
  assert.match(rx.text!, /X/);
  assert.match(ry.text!, /Y/);
  assert.equal(live.session.cursorsOf(A.principal).read, 0, 'both staged, nothing committed yet');
  commitReadDelivery(rx);
  assert.ok(live.session.cursorsOf(A.principal).read < ry.nextCursor, 'staging Y did not count its output as delivered');
  commitReadDelivery(ry);
  assert.equal(live.session.cursorsOf(A.principal).read, ry.nextCursor, 'after both are delivered the cursor is at Y’s end, with nothing unread between');
});

test('G22: reverse-order Run reads remember the higher delivered range until the lower gap closes', async () => {
  const s = 'two-deferred-reverse';
  await callTool('session_open', { session: s, visibility: 'shared' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  const x = await app.run(B, { session: s, command: 'echo X', wait: 5000 });
  const y = await app.run(B, { session: s, command: 'echo Y', wait: 5000 });
  assert.equal(x.state, 'exited');
  assert.equal(y.state, 'exited');
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-reverse', deferReadDelivery: true };
  const rx = await app.read(deferred, { session: s, runId: x.runId! });
  const ry = await app.read(deferred, { session: s, runId: y.runId! });
  assert.match(rx.text!, /X/);
  assert.match(ry.text!, /Y/);
  commitReadDelivery(ry);
  assert.ok(live.session.cursorsOf(A.principal).read < ry.nextCursor, 'X still blocks the scalar read cursor');
  type PendingReads = WeakMap<object, Map<string, Map<string, number>>>;
  const pendingReads = (app as unknown as { pendingRunReads: PendingReads }).pendingRunReads;
  const lineage = live.session.journal.runs;
  assert.equal(pendingReads.get(lineage)?.get(A.principal)?.get(y.runId!), ry.nextCursor, 'the higher delivered Run is retained until the gap closes');
  const other: Caller = { principal: 'agent:c@test', connectionId: 'c-ws-reverse' };
  const otherX = await app.read(other, { session: s, runId: x.runId! });
  assert.equal(live.session.cursorsOf(other.principal).read, otherX.nextCursor, 'another principal cannot inherit A’s pending Y delivery');
  assert.ok(otherX.nextCursor < ry.nextCursor);
  commitReadDelivery(rx);
  assert.equal(live.session.cursorsOf(A.principal).read, ry.nextCursor, 'delivering X joins the earlier delivered Y without reading Y again');
  assert.ok(!pendingReads.get(lineage)?.has(A.principal), 'joining the higher Run removes its hint and the now-empty principal');
});

test('G22: a remembered higher Run cannot carry read past a third, still-unread Run', async () => {
  const s = 'three-deferred-gap';
  await callTool('session_open', { session: s, visibility: 'shared' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  const x = await app.run(B, { session: s, command: 'echo X', wait: 5000 });
  const y = await app.run(B, { session: s, command: 'echo Y', wait: 5000 });
  const z = await app.run(B, { session: s, command: 'echo Z', wait: 5000 });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-three-gap', deferReadDelivery: true };
  const rx = await app.read(deferred, { session: s, runId: x.runId! });
  const ry = await app.read(deferred, { session: s, runId: y.runId! });
  const rz = await app.read(deferred, { session: s, runId: z.runId! });
  commitReadDelivery(rz);
  commitReadDelivery(rx);
  assert.ok(live.session.cursorsOf(A.principal).read < ry.nextCursor, 'unread Y still blocks the delivered Z');
  commitReadDelivery(ry);
  assert.equal(live.session.cursorsOf(A.principal).read, rz.nextCursor, 'Y delivery joins the earlier delivered Z');
});

test('G22: a session-level page closes an unread Run gap and joins a higher delivered Run', async () => {
  const s = 'session-bridges-run-gap';
  await callTool('session_open', { session: s, visibility: 'shared' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  const x = await app.run(B, { session: s, command: 'echo X', wait: 5000 });
  const y = await app.run(B, { session: s, command: 'echo Y-DELIVERED-ONLY', wait: 5000 });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-session-gap', deferReadDelivery: true };
  const ry = await app.read(deferred, { session: s, runId: y.runId! });
  commitReadDelivery(ry);
  assert.ok(live.session.cursorsOf(A.principal).read < ry.nextCursor);
  const page = await app.read(deferred, { session: s, since: 0, until: x.output.nextCursor });
  assert.match(page.text!, /(?:^|\n)X(?:\n|$)/);
  assert.doesNotMatch(page.text!, /Y-DELIVERED-ONLY/);
  assert.ok(page.nextCursor < ry.nextCursor);
  commitReadDelivery(page);
  assert.equal(live.session.cursorsOf(A.principal).read, ry.nextCursor, 'the session page bridged the gap below the earlier delivered Y');
});

test('G22: a first page of one Run leaves its remaining output unread below a higher delivered Run', async () => {
  const s = 'partial-run-gap';
  await callTool('session_open', { session: s, visibility: 'shared' }, { app, caller: B, resultText: 'transcript' }, TOOLS);
  const x = await app.run(B, { session: s, command: `awk 'BEGIN { for (i = 0; i < 5000; i++) printf "X"; printf "\\nX-END\\n" }'`, wait: 5000 });
  const y = await app.run(B, { session: s, command: 'echo Y', wait: 5000 });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-partial-gap', deferReadDelivery: true };
  const ry = await app.read(deferred, { session: s, runId: y.runId! });
  commitReadDelivery(ry);
  const first = await app.read(deferred, { session: s, runId: x.runId!, since: 0, maxBytes: 1024 });
  assert.equal(first.more, true, 'X has output beyond this page');
  assert.ok(first.nextCursor < ry.nextCursor);
  commitReadDelivery(first);
  assert.ok(live.session.cursorsOf(A.principal).read < ry.nextCursor, 'part of X is still unread');
  const whole = await app.read(deferred, { session: s, runId: x.runId!, since: 0, maxBytes: 16384 });
  assert.match(whole.text!, /X-END/);
  assert.equal(whole.more, false);
  commitReadDelivery(whole);
  assert.equal(live.session.cursorsOf(A.principal).read, ry.nextCursor, 'all of X has now been delivered');
});

test('78c4d6e 19: the read commit does not survive into an idempotency entry’s compact copy', async () => {
  const s = 'compact-sym';
  await app.sessionOpen(A, { id: s });
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-compact', deferReadDelivery: true };
  const key = 'k-compact';
  const r = await app.run(deferred, { session: s, command: 'echo hi', idempotencyKey: key, wait: 5000 });
  assert.equal(r.state, 'exited');
  // The delivered result carries the staged commit until it is run, then no longer.
  assert.ok(Object.getOwnPropertySymbols(r).length >= 1, 'the staged commit rides the result');
  commitReadDelivery(r);
  assert.deepEqual(Object.getOwnPropertySymbols(r), [], 'the delivered result has no symbol left');
  // The idempotency entry keeps a compact copy; it holds no read-commit symbol, so no Session leaks through it.
  await new Promise((res) => setImmediate(res));
  const entries = (app as unknown as { idem: { entries: Map<string, { value: Promise<unknown> }> } }).idem.entries;
  const entry = entries.get(`${A.principal}\u0000${key}`);
  assert.ok(entry, 'the key was remembered');
  const stored = (await entry.value) as RunResult;
  assert.deepEqual(Object.getOwnPropertySymbols(stored), [], 'the compact copy carries no symbol');
  assert.equal(stored.output.text, '', 'it is the compact copy (no output text)');
});

test('G22/G16: a keyed Run replay carries its own deferred read commit', async () => {
  const s = 'replay-delivery';
  await app.sessionOpen(A, { id: s });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-replay', deferReadDelivery: true };
  const command = 'echo REPLAY-READ-OUTPUT';
  const opts = { session: s, command, idempotencyKey: 'k-replay-delivery', wait: 5000 };
  const before = live.session.cursorsOf(A.principal).read;
  const first = await app.run(deferred, opts);
  assert.equal(first.state, 'exited');
  assert.equal(live.session.cursorsOf(A.principal).read, before, 'the first result has not been written');
  const replay = await app.run(deferred, opts);
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, first.runId, 'the command ran only once');
  assert.match(replay.output.text, /REPLAY-READ-OUTPUT/, 'the replay returned the Run output');
  assert.equal(live.session.cursorsOf(A.principal).read, before, 'replaying the method does not itself count as delivery');
  commitReadDelivery(replay);
  assert.ok(live.session.cursorsOf(A.principal).read > before, 'the replay write advances the read cursor');
  assert.deepEqual(Object.getOwnPropertySymbols(replay), [], 'its commit was consumed exactly once');
});

test('78c4d6e: run, await, start and screen advance a deferred caller’s read cursor only once their result is written', async () => {
  const s = 'deferred-tools';
  await callTool('session_open', { session: s }, { app, caller: A, resultText: 'transcript' }, TOOLS);
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-tools', deferReadDelivery: true };
  const cur = () => live.session.cursorsOf(A.principal).read;

  const commits = async (name: string, args: Record<string, unknown>, shown: string): Promise<void> => {
    const before = cur();
    const r = await callTool(name, args, { app, caller: deferred, resultText: 'transcript' }, TOOLS);
    assert.equal(r.isError, undefined, `${name}: ${r.text}`);
    assert.match(r.text, new RegExp(shown), `${name}: the result returned new output`);
    assert.equal(cur(), before, `${name}: nothing committed before the write`);
    assert.equal(typeof r.onSent, 'function', `${name}: the result carries its commit`);
    r.onSent!();
    assert.ok(cur() > before, `${name}: its new output advances the cursor after the write`);
  };

  await commits('run', { session: s, command: 'echo one' }, 'one');
  const two = await callTool('run', { session: s, command: 'echo two' }, { app, caller: deferred, resultText: 'transcript' }, TOOLS);
  assert.equal(two.isError, undefined, two.text);
  assert.equal(typeof two.onSent, 'function');
  // The prior run response stays unwritten: await is the first result that shows its output.
  await commits('await', { runId: (two.structured as { runId: string }).runId }, 'two');
  await commits('start', { session: s, command: 'echo START-FRESH; sleep 30', name: 'svc', target: 'process', ready: { pattern: 'START-FRESH' }, wait: 5000 }, 'START-FRESH');
  live.session.input('echo SCREEN-FRESH\n', { principal: A.principal });
  await until(() => live.session.snapshot().lines.some((l) => l.includes('SCREEN-FRESH')), 5000, 'the new shell output to reach the screen');
  await commits('screen', { session: s }, 'SCREEN-FRESH');
  const st = live.session.listRuns().find((x) => x.target === 'process');
  if (st) await app.cancel(A, { session: s, runId: st.runId });
});

test('78c4d6e 9: a staged commit that runs after a close and reopen lands on the new life, never dragging the persisted cursor back', async () => {
  const s = 'reopen-cursor';
  await app.sessionOpen(A, { id: s });
  await app.run(A, { session: s, command: 'echo one', wait: 5000 });
  const life1 = registry.get(s);
  assert.ok(life1?.kind === 'live');
  // A deferred read of the session on life1: its commit is staged, not run (the connection has not written).
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws9', deferReadDelivery: true };
  const staged = await app.read(deferred, { session: s, since: 0 });
  const stagedTarget = staged.nextCursor;
  // The name is closed and reopened: a new life, the journal continuous across it (G1).
  await app.sessionClose(A, { session: s });
  await app.sessionOpen(A, { id: s });
  const life2 = registry.get(s);
  assert.ok(life2?.kind === 'live' && life2.session !== life1.session);
  // life2 advances the cursor further, and the book is persisted at that point.
  await app.run(A, { session: s, command: 'echo two', wait: 5000 });
  await app.read(A, { session: s, since: 0 });
  const ahead = life2.session.cursorsOf(A.principal).read;
  assert.ok(ahead > stagedTarget, `the new life is ahead of the stale target (${ahead} > ${stagedTarget})`);
  // Now the stale staged commit runs: it resolves the live entry by name and commits onto the new life,
  // never handing the old life's cursors to the book whole and dragging the persisted cursor back.
  commitReadDelivery(staged);
  await app.sessionClose(A, { session: s });
  const hist = registry.get(s);
  assert.ok(hist?.kind === 'history');
  assert.ok(hist.cursorsOf(A.principal).read >= ahead, `the persisted cursor did not fall behind (${hist.cursorsOf(A.principal).read} >= ${ahead})`);
});

test('G22: deferred read commits stay with their journal after forget and name reuse', async () => {
  const s = 'forgotten-read';
  await app.sessionOpen(A, { id: s, visibility: 'shared' });
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-forgotten', deferReadDelivery: true };
  const old = await app.run(deferred, { session: s, command: 'echo OLD-LINEAGE', wait: 5000 });
  assert.ok(old.runId, 'the old Run was admitted');
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const whole = await app.read(deferred, { session: s, since: 0 });
  const oneRun = await app.awaitRun(deferred, { session: s, runId: old.runId });
  assert.match(whole.text ?? '', /OLD-LINEAGE/);
  assert.match(oneRun.output.text, /OLD-LINEAGE/);
  assert.equal(first.session.cursorsOf(A.principal).read, 0, 'the old results still wait for transport writes');
  const oldRuns = first.session.journal.runs;
  await app.sessionClose(A, { session: s, forget: true });
  await app.sessionOpen(A, { id: s });
  const fresh = registry.get(s);
  assert.ok(fresh?.kind === 'live');
  assert.notEqual(fresh.session.journal.runs, oldRuns, 'forget made a new journal lineage under the same name');
  const wanted = Math.max(whole.nextCursor, oneRun.output.nextCursor);
  while (fresh.session.journal.lastSeq <= wanted) fresh.session.journal.append({ type: 'note', text: 'new-life event', principal: A.principal });
  const before = fresh.session.cursorsOf(A.principal).read;
  commitReadDelivery(whole);
  assert.equal(fresh.session.cursorsOf(A.principal).read, before, 'the old whole-session read does not advance the new journal');
  commitReadDelivery(oneRun);
  assert.equal(fresh.session.cursorsOf(A.principal).read, before, 'the old Run read does not advance the new journal');
});

test('G22: a screen request keeps its snapshot when its live session becomes readable history', async () => {
  const s = 'screen-closing-to-history';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const screen = first.session.screen;
  const row = await app.run(A, { session: s, command: 'echo; echo SCREEN_CONTENT', wait: 5000 });
  assert.equal(row.state, 'exited');
  await screen.settled();
  const beforeClose = first.session.snapshot();
  assert.ok(beforeClose.lines.includes('SCREEN_CONTENT'), 'the live screen has a complete content row');
  const settled = screen.settled.bind(screen);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  screen.settled = async () => { entered(); await gate; await settled(); };
  const pending = app.screen(A, { session: s });
  void pending.catch(() => {});
  await inside;
  screen.settled = settled;
  try {
    await app.sessionClose(A, { session: s });
  } finally {
    release();
  }
  const snap = await pending;
  const history = registry.get(s);
  assert.ok(history?.kind === 'history');
  assert.ok(snap.lines.includes('SCREEN_CONTENT'), 'the content row survives settlement and disposal even if a later prompt arrives');
  assert.equal(history.cursorsOf(A.principal).read, snap.seq, 'the snapshot is delivered to the same journal after it becomes history');
});

test('G22: a screen from a forgotten journal does not answer for later history with the same name', async () => {
  const s = 'screen-replaced-history';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const screen = first.session.screen;
  const settled = screen.settled.bind(screen);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  screen.settled = async () => { entered(); await gate; await settled(); };
  const pending = app.screen(A, { session: s });
  void pending.catch(() => {});
  await inside;
  screen.settled = settled;
  try {
    await app.sessionClose(A, { session: s, forget: true });
    await app.sessionOpen(A, { id: s });
    await app.sessionClose(A, { session: s });
    const replacement = registry.get(s);
    assert.ok(replacement?.kind === 'history');
    assert.notEqual(replacement.journal.runs, first.session.journal.runs, 'name reuse has another journal lineage');
  } finally {
    release();
  }
  await assert.rejects(pending, (e: unknown) => (e as { code?: string }).code === 'session_not_found');
});

test('G22: a screen from an old live life does not answer for a reopened life of the same journal', async () => {
  const s = 'screen-reopened-life';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const screen = first.session.screen;
  const settled = screen.settled.bind(screen);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  screen.settled = async () => { entered(); await gate; await settled(); };
  const pending = app.screen(A, { session: s });
  void pending.catch(() => {});
  await inside;
  screen.settled = settled;
  try {
    await app.sessionClose(A, { session: s });
    await app.sessionOpen(A, { id: s });
    const reopened = registry.get(s);
    assert.ok(reopened?.kind === 'live');
    assert.notEqual(reopened.session, first.session);
    assert.equal(reopened.session.journal.runs, first.session.journal.runs, 'the life changes while its journal lineage persists');
  } finally {
    release();
  }
  await assert.rejects(pending, (e: unknown) => (e as { code?: string }).code === 'session_not_found', 'a prior screen cannot answer as the current live life');
});

test('G22: screen refuses a replaced session while its snapshot is settling', async () => {
  const s = 'screen-replaced';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const screen = first.session.screen;
  const settled = screen.settled.bind(screen);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  screen.settled = async () => { entered(); await gate; await settled(); };
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-screen-replaced', deferReadDelivery: true };
  const pending = app.screen(deferred, { session: s });
  void pending.catch(() => {});
  await inside;
  screen.settled = settled;
  try {
    await app.sessionClose(A, { session: s, forget: true });
    await app.sessionOpen(A, { id: s });
  } finally {
    release();
  }
  await assert.rejects(pending, (e: unknown) => (e as { code?: string }).code === 'session_not_found', 'the old screen does not answer for the replacement');
});

test('G22: a screen whose session is forgotten while it settles is refused as not found', async () => {
  const s = 'screen-forgotten';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const screen = first.session.screen;
  const settled = screen.settled.bind(screen);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  screen.settled = async () => { entered(); await gate; await settled(); };
  const pending = app.screen(A, { session: s });
  void pending.catch(() => {});
  await inside;
  screen.settled = settled;
  try {
    await app.sessionClose(A, { session: s, forget: true });
    assert.equal(registry.get(s), undefined, 'nothing holds the name now');
  } finally {
    release();
  }
  await assert.rejects(pending, (e: unknown) => (e as { code?: string }).code === 'session_not_found');
});

test('G22: a screen does not answer for a later life of its journal that closed while it settled', async () => {
  const s = 'screen-reclosed-life';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const screen = first.session.screen;
  const settled = screen.settled.bind(screen);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  screen.settled = async () => { entered(); await gate; await settled(); };
  const pending = app.screen(A, { session: s });
  void pending.catch(() => {});
  await inside;
  screen.settled = settled;
  try {
    await app.sessionClose(A, { session: s });
    await app.sessionOpen(A, { id: s });
    await app.sessionClose(A, { session: s });
    const later = registry.get(s);
    assert.ok(later?.kind === 'history');
    assert.equal(later.journal.runs, first.session.journal.runs, 'the later life keeps the journal lineage');
    assert.notEqual(later.journal, first.session.journal, 'and is a life of its own');
  } finally {
    release();
  }
  await assert.rejects(pending, (e: unknown) => (e as { code?: string }).code === 'session_not_found', 'the earlier life does not answer for the later one');
});

test('G22: a closed life cannot lower the reopened journal cursor book', async () => {
  const s = 'old-life-cursors';
  await app.sessionOpen(A, { id: s });
  const first = registry.get(s);
  assert.ok(first?.kind === 'live');
  const old = first.session;
  assert.deepEqual(old.cursorsOf(A.principal), { delivered: 0, read: 0 });
  await app.sessionClose(A, { session: s });
  await app.sessionOpen(A, { id: s });
  const reopened = registry.get(s);
  assert.ok(reopened?.kind === 'live');
  const top = reopened.session.journal.lastSeq;
  assert.ok(top > 1, 'the new life has journal events beyond the stale update');
  reopened.session.markRead(A.principal, top);
  reopened.session.markDelivered(A.principal, top);
  type Book = { get(principal: string): { read: number; delivered: number }; flush(): void };
  const slots = (registry as unknown as { slots: Map<string, { cursors: Book }> }).slots;
  const book = slots.get(s)?.cursors;
  assert.ok(book);
  const expected = { read: top, delivered: top };
  assert.deepEqual(book.get(A.principal), expected, 'the reopened Session advanced both persisted fields');
  old.markDelivered(A.principal, 1);
  assert.deepEqual(book.get(A.principal), expected, 'an old delivered update cannot lower the new read or delivered cursor');
  old.markRead(A.principal, 1);
  assert.deepEqual(book.get(A.principal), expected, 'an old read update cannot lower either cursor');
  book.flush();
  const file = path.join(dataDir, 'sessions', s, 'cursors.json');
  const stored = (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { read: number; delivered: number }>)[A.principal];
  assert.deepEqual(stored, expected, 'the journal persists both newer cursor fields');
});

test('78c4d6e 10: a service outcome marks the status event the result rendered, so a ready→unhealthy→ready flap before the write does not swallow the recovery', async () => {
  const s = 'flap';
  await app.sessionOpen(A, { id: s });
  // The service is ready at once, then says FAIL, then is ready again: three status events.
  const st = await app.start(A, { session: s, name: 'svc', target: 'process', command: `bash -c 'echo READY; sleep 0.3; echo FAIL; sleep 0.3; echo READY-AGAIN; sleep 10'`, ready: { pattern: 'READY' }, fail: { pattern: 'FAIL' }, wait: 5000 });
  assert.equal(st.service, 'ready', JSON.stringify(st));
  const runId = st.runId!;
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const monitor = app.extras(live.session).services.get(runId)!;
  const readySeq = monitor.info().seq!;
  assert.equal(typeof readySeq, 'number');
  // The flap plays out: unhealthy, then ready again at a new seq.
  await until(() => monitor.info().status === 'ready' && (monitor.info().seq ?? 0) > readySeq, 5000, 'the recovery ready, at a new seq');
  const recoverySeq = monitor.info().seq!;
  assert.ok(recoverySeq > readySeq);
  // The start result is now written: it carried the first ready, so that is what counts as delivered.
  app.outcomeSent(A, st);
  assert.equal(live.session.outcomeDeliveredTo(serviceOutcomeKey(runId, 'ready', readySeq), A.principal), true, 'the ready the result carried is delivered');
  assert.equal(live.session.outcomeDeliveredTo(serviceOutcomeKey(runId, 'ready', recoverySeq), A.principal), false, 'the recovery the result never carried is still announced');
  await app.cancel(A, { session: s, runId });
});

test('G16/G22/G28: a keyed start replay keeps its read commit and rendered service status', async () => {
  const s = 'start-replay';
  await app.sessionOpen(A, { id: s });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-start-replay', deferReadDelivery: true };
  const opts = { session: s, name: 'start-replay-svc', target: 'process' as const, command: 'echo START-READY; sleep 30', ready: { pattern: 'START-READY' }, idempotencyKey: 'k-start-replay', wait: 5000 };
  const before = live.session.cursorsOf(A.principal).read;
  const first = await app.start(deferred, opts);
  assert.equal(first.service, 'ready', JSON.stringify(first));
  assert.ok(first.runId);
  const replay = await app.start(deferred, opts);
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, first.runId, 'the service was admitted once');
  assert.equal(replay.service, 'ready');
  assert.match(replay.output.text, /START-READY/, 'the replay returns the service Run output');
  assert.equal(live.session.cursorsOf(A.principal).read, before, 'neither deferred result was written');
  const seq = app.extras(live.session).services.get(first.runId)!.info().seq;
  assert.ok(seq !== undefined, 'ready has a journaled status event');
  const key = serviceOutcomeKey(first.runId, 'ready', seq);
  assert.equal(live.session.outcomeDeliveredTo(key, A.principal), false);
  app.outcomeSent(deferred, replay);
  assert.equal(live.session.outcomeDeliveredTo(key, A.principal), true, 'the replay marks the rendered ready event delivered');
  commitReadDelivery(replay);
  assert.ok(live.session.cursorsOf(A.principal).read > before, 'the replay write marks its returned output read');
  await app.cancel(A, { session: s, runId: first.runId });
});

test('a reviewer’s read (6270045466): a read with `advance: false` stages no commit and moves no cursor, deferred or not', async () => {
  const s = 'no-advance';
  await app.sessionOpen(A, { id: s });
  await app.run(A, { session: s, command: 'echo shown-unasked', wait: 5000 });
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  // The run's own result moved the cursor to its end; later output is unread.
  await app.run(A, { session: s, command: 'echo later', wait: 5000, queue: true });
  const r0 = await app.read(A, { session: s, since: 0 });
  const at = live.session.cursorsOf(A.principal).read;
  assert.equal(at, r0.nextCursor);
  live.session.journal.append({ type: 'output', data: 'appended-after\r\n', stream: 'pty' });
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-na', deferReadDelivery: true };
  const staged = await app.read(deferred, { session: s, since: 0, advance: false });
  assert.match(staged.text!, /appended-after/);
  assert.equal(takeReadCommit(staged), undefined, 'nothing staged for a deferred caller');
  const direct = await app.read(A, { session: s, since: 0, advance: false });
  assert.match(direct.text!, /appended-after/);
  assert.equal(live.session.cursorsOf(A.principal).read, at, 'neither read moved the cursor');
  const counted = await app.read(A, { session: s, since: 0 });
  assert.equal(live.session.cursorsOf(A.principal).read, counted.nextCursor, 'an ordinary read still does');
});

test('a pruned same-life Run retains monotonic age when a keyed retry finds it in the index', { timeout: 90_000 }, async (t) => {
  const local = new SessionRegistry({ dataDir: path.join(dataDir, 'idem-pruned'), backend: fakeShellBackend((sh) => sh.on(/^echo /, () => ({ exit: 0 }))), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry: local, defaultWaitMs: 1000 });
  const session = 'idem-pruned';
  try {
    await app.sessionOpen(A, { id: session });
    const call = () => app.run(A, { session, command: 'echo once', wait: 1000, idempotencyKey: 'pruned-first' });
    const first = await call();
    assert.equal(first.state, 'exited');
    assert.ok(first.runId, 'the first Run was admitted');
    // 1,025 keyed Runs exceed both the Session's 1,000 ended Runs and this principal's 1,024 cached keys.
    for (let i = 0; i < 1024; i++) {
      const r = await app.run(A, { session, command: `echo ${i}`, wait: 1000, idempotencyKey: `pruned-next-${i}` });
      assert.equal(r.state, 'exited', `filler ${i}`);
    }
    const live = local.get(session);
    assert.ok(live?.kind === 'live');
    assert.equal(live.session.runAgeMs(first.runId), undefined, 'the live Session pruned the first ended Run');
    assert.ok(live.session.journal.runs.has(first.runId), 'its older Run remains in the bounded journal index');
    const realNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => realNow() + 60 * 60_000);
    await assert.rejects(() => app.run(A, { session, command: 'echo different', wait: 1000, idempotencyKey: 'pruned-first' }), /other arguments/, 'an indexed key still rejects different arguments after the cache evicts it');
    const replayed = await call();
    assert.equal(replayed.runId, first.runId, 'a wall-clock step cannot expire a same-life indexed Run');
    assert.equal(replayed.replayed, true);
    const realMono = clocks.monotonic;
    t.mock.method(clocks, 'monotonic', () => realMono() + 16 * 60_000);
    const expired = await call();
    assert.notEqual(expired.runId, first.runId, 'the monotonic window still expires the key');
  } finally {
    t.mock.restoreAll();
    await local.closeAll();
  }
});

test('the 38 commits 7: the idempotency window is measured on the monotonic clock: a wall-clock step never expires a young key', async (t) => {
  // The store swept on Date.now: an hour's step forward expired a key made a moment before, and the retry ran
  // the command again (the house's read of the 38 commits, #22, comment 6274935728, item 7).
  const s = 'idemclock';
  await tool('session_open', { session: s });
  const call = () => app.run(A, { session: s, command: 'echo once', target: 'process', wait: 5000, idempotencyKey: 'the-38-commits-7' });
  const first = await call();
  assert.equal(first.state, 'exited', JSON.stringify(first));
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + 60 * 60_000);
  const again = await call();
  assert.equal(again.runId, first.runId, 'the same Run, not a second execution');
  assert.equal(again.replayed, true);
  // Past the 15-minute window on the monotonic clock, the key is forgotten and the call runs anew.
  const realMono = clocks.monotonic;
  t.mock.method(clocks, 'monotonic', () => realMono() + 16 * 60_000);
  const later = await call();
  assert.notEqual(later.runId, first.runId);
  assert.equal(later.replayed, undefined);
});

test('a key a restart’s journal recovers keeps its age: it expires a window after its Run’s admission, not a window after its first retry', async (t) => {
  // It was stamped with the retry's monotonic time, so a key 14 minutes old lived 15 more minutes from its
  // first retry (a reviewer's read of the fixes for #22).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-idem-aged-'));
  const open = () => {
    const registry = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    return { registry, app: new App({ registry, defaultWaitMs: 5000 }) };
  };
  let life = open();
  const call = () => life.app.run(A, { session: 'aged', command: 'echo once', target: 'process', wait: 5000, idempotencyKey: 'aged-key' });
  try {
    await life.app.sessionOpen(A, { id: 'aged' });
    const first = await call();
    assert.equal(first.state, 'exited', JSON.stringify(first));
    await life.registry.closeAll();
    // The daemon comes back 14 minutes later: the key is recovered from the journal and replays the Run.
    const realNow = Date.now.bind(Date);
    let wall = 14 * 60_000;
    t.mock.method(Date, 'now', () => realNow() + wall);
    life = open();
    const again = await call();
    assert.equal(again.runId, first.runId, 'the same Run');
    assert.equal(again.replayed, true);
    // Two minutes on, by both clocks: 16 minutes since the admission, past the window.
    const realMono = clocks.monotonic;
    t.mock.method(clocks, 'monotonic', () => realMono() + 2 * 60_000);
    wall = 16 * 60_000;
    const later = await call();
    assert.notEqual(later.runId, first.runId, 'the key expired with its window');
    assert.equal(later.replayed, undefined);
  } finally {
    await life.registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the 33 commits 7: a recovered key stamped old behind a younger one is dropped when it is looked up past its window, which the sweep stops short of', async (t) => {
  // The sweep expires from the oldest entry in insertion order and stops at the first inside the window; a key
  // a restart recovered is stamped with its Run's age, so it can sit, expired, behind a younger key (the house's
  // read of the 33 commits, #22, comment 6307350650, item 7).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-idem-behind-'));
  const open = () => {
    const registry = new SessionRegistry({ dataDir: dir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    return { registry, app: new App({ registry, defaultWaitMs: 5000 }) };
  };
  let life = open();
  const call = (key: string) => life.app.run(A, { session: 'behind', command: `echo ${key}`, target: 'process', wait: 5000, idempotencyKey: key });
  try {
    await life.app.sessionOpen(A, { id: 'behind' });
    const aged = await call('aged-key');
    assert.equal(aged.state, 'exited', JSON.stringify(aged));
    await life.registry.closeAll();
    // The daemon comes back 14 minutes later. A new key is made first, then the old key's retry recovers it,
    // stamped 14 minutes old, after the younger entry.
    const realNow = Date.now.bind(Date);
    let wall = 14 * 60_000;
    t.mock.method(Date, 'now', () => realNow() + wall);
    life = open();
    const young = await call('young-key');
    assert.equal(young.replayed, undefined);
    const again = await call('aged-key');
    assert.equal(again.runId, aged.runId, 'recovered: the same Run');
    assert.equal(again.replayed, true);
    // Two minutes on, by both clocks: the young key is inside its window, so the sweep stops at it; the old one,
    // 16 minutes from its admission, is past its own and runs anew.
    const realMono = clocks.monotonic;
    t.mock.method(clocks, 'monotonic', () => realMono() + 2 * 60_000);
    wall = 16 * 60_000;
    const later = await call('aged-key');
    assert.notEqual(later.runId, aged.runId, 'the expired key is dropped where it sits');
    assert.equal(later.replayed, undefined);
    assert.equal((await call('young-key')).runId, young.runId, 'the younger key still replays');
  } finally {
    await life.registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a command line shortened for a result never splits a surrogate pair', async () => {
  const prefix = `: ${'x'.repeat(197)}`;
  const r = await tool('run', { session: 'surrogate', command: `${prefix}\u{1F600} tail`, wait: 5000 });
  assert.equal(r.structured?.line, `${prefix}…(${Buffer.byteLength(`${prefix}\u{1F600} tail`)} bytes)`);
});
