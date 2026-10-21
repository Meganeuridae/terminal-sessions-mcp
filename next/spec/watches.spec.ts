/**
 * Watches and wait_for (§4, §11): patterns mean what `search` means (m2-10, m2-5),
 * the idle watch follows the shell's own Runs only (m2-11), silence on a Run waits
 * for that Run (m2-12), a coalesced firing carries the latest match (m2-20), and a
 * wait that can no longer be met ends at once with a reason (m2-24).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, type Caller } from '../src/api/app.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { TermError } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import type { Session } from '../src/core/session.js';
import type { JournalEvent } from '../src/core/types.js';
import { WatchManager, type WatchHost } from '../src/core/watches.js';
import { sleep, until } from './testhost.js';

const A = 'agent:a@test';
const C: Caller = { principal: A, connectionId: 'cw' };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-watch-'));
let registry: SessionRegistry;
let app: App;

before(() => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  app = new App({ registry, defaultWaitMs: 5000 });
});

after(async () => {
  await registry.closeAll({ graceful: false });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const live = (id: string): Session => {
  const s = registry.get(id);
  assert.ok(s?.kind === 'live', `${id} is live`);
  return s.session;
};
const fired = (s: Session, watchId: string, from = 0) =>
  s.journal.since(from).events.filter((e): e is Extract<JournalEvent, { type: 'watch.fired' }> => e.type === 'watch.fired' && e.watchId === watchId);
const invalid = (e: unknown) => e instanceof TermError && e.code === 'invalid_argument';

test('m2-10 (real bash): `^ERROR` and `done$` watches fire on lines inside one write, as search finds them', async () => {
  await app.sessionOpen(C, { id: 'anch' });
  const s = live('anch');
  const err = await app.watch(C, { session: 'anch', pattern: '^ERROR' });
  const done = await app.watch(C, { session: 'anch', pattern: 'done$' });
  const since = s.journal.lastSeq;
  await app.run(C, { session: 'anch', command: "printf 'building\\nERR%s: boom\\nall do%s\\n' OR ne" });
  await until(() => fired(s, err.watchId).length === 1 && fired(s, done.watchId).length === 1, 3000, 'both watches fired');
  assert.equal(fired(s, err.watchId)[0]!.line, 'ERROR: boom');
  assert.equal(fired(s, done.watchId)[0]!.line, 'all done');
  const w = await app.waitFor(C, { session: 'anch', pattern: 'done$', since, wait: 100 });
  assert.equal(w.matched, true);
  const found = await app.search(C, { session: 'anch', pattern: '^ERROR' });
  assert.ok(found.matches.some((m) => m.line === 'ERROR: boom'), 'the same pattern means the same thing in search');
});

test('m2-5/m2-10: a pattern the engine refuses, or one that matches the empty string, fails at creation', async () => {
  await app.sessionOpen(C, { id: 'badpat' });
  for (const pattern of ['x*', '(unclosed', '(error)?']) {
    await assert.rejects(app.watch(C, { session: 'badpat', pattern }), invalid, pattern);
    await assert.rejects(app.waitFor(C, { session: 'badpat', pattern, wait: 10 }), invalid, pattern);
  }
  const t0 = Date.now();
  const r = await app.waitFor(C, { session: 'badpat', pattern: '(\\w+\\s?)+ready', since: 0, wait: 50 });
  assert.equal(r.matched, false);
  assert.ok(Date.now() - t0 < 1000);
});

test('m2-24: wait_for on a shell that exited, or a session closed during the wait, returns at once with the reason', async () => {
  await app.sessionOpen(C, { id: 'dead' });
  await app.run(C, { session: 'dead', command: 'exit 3', wait: 3000 });
  await until(() => live('dead').exit !== undefined, 3000, 'shell exited');
  let t0 = Date.now();
  const p = await app.waitFor(C, { session: 'dead', pattern: 'DONE', wait: 5000 });
  assert.equal(p.matched, false);
  assert.match(String(p.reason), /session exited \(code 3\)/);
  assert.ok(Date.now() - t0 < 1000, `pattern: ${Date.now() - t0} ms`);
  const q = await app.waitFor(C, { session: 'dead', silenceMs: 300, wait: 5000 });
  assert.match(String(q.reason), /session exited/);
  const i = await app.waitFor(C, { session: 'dead', idle: true, wait: 5000 });
  assert.equal(i.matched, false);
  assert.match(String(i.reason), /session exited/);

  await app.sessionOpen(C, { id: 'closing' });
  t0 = Date.now();
  const waiting = app.waitFor(C, { session: 'closing', pattern: 'never', wait: 8000 });
  await sleep(300);
  await app.sessionClose(C, { session: 'closing' });
  const c = await waiting;
  assert.equal(c.matched, false);
  assert.match(String(c.reason), /session (closed|exited)/);
  assert.ok(Date.now() - t0 < 4000, `closed: ${Date.now() - t0} ms`);
});

test('m2-12: silence on a runId waits for that Run’s first output or its end; unknown runIds are run_not_found', async () => {
  await app.sessionOpen(C, { id: 'quiet' });
  const r = await app.run(C, { session: 'quiet', command: 'sleep 1; echo first; sleep 0.2', wait: 0 });
  let t0 = Date.now();
  const w = await app.waitFor(C, { session: 'quiet', silenceMs: 1500, runId: r.runId!, wait: 8000 });
  assert.equal(w.matched, true);
  assert.ok(Date.now() - t0 >= 900, `a silent start is not silence: ${Date.now() - t0} ms`);
  assert.match(String(w.match), /ended/);
  assert.doesNotMatch(String(w.match), /1000000000/);

  const r2 = await app.run(C, { session: 'quiet', command: 'echo a; sleep 3; echo b', wait: 0 });
  t0 = Date.now();
  const w2 = await app.waitFor(C, { session: 'quiet', silenceMs: 400, runId: r2.runId!, wait: 8000 });
  assert.equal(w2.matched, true);
  assert.match(String(w2.match), /^no output for \d+ms$/);
  assert.ok(Date.now() - t0 < 2500, `fires after its output went quiet: ${Date.now() - t0} ms`);
  await app.cancel(C, { runId: r2.runId! });

  const notFound = (e: unknown) => e instanceof TermError && e.code === 'run_not_found';
  await assert.rejects(app.waitFor(C, { session: 'quiet', silenceMs: 500, runId: 'r-does-not-exist', wait: 100 }), notFound);
  await assert.rejects(app.watch(C, { session: 'quiet', silenceMs: 500, runId: 'r-does-not-exist' }), notFound);
  await assert.rejects(app.watch(C, { session: 'quiet', pattern: 'x', runId: 'r-does-not-exist' }), notFound);

  // Without a runId, quiet is measured from the last output or the call — never "forever".
  const w3 = await app.waitFor(C, { session: 'quiet', silenceMs: 300, wait: 3000 });
  assert.equal(w3.matched, true);
  const ms = Number(/no output for (\d+)ms/.exec(String(w3.match))?.[1]);
  assert.ok(ms >= 300 && ms < 600_000, String(w3.match));
});

test('m2-11 (bash, rich): the idle watch fires for the shell’s own Runs only — not for a process Run, not for a bare Enter', async () => {
  await app.sessionOpen(C, { id: 'idle-bash' });
  const s = live('idle-bash');
  const w = await app.watch(C, { session: 'idle-bash', idle: true });
  const proc = await app.run(C, { session: 'idle-bash', command: 'true', target: 'process', wait: 3000 });
  assert.equal(proc.state, 'exited');
  await sleep(300);
  await app.input(C, { session: 'idle-bash', keys: ['Enter'] });
  await sleep(600);
  assert.equal(fired(s, w.watchId).length, 0, 'the shell ran nothing');
  await app.run(C, { session: 'idle-bash', command: 'echo shell-run', wait: 3000 });
  await until(() => fired(s, w.watchId).length === 1, 3000, 'idle after a shell Run');
});

test('m2-11 (/bin/sh, no integration): a process Run ending while a shell Run runs does not report the shell available', async () => {
  await app.sessionOpen(C, { id: 'idle-sh', shell: '/bin/sh' });
  const s = live('idle-sh');
  const w = await app.watch(C, { session: 'idle-sh', idle: true });
  const slow = await app.run(C, { session: 'idle-sh', command: 'sleep 1.5', wait: 0 });
  await app.run(C, { session: 'idle-sh', command: 'true', target: 'process', wait: 3000 });
  await sleep(300);
  assert.equal(s.run(slow.runId!).state, 'running');
  assert.equal(fired(s, w.watchId).length, 0, 'the shell is still busy');
  await until(() => fired(s, w.watchId).length === 1, 5000, 'idle once the shell Run ends');
  assert.ok(s.shellAvailable().ok);
});

test('m2-20: a coalesced firing carries the latest match, and "+N more" counts only the hits it does not show', async () => {
  const journal = new Journal();
  const host: WatchHost = { journal, integration: 'rich', waitAvailable: async () => false, shellAvailable: () => ({ ok: false }) };
  const wm = new WatchManager(host);
  const w = wm.add({ pattern: 'ERR\\d+' }, A);
  const out = (data: string) => journal.append({ type: 'output', data, stream: 'pty' });
  const firings = () => journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'watch.fired' }> => e.type === 'watch.fired' && e.watchId === w.watchId);
  out('ERR1\n');
  out('ERR2\n');
  await until(() => firings().length === 2, 2500, 'trailing firing');
  assert.deepEqual(firings().map((f) => [f.match, f.suppressed ?? 0]), [['ERR1', 0], ['ERR2', 0]], 'a two-hit burst has no "more"');
  for (const n of [3, 4, 5, 6, 7]) out(`ERR${n}\n`);
  await until(() => firings().length === 3, 2500, 'burst firing');
  assert.deepEqual(firings()[2]!.match, 'ERR7', 'the latest match, not the first held');
  assert.equal(firings()[2]!.suppressed, 4, 'ERR3–ERR6 are the four not shown');
  wm.dispose();
});

test('a `once` watch is removed after its first firing', async () => {
  await app.sessionOpen(C, { id: 'once' });
  const s = live('once');
  const w = await app.watch(C, { session: 'once', pattern: 'pi.ng', once: true });
  await app.run(C, { session: 'once', command: "printf 'pi%sng\\n' .", wait: 3000 });
  await until(() => fired(s, w.watchId).length === 1, 3000, 'fired once');
  assert.deepEqual(app.watches(C, { session: 'once' }).map((x) => x.watchId), [], 'gone after the firing');
  await app.run(C, { session: 'once', command: "printf 'pi%sng\\n' .", wait: 3000 });
  await sleep(300);
  assert.equal(fired(s, w.watchId).length, 1, 'it does not fire again');
});

test('a pattern watch reads a LF or CR inside a window title as no line end, as search does', async () => {
  // An independent read of the fix for the house's read of the 33 commits (#22, comment 6307350650): the watch's
  // line reader split at the title's LF, so `AAA` and `leBBB` were lines and `A+B+` never matched what the
  // transcript and search read as `AAABBB`.
  const journal = new Journal();
  const host: WatchHost = { journal, integration: 'rich', waitAvailable: async () => false, shellAvailable: () => ({ ok: false }) };
  const wm = new WatchManager(host);
  try {
    const w = wm.add({ pattern: '^A+B+$' }, A);
    const firings = () => journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'watch.fired' }> => e.type === 'watch.fired' && e.watchId === w.watchId);
    journal.append({ type: 'output', data: 'AAA\x1b]0;tit\r\nle\x07BBB\r\n', stream: 'pty' });
    journal.append({ type: 'output', data: 'AAAA\x1b]0;a\rb', stream: 'pty' });
    journal.append({ type: 'output', data: '\x07BBBB\r\n', stream: 'pty' });
    await until(() => firings().length === 2, 2500, 'both lines matched');
    assert.deepEqual(firings().map((f) => f.match), ['AAABBB', 'AAAABBBB']);
  } finally {
    wm.dispose();
  }
});
