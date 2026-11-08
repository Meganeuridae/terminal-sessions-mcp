import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openSession } from '../src/session/session.js';
import type { Command, Session, SessionEvent } from '../src/session/types.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-session-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const which = (name: string): string | undefined => {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const wanted = (process.env.TSM_SHELLS ?? 'bash,zsh,fish').split(',');
const shells = wanted.map((name) => ({ name, path: which(name) }));
let ids = 0;
let homes = 0;
const sessions: Session[] = [];
after(async () => {
  for (const s of sessions) await s.close({ force: true });
});

const bashBelow = (shell: string, major: number, minor: number): boolean => {
  if (path.basename(shell) !== 'bash') return false;
  const [a, b] = execFileSync(shell, ['-c', 'echo "$\{BASH_VERSINFO[0]} $\{BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim().split(' ').map(Number);
  return a! < major || (a === major && b! < minor);
};

const STARTUP: Record<string, string> = { bash: '.bash_profile', zsh: '.zshrc', fish: '.config/fish/config.fish' };

async function open(shell: string, opts: { rc?: string; cwd?: string; cols?: number; waitMs?: number } = {}): Promise<Session> {
  const home = path.join(tmp, `home-${++homes}`);
  fs.mkdirSync(home);
  const name = path.basename(shell);
  if (name === 'zsh') fs.writeFileSync(path.join(home, '.zshenv'), 'skip_global_compinit=1\n');
  if (opts.rc !== undefined && STARTUP[name]) {
    fs.mkdirSync(path.dirname(path.join(home, STARTUP[name]!)), { recursive: true });
    fs.writeFileSync(path.join(home, STARTUP[name]!), opts.rc);
  }
  const s = await openSession({
    name: 'main',
    shell,
    cwd: opts.cwd ?? home,
    cols: opts.cols ?? 100,
    rows: 30,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
    parent: tmp,
    nextCommandId: () => ++ids,
    waitMs: opts.waitMs ?? 10_000,
  });
  sessions.push(s);
  return s;
}

const out = (s: Session, c: Command): string[] => s.lines(c.from, c.to).lines;

async function ran(s: Session, text: string, waitMs = 10_000): Promise<Command> {
  const r = await s.run(text, { waitMs });
  assert.equal(r.kind, 'ended', `${text}: ${JSON.stringify(r)}`);
  return (r as { command: Command }).command;
}

for (const sh of shells) {
  describe(`${sh.name}`, { skip: sh.path ? false : `${sh.name} is not installed` }, () => {
    const shell = sh.path!;

    test('opens at a prompt, after the user startup files ran, which the hooks survive', async () => {
      const rc = sh.name === 'fish' ? 'set -gx FROM_RC yes\nfunction fish_prompt; echo -n "custom> "; end\n' : 'export FROM_RC=yes\nPROMPT_COMMAND="true"\nPS1="custom> "\n';
      const s = await open(shell, { rc });
      assert.equal(s.front().state, 'prompt');
      const c = await ran(s, 'echo $FROM_RC');
      assert.deepEqual(out(s, c), ['yes']);
      assert.equal(c.end?.status, 0);
    });

    test('a startup file that asks a question holds the session until it is answered', { skip: sh.name === 'fish' ? 'fish config has no prompt read here' : false }, async () => {
      const s = await open(shell, { rc: 'read ANSWER\nexport ANSWER\n', waitMs: 1500 });
      const f = s.front();
      assert.notEqual(f.state, 'prompt');
      if (process.platform === 'linux') assert.equal(f.state, 'waiting');
      await s.send('given\r', { waitMs: 3000 });
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.equal(s.front().state, 'prompt');
      assert.deepEqual(out(s, await ran(s, 'echo $ANSWER')), ['given']);
    });

    test('gives each command its status, pipeline, directory and output, without the prompt or the typed line', async () => {
      const s = await open(shell);
      assert.equal((await ran(s, 'false')).end?.status, 1);
      assert.equal((await ran(s, sh.name === 'fish' ? 'fish -c "exit 3"' : '(exit 3)')).end?.status, 3);
      const p = await ran(s, 'false | true');
      assert.equal(p.end?.status, 0);
      assert.deepEqual(p.end?.pipeline, [1, 0]);
      assert.equal((await ran(s, 'cd /')).end?.cwd, '/');
      assert.equal(s.cwd(), '/');
      const two = await ran(s, 'echo one; echo two');
      assert.deepEqual(out(s, two), ['one', 'two']);
      const bare = await ran(s, 'printf abc');
      assert.deepEqual(out(s, bare), ['abc']);
    });

    test('a command typed with send gets an id and a status too', { skip: bashBelow(shell, 4, 4) ? 'bash before 4.4 has no PS0' : false }, async () => {
      const s = await open(shell);
      const r = await s.send('echo typed-here\r', { waitMs: 5000, until: /typed-here$/ });
      const w = await s.wait({ kind: 'end' }, { waitMs: 5000, from: r.lines.from });
      const c = [...r.ended, ...w.ended].at(-1) ?? s.last();
      assert.ok(c?.end, 'the typed command ended');
      assert.equal(c.end.status, 0);
      assert.deepEqual(out(s, c), ['typed-here']);
    });

    test('a command reaches the shell whole: history expansion, quotes, several lines and a heredoc', async () => {
      const s = await open(shell);
      assert.deepEqual(out(s, await ran(s, 'echo "bang:!!:end"')), ['bang:!!:end']);
      assert.deepEqual(out(s, await ran(s, `echo 'single "double"'`)), ['single "double"']);
      assert.deepEqual(out(s, await ran(s, 'echo first\necho second')), ['first', 'second']);
      if (sh.name !== 'fish') assert.deepEqual(out(s, await ran(s, 'cat <<EOF\nline one\nEOF')), ['line one']);
    });

    test('output that replays marks ends nothing, and is counted', async () => {
      const s = await open(shell);
      const forged = `printf '\\033]133;D;1.1234;2.5678;0;;;/;\\007\\033]133;C;2.5678;\\007after\\n'; false`;
      const c = await ran(s, forged);
      assert.equal(c.end?.status, 1);
      assert.ok((c.end?.refusedMarks ?? 0) >= 2);
      assert.deepEqual(out(s, c), ['after']);
      assert.equal(s.front().state, 'prompt');
    });

    test('the live nonce never shows in output', async () => {
      const s = await open(shell);
      const c = await ran(s, 'echo "[$__tsm_r]"');
      assert.deepEqual(out(s, c), ['[[redacted]]']);
    });

    test('a line typed ahead of a program that never read it is discarded at the prompt and reported', { skip: sh.name === 'fish' || bashBelow(shell, 4, 0) ? 'fish and bash before 4 have no timed read to flush with' : false }, async () => {
      const s = await open(shell);
      const r = await s.run('sleep 1', { waitMs: 200 });
      assert.equal(r.kind, 'running');
      await s.send('echo TYPEAHEAD_RAN\r', { waitMs: 100, quietMs: 50 });
      const w = await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      const c = w.ended.find((e) => e.id === (r as { command: Command }).command.id) ?? s.command((r as { command: Command }).command.id);
      assert.equal(c?.end?.flushed, 'echo TYPEAHEAD_RAN\n');
      const after = await ran(s, 'echo next');
      assert.deepEqual(out(s, after), ['next']);
      assert.ok(!s.lines(0).lines.includes('TYPEAHEAD_RAN'));
    });

    test('run refuses, typing nothing, while something is in front or text waits at the prompt', async () => {
      const s = await open(shell);
      const r = await s.run('sleep 2', { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const busy = await s.run('echo SHOULD_NOT_RUN', { waitMs: 1000 });
      assert.equal(busy.kind, 'refused');
      assert.equal(busy.front.state, 'running');
      assert.match(busy.front.state === 'running' ? busy.front.process.argv : '', /sleep 2/);
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      await s.send('ech', { waitMs: 1000 });
      const front = s.front();
      assert.equal(front.state === 'prompt' ? front.pending : undefined, 'ech');
      assert.equal((await s.run('echo no', { waitMs: 1000 })).kind, 'refused');
      await s.send('\x15', { waitMs: 1000 });
      assert.deepEqual(out(s, await ran(s, 'echo yes')), ['yes']);
      assert.ok(!s.lines(0).lines.some((l) => l === 'SHOULD_NOT_RUN'));
    });

    test('a program blocked reading the terminal shows as waiting, and run returns at once', { skip: process.platform !== 'linux' ? 'only Linux shows reads' : false }, async () => {
      const s = await open(shell);
      const t0 = Date.now();
      const r = await s.run('cat', { waitMs: 8000 });
      assert.equal(r.kind, 'running');
      assert.ok(Date.now() - t0 < 4000);
      assert.equal(r.front.state, 'waiting');
      assert.match(r.front.state === 'waiting' ? r.front.process.argv : '', /cat/);
      const sent = await s.send('typed\r\x04', { waitMs: 3000, until: /^typed$/ });
      assert.equal(sent.by, 'match');
      await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      assert.equal(s.front().state, 'prompt');
    });

    test('a password read shows as waiting without echo', { skip: process.platform !== 'linux' || sh.name === 'fish' ? 'Linux, bash and zsh only' : false }, async () => {
      const s = await open(shell);
      const r = await s.run(sh.name === 'zsh' ? 'read -s pw' : 'read -s pw', { waitMs: 3000 });
      assert.equal(r.front.state, 'waiting');
      assert.equal(r.front.state === 'waiting' ? r.front.echo : undefined, false);
      await s.send('secret\r', { waitMs: 2000 });
    });

    test('the transcript keeps long output whole, and what a clear erased', async () => {
      const s = await open(shell);
      const c = await ran(s, 'seq 1 5000', 20_000);
      const o = out(s, c);
      assert.equal(o.length, 5000);
      assert.equal(o[0], '1');
      assert.equal(o[4999], '5000');
      const k = await ran(s, `echo before; printf '\\033[H\\033[2J\\033[3J'; echo after`);
      assert.deepEqual(out(s, k), ['before', 'after']);
    });

    test('wrapped lines come back joined', async () => {
      const s = await open(shell, { cols: 20 });
      assert.deepEqual(out(s, await ran(s, `echo ${'x'.repeat(50)}`)), ['x'.repeat(50)]);
    });

    test('a full-screen program leaves its last frame in the transcript', async () => {
      const s = await open(shell);
      const c = await ran(s, `printf '\\033[?1049h\\033[HFRAME-TEXT\\033[?1049l'; echo after`);
      assert.deepEqual(out(s, c), ['FRAME-TEXT', 'after']);
    });

    test('a program asking the terminal where its cursor is gets an answer', { skip: sh.name === 'fish' ? 'the probe is bash and zsh syntax' : false }, async () => {
      const s = await open(shell);
      const c = await ran(s, `printf '\\033[6n'; IFS= read -rs -d R pos; echo "got$\{pos#*\\[}"`, 5000);
      assert.match(out(s, c).join('\n'), /got\d+;\d+/);
    });

    test('stop with a signal takes that one step', async () => {
      const s = await open(shell);
      await s.run('sleep 30', { waitMs: 200 });
      const r = await s.stop('SIGTERM');
      assert.deepEqual(r.steps.map((x) => x.sent), ['SIGTERM']);
      assert.equal(r.steps[0]?.to?.argv.includes('sleep'), true);
      assert.equal(r.front.state, 'prompt');
    });

    test('stop takes steps, each reported, and never signals the shell', async () => {
      const s = await open(shell);
      await s.run('sleep 30', { waitMs: 200 });
      const one = await s.stop();
      assert.deepEqual(one.steps.map((x) => x.sent), ['C-c']);
      assert.equal(one.front.state, 'prompt');
      await s.run(`bash -c 'trap "" INT TERM; sleep 30'`, { waitMs: 300 });
      const hard = await s.stop();
      assert.deepEqual(hard.steps.map((x) => x.sent), ['C-c', 'SIGTERM', 'SIGKILL']);
      assert.equal(hard.front.state, 'prompt');
      assert.deepEqual(out(s, await ran(s, 'echo alive')), ['alive']);
    });

    test('events: endings a call returned are taken; one after the call returned is not; the exit comes last', async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const c = await ran(s, 'echo hi');
      assert.ok(events.some((e) => e.kind === 'ended' && e.command.id === c.id && e.taken));
      const r = await s.run('sleep 0.5', { waitMs: 50 });
      assert.equal(r.kind, 'running');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.ok(events.some((e) => e.kind === 'ended' && e.command.id === (r as { command: Command }).command.id && !e.taken));
      await s.run('exit 4', { waitMs: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const last = events.at(-1);
      assert.equal(last?.kind, 'exited');
      assert.equal(last?.kind === 'exited' ? last.exit.code : undefined, 4);
      assert.equal(s.front().state, 'exited');
    });

    test('a shell replaced by exec keeps working, without statuses', async () => {
      const s = await open(shell);
      const r = await s.run('exec /bin/sh', { waitMs: 8000 });
      assert.equal(r.kind, 'ended');
      assert.equal(r.kind === 'ended' ? r.command.end?.status : 'x', undefined);
      const after = await s.run('echo after-exec', { waitMs: 8000 });
      assert.equal(after.kind, 'ended');
      if (after.kind === 'ended') {
        assert.deepEqual(out(s, after.command), ['after-exec']);
        assert.equal(after.command.end?.status, undefined);
      }
    });

    test('close hangs up the shell and removes its directory', async () => {
      const s = await open(shell);
      const before = fs.readdirSync(tmp).filter((d) => d.startsWith('s-')).length;
      const exit = await s.close();
      assert.ok(exit.code !== undefined);
      assert.equal(fs.readdirSync(tmp).filter((d) => d.startsWith('s-')).length, before - 1);
    });

    test('close with force ends a shell whose job ignores the hangup', async () => {
      const s = await open(shell);
      await s.run(`bash -c 'trap "" HUP INT TERM; sleep 30'`, { waitMs: 200 });
      const t0 = Date.now();
      const exit = await s.close({ force: true });
      assert.ok(Date.now() - t0 < 3000);
      assert.ok(exit.code !== undefined || exit.signal !== undefined);
    });
  });
}

test('a cwd that is not a directory is refused as invalid_argument', async () => {
  await assert.rejects(open(which('bash') ?? '/bin/sh', { cwd: path.join(tmp, 'missing') }), { code: 'invalid_argument' });
});

test('a shell without integration opens and runs, with no status', async () => {
  const s = await open('/bin/sh');
  assert.equal(s.kind, 'none');
  assert.equal(s.front().state, 'prompt');
  const r = await s.run('echo plain', { waitMs: 5000 });
  assert.equal(r.kind, 'ended');
  assert.equal(r.kind === 'ended' ? r.command.end?.status : 'x', undefined);
});
