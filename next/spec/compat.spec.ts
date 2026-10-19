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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { callTool, toolsFor } from '../src/api/tools.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
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
  const refused = await call('takeScreenshot', { session: 'shot', outputPath: file, width: 800, height: 600 });
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /no file was written/);
  assert.ok(!fs.existsSync(file));
  assert.match(String(refused.text), /on-screen/, 'the text still comes along');
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
  assert.match(out, new RegExp(`^\\[… earlier output omitted: read \\{"runId": "${big.runId}"\\} pages all of it\\]`));
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
  assert.match(most[0]!, /^\[earlier output not shown: these lines come from the last 1 MiB; read \{"session": "long", "tail": 10000, "until": \d+\}/, 'the bound cut lines that were asked for: said');
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
