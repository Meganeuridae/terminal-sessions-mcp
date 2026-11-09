import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host, type Caller, type Wake } from '../src/tools/host.js';
import { cutAt, outputValue, RESULT_MAX_CHARS } from '../src/tools/render.js';
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
  assert.match(r.text, /… \d+ lines left out \(`read` with `command: 1` or a range of `lines` gives more of it\)/);
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
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.frontNow = { state: 'running', since: Date.now() - 2_300, process: { pgid: 5, argv: 'bash', shell: true }, waitVisible: true };
  s.promptUndrawn = true;
  const r = await host.call(agent(), 'send', { name: 'main', keys: ['C-r'], wait: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.structured.error, 'not_at_prompt');
  assert.match(r.text, /\nNothing was typed: the shell hasn't finished drawing its prompt after 2\.\d s, .* `send` again with a longer `wait`\.$/);
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

test('closing a session wakes no one, though its running command ends and its shell exits', async () => {
  const { host, opened } = setup();
  const wakes: Wake[] = [];
  host.subscribe('a', async (w) => (wakes.push(w), true));
  await host.call(agent(), 'open', { name: 'main' });
  running(opened[0]!);
  await host.call(agent(), 'run', { name: 'main', command: 'sleep 9', wait: 0 });
  await host.call(agent(), 'close', { name: 'main' });
  await settle();
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
  assert.match(r.text, /`send` with `keys: \["C-e", "C-u"\]` clears the line/);
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
  assert.deepEqual(logs, ['closing session "main" of scope "a" failed: EIO']);
});

test('a close that finishes after the name was closed and opened again leaves the new session alone', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  let release!: () => void;
  const realClose = s.close.bind(s);
  s.close = async (o?: { force?: boolean }) => {
    if (!o?.force) await new Promise<void>((r) => (release = r));
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

test('a session that is closing refuses run, send and stop, and a forced close still goes through', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  let release!: () => void;
  const realClose = s.close.bind(s);
  s.close = async (o?: { force?: boolean }) => {
    if (!o?.force) await new Promise<void>((r) => (release = r));
    return realClose(o);
  };
  const graceful = host.call(agent(), 'close', { name: 'main' });
  await settle();
  for (const [tool, extra] of [['run', { command: 'ls' }], ['send', { text: 'x' }], ['stop', {}]] as const) {
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
  assert.match(r.text, /\na+…\n… \d+ characters of this line left out\n…b+$/);
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
  const reading = host.call(cli(), 'read', { name: 'main', match: 'nowhere' }).then(() => (done = true));
  await settle();
  assert.equal(done, false, 'a turn of the event loop came while it searched');
  await reading;
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
  await host.call(agent(), 'close', { name: 'main' });
  release();
  const r = await looking;
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

test('a failed open or close says what is unknown and that list shows it; a backend failure says calling again won\'t help', async () => {
  let fail: Error = new Error('EMFILE');
  const host = new Host({ openSession: async () => { throw fail; }, shell: '/bin/bash', env: {}, sessionsDir: '/tmp/sessions', startedAt: STARTED });
  const r = await host.call(agent(), 'open', { name: 'main' });
  assert.match(r.text, /^`open` failed: EMFILE\. Whether the session opened is unknown; `list` shows the sessions open\.$/);
  const { TermError } = await import('../src/core/errors.js');
  fail = new TermError('backend_failure', 'this host has no bash');
  const b = await host.call(agent(), 'open', { name: 'main' });
  assert.match(b.text, /^This host has no bash\. Calling again won't help: whoever runs the daemon can fix it\.$/);
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
  s.send = async () => ({ sent: true, lines: s.lines(s.out.length), front: s.frontNow, ended: [], by: 'timeout', clipped: 2 });
  assert.match((await host.call(agent(), 'send', { name: 'main', text: 'x', wait_for: 'never', wait: 1 })).text, /\nThe wait ended before the pattern matched; 2 lines longer than the match window, searched on their head only\./);
  s.frontNow = { state: 'waiting', since: Date.now(), process: { pgid: 9, argv: 'read', shell: false } };
  assert.match((await host.call(agent(), 'list', {})).text, /waiting for input: read, echo unknown, for /);
  const made = s.end(0);
  made.end!.ms = 1_200;
  await settle();
  assert.ok(wakes.some((w) => w.tag === 'terminal:ended' && / · exit 0 · 1\.2 s · /.test(w.text)), "the duration is the ending's own");
  s.close = async () => ({ code: null, signal: 'SIGKILL', unconfirmed: true, unlisted: true });
  assert.equal((await host.call(agent(), 'close', { name: 'main', force: true })).text, "[main · closed]\nThe shell was sent SIGKILL, and its exit wasn't seen within the grace after it. Its descendants couldn't be listed, so only the shell was killed, and jobs it started may live on.");
});

test('a search the wait ended before it reached the end says how many lines it never searched, and what searches them', async () => {
  const { host, opened } = setup();
  await host.call(agent(), 'open', { name: 'main' });
  const s = opened[0]!;
  s.send = async () => ({ sent: true, lines: s.lines(s.out.length), front: s.frontNow, ended: [], by: 'timeout', unsearched: 1200, clipped: 3 });
  const sent = await host.call(agent(), 'send', { name: 'main', text: 'x', wait_for: 'DONE', wait: 5 });
  assert.match(sent.text, /\nThe wait ended with 1200 lines not yet searched, and no match in those it searched; 3 lines longer than the match window, searched on their head only\. `look` again with a longer `wait` searches them, or `read` with `match` searches a range of `lines`\./);
  const longest = await host.call(agent(), 'send', { name: 'main', text: 'x', wait_for: 'DONE', wait: 55 });
  assert.match(longest.text, /no match in those it searched; 3 lines .* head only\. `read` with `match` searches a range of `lines`\./);
  s.wait = async () => ({ by: 'timeout', front: s.frontNow, ended: [], unsearched: 1 });
  assert.match((await host.call(cli(), 'look', { name: 'main', match: 'DONE', wait: 5 })).text, /\nThe wait ended with 1 line not yet searched, and no match in those it searched\. `look` again with a longer `wait` searches them/);
  assert.match((await host.call(agent(), 'look', { name: 'main', match: 'DONE', wait: 5 })).text, /\nThe wait ended with 1 line not yet searched, and no match in those it searched\. The match will be reported to you when it comes\./);
  s.wait = async () => ({ by: 'timeout', front: s.frontNow, ended: [] });
  assert.match((await host.call(agent(), 'look', { name: 'main', match: 'DONE', wait: 5 })).text, /\nThe wait ended first\. The match will be reported to you when it comes\./);
});
