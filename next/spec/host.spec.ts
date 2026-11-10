import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { Host, type Caller, type Wake } from '../src/tools/host.js';
import { cutAt, linesText, outputValue, RESULT_MAX_CHARS } from '../src/tools/render.js';
import type { Closed, Command, Front, OpenOptions, Process } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

const STARTED = Date.parse('2026-11-08T13:00:00.000Z');

function setup(now?: () => number, front?: Front) {
  const opened: FakeSession[] = [];
  const host = new Host({
    ...(now ? { now } : {}),
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      if (front) s.frontNow = front;
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

test("H6: when the terminal couldn't be read, the status line says so, and a refused run sends the agent to run again or look, not to wait", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  opened[0]!.frontNow = { state: 'unknown', since: Date.now() };
  const r = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^\[main · whether the shell is at its prompt can't be seen now: reading its terminal failed · \/home\/u\]\nNothing was typed: whether the shell is at its prompt couldn't be seen: reading its terminal failed\. `run` again, or `look`\.$/);
  assert.equal((r.structured.front as { state: string }).state, 'unknown');
  assert.equal(r.structured.error, 'front_unknown');
});

const unreadOpen = async () => {
  const { host } = setup(undefined, { state: 'unknown', since: Date.now() });
  const open = await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  return { host, open };
};

test("H6: open with the terminal unread says the reading failed, and not that the shell isn't at its prompt", async () => {
  const { open } = await unreadOpen();
  assert.doesNotMatch(open.text, /isn't at its prompt/);
  assert.match(open.text, /whether the shell is at its prompt can't be seen now: reading its terminal failed/);
});

test('H6: integrate with the terminal unread is refused as unknown, not as integrated already', async () => {
  const { host } = await unreadOpen();
  const integrate = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(integrate.structured.error, 'front_unknown');
  assert.equal(integrate.isError, true);
  assert.match(integrate.text, /\nNothing was typed: whether the shell is at its prompt couldn't be seen: reading its terminal failed\. `integrate` again, or `look`\.$/);
});

test("H6: integrate refused because the terminal's modes couldn't be read says so, as front_unknown, not as a whole-line reader", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 77, argv: 'ssh box', shell: false }, waitVisible: true };
  s.integrate = async () => ({ kind: 'refused', unread: true, front: s.frontNow });
  const r = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(r.structured.error, 'front_unknown');
  assert.equal(r.structured.unread, true);
  assert.match(r.text, /\nNothing was typed: this terminal's modes couldn't be read, so whether what's in front reads a whole line itself, such as a password question, couldn't be seen\. `integrate` again, or `look`\.$/);
});

test('H6: stop with the terminal unread sends nothing and is refused, saying to stop again or look', async () => {
  const { host } = await unreadOpen();
  const stop = await host.call(agent(), 'stop', { name: 'main' });
  assert.equal(stop.isError, true);
  assert.equal(stop.structured.error, 'not_sent');
  assert.match(stop.text, /\nNothing was sent: whether the shell is at its prompt couldn't be seen: reading its terminal failed\. `stop` again, or `look`\.$/);
});

test('H6: a look for input with the terminal unread says the reading failed and promises no report', async () => {
  const { host } = await unreadOpen();
  const input = await host.call(agent(), 'look', { name: 'main', until: 'input', wait: 0 });
  assert.doesNotMatch(input.text, /will be reported/);
  assert.match(input.text, /Reading the terminal failed, so whether a program waits for input couldn't be seen\. `look` with `until: "input"` reads it again\./);
});

test('H6: run\'s result opens with the status line: the command\'s status, duration, what is in front and the directory', async () => {
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
  assert.match(r.text, /… \d+ lines left out \(`read` with a range of `lines` within \[\d+, \d+\] gives more\)/);
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

test('a report a cancelled call gives back is offered before a newer one, to a host whose wakes start later', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'one' });
  await host.call(agent(), 'open', { name: 'two' });
  const [one, two] = opened as [FakeSession, FakeSession];
  two.runMode = 'run';
  await host.call(agent(), 'run', { name: 'two', command: 'sleep 9', wait: 0 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = one.run.bind(one);
  one.run = async (text, opts) => {
    const r = await run(text, opts);
    await gate;
    return r;
  };
  const ac = new AbortController();
  const taking = host.call(agent(), 'run', { name: 'one', command: 'true' }, ac.signal);
  await settle();
  two.end(0);
  await settle();
  ac.abort();
  release();
  assert.equal((await taking).structured.error, 'cancelled', 'the premise: the call that took the older end was cancelled');
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(wakes.map((w) => w.session), ['one', 'two'], 'the older end first');
});

test('H8: an end a call already returned wakes no one', async () => {
  const { host } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const ran = await host.call(agent(), 'run', { name: 'main', command: 'true' });
  assert.match(ran.text, /^\[main · command 1 · exit 0 · /, 'the premise: the run returned the end');
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

test('H8: notify_on reports its first match once, under its command\'s key with /match', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'main', command: 'serve', wait: 0, notify_on: 'listening on \\d+' });
  s.print('starting', 'listening on 8080', 'listening on 8081');
  await settle();
  assert.deepEqual(wakes.map((w) => [w.tag, w.key]), [['terminal:match', 'a/main/1/match']]);
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

test('open holds a terminal to the size whose whole screen fits in a result, naming the largest that fits, and a send and a wake at that size stay under the cap', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), false));
  const big = await host.call(agent(), 'open', { name: 'big', cols: 500, rows: 500 });
  assert.equal(big.isError, true);
  assert.match(big.text, /A terminal of 500 by 500 can show a screen of 250500 characters, more than a result can carry whole \(24000, less 1000 for its other lines\).* At 500 columns, up to 45 rows fit; at 500 rows, up to 45 columns\./);
  const tooWide = await host.call(agent(), 'open', { name: 'big', cols: 501 });
  assert.match(tooWide.text, /must be <= 500/);
  assert.equal(opened.length, 0);
  assert.equal((await host.call(agent(), 'open', { name: 'big', cols: 500, rows: 45 })).isError, undefined);
  const s = opened[0]!;
  s.screenNow = { rows: Array.from({ length: 45 }, (_, i) => `${i}`.padEnd(500, 'x')), cursor: { row: 44, col: 499 }, alt: true, title: 'top' };
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 9, argv: 'top', shell: false }, command: 1, waitVisible: true };
  const sent = await host.call(agent(), 'send', { name: 'big', keys: ['Down'] });
  assert.ok(sent.text.length <= RESULT_MAX_CHARS, `${sent.text.length}`);
  assert.match(sent.text, /\n44x+$/, 'the bottom row is there');
  assert.doesNotMatch(sent.text, /rows above not shown/);
  s.dir = `/${'d'.repeat(2100)}`;
  const long = await host.call(agent(), 'send', { name: 'big', keys: ['Down'] });
  assert.ok(long.text.length <= RESULT_MAX_CHARS, `in a 2,100-character directory: ${long.text.length}`);
  assert.match(long.text.split('\n')[0]!, / · \/d+… \(\d+ more characters\)\]$/, 'the directory is quoted');
  assert.doesNotMatch(long.text, /rows? above not shown/, 'so no row of the screen goes');
  assert.match(long.text, /\n44x+$/);
  s.emit({ kind: 'waiting', front: { state: 'waiting', since: Date.now(), process: { pgid: 9, argv: 'top', shell: false }, command: 1, echo: true }, taken: false });
  await settle();
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0]!.text.length <= RESULT_MAX_CHARS, `${wakes[0]!.text.length}`);
  assert.match(wakes[0]!.text, /\n44x+$/);
});

test('a command line, a title and a matched line a program sets are quoted up to a quarter of the room, so a screen at the largest size stays whole', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), false));
  await host.call(agent(), 'open', { name: 'big', cols: 500, rows: 45 });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 9, argv: `prog ${'a'.repeat(100_000)}`, shell: false }, command: 1, waitVisible: true };
  const listed = await host.call(agent(), 'list', {});
  assert.match(listed.text, /running prog a+… \(99755 more characters\)/);
  s.screenNow = { rows: Array.from({ length: 45 }, (_, i) => `${i}`.padEnd(500, 'x')), cursor: { row: 44, col: 499 }, alt: true, title: 'T'.repeat(100_000) };
  const sent = await host.call(agent(), 'send', { name: 'big', keys: ['Down'] });
  assert.ok(sent.text.length <= RESULT_MAX_CHARS, `${sent.text.length}`);
  assert.match(sent.text, /title "T+"… \(99750 more characters\);/, 'the note after the closing quotation mark');
  assert.doesNotMatch(sent.text, /rows above not shown/, 'with both clipped, no row of the screen goes');
  assert.match(sent.text, /\n44x+$/);
  s.screenNow = undefined;
  s.frontNow = { state: 'prompt', since: Date.now() };
  s.runMode = 'run';
  await host.call(agent(), 'run', { name: 'big', command: 'gen', wait: 0, notify_on: 'needle' });
  s.print(`needle ${'b'.repeat(100_000)}`);
  await settle();
  const match = wakes.find((w) => w.tag === 'terminal:match')!;
  assert.match(match.text, /Matched at line 1: needle b+… \(99757 more characters\) \(the line is longer than the match window: matched on its head only\)$/);
});

test('no result passes the cap, even with more endings not yet seen than its status lines fit', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runMode = 'run';
  for (let i = 0; i < 400; i++) {
    await host.call(agent(), 'run', { name: 'main', command: `job ${i} ${'y'.repeat(200)}`, wait: 0 });
    s.end(0);
  }
  await settle();
  const listed = await host.call(cli(), 'list', {});
  assert.ok(listed.text.length <= RESULT_MAX_CHARS, `${listed.text.length}`);
  assert.match(listed.text, /\n… \d+ characters left out, past the 24000 a result carries$/);
  assert.match(listed.text, /^main: at the prompt/);
});

test('a send whose wait ends before the prompt is drawn types nothing, and says so and for how long', async () => {
  const now = Date.now();
  const { host, opened } = setup(() => now);
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: now - 2_300, process: { pgid: 5, argv: 'bash', shell: true }, waitVisible: true };
  s.promptUndrawn = true;
  const r = await host.call(agent(), 'send', { name: 'main', keys: ['C-r'], wait: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.structured.error, 'not_at_prompt');
  assert.match(r.text, /\nNothing was typed: the shell hasn't finished drawing its prompt after 2\.3 s, .* `send` again with a longer `wait`\.$/);
});

test('a shell still running its startup files says so, in the status line and in a refused run', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 5, argv: '-bash', shell: true }, waitVisible: true, starting: true };
  const r = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^\[main · the shell is still running its startup files for /);
  assert.match(r.text, /\nNothing was typed: the shell is still running its startup files, and `run` works once it has drawn its first prompt\./);
  assert.doesNotMatch(r.text, /prompt hooks/);
  s.frontNow = { state: 'waiting', since: Date.now(), process: { pgid: 5, argv: '-bash', shell: true }, echo: false, starting: true };
  const w = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  assert.match(w.text, /^\[main · waiting for input in the shell's startup files: -bash, not echoed/);
  assert.match(w.text, /\nNothing was typed: -bash is waiting for input in the shell's startup files\. `send` answers it\.$/);
});

test('a refused run with the shell itself in front names the way out if its prompt hooks were removed, without saying they were', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  opened[0]!.frontNow = { state: 'running', since: Date.now(), process: { pgid: 5, argv: '-bash', shell: true }, waitVisible: true };
  const r = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  assert.match(r.text, /\nNothing was typed: the shell itself is busy\. .* If a command removed the session's prompt hooks, `close` it and `open` it again\.$/);
});

const running = (s: FakeSession) => (s.runMode = 'run');

test('a sink is offered one wake at a time, oldest first, each once; an acceptance clears only the wake it accepted', async () => {
  const { host, opened } = setup();
  const offered: Wake[] = [];
  const answers: Array<(v: boolean) => void> = [];
  host.subscribe('a', (w) => new Promise((resolve) => (offered.push(w), answers.push(resolve))));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  for (const cmd of ['one', 'two', 'three']) {
    await host.call(agent(), 'run', { name: 'main', command: cmd, wait: 0 });
    s.end(0);
    await settle();
  }
  assert.equal(offered.length, 1, 'one push in flight');
  answers[0]!(true);
  await settle();
  assert.equal(offered.length, 2);
  assert.match(offered[1]!.text, /command 2 ·/, 'the oldest waiting is offered next');
  answers[1]!(false);
  await settle();
  answers[2]!(true);
  await settle();
  assert.equal(offered.length, 3, 'each wake is offered once');
  const left = (await host.call(cli(), 'list', {})).structured.unseen as string[];
  assert.deepEqual(left.map((l) => /command (\d)/.exec(l)![1]), ['2'], 'only the refused one is left');
});

test('a late acceptance of an older wake under a key leaves the newer wake under it unseen', async () => {
  const { host, opened } = setup();
  const answers: Array<(v: boolean) => void> = [];
  host.subscribe('a', () => new Promise((resolve) => answers.push(resolve)));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'read x', wait: 0 });
  s.emit({ kind: 'waiting', front: { state: 'waiting', since: Date.now(), process: { pgid: 9, argv: 'read', shell: false }, command: 1, echo: true }, taken: false });
  await settle();
  s.end(1);
  await settle();
  answers[0]!(true);
  await settle();
  const left = (await host.call(cli(), 'list', {})).structured.unseen as string[];
  assert.equal(left.length, 1);
  assert.match(left[0]!, /command 1 · exit 1/, 'the end, which replaced the waiting wake under its key, is still unseen');
});

test("a report a call takes removes the older one not yet seen under its key: a command's end, taken, leaves no wait behind", async () => {
  const { host, opened } = setup();
  host.subscribe('a', async () => false);
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'read x', wait: 0 });
  s.emit({ kind: 'waiting', front: { state: 'waiting', since: Date.now(), process: { pgid: 9, argv: 'read', shell: false }, command: 1, echo: true }, taken: false });
  await settle();
  assert.equal(((await host.call(cli(), 'list', {})).structured.unseen as string[]).length, 1, 'the wait is kept, since no wake was accepted');
  s.end(0, true);
  await settle();
  assert.deepEqual((await host.call(cli(), 'list', {})).structured.unseen, []);
});

