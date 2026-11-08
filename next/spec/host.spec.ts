import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host, type Caller, type Wake } from '../src/tools/host.js';
import { RESULT_MAX_CHARS } from '../src/tools/render.js';
import type { OpenOptions } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

const STARTED = Date.parse('2026-11-08T13:00:00.000Z');

function setup() {
  const opened: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      opened.push(s);
      return s;
    },
    shell: '/bin/bash',
    env: { HOME: '/home/u' },
    sessionsDir: '/tmp/sessions',
    startedAt: STARTED,
  });
  return { host, opened };
}

const agent = (scope = 'a'): Caller => ({ scope, takes: true, pushes: true });
const cli = (scope = 'a'): Caller => ({ scope, takes: false, pushes: false });

const settle = () => new Promise((r) => setImmediate(r));

test('H5: session names are per scope: two scopes\' "main" are two shells, and each lists only its own', async () => {
  const { host, opened } = setup();
  assert.equal((await host.call(agent('a'), 'open', { name: 'main' })).isError, undefined);
  assert.equal((await host.call(agent('b'), 'open', { name: 'main' })).isError, undefined);
  assert.equal(opened.length, 2);
  const listA = await host.call(agent('a'), 'list', {});
  assert.deepEqual((listA.structured.sessions as Array<{ name: string }>).map((s) => s.name), ['main']);
  await host.call(agent('a'), 'run', { name: 'main', command: 'echo a' });
  assert.equal(opened[0]!.calls.filter((c) => c.method === 'run').length, 1);
  assert.equal(opened[1]!.calls.filter((c) => c.method === 'run').length, 0);
});

test('H5a: a call naming a session its scope doesn\'t have is refused, opens none, and says the daemon\'s start', async () => {
  const { host, opened } = setup();
  await host.call(agent('b'), 'open', { name: 'main' });
  const args: Record<string, Record<string, unknown>> = { run: { command: 'rm -rf build/' }, send: { text: 'x' }, look: {}, read: {}, stop: {}, close: {} };
  for (const [tool, extra] of Object.entries(args)) {
    const r = await host.call(agent('a'), tool, { name: 'main', ...extra });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /^No session named "main" is open in scope "a", and none is opened for you\. None is open here\. `open` makes one\. This daemon started at 2026-11-08T13:00:00\.000Z, and no session outlives the daemon that held it\.$/, tool);
  }
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.calls.length, 0);
});

test('H6: a run refused away from the prompt says what is in front and what would work', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  opened[0]!.frontNow = { state: 'waiting', since: Date.now(), process: { pgid: 7, argv: 'python3 -c input()', shell: false }, echo: false };
  const r = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^\[main · waiting for input: python3 -c input\(\), not echoed, as for a password, for [\d.]+ s · \/home\/u\]\nNothing was typed: python3 -c input\(\) is waiting for input\. `send` answers it, `stop` stops it\.$/);
});

test('H6: every result opens with the status line: a command\'s status, duration, directory and what is in front', async () => {
  const { host } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/srv/app' });
  const r = await host.call(agent(), 'run', { name: 'main', command: 'make' });
  assert.match(r.text.split('\n')[0]!, /^\[main · command 1 · exit 0 · \d+\.\d s · at the prompt · \/srv\/app\]$/);
});

