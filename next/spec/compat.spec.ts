/**
 * The compat pack against real bash: the 1.x names keep their shapes and tell the truth
 * about running commands, and where 1.x's server behaved differently the pack follows it
 * (the house's read of 1cabc6a, #22): a command meant for a nested shell is not queued
 * behind it, logs show `$ <command>` and no plumbing, a launch with error patterns alone
 * watches for them, takeScreenshot does not claim a file it never wrote, killed sessions
 * are forgotten.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { callTool, toolsFor } from '../src/api/tools.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { clocks } from '../src/core/clock.js';
import { commandFile, inlineProbe, markerProbe, probeEcho, sourceLine } from '../src/core/plumbing.js';
import { fakeShellBackend, type FakeShell } from './fake-shell.js';
import { until } from './testhost.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-compat-'));
let registry: SessionRegistry;
let app: App;
const A: Caller = { principal: 'agent:a@test', connectionId: 'ca' };
const compat = toolsFor('compat');

type Obj = Record<string, unknown>;
/** Call a compat-profile tool and parse its JSON text. */
const call = async (name: string, args: Obj): Promise<Obj & unknown[]> => JSON.parse((await callTool(name, args, { app, caller: A, resultText: 'json' }, compat)).text) as Obj & unknown[];
const lines = (r: unknown): string[] => r as string[];
const summary = (id: string) => app.sessionList(A).find((s) => s.id === id);

before(() => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  app = new App({ registry, defaultWaitMs: 5000 });
});