async function waitingCommand(host: Host, s: FakeSession): Promise<Command> {
  running(s);
  await host.call(cli(), 'run', { name: 'main', command: 'cat', wait: 0 });
  const c = s.current()!;
  const waiting: Front = { state: 'waiting', since: Date.now(), process: { pgid: 99, argv: 'cat', shell: false }, command: c.id, echo: true };
  s.frontNow = waiting;
  s.emit({ kind: 'waiting', front: waiting, taken: false });
  await settle();
  const kept = (await host.call(cli(), 'list', {})).structured.unseen as string[] | undefined;
  assert.equal(kept?.length, 1, 'the premise: the wait for input is kept as a report');
  return c;
}

function heldClose(s: FakeSession): { started: Promise<void>; release: () => void } {
  let begun!: () => void;
  const started = new Promise<void>((r) => (begun = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const close = s.close.bind(s);
  s.close = async (o) => (begun(), await gate, close(o));
  return { started, release };
}

test("a command's end a look shows during a close removes the older wait under its key, so the close doesn't report the wait", async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = await waitingCommand(host, s);
  let waitBegun!: () => void;
  const waitStarted = new Promise<void>((r) => (waitBegun = r));
  let endNow!: () => void;
  const ending = new Promise<void>((r) => (endNow = r));
  s.wait = async () => {
    waitBegun();
    await ending;
    c.to = s.out.length;
    c.end = { at: Date.now(), ms: 1, status: 0, errexit: false, refusedMarks: 0, cwd: '/w' };
    s.frontNow = { state: 'prompt', since: Date.now() };
    const ev = { kind: 'ended' as const, command: c, taken: true, takers: 1 };
    s.emit(ev);
    await settle();
    return { by: 'closed', front: s.front(), ended: [c], took: [ev] };
  };
  const held = heldClose(s);
  const looked = host.call(plain(), 'look', { name: 'main', until: 'end', wait: 1 });
  await waitStarted;
  const closed = host.call(plain(), 'close', { name: 'main' });
  await held.started;
  endNow();
  assert.match((await looked).text, /command 1 · exit 0|Command 1 ended/);
  held.release();
  const r = await closed;
  assert.deepEqual(r.structured.unseen ?? [], [], r.text);
});

test("a command's end that no call takes, during a close, removes the older wait under its key, though the end itself isn't kept", async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  await waitingCommand(host, s);
  const held = heldClose(s);
  const closed = host.call(plain(), 'close', { name: 'main' });
  await held.started;
  s.end(0);
  await settle();
  held.release();
  const r = await closed;
  assert.deepEqual(r.structured.unseen ?? [], [], r.text);
});

test("a close whose session's close fails keeps its reports and refuses input until a close finishes it", async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  const r = await host.call(agent(), 'run', { name: 'main', command: 'sleep 9', wait: 0 });
  assert.equal(r.structured.running, true, `the premise: a command runs: ${r.text}`);
  s.closeFails = new Error('the listing failed');
  const failed = await host.call(agent(), 'close', { name: 'main' });
  assert.equal(failed.structured.error, 'backend_failure', failed.text);
  s.end(0);
  await settle();
  assert.equal(wakes.length, 1, 'the end of the command that ran before the failed close wakes');
  const before = s.calls.length;
  for (const [tool, args, nothing] of [
    ['run', { command: 'echo hi', wait: 0 }, 'Nothing was typed.'],
    ['send', { text: 'q' }, 'Nothing was typed.'],
    ['stop', {}, 'Nothing was sent.'],
    ['integrate', {}, 'Nothing was typed.'],
  ] as const) {
    const refused = await host.call(agent(), tool, { name: 'main', ...args });
    assert.equal(refused.structured.error, 'close_failed', `${tool}: ${refused.text}`);
    assert.match(refused.text, /last close failed partway: the listing failed\./, tool);
    assert.ok(refused.text.includes(nothing), `${tool}: ${refused.text}`);
  }
  assert.deepEqual(s.calls.slice(before).map((c) => c.method), [], 'no input call reached the session');
  const look = await host.call(agent(), 'look', { name: 'main' });
  assert.equal(look.structured.error, undefined, `look goes on: ${look.text}`);
  const closed = await host.call(agent(), 'close', { name: 'main' });
  assert.equal(closed.structured.error, undefined, `a second close finishes it: ${closed.text}`);
  const gone = await host.call(agent(), 'run', { name: 'main', command: 'echo hi', wait: 0 });
  assert.equal(gone.structured.error, 'session_not_found', gone.text);
});

test('closing a session wakes no one, though its running command ends and its shell exits', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  running(opened[0]!);
  const r = await host.call(agent(), 'run', { name: 'main', command: 'sleep 9', wait: 0 });
  assert.equal(r.structured.running, true, 'a command was running when the session closed');
  const emitted: string[] = [];
  opened[0]!.onEvent((e) => emitted.push(e.kind));
  const closed = await host.call(agent(), 'close', { name: 'main' });
  await settle();
  assert.match(closed.text, /^\[main · closed\]\nThe shell /);
  assert.deepEqual(emitted, ['ended', 'exited'], 'the premise: the session gave the end and the exit');
  assert.deepEqual(wakes, []);
});

test('notify_on reports in the result when the command has ended, from buffered output while it runs, and never after its command ends', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runOutput = ['starting', 'READY now'];
  const ended = await host.call(agent(), 'run', { name: 'main', command: 'serve', notify_on: 'READY' });
  assert.match(ended.text, /\nMatched at line \d+: READY now/);
  s.runOutput = [];
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'gen', wait: 0, notify_on: 'ready' });
  s.end(0);
  await settle();
  wakes.length = 0;
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'other', wait: 0 });
  s.print('ready');
  await settle();
  assert.equal(wakes.filter((w) => w.tag === 'terminal:match').length, 0, "a later command's output doesn't fire the first one's watch");
  s.end(0);
  running(s);
  s.print('early ping');
  await host.call(agent(), 'run', { name: 'main', command: 'third', wait: 0, notify_on: 'ping' });
  await settle();
  assert.equal(wakes.filter((w) => w.tag === 'terminal:match').length, 0, 'output from before the command is not its output');
  s.print('ping');
  await settle();
  assert.equal(wakes.filter((w) => w.tag === 'terminal:match').length, 1);
});

test('an unaccepted match keeps its matched line for list, and the status line counts reports, not endings', async () => {
  const { host, opened } = setup();
  host.subscribe('a', async () => false);
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'gen', wait: 0, notify_on: 'needle' });
  s.print('a needle here');
  await settle();
  const listed = await host.call(cli(), 'list', {});
  assert.match(listed.text, /main: .* · 1 report not yet seen/);
  assert.match(listed.text, /\nMatched at line \d+: a needle here/);
});

test('a timed-out look promises only what will be reported, and its match is keyed apart from any command', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  assert.doesNotMatch((await host.call(agent(), 'look', { name: 'main', until: 'end', wait: 0 })).text, /The wait ended first/, 'at the prompt, nothing is waited for');
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 4242, argv: 'bash', shell: true }, waitVisible: true };
  const end = await host.call(agent(), 'look', { name: 'main', until: 'end', wait: 0 });
  assert.match(end.text, /No command is running, so no end will be reported/);
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 9, argv: 'cat', shell: false }, waitVisible: false };
  const input = await host.call(agent(), 'look', { name: 'main', until: 'input', wait: 0 });
  assert.match(input.text, /can't show a program waiting for input, so none will be reported/);
  s.frontNow = { state: 'prompt', since: Date.now() };
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'build', wait: 0 });
  await host.call(agent(), 'look', { name: 'main', match: 'done', wait: 0 });
  s.end(0);
  await settle();
  s.print('done');
  await settle();
  const match = wakes.find((w) => w.tag === 'terminal:match')!;
  const ending = wakes.find((w) => w.tag === 'terminal:ended')!;
  assert.notEqual(match.key, ending.key);
  assert.match(match.key, /^a\/main\/look$/);
});

test('the refusal at a typed line advises clearing the whole line, and run moves the look cursor only over output it returned', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.frontNow = { state: 'prompt', since: Date.now(), pending: 'half typed' };
  s.runMode = 'refuse';
  const r = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  s.runMode = 'end';
  assert.match(r.text, /With a line editor's default keys, `send` with `keys: \["C-e", "C-u"\]` clears the line/);
  s.frontNow = { state: 'prompt', since: Date.now() };
  s.out.push('unseen 1', 'unseen 2');
  await host.call(agent(), 'run', { name: 'main', command: 'echo hi' });
  const looked = await host.call(agent(), 'look', { name: 'main' });
  assert.match(looked.text, /unseen 1\nunseen 2/, 'output from before the run is still new to look');
});

test('unseen keeps nothing about a command the session has forgotten, and list clears only the reports it shows', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  for (let i = 0; i < 3; i++) {
    await host.call(agent(), 'run', { name: 'main', command: `c${i}`, wait: 0 });
    s.end(0);
  }
  await settle();
  s.commands.delete(1);
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'c3', wait: 0 });
  s.end(0);
  await settle();
  const ids = ((await host.call(cli(), 'list', {})).structured.unseen as string[]).map((l) => /command (\d)/.exec(l)![1]);
  assert.deepEqual(ids, ['2', '3', '4'], 'command 1 is forgotten, so its report goes');
  for (let i = 0; i < 400; i++) {
    running(s);
    await host.call(agent(), 'run', { name: 'main', command: `job ${i}`, wait: 0 });
    s.end(0);
  }
  await settle();
  const idsOf = (r: { structured: Record<string, unknown> }) => (r.structured.unseen as string[]).map((l) => /command (\d+)/.exec(l)![1]);
  const first = idsOf(await host.call(agent(), 'list', {}));
  assert.ok(first.length < 403, `${first.length} shown of 403`);
  const second = idsOf(await host.call(agent(), 'list', {}));
  assert.ok(second.length > 0, 'what the first list cut is still there');
  assert.deepEqual(second.filter((id) => first.includes(id)), [], 'nothing shown once is shown again');
});

test('unexpected failures, a second open of a starting name, and refused arguments each say what was and wasn\'t done', async () => {
  let release!: () => void;
  const opened: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      await new Promise<void>((r) => (release = r));
      const s = new FakeSession(o.name, o);
      opened.push(s);
      return s;
    },
    shell: '/bin/bash', env: { HOME: '/home/u' }, sessionsDir: '/tmp/sessions', startedAt: STARTED,
  });
  const first = host.call(agent(), 'open', { name: 'main' });
  await settle();
  const second = await Promise.race([host.call(agent(), 'open', { name: 'main' }), new Promise<{ isError?: true; text: string }>((r) => setTimeout(() => r({ text: 'still starting a second shell' }), 500))]);
  assert.equal(second.isError, true, second.text);
  assert.match(second.text, /already open in this scope, or opening/);
  release();
  await first;
  const s = opened[0]!;
  s.run = async () => {
    throw new Error('EIO writing the command file');
  };
  const failed = await host.call(agent(), 'run', { name: 'main', command: 'ls' });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /^`run` failed: EIO writing the command file\. Whether anything was typed or run is unknown; `look` shows the session as it is\.$/);
  const badKey = await host.call(agent(), 'send', { name: 'main', text: 'ls', keys: ['Entr'] });
  assert.match(badKey.text, /^`keys`: .*\. Nothing was typed\.$/);
  const badPattern = await host.call(agent(), 'look', { name: 'main', match: '(a)\\1', wait: 0 });
  assert.match(badPattern.text, /^`match`: .*\. Nothing was waited for\.$/);
});

test('an open that finishes after the daemon began stopping closes its shell', async () => {
  let release!: () => void;
  const opened: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      await new Promise<void>((r) => (release = r));
      const s = new FakeSession(o.name, o);
      opened.push(s);
      return s;
    },
    shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED,
  });
  const pending = host.call(agent(), 'open', { name: 'main' });
  await settle();
  let stopped = false;
  const stopping = host.closeAll().then(() => (stopped = true));
  await settle();
  assert.equal(stopped, false, 'stopping waits for the open still starting');
  release();
  await stopping;
  assert.ok(opened[0]!.closedWith, 'its shell was closed before stopping finished');
  const r = await pending;
  assert.equal(r.isError, true);
});

test("an open still starting when the daemon stops says what its shell's close did: it says the shell is closed only when the close confirmed it", async () => {
  const cases: Array<[string, () => Promise<Closed>, RegExp]> = [
    ['rejected', async () => Promise.reject(new Error('EIO')), /^The daemon stopped while this session started, and closing its shell failed: EIO, so whether it ended isn't known\.$/],
    ['under way', async () => ({ code: null, underway: true }), /^The daemon stopped while this session started, and its shell was still being closed by a close begun earlier when the stop's wait ended, and nothing had been sent to it yet\.$/],
    ['unconfirmed', async () => ({ code: null, signal: 'SIGKILL', unconfirmed: true }), /^The daemon stopped while this session started, and its shell was sent SIGKILL, and its exit wasn't seen within the grace after it\.$/],
    ['sent nothing', async () => ({ code: null, unconfirmed: true }), /^The daemon stopped while this session started, and its shell couldn't be sent a signal, and its exit wasn't seen\.$/],
    ['closed', async () => ({ code: null, signal: 'SIGKILL' }), /^The daemon stopped while this session started, so its shell is closed\.$/],
  ];
  for (const [kind, close, says] of cases) {
    let release!: () => void;
    const host = new Host({
      openSession: async (o: OpenOptions) => {
        await new Promise<void>((r) => (release = r));
        const s = new FakeSession(o.name, o);
        s.close = close;
        return s;
      },
      shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED,
    });
    const pending = host.call(agent(), 'open', { name: 'main' });
    await settle();
    const stopping = host.closeAll();
    await settle();
    release();
    await stopping;
    const r = await pending;
    assert.equal(r.isError, true, kind);
    assert.match(r.text, says, kind);
  }
});

test("an open still starting when the daemon stops logs its shell's close, and what may live on, as the stop's other closes do", async () => {
  let release!: () => void;
  const lines: string[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      await new Promise<void>((r) => (release = r));
      const s = new FakeSession(o.name, o);
      s.close = async () => ({ code: null, signal: 'SIGKILL', unlisted: true });
      return s;
    },
    shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED, log: (l) => lines.push(l),
  });
  const pending = host.call(agent(), 'open', { name: 'main' });
  await settle();
  const stopping = host.closeAll();
  await settle();
  release();
  await stopping;
  await pending;
  assert.deepEqual(lines, [
    'closing session "main" of scope "a", which was still opening',
    'session "main" of scope "a" closed, but not every process it started could be listed: processes it started may live on',
  ]);
});

test('a session that fails to close is logged by name as the daemon stops', async () => {
  const logs: string[] = [];
  const opened: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      opened.push(s);
      return s;
    },
    shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED, log: (l) => logs.push(l),
  });
  await host.call(agent(), 'open', { name: 'main' });
  await host.call(agent(), 'open', { name: 'other' });
  opened[0]!.close = async () => {
    throw new Error('EIO');
  };
  await host.closeAll();
  assert.ok(opened[1]!.closedWith, 'the other still closed');
  assert.deepEqual(logs.sort(), ['closing session "main" of scope "a"', 'closing session "main" of scope "a" failed: EIO', 'closing session "other" of scope "a"', 'session "other" of scope "a" closed']);
});