test('H6: output too long for the host\'s inline cap keeps its start and its end, within the cap, and says how to read the rest', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'main', command: 'build', wait: 0 });
  s.print(...Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`));
  s.end(0, true);
  s.runMode = 'end';
  const r = await host.call(agent(), 'read', { name: 'main', command: 1 });
  assert.ok(r.text.length <= RESULT_MAX_CHARS, `${r.text.length} chars`);
  assert.match(r.text, /line 0 x/);
  assert.match(r.text, /line 4999 x/);
  assert.match(r.text, /… \d+ lines left out \(`read` with `command: 1` gives it whole\)/);
});

test('H7: waits default to 15 s, reach 55 s, and go no further', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  await host.call(agent(), 'run', { name: 'main', command: 'a' });
  await host.call(agent(), 'run', { name: 'main', command: 'b', wait: 55 });
  const waits = opened[0]!.calls.filter((c) => c.method === 'run').map((c) => (c.args[1] as { waitMs: number }).waitMs);
  assert.deepEqual(waits, [15_000, 55_000]);
  const r = await host.call(agent(), 'run', { name: 'main', command: 'c', wait: 56 });
  assert.equal(r.isError, true);
  assert.match(r.text, /\.wait: must be <= 55/);
});

test('H8: an end no call took is pushed under its command\'s key; accepted, it is seen; refused, it stays for list', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  let accept = false;
  host.subscribe('a', async (w) => {
    wakes.push(w);
    return accept;
  });
  const otherScope: Wake[] = [];
  host.subscribe('b', async (w) => (otherScope.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'main', command: 'sleep 60', wait: 0 });
  s.end(0);
  await settle();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.tag, 'terminal:ended');
  assert.equal(wakes[0]!.key, 'a/main/1');
  assert.match(wakes[0]!.text, /^\[main · command 1 · exit 0 · /);
  const listed = await host.call(agent(), 'list', {});
  assert.equal((listed.structured.unseen as string[]).length, 1, 'refused, it stays unseen');
  assert.equal(((await host.call(agent(), 'list', {})).structured.unseen as string[]).length, 0, "the agent's list took it");

  accept = true;
  await host.call(agent(), 'run', { name: 'main', command: 'sleep 61', wait: 0 });
  s.end(1);
  await settle();
  assert.equal(wakes.length, 2);
  assert.equal(((await host.call(agent(), 'list', {})).structured.unseen as string[]).length, 0, 'accepted, it is seen');
  assert.equal(otherScope.length, 0, 'another scope is never woken');
});

test('H8: an end a call already returned wakes no one', async () => {
  const { host } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  await host.call(agent(), 'run', { name: 'main', command: 'true' });
  await settle();
  assert.equal(wakes.length, 0);
});

test('H8: a shell dying mid-command pushes its death under the command\'s key, so an unread end is replaced', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), false));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'main', command: 'exit 3', wait: 0 });
  s.end(undefined);
  s.exit({ code: 3 });
  await settle();
  assert.deepEqual(wakes.map((w) => [w.tag, w.key]), [['terminal:ended', 'a/main/1'], ['terminal:exited', 'a/main/1']]);
  assert.match(wakes[1]!.text, /^\[main · the shell exited with status 3\]/);
  const unseen = (await host.call(agent(), 'list', {})).structured.unseen as string[];
  assert.deepEqual(unseen, ['[main · the shell exited with status 3]']);
});

test('H8: notify_on reports its first match once, under its command\'s key', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'main', command: 'serve', wait: 0, notify_on: 'listening on \\d+' });
  s.print('starting', 'listening on 8080', 'listening on 8081');
  await settle();
  assert.deepEqual(wakes.map((w) => [w.tag, w.key]), [['terminal:match', 'a/main/1']]);
  assert.match(wakes[0]!.text, /Matched at line \d+: listening on 8080$/);
});

test('H9: the CLI reads without taking: its calls pass take: false, and leave what it saw unseen for the agent', async () => {
  const { host, opened } = setup();
  host.subscribe('a', async () => false);
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'main', command: 'job', wait: 0 });
  s.print('one', 'two');
  s.end(0);
  await settle();
  await host.call(cli(), 'list', {});
  await host.call(cli(), 'look', { name: 'main' });
  await host.call(cli(), 'run', { name: 'main', command: 'x' });
  assert.equal((s.calls.at(-1)!.args[1] as { take?: boolean }).take, false);
  const look = await host.call(agent(), 'look', { name: 'main' });
  assert.equal((look.structured.unseen as string[]).length, 1, 'the CLI left the end unseen');
  assert.match(look.text, /^\$ job$/m, "the CLI's look didn't move the agent's cursor");
});

test('look shows each line once, but for the lines still live on the screen', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.print('a', 'b', 'prompt$ ');
  const first = await host.call(agent(), 'look', { name: 'main' });
  assert.match(first.text, /\na\nb\nprompt\$ $/);
  s.print('c');
  const second = await host.call(agent(), 'look', { name: 'main' });
  assert.match(second.text, /\nprompt\$ \nc$/);
  assert.doesNotMatch(second.text, /\nb\n/);
});

test('read with a pattern says how many lines were searched on their head only', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  opened[0]!.print('short needle', `${'x'.repeat(70_000)} needle`);
  const r = await host.call(agent(), 'read', { name: 'main', match: 'needle' });
  assert.match(r.text, /1 matching line; 1 line longer than the match window, searched on its head only/);
});

test('the shells start with the daemon\'s oom preference', async () => {
  const opened: OpenOptions[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => (opened.push(o), new FakeSession(o.name, o)),
    shell: '/bin/bash', env: {}, sessionsDir: '/tmp/s', startedAt: STARTED, oomScoreAdj: 200,
  });
  await host.call(agent(), 'open', { name: 'main' });
  assert.equal(opened[0]!.oomScoreAdj, 200);
});