after(async () => {
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('runCommand, tailLogs, searchLogs: results keep the 1.x shapes; logs show `$ <command>` and none of the daemon’s plumbing', async () => {
  const r = await call('runCommand', { session: 'legacy', command: 'echo legacy-ok' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, 'exited');
  assert.match(String(r.output), /legacy-ok/);
  assert.doesNotMatch(String(r.output), /tsm-cmd-/);
  const tail = lines(await call('tailLogs', { session: 'legacy', lines: 20 }));
  assert.ok(tail.includes('$ echo legacy-ok'), JSON.stringify(tail));
  assert.ok(tail.some((l) => l === 'legacy-ok'), JSON.stringify(tail));
  assert.ok(!tail.some((l) => l.includes('tsm-cmd-')), `the typed command file line is plumbing: ${JSON.stringify(tail)}`);
  const rawTail = lines(await call('tailLogs', { session: 'legacy', lines: 20, raw: true }));
  assert.ok(rawTail.includes('$ echo legacy-ok'), JSON.stringify(rawTail));
  // The wrapper's own text is not something 1.x logs ever matched.
  const plumbing = await call('searchLogs', { session: 'legacy', pattern: 'tsm-cmd' });
  assert.equal((plumbing as unknown[]).length, 0, JSON.stringify(plumbing));
  const found = (await call('searchLogs', { session: 'legacy', pattern: 'LEGACY-ok' })) as unknown as Array<{ line: string; context: string[] }>;
  assert.ok(found.length >= 1, 'case-insensitive, as 1.x searched');
  assert.ok(found.every((m) => !m.line.includes('tsm-cmd-') && m.context.every((c) => !c.includes('tsm-cmd-'))), JSON.stringify(found));

  // 1.x queued overlapping calls to one session (atc-10): this one runs after the sleep.
  const running = await call('runCommand', { session: 'legacy', command: 'sleep 1; echo later', timeout: -1 });
  assert.equal(running.exitCode, -1);
  assert.ok(running.state === 'running' || running.state === 'starting', String(running.state));
  const queued = await call('runCommand', { session: 'legacy', command: 'echo queued-ran', timeout: 50 });
  assert.equal(queued.state, 'queued');
  assert.match(String(queued.note), /await \{"runId": "r/);
  const done = await call('await', { runId: queued.runId, wait: 5000 });
  assert.equal(done.state, 'exited');
  const tail2 = lines(await call('tailLogs', { session: 'legacy', lines: 20 }));
  assert.ok(tail2.includes('later') && tail2.includes('queued-ran') && tail2.includes('$ echo queued-ran'), JSON.stringify(tail2));
});

test('defect 1: a command meant for a nested shell is not queued behind it; declared, it runs there (session_declare_shell is served)', async () => {
  assert.ok(compat.some((t) => t.name === 'session_declare_shell'), 'the compat profile serves session_declare_shell');
  assert.ok(compat.some((t) => t.name === 'await') && compat.some((t) => t.name === 'read'));
  const opened = await call('runCommand', { session: 'nest', command: 'env MARK=inner bash --norc --noprofile', timeout: -1 });
  assert.ok(opened.state === 'running' || opened.state === 'starting', String(opened.state));
  await until(() => summary('nest')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'the nested bash to be running');
  // The result says what to do about a command that looks like it opened a shell.
  const seen = await call('await', { runId: opened.runId, wait: 300 });
  assert.equal(seen.state, 'running');
  const refused = await call('runCommand', { session: 'nest', command: 'echo "mark=[$MARK]"', timeout: 500 });
  assert.equal(refused.state, 'busy', JSON.stringify(refused));
  assert.equal(refused.exitCode, -1);
  assert.match(String(refused.error), /session_declare_shell \{"session": "nest"\}/);
  assert.match(String(refused.error), new RegExp(`await \\{"runId": "${opened.runId}"\\}`));
  assert.equal(summary('nest')?.runs?.length, 1, 'nothing was queued behind the nested shell');
  const declared = await call('session_declare_shell', { session: 'nest', shell: 'bash' });
  assert.equal(declared.within, opened.runId);
  assert.deepEqual(summary('nest')?.declared, { shell: 'bash', within: opened.runId });
  const inner = await call('runCommand', { session: 'nest', command: 'echo "mark=[$MARK]"' });
  assert.equal(inner.exitCode, 0, JSON.stringify(inner));
  assert.match(String(inner.output), /mark=\[inner\]/, 'the command ran in the nested shell, not the outer one');
  assert.equal(inner.shell, 'bash');
  assert.equal(inner.within, opened.runId);
  // Declared, a second command queues behind a first as before.
  const slow = await call('runCommand', { session: 'nest', command: 'sleep 0.6; echo first', timeout: -1 });
  const second = await call('runCommand', { session: 'nest', command: 'echo second', timeout: 50 });
  assert.equal(second.state, 'queued', JSON.stringify(second));
  const both = await call('await', { runId: second.runId, wait: 5000 });
  assert.equal(both.exit, 0);
  assert.equal((await call('await', { runId: slow.runId, wait: 1000 })).state, 'exited');
  // The caller's own exit ends the nested shell and its declaration; the next command is the session's own shell's.
  await call('runCommand', { session: 'nest', command: 'exit', timeout: 3000 });
  const ended = await call('await', { runId: opened.runId, wait: 5000 });
  assert.equal(ended.state, 'exited', JSON.stringify(ended));
  const outer = await call('runCommand', { session: 'nest', command: 'echo "mark=[$MARK]"' });
  assert.equal(outer.exitCode, 0, JSON.stringify(outer));
  assert.match(String(outer.output), /mark=\[\]/);
});

test('defect 3: a launch with error patterns alone watches 15 s for them and answers error; launch into an existing session keeps its command in the cwd', async () => {
  const began = Date.now();
  const failed = await call('launch', { name: 'svc-fail', command: 'sleep 1; echo FATAL-42; sleep 30', errorPatterns: ['FATAL-42'] });
  assert.equal(failed.status, 'error', JSON.stringify(failed));
  assert.equal(failed.service, 'unhealthy');
  assert.match(String(failed.evidence), /FATAL-42/);
  assert.ok(Date.now() - began < 15_000, 'answered when the pattern appeared, not at the deadline');
  assert.ok(lines(failed.logs).some((l) => l.includes('FATAL-42')));
  const listed = (await call('listSessions', {})) as unknown as Array<Record<string, unknown>>;
  const svc = listed.find((s) => s.id === 'svc-fail');
  assert.equal(svc?.service, 'unhealthy', 'listSessions carries the service status');
  assert.equal(svc?.name, 'svc-fail');
  await call('killSession', { session: 'svc-fail', graceful: false });

  const ready = await call('launch', { name: 'svc-ready', command: 'echo "[server] ready (port 3000)?"; sleep 30', readyPatterns: ['[server] ready (port 3000)?'] });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  await call('killSession', { session: 'svc-ready', graceful: false });

  const target = path.join(dataDir, 'cd-target');
  fs.mkdirSync(target);
  await call('runCommand', { session: 'svc-cd', command: 'echo warm' });
  // (The group ends when pwd does — the sleep is in the background — so the service is `exited`; the point is where pwd ran.)
  const bg = await call('launch', { name: 'svc-cd', command: 'sleep 30 & pwd', cwd: target });
  assert.ok(lines(bg.logs).some((l) => l.endsWith('/cd-target')), `pwd ran in cwd despite the &: ${JSON.stringify(bg.logs)}`);
  assert.ok(lines(bg.logs).some((l) => l.startsWith('$ cd -- ')), 'the launched line is logged as a command');
  await call('killSession', { session: 'svc-cd', graceful: false });
});

test('defect 4: takeScreenshot with outputPath does not claim a file it never wrote', async () => {
  await call('runCommand', { session: 'shot', command: 'echo on-screen' });
  const file = path.join(dataDir, 'never.png');
  const live = registry.get('shot');
  assert.ok(live?.kind === 'live');
  const before = live.session.cursorsOf(A.principal).read;
  const refused = await call('takeScreenshot', { session: 'shot', outputPath: file, width: 800, height: 600 });
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /no file was written.*call again without outputPath for the text/);
  assert.ok(!fs.existsSync(file));
  // The refusal says to call again for the text, and hands none back: nothing was read for it, and the read
  // cursor did not move (the house's read of 78c4d6e, #22).
  assert.equal(refused.text, undefined, 'the refusal carries no screen');
  assert.equal(live.session.cursorsOf(A.principal).read, before, 'no screen was read for the refusal');
  // Without outputPath the screen comes as plain text, with the envelope beside it.
  const shot = await callTool('takeScreenshot', { session: 'shot' }, { app, caller: A, resultText: 'json' }, compat);
  assert.match(shot.text, /on-screen/);
  assert.equal(shot.structured?.success, true);
  assert.equal(typeof shot.structured?.cols, 'number');
});

test('listSessions has 1.x’s fields; killSession and killAll forget sessions, so a kill-until-empty loop ends', async () => {
  await call('runCommand', { session: 'ls-1', command: 'echo one' });
  await call('runCommand', { session: 'ls-2', command: 'echo two' });
  const listed = (await call('listSessions', {})) as unknown as Array<Record<string, unknown>>;
  const one = listed.find((s) => s.id === 'ls-1')!;
  assert.deepEqual(Object.keys(one).sort(), ['createdAt', 'id', 'isAlive', 'lastActivity', 'logSize', 'name', 'state'].sort(), JSON.stringify(one));
  assert.equal(one.isAlive, true);
  assert.match(String(one.createdAt), /^\d{4}-\d\d-\d\dT/);
  assert.ok(typeof one.logSize === 'number' && one.logSize > 0);
  const killed = await call('killSession', { session: 'ls-1' });
  assert.equal(killed.success, true);
  assert.ok(!((await call('listSessions', {})) as unknown as Array<{ id: string }>).some((s) => s.id === 'ls-1'), 'a killed session is gone from the list');
  const again = await call('killSession', { session: 'ls-1' });
  assert.equal(again.success, false, 'a second kill finds no session');
  await call('runCommand', { session: 'ls-3', command: 'sleep 30', timeout: -1 });
  const began = Date.now();
  const all = await call('killAll', {});
  assert.equal(all.success, true, JSON.stringify(all));
  assert.ok(Date.now() - began < 6000, 'sessions close concurrently');
  assert.deepEqual(await call('listSessions', {}), []);
});

test('runCommand output: raw keeps the stream, paged output comes whole, and past 1 MiB the tail is kept with a visible cut', async () => {
  const raw = await call('runCommand', { session: 'out', command: 'for i in $(seq 1 3000); do echo "line $i"; done', raw: true });
  assert.equal(raw.exitCode, 0);
  assert.match(String(raw.output), /line 1\r?\n/);
  assert.match(String(raw.output), /line 3000/);
  const big = await call('runCommand', { session: 'out', command: "head -c 1200000 /dev/zero | tr '\\0' y | fold -w 200; echo; echo END-OF-BIG", timeout: 30_000 });
  assert.equal(big.exitCode, 0, JSON.stringify({ state: big.state, note: big.note }));
  const out = String(big.output);
  // The advised read names the session, which the read tool requires (our read of the 40 commits, PR #22).
  const advice = new RegExp(`^\\[… earlier output omitted: read (\\{"session": "out", "runId": "${big.runId}"\\}) pages all of it\\]`).exec(out);
  assert.ok(advice, out.slice(0, 120));
  const first = (await call('read', JSON.parse(advice![1]!) as Obj)) as unknown as { text?: string };
  assert.ok(String(first.text).includes('y'.repeat(200)), 'the advised read pages the Run');
  assert.ok(out.endsWith('END-OF-BIG') || out.trimEnd().endsWith('END-OF-BIG'), out.slice(-100));
  assert.ok(Buffer.byteLength(out) <= 1024 * 1024 + 200, `bounded: ${Buffer.byteLength(out)}`);
  // A tail asked in lines gets lines, raw or clean, from the end.
  const tail = lines(await call('tailLogs', { session: 'out', lines: 500, raw: true }));
  assert.equal(tail.length, 500);
  assert.ok(tail.includes('END-OF-BIG'), tail.slice(-3).join('|'));
  assert.ok(tail.slice(0, 10).every((l) => /^y{200}$/.test(l)), 'the lines before the end are the output’s, counted as lines');
  const clean = lines(await call('tailLogs', { session: 'out', lines: 3 }));
  assert.equal(clean.length, 3);
  assert.ok(clean.includes('END-OF-BIG'), JSON.stringify(clean));
});

test('tailLogs on a 30,000-line session returns the lines asked for, clean or raw, and says when the 1 MiB bound cut them', async () => {
  // 30,000 lines of 110 bytes: 3.3 MB, of which the last 1 MiB holds about 9,500 lines.
  const r = await call('runCommand', { session: 'long', command: `awk 'BEGIN { for (i = 1; i <= 30000; i++) printf "line %06d %s\\n", i, "${'x'.repeat(98)}" }'`, timeout: 55_000 });
  assert.equal(r.exitCode, 0, JSON.stringify({ state: r.state, note: r.note }));
  const isLine = (l: string) => /^line \d{6} x{98}$/.test(l);
  for (const raw of [false, true]) {
    const tail = lines(await call('tailLogs', { session: 'long', lines: 500, raw }));
    assert.equal(tail.length, 500, `raw ${raw}: lines asked for are lines returned`);
    assert.ok(!tail[0]!.startsWith('[earlier output'), `raw ${raw}: the 500 lines are all there, nothing was cut`);
    assert.ok(tail.includes(`line 030000 ${'x'.repeat(98)}`), `raw ${raw}: ${tail.slice(-3).join('|')}`);
    assert.ok(tail.filter(isLine).length >= 497, `raw ${raw}: the output's own lines, counted as lines`);
  }
  const most = lines(await call('tailLogs', { session: 'long', lines: 10_000 }));
  assert.match(most[0]!, /^\[earlier output not shown \((?:the tail reached a bound|the raw tail reached)[^)]*\); read \{"session": "long", "tail": 10000, "until": \d+(?:, "untilOffset": \d+)?\}/, 'the bound cut lines that were asked for: said, with why');
  assert.ok(most.length > 5000 && most.length <= 10_001, `${most.length} lines`);
  assert.ok(most.slice(1).filter(isLine).length >= most.length - 3, 'whole lines up to the end');
});

test('sendInput types text and keys as asked; sendSignal interrupts the foreground command', async () => {
  const asked = await call('runCommand', { session: 'io', command: 'read -p "k? " k; echo "got [$k]"', timeout: -1 });
  await until(() => summary('io')?.runs?.some((x) => x.runId === asked.runId && x.state === 'running') === true, 5000, 'read to be running');
  assert.deepEqual(await call('sendInput', { session: 'io', input: 'ab', appendNewline: false }), { success: true });
  assert.deepEqual(await call('sendInput', { session: 'io', input: '', keys: ['Enter'] }), { success: true });
  const got = await call('await', { runId: asked.runId, wait: 5000 });
  assert.equal(got.exit, 0);
  assert.match(String((got.output as { text: string }).text), /got \[ab\]/);
  const long = await call('runCommand', { session: 'io', command: 'sleep 30', timeout: -1 });
  await until(() => summary('io')?.runs?.some((x) => x.runId === long.runId && x.state === 'running') === true, 5000, 'sleep to be running');
  assert.deepEqual(await call('sendSignal', { session: 'io' }), { success: true });
  const stopped = await call('await', { runId: long.runId, wait: 5000 });
  assert.ok(stopped.state === 'exited' || stopped.state === 'cancelled', JSON.stringify(stopped));
  assert.notEqual(stopped.exit, 0);
  const missing = await call('sendSignal', { session: 'no-such-session', signal: 'SIGINT' });
  assert.equal(missing.success, false);
});

test('a compat host whose delivery is deferred gets its read cursor advanced only once tailLogs or runCommand is written, and then for everything they drew', async () => {
  // The transport defers the cursor advance of a WebSocket caller to the write (G22); the compat tools
  // draw on several App results and must carry every one of their commits (a review of the branch).
  const deferred: Caller = { principal: A.principal, connectionId: 'ca-ws', deferReadDelivery: true };
  await call('runCommand', { session: 'cursor-c', command: 'echo first', timeout: 10_000 });
  const live = registry.get('cursor-c');
  assert.ok(live?.kind === 'live');
  const before = live.session.cursorsOf(A.principal).read;
  const tail = await callTool('tailLogs', { session: 'cursor-c', lines: 20 }, { app, caller: deferred, resultText: 'json' }, compat);
  assert.match(tail.text, /first/);
  assert.equal(live.session.cursorsOf(A.principal).read, before, 'nothing moved before the write');
  assert.equal(typeof tail.onSent, 'function', 'the result carries its commit');
  tail.onSent!();
  const afterTail = live.session.cursorsOf(A.principal).read;
  assert.ok(afterTail > before, 'written: the cursor covers what tailLogs showed');
  const ran = await callTool('runCommand', { session: 'cursor-c', command: 'echo second', timeout: 10_000 }, { app, caller: deferred, resultText: 'json' }, compat);
  assert.match(ran.text, /second/);
  assert.equal(live.session.cursorsOf(A.principal).read, afterTail, 'the paged output moved nothing before the write');
  ran.onSent!();
  assert.ok(live.session.cursorsOf(A.principal).read > afterTail, 'written: the cursor covers the output pages too');
  await call('killSession', { session: 'cursor-c' });
});

// ───────────── the house's read of 78c4d6e (#22): compat ─────────────

test('78c4d6e 7 and 8: launch’s start keeps another Run’s unread output unread, and the tail it shows moves no cursor', async () => {
  const deferred: Caller = { principal: A.principal, connectionId: 'ca-ws78', deferReadDelivery: true };
  await callTool('session_open', { session: 'lc' }, { app, caller: A, resultText: 'json' }, compat);
  // A process Run's output, left unread: a deferred runCommand whose result is never written.
  const ran = JSON.parse((await callTool('runCommand', { session: 'lc', command: 'seq 1 300', timeout: 20_000 }, { app, caller: deferred, resultText: 'json' }, compat)).text) as { runId: string; state: string };
  assert.equal(ran.state, 'exited');
  const live = registry.get('lc');
  assert.ok(live?.kind === 'live');
  const firstOut = live.session.runOutput(ran.runId).events.find((e) => e.type === 'output')!.seq;
  assert.equal(live.session.cursorsOf(A.principal).read, 0, 'the run’s output was never delivered: unread');
  // A launch in the same session: its tail shows the last lines, its own service Run starts after them.
  const launched = await callTool('launch', { name: 'lc', command: 'sleep 30' }, { app, caller: deferred, resultText: 'json' }, compat);
  assert.equal(live.session.cursorsOf(A.principal).read, 0, 'nothing committed before the write');
  launched.onSent?.();
  assert.equal(live.session.cursorsOf(A.principal).read, 0, 'launch previews output without marking it read');
  assert.ok(live.session.cursorsOf(A.principal).read < firstOut, 'the earlier Run remains unread');
  assert.notEqual(live.session.cursorsOf(A.principal).read, live.session.journal.lastSeq, 'not the journal end');
  await call('killSession', { session: 'lc', graceful: false });
});

test('G22: compat launch leaves omitted start output unread for direct and deferred callers', async () => {
  const command = "for n in $(seq 1 80); do printf 'OLD-%s\\n' \"$n\"; done; echo SERVICE-READY; sleep 30";
  const deferred: Caller = { principal: A.principal, connectionId: 'ca-ws-launch-preview', deferReadDelivery: true };
  for (const [mode, caller] of [['direct', A], ['deferred', deferred]] as const) {
    const s = `launch-preview-${mode}`;
    await app.sessionOpen(A, { id: s });
    const live = registry.get(s);
    assert.ok(live?.kind === 'live');
    const before = live.session.cursorsOf(A.principal).read;
    const launched = await callTool('launch', { name: s, command, readyPatterns: ['SERVICE-READY'] }, { app, caller, resultText: 'json' }, compat);
    assert.equal(launched.isError, undefined, `${mode}: ${launched.text}`);
    const logs = (launched.structured as { logs: string[] }).logs;
    assert.ok(logs.some((l) => l.includes('SERVICE-READY')), `${mode}: the latest service output is returned`);
    assert.ok(!logs.includes('OLD-1'), `${mode}: the bounded response omitted the first start-output line`);
    assert.equal(live.session.cursorsOf(A.principal).read, before, `${mode}: preparing the preview moves no cursor`);
    launched.onSent?.();
    assert.equal(live.session.cursorsOf(A.principal).read, before, `${mode}: writing the preview moves no cursor`);
    const runId = (launched.structured as { runId: string }).runId;
    await app.cancel(A, { session: s, runId });
  }
});

test('78c4d6e 18: a many-page runCommand advances the deferred cursor across every page once written', async () => {
  const deferred: Caller = { principal: A.principal, connectionId: 'ca-ws18', deferReadDelivery: true };
  // About 0.86 MB of output (15,000 lines of about 57 bytes with CRLF): runOutput pages it in four 256 KiB pages,
  // and Drawn carries every page's commit, not its text.
  const ran = await callTool('runCommand', { session: 'pages', command: "awk 'BEGIN { for (i = 1; i <= 15000; i++) print i, \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" }'", timeout: 30_000 }, { app, caller: deferred, resultText: 'json' }, compat);
  const runId = (JSON.parse(ran.text) as { runId: string }).runId;
  const live = registry.get('pages');
  assert.ok(live?.kind === 'live');
  const outs = live.session.runOutput(runId).events.filter((e) => e.type === 'output');
  const runEnd = outs[outs.length - 1]!.seq;
  assert.ok(outs.length > 1, 'the output spans several events (pages)');
  assert.equal(live.session.cursorsOf(A.principal).read, 0, 'nothing before the write');
  assert.equal(typeof ran.onSent, 'function');
  ran.onSent!();
  // Every page's commit lands: the cursor covers the Run's whole output (and its end boundary), not a single page.
  assert.ok(live.session.cursorsOf(A.principal).read >= runEnd, `the cursor covers all of the paged output once written (${live.session.cursorsOf(A.principal).read} >= ${runEnd})`);
  await call('killSession', { session: 'pages', graceful: false });
});

test('78c4d6e 12: a program line in a mark’s shape with no Run’s nonce survives tailLogs and searchLogs; a real Run’s plumbing is still cut', async () => {
  await call('runCommand', { session: 'shape', command: 'echo real-output' });
  // A process Run in the same window records no strategy and no nonce; that is not a Run from before the
  // recording, and must not put the filter back on shapes (a review of the fix, #22).
  await app.run(A, { session: 'shape', command: 'true', target: 'process', wait: 5000 });
  const live = registry.get('shape');
  assert.ok(live?.kind === 'live');
  // A program prints something shaped like an end marker, under a nonce no Run here recorded.
  live.session.journal.append({ type: 'output', data: 'program prints <<<EXIT:deadbeef00:0>>> itself\r\n', stream: 'pty' });
  const tail = lines(await call('tailLogs', { session: 'shape', lines: 50 }));
  assert.ok(tail.some((l) => l.includes('<<<EXIT:deadbeef00:0>>>')), `the program’s own line is not the daemon’s plumbing: ${JSON.stringify(tail)}`);
  assert.ok(!tail.some((l) => l.includes('tsm-cmd-')), 'the real typed line is still cut');
  const found = (await call('searchLogs', { session: 'shape', pattern: 'program prints' })) as unknown as Array<{ line: string }>;
  assert.ok(found.length >= 1 && found[0]!.line.includes('<<<EXIT:deadbeef00:0>>>'), JSON.stringify(found));
});

test('78c4d6e 14: a raw tail marks a hole where output was lost, rather than running lines across it', async () => {
  await call('runCommand', { session: 'holes', command: 'echo before-hole' });
  const live = registry.get('holes');
  assert.ok(live?.kind === 'live');
  const j = live.session.journal;
  // A gap in the middle of the output, as a torn write or a store failure leaves one.
  j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 3, reason: 'store-error' });
  j.append({ type: 'output', data: 'after-hole\r\n', stream: 'pty' });
  const raw = lines(await call('tailLogs', { session: 'holes', lines: 50, raw: true }));
  assert.ok(raw.some((l) => /journal event.*missing/.test(l)), `the hole is marked, not run across: ${JSON.stringify(raw)}`);
  assert.ok(raw.some((l) => l.includes('before-hole')) && raw.some((l) => l.includes('after-hole')));
});

test('78c4d6e 15 and 16: launch carries tailLogs’ cut note, and the advised page reaches what came before', async () => {
  // Sixty lines of 25,000 bytes: a 50-line tail is over the 1 MiB bound, so the tail is cut and names
  // where a read of what came before ends (item 16). launch into the same session carries that note (item 15).
  await call('runCommand', { session: 'cutnote', command: "awk 'BEGIN { for (i = 0; i < 25000; i++) s = s \"y\"; for (i = 1; i <= 60; i++) print i, s }'", timeout: 30_000 });
  const tail = lines(await call('tailLogs', { session: 'cutnote', lines: 50 }));
  const note = tail.find((l) => l.startsWith('[earlier output not shown'));
  assert.ok(note, `the cut is said: ${JSON.stringify(tail.slice(0, 1))}`);
  const m = /read (\{"session": "cutnote", "tail": 50, "until": \d+(?:, "untilOffset": \d+)?\}) shows what came before/.exec(note!);
  assert.ok(m, note);
  // The advised read ends right where the first line shown begins: its last line is the one just before,
  // so no line falls in neither page and none is in both (the house's read of the 38 commits, #22).
  // (The window may begin right at a line's start; the reader cannot tell that from what it read, and marks the line as cut.)
  const shown = Number(/^…?(\d+) y/.exec(tail[1]!)?.[1]);
  assert.ok(shown > 1, tail[1]!.slice(0, 20));
  const earlier = (await call('read', { ...(JSON.parse(m![1]!) as Obj), maxBytes: 1024 * 1024 })) as unknown as { text: string };
  assert.equal(/^(\d+) y/.exec(earlier.text.split('\n').at(-1)!)?.[1], String(shown - 1));

  const launched = await call('launch', { name: 'cutnote', command: 'echo started' });
  assert.ok(lines(launched.logs).some((l) => l.startsWith('[earlier output not shown')), `launch keeps the note: ${JSON.stringify(lines(launched.logs).slice(0, 1))}`);
  await call('killSession', { session: 'cutnote', graceful: false });
});

test('78c4d6e: searchLogs reports the holes it spanned and the lines it searched on their head only', async () => {
  await call('runCommand', { session: 'snotes', command: 'echo findme-here' });
  const live = registry.get('snotes');
  assert.ok(live?.kind === 'live');
  const j = live.session.journal;
  j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 2, reason: 'store-error' });
  j.append({ type: 'output', data: 'findme-again\r\n', stream: 'pty' });
  // A matching line longer than the pattern's match window (64 KiB) is matched on its head only (the house's read of the 38 commits, #22).
  j.append({ type: 'output', data: `findme-long ${'w'.repeat(70_000)}\r\n`, stream: 'pty' });
  const out = (await call('searchLogs', { session: 'snotes', pattern: 'findme' })) as unknown as Array<{ line?: string; note?: string }>;
  const note = out.find((m) => m.note !== undefined)?.note;
  assert.ok(note && /missing/.test(note), `the hole is noted: ${JSON.stringify(out)}`);
  assert.match(note!, /1 line longer than the match window, searched on its head only/);
  assert.ok(out.some((m) => m.line?.startsWith('findme-long ')), 'the long line still matched on its head');
});

test('the 38 commits 6: a first line cut at its head is named with the read that shows it from its head, and that read does', async () => {
  // One line longer than the 1 MiB the tail reads: shown as its last MiB, marked; the note's head-first read begins at its head.
  await call('runCommand', { session: 'hugeline', command: 'echo before-the-line' });
  const live = registry.get('hugeline');
  assert.ok(live?.kind === 'live');
  // After the prompt, on a line of its own, so the line's head is known.
  await until(() => live.session.shellAvailable().ok, 5000, 'the prompt');
  live.session.journal.append({ type: 'output', data: `\r\nHEAD-${'z'.repeat(1_200_000)}-TAIL\r\n`, stream: 'pty' });
  const tail = lines(await call('tailLogs', { session: 'hugeline', lines: 1 }));
  assert.equal(tail.length, 2, JSON.stringify(tail.map((l) => l.slice(0, 40))));
  assert.ok(tail[1]!.startsWith('…z') && tail[1]!.endsWith('-TAIL'), tail[1]!.slice(0, 20));
  const m = /; read (\{"session": "hugeline", "tail": 1, "until": \d+(?:, "untilOffset": \d+)?\}) shows what came before; read (\{"session": "hugeline", "since": \d+(?:, "offset": \d+)?\}) shows the first line below from its head\]$/.exec(tail[0]!);
  assert.ok(m, tail[0]);
  const head = (await call('read', JSON.parse(m![2]!) as Obj)) as unknown as { text: string; splitLine?: boolean };
  assert.ok(head.text.startsWith('HEAD-zzz'), `the promise: the read begins at the line's head: ${head.text.slice(0, 20)}`);
  // What came before, five lines of it: up to the line's start, without the line.
  const before = (await call('read', { ...(JSON.parse(m![1]!) as Obj), tail: 5 })) as unknown as { text: string };
  assert.ok(before.text.split('\n').some((l) => l.includes('before-the-line')) && !before.text.includes('HEAD-'), `what came before, without the cut line: ${JSON.stringify(before.text)}`);
  await call('killSession', { session: 'hugeline', graceful: false });
});