test('a close that finishes after the name was closed and opened again leaves the new session alone', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  let release!: () => void;
  const realClose = s.close.bind(s);
  s.close = async (o: { force?: boolean; deadline: number }) => {
    if (!o.force) await new Promise<void>((r) => (release = r));
    return realClose(o);
  };
  const graceful = host.call(agent(), 'close', { name: 'main' });
  await settle();
  await host.call(agent(), 'close', { name: 'main', force: true });
  assert.equal((await host.call(agent(), 'open', { name: 'main' })).isError, undefined);
  release();
  await graceful;
  const listed = await host.call(agent(), 'list', {});
  assert.match(listed.text, /^main: /, 'the new session is still open');
});

test('a timed-out look sets no watch for a caller that gets no pushes, and one per session for one that does', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const watches = () => s.calls.filter((c) => c.method === 'watch').length - s.calls.filter((c) => c.method === 'unwatch').length;
  await host.call({ scope: 'a', takes: true, pushes: false }, 'look', { name: 'main', match: 'x', wait: 0 });
  assert.equal(watches(), 0);
  for (let i = 0; i < 3; i++) await host.call(agent(), 'look', { name: 'main', match: `y${i}`, wait: 0 });
  assert.equal(watches(), 1);
});

test('a session that is closing refuses run, send, stop and integrate, and a forced close still goes through', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  let release!: () => void;
  const realClose = s.close.bind(s);
  s.close = async (o: { force?: boolean; deadline: number }) => {
    if (!o.force) await new Promise<void>((r) => (release = r));
    return realClose(o);
  };
  const graceful = host.call(agent(), 'close', { name: 'main' });
  await settle();
  for (const [tool, extra] of [['run', { command: 'ls' }], ['send', { text: 'x' }], ['stop', {}], ['integrate', {}]] as const) {
    const r = await host.call(agent(), tool, { name: 'main', ...extra });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /^Session "main" is closing, so nothing was (typed|sent)\./, tool);
  }
  assert.equal((await host.call(agent(), 'close', { name: 'main', force: true })).isError, undefined);
  release();
  await graceful;
});

test('notify_on reports a match the command printed before run returned', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  s.runOutput = ['ready at once'];
  await host.call(agent(), 'run', { name: 'main', command: 'serve', wait: 0, notify_on: 'ready' });
  await settle();
  const match = wakes.find((w) => w.tag === 'terminal:match');
  assert.ok(match, 'a match wake');
  assert.match(match.text, /Matched at line \d+: ready at once/);
});

test('look clears only the reports its result keeps, and shows the rest next time', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  for (let i = 0; i < 400; i++) {
    running(s);
    await host.call(agent(), 'run', { name: 'main', command: `job ${i}`, wait: 0 });
    s.end(0);
  }
  await settle();
  const idsOf = (r: { structured: Record<string, unknown> }) => (r.structured.unseen as string[]).map((l) => /command (\d+)/.exec(l)![1]);
  const first = await host.call(agent(), 'look', { name: 'main' });
  const firstIds = idsOf(first);
  assert.ok(firstIds.length > 0 && firstIds.length < 400, `${firstIds.length} shown of 400`);
  for (const id of firstIds) assert.match(first.text, new RegExp(`command ${id} ·`));
  const second = idsOf(await host.call(agent(), 'look', { name: 'main' }));
  assert.equal(second[0], String(Number(firstIds.at(-1)) + 1), 'the next report after the last one shown');
  assert.deepEqual(second.filter((id) => firstIds.includes(id)), []);
});

test('a match on a line longer than the match window says it was matched on the head only, in a result and in a wake', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runOutput = [`${'x'.repeat(70_000)} tail`];
  const ended = await host.call(agent(), 'run', { name: 'main', command: 'long', notify_on: 'x' });
  assert.match(ended.text, /\nMatched at line \d+: .* \(the line is longer than the match window: matched on its head only\)/);
  s.runOutput = [];
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'gen', wait: 0, notify_on: 'needle' });
  s.print(`needle ${'y'.repeat(70_000)}`);
  await settle();
  const wake = wakes.find((w) => w.tag === 'terminal:match')!;
  assert.match(wake.text, /\nMatched at line \d+: needle y+… \(\d+ more characters\) \(the line is longer than the match window: matched on its head only\)$/);
  s.end(0);
  await settle();
  const looked = await host.call(agent(), 'look', { name: 'main', match: 'needle', wait: 1 });
  assert.match(looked.text, /\nMatched at line \d+: needle y+… \(\d+ more characters\) \(the line is longer than the match window: matched on its head only\)/);
  assert.equal(s.calls.filter((c) => c.method === 'watch').length, 1, 'a look that matched at once sets no watch');
});

test('a line cut to fit a result is cut between characters, never inside a surrogate pair', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const pad of ['', 'x'])
    for (const fromEnd of [false, true]) {
      const cut = cutAt(`${pad}${'😀'.repeat(100)}${pad}`, 51, fromEnd);
      assert.ok(cut.length <= 51, `${cut.length}`);
      assert.doesNotMatch(cut, lone, `pad ${JSON.stringify(pad)}, from the ${fromEnd ? 'end' : 'start'}`);
    }
});

test('a single line too long for a result keeps its start and its end, and says how much of it was left out', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.out = [`${'a'.repeat(30_000)}${'b'.repeat(30_000)}`];
  const r = await host.call(cli(), 'read', { name: 'main', lines: [0, 1] });
  assert.ok(r.text.length <= RESULT_MAX_CHARS, `${r.text.length}`);
  assert.match(r.text, /\na+…\n… \d+ characters of this line left out, which no call returns; .*\n…b+$/);
  const [, cut] = /… (\d+) characters of this line left out/.exec(r.text)!;
  const kept = (/\n(a+)…/.exec(r.text)![1]!.length) + (/…(b+)$/.exec(r.text)![1]!.length);
  assert.equal(kept + Number(cut), 60_000);
});

test('lines cut short to fit say so with the read hint, even with no line left out whole', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.out = ['a'.repeat(20_000), 'b'.repeat(20_000)];
  const r = await host.call(cli(), 'read', { name: 'main', lines: [0, 2] });
  assert.match(r.text, /\na+…\n… 2 lines cut short \(`read` with a range of `lines` within \[0, 2\] gives more\)\n…b+$/);
});

test('a read search lets other calls run between the lines it searches', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  opened[0]!.out = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  let done = false;
  let turns = 0;
  const tick = (): void => {
    if (done) return;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  await host.call(cli(), 'read', { name: 'main', match: 'nowhere' });
  done = true;
  assert.ok(turns >= 48, `the event loop turned ${turns} times while it searched 50 lines`);
});

test('a call that waited while its session closed is refused, and sets no watch', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  let release!: () => void;
  const fakeWait = s.wait.bind(s);
  s.wait = async (until, opts) => {
    await new Promise<void>((r) => (release = r));
    return fakeWait(until, opts);
  };
  const looking = host.call(agent(), 'look', { name: 'main', match: 'never', wait: 5 });
  await settle();
  const closing = host.call(agent(), 'close', { name: 'main' });
  release();
  const r = await looking;
  await closing;
  assert.equal(r.isError, true);
  assert.match(r.text, /^Session "main" was closed while this call waited\. `list` shows the sessions still open\.$/);
  assert.equal(s.calls.filter((c) => c.method === 'watch').length, 0);
});

test('a timed-out look watches from where its wait started, though another call moved the cursor meanwhile', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.out = ['one', 'two'];
  s.live = 0;
  await host.call(agent(), 'look', { name: 'main' });
  let release!: () => void;
  const fakeWait = s.wait.bind(s);
  s.wait = async (until, opts) => {
    await new Promise<void>((r) => (release = r));
    return fakeWait(until, opts);
  };
  const looking = host.call(agent(), 'look', { name: 'main', match: 'never', wait: 5 });
  await settle();
  s.out.push('three', 'four');
  s.wait = fakeWait;
  await host.call(agent(), 'look', { name: 'main' });
  release();
  await looking;
  const watched = s.calls.find((c) => c.method === 'watch')!;
  assert.equal(watched.args[1], 2, 'from the line the wait started at, not the one the other look left');
});

test('an unseen notify_on match about a command the session has forgotten is dropped', async () => {
  const { host, opened } = setup();
  host.subscribe('a', async () => false);
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  const r = await host.call(agent(), 'run', { name: 'main', command: 'gen', wait: 0, notify_on: 'needle' });
  const id = (r.structured.command as { id: number }).id;
  s.print('needle');
  await settle();
  assert.match((await host.call(cli(), 'list', {})).text, /Matched at line/);
  s.end(0, true);
  s.commands.delete(id);
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'next', wait: 0 });
  s.end(0);
  await settle();
  assert.doesNotMatch((await host.call(cli(), 'list', {})).text, /Matched at line/);
});

test('strings in structured content are cut as the text quotes them', async () => {
  const { host } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const r = await host.call(agent(), 'run', { name: 'main', command: `echo ${'z'.repeat(1000)}` });
  const text = (r.structured.command as { text: string }).text;
  assert.match(text, /^echo z+… \(\d+ more characters\)$/);
  assert.ok(text.length < 300, `${text.length}`);
});

test('a failed open or close says what is unknown and that list shows it; a backend failure says what the session said, next step included', async () => {
  let fail: Error = new Error('EMFILE');
  const host = new Host({ openSession: async () => { throw fail; }, shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED });
  const r = await host.call(agent(), 'open', { name: 'main' });
  assert.match(r.text, /^`open` failed: EMFILE\. Whether the session opened is unknown; `list` shows the sessions open\.$/);
  const { TermError } = await import('../src/core/errors.js');
  fail = new TermError('backend_failure', 'this host has no bash. Sessions open here once bash is installed');
  const b = await host.call(agent(), 'open', { name: 'main' });
  assert.equal(b.text, 'This host has no bash. Sessions open here once bash is installed.');
});

test('a failure whose message ends with a period gets no second one', async () => {
  const host = new Host({ openSession: async () => { throw new Error('posix_spawnp failed.'); }, shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED });
  const r = await host.call(agent(), 'open', { name: 'main' });
  assert.equal(r.text, '`open` failed: posix_spawnp failed. Whether the session opened is unknown; `list` shows the sessions open.');
});

test('a send refused at the longest wait advises look, not a longer wait', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 5, argv: 'bash', shell: true }, waitVisible: true };
  s.promptUndrawn = true;
  const r = await host.call(agent(), 'send', { name: 'main', text: 'x', wait: 55 });
  assert.match(r.text, / `look` shows what is in front\.$/);
});

test('the status line quotes a long directory, so the rest of a result keeps its room', async () => {
  const { host } = setup();
  const r = await host.call(agent(), 'open', { name: 'main', cwd: `/${'d'.repeat(2000)}` });
  assert.match(r.text.split('\n')[0]!, / · \/d+… \(\d+ more characters\)\]$/);
});

test("run's structured content gives the command's own output and its exit code, a non-zero one as a result", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runOutput = ['a.txt', 'b.txt'];
  s.runStatus = 1;
  const r = await host.call(agent(), 'run', { name: 'main', command: 'grep -l x *.txt' });
  assert.equal(r.isError, undefined);
  assert.equal(r.structured.exitCode, 1);
  assert.equal(r.structured.output, 'a.txt\nb.txt', 'the lines alone, without the typed command');
  assert.equal(r.structured.outputLeftOut, undefined);
  s.runStatus = undefined;
  const unknown = await host.call(agent(), 'run', { name: 'main', command: 'true' });
  assert.deepEqual([unknown.structured.exitCode, unknown.structured.running], [null, false]);
  s.runOutput = ['started'];
  running(s);
  const still = await host.call(agent(), 'run', { name: 'main', command: 'serve', wait: 0 });
  assert.deepEqual([still.structured.exitCode, still.structured.running, still.structured.output], [null, true, 'started']);
});

test("run's output past its budget keeps its start and end, and says where the gap is and how long, never splitting a surrogate pair", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const lines = Array.from({ length: 3000 }, (_, i) => `${i} 😀 ${'x'.repeat(i % 7)}`);
  s.runOutput = lines;
  const r = await host.call(agent(), 'run', { name: 'main', command: 'gen' });
  const output = r.structured.output as string;
  const gap = r.structured.outputLeftOut as { at: number; characters: number };
  const whole = lines.join('\n');
  assert.ok(output.length < RESULT_MAX_CHARS, `${output.length}`);
  assert.equal(output.slice(0, gap.at) + whole.slice(gap.at, gap.at + gap.characters) + output.slice(gap.at), whole);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(output, lone);
  for (const pad of ['', 'x'])
    for (const budget of [60, 61]) {
      const text = `${pad}${'😀'.repeat(100)}`;
      const v = outputValue([text], budget);
      assert.doesNotMatch(v.output, lone, `pad ${JSON.stringify(pad)}, budget ${budget}`);
      assert.equal(v.output.slice(0, v.outputLeftOut!.at) + text.slice(v.outputLeftOut!.at, v.outputLeftOut!.at + v.outputLeftOut!.characters) + v.output.slice(v.outputLeftOut!.at), text);
    }
});

