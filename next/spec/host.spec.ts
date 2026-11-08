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
  assert.match(long.text, /\(\d+ rows? above not shown\)/);
  assert.match(long.text, /\n44x+$/, 'the top rows go, not the bottom');
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
  assert.match(match.text, /Matched at line 1: needle b+… \(99757 more characters\)$/);
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
  s.out.push('READY now');
  const ended = await host.call(agent(), 'run', { name: 'main', command: 'echo READY', notify_on: 'READY' });
  assert.match(ended.text, /\nMatched at line \d+: \$ echo READY|\nMatched at line \d+: READY now/);
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
  await host.closeAll();
  release();
  const r = await pending;
  assert.equal(r.isError, true);
  assert.ok(opened[0]!.closedWith, 'its shell was closed');
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
  const id = [...s.watches.keys()].at(-1)!;
  s.emit({ kind: 'match', watch: id, match: { line: 7, text: 'needle', clipped: true } });
  await settle();
  const wake = wakes.find((w) => w.tag === 'terminal:match')!;
  assert.match(wake.text, /\nMatched at line 7: needle \(the line is longer than the match window: matched on its head only\)$/);
});