test('a reviewer’s read: a first line begun before the tail’s 1 MiB is said to be read on from where the page before ends, not from its head', async () => {
  // The line in 2,000 events of 1,000 bytes, so the tail's window (1 MiB, walked back 512 events at a time)
  // starts in its middle: the note promised the line's head, and its head-first read began at the window's
  // start (a reviewer's read of the fixes for #22).
  await call('runCommand', { session: 'begunline', command: 'echo before-the-line' });
  const live = registry.get('begunline');
  assert.ok(live?.kind === 'live');
  await until(() => live.session.shellAvailable().ok, 5000, 'the prompt');
  const line = `HEAD-${'z'.repeat(2_000_000)}-TAIL`;
  live.session.journal.append({ type: 'output', data: '\r\n', stream: 'pty' });
  for (let i = 0; i < line.length; i += 1000) live.session.journal.append({ type: 'output', data: line.slice(i, i + 1000), stream: 'pty' });
  live.session.journal.append({ type: 'output', data: '\r\n', stream: 'pty' });
  const tail = lines(await call('tailLogs', { session: 'begunline', lines: 1 }));
  assert.equal(tail.length, 2, JSON.stringify(tail.map((l) => l.slice(0, 40))));
  assert.ok(tail[1]!.startsWith('…z') && tail[1]!.endsWith('-TAIL'));
  const m = /; read (\{"session": "begunline", "tail": 1, "until": \d+\}) shows what came before, ending with the earlier part of the first line below; read (\{"session": "begunline", "since": \d+\}) shows that line on from where that page ends\]$/.exec(tail[0]!);
  assert.ok(m, tail[0]);
  const on = (await call('read', JSON.parse(m![2]!) as Obj)) as unknown as { text: string };
  assert.ok(on.text.startsWith('zzz'), `on from the window's start, mid-line: ${on.text.slice(0, 20)}`);
  // The page before ends right there, with the line's earlier part (its head further back still).
  const before = (await call('read', { ...(JSON.parse(m![1]!) as Obj), maxBytes: 1024 * 1024 })) as unknown as { text: string };
  assert.ok(before.text.endsWith('zzz') && !before.text.includes('-TAIL'), 'the page before ends with the line’s earlier part');
  await call('killSession', { session: 'begunline', graceful: false });
});