test("output joins the pieces of one long line with no line break, and its left-out count is the command's own characters", () => {
  assert.equal(outputValue(['ab', 'cd', 'ef'], 100, [1]).output, 'abcd\nef');
  const v = outputValue(['x'.repeat(60), 'y'.repeat(40)], 30, [1]);
  assert.equal(v.output.length + v.outputLeftOut!.characters, 100);
});

test("the note of earlier lines no longer kept counts within the text's budget, so lines that fit the budget alone keep their end", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  const budget = lines.join('\n').length;
  const text = linesText({ from: 10, to: 50, lines, dropped: 10, live: 0 }, budget, '`read` gives more');
  assert.ok(text.length <= budget, `${text.length} > ${budget}`);
  assert.match(text, /^… 10 earlier lines no longer kept\n/);
  assert.ok(text.endsWith(`\n${lines.at(-1)}`), text.slice(-80));
});

test("the host says what the session reports of a match on the screen, an undelivered signal, an unlisted or unseen close, a timed-out search's long lines, unknown echo and a command's duration", async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'top', wait: 0, notify_on: 'READY' });
  const id = [...s.watches.keys()].at(-1)!;
  s.emit({ kind: 'match', watch: id, match: { line: 5, text: 'ALT-READY', row: 2 } });
  await settle();
  assert.match(wakes.find((w) => w.tag === 'terminal:match')!.text, /\nMatched on the screen, row 3: ALT-READY$/);
  s.stop = async () => ({ steps: [{ sent: 'SIGTERM', to: { pgid: 9, argv: 'sudo -n sleep 9', shell: false }, refused: 'EPERM', front: s.frontNow }], front: s.frontNow });
  assert.match((await host.call(agent(), 'stop', { name: 'main' })).text, /\nSIGTERM wasn't delivered to sudo -n sleep 9 \(EPERM\), so no further step was taken: now /);
  s.send = async () => ({ sent: true, lines: s.lines(s.out.length), front: s.frontNow, ended: [], by: 'timeout', clipped: 2, took: [] });
  assert.match((await host.call(agent(), 'send', { name: 'main', text: 'x', wait_for: 'never', wait: 1 })).text, /\nThe wait ended before the pattern matched; 2 lines longer than the match window, searched on their head only\./);
  s.frontNow = { state: 'waiting', since: Date.now(), process: { pgid: 9, argv: 'read', shell: false } };
  assert.match((await host.call(agent(), 'list', {})).text, /waiting for input: read, echo unknown, for /);
  const made = s.end(0);
  made.end!.ms = 1_200;
  await settle();
  assert.ok(wakes.some((w) => w.tag === 'terminal:ended' && / · exit 0 · 1\.2 s · /.test(w.text)), "the duration is the ending's own");
  s.close = async () => ({ code: null, signal: 'SIGKILL', unconfirmed: true, unlisted: true });
  assert.equal((await host.call(agent(), 'close', { name: 'main', force: true })).text, "[main · closed]\nThe shell was sent SIGKILL, and its exit wasn't seen within the grace after it. The session couldn't list every process it started, so jobs it started may live on.");
});

test("a close that couldn't send the shell any signal doesn't say one was sent", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened.at(-1)!;
  s.close = async () => ({ code: null, unconfirmed: true });
  assert.equal((await host.call(agent(), 'close', { name: 'main' })).text, "[main · closed]\nThe shell couldn't be sent a signal, and its exit wasn't seen.");
});

test('a search the wait ended before it reached the end says how many lines it never searched, and what searches them', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.out = Array.from({ length: 1300 }, (_, i) => `line ${i}`);
  s.send = async () => ({ sent: true, lines: s.lines(s.out.length), front: s.frontNow, ended: [], by: 'timeout', unsearched: 1202, unsearchedFrom: 100, clipped: 3, took: [] });
  const sent = await host.call(agent(), 'send', { name: 'main', text: 'x', wait_for: 'DONE', wait: 5 });
  assert.match(sent.text, /\nThe wait ended with 1202 lines not yet searched, and no match in those it searched; 3 lines longer than the match window, searched on their head only\. `read` with `match` and `lines: \[100, 1300\]` searches them\. The screen's 2 rows it didn't reach are on the screen now\./);
  s.wait = async () => ({ by: 'timeout', front: s.frontNow, ended: [], unsearched: 1, unsearchedFrom: 1299, took: [] });
  assert.match((await host.call(cli(), 'look', { name: 'main', match: 'DONE', wait: 5 })).text, /\nThe wait ended with 1 line not yet searched, and no match in those it searched\. `read` with `match` and `lines: \[1299, 1300\]` searches them\.$/m);
  assert.match((await host.call(agent(), 'look', { name: 'main', match: 'DONE', wait: 5 })).text, /\nThe wait ended with 1 line not yet searched, and no match in those it searched\. The match will be reported to you when it comes\./);
  s.wait = async () => ({ by: 'timeout', front: s.frontNow, ended: [], took: [] });
  assert.match((await host.call(agent(), 'look', { name: 'main', match: 'DONE', wait: 5 })).text, /\nThe wait ended first\. The match will be reported to you when it comes\./);
});

const plain = (scope = 'a'): Caller => ({ scope, takes: true, pushes: false });
const unseenOf = async (host: Host): Promise<string[]> => (await host.call(cli(), 'list', {})).structured.unseen as string[];

test('a pattern a command asked to be told of stays reported when its command ends before anyone saw the match', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', notify_on: 'needle', wait: 0 });
  s.print('a needle here');
  await settle();
  s.end(0);
  await settle();
  const unseen = await unseenOf(host);
  assert.equal(unseen.length, 2, unseen.join('\n---\n'));
  assert.match(unseen[0]!, /\nMatched at line \d+: a needle here$/);
  assert.match(unseen[1]!, /^\[main · command 1 · exit 0 /);
});

test('a match is pushed under a key of its own, so a host coalescing by key keeps it beside its command\'s end', async () => {
  const { host, opened } = setup();
  const keys: string[] = [];
  host.subscribe('a', async (w) => (keys.push(`${w.tag} ${w.key}`), false));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(agent(), 'run', { name: 'main', command: 'make', notify_on: 'needle', wait: 0 });
  s.print('a needle here');
  await settle();
  await settle();
  s.end(0);
  await settle();
  await settle();
  const match = keys.find((k) => k.startsWith('terminal:match'))!.split(' ')[1];
  const end = keys.find((k) => k.startsWith('terminal:ended'))!.split(' ')[1];
  assert.notEqual(match, end);
});

test('a single line longer than a result says its middle is returned by no call, and what can show it', async () => {
  const { host, opened } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  opened[0]!.out = ['x'.repeat(30_000)];
  const r = await host.call(cli(), 'read', { name: 'main', lines: [0, 1] });
  assert.match(r.text, /\n… \d+ characters of this line left out, which no call returns; a command that prints the line in pieces, such as `fold -w 10000`, shows them\n/);
});

test('read takes `command` or `lines`, not both, and a cut command output names the range of lines that gives more', async () => {
  const { host, opened } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runOutput = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'y'.repeat(20)}`);
  const r = await host.call(cli(), 'run', { name: 'main', command: 'make' });
  const c = r.structured.command as { id: number; from: number; to: number };
  assert.match(r.text, new RegExp(`\\(\`read\` with a range of \`lines\` within \\[${c.from}, ${c.to}\\] gives more\\)`));
  const both = await host.call(cli(), 'read', { name: 'main', command: c.id, lines: [c.from + 10, c.from + 20] });
  assert.equal(both.isError, true);
  assert.equal(both.structured.error, 'invalid_argument');
  assert.match(both.text, /^Give `command` or `lines`, not both/);
});

test('a read search and a notify_on search of an ended command stop at the 55 s a call may hold, and say which lines they left', async () => {
  const { host, opened } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.out = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  let t = 0;
  const clock = mock.method(performance, 'now', () => (t += 5_000));
  try {
    const r = await host.call(cli(), 'read', { name: 'main', match: 'nowhere' });
    assert.match(r.text, /searched lines 0 to \d+ before the 55 s a call may hold ran out; `read` with `match` and `lines: \[\d+, 50\]` searches the rest/);
    assert.ok((r.structured.unsearched as { from: number }).from < 50);
    s.runOutput = Array.from({ length: 50 }, (_, i) => `out ${i}`);
    const run = await host.call(cli(), 'run', { name: 'main', command: 'make', notify_on: 'nowhere' });
    assert.match(run.text, /`notify_on` searched lines \d+ to \d+ before the 55 s a call may hold ran out; `read` with `match` and `lines: \[\d+, \d+\]` searches the rest/);
  } finally {
    clock.mock.restore();
  }
});

test('a report keeps its status line whole when a directory holds a line break, and the status line stays one line', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main', cwd: '/tmp' });
  const s = opened[0]!;
  s.dir = '/tmp/a\nb';
  running(s);
  const r = await host.call(plain(), 'run', { name: 'main', command: 'make', notify_on: 'needle', wait: 0 });
  assert.match(r.text.split('\n')[0]!, /^\[main · command 1 · still running · .* · \/tmp\/a\\nb\]$/);
  s.print('a needle here');
  await settle();
  const [report] = await unseenOf(host);
  const lines = report!.split('\n');
  assert.equal(lines.length, 2, report);
  assert.match(lines[0]!, /\/tmp\/a\\nb\]$/);
  assert.match(lines[1]!, /^Matched at line \d+: a needle here$/);
});

test("a run whose stop signal's stopped check couldn't be read has no exit code, and says whether it stopped isn't known", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.run = async (text) => {
    const c = { id: 4, text, from: 0, to: 1, startedAt: Date.now(), end: { at: Date.now(), ms: 1200, status: 146, errexit: false, refusedMarks: 0, stoppedUnknown: true as const } };
    s.commands.set(4, c);
    return { kind: 'ended', command: c, front: s.frontNow, took: [] };
  };
  const r = await host.call(agent(), 'run', { name: 'main', command: 'sleep 30' });
  assert.deepEqual([r.structured.exitCode, r.structured.stoppedUnknown], [null, true], JSON.stringify(r.structured));
  assert.match(r.text, /^\[main · command 4 · whether the stop signal stopped it isn't known \(the shell reported exit 146\) · 1\.2 s · /);
});

/** A command `s` no longer follows, ended as the session reports one. */
const unfollowedEnd = (s: FakeSession, id: number, text: string): Command => {
  const c = { id, text, from: 0, to: 1, startedAt: Date.now(), end: { at: Date.now(), ms: 1200, errexit: false, refusedMarks: 0, unfollowed: { by: 'ssh box', how: 'left' as const } } };
  s.commands.set(id, c);
  return c;
};

test("a run on a session closed while it waited doesn't call a command the session stopped following ended", async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  let closing: Promise<unknown> = Promise.resolve();
  s.run = async (text) => {
    const c = unfollowedEnd(s, 7, text);
    closing = host.call(cli(), 'close', { name: 'main' });
    return { kind: 'ended', command: c, front: s.frontNow, took: [] };
  };
  const r = await host.call(plain(), 'run', { name: 'main', command: 'make' });
  await closing;
  assert.match(r.text, /^Session "main" was closed while this call waited\. Command 7 was typed: no longer followed: ssh box left the terminal, so whether the command ended isn't known · followed for 1\.2 s\. /);
});

test("a wait's ends don't call a command the session stopped following ended", async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = unfollowedEnd(s, 8, 'make');
  s.wait = async () => ({ by: 'end', front: s.frontNow, ended: [c], took: [] });
  const w = await host.call(plain(), 'look', { name: 'main', until: 'end' });
  assert.match(w.text, /Command 8: no longer followed: ssh box left the terminal, so whether the command ended isn't known · followed for 1\.2 s\./);
  assert.doesNotMatch(w.text, /Command 8 ended/);
});

test('a run or send on a session closed while it waited says what it typed and what ended', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  let closing: Promise<unknown> = Promise.resolve();
  s.run = async (text) => {
    const c = { id: 7, text, from: 0, to: 1, startedAt: Date.now(), end: { at: Date.now(), ms: 1200, status: 0, errexit: false, refusedMarks: 0 } };
    s.commands.set(7, c);
    closing = host.call(cli(), 'close', { name: 'main' });
    return { kind: 'ended', command: c, front: s.frontNow, took: [] };
  };
  const r = await host.call(plain(), 'run', { name: 'main', command: 'make' });
  await closing;
  assert.equal(r.isError, true);
  assert.match(r.text, /^Session "main" was closed while this call waited\. Command 7 was typed, and ended: exit 0 · 1\.2 s\. /);
  await host.call(plain(), 'open', { name: 'other' });
  const o = opened[1]!;
  o.send = async () => {
    closing = host.call(cli(), 'close', { name: 'other' });
    return { sent: true, lines: o.lines(0), front: o.frontNow, ended: [], by: 'closed', took: [] };
  };
  const sent = await host.call(plain(), 'send', { name: 'other', text: 'y\n' });
  await closing;
  assert.match(sent.text, /^Session "other" was closed while this call waited\. Its input was typed\. /);
});

test('closing a session returns the reports about it that no one has seen, since nothing can show them after', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  const r = await host.call(plain(), 'close', { name: 'main' });
  assert.match(r.text, /\n\nNot yet seen:\n\[main · command 1 · exit 2 /);
  assert.equal((r.structured.unseen as string[]).length, 1);
});

