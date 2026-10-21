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
  // Reading r2 itself does: nothing unread lies before its end any more.
  const rd = await app.read(A, { session: s, runId: r2.runId });
  assert.equal(life2.session.cursorsOf(A.principal).read, rd.nextCursor);
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
  commitReadDelivery(ry);
  assert.equal(live.session.cursorsOf(A.principal).read, ry.nextCursor, 'after both are delivered the cursor is at Y’s end, with nothing unread between');
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

test('78c4d6e: run, await, start and screen advance a deferred caller’s read cursor only once their result is written', async () => {
  const s = 'deferred-tools';
  await callTool('session_open', { session: s }, { app, caller: A, resultText: 'transcript' }, TOOLS);
  const live = registry.get(s);
  assert.ok(live?.kind === 'live');
  const deferred: Caller = { principal: A.principal, connectionId: 'a-ws-tools', deferReadDelivery: true };
  const cur = () => live.session.cursorsOf(A.principal).read;

  const commits = async (name: string, args: Record<string, unknown>): Promise<void> => {
    const before = cur();
    const r = await callTool(name, args, { app, caller: deferred, resultText: 'transcript' }, TOOLS);
    assert.equal(r.isError, undefined, `${name}: ${r.text}`);
    assert.equal(cur(), before, `${name}: nothing committed before the write`);
    assert.equal(typeof r.onSent, 'function', `${name}: the result carries its commit`);
    r.onSent!();
    assert.ok(cur() >= before, `${name}: the cursor advances on the write`);
  };

  await commits('run', { session: s, command: 'echo one' });
  const two = await callTool('run', { session: s, command: 'echo two' }, { app, caller: deferred, resultText: 'transcript' }, TOOLS);
  two.onSent!();
  await commits('await', { runId: (two.structured as { runId: string }).runId });
  await commits('start', { session: s, command: 'sleep 30', name: 'svc', target: 'process' });
  await commits('screen', { session: s });
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