test('a reviewer’s read: a declared shell’s typed body, its start mark and its pieces’ marks stay out of the logs, and a program’s mark-shaped line stays in', async () => {
  // compat cut by its own copy of the marker strategy's shapes: a declared sh's typed body and its
  // `<<<START:…>>>` showed in tailLogs (a reviewer's read of the fixes for #22).
  const opened = await call('runCommand', { session: 'declog', command: 'sh', timeout: -1 });
  await until(() => summary('declog')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'sh in front');
  await call('session_declare_shell', { session: 'declog', shell: 'sh' });
  assert.equal((await call('runCommand', { session: 'declog', command: 'echo declared-hello' })).exitCode, 0);
  // A body longer than one typed line goes in pieces, each acknowledged by a mark.
  const long = `echo long-${'x'.repeat(1500)}`;
  assert.equal((await call('runCommand', { session: 'declog', command: long })).exitCode, 0);
  assert.equal((await call('runCommand', { session: 'declog', command: 'echo "<<<START:abc:12>>> a program line"' })).exitCode, 0);
  await until(() => summary('declog')?.runs?.every((x) => x.runId === opened.runId || x.state === 'exited') === true, 5000, 'the Runs ended');
  const live = registry.get('declog');
  assert.ok(live?.kind === 'live');
  const nonces = live.session.listRuns().flatMap((r) => (r.nonce === undefined ? [] : [r.nonce]));
  assert.ok(nonces.length >= 3, JSON.stringify(nonces));
  for (const raw of [false, true]) {
    const tail = lines(await call('tailLogs', { session: 'declog', lines: 40, raw }));
    const said = `raw ${raw}: ${JSON.stringify(tail.map((l) => l.slice(0, 80)))}`;
    assert.ok(!tail.some((l) => l.includes('__tsm_')), `no typed body: ${said}`);
    assert.ok(!tail.some((l) => nonces.some((n) => l.includes(n))), `no mark of the Runs': ${said}`);
    const at = tail.indexOf('$ echo declared-hello');
    assert.ok(at >= 0 && tail[at + 1] === 'declared-hello', `the command line, then its output: ${said}`);
    assert.ok(tail.includes(`long-${'x'.repeat(1500)}`), said);
    assert.ok(tail.includes('<<<START:abc:12>>> a program line'), `a mark-shaped line with no Run's nonce is the program's: ${said}`);
  }
  await call('killSession', { session: 'declog', graceful: false });
});

test('a declared shell’s Run: runCommand’s output and read {runId} carry no marks, as text and raw (our read of the house’s fixes for its review of f3750e4, PR #22; older than them)', async () => {
  // runCommand paged the Run through read {runId}, which cut nothing: `\nviacompat\n<<<EXIT:…:0>>>`, while the run's own result was clean.
  const opened = await call('runCommand', { session: 'declout', command: 'sh', timeout: -1 });
  await until(() => summary('declout')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'sh in front');
  await call('session_declare_shell', { session: 'declout', shell: 'sh' });
  const text = await call('runCommand', { session: 'declout', command: 'echo single' });
  assert.equal(text.exitCode, 0, JSON.stringify(text));
  assert.equal(text.output, 'single', JSON.stringify(text.output));
  // read {runId} pages the Run as its own result shows it, and runCommand's text is those pages.
  const read = (await call('read', { session: 'declout', runId: text.runId })) as unknown as { text: string };
  assert.equal(read.text, 'single', JSON.stringify(read.text));
  const raw = await call('runCommand', { session: 'declout', command: 'printf "\\033[1mbold\\033[0m\\n"; printf no-newline', raw: true });
  assert.equal(raw.output, '\x1b[1mbold\x1b[0m\r\nno-newline', JSON.stringify(raw.output));
  await call('killSession', { session: 'declout', graceful: false });
});

test('a declared shell’s two-line command shows in the logs with no empty line under it: the start mark’s line end is struck after the heading’s every line (our read of the house’s fixes for its review of f3750e4, PR #22: e8a8d52)', async () => {
  // The empty line a start mark's line end leaves was struck one line after a `$ <command>` heading, whatever the command's lines.
  const opened = await call('runCommand', { session: 'declml', command: 'sh', timeout: -1 });
  await until(() => summary('declml')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'sh in front');
  await call('session_declare_shell', { session: 'declml', shell: 'sh' });
  assert.equal((await call('runCommand', { session: 'declml', command: 'echo first\necho second' })).exitCode, 0);
  assert.equal((await call('runCommand', { session: 'declml', command: 'echo single' })).exitCode, 0);
  for (const raw of [false, true]) {
    const tail = lines(await call('tailLogs', { session: 'declml', lines: 20, raw }));
    const at = tail.indexOf('$ echo first');
    assert.deepEqual(tail.slice(at, at + 4), ['$ echo first', 'echo second', 'first', 'second'], `raw ${raw}: ${JSON.stringify(tail)}`);
    const one = tail.indexOf('$ echo single');
    assert.deepEqual(tail.slice(one, one + 2), ['$ echo single', 'single'], `raw ${raw}: ${JSON.stringify(tail)}`);
  }
  await call('killSession', { session: 'declml', graceful: false });
});

test('a reviewer’s read: the probe line a cancel types into a declared shell stays out of the logs, cut by the cutter’s own matcher', async () => {
  // The program ignores ^C, so the session types its end-marker probe (plumbing.ts inlineProbe) before it
  // escalates; compat struck that line's echo with a copy of the builders, now with probeEcho itself.
  const opened = await call('runCommand', { session: 'probelog', command: 'bash --norc --noprofile', timeout: -1 });
  await until(() => summary('probelog')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'bash in front');
  await call('session_declare_shell', { session: 'probelog', shell: 'bash' });
  const stuck = await call('runCommand', { session: 'probelog', command: '(trap "" INT; sleep 5)', timeout: 500 });
  assert.equal(stuck.state, 'running', JSON.stringify(stuck));
  const cancelled = await app.cancel(A, { runId: String(stuck.runId) });
  assert.match(cancelled.steps.join(' '), /end-marker probe/, 'the probe was typed');
  assert.equal((await call('runCommand', { session: 'probelog', command: 'echo after-the-cancel' })).exitCode, 0);
  const live = registry.get('probelog');
  assert.ok(live?.kind === 'live');
  // The echo can come in pieces across many small output events: looked for in them joined, on one page.
  const page = await app.read(A, { session: 'probelog', since: 0, as: 'events', limit: 2000, maxBytes: 1024 * 1024, advance: false });
  assert.equal(page.more, false);
  const output = page.events!.map((e) => (e.type === 'output' ? e.data : '')).join('');
  assert.ok(probeEcho().test(output), 'the probe line’s echo is in the journal');
  for (const raw of [false, true]) {
    const tail = lines(await call('tailLogs', { session: 'probelog', lines: 40, raw }));
    const said = `raw ${raw}: ${JSON.stringify(tail)}`;
    assert.ok(!tail.some((l) => /PRO''BE|<<<PROBE/.test(l)), `no probe line, no probe answer: ${said}`);
    assert.ok(tail.includes('$ (trap "" INT; sleep 5)') && tail.includes('after-the-cancel'), said);
  }
  await call('killSession', { session: 'probelog', graceful: false });
});

test('the 38 commits: a raw tail that reaches its 1 MiB bound says so, and the page it advises ends right where its lines begin', async () => {
  // No spec reached rawTail's byte bound (the house's read of the 38 commits, #22): 150 lines of 20,000 bytes
  // (3 MB), each in three events, so the 50 lines asked for and the redraw room the tail reads for need more
  // than the bound holds while older output remains.
  await call('runCommand', { session: 'rawbound', command: 'echo start' });
  const live = registry.get('rawbound');
  assert.ok(live?.kind === 'live');
  for (let i = 1; i <= 150; i++) {
    const line = `${i} ${'y'.repeat(20_000)}\r\n`;
    for (let at = 0; at < line.length; at += 7000) live.session.journal.append({ type: 'output', data: line.slice(at, at + 7000), stream: 'pty' });
  }
  const raw = lines(await call('tailLogs', { session: 'rawbound', lines: 50, raw: true }));
  assert.equal(raw.length, 51, `the lines asked for, after the note: ${raw.length}`);
  const m = /^\[earlier output not shown \(the raw tail reached its byte or page bound\); read (\{"session": "rawbound", "tail": 50, "until": \d+(?:, "untilOffset": \d+)?\}) shows what came before\]$/.exec(raw[0]!);
  assert.ok(m, raw[0]);
  // The first line shown is whole, among the last of the 150 (a raw tail keeps the empty line after the last line end).
  const shown = Number(/^(\d+) y/.exec(raw[1]!)?.[1]);
  assert.ok(shown >= 100 && shown <= 102, raw[1]!.slice(0, 20));
  const earlier = (await call('read', { ...(JSON.parse(m![1]!) as Obj), maxBytes: 1024 * 1024 })) as unknown as { text: string };
  assert.equal(Number(/^(\d+) y/.exec(earlier.text.split('\n').at(-1)!)?.[1]), shown - 1, 'the page before ends with the line just before: nothing in neither page');
  await call('killSession', { session: 'rawbound', graceful: false });
});