test('a session that a caller taking no reports closes, after one taking them used it, leaves its unseen reports and its close for list, and frees its name', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  const closed = await host.call(cli(), 'close', { name: 'main' });
  assert.match(closed.text, /\n\nNot yet seen:\n\[main · command 1 · exit 2 /);
  assert.equal((await host.call(cli(), 'open', { name: 'main' })).isError, undefined, 'the name is free at once');
  const first = await host.call(plain(), 'list', {});
  assert.match(first.text, /\n\nNot yet seen:\n\[main · command 1 · exit 2 [^\n]*\n\[main · closed by a caller that takes no reports; the shell /);
  assert.equal(((await host.call(plain(), 'list', {})).structured.unseen as string[]).length, 0, 'a taking list forgets them');
});

test('a close whose call is cancelled before its result is made counts nothing as shown, and leaves the reports and its close for list', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const close = s.close.bind(s);
  s.close = async (o) => (await held, close(o));
  const ac = new AbortController();
  const closing = host.call(plain(), 'close', { name: 'main' }, ac.signal);
  await settle();
  ac.abort();
  release();
  await closing;
  const r = await host.call(plain(), 'list', {});
  assert.match(r.text, /\n\nNot yet seen:\n\[main · command 1 · exit 2 [^\n]*\n\[main · closed by a call that was cancelled or lost its connection; the shell /);
});

test("a close that joins one begun earlier says when that close left the session's reports in list, and nothing when it showed them", async () => {
  for (const firstTakes of [false, true]) {
    const { host, opened } = setup();
    await host.call(plain(), 'open', { name: 'main' });
    const s = opened[0]!;
    running(s);
    await host.call(plain(), 'run', { name: 'main', command: 'make', wait: 0 });
    s.end(2);
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const close = s.close.bind(s);
    let joined: Promise<Closed> | undefined;
    s.close = (o) => (joined ??= (async () => (await gate, close(o)))());
    const firstCall = host.call(firstTakes ? plain() : cli(), 'close', { name: 'main' });
    await settle();
    const secondCall = host.call(firstTakes ? cli() : plain(), 'close', { name: 'main' });
    await settle();
    release();
    const [first, r] = await Promise.all([firstCall, secondCall]);
    if (firstTakes) {
      assert.match(first.text, /\n\nNot yet seen:\n\[main · command 1 · exit 2 /);
      assert.doesNotMatch(r.text, /in `list`/, r.text);
    } else assert.match(r.text, /\n2 reports about this session that no call showed are in `list`\.$/, r.text);
  }
});

test('a host whose wakes start after reports were kept is offered each one still unseen in its scope, oldest first', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  await host.call(plain(), 'open', { name: 'other' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  await host.call(cli(), 'close', { name: 'other' });
  const offered: Wake[] = [];
  host.subscribe('a', async (w) => (offered.push(w), true));
  await settle();
  await settle();
  assert.equal(offered.length, 2, offered.map((w) => w.text).join('\n'));
  assert.match(offered[0]!.text, /^\[main · command 1 · exit 2 /);
  assert.match(offered[1]!.text, /^\[other · closed by a caller that takes no reports; the shell /);
  assert.deepEqual((await host.call(cli(), 'list', {})).structured.unseen, [], 'each was taken');
});

test('a host that takes reports is woken when a caller taking none closes a session it used', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  await host.call(cli(), 'close', { name: 'main' });
  await settle();
  assert.equal(opened.length, 1);
  assert.deepEqual(wakes.map((w) => w.tag), ['terminal:exited']);
  assert.match(wakes[0]!.text, /^\[main · closed by a caller that takes no reports; the shell /);
  assert.equal(((await host.call(plain(), 'list', {})).structured.unseen as string[] | undefined)?.length ?? 0, 0);
});

test('a session a caller taking none opened, then a taking list showed, leaves its close for list when that caller closes it', async () => {
  const { host } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  await host.call(plain(), 'list', {});
  await host.call(cli(), 'close', { name: 'main' });
  const r = await host.call(plain(), 'list', {});
  assert.match(r.text, /\n\nNot yet seen:\n\[main · closed by a caller that takes no reports; the shell /);
});

test('a host that accepted a wake about a session a caller taking none opened is woken when that caller closes it', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  await host.call(cli(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(cli(), 'run', { name: 'main', command: 'make', wait: 0 });
  host.subscribe('a', async (w) => (wakes.push(w), true));
  s.end(2);
  await settle();
  assert.equal(wakes.length, 1);
  await host.call(cli(), 'close', { name: 'main' });
  await settle();
  assert.equal(wakes.length, 2, wakes.map((w) => w.text).join('\n'));
  assert.match(wakes[1]!.text, /^\[main · closed by a caller that takes no reports; the shell /);
});

test("a taking caller refused with a session's name, as not found or already open, counts as shown it", async () => {
  const { host } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  await host.call(cli(), 'open', { name: 'work' });
  assert.equal((await host.call(plain(), 'look', { name: 'nope' })).structured.error, 'session_not_found');
  await host.call(cli(), 'close', { name: 'main' });
  await host.call(cli(), 'open', { name: 'other' });
  assert.equal((await host.call(plain(), 'open', { name: 'other' })).structured.error, 'session_exists');
  await host.call(cli(), 'close', { name: 'other' });
  const r = await host.call(plain(), 'list', {});
  assert.match(r.text, /\[main · closed by a caller that takes no reports; /);
  assert.match(r.text, /\[other · closed by a caller that takes no reports; /);
});

test("a taking caller refused because the session is still opening counts as shown it once it opens", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      await held;
      return new FakeSession(o.name, o);
    },
    shell: '/bin/bash',
    env: { HOME: '/home/u' },
    sessionsDir: '/tmp/sessions',
    startedAt: STARTED,
  });
  const opening = host.call(cli(), 'open', { name: 'main' });
  await settle();
  assert.equal((await host.call(plain(), 'open', { name: 'main' })).structured.error, 'session_exists');
  release();
  await opening;
  await host.call(cli(), 'close', { name: 'main' });
  const r = await host.call(plain(), 'list', {});
  assert.match(r.text, /\n\nNot yet seen:\n\[main · closed by a caller that takes no reports; the shell /);
});

test('a report a host accepts after a caller taking none closed its session, moving it, is forgotten', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  let accept!: (v: boolean) => void;
  host.subscribe('a', (w) => {
    wakes.push(w);
    return wakes.length === 1 ? new Promise<boolean>((r) => (accept = r)) : Promise.resolve(true);
  });
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(cli(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  assert.equal(wakes.length, 1);
  await host.call(cli(), 'close', { name: 'main' });
  accept(true);
  await settle();
  await settle();
  assert.equal(wakes.length, 2, wakes.map((w) => w.text).join('\n'));
  const r = await host.call(plain(), 'list', {});
  assert.match(r.text, /^No session is open in scope "a"\.$/);
});

test('a session a caller taking none opened counts as shown once a wake about it is offered, before the host answers', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  let accept!: (v: boolean) => void;
  host.subscribe('a', (w) => {
    wakes.push(w);
    return wakes.length === 1 ? new Promise<boolean>((r) => (accept = r)) : Promise.resolve(true);
  });
  await host.call(cli(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(cli(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  assert.equal(wakes.length, 1);
  await host.call(cli(), 'close', { name: 'main' });
  accept(true);
  await settle();
  await settle();
  assert.equal(wakes.length, 2, wakes.map((w) => w.text).join('\n'));
  assert.match(wakes[1]!.text, /^\[main · closed by a caller that takes no reports; the shell /);
});

test('a close that joined one under way and whose wait ended first says the session is still closing, and leaves it to that close', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const close = s.close.bind(s);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let calls = 0;
  s.close = async (opts) => {
    if (++calls > 1) return { code: null, underway: true };
    await held;
    return close(opts);
  };
  const first = host.call(cli(), 'close', { name: 'main' });
  await settle();
  const joined = await host.call(cli(), 'close', { name: 'main' });
  assert.equal(joined.text, "[main · still closing]\nThe shell was still being closed by a close begun earlier when this call's wait ended, and nothing had been sent to it yet.");
  assert.match((await host.call(plain(), 'list', {})).text, /^main: /);
  release();
  assert.match((await first).text, /^\[main · closed\]/);
  const r = await host.call(plain(), 'list', {});
  assert.equal((r.text.match(/closed by a caller that takes no reports/g) ?? []).length, 1, r.text);
});

test('two closes that end with the same exit finish the session once', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const close = s.close.bind(s);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let shared: ReturnType<typeof close> | undefined;
  s.close = (opts) => (shared ??= held.then(() => close(opts)));
  const both = Promise.all([host.call(cli(), 'close', { name: 'main' }), host.call(cli(), 'close', { name: 'main' })]);
  await settle();
  release();
  for (const r of await both) assert.match(r.text, /^\[main · closed\]\nThe shell /);
  const r = await host.call(plain(), 'list', {});
  assert.equal((r.text.match(/closed by a caller that takes no reports/g) ?? []).length, 1, r.text);
});

test('a session no caller taking reports used leaves nothing behind when one taking none closes it', async () => {
  const { host, opened } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(cli(), 'run', { name: 'main', command: 'make', wait: 0 });
  s.end(2);
  await settle();
  await host.call(cli(), 'close', { name: 'main' });
  const r = await host.call(plain(), 'list', {});
  assert.match(r.text, /^No session is open in scope "a"\.$/);
  assert.equal((r.structured.unseen as string[] | undefined)?.length ?? 0, 0);
});

test("close returns the reports that fit its result, and keeps the rest for list", async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.dir = `/home/u/${'d'.repeat(1_000)}`;
  const n = 120;
  for (let i = 0; i < n; i++) {
    running(s);
    await host.call(plain(), 'run', { name: 'main', command: `c${i}`, wait: 0 });
    s.end(1);
    await settle();
  }
  const closed = await host.call(plain(), 'close', { name: 'main' });
  const shown = (closed.structured.unseen as string[]).length;
  assert.ok(shown > 0 && shown < n, `close showed ${shown} of ${n}`);
  assert.ok(closed.text.length <= RESULT_MAX_CHARS);
  const listed = await host.call(plain(), 'list', {});
  assert.equal((listed.structured.unseen as string[]).length, n - shown, 'list gives the rest');
  assert.match(listed.text, new RegExp(`\\n\\nNot yet seen:\\n\\[main · command ${shown + 1} · exit 1 `));
});

test("a close whose wait ends while an earlier close is still under way says so, and names only a signal that close had sent", async () => {
  const lines: string[] = [];
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
    log: (line) => lines.push(line),
  });
  await host.call(plain(), 'open', { name: 'main' });
  await host.call(plain(), 'open', { name: 'other' });
  opened[0]!.close = async () => ({ code: null, underway: true });
  assert.equal(
    (await host.call(plain(), 'close', { name: 'main' })).text,
    '[main · still closing]\nThe shell was still being closed by a close begun earlier when this call\'s wait ended, and nothing had been sent to it yet.',
  );
  opened[1]!.close = async () => ({ code: null, signal: 'SIGHUP', underway: true });
  await host.closeAll();
  assert.deepEqual(lines.sort(), [
    'closing session "main" of scope "a"',
    'closing session "other" of scope "a"',
    'session "main" of scope "a": the shell was still being closed by a close begun earlier when the stop\'s wait ended, and nothing had been sent to it yet, so processes it started may live on',
    'session "other" of scope "a": the shell was still being closed by a close begun earlier when the stop\'s wait ended, and had been sent SIGHUP, so processes it started may live on',
  ]);
});

test('stopping the daemon logs each session as its close begins, then how each close went, naming what may live on', async () => {
  const lines: string[] = [];
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
    log: (line) => lines.push(line),
  });
  await host.call(plain(), 'open', { name: 'main' });
  await host.call(plain(), 'open', { name: 'clean' });
  await host.call(plain(), 'open', { name: 'done' });
  opened[0]!.close = async () => {
    opened[0]!.exit({ code: null, signal: 'SIGHUP' });
    await settle();
    return { code: null, signal: 'SIGHUP', unlisted: true, unreached: [{ pgid: 77, signal: 'SIGHUP', error: 'EPERM' }] };
  };
  opened[2]!.exit({ code: 0 });
  await settle();
  opened[2]!.close = async () => ({ code: 0, unlisted: true });
  await host.closeAll();
  assert.deepEqual(lines.slice(0, 3), ['closing session "main" of scope "a"', 'closing session "clean" of scope "a"', 'closing session "done" of scope "a"'], 'each close is logged as it begins, before any outcome');
  assert.equal(lines.length, 6, lines.join('\n'));
  const line = (n: string): string => lines.find((l) => l.startsWith(`session "${n}" `)) ?? '';
  assert.equal(line('clean'), 'session "clean" of scope "a" closed');
  assert.match(line('main'), /^session "main" of scope "a" closed, but not every process it started could be listed; SIGHUP to group 77 \(EPERM\) weren't delivered: processes it started may live on$/);
  assert.match(line('done'), /^session "done" of scope "a" closed, but the shell had already exited, so what it left running couldn't be listed: processes it started may live on$/);
});

test('a paste refuses text holding Ctrl-C, Ctrl-Z or Ctrl-\\, and types nothing', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  for (const ch of ['\x03', '\x1a', '\x1c']) {
    const r = await host.call(plain(), 'send', { name: 'main', text: `a${ch}b`, paste: true });
    assert.equal(r.isError, true, JSON.stringify(ch));
    assert.equal(r.structured.error, 'invalid_argument');
    assert.match(r.text, /^Nothing was typed: `text` holds Ctrl-C, Ctrl-Z or Ctrl-\\, /);
  }
  assert.equal(s.calls.filter((c) => c.method === 'send').length, 0);
});

test("notify_on says when it found no match in lines it searched only at their head", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.runOutput = [`${'x'.repeat(200_000)}READY`];
  const r = await host.call(agent(), 'run', { name: 'main', command: 'serve', notify_on: 'READY' });
  assert.match(r.text, /\n`notify_on` found no match: 1 line longer than the match window, searched on its head only\./);
});

test('look gives the ends its own wait took before the reports not yet seen, so a cut leaves them', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  for (let id = 100; id < 400; id++) {
    const c = { id, text: 'x', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 1, status: 0, errexit: false, refusedMarks: 0, cwd: '/home/u' } };
    s.commands.set(id, c);
    s.emit({ kind: 'ended', command: c, taken: false });
  }
  await settle();
  const mine = { id: 500, text: 'make', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 3, status: 1, errexit: false, refusedMarks: 0, cwd: '/home/u' } };
  s.commands.set(500, mine);
  s.wait = async () => ({ by: 'end', front: s.frontNow, ended: [mine], took: [] });
  const r = await host.call(plain(), 'look', { name: 'main', until: 'end' });
  assert.match(r.text, /^\[main · [^\n]*\]\nCommand 500 ended: exit 1 · /);
  assert.deepEqual((r.structured.ended as Array<{ id: number }>).map((c) => c.id), [500]);
});

test('a send that returns a screen leaves the look cursor where it was, since it returned no lines', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.live = 0;
  s.out = ['before'];
  await host.call(plain(), 'look', { name: 'main' });
  s.send = async () => {
    s.out.push('normal output');
    return { sent: true, lines: { from: 1, to: 2, lines: ['normal output'], dropped: 0, live: 0 }, screen: { rows: ['vim'], cursor: { row: 0, col: 0 }, alt: true, title: '' }, front: s.frontNow, ended: [], by: 'quiet', took: [] };
  };
  const sent = await host.call(plain(), 'send', { name: 'main', text: 'x' });
  assert.match(sent.text, /full-screen program/);
  const after = await host.call(plain(), 'look', { name: 'main' });
  assert.match(after.text, /\nnormal output$/);
});

test('look shows a full-screen program\'s screen while it is up, and leaves its cursor where it was, since it returned no lines', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.live = 0;
  s.out = ['before'];
  await host.call(plain(), 'look', { name: 'main' });
  s.out.push('printed before the program took the screen');
  s.screenNow = { rows: ['VIM ROW', ''], cursor: { row: 0, col: 3 }, alt: true, title: '' };
  const r = await host.call(plain(), 'look', { name: 'main' });
  assert.match(r.text, /^\[main · [^\n]*\]\n\(screen, full-screen program; cursor at row 1, column 4\)\nVIM ROW$/);
  s.screenNow = undefined;
  const after = await host.call(plain(), 'look', { name: 'main' });
  assert.match(after.text, /\nprinted before the program took the screen$/);
});

test('a read search\'s context costs about the lines it shows, not a hit\'s context times the hits', async () => {
  const { host, opened } = setup();
  await host.call(cli(), 'open', { name: 'main' });
  const cost = async (n: number): Promise<number> => {
    opened[0]!.out = Array.from({ length: n }, () => 'hit');
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = process.cpuUsage();
      await host.call(cli(), 'read', { name: 'main', match: 'hit', context: n });
      const { user, system } = process.cpuUsage(start);
      best = Math.min(best, (user + system) / 1000);
    }
    return best;
  };
  const small = await cost(1_000);
  const large = await cost(4_000);
  assert.ok(large < small * 8 + 20, `4,000 lines: ${large.toFixed(1)} ms; 1,000 lines: ${small.toFixed(1)} ms`);
});

test('list leaves room for the oldest report not yet seen however many sessions there are, so a taking list clears them', async () => {
  const { host, opened } = setup();
  for (let i = 0; i < 150; i++) await host.call(plain(), 'open', { name: `s${i}`, cwd: `/${'d'.repeat(200)}` });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 's0', command: 'make', wait: 0 });
  s.end(0);
  await settle();
  const first = await host.call(plain(), 'list', {});
  assert.equal((first.structured.unseen as string[]).length, 1);
  assert.match(first.text, /\n… \d+ more sessions, listed in structuredContent\n\nNot yet seen:\n\[s0 · command 1 · exit 0 /);
  assert.equal((first.structured.sessions as unknown[]).length, 150);
  assert.equal(((await host.call(plain(), 'list', {})).structured.unseen as string[]).length, 0);
});

