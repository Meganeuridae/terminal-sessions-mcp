import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileUserRegex, matchWindow } from '../src/core/regex.js';
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
/** Whether `pid` is gone: no such process, or a zombie nobody has reaped yet, which `kill(pid, 0)` still finds. */
const gone = (pid: number): boolean => {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return true;
  }
};
/** The home directory of the session `open` opened last. */
const lastHome = (): string => path.join(tmp, `home-${homes}`);
/** The exit the session saw, as its front gives it. */
const exitSeen = (s: Session): unknown => {
  const f = s.front();
  return f.state === 'exited' ? f.exit : f;
};

async function eventually<T>(what: string, get: () => T | undefined | false, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > until) assert.fail(`${what} did not happen within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let gates = 0;
/** A file whose presence holds whatever waits on it; the test removes it to release. */
const newGate = (): string => path.join(tmp, `gate-${++gates}`);
/** A job of one process group that runs until `gate` is removed. */
const holdJob = (gate: string): string => `sh -c 'while [ -e "$0" ]; do sleep 0.05; done' '${gate}'`;
/** A prompt hook that, while `gate` exists, prints HELD and holds the prompt; it runs after the end mark. fish draws what its prompt function prints only once it returns, so there HELD goes to the terminal itself. */
const gateHook = (shell: string, gate: string): string =>
  shell === 'fish'
    ? `function fish_prompt; if test -e '${gate}'; echo HELD >/dev/tty; while test -e '${gate}'; sleep 0.05; end; end; echo -n "> "; end\n`
    : shell === 'zsh'
      ? `__gate() { if [[ -e '${gate}' ]]; then echo HELD; while [[ -e '${gate}' ]]; do sleep 0.05; done; fi }\nprecmd_functions+=(__gate)\n`
      : `PROMPT_COMMAND='if [ -e "${gate}" ]; then echo HELD; while [ -e "${gate}" ]; do sleep 0.05; done; fi'\n`;
/** Starts a command whose prompt hook `gateHook` holds, and returns once the hook holds it, its end mark parsed. */
async function heldAfter(s: Session, gate: string, text: string, via: 'run' | 'send'): Promise<void> {
  fs.writeFileSync(gate, '');
  const from = s.lines(0).to - 1;
  if (via === 'run') await s.run(text, { waitMs: 100 });
  else await s.send(`${text}\r`, { waitMs: 100 });
  const w = await s.wait({ kind: 'match', pattern: /^HELD$/ }, { waitMs: 10_000, from });
  assert.equal(w.by, 'match', 'the prompt hook holds');
}

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
      const r = await s.send('echo typed-here\r', { waitMs: 5000, until: /^typed-here$/ });
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

    test('a command whose syntax runs past its end (a trailing backslash, an open quote, and in bash a heredoc) ends there, with a status, and the session\'s own lines neither run nor show', async () => {
      const s = await open(shell);
      const own = (c: Command): void => assert.ok(!out(s, c).some((l) => l.includes('__tsm')), out(s, c).join('\n'));
      const tail = await ran(s, 'echo tail\\');
      own(tail);
      assert.deepEqual(out(s, tail), ['tail']);
      assert.equal(tail.end?.status, 0);
      const quote = await ran(s, 'echo "open');
      own(quote);
      assert.notEqual(quote.end?.status, 0);
      assert.ok(quote.end?.status !== undefined);
      if (sh.name === 'bash') {
        const doc = await ran(s, 'cat <<EOF\nbody');
        own(doc);
        assert.ok(out(s, doc).includes('body'));
        assert.equal(doc.end?.status, 0);
      }
      assert.equal((await ran(s, 'false')).end?.status, 1);
      assert.deepEqual((await ran(s, 'false | true')).end?.pipeline, [1, 0]);
    });

    test('in bash, a command run leaves the shell\'s own RETURN trap as it was, and one it sets stays set', { skip: sh.name !== 'bash' ? 'bash only' : false }, async () => {
      const s = await open(shell, { rc: "trap ': user-trap' RETURN\n" });
      await ran(s, 'true');
      const before = await s.send('trap -p RETURN\r', { waitMs: 5000, until: /^trap -- ': user-trap' RETURN$/ });
      assert.equal(before.by, 'match');
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      await ran(s, "trap ': set-by-run' RETURN");
      const after = await s.send('trap -p RETURN\r', { waitMs: 5000, until: /^trap -- ': set-by-run' RETURN$/ });
      assert.equal(after.by, 'match');
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
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running');
      await inFront(s, /while \[ -e/);
      await s.send('echo TYPEAHEAD_RAN\r', { waitMs: 100, quietMs: 50 });
      fs.rmSync(gate);
      const w = await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      const c = w.ended.find((e) => e.id === (r as { command: Command }).command.id) ?? s.command((r as { command: Command }).command.id);
      assert.equal(c?.end?.flushed, 'echo TYPEAHEAD_RAN\n');
      const after = await ran(s, 'echo next');
      assert.deepEqual(out(s, after), ['next']);
      assert.ok(!s.lines(0).lines.includes('TYPEAHEAD_RAN'));
    });

    test('a partial line typed ahead is discarded and reported too, leaving nothing at the prompt', async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running');
      await inFront(s, /while \[ -e/);
      await s.send('echo PARTIAL', { waitMs: 100, quietMs: 50 });
      fs.rmSync(gate);
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.equal(s.command((r as { command: Command }).command.id)?.end?.flushed, 'echo PARTIAL');
      const f = s.front();
      assert.equal(f.state, 'prompt');
      assert.equal(f.state === 'prompt' ? f.pending : 'x', undefined);
      assert.deepEqual(out(s, await ran(s, 'echo next')), ['next']);
    });

    test('run refuses while text sent at the prompt a moment ago has not echoed yet, typing nothing after it', async () => {
      const s = await open(shell);
      assert.equal((await s.send('echo UNWANTED', { waitMs: 0 })).sent, true);
      const r = await s.run('echo intended', { waitMs: 1000 });
      assert.equal(r.kind, 'refused');
      assert.equal(r.front.state === 'prompt' ? r.front.pending : undefined, 'echo UNWANTED');
      await pendingIs(s, 'echo UNWANTED');
      await s.send('\x15', { waitMs: 1000 });
      assert.deepEqual(out(s, await ran(s, 'echo yes')), ['yes']);
      assert.ok(!s.lines(0).lines.some((l) => l.startsWith('UNWANTED') || l.includes('intended')));
    });

    test('run refuses, typing nothing, while something is in front or text waits at the prompt', async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running');
      await inFront(s, /while \[ -e/);
      const busy = await s.run('echo SHOULD_NOT_RUN', { waitMs: 1000 });
      assert.equal(busy.kind, 'refused');
      assert.equal(busy.front.state, 'running');
      assert.match(busy.front.state === 'running' ? busy.front.process.argv : '', /while \[ -e/);
      fs.rmSync(gate);
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
      const search = sh.name === 'bash' ? /reverse-i-search/ : sh.name === 'zsh' ? /bck-i-search/ : /search:/;
      for (const via of ['run', 'send'] as const) {
        const gate = newGate();
        const s = await open(shell, { rc: gateHook(sh.name, gate) });
        await heldAfter(s, gate, 'true', via);
        const sent = s.send('\x12', { waitMs: 10_000 });
        fs.rmSync(gate);
        assert.equal((await sent).sent, true);
        const screen = s.screen().rows.join('\n');
        assert.ok(!screen.includes('^R'), screen);
        assert.match(screen, search);
      }
    });

    test('send types nothing while a prompt hook outlasts its wait, and the same keys go in once the prompt is drawn', async () => {
      const gate = newGate();
      const s = await open(shell, { rc: gateHook(sh.name, gate) });
      await heldAfter(s, gate, 'true', 'send');
      const early = await s.send('zq', { waitMs: 500 });
      assert.equal(early.sent, false);
      assert.equal(early.by, 'timeout');
      fs.rmSync(gate);
      assert.equal((await s.send('zq', { waitMs: 10_000 })).sent, true);
      await pendingIs(s, 'zq');
    });

    test('run waits within its wait for a prompt that is slow to draw, and refuses, typing nothing, only when the wait runs out', async () => {
      const gate = newGate();
      const s = await open(shell, { rc: gateHook(sh.name, gate) });
      await heldAfter(s, gate, 'true', 'send');
      const early = await s.run('echo early', { waitMs: 500 });
      assert.equal(early.kind, 'refused');
      assert.equal(early.front.state, 'running');
      const pending = s.run('echo later', { waitMs: 10_000 });
      fs.rmSync(gate);
      const later = await pending;
      assert.equal(later.kind, 'ended');
      assert.deepEqual(out(s, (later as { command: Command }).command), ['later']);
      assert.ok(!s.lines(0).lines.includes('early'));
    });

    test('keys sent while a prompt hook reads the terminal raw wait for the drawn prompt, so the hook does not get them', { skip: sh.name === 'fish' ? 'the hooks are bash and zsh syntax' : false }, async () => {
      const hooks = sh.name === 'zsh'
        ? ['__hk() { echo HOOK_READING; read -rsk1 -t 2 hookkey }\nprecmd_functions+=(__hk)\n', "__cq() { echo HOOK_READING; print -n '\\e[6n'; read -rs -d R pos; sleep 1 }\nprecmd_functions+=(__cq)\n"]
        : ['PROMPT_COMMAND="echo HOOK_READING; read -rsn1 -t 2 hookkey"\n', "PROMPT_COMMAND='echo HOOK_READING; printf \"\\033[6n\"; IFS= read -rs -d R pos; sleep 1'\n"];
      for (const rc of hooks) {
        const s = await open(shell, { rc, waitMs: 15_000 });
        assert.equal((await s.send('true\r', { waitMs: 5000, until: /^HOOK_READING$/ })).by, 'match', 'the hook is reading when the keys are sent');
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
      const r = await s.run('cat', { waitMs: 30_000 });
      assert.equal(r.kind, 'running');
      assert.ok(Date.now() - t0 < 15_000);
      assert.equal(r.front.state, 'waiting');
      assert.match(r.front.state === 'waiting' ? r.front.process.argv : '', /cat/);
      const sent = await s.send('typed\r\x04', { waitMs: 3000, until: /^typed$/ });
      assert.equal(sent.by, 'match');
      await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      assert.equal(s.front().state, 'prompt');
    });

    test('the line editor reading before its end mark is parsed is not taken for a program waiting for input', { skip: process.platform !== 'linux' ? 'only Linux shows reads' : sh.name === 'bash' ? 'readline waits in pselect, never in a read' : sh.name === 'fish' ? 'fish waits in poll, never in a read' : false }, async () => {
      const s = await open(shell);
      const r = await s.run('sleep 0.3', { waitMs: 50 });
      assert.equal(r.kind, 'running');
      const read = process.arch === 'x64' ? '0' : '63';
      const terminal = fs.readlinkSync(`/proc/${s.pid}/fd/0`);
      /** What descriptor `fd` names, or undefined when the shell closed it after the read was seen. */
      const named = (fd: number): string | undefined => {
        try {
          return fs.readlinkSync(`/proc/${s.pid}/fd/${fd}`);
        } catch {
          return undefined;
        }
      };
      const until = Date.now() + 15_000;
      for (;;) {
        const sc = fs.readFileSync(`/proc/${s.pid}/syscall`, 'utf8').split(' ');
        if (sc[0] === read && named(Number.parseInt(sc[1] ?? '', 16)) === terminal) break;
        if (Date.now() > until) assert.fail(`the shell never read the terminal: ${sc.join(' ')}`);
      }
      assert.notEqual(s.front().state, 'waiting');
      const block = Date.now() + 300;
      while (Date.now() < block);
      assert.notEqual(s.front().state, 'waiting');
      const w = await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      assert.equal(w.by, 'end');
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
      const python = await eventually('python in front', () => { const f = s.front(); return f.state !== 'prompt' && f.state !== 'exited' && /python3/.test(f.process.argv) && f.process.pgid; });
      await eventually('python blocked in splice for room in its pipe', () => fs.readFileSync(`/proc/${python}/syscall`, 'utf8').startsWith(process.arch === 'x64' ? '275 ' : '76 ') && fs.readFileSync(`/proc/${python}/wchan`, 'utf8').trim() === 'pipe_wait_writable');
      assert.equal(s.front().state, 'running');
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

    test('a line longer than the emulator\'s scrollback comes back whole, as lines of at most 64 Ki characters', async () => {
      const s = await open(shell, { cols: 20 });
      const c = await ran(s, "head -c 250000 /dev/zero | tr '\\0' x; echo", 30_000);
      assert.deepEqual(out(s, c).map((l) => l.length), [65_536, 65_536, 65_536, 53_392]);
      assert.equal(out(s, c).join(''), 'x'.repeat(250_000));
      assert.deepEqual(out(s, await ran(s, 'echo after')), ['after']);
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
      const from = s.lines(0).to - 1;
      await s.run(`bash -c 'trap "" INT TERM; echo TRAPS_SET; sleep 30'`, { waitMs: 300 });
      assert.equal((await s.wait({ kind: 'match', pattern: /^TRAPS_SET$/ }, { waitMs: 10_000, from })).by, 'match');
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
      const ended = await eventually('the ending', () => events.find((e) => e.kind === 'ended' && e.command.id === (r as { command: Command }).command.id));
      assert.equal(ended.kind === 'ended' && ended.taken, false);
      await s.run('exit 4', { waitMs: 3000 });
      await eventually('the exit', () => events.some((e) => e.kind === 'exited'));
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

    test('a program exec\'d in the shell\'s place is a program in front, not a shell, and run refuses', async () => {
      const s = await open(shell);
      const r = await s.run('exec cat', { waitMs: 3000 });
      assert.equal(r.kind, 'running');
      const f = await eventually('cat in front', () => {
        const now = s.front();
        return now.state !== 'prompt' && now.state !== 'exited' && /cat/.test(now.process.argv) && now;
      });
      assert.equal(f.process.shell, false);
      if (process.platform === 'linux') assert.equal(f.state, 'waiting');
      assert.equal((await s.run('echo no', { waitMs: 1000 })).kind, 'refused');
      const stopped = await s.stop('SIGTERM');
      assert.deepEqual(stopped.steps, []);
      assert.equal(stopped.next, 'close');
    });

    test('a typed command that reads the terminal shows as waiting though its shell marks no start', { skip: process.platform !== 'linux' ? 'only Linux shows reads' : sh.name !== 'bash' ? 'bash only: it clears PS0, as bash before 4.4 has none' : false }, async () => {
      const s = await open(shell, { rc: "PROMPT_COMMAND='PS0='\n" });
      await s.send('read x; echo "GOT:$x"\r', { waitMs: 1000 });
      const w = await s.wait({ kind: 'input' }, { waitMs: 5000, from: 0 });
      assert.equal(w.by, 'input');
      assert.equal(w.front.state === 'waiting' && w.front.process.shell, true);
      assert.equal((await s.send('y\r', { waitMs: 3000, until: /^GOT:y$/ })).by, 'match');
    });

    test('a program that reads again after input sent to it is a new wait, with its own event', { skip: process.platform !== 'linux' ? 'only Linux shows reads' : false }, async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const r = await s.run(`sh -c 'read a; read b; echo "DONE:$a$b"'`, { waitMs: 5000 });
      assert.equal(r.front.state, 'waiting');
      await s.send('x\r', { waitMs: 3000 });
      assert.equal((await s.wait({ kind: 'input' }, { waitMs: 5000, from: 0 })).by, 'input');
      assert.equal((await s.send('y\r', { waitMs: 3000, until: /^DONE:xy$/ })).by, 'match');
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.equal(events.filter((e) => e.kind === 'waiting').length, 2);
    });

    test('a wait for input that a call returns is taken by that call', { skip: process.platform !== 'linux' ? 'only Linux shows reads' : false }, async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(`sh -c 'while [ -e "$0" ]; do sleep 0.05; done; read a' '${gate}'`, { waitMs: 50 });
      assert.equal(r.kind, 'running');
      fs.rmSync(gate);
      assert.equal((await s.wait({ kind: 'input' }, { waitMs: 5000, from: 0 })).by, 'input');
      const waits = await eventually('the waiting event', () => events.filter((e) => e.kind === 'waiting').length > 0 && events.filter((e) => e.kind === 'waiting'));
      assert.ok(waits.every((e) => e.kind === 'waiting' && e.taken), JSON.stringify(waits));
      await s.send('z\r', { waitMs: 1000 });
    });

    test('a directory whose name ends in a newline comes back exact', async () => {
      const dir = path.join(tmp, `nl-${++homes}\n`);
      fs.mkdirSync(dir);
      const s = await open(shell, { cwd: dir });
      assert.equal((await ran(s, 'true')).end?.cwd, dir);
      assert.equal(s.cwd(), dir);
    });

    test('close hangs up the shell and removes its directory', async () => {
      const s = await open(shell);
      const before = fs.readdirSync(tmp).filter((d) => d.startsWith('s-')).length;
      const exit = await s.close();
      assert.deepEqual(exit, exitSeen(s));
      assert.notEqual(exit.signal, 'SIGKILL', 'the shell ended on the hangup, not on the KILL that follows a grace');
      assert.equal(fs.readdirSync(tmp).filter((d) => d.startsWith('s-')).length, before - 1);
    });

    test('text typed ahead past what the terminal holds at once is drained whole at the next prompt, and none of it runs', async () => {
      const s = await open(shell);
      const r = await s.run('sleep 2', { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const typed = Array.from({ length: 1400 }, (_, i) => `echo LEAKED_${i}\r`).join('');
      await s.send(typed, { waitMs: 300, quietMs: 100 });
      assert.equal((await s.wait({ kind: 'end' }, { waitMs: 20_000, from: 0 })).by, 'end');
      assert.ok(r.kind === 'running' && r.command.end?.flushed?.includes('LEAKED_1399'), JSON.stringify(r.kind === 'running' && r.command.end?.flushed?.length));
      assert.deepEqual(out(s, await ran(s, 'echo AFTER')), ['AFTER']);
      assert.ok(!s.lines(0).lines.some((l) => /^LEAKED_\d+$/.test(l)));
    });

    test('a pattern wait and a watch match text a program draws on the alternate screen', async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const id = s.watch(/ALT-WATCHED/, s.lines(0).to);
      const r = await s.run(`printf '\\x1b[?1049h\\x1b[HALT-READY ALT-WATCHED'; sleep 3; printf '\\x1b[?1049l'`, { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const w = await s.wait({ kind: 'match', pattern: /ALT-READY/ }, { waitMs: 5000, from: s.lines(0).to });
      assert.equal(w.by, 'match');
      assert.equal(w.matched?.row, 0);
      await eventually('the watch', () => events.some((e) => e.kind === 'match' && e.watch === id));
    });

    test('a match on a line longer than the pattern\'s window is not seen, and the wait says how many lines it searched on their head only', async () => {
      const pattern = compileUserRegex('(a?)'.repeat(200) + 'READY');
      assert.ok(matchWindow(pattern) < 60_000, String(matchWindow(pattern)));
      const s = await open(shell);
      const from = s.lines(0).to;
      await ran(s, `head -c 60000 /dev/zero | tr '\\0' x; echo READY`, 30_000);
      const w = await s.wait({ kind: 'match', pattern }, { waitMs: 1000, from });
      assert.equal(w.by, 'timeout');
      assert.equal(w.clipped, 1);
    });

    /** `n` lines of 2,000 characters of words, `TARGET` at the end of lines n-5 and n-2, and a pattern whose search costs each line its whole length. */
    const backlog = (n = 40): string => `awk 'BEGIN{for(i=1;i<=${n};i++){printf "%d", i; for(j=0;j<666;j++) printf " ab"; if (i==${n - 5}||i==${n - 2}) printf " TARGET"; print ""}}'`;
    const costly = (): RegExp => compileUserRegex('(\\w+\\s?){1,80}TARGET');
    const same = { skip: sh.name !== 'bash' ? 'a search is the same in every shell' : false };

    test('a pattern search across a long backlog lets the event loop turn while it searches, and a wait finds the first line that matches', same, async () => {
      const s = await open(shell, { cols: 200 });
      const from = s.lines(0).to;
      await ran(s, backlog(), 30_000);
      // Counted with a watch: a wait takes turns of its own after its match.
      let turns = 0;
      let done = false;
      const turn = (): void => {
        if (done) return;
        turns++;
        setImmediate(turn);
      };
      setImmediate(turn);
      const id = s.watch(costly(), from);
      s.onEvent((e) => {
        if (e.kind === 'match' && e.watch === id) done = true;
      });
      await eventually('the watch', () => done, 300_000);
      assert.ok(turns >= 3, `the event loop turned ${turns} times while the search ran`);
      const w = await s.wait({ kind: 'match', pattern: costly() }, { waitMs: 300_000, from });
      assert.equal(w.by, 'match');
      assert.match(w.matched!.text, /^35 /);
    });

    test('a watch on lines already printed goes on searching though nothing more is printed, and reports the first line that matches', same, async () => {
      const s = await open(shell, { cols: 200 });
      const from = s.lines(0).to;
      await ran(s, backlog(), 30_000);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const id = s.watch(costly(), from);
      await eventually('the watch', () => events.some((e) => e.kind === 'match' && e.watch === id), 300_000);
      const m = events.find((e) => e.kind === 'match' && e.watch === id);
      assert.match(m?.kind === 'match' ? m.match.text : '', /^35 /);
    });

    test('a search that has spent the turn\'s slice still lets another session\'s watch search a line in that turn', same, async () => {
      const a = await open(shell, { cols: 200 });
      const from = a.lines(0).to;
      await ran(a, backlog(80), 30_000);
      const b = await open(shell);
      const bFrom = b.lines(0).to;
      await ran(b, 'echo NEEDLE-$((6 * 7))');
      const needle = bFrom + b.lines(bFrom).lines.indexOf('NEEDLE-42');
      assert.ok(needle >= bFrom);
      const events: SessionEvent[] = [];
      b.onEvent((e) => events.push(e));
      const w = a.wait({ kind: 'match', pattern: costly() }, { waitMs: 300_000, from });
      const id = b.watch(/^NEEDLE-42$/, needle);
      for (let i = 0; i < 20; i++) await null;
      assert.ok(events.some((e) => e.kind === 'match' && e.watch === id), 'the watch searched nothing in the turn the other search spent');
      assert.equal((await w).by, 'match');
    });

    test('a pattern wait that ends before its search reaches the end says how many lines it had not searched', same, async () => {
      const s = await open(shell, { cols: 200 });
      const from = s.lines(0).to;
      await ran(s, backlog(), 30_000);
      const w = await s.wait({ kind: 'match', pattern: costly() }, { waitMs: 100, from });
      assert.equal(w.by, 'timeout');
      assert.equal(w.matched, undefined);
      assert.ok(w.unsearched !== undefined && w.unsearched > 0 && w.unsearched <= s.lines(from).lines.length, String(w.unsearched));
    });

    test('a watch that matches a command\'s output is reported before the command\'s end, though both arrive in one read', async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const id = s.watch(/^WATCHED-LAST$/, s.lines(0).to);
      const r = s.run('sleep 0.2; echo WATCHED-LAST', { waitMs: 50 });
      const held = Date.now() + 1500;
      while (Date.now() < held);
      await r;
      await eventually('both', () => events.some((e) => e.kind === 'match' && e.watch === id) && events.some((e) => e.kind === 'ended'));
      assert.deepEqual(events.filter((e) => e.kind === 'match' || e.kind === 'ended').map((e) => e.kind), ['match', 'ended']);
    });

    test('a program whose other thread reads the terminal shows as waiting', { skip: process.platform !== 'linux' ? 'only Linux shows reads' : false }, async () => {
      const s = await open(shell);
      const r = await s.run(`python3 -c 'import sys, threading; t = threading.Thread(target=sys.stdin.readline); t.start(); t.join()'`, { waitMs: 300 });
      assert.equal(r.kind, 'running');
      assert.equal((await s.wait({ kind: 'input' }, { waitMs: 10_000, from: 0 })).by, 'input');
      await s.send('\r', { waitMs: 2000 });
    });

    test('a line sent with no start mark that reaches a read after send returned is seen waiting', { skip: sh.name !== 'bash' || process.platform !== 'linux' ? 'bash with PS0 cleared, on Linux, where reads show' : false }, async () => {
      const s = await open(shell);
      await ran(s, 'PS0=');
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      await s.send('sleep 1; read x\r', { waitMs: 300, quietMs: 100 });
      await eventually('the waiting event', () => events.some((e) => e.kind === 'waiting'), 8000);
      await s.send('z\r', { waitMs: 2000 });
    });

    test('run waiting for a prompt that close has begun to end types nothing', { skip: sh.name === 'fish' ? 'the hangup is ignored with bash and zsh syntax' : false }, async () => {
      const gate = newGate();
      const s = await open(shell, { rc: `${gateHook(sh.name, gate)}trap '' HUP\n` });
      await heldAfter(s, gate, 'true', 'run');
      const r = s.run('echo NOPE', { waitMs: 10_000 });
      const closing = s.close();
      fs.rmSync(gate);
      assert.equal((await r).kind, 'refused');
      await closing;
    });

    test('close with force ends a descendant that left the terminal with setsid', async () => {
      const s = await open(shell);
      const c = await ran(s, `sh -c 'python3 -c "import os, sys, time; os.setsid(); sys.stdout.write(str(os.getpid()) + chr(10)); sys.stdout.flush(); time.sleep(300)"; :' & sleep 1`);
      const pid = Number(out(s, c).find((l) => /^\d+$/.test(l)));
      assert.ok(pid > 0, out(s, c).join('\n'));
      try {
        const exit = await s.close({ force: true });
        assert.equal(exit.unlisted, undefined);
        await eventually('the setsid descendant is gone', () => gone(pid));
      } finally {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    });

    test('close hangs up again while the shell is there, so a shell that outlived the first hangup ends on a later one, not on the KILL', { skip: sh.name === 'fish' ? 'the trap is written with bash and zsh syntax' : false }, async () => {
      // The trap takes the first hangup, leaves a file to say so, and restores the default. Without ignoreeof, bash at its prompt exits on the trapped hangup with status 0, as at end of file.
      const s = await open(shell, { rc: "set -o ignoreeof\ntrap ': > \"$HOME/first-hangup\"; trap - HUP' HUP\n" });
      const home = lastHome();
      const exit = await s.close();
      assert.deepEqual(exit, exitSeen(s));
      assert.ok(fs.existsSync(path.join(home, 'first-hangup')), 'the shell took the first hangup and went on');
      assert.notEqual(exit.signal, 'SIGKILL', 'the shell ended on a later hangup, not on the KILL that follows a grace');
    });

    test('close of a shell that ignores the hangup KILLs the shell alone, so a job that ignores it too lives on, writing to the closed terminal', { skip: sh.name === 'fish' ? 'the hangup is ignored with bash and zsh syntax' : false }, async () => {
      const s = await open(shell, { rc: "trap '' HUP\n" });
      const ticks = path.join(lastHome(), 'ticks');
      const c = await ran(s, `(while :; do echo tick; echo tick >> '${ticks}'; sleep 0.1; done) & echo "JOB:$!"`);
      const job = Number(/^JOB:(\d+)$/.exec(out(s, c).find((l) => l.startsWith('JOB:')) ?? '')?.[1]);
      assert.ok(job > 0);
      try {
        await eventually('the job ticks', () => fs.existsSync(ticks));
        const exit = await s.close();
        assert.deepEqual(exit, exitSeen(s));
        assert.equal(exit.signal, 'SIGKILL');
        const at = fs.statSync(ticks).size;
        await eventually('the job goes on after close', () => fs.statSync(ticks).size > at);
      } finally {
        try {
          process.kill(job, 'SIGKILL');
        } catch {}
      }
    });

    test('close with force ends a shell whose job ignores the hangup', async () => {
      const s = await open(shell);
      const from = s.lines(0).to - 1;
      await s.run(`bash -c 'trap "" HUP INT TERM; echo "TRAPS_SET:$$"; sleep 30'`, { waitMs: 200 });
      assert.equal((await s.wait({ kind: 'match', pattern: /^TRAPS_SET:\d+$/ }, { waitMs: 10_000, from })).by, 'match');
      const job = Number(s.lines(from).lines.find((l) => /^TRAPS_SET:\d+$/.test(l))!.slice('TRAPS_SET:'.length));
      const exit = await s.close({ force: true });
      assert.deepEqual(exit, exitSeen(s));
      assert.equal(exit.signal, 'SIGKILL');
      await eventually('the job is gone', () => gone(job));
    });
  });
}

test('a cwd that is not a directory is refused as invalid_argument', async () => {
  await assert.rejects(open(which('bash') ?? '/bin/sh', { cwd: path.join(tmp, 'missing') }), { code: 'invalid_argument' });
});

test('text sent to a shell without integration at its prompt is pending there, so run refuses until it is cleared', async () => {
  const s = await open('/bin/sh');
  await s.send('echo par', { waitMs: 2000, quietMs: 100 });
  await pendingIs(s, 'echo par');
  assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
  await s.send('\x15', { waitMs: 2000, quietMs: 100 });
  await eventually('nothing pending', () => {
    const f = s.front();
    return f.state === 'prompt' && f.pending === undefined;
  });
  assert.equal((await s.run('echo plain', { waitMs: 5000 })).kind, 'ended');
});

test('a shell without integration opens and runs, with no status', async () => {
  const s = await open('/bin/sh');
  assert.equal(s.kind, 'none');
  assert.equal(s.front().state, 'prompt');
  const r = await s.run('echo plain', { waitMs: 5000 });
  assert.equal(r.kind, 'ended');
  assert.equal(r.kind === 'ended' ? r.command.end?.status : 'x', undefined);
});