test('the 38 commits 5: a queued shell Run does not turn shape-only cutting on while it waits', async () => {
  await call('runCommand', { session: 'qshape', command: 'echo ready' });
  const running = await app.run(A, { session: 'qshape', command: 'sleep 5', wait: 0 });
  const queued = await app.run(A, { session: 'qshape', command: 'echo after', queue: true, wait: 0 });
  assert.equal(queued.state, 'queued', JSON.stringify(queued));
  const live = registry.get('qshape');
  assert.ok(live?.kind === 'live');
  // A Run with neither strategy nor nonce read as one journaled before the recording: every mark-shaped line was cut by shape.
  live.session.journal.append({ type: 'output', data: 'program prints <<<EXIT:deadbeef00:0>>> while one waits\r\n', stream: 'pty' });
  const tail = lines(await call('tailLogs', { session: 'qshape', lines: 50 }));
  assert.ok(tail.some((l) => l.includes('<<<EXIT:deadbeef00:0>>>')), `the program's line is not the daemon's: ${JSON.stringify(tail)}`);
  for (const r of [queued, running]) await app.cancel(A, { runId: r.runId! });
  await call('killSession', { session: 'qshape', graceful: false });
});

test('6270946953: launch’s watch for error patterns is measured on the monotonic clock: a wall-clock jump neither ends it early nor stretches it', async (t) => {
  const real = Date.now.bind(Date);
  let lag = 0;
  t.mock.method(Date, 'now', () => real() + lag);
  try {
    // The error line comes after the 2 s liveness window, so launch has answered `running` to itself and is polling when it appears.
    const launching = call('launch', { name: 'mono', command: 'sleep 3; echo FATAL-77; sleep 30', errorPatterns: ['FATAL-77'] });
    await until(() => summary('mono')?.services?.some((v) => v.status === 'running') === true, 8000, 'the service to be running (the poll has begun)');
    // The wall clock jumps an hour ahead: a watch measured on it would be past its deadline at once and answer `running`.
    lag = 3_600_000;
    const r = await launching;
    assert.equal(r.status, 'error', JSON.stringify(r));
    assert.equal(r.service, 'unhealthy');
    assert.match(String(r.evidence), /FATAL-77/);
  } finally {
    lag = 0;
    await call('killSession', { session: 'mono', graceful: false });
  }
});

// ───────────── a reviewer's read of the fixes for #22 comment 6270045466: the marker strategy's plumbing in the logs ─────────────

/** A registry over the scripted shell with no integration marks: Runs take the marker strategy, and their plumbing is printed as marks with a recorded nonce. */
async function markerHarness(): Promise<{ app: App; registry: SessionRegistry; shells: FakeShell[]; call(name: string, args: Obj): Promise<Obj & unknown[]>; close(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-compat-marker-'));
  const shells: FakeShell[] = [];
  const backend = fakeShellBackend(
    (sh) => {
      sh.on(/^echo /, (line) => ({ output: `${line.slice(5)}\r\n`, exit: 0 }));
      sh.on(/^sleep/, () => ({ hang: true }));
      shells.push(sh);
    },
    { marks: 'none' },
  );
  const registry = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 2000 });
  return {
    app,
    registry,
    shells,
    call: async (name, args) => JSON.parse((await callTool(name, args, { app, caller: A, resultText: 'json' }, compat)).text) as Obj & unknown[],
    close: async () => {
      await registry.closeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A marker Run left running in `session`: its nonce is recorded, and its range reaches everything appended while it runs. */
async function hungMarkerRun(h: Awaited<ReturnType<typeof markerHarness>>, session: string): Promise<{ nonce: string; journal: import('../src/core/journal.js').Journal }> {
  const hung = await h.call('runCommand', { session, command: 'sleep 99', timeout: -1 });
  const live = h.registry.get(session);
  assert.ok(live?.kind === 'live');
  const run = live.session.listRuns().find((r) => r.runId === hung.runId)!;
  assert.equal(run.strategy, 'marker', JSON.stringify(run));
  assert.ok(run.nonce, 'the marker Run recorded its nonce');
  return { nonce: run.nonce!, journal: live.session.journal };
}

test('a marker Run’s runCommand output is its command’s alone: no typed line, no start or end mark, no prompt after it, as text and raw (our read of the house’s fixes for its review of f3750e4, PR #22)', async () => {
  // Under the marker strategy (dash, an unknown sh) the Run's range holds the typed line's echo, the start mark, the end
  // mark and the prompt the shell printed after it, and runCommand returned them all, paged through read {runId}.
  const h = await markerHarness();
  try {
    const text = await h.call('runCommand', { session: 'mout', command: 'echo hi' });
    assert.deepEqual([text.exitCode, text.output], [0, 'hi'], JSON.stringify(text));
    const raw = await h.call('runCommand', { session: 'mout', command: 'echo there', raw: true });
    assert.deepEqual([raw.exitCode, raw.output], [0, 'there\r\n'], JSON.stringify(raw));
  } finally {
    await h.close();
  }
});

test('a text tail names its first line’s source by the nearest header before it, wherever it sits, as the reader’s tail does (our read of the house’s fixes for its review of f3750e4, PR #22: c050928)', async () => {
  // compat kept a header only when it sat just before the first line kept: a tail of 2 over a Run's `a1` to `a3`
  // then the pty's `p2` began with `a3`, unnamed, where read's tail begins with `[run rx]`.
  const h = await markerHarness();
  try {
    await h.call('runCommand', { session: 'hdr', command: 'echo ready' });
    const live = h.registry.get('hdr');
    assert.ok(live?.kind === 'live');
    const j = live.session.journal;
    j.append({ type: 'run.admit', runId: 'rx', target: 'process', principal: A.principal, origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'rx', cwd: '/' });
    j.append({ type: 'output', data: 'a1\na2\na3\n', stream: 'stdout', runId: 'rx' });
    j.append({ type: 'output', data: 'p2\r\n', stream: 'pty' });
    // The pty's line follows the scripted shell's prompt; what matters is the head.
    for (const [n, head] of [
      [2, ['[run rx]', 'a3', '[terminal]']],
      [3, ['[run rx]', 'a2', 'a3', '[terminal]']],
    ] as const) {
      const tail = lines(await h.call('tailLogs', { session: 'hdr', lines: n }));
      assert.deepEqual(tail.slice(0, head.length), head, `${n}: ${JSON.stringify(tail)}`);
      assert.match(tail[head.length]!, /p2$/, JSON.stringify(tail));
      const read = (await h.app.read(A, { session: 'hdr', tail: n, advance: false })).text!.split('\n');
      assert.deepEqual(read, tail, `read's tail of ${n} is the same lines`);
    }
    // A first line shown without its head is marked, not the header naming its source before it: one progress
    // line longer than the 1 MiB the tail reads, which shows as `done`.
    let progress = '';
    for (let i = 0; i < 90_000; i++) progress += `\r${String(i).padStart(12)}`;
    j.append({ type: 'output', data: `${progress}\rdone        \n`, stream: 'stdout', runId: 'rx' });
    j.append({ type: 'output', data: 'p3\r\n', stream: 'pty' });
    const cut = lines(await h.call('tailLogs', { session: 'hdr', lines: 2 }));
    const said = JSON.stringify(cut.map((l) => l.slice(0, 40)));
    assert.match(cut[0]!, /^\[earlier output not shown/, said);
    assert.deepEqual(cut.slice(1, 4), ['[run rx]', '…done', '[terminal]'], said);
  } finally {
    await h.close();
  }
});

test('runCommand’s raw output says where a hole lies, with the note its text output shows, between the raw pieces (an independent read of the fixes for the review of f3750e4, PR #22; older than them)', async () => {
  // The raw path joined the output on both sides of a hole with nothing between: the hole was only in the reads' `gap`.
  const h = await markerHarness();
  try {
    await h.call('runCommand', { session: 'holed', command: 'echo ready' });
    const live = h.registry.get('holed');
    assert.ok(live?.kind === 'live');
    for (const raw of [false, true]) {
      const pending = h.call('runCommand', { session: 'holed', command: 'sleep 9', raw, timeout: 5000 });
      await until(() => live.session.listRuns().some((r) => r.line === 'sleep 9' && r.state === 'running'), 5000, 'the Run to be running');
      const runId = live.session.listRuns().find((r) => r.line === 'sleep 9' && r.state === 'running')!.runId;
      const j = live.session.journal;
      j.append({ type: 'output', data: 'before\r\n', stream: 'pty', runId, attribution: 'temporal' });
      j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 1, reason: 'store-error' });
      j.append({ type: 'output', data: 'after\r\n', stream: 'pty', runId, attribution: 'temporal' });
      h.shells[h.shells.length - 1]!.finishHung(0);
      const r = await pending;
      assert.equal(r.exitCode, 0, JSON.stringify(r));
      const hole = /\[… (?:up to )?1 journal event missing \(seq \d+–\d+: [^)]+\) …\]/.source;
      assert.match(String(r.output), new RegExp(raw ? `^before\\r\\n${hole}\\nafter\\r\\n$` : `^before\\n${hole}\\nafter$`), `raw ${raw}: ${JSON.stringify(r.output)}`);
    }
  } finally {
    await h.close();
  }
});

test('a reviewer’s read: the logs drop the line that runs a command file for every shell flavor the session types for, fish’s marker line included', async () => {
  // compat's hand copy of these lines had none for fish's marker strategy; it is now derived from the session's builder.
  const h = await markerHarness();
  try {
    const { nonce, journal } = await hungMarkerRun(h, 'srcline');
    let k = 100;
    for (const flavor of ['posix', 'zsh', 'fish'] as const) {
      for (const n of [undefined, nonce]) journal.append({ type: 'output', data: `prompt$ ${sourceLine(`/tmp/tsm-501/ab12/${commandFile(k++)}`, flavor, n)}\r\nran-${flavor}-${n ? 'marker' : 'integrated'}\r\n`, stream: 'pty' });
    }
    for (const raw of [false, true]) {
      const tail = lines(await h.call('tailLogs', { session: 'srcline', lines: 30, raw }));
      const said = `raw ${raw}: ${JSON.stringify(tail)}`;
      assert.ok(!tail.some((l) => l.includes('tsm-cmd-') || l.includes('EXI""T')), `no typed line: ${said}`);
      assert.equal(tail.filter((l) => l === 'prompt$').length, 6, `each prompt stays: ${said}`);
      assert.equal(tail.filter((l) => l.startsWith('ran-')).length, 6, said);
    }
  } finally {
    await h.close();
  }
});