test('stop is an error when the step asked for wasn\'t carried out, and not when its signals were delivered', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const front = { state: 'running' as const, since: Date.now(), process: { pgid: 4242, argv: 'bash', shell: true }, waitVisible: true };
  s.stop = async () => ({ steps: [], front, next: 'close' as const });
  const shell = await host.call(plain(), 'stop', { name: 'main', signal: 'TERM' });
  assert.equal(shell.isError, true);
  assert.equal(shell.structured.error, 'not_sent');
  s.stop = async () => ({ steps: [{ sent: 'SIGTERM', to: { pgid: 9, argv: 'make', shell: false }, refused: 'EPERM', front }], front });
  assert.equal((await host.call(plain(), 'stop', { name: 'main', signal: 'TERM' })).isError, true);
  s.stop = async () => ({ steps: [{ sent: 'C-c', front }], front });
  assert.equal((await host.call(plain(), 'stop', { name: 'main' })).isError, undefined);
});

test('a signal asked for at the prompt or after the shell exited is not sent, and stop says so as an error', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  for (const front of [{ state: 'prompt' as const, since: Date.now() }, { state: 'exited' as const, since: Date.now(), exit: { code: 0 } }]) {
    s.stop = async () => ({ steps: [], front });
    const term = await host.call(plain(), 'stop', { name: 'main', signal: 'TERM' });
    assert.equal(term.isError, true, front.state);
    assert.equal(term.structured.error, 'not_sent', front.state);
    assert.match(term.text, /\nNothing was sent: /, front.state);
  }
  s.stop = async () => ({ steps: [], front: { state: 'prompt' as const, since: Date.now() } });
  assert.equal((await host.call(plain(), 'stop', { name: 'main' })).isError, undefined);
});

test('a timed-out look tells a plain host the argument that waits again', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', wait: 0 });
  assert.match((await host.call(plain(), 'look', { name: 'main', until: 'end', wait: 0 })).text, /`look` with `until: "end"` again waits for it\./);
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 99, argv: 'make', shell: false }, command: 1, waitVisible: true };
  assert.match((await host.call(plain(), 'look', { name: 'main', until: 'input', wait: 0 })).text, /`look` with `until: "input"` again waits for it\./);
  assert.match((await host.call(plain(), 'look', { name: 'main', match: 'DONE', wait: 0 })).text, /`look` with the same `match` again waits for it\./);
});

test('structuredContent keeps a directory whole, since a script passes it back', async () => {
  const { host, opened } = setup();
  const long = `/${'d'.repeat(400)}`;
  await host.call(cli(), 'open', { name: 'main', cwd: long });
  opened[0]!.dir = long;
  const listed = await host.call(cli(), 'list', {});
  assert.equal((listed.structured.sessions as Array<{ cwd: string }>)[0]!.cwd, long);
  assert.match(listed.text, /d… \(\d+ more characters\)/);
});

test('an end a cancelled call had taken is reported, and the cursor stays where it was', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.live = 0;
  s.run = async (text, opts) => {
    const c = { id: 1, text, from: s.out.length, startedAt: Date.now() } as Command;
    s.out.push(...Array.from({ length: 50 }, (_, i) => `out ${i}`));
    c.to = s.out.length;
    c.end = { at: Date.now(), ms: 1, status: 0, errexit: false, refusedMarks: 0 };
    s.commands.set(1, c);
    const ended = { kind: 'ended' as const, command: c, taken: opts.take !== false, takers: 1 };
    s.emit(ended);
    return { kind: 'ended', command: c, front: s.frontNow, took: [ended] };
  };
  const ac = new AbortController();
  const running = host.call(plain(), 'run', { name: 'main', command: 'make', notify_on: 'nowhere' }, ac.signal);
  await settle();
  await settle();
  ac.abort();
  const r = await running;
  assert.equal(r.structured.error, 'cancelled');
  await settle();
  const unseen = await unseenOf(host);
  assert.equal(unseen.length, 1, 'the end the call took is a report again');
  assert.match(unseen[0]!, /^\[main · command 1 · exit 0 /);
  const look = await host.call(plain(), 'look', { name: 'main' });
  assert.match(look.text, /\nout 0\n/, 'the cancelled run moved no cursor');
  assert.equal(r.text, 'The call was cancelled.');
});

test('a cancelled send or look hands back what it took: an end, a wait for input and an exit, the exit keyed to the command it ended', async () => {
  const { host, opened } = setup();
  const keys: string[] = [];
  host.subscribe('a', async (w) => (keys.push(`${w.tag} ${w.key}`), false));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = { id: 9, text: 'make', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 5, errexit: false, refusedMarks: 0 } };
  s.commands.set(9, c);
  const exit = { code: 1 };
  const took = [{ kind: 'ended' as const, command: c, taken: true, takers: 1 }, { kind: 'exited' as const, exit, taken: true, takers: 1 }];
  s.wait = async (_u, opts) => {
    for (const ev of took) s.emit(ev);
    await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
    return { by: 'cancelled', front: s.frontNow, ended: [c], took };
  };
  const ac = new AbortController();
  const looking = host.call(agent(), 'look', { name: 'main', until: 'end' }, ac.signal);
  await settle();
  ac.abort();
  assert.equal((await looking).structured.error, 'cancelled');
  await settle();
  await settle();
  assert.ok(keys.includes('terminal:exited a/main/9'), keys.join(', '));
  const waiting = { kind: 'waiting' as const, front: { state: 'waiting' as const, since: Date.now(), process: { pgid: 7, argv: 'read', shell: false } }, taken: true, takers: 1 };
  s.frontNow = waiting.front;
  s.send = async (_b, opts) => {
    s.emit(waiting);
    await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
    return { sent: true, lines: s.lines(0), front: s.frontNow, ended: [], by: 'cancelled', took: [waiting] };
  };
  const ac2 = new AbortController();
  const sending = host.call(agent(), 'send', { name: 'main', text: 'x' }, ac2.signal);
  await settle();
  ac2.abort();
  await sending;
  await settle();
  await settle();
  assert.ok(keys.some((k) => k.startsWith('terminal:waiting ')), keys.join(', '));
});

test('a report handed back sits where it happened, before a newer one, and both are listed', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const old = { id: 3, text: 'a', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 1, status: 0, errexit: false, refusedMarks: 0 } };
  const newer = { id: 4, text: 'b', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 1, status: 5, errexit: false, refusedMarks: 0 } };
  s.commands.set(3, old);
  s.commands.set(4, newer);
  s.wait = async (_u, opts) => {
    s.emit({ kind: 'ended', command: old, taken: true });
    s.emit({ kind: 'ended', command: newer, taken: false });
    await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
    return { by: 'cancelled', front: s.frontNow, ended: [old], took: [{ kind: 'ended', command: old, taken: true, takers: 1 }] };
  };
  const ac = new AbortController();
  const looking = host.call(plain(), 'look', { name: 'main', until: 'end' }, ac.signal);
  await settle();
  ac.abort();
  await looking;
  const unseen = await unseenOf(host);
  assert.equal(unseen.length, 2);
  assert.match(unseen[0]!, /command 3 · exit 0/);
  assert.match(unseen[1]!, /command 4 · exit 5/);
});

test('a running command\'s notify_on watch names its command, and a cancelled stop hands the session its signal, asks nothing of it after, and answers nobody', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  await host.call(plain(), 'run', { name: 'main', command: 'make', notify_on: 'x', wait: 0 });
  assert.deepEqual(s.calls.find((c) => c.method === 'watch')!.args.slice(1), [s.commands.get(1)!.from, 1]);
  let abort: AbortSignal | undefined;
  s.stop = async (_sig, opts) => {
    abort = opts?.abort;
    await new Promise<void>((res) => opts?.abort?.addEventListener('abort', () => res()));
    return { steps: [], front: s.frontNow, cancelled: true };
  };
  const ac = new AbortController();
  const stopping = host.call(plain(), 'stop', { name: 'main' }, ac.signal);
  await settle();
  assert.equal(abort, ac.signal, 'the session got the call\'s signal');
  const before = s.calls.length;
  ac.abort();
  assert.equal((await stopping).structured.error, 'cancelled');
  await settle();
  assert.deepEqual(s.calls.slice(before).map((c) => c.method), [], 'nothing is asked of the session after the cancel');
});

test('stop says when it withheld a signal, and close names the signals that weren\'t delivered', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const front = { state: 'running' as const, since: Date.now(), process: { pgid: 9, argv: 'make', shell: false }, waitVisible: true };
  s.stop = async () => ({ steps: [{ sent: 'C-c', front }, { sent: 'SIGTERM', to: front.process, withheld: true, front }], front });
  const stopped = await host.call(plain(), 'stop', { name: 'main' });
  assert.equal(stopped.isError, true);
  assert.match(stopped.text, /\nSIGTERM wasn't sent to make: the shell's processes couldn't be listed, so its group couldn't be confirmed as still the shell's, and no further step was taken: now /);
  s.close = async () => ({ code: null, signal: 'SIGKILL', unreached: [{ pgid: 77, signal: 'SIGKILL', error: 'EPERM' }] });
  assert.match((await host.call(plain(), 'close', { name: 'main', force: true })).text, / These signals weren't delivered: SIGKILL to group 77 \(EPERM\)\. Their processes may live on\.$/);
  await host.call(plain(), 'open', { name: 'main' });
  opened[1]!.close = async () => ({ code: 0, unreached: [{ pgid: 78, signal: 'SIGHUP', error: 'EPERM' }] });
  assert.match((await host.call(plain(), 'close', { name: 'main' })).text, / These signals weren't delivered: SIGHUP to group 78 \(EPERM\)\. Their processes may live on\.$/);
});

test('an end handed back from a cancelled call doesn\'t change which command a later exit is keyed to', async () => {
  const { host, opened } = setup();
  const keys: string[] = [];
  host.subscribe('a', async (w) => (keys.push(`${w.tag} ${w.key}`), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const lost = { id: 9, text: 'a', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 1, errexit: false, refusedMarks: 0 } };
  const after = { id: 10, text: 'b', from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 1, status: 0, errexit: false, refusedMarks: 0 } };
  s.commands.set(9, lost);
  s.commands.set(10, after);
  s.wait = async (_u, opts) => {
    s.emit({ kind: 'ended', command: lost, taken: true });
    s.emit({ kind: 'ended', command: after, taken: false });
    await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
    return { by: 'cancelled', front: s.frontNow, ended: [lost], took: [{ kind: 'ended', command: lost, taken: true, takers: 1 }] };
  };
  const ac = new AbortController();
  const looking = host.call(agent(), 'look', { name: 'main', until: 'end' }, ac.signal);
  await settle();
  ac.abort();
  await looking;
  s.emit({ kind: 'exited', exit: { code: 0 }, taken: false });
  await settle();
  await settle();
  assert.ok(keys.includes('terminal:exited a/main/shell'), keys.join(', '));
});

test('a wait for input a cancelled call took is reported only while the program still waits', async () => {
  const { host, opened } = setup();
  const tags: string[] = [];
  host.subscribe('a', async (w) => (tags.push(w.tag), true));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const waiting = { kind: 'waiting' as const, front: { state: 'waiting' as const, since: Date.now(), process: { pgid: 7, argv: 'read', shell: false } }, taken: true, takers: 1 };
  let tookWaiting = false;
  s.wait = async (_u, opts) => {
    s.emit(waiting);
    s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 7, argv: 'read', shell: false }, waitVisible: true };
    await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
    tookWaiting = true;
    return { by: 'cancelled', front: s.frontNow, ended: [], took: [waiting] };
  };
  const ac = new AbortController();
  const looking = host.call(agent(), 'look', { name: 'main', until: 'input' }, ac.signal);
  await settle();
  ac.abort();
  assert.equal((await looking).structured.error, 'cancelled');
  assert.equal(tookWaiting, true, 'the premise: the wait ran and returned the wait for input as taken');
  await settle();
  await settle();
  assert.deepEqual(tags, [], 'the program was answered, so no wake asks for input');
});

