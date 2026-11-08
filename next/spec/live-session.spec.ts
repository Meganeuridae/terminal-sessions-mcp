import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openSession } from '../src/session/session.js';
import type { Command, Session, SessionEvent } from '../src/session/types.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-session-')));

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
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

const bashBelow = (shell: string, major: number, minor: number): boolean => {
  if (path.basename(shell) !== 'bash') return false;
  const [a, b] = execFileSync(shell, ['-c', 'echo "$\{BASH_VERSINFO[0]} $\{BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim().split(' ').map(Number);
  return a! < major || (a === major && b! < minor);
};

const STARTUP: Record<string, string> = { bash: '.bash_profile', zsh: '.zshrc', fish: '.config/fish/config.fish' };

async function open(shell: string, opts: { rc?: string; files?: Record<string, string>; cwd?: string; cols?: number; waitMs?: number } = {}): Promise<Session> {
  const home = path.join(tmp, `home-${++homes}`);
  fs.mkdirSync(home);
  const name = path.basename(shell);
  if (name === 'zsh') fs.writeFileSync(path.join(home, '.zshenv'), 'skip_global_compinit=1\n');
  // fish's first interactive start in a home without generated completions launches a disowned
  // generator that outlives the session and writes into the home while `after` removes it. Their
  // directory's presence is what fish checks: ~/.local/share in fish 3, ~/.cache in fish 4.
  if (name === 'fish') for (const dir of ['.local/share/fish', '.cache/fish']) fs.mkdirSync(path.join(home, dir, 'generated_completions'), { recursive: true });
  if (opts.rc !== undefined && STARTUP[name]) {
    fs.mkdirSync(path.dirname(path.join(home, STARTUP[name]!)), { recursive: true });
    fs.writeFileSync(path.join(home, STARTUP[name]!), opts.rc);
  }
  for (const [file, text] of Object.entries(opts.files ?? {})) fs.writeFileSync(path.join(home, file), text);
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

async function inFront(s: Session, pattern: RegExp, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const f = s.front();
    if ((f.state === 'running' || f.state === 'waiting') && pattern.test(f.process.argv)) return;
    if (Date.now() > until) assert.fail(`nothing matching ${pattern} came in front: ${JSON.stringify(f)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pendingIs(s: Session, text: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const f = s.front();
    if (f.state === 'prompt' && f.pending === text) return;
    if (Date.now() > until) assert.fail(`the prompt never showed ${JSON.stringify(text)} pending: ${JSON.stringify(f)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

    test('bash reads what an interactive login bash reads: its profile, and .bashrc only where the profile sources it', { skip: sh.name !== 'bash' ? 'bash only' : false }, async () => {
      const both = 'echo "$FROM_PROFILE|$FROM_BASHRC"';
      const alone = await open(shell, { files: { '.bash_profile': 'FROM_PROFILE=profile_ok\n', '.bashrc': 'FROM_BASHRC=rc_ok\n' } });
      assert.deepEqual(out(alone, await ran(alone, both)), ['profile_ok|']);
      const sourced = await open(shell, { files: { '.bash_profile': 'FROM_PROFILE=profile_ok\n. "$HOME/.bashrc"\n', '.bashrc': 'FROM_BASHRC=rc_ok\n' } });
      assert.deepEqual(out(sourced, await ran(sourced, both)), ['profile_ok|rc_ok']);
    });

    test('a startup file reading one key holds the session, starting, until it is answered', { skip: sh.name === 'fish' ? 'fish config has no prompt read here' : false }, async () => {
      const read = sh.name === 'zsh' ? 'read -rsk1 startup_answer' : 'read -rsn1 startup_answer';
      const s = await open(shell, { rc: `${read}\necho STARTUP_DONE:$startup_answer\n`, waitMs: 1000 });
      const f = s.front();
      assert.notEqual(f.state, 'prompt');
      assert.equal(f.state === 'running' || f.state === 'waiting' ? f.starting : f.state, true);
      assert.equal((await s.run('echo no', { waitMs: 500 })).kind, 'refused');
      await s.send('Z', { waitMs: 3000, until: /STARTUP_DONE:Z/ });
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.equal(s.front().state, 'prompt');
      assert.deepEqual(out(s, await ran(s, 'echo ready')), ['ready']);
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

    test('output is cut at its end by cells, so a wide or combining character before the prompt stays whole', async () => {
      const s = await open(shell);
      assert.deepEqual(out(s, await ran(s, "printf '界'")), ['界']);
      assert.deepEqual(out(s, await ran(s, "printf 'e\u0301'")), ['e\u0301']);
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

    test('an empty line at the prompt leaves the session at its prompt, ready to run', async () => {
      const s = await open(shell);
      await s.send('\r', { waitMs: 3000 });
      const w = await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.equal(w.by, 'end');
      assert.deepEqual(out(s, await ran(s, 'echo after-empty', 5000)), ['after-empty']);
    });

    test('a command reaches the shell whole: history expansion, quotes, several lines and a heredoc', async () => {
      const s = await open(shell);
      assert.deepEqual(out(s, await ran(s, 'echo "bang:!!:end"')), ['bang:!!:end']);
      assert.deepEqual(out(s, await ran(s, `echo 'single "double"'`)), ['single "double"']);
      assert.deepEqual(out(s, await ran(s, 'echo first\necho second')), ['first', 'second']);
      if (sh.name !== 'fish') assert.deepEqual(out(s, await ran(s, 'cat <<EOF\nline one\nEOF')), ['line one']);
    });

    test('output that replays marks ends nothing, and only marks shaped like the session\'s own are counted', async () => {
      const s = await open(shell);
      const forged = `printf '\\033]133;D;1.1234;2.5678;0;;;/;\\007\\033]133;C;2.5678;\\007\\033]133;D;0\\007after\\n'; false`;
      const c = await ran(s, forged);
      assert.equal(c.end?.status, 1);
      assert.equal(c.end?.refusedMarks, 2);
      assert.deepEqual(out(s, c), ['after']);
      assert.equal(s.front().state, 'prompt');
    });

    test('the live nonce never shows in output', async () => {
      const s = await open(shell);
      const c = await ran(s, 'echo "[$__tsm_r]"');
      assert.deepEqual(out(s, c), ['[[redacted]]']);
    });

    test('the live nonce never shows in the title', { skip: sh.name === 'fish' ? 'fish sets its own title at each prompt' : false }, async () => {
      const s = await open(shell);
      await ran(s, `printf '\\033]0;%s\\007' "$__tsm_r"`);
      assert.equal(s.screen().title, '[redacted]');
    });

    test('a line typed ahead of a program that never read it is discarded at the prompt and reported', async () => {
      const s = await open(shell);
      const r = await s.run('sleep 1', { waitMs: 200 });
      assert.equal(r.kind, 'running');
      await inFront(s, /sleep 1/);
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
      await inFront(s, /sleep 2/);
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

    test('keys sent before a slow prompt is drawn wait for it, so the line editor gets them rather than the terminal', async () => {
      const rc = sh.name === 'fish' ? 'function fish_prompt; sleep 0.5; echo -n "> "; end\n' : sh.name === 'zsh' ? '__slow() { sleep 0.5 }\nprecmd_functions+=(__slow)\n' : 'PROMPT_COMMAND="sleep 0.5"\n';
      const search = sh.name === 'bash' ? /reverse-i-search/ : sh.name === 'zsh' ? /bck-i-search/ : /./;
      const viaRun = await open(shell, { rc });
      await ran(viaRun, 'true');
      await viaRun.send('\x12', { waitMs: 3000 });
      const a = viaRun.screen().rows.join('\n');
      assert.ok(!a.includes('^R'), a);
      assert.match(a, search);
      const viaSend = await open(shell, { rc });
      await viaSend.send('true\r', { waitMs: 3000, quietMs: 100 });
      await viaSend.send('\x12', { waitMs: 3000 });
      const b = viaSend.screen().rows.join('\n');
      assert.ok(!b.includes('^R'), b);
      assert.match(b, search);
    });

    test('send types nothing while a prompt hook outlasts its wait, and the same keys go in once the prompt is drawn', async () => {
      const rc = sh.name === 'fish' ? 'function fish_prompt; sleep 2; echo -n "> "; end\n' : sh.name === 'zsh' ? '__slow() { sleep 2 }\nprecmd_functions+=(__slow)\n' : 'PROMPT_COMMAND="sleep 2"\n';
      const s = await open(shell, { rc, waitMs: 15_000 });
      await s.send('true\r', { waitMs: 3000, quietMs: 100 });
      const early = await s.send('zq', { waitMs: 500 });
      assert.equal(early.sent, false);
      assert.equal(early.by, 'timeout');
      assert.equal((await s.send('zq', { waitMs: 5000 })).sent, true);
      await pendingIs(s, 'zq');
    });

    test('keys sent while a prompt hook reads the terminal raw wait for the drawn prompt, so the hook does not get them', { skip: sh.name === 'fish' ? 'the hooks are bash and zsh syntax' : false }, async () => {
      const hooks = sh.name === 'zsh'
        ? ['__hk() { read -rsk1 -t 2 hookkey }\nprecmd_functions+=(__hk)\n', "__cq() { print -n '\\e[6n'; read -rs -d R pos; sleep 1 }\nprecmd_functions+=(__cq)\n"]
        : ['PROMPT_COMMAND="read -rsn1 -t 2 hookkey"\n', "PROMPT_COMMAND='printf \"\\033[6n\"; IFS= read -rs -d R pos; sleep 1'\n"];
      for (const rc of hooks) {
        const s = await open(shell, { rc, waitMs: 15_000 });
        await s.send('true\r', { waitMs: 3000, quietMs: 100 });
        assert.equal((await s.send('zq', { waitMs: 6000 })).sent, true);
        await pendingIs(s, 'zq');
      }
    });

    test('a typed command that removes the prompt hooks and the prompt mark leaves the session running, refusing run', { skip: sh.name === 'fish' ? 'bash and zsh: the hooks are removed by assignment' : false }, async () => {
      const s = await open(shell);
      await s.send(sh.name === 'zsh' ? 'precmd_functions=(); PS1="> "\r' : 'unset PROMPT_COMMAND; PS1="> "\r', { waitMs: 3000 });
      const w = await s.wait({ kind: 'end' }, { waitMs: 1500, from: 0 });
      assert.notEqual(w.by, 'end');
      const r = await s.run('echo no', { waitMs: 1000 });
      assert.equal(r.kind, 'refused');
      assert.equal(r.front.state === 'running' || r.front.state === 'waiting' ? r.front.process.shell && !r.front.starting : r.front.state, true);
    });

    test('a command reading the terminal without echo stays running until it ends, however quiet', async () => {
      const s = await open(shell);
      const read = sh.name === 'zsh' ? 'read -rsk1 a' : sh.name === 'fish' ? 'read -s -n1 a' : 'read -rsn1 a';
      const r = await s.run(`${read}; printf '\\nREAD_DONE:%s\\n' "$a"`, { waitMs: 1500 });
      assert.equal(r.kind, 'running');
      assert.notEqual(r.front.state, 'prompt');
      assert.notEqual(s.front().state, 'prompt');
      await s.send('Z', { waitMs: 3000, until: /READ_DONE:Z/ });
      await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      const c = s.command((r as { command: Command }).command.id);
      assert.equal(c?.end?.status, 0);
      assert.ok(out(s, c!).includes('READ_DONE:Z'));
    });

    test('a typed command that removes the prompt hook but not the prompt ends when its prompt is drawn, with no status', { skip: sh.name === 'fish' || bashBelow(shell, 4, 4) ? 'bash 4.4 and later and zsh: a typed command needs a start mark' : false }, async () => {
      const s = await open(shell);
      const r = await s.send(sh.name === 'zsh' ? 'precmd_functions=()\r' : 'PROMPT_COMMAND=\r', { waitMs: 3000 });
      const w = await s.wait({ kind: 'end' }, { waitMs: 3000, from: r.lines.from });
      const c = [...r.ended, ...w.ended].at(-1);
      assert.ok(c?.end, 'the typed command ended');
      assert.equal(c.end.status, undefined);
      assert.equal(s.front().state, 'prompt');
      assert.equal((await ran(s, 'false', 5000)).end?.status, 1);
    });

    test('a command run that replaces the prompt hook and the prompt leaves the hooks in place', { skip: sh.name === 'fish' ? 'fish keeps its hooks as event functions' : false }, async () => {
      const s = await open(shell);
      const c = await ran(s, sh.name === 'zsh' ? 'precmd_functions=(); PS1="> "' : 'PROMPT_COMMAND=; PS1="> "', 5000);
      assert.equal(c.end?.status, 0);
      assert.equal((await ran(s, 'false', 5000)).end?.status, 1);
    });

    test('a run line the shell took without starting a command ends at the next end mark, with its status', { skip: sh.name !== 'bash' ? 'bash only: it disables the builtin a run line sources with' : false }, async () => {
      const s = await open(shell, { rc: "PROMPT_COMMAND='PS0='\nenable -n .\n" });
      const c = await ran(s, 'echo NOT_RUN', 5000);
      assert.equal(c.end?.status, 127);
      assert.ok(!out(s, c).includes('NOT_RUN'));
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

    test('a program splicing from the terminal shows as waiting only while it waits for input, not for room in its pipe', { skip: process.platform !== 'linux' || !which('python3') ? 'Linux with python3 only' : false }, async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const empty = await s.run(`python3 -c 'import os; r, w = os.pipe(); print("TRANSFERRED:%d" % os.splice(0, w, 4096))'`, { waitMs: 4000 });
      assert.equal(empty.kind, 'running');
      assert.equal(empty.front.state, 'waiting');
      const sent = await s.send('X\r', { waitMs: 3000, until: /^TRANSFERRED:2$/ });
      assert.equal(sent.by, 'match');
      await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      events.length = 0;
      const full = await s.run(`python3 -c 'import os, fcntl; r, w = os.pipe(); fcntl.fcntl(w, 1031, 4096); os.write(w, b"x" * 4096); print("FULL", flush=True); print("TRANSFERRED:%d" % os.splice(0, w, 4096))'`, { waitMs: 1500 });
      assert.equal(full.kind, 'running');
      assert.equal(full.front.state, 'running');
      await s.send('Y\r', { waitMs: 1000 });
      assert.equal(s.front().state, 'running');
      assert.ok(!events.some((e) => e.kind === 'waiting'));
      await s.stop();
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
      await inFront(s, /sleep 30/);
      const r = await s.stop('SIGTERM');
      assert.deepEqual(r.steps.map((x) => x.sent), ['SIGTERM']);
      assert.equal(r.steps[0]?.to?.argv.includes('sleep'), true);
      assert.equal(r.front.state, 'prompt');
    });

    test('stop takes steps, each reported, and never signals the shell', async () => {
      const s = await open(shell);
      await s.run('sleep 30', { waitMs: 200 });
      await inFront(s, /sleep 30/);
      const one = await s.stop();
      assert.deepEqual(one.steps.map((x) => x.sent), ['C-c']);
      assert.equal(one.front.state, 'prompt');
      await s.run(`bash -c 'trap "" INT TERM; sleep 30'`, { waitMs: 300 });
      await inFront(s, /trap|sleep 30/);
      const hard = await s.stop();
      assert.deepEqual(hard.steps.map((x) => x.sent), ['C-c', 'SIGTERM', 'SIGKILL']);
      assert.equal(hard.front.state, 'prompt');
      assert.deepEqual(out(s, await ran(s, 'echo alive')), ['alive']);
    });

    test('stop counts a step done once its job is gone, though the shell has not drawn its prompt within the grace', { skip: sh.name === 'fish' ? 'the busy prompt hook is bash and zsh syntax' : false }, async () => {
      const busy = 'SECONDS=0; while (( SECONDS < 3 )); do :; done';
      const rc = sh.name === 'zsh' ? `__busy() { ${busy} }\nprecmd_functions+=(__busy)\n` : `PROMPT_COMMAND='${busy}'\n`;
      const s = await open(shell, { rc, waitMs: 15_000 });
      await s.run('sleep 30', { waitMs: 300 });
      await inFront(s, /sleep 30/);
      const r = await s.stop();
      assert.deepEqual(r.steps.map((x) => x.sent), ['C-c']);
      assert.equal(r.front.state === 'running' ? r.front.process.shell : r.front.state, true);
      await s.wait({ kind: 'end' }, { waitMs: 8000, from: 0 });
      assert.equal(s.front().state, 'prompt');
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