test('the 33 commits 4, an independent read of its fix: the logs’ probe filter costs the same however many Runs’ nonces the text holds', async () => {
  // A pattern listing every nonce a reader knew, rebuilt per call, took searchLogs 1.9 s on 200 short lines with 300 nonces and
  // 39 s with 3,000. Here 200 lines hold a `<` and 3,000 marks of other Runs, and the reads stay quick.
  const h = await markerHarness();
  try {
    const { journal } = await hungMarkerRun(h, 'manynonces');
    const hex = (i: number) => (0x10000000 + i * 7919).toString(16).slice(-8);
    let k = 0;
    const line = (i: number) => `match-me ${i} <tag> a < b ${Array.from({ length: 15 }, () => `<<<EXIT:${hex(k++)}:0>>>`).join(' ')}`;
    journal.append({ type: 'output', data: `${Array.from({ length: 200 }, (_, i) => line(i)).join('\r\n')}\r\n`, stream: 'pty' });
    const t = performance.now();
    const found = (await h.call('searchLogs', { session: 'manynonces', pattern: 'match-me' })) as unknown as unknown[];
    const tail = lines(await h.call('tailLogs', { session: 'manynonces', lines: 200 }));
    const ms = performance.now() - t;
    assert.ok(found.length >= 100, `${found.length} matches`);
    assert.equal(tail.filter((l) => l.startsWith('match-me')).length, 200);
    // Seconds on the old filter; tens of milliseconds now, and the bound leaves room for a loaded machine.
    assert.ok(ms < 1500, `${Math.round(ms)} ms`);
  } finally {
    await h.close();
  }
});