test('a cancelled run keeps its command\'s notify_on watch, so the match is still reported', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  running(s);
  const run = s.run.bind(s);
  s.run = async (text, opts) => {
    const r = await run(text, opts);
    await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
    return r;
  };
  const ac = new AbortController();
  const running2 = host.call(plain(), 'run', { name: 'main', command: 'make', notify_on: 'needle', wait: 30 }, ac.signal);
  await settle();
  ac.abort();
  assert.equal((await running2).structured.error, 'cancelled');
  s.print('a needle here');
  await settle();
  await settle();
  const unseen = await unseenOf(host);
  assert.ok(unseen.some((u) => /\nMatched at line \d+: a needle here$/.test(u)), unseen.join('\n---\n'));
});

const ended = (s: FakeSession, id: number, status?: number): Command => {
  const c = { id, text: `c${id}`, from: 0, to: 0, startedAt: Date.now(), end: { at: Date.now(), ms: 1, ...(status === undefined ? {} : { status }), errexit: false, refusedMarks: 0 } } as Command;
  s.commands.set(id, c);
  return c;
};
const untilAborted = (opts: { signal?: AbortSignal }): Promise<void> => new Promise((res) => opts.signal?.addEventListener('abort', () => res()));

/** Two `look`s that both took one end: the first shows it once released, or is cancelled; the second waits for its abort. Wakes are refused, so a report stays for `list`. */
async function twoTakers() {
  const { host, opened } = setup();
  const wakes: string[] = [];
  host.subscribe('a', async (w) => (wakes.push(`${w.tag} ${w.key}`), false));
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = ended(s, 9, 0);
  const took = { kind: 'ended' as const, command: c, taken: true, takers: 2 };
  s.emit(took);
  await settle();
  let release!: () => void;
  const first = new Promise<void>((r) => (release = r));
  let n = 0;
  s.wait = async (_u, opts) => {
    if (++n === 1) {
      await Promise.race([first, untilAborted(opts)]);
      return opts.signal?.aborted ? { by: 'cancelled', front: s.frontNow, ended: [c], took: [took] } : { by: 'end', front: s.frontNow, ended: [c], took: [took] };
    }
    await untilAborted(opts);
    return { by: 'cancelled', front: s.frontNow, ended: [c], took: [took] };
  };
  const a1 = new AbortController();
  const a2 = new AbortController();
  const one = host.call(agent(), 'look', { name: 'main', until: 'end' }, a1.signal);
  const two = host.call(agent(), 'look', { name: 'main', until: 'end' }, a2.signal);
  await settle();
  return { host, s, wakes, one, two, a1, a2, release };
}

test('an end two calls took is reported only if neither showed it: one shows it, then the other is cancelled', async () => {
  const t = await twoTakers();
  t.release();
  assert.match((await t.one).text, /Command 9 ended: exit 0/);
  t.a2.abort();
  assert.equal((await t.two).structured.error, 'cancelled');
  await settle();
  await settle();
  assert.deepEqual(t.wakes, [], 'no wake for an end a result showed');
  assert.deepEqual(await unseenOf(t.host), []);
});

test('an end two calls took is reported only if neither showed it: one is cancelled, then the other shows it', async () => {
  const t = await twoTakers();
  t.a2.abort();
  assert.equal((await t.two).structured.error, 'cancelled');
  await settle();
  await settle();
  assert.deepEqual(t.wakes, [], 'no wake while another call that took it may still show it');
  t.release();
  assert.match((await t.one).text, /Command 9 ended: exit 0/);
  await settle();
  await settle();
  assert.deepEqual(t.wakes, []);
  assert.deepEqual(await unseenOf(t.host), []);
});

test('an end two calls took and both cancelled is reported once', async () => {
  const t = await twoTakers();
  t.a2.abort();
  await t.two;
  t.a1.abort();
  await t.one;
  await settle();
  await settle();
  assert.deepEqual(t.wakes, ['terminal:ended a/main/9']);
  assert.equal((await unseenOf(t.host)).length, 1);
});

test('an end a call took is reported when the host fails after the session returned it', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = ended(s, 9, 0);
  const took = { kind: 'ended' as const, command: c, taken: true, takers: 1 };
  s.emit(took);
  await settle();
  s.wait = async () => ({ by: 'end', front: s.frontNow, ended: [c], took: [took] });
  const lines = s.lines.bind(s);
  let fail = true;
  s.lines = (from, to) => {
    if (fail) {
      fail = false;
      throw new Error('EIO');
    }
    return lines(from, to);
  };
  const r = await host.call(plain(), 'look', { name: 'main', until: 'end' });
  assert.equal(r.isError, true);
  const unseen = await unseenOf(host);
  assert.equal(unseen.length, 1, 'the end the failed call took is a report');
  assert.match(unseen[0]!, /command 9 · exit 0/);
});

test('an end a call cancelled during a close had taken is in the close\'s result', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = ended(s, 9, 7);
  const took = { kind: 'ended' as const, command: c, taken: true, takers: 1 };
  s.emit(took);
  await settle();
  s.wait = async (_u, opts) => {
    await untilAborted(opts);
    return { by: 'cancelled', front: s.frontNow, ended: [c], took: [took] };
  };
  const ac = new AbortController();
  const looking = host.call(plain(), 'look', { name: 'main', until: 'input' }, ac.signal);
  await settle();
  const closing = host.call(plain(), 'close', { name: 'main' });
  await settle();
  await settle();
  ac.abort();
  assert.equal((await looking).structured.error, 'cancelled');
  const closed = await closing;
  assert.match(closed.text, /\n\nNot yet seen:\n\[main · command 9 · exit 7 /);
});

test('a run whose session closed after its command ended names the end in its text and its structured content', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const run = s.run.bind(s);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  s.run = async (text, opts) => {
    const r = await run(text, opts);
    await held;
    return r;
  };
  const running = host.call(plain(), 'run', { name: 'main', command: 'make' });
  await settle();
  const closing = host.call(plain(), 'close', { name: 'main' });
  await settle();
  release();
  const r = await running;
  assert.match(r.text, /Command 1 was typed, and ended: exit 0/);
  assert.deepEqual(((r.structured.ended ?? []) as Command[]).map((x) => x.id), [1]);
  const closed = await closing;
  assert.doesNotMatch(closed.text, /Not yet seen/, 'the run showed its end');
});

test('an end handed back after a later report about its command happened adds nothing, whether that report waits or was read', async () => {
  for (const readFirst of [false, true]) {
    const { host, opened } = setup();
    await host.call(plain(), 'open', { name: 'main' });
    const s = opened[0]!;
    const c = ended(s, 9);
    const took = { kind: 'ended' as const, command: c, taken: true, takers: 1 };
    s.emit(took);
    s.emit({ kind: 'exited', exit: { code: 1 }, taken: false });
    await settle();
    s.wait = async (_u, opts) => {
      await untilAborted(opts);
      return { by: 'cancelled', front: s.frontNow, ended: [c], took: [took] };
    };
    if (readFirst) assert.match((await host.call(plain(), 'list', {})).text, /the shell exited/);
    const ac = new AbortController();
    const looking = host.call(plain(), 'look', { name: 'main', until: 'end' }, ac.signal);
    await settle();
    ac.abort();
    await looking;
    const unseen = await unseenOf(host);
    if (readFirst) assert.deepEqual(unseen, [], 'the exit was read, and the older end adds nothing');
    else {
      assert.equal(unseen.length, 1, unseen.join('\n---\n'));
      assert.match(unseen[0]!, /the shell exited/, 'the exit stands');
    }
  }
});

test('an end handed back after the session dropped its command adds nothing', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const c = ended(s, 9, 0);
  const took = { kind: 'ended' as const, command: c, taken: true, takers: 1 };
  s.emit(took);
  await settle();
  s.wait = async (_u, opts) => {
    await untilAborted(opts);
    return { by: 'cancelled', front: s.frontNow, ended: [c], took: [took] };
  };
  const ac = new AbortController();
  const looking = host.call(plain(), 'look', { name: 'main', until: 'end' }, ac.signal);
  await settle();
  s.commands.delete(9);
  ac.abort();
  await looking;
  assert.deepEqual(await unseenOf(host), []);
});

test('a wait for input a call cancelled during a close had taken is not in the close\'s result, since the close ends it', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const front = { state: 'waiting' as const, since: Date.now(), process: { pgid: 7, argv: 'read', shell: false } };
  s.frontNow = front;
  const took = { kind: 'waiting' as const, front, taken: true, takers: 1 };
  s.emit(took);
  await settle();
  s.wait = async (_u, opts) => {
    await untilAborted(opts);
    return { by: 'cancelled', front: s.frontNow, ended: [], took: [took] };
  };
  const ac = new AbortController();
  const looking = host.call(plain(), 'look', { name: 'main', until: 'input' }, ac.signal);
  await settle();
  const realClose = s.close.bind(s);
  let release!: () => void;
  s.close = async (o: { force?: boolean; deadline: number }) => {
    await new Promise<void>((r) => (release = r));
    return realClose(o);
  };
  const closing = host.call(plain(), 'close', { name: 'main' });
  await settle();
  ac.abort();
  await looking;
  release();
  assert.doesNotMatch((await closing).text, /Not yet seen/);
});

const SSH: Process = { pgid: 31, argv: 'ssh box', shell: false };

test('integrate: the result names the shell given the integration, and the status line, list and structuredContent then name what it runs within', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.integrate = async (o) => {
    s.calls.push({ method: 'integrate', args: [o.waitMs] });
    s.frontNow = { state: 'prompt', since: Date.now(), within: SSH };
    s.dir = '/srv/far';
    return { kind: 'integrated', shell: 'zsh', version: '5.9', front: s.frontNow };
  };
  const r = await host.call(agent(), 'integrate', { name: 'main', wait: 5 });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.text, "[main · at the prompt of the shell within ssh box · /srv/far]\nThe shell in front, zsh 5.9, now has the session's integration. `run` types there, with statuses, until that shell exits, or until the local program it was reached through ends or leaves the terminal. Then `run` goes back to the shell it was typed from.");
  assert.deepEqual(r.structured, { integrated: { shell: 'zsh', version: '5.9' }, front: s.frontNow });
  assert.deepEqual(s.calls.find((c) => c.method === 'integrate')?.args, [5000]);
  assert.match((await host.call(agent(), 'list', {})).text, /^main: at the prompt of the shell within ssh box · \/srv\/far/);
  s.frontNow = { state: 'running', since: Date.now(), process: SSH, command: 4, waitVisible: false, within: SSH };
  assert.match((await host.call(agent(), 'look', { name: 'main' })).text, /^\[main · the shell within ssh box is running a command for [\d.]+ s \(whether it waits for input can't be seen here\) · \/srv\/far\]/);
  s.frontNow = { state: 'prompt', since: Date.now(), within: SSH };
  s.dir = '';
  assert.match((await host.call(agent(), 'look', { name: 'main' })).text, /^\[main · at the prompt of the shell within ssh box · directory not yet known\]/);
});

test('integrate is refused at the prompt of a shell that has the integration, and names a shell that gets none', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.integrate = async () => ({ kind: 'refused', front: s.frontNow });
  const own = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(own.isError, true);
  assert.equal(own.text, "[main · at the prompt · /home/u]\nNothing was typed: the shell in front has the session's integration already, so `run` works there.");
  assert.equal(own.structured.error, 'already_integrated');
  s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 4242, argv: 'bash', shell: true }, waitVisible: true };
  s.integrate = async () => ({ kind: 'refused', sent: true, front: s.frontNow });
  const sent = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(sent.isError, true);
  assert.match(sent.text, /\nNothing was typed: a line sent at this prompt hasn't started yet, and what is in front may be a question, such as a password, that anything typed would answer\. `look` until the shell it reaches shows its prompt, then call `integrate` again\.$/);
  assert.deepEqual([sent.structured.error, sent.structured.sent], ['not_at_prompt', true]);
  s.integrate = async () => ({ kind: 'refused', canonical: true, front: s.frontNow });
  const canonical = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(canonical.isError, true);
  assert.match(canonical.text, /\nNothing was typed: what's in front reads a whole line itself, such as a password or a yes\/no question, or a shell without a line editor\. At a question, answer it, then `look` until a shell prompt shows and call `integrate` again\. At a shell prompt, that shell has no line editor, and `integrate` can't give it the integration\.$/);
  assert.deepEqual([canonical.structured.error, canonical.structured.canonical], ['not_at_prompt', true]);
  s.integrate = async () => ({ kind: 'refused', integrating: true, front: s.frontNow });
  const busy = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(busy.isError, true);
  assert.match(busy.text, /\nNothing was typed: another `integrate` is running in this session\. Its result says how it went\.$/);
  assert.deepEqual([busy.structured.error, busy.structured.integrating], ['not_sent', true]);
  s.frontNow = { state: 'running', since: Date.now(), process: SSH, waitVisible: true };
  s.integrate = async () => ({ kind: 'unsupported', shell: 'dash', front: s.frontNow });
  const dash = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(dash.isError, true);
  assert.match(dash.text, /\nThe shell in front, dash, gets no integration: only bash, zsh and fish do\. It answered the probe line, and a second line that asks its name\. Nothing more was typed\. `send` types into it\.$/);
  assert.deepEqual([dash.structured.error, dash.structured.shell], ['unsupported_shell', 'dash']);
});

test('integrate whose wait ran out names the step it reached, and says what a later prompt does', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now(), process: SSH, waitVisible: true };
  s.integrate = async () => ({ kind: 'incomplete', step: 'probe', by: 'timeout', front: s.frontNow });
  const probe = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(probe.isError, true);
  assert.match(probe.text, /\nThe probe line was typed, and no shell answered it within the wait, so nothing more was typed\. The shell in front has no integration\.$/);
  assert.deepEqual([probe.structured.error, probe.structured.step, probe.structured.by], ['incomplete', 'probe', 'timeout']);
  s.integrate = async () => ({ kind: 'incomplete', step: 'hooks', by: 'timeout', front: s.frontNow });
  const hooks = await host.call(agent(), 'integrate', { name: 'main' });
  assert.match(hooks.text, /\nThe hooks were typed in part or whole, and no prompt with them was drawn within the wait\. Nothing more is typed\. If their last part was typed, a prompt drawn later still gives that shell the integration, and the status line then names what it runs within\.$/);
  s.integrate = async () => ({ kind: 'incomplete', step: 'hooks', by: 'exited', front: s.frontNow });
  assert.match((await host.call(agent(), 'integrate', { name: 'main' })).text, /\nWhat the hooks were typed into ended before it drew a prompt with them, and the shell below is back at its prompt\. Nothing more was typed\.$/);

  s.integrate = async () => ({ kind: 'incomplete', step: 'hooks', by: 'exited', ended: 'ssh h', front: s.frontNow });
  const carrier = await host.call(agent(), 'integrate', { name: 'main' });
  assert.match(carrier.text, /\nThe program the shell is reached through, ssh h, ended before the hooks were all typed and a prompt with them was drawn\. Nothing more was typed\.$/);
  assert.equal(carrier.structured.ended, 'ssh h');
});

test('a run refused with ssh, or a shell that isn\'t the session\'s own, in front names integrate; one with another program in front doesn\'t', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  const refusal = async (argv: string): Promise<string> => {
    s.frontNow = { state: 'running', since: Date.now(), process: { pgid: 40, argv, shell: false }, waitVisible: true };
    return (await host.call(agent(), 'run', { name: 'main', command: 'ls' })).text;
  };
  assert.match(await refusal('ssh -p 2222 box'), /`stop` stops it\. At the prompt of the shell it reached, `integrate` gives that shell statuses\.$/);
  assert.match(await refusal('/usr/bin/zsh'), /`stop` stops it\. At its prompt, `integrate` gives it statuses\.$/);
  assert.match(await refusal('-bash'), /At its prompt, `integrate` gives it statuses\.$/);
  assert.doesNotMatch(await refusal('npm run dev'), /integrate/);
  s.frontNow = { state: 'running', since: Date.now(), process: SSH, command: 4, waitVisible: false, within: SSH };
  const far = (await host.call(agent(), 'run', { name: 'main', command: 'ls' })).text;
  assert.match(far, /\nNothing was typed: the shell within ssh box is running a command\. `look` with `until: "end"` waits for it, `send` types into it, `stop` types Ctrl-C to it\.$/);
});

test('a run whose text is too long for the line a shell given the integration takes is refused, saying how long it was', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.frontNow = { state: 'prompt', since: Date.now(), within: SSH };
  s.run = async () => ({ kind: 'refused', front: s.frontNow, took: [], tooLong: { typed: 9000, max: 8192 } });
  const r = await host.call(agent(), 'run', { name: 'main', command: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /\nNothing was typed: in the shell within ssh box, `run` types the text as one line, and this one would type as 9000 characters, over the 8192 it takes\. Split it into shorter runs, or copy a script over and run that\.$/);
  assert.deepEqual([r.structured.error, r.structured.tooLong], ['invalid_argument', { typed: 9000, max: 8192 }]);
});

test('stop with a shell given the integration in front types only Ctrl-C, and refuses a signal, which would reach the local program', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now(), process: SSH, command: 4, waitVisible: false, within: SSH };
  s.stop = async (signal) => ({ steps: signal ? [] : [{ sent: 'C-c', front: s.frontNow }], front: s.frontNow, within: true });
  const ctrlC = await host.call(agent(), 'stop', { name: 'main' });
  assert.equal(ctrlC.isError, undefined, ctrlC.text);
  assert.match(ctrlC.text, /\nSent C-c: now the shell within ssh box is running a command/);
  const term = await host.call(agent(), 'stop', { name: 'main', signal: 'TERM' });
  assert.equal(term.isError, true);
  assert.match(term.text, /\nNothing was sent: a signal would reach ssh box, not the job in the shell within it\. `stop` without `signal` types Ctrl-C there\.$/);
  assert.deepEqual([term.structured.error, term.structured.within], ['not_sent', true]);
});

test('after integrated, look starts at the far prompt: the hooks\' echo is skipped', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.print('$ ssh box', 'box$ ');
  await host.call(agent(), 'look', { name: 'main' });
  s.integrate = async () => {
    s.print('box$  unset HISTFILE; hook piece 0', 'box$  __tsm_h=hook piece 1', 'far> ');
    s.frontNow = { state: 'prompt', since: Date.now(), within: SSH };
    return { kind: 'integrated', shell: 'bash', version: '5.2.37', front: s.frontNow };
  };
  await host.call(agent(), 'integrate', { name: 'main' });
  const seen = await host.call(agent(), 'look', { name: 'main' });
  assert.doesNotMatch(seen.text, /hook piece/, seen.text);
  assert.match(seen.text, /\nfar> $/, seen.text);
});

test('integrated carries what the far shell printed while taking the hooks, once, and nothing when it printed nothing', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  const integrated = (printed?: string[]) => async () => {
    s.frontNow = { state: 'prompt', since: Date.now(), within: SSH };
    return { kind: 'integrated' as const, shell: 'bash' as const, version: '5.2.37', ...(printed ? { printed } : {}), front: s.frontNow };
  };
  s.integrate = integrated(['bash: alias: ll: not found']);
  const r = await host.call(agent(), 'integrate', { name: 'main' });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /Then `run` goes back to the shell it was typed from\.\nWhile taking the hooks, the shell printed:\nbash: alias: ll: not found$/);
  assert.deepEqual((r.structured.integrated as { printed?: string[] }).printed, ['bash: alias: ll: not found']);
  s.frontNow = { state: 'prompt', since: Date.now() };
  s.integrate = integrated();
  const quiet = await host.call(agent(), 'integrate', { name: 'main' });
  assert.doesNotMatch(quiet.text, /printed/);
  assert.equal('printed' in (quiet.structured.integrated as object), false);
});

test('stop takes any signal this system has, by name, with or without SIG, and refuses one it doesn\'t have', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  for (const [given, sent] of [['USR1', 'SIGUSR1'], ['SIGWINCH', 'SIGWINCH'], ['tstp', 'SIGTSTP']] as const) {
    await host.call(plain(), 'stop', { name: 'main', signal: given });
    assert.deepEqual(s.calls.at(-1), { method: 'stop', args: [sent] }, given);
  }
  const before = s.calls.length;
  const bad = await host.call(plain(), 'stop', { name: 'main', signal: 'NOPE' });
  assert.equal(bad.isError, true);
  assert.equal(bad.text, '"NOPE" isn\'t a signal this system has. Nothing was sent.');
  assert.equal(bad.structured.error, 'invalid_argument');
  assert.equal(s.calls.length, before);
});

test("a command a stop signal stopped reads as stopped, not exited: exitCode is null, with stopped beside it, and the status line keeps what the shell reported", async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  const run = s.run.bind(s);
  s.run = async (text, opts) => {
    const r = await run(text, opts);
    if (r.kind === 'ended') Object.assign(r.command.end!, { stopped: true });
    return r;
  };
  for (const status of [0, 148]) {
    s.runStatus = status;
    const r = await host.call(agent(), 'run', { name: 'main', command: 'vim notes' });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text.split('\n')[0]!, new RegExp(` · stopped \\(the shell reported exit ${status}\\) · `), r.text);
    assert.equal(r.structured.exitCode, null);
    assert.equal(r.structured.stopped, true);
  }
});

test('a stop step that stopped the job says so, and how to continue it', async () => {
  const { host, opened } = setup();
  await host.call(plain(), 'open', { name: 'main' });
  const s = opened[0]!;
  const front = { state: 'prompt' as const, since: Date.now() };
  s.stop = async () => ({ steps: [{ sent: 'SIGTSTP', to: { pgid: 9, argv: 'vim notes', shell: false }, front, stopped: true }], front });
  const r = await host.call(plain(), 'stop', { name: 'main', signal: 'TSTP' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /\nSent SIGTSTP to [^\n]*vim notes[^\n]*: now at the prompt\. The job is stopped: `jobs` lists it, and `run fg` or `run bg` continues it\.$/);
  s.stop = async () => ({ steps: [{ sent: 'SIGUSR1', to: { pgid: 9, argv: 'dd', shell: false }, front }], front });
  assert.doesNotMatch((await host.call(plain(), 'stop', { name: 'main', signal: 'USR1' })).text, /stopped/);
});

test('a run refused with a shell other than the session\'s own waiting at its prompt names integrate too', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  const refusal = async (argv: string): Promise<string> => {
    s.frontNow = { state: 'waiting', since: Date.now(), process: { pgid: 40, argv, shell: false } };
    return (await host.call(agent(), 'run', { name: 'main', command: 'ls' })).text;
  };
  assert.match(await refusal('bash'), /\nNothing was typed: "?bash"? is waiting for input\. `send` answers it, `stop` stops it\. At its prompt, `integrate` gives it statuses\.$/);
  assert.match(await refusal('ssh box'), /`stop` stops it\. At the prompt of the shell it reached, `integrate` gives that shell statuses\.$/);
  assert.doesNotMatch(await refusal('python3'), /integrate/);
});

test('integrated shows the lines not yet shown before the call, frozen or live, once, and the next look starts at the far prompt', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main', cwd: '/home/u' });
  const s = opened[0]!;
  s.integrate = async () => {
    s.print('box$  unset HISTFILE; hook piece 0', 'far> ');
    s.frontNow = { state: 'prompt', since: Date.now(), within: SSH };
    return { kind: 'integrated', shell: 'bash', version: '5.2.37', front: s.frontNow };
  };
  s.print('$ ssh box');
  await host.call(agent(), 'look', { name: 'main' });
  s.print('Welcome to box', 'box$ ');
  const frozen = await host.call(agent(), 'integrate', { name: 'main' });
  assert.match(frozen.text, /^\[[^\n]*\]\n\$ ssh box\nWelcome to box\nbox\$ \nThe shell in front, bash 5\.2\.37, now has the session's integration\./, frozen.text);
  assert.doesNotMatch(frozen.text, /hook piece/);
  const after = await host.call(agent(), 'look', { name: 'main' });
  assert.doesNotMatch(after.text, /Welcome to box|hook piece/, after.text);
  assert.match(after.text, /\nfar> $/, after.text);
  s.print('$ ssh box2');
  await host.call(agent(), 'look', { name: 'main' });
  s.out[s.out.length - 1] = '$ ssh box2 Last login: today, with no newline before box2$ ';
  const live = await host.call(agent(), 'integrate', { name: 'main' });
  assert.match(live.text, /\n\$ ssh box2 Last login: today, with no newline before box2\$ \nThe shell in front/, live.text);
});

test('close gives the session until 55 s after the call began, the most any call may hold', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const clock = mock.method(performance, 'now', () => 1_000_000);
  try {
    await host.call(agent(), 'close', { name: 'main', force: true });
  } finally {
    clock.mock.restore();
  }
  assert.deepEqual(opened[0]!.calls.find((c) => c.method === 'close')?.args, [{ force: true, deadline: 1_055_000 }]);
});

test('a stop gives every session, and one that finishes opening during it, until 20 s after the stop began', async () => {
  let release!: () => void;
  let hold = false;
  const opened: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      if (hold) await new Promise<void>((r) => (release = r));
      const s = new FakeSession(o.name, o);
      opened.push(s);
      return s;
    },
    shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED,
  });
  await host.call(agent(), 'open', { name: 'one' });
  await host.call(agent(), 'open', { name: 'two' });
  hold = true;
  const pending = host.call(agent(), 'open', { name: 'late' });
  await settle();
  let t = 2_000_000;
  const clock = mock.method(performance, 'now', () => t);
  try {
    const stopping = host.closeAll();
    t += 3_000;
    release();
    await stopping;
    await pending;
  } finally {
    clock.mock.restore();
  }
  assert.deepEqual(opened.map((s) => [s.name, s.calls.find((c) => c.method === 'close')?.args]), [
    ['one', [{ deadline: 2_020_000 }]],
    ['two', [{ deadline: 2_020_000 }]],
    ['late', [{ force: true, deadline: 2_020_000 }]],
  ]);
});

test('a stop closes the known sessions at once, without waiting behind an open still starting, and ends that open\'s wait', async () => {
  let release!: () => void;
  let hold = false;
  const given: Array<AbortSignal | undefined> = [];
  const opened: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      given.push(o.signal);
      if (hold) await new Promise<void>((r) => (release = r));
      const s = new FakeSession(o.name, o);
      opened.push(s);
      return s;
    },
    shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED,
  });
  await host.call(agent(), 'open', { name: 'known' });
  hold = true;
  const pending = host.call(agent(), 'open', { name: 'late' });
  await settle();
  assert.equal(given[1]?.aborted, false, 'the starting open was given a signal');
  const stopping = host.closeAll();
  await settle();
  assert.ok(opened[0]!.closedWith, 'the known session closed while the open still started');
  assert.equal(given[1]?.aborted, true, 'the stop ended the starting open\'s wait');
  release();
  await stopping;
  assert.ok(opened[1]!.closedWith, 'the late session closed too');
  assert.equal((await pending).isError, true);
});