test('the 33 commits 4: a probe line whose nonce a redraw broke over two lines leaves neither line in the logs, for a Run’s recorded nonce and for one a mark in the text carries', async () => {
  // The house's read of the 33 commits (#22, comment 6307351104): with no nonce the probe filter matched `<<<PRO''BE:a1b2` and
  // stopped at the break, so the next line, `c3d4:%s:%s>>>\n' "$$" "${__tsm_r-}"`, stayed in compat's logs.
  const h = await markerHarness();
  try {
    const { nonce, journal } = await hungMarkerRun(h, 'brokenprobe');
    const broken = (line: string, n: string) => line.replace(n, () => `${n.slice(0, 4)}\r\n${n.slice(4)}`);
    journal.append({ type: 'output', data: `^C\r\n$${broken(markerProbe(nonce), nonce)}\r\nkept-1\r\n`, stream: 'pty' });
    journal.append({ type: 'output', data: `$${broken(inlineProbe(nonce, false), nonce)}\r\nkept-2\r\n`, stream: 'pty' });
    // A nonce no Run here recorded, which the probe's answer in the text carries.
    const other = 'feedface';
    journal.append({ type: 'output', data: `$${broken(inlineProbe(other, true), other)}\r\n<<<PROBE:${other}:77:${other}>>>\r\nkept-3\r\n`, stream: 'pty' });
    for (const raw of [false, true]) {
      const tail = lines(await h.call('tailLogs', { session: 'brokenprobe', lines: 40, raw }));
      const said = `raw ${raw}: ${JSON.stringify(tail)}`;
      assert.ok(!tail.some((l) => /%s|PRO""BE|PRO''BE|>>>"/.test(l)), `no piece of a probe line: ${said}`);
      assert.ok(['^C', 'kept-1', 'kept-2', 'kept-3'].every((k) => tail.includes(k)), `the output around them stays: ${said}`);
    }
  } finally {
    await h.close();
  }
});

test("an echo of the inline probe as earlier builds typed it, broken after its nonce, leaves no piece of its line in the logs (the house's review of 4860d4c..bc4bc85, PR #22)", async () => {
  // Journals keep what earlier builds typed: the probe naming the shell's `$$`, then the evaluating process's with no fallback.
  // Their rests weren't among the probe lines', so an echo broken after its nonce kept `:%s:%s>>>\n' "$$" "${__tsm_r-}"`.
  const h = await markerHarness();
  try {
    const { nonce, journal } = await hungMarkerRun(h, 'earlierprobe');
    const head = (n: string) => ` printf '<<<PRO''BE:${n}\r\n:%s:%s>>>\\n' `;
    const pids = ['"$$"', `"$(exec /bin/sh -c 'echo $PPID')"`];
    pids.forEach((pid, i) => journal.append({ type: 'output', data: `$${head(nonce)}${pid} "\${__tsm_r-}"\r\nkept-${i + 1}\r\n`, stream: 'pty' }));
    // And for a nonce no Run here recorded, which the probe's answer in the text carries.
    const other = 'feedface';
    journal.append({ type: 'output', data: `$${head(other)}"$$" "\${__tsm_r-}"\r\n<<<PROBE:${other}:77:${other}>>>\r\nkept-3\r\n`, stream: 'pty' });
    for (const raw of [false, true]) {
      const tail = lines(await h.call('tailLogs', { session: 'earlierprobe', lines: 40, raw }));
      const said = `raw ${raw}: ${JSON.stringify(tail)}`;
      assert.ok(!tail.some((l) => /%s|PRO''BE|__tsm_r|PPID/.test(l)), `no piece of a probe line: ${said}`);
      assert.ok(['kept-1', 'kept-2', 'kept-3'].every((k) => tail.includes(k)), `the output around them stays: ${said}`);
    }
  } finally {
    await h.close();
  }
});

test('a reviewer’s read: a tail whose window the daemon’s own lines fill reads further back for the lines asked, and at its cap says the shortfall instead of returning fewer in silence', async () => {
  const h = await markerHarness();
  try {
    for (let i = 1; i <= 3; i++) await h.call('runCommand', { session: 'fill', command: `echo real-${i}` });
    const { nonce, journal } = await hungMarkerRun(h, 'fill');
    const mark = `<<<EXIT:${nonce}:0>>>\r\n`;
    // 200 lines of the Run's own end mark: a 3-line tail first reads 56 lines, all plumbing, and reads further back until it has three.
    for (let i = 0; i < 200; i++) journal.append({ type: 'output', data: mark, stream: 'pty' });
    const found = lines(await h.call('tailLogs', { session: 'fill', lines: 3 }));
    assert.equal(found.length, 3, JSON.stringify(found));
    assert.ok(!found[0]!.startsWith('[earlier output'), `three lines were found further back, so no note: ${JSON.stringify(found)}`);
    assert.ok(found.every((l) => !l.includes('<<<EXIT')), 'none of the plumbing');
    assert.ok(found.some((l) => l.includes('real-3') || l.includes('sleep 99')), JSON.stringify(found));
    // More plumbing than the tail's cap: nothing but marks in the last 10,000 lines, said as such, with the earlier page named.
    for (let i = 0; i < 10_100; i++) journal.append({ type: 'output', data: mark, stream: 'pty' });
    const short = lines(await h.call('tailLogs', { session: 'fill', lines: 3 }));
    assert.equal(short.length, 1, JSON.stringify(short));
    assert.match(short[0]!, /^\[earlier output not shown \(the daemon's own lines took the rest of the 10000 lines read\); read \{"session": "fill", "tail": 3, "until": \d+\} shows what came before\]$/);
  } finally {
    await h.close();
  }
});

test('a reviewer’s read: a raw tail whose first shown line begins at the first event read, with older output before it, marks the line and includes that event in its advice', async () => {
  const h = await markerHarness();
  try {
    await h.call('runCommand', { session: 'rawhead', command: 'echo earlier' });
    const { nonce, journal } = await hungMarkerRun(h, 'rawhead');
    // Exactly the raw tail's page of 2,000 events: a real line at its head, the Run's end marks, two real lines at the end
    // (the last without a line end, so no empty line follows them).
    const headSeq = journal.append({ type: 'output', data: 'head-line\r\n', stream: 'pty' }).seq;
    for (let i = 0; i < 1997; i++) journal.append({ type: 'output', data: `<<<EXIT:${nonce}:0>>>\r\n`, stream: 'pty' });
    journal.append({ type: 'output', data: 'tail-a\r\n', stream: 'pty' });
    journal.append({ type: 'output', data: 'tail-b', stream: 'pty' });
    const raw = lines(await h.call('tailLogs', { session: 'rawhead', lines: 3, raw: true }));
    assert.equal(raw.length, 4, JSON.stringify(raw));
    const m = /^\[earlier output not shown \(the first line begins before what was read\); read \{"session": "rawhead", "tail": 3, "until": (\d+)\} shows what came before, ending with the earlier part of the first line below\]$/.exec(raw[0]!);
    assert.ok(m, raw[0]);
    assert.equal(Number(m![1]), headSeq - 1, 'the earlier page ends where what was read begins, so it ends with the head of the first line shown');
    assert.deepEqual(raw.slice(1), ['…head-line', 'tail-a', 'tail-b']);
  } finally {
    await h.close();
  }
});

test('runCommand reports the session’s duration, on the monotonic clock: a wall-clock step back while the command runs reads no negative duration', async (t) => {
  // A reviewer's read of the fixes for #22: runCommand's `duration` was the App's `endedAt - startedAt` on the wall clock, so
  // with the clock stepped back 3 s during a 1 s command it read about -2000 while the journal held about 1000. The session
  // is created after the stub, as a daemon's would be before a step.
  const realNow = Date.now;
  const realMono = clocks.monotonic;
  let wallStep = 0;
  let monoStep = 0;
  Date.now = () => realNow() + wallStep;
  clocks.monotonic = () => realMono() + monoStep;
  t.after(() => {
    Date.now = realNow;
    clocks.monotonic = realMono;
  });
  const pending = call('runCommand', { session: 'cdur', command: 'sleep 1', timeout: 10_000 });
  await until(() => {
    const s = registry.get('cdur');
    return s?.kind === 'live' && s.session.listRuns().some((r) => r.state === 'running');
  }, 5000, 'the command to start');
  wallStep -= 3000;
  monoStep += 2500;
  const r = await pending;
  assert.equal(r.state, 'exited', JSON.stringify(r));
  assert.ok((r.duration as number) >= 2500, `the session's measure: ${r.duration} ms`);
  const live = registry.get('cdur');
  assert.ok(live?.kind === 'live');
  const end = live.session.journal.since(0).events.find((e) => e.type === 'run.end');
  assert.ok(end?.type === 'run.end');
  assert.equal(r.duration, end.durationMs, 'the duration the journal holds');
});

test('the 33 commits 6: a searchLogs pattern holding a tab, as a character or an escape, comes back with a note that a tab reads as spaces, to use \\s+', async () => {
  // 1.x matched the raw logged lines, so its callers' tab patterns found tabs; here they find nothing, and an
  // empty list read as absence (the house's read of the 33 commits, #22, comment 6307350650, item 6).
  await call('runCommand', { session: 'tabs', command: "printf 'key\\tvalue\\n'" });
  type Hit = { line?: string; note?: string };
  const search = async (pattern: string) => (await call('searchLogs', { session: 'tabs', pattern })) as unknown as Hit[];
  const noteOf = (hits: Hit[]) => hits.find((h) => h.note !== undefined)?.note ?? '';
  for (const pattern of ['key\tvalue', 'key\\tvalue', 'key\\x09value', 'key\\u0009value', 'key\\cIvalue', '[\\t]value', '\\\\\\tvalue']) {
    const hits = await search(pattern);
    assert.equal(hits.filter((h) => h.line !== undefined).length, 0, `the tab itself is not in the line: ${JSON.stringify(pattern)}`);
    assert.match(noteOf(hits), /the pattern holds a tab, and lines read as the terminal shows them, where a tab is the spaces up to the next tab stop: use \\s\+ to match it/, JSON.stringify(pattern));
  }
  // An escaped backslash before a t is no tab; neither is \s.
  for (const pattern of ['key\\\\tvalue', 'key\\s+value']) assert.doesNotMatch(noteOf(await search(pattern)), /holds a tab/, JSON.stringify(pattern));
  const found = await search('key\\s+value');
  assert.ok(found.some((h) => h.line !== undefined && /^key +value$/.test(h.line)), JSON.stringify(found));
});

test('6307351617 5: a declared Run typed but not started carries its nonce, so its pieces’ marks, a GONE mark and a cancel probe’s answer stay out of the logs', async () => {
  // runPlumbing skipped a Run with no start, and a declared Run's nonce came only with its start, so the marks
  // its pieces print before it, or a GONE with no start at all, reached tailLogs (the house's read of the 33
  // commits, #22, comment 6307351617, item 5). `cat` declared as sh takes the typed lines and never starts the Run.
  const opened = await call('runCommand', { session: 'unstarted', command: 'cat', timeout: -1 });
  await until(() => summary('unstarted')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'cat in front');
  await call('session_declare_shell', { session: 'unstarted', shell: 'sh' });
  const typed = await call('runCommand', { session: 'unstarted', command: `echo long-${'x'.repeat(3000)}`, timeout: 300 });
  const live = registry.get('unstarted');
  assert.ok(live?.kind === 'live');
  const run = live.session.run(String(typed.runId));
  assert.equal(run.state, 'starting', JSON.stringify(run));
  assert.match(run.nonce ?? '', /^[0-9a-f]{8}$/, 'the nonce is there from the launch');
  // What a shell that took the first piece and then a cut line prints, a cancel probe's answer from a shell that
  // never ran the line (an empty token), and a program's mark of another Run.
  const marks = [`<<<ACK:${run.nonce}:1>>>`, `<<<GONE:${run.nonce}>>>`, `<<<PROBE:${run.nonce}:4242:>>>`].map((m) => `${m}\r\n`).join('');
  live.session.journal.append({ type: 'output', data: `${marks}<<<ACK:0badf00d:1>>> a program line\r\n`, stream: 'pty' });
  for (const raw of [false, true]) {
    const tail = lines(await call('tailLogs', { session: 'unstarted', lines: 40, raw }));
    const said = `raw ${raw}: ${JSON.stringify(tail.map((l) => l.slice(0, 80)))}`;
    assert.ok(!tail.some((l) => l.includes(run.nonce!)), `no mark of the declared Run: ${said}`);
    assert.ok(!tail.some((l) => l.includes('__tsm_')), `no typed piece: ${said}`);
    assert.ok(tail.includes('<<<ACK:0badf00d:1>>> a program line'), `another nonce's mark is a program's: ${said}`);
  }
  await call('killSession', { session: 'unstarted', graceful: false });
});

test('a probe answer with a Run’s nonce and an empty pid stays out of the logs, inline with the Run’s token or none, and the marker strategy’s', async () => {
  // macOS CI on #22 at 1c88566: a Run's history held `^\<<<PROBE:nonce::nonce>>>`, an answer whose pid came out empty after the
  // cancel's ^\. The logs took a probe's answer by the session's shape, which takes a pid only as digits, so it kept that line.
  const opened = await call('runCommand', { session: 'emptypid', command: 'cat', timeout: -1 });
  await until(() => summary('emptypid')?.runs?.some((x) => x.runId === opened.runId && x.state === 'running') === true, 5000, 'cat in front');
  await call('session_declare_shell', { session: 'emptypid', shell: 'sh' });
  const typed = await call('runCommand', { session: 'emptypid', command: 'echo typed', timeout: 300 });
  const live = registry.get('emptypid');
  assert.ok(live?.kind === 'live');
  const n = live.session.run(String(typed.runId)).nonce!;
  assert.match(n, /^[0-9a-f]{8}$/);
  const answers = [`$ ^\\<<<PROBE:${n}::${n}>>>`, `<<<PROBE:${n}::>>>`, `<<<PROBE:${n}:>>>`].map((m) => `${m}\r\n`).join('');
  live.session.journal.append({ type: 'output', data: `${answers}a program line\r\n`, stream: 'pty' });
  for (const raw of [false, true]) {
    const tail = lines(await call('tailLogs', { session: 'emptypid', lines: 40, raw }));
    const said = `raw ${raw}: ${JSON.stringify(tail.map((l) => l.slice(0, 80)))}`;
    assert.ok(!tail.some((l) => l.includes(n)), `no answer of the Run: ${said}`);
    assert.ok(tail.includes('a program line'), `the program's line stays: ${said}`);
  }
  assert.deepEqual(await call('searchLogs', { session: 'emptypid', pattern: n }), [], 'a search finds no answer of the Run');
  await call('killSession', { session: 'emptypid', graceful: false });
});

test('a raw tail counts a crash’s hole as up to its range, as a read does', async () => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650): the range a
  // crash skipped above the last synced reservation may be mostly seqs never issued.
  await call('runCommand', { session: 'crashhole', command: 'echo before-crash' });
  const live = registry.get('crashhole');
  assert.ok(live?.kind === 'live');
  const j = live.session.journal;
  j.append({ type: 'gap', from: j.lastSeq + 1, to: j.lastSeq + 40, reason: 'torn-write' });
  j.append({ type: 'output', data: 'after-crash\r\n', stream: 'pty' });
  for (const raw of [true, false]) {
    const tail = lines(await call('tailLogs', { session: 'crashhole', lines: 50, raw }));
    assert.ok(tail.some((l) => /^\[… up to 40 journal events missing \(seq \d+–\d+: a crash cut the journal short\) …\]$/.test(l)), `raw ${raw}: ${JSON.stringify(tail)}`);
  }
  await call('killSession', { session: 'crashhole', graceful: false });
});

test('question 5: a raw and a clean tail mark a hole where it lies, though its gap was recorded after the lines that follow it', async () => {
  // The catch-up records a hole when the disk takes writes again, after what followed the hole: the raw tail marked the
  // hole where its gap event sat, after `after-1` and `after-2` (the house's review of f3750e4..4f4c067, PR #22, comment
  // 6315636412, question 5).
  await call('runCommand', { session: 'latehole', command: 'echo before-hole' });
  const live = registry.get('latehole');
  assert.ok(live?.kind === 'live');
  const j = live.session.journal;
  const a = j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq; // the seqs the hole stands for
  const b = j.append({ type: 'note', text: 'n', principal: 'agent:a@test' }).seq;
  j.append({ type: 'output', data: 'after-1\r\n', stream: 'pty' });
  j.append({ type: 'output', data: 'after-2\r\n', stream: 'pty' });
  j.append({ type: 'gap', from: a, to: b, reason: 'store-error', exact: true });
  j.append({ type: 'output', data: 'last\r\n', stream: 'pty' });
  for (const raw of [true, false]) {
    const tail = lines(await call('tailLogs', { session: 'latehole', lines: 50, raw }));
    const at = tail.findIndex((l) => /journal events missing/.test(l));
    assert.ok(at > tail.findIndex((l) => l.includes('before-hole')) && at < tail.indexOf('after-1'), `raw ${raw}: the hole between before-hole and after-1: ${JSON.stringify(tail)}`);
    assert.equal(tail.filter((l) => /journal events missing/.test(l)).length, 1, `raw ${raw}: once`);
  }
  await call('killSession', { session: 'latehole', graceful: false });
});

test('tailLogs counts lines of output across two sources, and the page its cut note advises meets its first line', async () => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650): the tail kept
  // the last 6 lines of text, headers among them, so 3 lines of output showed; and the page of what came before was
  // read for 6 lines from the first kept on, headers counted, so it reached back 3 lines of output too many, and
  // those were in neither page. The pty and a process Run take turns, in lines of 25,000 bytes, so the tail is cut.
  await call('runCommand', { session: 'twosources', command: 'echo start' });
  const live = registry.get('twosources');
  assert.ok(live?.kind === 'live');
  const j = live.session.journal;
  j.append({ type: 'run.admit', runId: 'rx1', target: 'process', principal: A.principal, origin: 'self', queued: false });
  j.append({ type: 'run.start', runId: 'rx1', cwd: '/' });
  const big = 'y'.repeat(25_000);
  for (let i = 0; i < 60; i++) j.append(i % 2 ? { type: 'output', data: `run ${i} ${big}\n`, stream: 'stdout', runId: 'rx1' } : { type: 'output', data: `pty ${i} ${big}\r\n`, stream: 'pty' });
  const header = (l: string) => l === '[terminal]' || l === '[run rx1]';
  const numberOf = (l: string) => Number(/^(?:pty|run) (\d+) /.exec(l)?.[1]);
  const tail = lines(await call('tailLogs', { session: 'twosources', lines: 6 }));
  const note = tail.find((l) => l.startsWith('[earlier output not shown'));
  assert.ok(note, `the cut is said: ${JSON.stringify(tail.map((l) => l.slice(0, 20)))}`);
  const shown = tail.filter((l) => l !== note && !header(l));
  assert.deepEqual(shown.map(numberOf), [54, 55, 56, 57, 58, 59], 'six lines of output, the headers extra');
  const m = /read (\{"session": "twosources", "tail": 6, "until": \d+(?:, "untilOffset": \d+)?\}) shows what came before/.exec(note!);
  assert.ok(m, note);
  const earlier = (await call('read', { ...(JSON.parse(m[1]!) as Obj), maxBytes: 1024 * 1024 })) as unknown as { text: string };
  const before = earlier.text.split('\n').filter((l) => !header(l));
  assert.equal(numberOf(before.at(-1)!), 53, `the page before ends with the line just before the first shown: ${JSON.stringify(before.map((l) => l.slice(0, 8)))}`);
  await call('killSession', { session: 'twosources', graceful: false });
});

test('tailLogs over a line written last that another source holds back: the lines shown and the page they advise meet', async () => {
  // A pty line a Run's unfinished line interrupts, then ends unfinished: the reader's tail of 1 reaches back to it.
  // tailLogs re-read the line kept, took that read's page before, and showed only the Run's line, so the pty line
  // was in neither. Over 1.2 MB the tail is cut, so tailLogs advises the page before.
  const h = await markerHarness();
  try {
    await h.call('runCommand', { session: 'reach', command: 'echo hello' });
    const live = h.registry.get('reach');
    assert.ok(live?.kind === 'live');
    const j = live.session.journal;
    j.append({ type: 'output', data: `BIG-${'z'.repeat(1_200_000)}\r\nmid1\r\nmid2\r\n`, stream: 'pty' });
    j.append({ type: 'output', data: 'P-start', stream: 'pty' });
    j.append({ type: 'run.admit', runId: 'rx', target: 'process', principal: A.principal, origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'rx', cwd: '/' });
    j.append({ type: 'output', data: 'R-unfin', stream: 'stdout', runId: 'rx' });
    j.append({ type: 'output', data: '-P-more', stream: 'pty' });
    const tail = lines(await h.call('tailLogs', { session: 'reach', lines: 1 }));
    const m = /read (\{[^}]*\}) shows what came before/.exec(tail[0] ?? '');
    assert.ok(m, JSON.stringify(tail));
    const earlier = (await h.call('read', JSON.parse(m![1]!) as Obj)) as unknown as { text: string };
    const seen = [...tail.slice(1), ...earlier.text.split('\n')];
    for (const l of ['P-start-P-more', 'R-unfin']) assert.ok(seen.includes(l), `${l} in ${JSON.stringify({ tail: tail.slice(1), earlier: earlier.text.split('\n') })}`);
  } finally {
    await h.close();
  }
});

test("tailLogs' description advises a read with its session, which read requires (an independent read of the fixes for the review of the 40 commits, PR #22)", () => {
  const tail = toolsFor('compat').find((t) => t.name === 'tailLogs')!;
  assert.match(tail.description, /read \{"session": …, "runId": …\}/);
  const read = toolsFor('compat').find((t) => t.name === 'read')!;
  assert.deepEqual((read.inputSchema as { required?: string[] }).required, ['session']);
});

test("compat's logs keep a program's line that an unanswered probe was typed onto, and strike an answered probe's line whole, as the cutter does (an independent read of the fixes for the review of the 40 commits, PR #22)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-head-'));
  const backend = fakeShellBackend((sh) => { sh.on(/^echo /, (line) => ({ output: `${line.slice(5)}\r\n`, exit: 0 })); }, { marks: 'none' });
  const registry = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 2000 });
  const C: Caller = { principal: 'agent:a@test', connectionId: 'cp' };
  const compat = toolsFor('compat');
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await callTool(name, args, { app, caller: C, resultText: 'json' }, compat)).text);
  try {
    await call('runCommand', { session: 'pq', command: 'echo hello' });
    const live = registry.get('pq');
    if (live?.kind !== 'live') throw new Error('no live session');
    const j = live.session.journal;
    // A program asked and ignored ^C; the daemon's probe was typed on its line, and nothing answered.
    j.append({ type: 'output', data: `Continue? [y/N] ${markerProbe('n0nce')}\r\nnot continuing\r\n`, stream: 'pty' });
    // The program's text stays as the cutter keeps it, up to the probe's echo and the space before it, after the prompt it was printed on.
    const kept = (await call('tailLogs', { session: 'pq', lines: 2 })) as string[];
    assert.deepEqual(kept, ['$ Continue? [y/N] ', 'not continuing']);
    assert.equal(((await call('searchLogs', { session: 'pq', pattern: 'Continue' })) as unknown[]).length, 1);
    // A shell answered the next one: its echo's line, the shell's prompt with it, goes whole. (The answer is plumbing
    // for a Run's own nonce; this one names none of the session's Runs, so it stays.)
    j.append({ type: 'output', data: `$ ${markerProbe('n1nce')}\r\n<<<PROBE:n1nce:4242>>>\r\n$ `, stream: 'pty' });
    const tail = (await call('tailLogs', { session: 'pq', lines: 4 })) as string[];
    assert.ok(!tail.some((l) => l.includes('printf') || l === '$ '), JSON.stringify(tail));
    assert.ok(tail.includes('not continuing'), JSON.stringify(tail));
  } finally {
    await registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("searchLogs judges a probe answered as tailLogs does: an answered probe's prompt line is no hit, whatever context is asked (an independent read of the fixes for the review of 4f4c067..a8b6f28, PR #22)", async () => {
  // The hit's line judged alone could not see the answer on the next line, so the prompt the probe was typed after was
  // returned as a hit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-search-probe-'));
  const backend = fakeShellBackend((sh) => { sh.on(/^echo /, (line) => ({ output: `${line.slice(5)}\r\n`, exit: 0 })); }, { marks: 'none' });
  const registry = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 2000 });
  const C: Caller = { principal: 'agent:a@test', connectionId: 'cs' };
  const compat = toolsFor('compat');
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await callTool(name, args, { app, caller: C, resultText: 'json' }, compat)).text);
  try {
    await call('runCommand', { session: 'sq', command: 'echo hello' });
    const live = registry.get('sq');
    if (live?.kind !== 'live') throw new Error('no live session');
    // A plain line after the hit: the context the scan took beyond what was asked is cut back off (the house's review of
    // 4860d4c..bc4bc85, PR #22: with only plumbing beside the hit, the cut was never needed).
    live.session.journal.append({ type: 'output', data: `\r\nmyhost$ ${markerProbe('n1nce')}\r\n<<<PROBE:n1nce:4242>>>\r\nmyhost$ ok\r\nplain after\r\n`, stream: 'pty' });
    for (const context of [0, 1, 3]) {
      const hits = (await call('searchLogs', { session: 'sq', pattern: 'myhost', context })) as Array<{ line: string; context: string[] }>;
      assert.deepEqual(hits.map((h) => h.line), ['myhost$ ok'], `context ${context}: ${JSON.stringify(hits)}`);
      assert.ok(hits[0]!.context.length <= 2 * context + 1, `context ${context}: ${JSON.stringify(hits[0]!.context)}`);
    }
  } finally {
    await registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("searchLogs judges a probe answered when its own `set -x` trace stands between its echo and its answer, in bash and in its restricted mode, whatever context is asked (the house's review of 4860d4c..bc4bc85, PR #22)", { skip: !fs.existsSync('/bin/bash') }, async () => {
  // A line of context reached bash's trace of the probe's pid substitution and no further, so the prompt the answered
  // probe was typed after came back as a hit at context 0 and 1 (by run, bash 5.2.37).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-search-traced-'));
  const backend = fakeShellBackend((sh) => { sh.on(/^echo /, (line) => ({ output: `${line.slice(5)}\r\n`, exit: 0 })); }, { marks: 'none' });
  const registry = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 2000 });
  const C: Caller = { principal: 'agent:a@test', connectionId: 'cs' };
  const compat = toolsFor('compat');
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await callTool(name, args, { app, caller: C, resultText: 'json' }, compat)).text);
  try {
    await call('runCommand', { session: 'st', command: 'echo hello' });
    const live = registry.get('st');
    if (live?.kind !== 'live') throw new Error('no live session');
    // The probe as a declared shell's inline strategy types it, and bash's own trace of it: the substitution, then the printf.
    const probe = inlineProbe('n1nce', false).trimStart();
    const traceOf = (flags: string[]) => execFileSync('/bin/sh', ['-c', 'exec "$0" "$@" 2>&1', '/bin/bash', ...flags, '-c', `set -x; ${probe}`], { encoding: 'utf8' }).replace(/\n/g, '\r\n');
    const traced = traceOf([]);
    // Two trace lines before the answer (`++ exec /bin/sh -c 'echo $PPID'`, `+ printf …` in bash 5.2): its answer is the third.
    assert.ok(/^[^\r\n]+\r\n[^\r\n]+\r\n<<<PROBE:n1nce:\d+:>>>\r\n$/.test(traced), `bash's trace: ${JSON.stringify(traced)}`);
    // In bash's restricted mode, four in bash 5.2.37: the refused exec's trace, its refusal of the redirect, the fallback's
    // `echo`, the printf's; the answer is the fifth, as far below the echo as a search looks (the house's review of
    // bc4bc85..5d8ce0e, PR #22, by run).
    const restricted = traceOf(['-r']);
    assert.ok(/^(?:[^\r\n]*\r\n){1,4}<<<PROBE:n1nce:\d+:>>>\r\n$/.test(restricted), `restricted bash's trace: ${JSON.stringify(restricted)}`);
    live.session.journal.append({ type: 'output', data: `\r\nmyhost$ ${probe}\r\n${traced}myhost$ ok\r\nmyhost$ ${probe}\r\n${restricted}myhost$ ok2\r\n`, stream: 'pty' });
    for (const context of [0, 1, 3]) {
      const hits = (await call('searchLogs', { session: 'st', pattern: 'myhost', context })) as Array<{ line: string; context: string[] }>;
      assert.deepEqual(hits.map((h) => h.line), ['myhost$ ok', 'myhost$ ok2'], `context ${context}: ${JSON.stringify(hits)}`);
      for (const h of hits) assert.ok(h.context.length <= 2 * context + 1, `context ${context}: ${JSON.stringify(h.context)}`);
    }
  } finally {
    await registry.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
