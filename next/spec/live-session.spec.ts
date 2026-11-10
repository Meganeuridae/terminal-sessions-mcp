import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileUserRegex, matchWindow } from '../src/core/regex.js';
import * as proc from '../src/session/proc.js';
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
/** A deadline for `close`, on `performance.now()`'s clock. */
const by = (ms = 30_000): number => performance.now() + ms;
// Each test's sessions close as it ends. With every session held to the suite's end, the last tests' shells failed to start
// on macOS.
let openedBefore = 0;
beforeEach(() => {
  openedBefore = sessions.length;
});
afterEach(async () => {
  for (const s of sessions.slice(openedBefore)) await s.close({ force: true, deadline: by() });
});
after(async () => {
  for (const s of sessions) await s.close({ force: true, deadline: by() });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

const bashBelow = (shell: string, major: number, minor: number): boolean => {
  if (path.basename(shell) !== 'bash') return false;
  const [a, b] = execFileSync(shell, ['-c', 'echo "$\{BASH_VERSINFO[0]} $\{BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim().split(' ').map(Number);
  return a! < major || (a === major && b! < minor);
};

const STARTUP: Record<string, string> = { bash: '.bash_profile', zsh: '.zshrc', fish: '.config/fish/config.fish' };

async function open(shell: string, opts: { rc?: string; files?: Record<string, string>; cwd?: string; cols?: number; waitMs?: number; log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<Session> {
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
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  sessions.push(s);
  return s;
}

const out = (s: Session, c: Command): string[] => s.lines(c.from, c.to).lines;
/**
 * Whether `pid` is gone: `kill(pid, 0)` finds no such process, or finds a zombie nobody has reaped yet. A ps that fails, as when
 * no process can be spawned, throws rather than counting as gone.
 */
const gone = (pid: number): boolean => {
  const there = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw e;
    }
  };
  if (!there()) return true;
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch (e) {
    // ps fails for a pid that went between the two looks; a failure while it's still there is ps's own.
    if (!there()) return true;
    throw e;
  }
};
/** The pid a command printed on a line of its own as `TAG:pid`. */
const pidOf = (s: Session, c: Command, tag: string): number => {
  const pid = Number(new RegExp(`^${tag}:(\\d+)$`).exec(out(s, c).find((l) => l.startsWith(`${tag}:`)) ?? '')?.[1]);
  assert.ok(pid > 0, `${tag} in ${JSON.stringify(out(s, c))}`);
  return pid;
};
/** Whether `pid` is stopped. */
const isStopped = (pid: number): boolean => {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('T');
  } catch {
    return false;
  }
};
/** KILLs `pid` if it's still there, to clean up after a test. */
const killPid = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
};
/** The home directory of the session `open` opened last. */
const lastHome = (): string => path.join(tmp, `home-${homes}`);
/** The exit the session saw, as its front gives it. */
const exitSeen = (s: Session): unknown => {
  const f = s.front();
  return f.state === 'exited' ? f.exit : f;
};

async function eventually<T>(what: string, get: () => T | undefined | false, ms = 10_000): Promise<T> {
  const until = performance.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (performance.now() > until) assert.fail(`${what} did not happen within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let gates = 0;
/** A directory holding a `ps` that runs `cases`, a `case "$*"` body, before it runs the real one: put it first on PATH. */
const fakePs = (cases: string): string => {
  const dir = path.join(tmp, `ps-${++gates}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ps'), `#!/bin/sh\ncase "$*" in\n${cases}\nesac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return dir;
};
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
/** A prompt hook that, at the prompt after a command creates `arm`, removes it and creates `flag`: once `flag` exists, the command's output and its end mark have been written. */
const flagHook = (shell: string, arm: string, flag: string): string =>
  shell === 'fish'
    ? `function __flag --on-event fish_prompt; if test -e '${arm}'; rm '${arm}'; touch '${flag}'; end; end\n`
    : shell === 'zsh'
      ? `__flag() { if [[ -e '${arm}' ]]; then rm '${arm}'; : > '${flag}'; fi }\nprecmd_functions+=(__flag)\n`
      : `PROMPT_COMMAND='if [ -e "${arm}" ]; then rm "${arm}"; : > "${flag}"; fi'\n`;
/** Which of the 1,400 `echo LEAKED_i` lines a test typed ahead are missing from `flushed`. */
const missingLeaked = (flushed: string | undefined, count = 1400): number[] => {
  const seen = new Set([...(flushed ?? '').matchAll(/LEAKED_(\d+)/g)].map((m) => Number(m[1])));
  return Array.from({ length: count }, (_, i) => i).filter((i) => !seen.has(i));
};
/** Holds the event loop until `file` exists, so whatever was written before it is read in one go. */
function holdUntil(file: string, ms = 10_000): void {
  const until = performance.now() + ms;
  while (!fs.existsSync(file)) if (performance.now() > until) assert.fail(`${file} did not appear within ${ms} ms`);
}
/** Each event with the event loop's turn it came in. */
function eventsByTurn(s: Session): { events: Array<{ e: SessionEvent; turn: number }>; stop: () => void } {
  const events: Array<{ e: SessionEvent; turn: number }> = [];
  let turn = 0;
  let stopped = false;
  const tick = (): void => {
    turn++;
    if (!stopped) setImmediate(tick);
  };
  setImmediate(tick);
  const off = s.onEvent((e) => events.push({ e, turn }));
  return { events, stop: () => ((stopped = true), off()) };
}
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
  const until = performance.now() + ms;
  for (;;) {
    const f = s.front();
    if ((f.state === 'running' || f.state === 'waiting') && pattern.test(f.process.argv)) return;
    if (performance.now() > until) assert.fail(`nothing matching ${pattern} came in front: ${JSON.stringify(f)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pendingIs(s: Session, text: string, ms = 5000): Promise<void> {
  const until = performance.now() + ms;
  for (;;) {
    const f = s.front();
    if (f.state === 'prompt' && f.pending === text) return;
    if (performance.now() > until) assert.fail(`the prompt never showed ${JSON.stringify(text)} pending: ${JSON.stringify(f)}`);
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

    test('output that replays a spent mark of the session\'s own ends nothing', async () => {
      const s = await open(shell);
      const expected = (): string => {
        const e = (s as unknown as { chains: Array<{ expected: { counter: number; random: string } }> }).chains[0]!.expected;
        return `${e.counter}.${e.random}`;
      };
      const spent = expected();
      await ran(s, 'true');
      const next = expected();
      assert.notEqual(next, spent);
      const c = await ran(s, `printf '\\033]133;C;${spent};\\007\\033]133;D;${spent};${next};0;;;/;\\007after\\n'; false`);
      assert.deepEqual([c.end?.status, c.end?.refusedMarks], [1, 2]);
      assert.deepEqual(out(s, c), ['after']);
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
      assert.deepEqual(out(s, c), ['[[redacted]..........]']);
    });

    test('the live nonce never shows in the title', { skip: sh.name === 'fish' ? 'fish sets its own title at each prompt' : false }, async () => {
      const s = await open(shell);
      await ran(s, `printf '\\033]0;%s\\007' "$__tsm_r"`);
      assert.equal(s.screen().title, '[redacted]..........');
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
      await eventually('the text is drawn', () => s.screen().rows.some((l) => l.includes('echo UNWANTED')));
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

    test('after a blank line, which ends with no start mark, run waits for the prompt a hook holds, then runs', { skip: sh.name === 'fish' ? 'fish prints no end mark for a blank line' : false }, async () => {
      const gate = newGate();
      const s = await open(shell, { rc: gateHook(sh.name, gate) });
      await heldAfter(s, gate, '', 'send');
      const pending = s.run('echo later', { waitMs: 10_000 });
      fs.rmSync(gate);
      const later = await pending;
      assert.equal(later.kind, 'ended', JSON.stringify(later));
      assert.deepEqual(later.kind === 'ended' && out(s, later.command), ['later']);
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
      for (const query of [false, true]) {
        const gate = newGate();
        const keys = path.join(tmp, `keys-${gates}`);
        const loop = sh.name === 'zsh'
          ? `while :; do if read -rs -k 1 -t 0.05 k; then print -rn -- "$k" >> '${keys}'; elif [[ ! -e '${gate}' ]]; then break; fi; done`
          : `while :; do if IFS= read -rsn1 -t 1 k; then printf %s "$k" >> '${keys}'; elif [ ! -e '${gate}' ]; then break; fi; done`;
        const ask = !query ? '' : sh.name === 'zsh' ? "print -n '\\e[6n'; read -rs -d R pos; " : 'printf "\\033[6n"; IFS= read -rs -d R pos; ';
        const rc = sh.name === 'zsh' ? `__hk() { if [[ -e '${gate}' ]]; then echo HOOK_READING; ${ask}${loop}; fi }\nprecmd_functions+=(__hk)\n` : `__hk() { if [ -e '${gate}' ]; then echo HOOK_READING; ${ask}${loop}; fi; }\nPROMPT_COMMAND=__hk\n`;
        const s = await open(shell, { rc, waitMs: 15_000 });
        fs.writeFileSync(gate, '');
        assert.equal((await s.send('true\r', { waitMs: 5000, until: /^HOOK_READING$/ })).by, 'match', 'the hook is reading when the keys are sent');
        const sent = s.send('zq', { waitMs: 10_000 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        fs.rmSync(gate);
        assert.equal((await sent).sent, true);
        await pendingIs(s, 'zq');
        assert.equal(fs.existsSync(keys) ? fs.readFileSync(keys, 'utf8') : '', '', 'the hook read none of the keys');
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

    test('a program blocked reading the terminal shows as waiting, and run returns at once', { skip: !proc.READS_VISIBLE ? "only Linux on x64, arm64, riscv64 and loong64 shows reads" : false }, async () => {
      const s = await open(shell);
      const t0 = performance.now();
      const r = await s.run('cat', { waitMs: 30_000 });
      assert.equal(r.kind, 'running');
      assert.ok(performance.now() - t0 < 15_000);
      assert.equal(r.front.state, 'waiting');
      assert.match(r.front.state === 'waiting' ? r.front.process.argv : '', /cat/);
      const sent = await s.send('typed\r\x04', { waitMs: 3000, until: /^typed$/ });
      assert.equal(sent.by, 'match');
      await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      assert.equal(s.front().state, 'prompt');
    });

    test('the line editor reading before its end mark is parsed is not taken for a program waiting for input', { skip: !proc.READS_VISIBLE ? "only Linux on x64, arm64, riscv64 and loong64 shows reads" : sh.name === 'bash' ? 'readline waits in pselect, never in a read' : sh.name === 'fish' ? 'fish waits in poll, never in a read' : false }, async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 50 });
      assert.equal(r.kind, 'running');
      fs.rmSync(gate);
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
      const until = performance.now() + 15_000;
      for (;;) {
        const sc = fs.readFileSync(`/proc/${s.pid}/syscall`, 'utf8').split(' ');
        if (sc[0] === read && named(Number.parseInt(sc[1] ?? '', 16)) === terminal) break;
        if (performance.now() > until) assert.fail(`the shell never read the terminal: ${sc.join(' ')}`);
      }
      assert.notEqual(s.front().state, 'waiting');
      const block = performance.now() + 300;
      while (performance.now() < block);
      assert.notEqual(s.front().state, 'waiting');
      const w = await s.wait({ kind: 'end' }, { waitMs: 3000, from: 0 });
      assert.equal(w.by, 'end');
      assert.equal(s.front().state, 'prompt');
    });

    test('a program splicing from the terminal shows as waiting only while it waits for input, not for room in its pipe', { skip: !proc.READS_VISIBLE || !which('python3') ? 'Linux on x64, arm64, riscv64 or loong64, with python3, only' : false }, async () => {
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
      const python = await eventually('python in front', () => { const f = s.front(); return (f.state === 'running' || f.state === 'waiting') && /python3/.test(f.process.argv) && f.process.pgid; });
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
      assert.deepEqual(s.lines(c.from, c.to).continues, [c.from + 1, c.from + 2, c.from + 3]);
      assert.deepEqual(out(s, await ran(s, 'echo after')), ['after']);
    });

    test('of the pieces of a line longer than 64 Ki characters, each after the first is reported as going on the line before, on the screen and once frozen', async () => {
      const s = await open(shell);
      const c = await ran(s, "head -c 70000 /dev/zero | tr '\\0' y; echo; echo short", 30_000);
      assert.deepEqual(out(s, c).map((l) => l.length), [65_536, 4_464, 5]);
      assert.deepEqual(s.lines(c.from, c.to).continues, [c.from + 1]);
      await ran(s, 'seq 1 100');
      assert.deepEqual(s.lines(c.from, c.to).continues, [c.from + 1]);
      assert.equal(s.lines(c.from, c.to).live, 0, 'frozen');
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

    test('a directory at the drain file\'s path counts as no drain: the command ends with nothing flushed, and the session goes on', async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running', JSON.stringify(r));
      // The end hook drains into the session's directory, to a file named for the nonce counter its end mark closes.
      const inner = s as unknown as { dir: string; chains: Array<{ expected: { counter: number } }> };
      fs.mkdirSync(path.join(inner.dir, `drained.${inner.chains[0]!.expected.counter}`));
      fs.rmSync(gate);
      await s.wait({ kind: 'end' }, { waitMs: 10_000, from: 0 });
      const c = s.command(r.kind === 'running' ? r.command.id : -1);
      assert.deepEqual([c?.end?.status, c?.end?.flushed], [0, undefined], JSON.stringify(c?.end));
      assert.deepEqual(out(s, await ran(s, 'echo after')), ['after']);
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

    test('a suspend signal stops the job: the prompt comes back, the step and the command say stopped, and run fg brings it back', async () => {
      const s = await open(shell);
      // As each ended event is emitted, whether its command says stopped then: a wake is written from it at once.
      const atEmit = new Map<number, boolean>();
      s.onEvent((e) => e.kind === 'ended' && atEmit.set(e.command.id, e.command.end?.stopped === true));
      for (const sig of ['SIGTSTP', 'SIGSTOP', 'SIGTTIN', 'SIGTTOU'] as const) {
        const r = await s.run('sleep 30', { waitMs: 200 });
        assert.equal(r.kind, 'running', JSON.stringify(r));
        await inFront(s, /sleep 30/);
        const o = await s.stop(sig);
        assert.deepEqual(o.steps.map((x) => [x.sent, x.front.state, x.stopped]), [[sig, 'prompt', true]], JSON.stringify(o));
        const c = s.command(r.kind === 'running' ? r.command.id : -1);
        assert.equal(c?.end?.stopped, true, JSON.stringify(c?.end));
        assert.equal(atEmit.get(c!.id), true, 'the ended event said stopped as it was emitted');
        // bash and zsh report 128 and the signal's number, as for a job a signal ended; fish reports 0.
        assert.equal(c?.end?.status, sh.name === 'fish' ? 0 : 128 + os.constants.signals[sig]);
        if (sig === 'SIGTSTP') {
          const cont = await s.stop('SIGCONT');
          assert.deepEqual([cont.steps.length, cont.front.state], [0, 'prompt'], 'at a prompt nothing is in front');
        }
        const fg = await s.run('fg', { waitMs: 500 });
        assert.equal(fg.kind, 'running', JSON.stringify(fg));
        await inFront(s, /sleep 30/);
        const k = await s.stop();
        assert.deepEqual([k.front.state, k.steps.some((x) => x.stopped)], ['prompt', false], JSON.stringify(k));
      }
    });

    test('a signal the job ignores leaves it in front, running, once the grace runs out, and an unknown name is refused', async () => {
      const s = await open(shell);
      const from = s.lines(0).to - 1;
      const r = await s.run(`sh -c 'trap "" USR1; echo USR1_IGNORED; sleep 30'`, { waitMs: 300 });
      assert.equal((await s.wait({ kind: 'match', pattern: /^USR1_IGNORED$/ }, { waitMs: 10_000, from })).by, 'match');
      const o = await s.stop('SIGUSR1');
      assert.deepEqual(o.steps.map((x) => [x.sent, x.front.state, x.stopped]), [['SIGUSR1', 'running', undefined]], JSON.stringify(o));
      assert.equal(s.command(r.kind === 'running' ? r.command.id : -1)?.end, undefined);
      const bogus = await s.stop('SIGBOGUS' as NodeJS.Signals);
      assert.deepEqual(bogus.steps.map((x) => [x.sent, x.refused]), [['SIGBOGUS', 'ERR_UNKNOWN_SIGNAL']]);
      await s.stop();
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
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 50 });
      assert.equal(r.kind, 'running');
      fs.rmSync(gate);
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

    test('a shell replaced by exec typed through send keeps working, without statuses', async () => {
      const s = await open(shell);
      await s.send('exec /bin/sh\r', { waitMs: 3000, quietMs: 300 });
      await eventually('sh replaced the shell', () => /^(\/bin\/)?sh\b/.test(proc.argv(s.pid) ?? ''));
      // With no marks, its prompt is known once it reads the terminal after a quiet spell.
      await eventually("sh's prompt is in front", () => s.front().state === 'prompt');
      const after = await s.run('echo after-exec', { waitMs: 8000 });
      assert.equal(after.kind, 'ended', JSON.stringify(after));
      if (after.kind === 'ended') assert.deepEqual(out(s, after.command), ['after-exec']);
    });

    test('a program exec\'d in the shell\'s place is a program in front, not a shell, and run refuses', async () => {
      const s = await open(shell);
      const r = await s.run('exec cat', { waitMs: 3000 });
      assert.equal(r.kind, 'running');
      const f = await eventually('cat in front', () => {
        const now = s.front();
        return (now.state === 'running' || now.state === 'waiting') && /cat/.test(now.process.argv) && now;
      });
      assert.equal(f.process.shell, false);
      if (process.platform === 'linux') assert.equal(f.state, 'waiting');
      assert.equal((await s.run('echo no', { waitMs: 1000 })).kind, 'refused');
      const stopped = await s.stop('SIGTERM');
      assert.deepEqual(stopped.steps, []);
      assert.equal(stopped.next, 'close');
    });

    test('a typed command that reads the terminal shows as waiting though its shell marks no start', { skip: !proc.READS_VISIBLE ? "only Linux on x64, arm64, riscv64 and loong64 shows reads" : sh.name !== 'bash' ? 'bash only: it clears PS0, as bash before 4.4 has none' : false }, async () => {
      const s = await open(shell, { rc: "PROMPT_COMMAND='PS0='\n" });
      await s.send('read x; echo "GOT:$x"\r', { waitMs: 1000 });
      const w = await s.wait({ kind: 'input' }, { waitMs: 5000, from: 0 });
      assert.equal(w.by, 'input');
      assert.equal(w.front.state === 'waiting' && w.front.process.shell, true);
      assert.equal((await s.send('y\r', { waitMs: 3000, until: /^GOT:y$/ })).by, 'match');
    });

    test('a program that reads again after input sent to it is a new wait, with its own event', { skip: !proc.READS_VISIBLE ? "only Linux on x64, arm64, riscv64 and loong64 shows reads" : false }, async () => {
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

    test('a wait for input that a call returns is taken by that call', { skip: !proc.READS_VISIBLE ? "only Linux on x64, arm64, riscv64 and loong64 shows reads" : false }, async () => {
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
      const exit = await s.close({ deadline: by() });
      assert.deepEqual(exit, exitSeen(s));
      assert.notEqual(exit.signal, 'SIGKILL', 'the shell ended on the hangup, not on the KILL that follows a grace');
      assert.equal(fs.readdirSync(tmp).filter((d) => d.startsWith('s-')).length, before - 1);
    });

    test('text typed ahead past what the terminal holds at once is drained whole at the next prompt, and none of it runs', async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const typed = Array.from({ length: 1400 }, (_, i) => `echo LEAKED_${i}\r`).join('');
      await s.send(typed, { waitMs: 300, quietMs: 100 });
      fs.rmSync(gate);
      assert.equal((await s.wait({ kind: 'end' }, { waitMs: 20_000, from: 0 })).by, 'end');
      assert.deepEqual(missingLeaked(r.kind === 'running' ? r.command.end?.flushed : undefined), [], 'every line typed ahead came back');
      assert.deepEqual(out(s, await ran(s, 'echo AFTER')), ['AFTER']);
      assert.ok(!s.lines(0).lines.some((l) => /^LEAKED_\d+$/.test(l)));
    });

    test('a pattern wait and a watch match text a program draws on the alternate screen', async () => {
      const s = await open(shell);
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const id = s.watch(/ALT-WATCHED/, s.lines(0).to);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(`printf '\\x1b[?1049h\\x1b[HALT-READY ALT-WATCHED'; ${holdJob(gate)}; printf '\\x1b[?1049l'`, { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const w = await s.wait({ kind: 'match', pattern: /ALT-READY/ }, { waitMs: 5000, from: s.lines(0).to });
      assert.equal(w.by, 'match');
      assert.equal(w.matched?.row, 0);
      await eventually('the watch', () => events.some((e) => e.kind === 'match' && e.watch === id));
      fs.rmSync(gate);
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

    /** Starts this turn's search slice and holds the loop past its end, so a search begun later in this turn gets its one line and stops. */
    const spendSlice = (s: Session): void => {
      void s.wait({ kind: 'match', pattern: /^NEVER-MATCHED$/ }, { waitMs: 0, from: s.lines(0).to - 1 });
      const until = performance.now() + 60;
      while (performance.now() < until);
    };

    test('a pattern search stops for the turn once the turn\'s slice is spent, and a later wait finds the first line that matches', same, async () => {
      const s = await open(shell, { cols: 200 });
      const from = s.lines(0).to;
      await ran(s, backlog(), 30_000);
      spendSlice(s);
      const stopped = await s.wait({ kind: 'match', pattern: costly() }, { waitMs: 0, from });
      assert.equal(stopped.by, 'timeout');
      assert.equal(stopped.unsearchedFrom, from + 1, 'it searched one line in the spent turn');
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

    test('a pattern wait that ends before its search reaches the end says how many lines it had not searched, and from which', same, async () => {
      const s = await open(shell, { cols: 200 });
      const from = s.lines(0).to;
      await ran(s, backlog(), 30_000);
      spendSlice(s);
      const w = await s.wait({ kind: 'match', pattern: /TARGET/ }, { waitMs: 0, from });
      assert.equal(w.by, 'timeout');
      assert.equal(w.matched, undefined);
      assert.equal(w.unsearchedFrom, from + 1);
      assert.equal(w.unsearched, s.lines(from).lines.length - 1);
    });

    for (const own of [true, false]) {
      const title = own
        ? 'a watch given its command reports a match in that command\'s output before the command\'s end, though both are parsed in one turn'
        : 'a watch given no command reports its match after a command\'s end parsed in the same turn, since only the command\'s own watches search at once';
      test(title, async (t) => {
        const gate = newGate();
        const arm = path.join(tmp, `arm-${gates}`);
        const flag = path.join(tmp, `flag-${gates}`);
        const s = await open(shell, { rc: flagHook(sh.name, arm, flag) });
        fs.writeFileSync(gate, '');
        const r = await s.run(`${holdJob(gate)}; echo WATCHED-LAST; touch '${arm}'`, { waitMs: 200 });
        assert.equal(r.kind, 'running');
        const c = (r as { command: Command }).command;
        const id = own ? s.watch(/^WATCHED-LAST$/, c.from, c.id) : s.watch(/^WATCHED-LAST$/, c.from);
        const seen = eventsByTurn(s);
        fs.rmSync(gate);
        holdUntil(flag);
        await eventually('both', () => seen.events.some(({ e }) => e.kind === 'match' && e.watch === id) && seen.events.some(({ e }) => e.kind === 'ended'));
        seen.stop();
        const both = seen.events.filter(({ e }) => (e.kind === 'match' && e.watch === id) || e.kind === 'ended');
        if (both[0]!.turn !== both[1]!.turn) return t.skip('the output and the end mark were parsed in separate turns');
        assert.deepEqual(both.map(({ e }) => e.kind), own ? ['match', 'ended'] : ['ended', 'match']);
      });
    }

    test('a program whose other thread reads the terminal shows as waiting', { skip: !proc.READS_VISIBLE ? "only Linux on x64, arm64, riscv64 and loong64 shows reads" : false }, async () => {
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
      const typed = path.join(tmp, `typed-${gates}`);
      const r = s.run(`touch '${typed}'`, { waitMs: 10_000 });
      const closing = s.close({ deadline: by() });
      fs.rmSync(gate);
      assert.equal((await r).kind, 'refused');
      await closing;
      assert.equal(fs.existsSync(typed), false, 'nothing was typed: the shell, held at its prompt through the hangups, would have run it');
    });

    test('close with force ends a descendant that left the terminal with setsid', async () => {
      const logs: string[] = [];
      const s = await open(shell, { log: (l) => logs.push(l) });
      const file = path.join(tmp, `pid-${++gates}`);
      await ran(s, `sh -c 'python3 -c "import os, sys, time; os.setsid(); open(sys.argv[1], \\"w\\").write(str(os.getpid())); time.sleep(300)" "$0"; :' '${file}' & ${holdJob(file).replace('[ -e', '[ ! -s')}`);
      const pid = Number(fs.readFileSync(file, 'utf8'));
      assert.ok(pid > 0);
      try {
        const exit = await s.close({ force: true, deadline: by() });
        assert.equal(exit.unlisted, undefined, logs.join('\n'));
        await eventually('the setsid descendant is gone', () => gone(pid));
      } finally {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    });

    test('close hangs up a disowned job, which the shell no longer counts as its own', async () => {
      const logs: string[] = [];
      const s = await open(shell, { log: (l) => logs.push(l) });
      const c = await ran(s, sh.name === 'fish' ? 'sleep 300 & echo "JOB:$last_pid"; disown' : 'sleep 300 & echo "JOB:$!"; disown');
      const job = pidOf(s, c, 'JOB');
      try {
        const exit = await s.close({ deadline: by() });
        assert.equal(exit.unlisted, undefined, logs.join('\n'));
        await eventually('the disowned job is gone', () => gone(job));
      } finally {
        killPid(job);
      }
    });

    test('when close can\'t check which listed groups still hold their processes, it signals none, says what was started may live on, and logs why', { skip: process.platform !== 'darwin' ? 'the check fails only where it spawns ps' : false }, async () => {
      const logs: string[] = [];
      const s = await open(shell, { log: (l) => logs.push(l) });
      const c = await ran(s, sh.name === 'fish' ? 'sleep 300 & echo "JOB:$last_pid"; disown' : 'sleep 300 & echo "JOB:$!"; disown');
      const job = pidOf(s, c, 'JOB');
      const fake = fakePs('*stat=*) exit 2;;');
      const keep = process.env.PATH;
      try {
        process.env.PATH = `${fake}:${keep}`;
        const exit = await s.close({ deadline: by() });
        process.env.PATH = keep;
        assert.equal(exit.unlisted, true, JSON.stringify(exit));
        assert.match(logs.join('\n'), /close couldn't list which listed groups still hold a process: ps exited with status 2/);
        assert.equal(gone(job), false, 'the disowned job was left alone');
      } finally {
        process.env.PATH = keep;
        killPid(job);
      }
    });

    test('close hangs up a job whose parent exited, which no shell counts as its own', { skip: sh.name !== 'bash' ? 'close lists the same way in every shell' : false }, async () => {
      const s = await open(shell);
      const job = pidOf(s, await ran(s, `sh -c 'sleep 300 & echo "JOB:$!"'`), 'JOB');
      try {
        await s.close({ deadline: by() });
        await eventually('the job whose parent exited is gone', () => gone(job));
      } finally {
        killPid(job);
      }
    });

    test('close with force ends a job whose parent exited, which is no longer a descendant', { skip: sh.name !== 'bash' ? 'close lists the same way in every shell' : false }, async () => {
      const s = await open(shell);
      const job = pidOf(s, await ran(s, `sh -c 'sleep 300 & echo "JOB:$!"'`), 'JOB');
      try {
        await s.close({ force: true, deadline: by() });
        await eventually('the job whose parent exited is gone', () => gone(job));
      } finally {
        killPid(job);
      }
    });

    test('close hangs up a stopped, disowned job, and spares a process that left the terminal with setsid and a job started with nohup', { skip: sh.name === 'fish' ? 'the fixture is bash and zsh syntax' : false }, async () => {
      const s = await open(shell);
      const file = path.join(tmp, `pid-${++gates}`);
      await ran(s, `sh -c 'python3 -c "import os, sys, time; os.setsid(); open(sys.argv[1], \\"w\\").write(str(os.getpid())); time.sleep(300)" "$0"; :' '${file}' & ${holdJob(file).replace('[ -e', '[ ! -s')}`);
      const left = Number(fs.readFileSync(file, 'utf8'));
      const nohup = pidOf(s, await ran(s, 'nohup sleep 300 >/dev/null 2>&1 & echo "JOB:$!"'), 'JOB');
      const stopped = pidOf(s, await ran(s, 'sleep 300 & p=$!; kill -STOP $p; echo "JOB:$p"; disown'), 'JOB');
      const disowned = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"; disown'), 'JOB');
      try {
        const exit = await s.close({ deadline: by() });
        assert.equal(exit.unreached, undefined);
        // The disowned jobs were hung up in the step that hangs up the nohup job, so once they're gone it has had its hangup.
        await eventually('the disowned job is gone', () => gone(disowned));
        await eventually('the stopped, disowned job is gone', () => gone(stopped));
        assert.equal(gone(nohup), false, 'the nohup job lives on');
        assert.equal(gone(left), false, 'the process that left the terminal lives on');
      } finally {
        for (const pid of [left, nohup, stopped, disowned]) killPid(pid);
      }
    });

    test('close continues a stopped job it hangs up, which the kernel leaves stopped while its parent lives on in another group', { skip: sh.name !== 'bash' ? 'close lists the same way in every shell' : false }, async () => {
      // The parent ignores the hangup and lives on, so the child's group isn't orphaned, and the kernel neither hangs it up nor continues it.
      const script = path.join(tmp, `stopped-${++gates}.py`);
      const file = path.join(tmp, `pid-${gates}`);
      fs.writeFileSync(script, ['import os, signal, sys, time', 'pid = os.fork()', 'if pid == 0:', '    signal.signal(signal.SIGHUP, signal.SIG_DFL)', '    os.setpgid(0, 0)', '    os.kill(os.getpid(), signal.SIGSTOP)', '    time.sleep(300)', '    os._exit(0)', 'open(sys.argv[1], "w").write(str(pid))', 'time.sleep(300)', ''].join('\n'));
      const s = await open(shell);
      const parent = pidOf(s, await ran(s, `nohup python3 '${script}' '${file}' >/dev/null 2>&1 & echo "JOB:$!"`), 'JOB');
      const child = await eventually('the child wrote its pid', () => (fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8'))) || undefined);
      try {
        await eventually('the child is stopped', () => isStopped(child));
        await s.close({ deadline: by() });
        await eventually('the stopped child is gone', () => gone(child));
      } finally {
        for (const pid of [child, parent]) killPid(pid);
      }
    });

    test('a session directory close cannot remove is logged, and close still resolves with the exit', { skip: sh.name !== 'bash' ? 'close removes its directory the same way in every shell' : false }, async () => {
      const logged: string[] = [];
      const s = await open(shell, { log: (line) => logged.push(line) });
      const dir = out(s, await ran(s, 'd=$(dirname "$HISTFILE"); mkdir "$d/ro" && : > "$d/ro/f" && chmod 555 "$d/ro" && echo "DIR:$d"')).find((l) => l.startsWith('DIR:'))!.slice(4);
      assert.ok(fs.existsSync(path.join(dir, 'ro', 'f')));
      try {
        const exit = await s.close({ deadline: by() });
        assert.deepEqual(exit, exitSeen(s));
        assert.equal(logged.length, 1, JSON.stringify(logged));
        assert.match(logged[0]!, /closed, but its directory .* wasn't removed: /);
      } finally {
        fs.chmodSync(path.join(dir, 'ro'), 0o755);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('close hangs up again while the shell is there, so a shell that outlived the first hangup ends on a later one, not on the KILL', { skip: sh.name === 'fish' ? 'the trap is written with bash and zsh syntax' : false }, async () => {
      // The trap takes the first hangup, leaves a file to say so, and restores the default. Without ignoreeof, bash at its prompt exits on the trapped hangup with status 0, as at end of file.
      const s = await open(shell, { rc: "set -o ignoreeof\ntrap ': > \"$HOME/first-hangup\"; trap - HUP' HUP\n" });
      const home = lastHome();
      const exit = await s.close({ deadline: by() });
      assert.deepEqual(exit, exitSeen(s));
      assert.ok(fs.existsSync(path.join(home, 'first-hangup')), 'the shell took the first hangup and went on');
      assert.notEqual(exit.signal, 'SIGKILL', 'the shell ended on a later hangup, not on the KILL that follows a grace');
    });

    test('close of a shell that ignores the hangup KILLs the shell and hangs up its jobs, so a job that ignores the hangup too lives on, writing to the closed terminal', { skip: sh.name === 'fish' ? 'the hangup is ignored with bash and zsh syntax' : false }, async () => {
      const s = await open(shell, { rc: "trap '' HUP\n" });
      const ticks = path.join(lastHome(), 'ticks');
      // The job ignores the hangup in sh, which passes the ignore on to the sleep it runs. A zsh subshell keeps the shell's ignored HUP, but the commands it runs don't.
      const c = await ran(s, `sh -c 'trap "" HUP; while :; do echo tick; echo tick >> "$0"; sleep 0.1; done' '${ticks}' & echo "JOB:$!"`);
      const job = Number(/^JOB:(\d+)$/.exec(out(s, c).find((l) => l.startsWith('JOB:')) ?? '')?.[1]);
      assert.ok(job > 0);
      try {
        await eventually('the job ticks', () => fs.existsSync(ticks));
        const exit = await s.close({ deadline: by() });
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
      const exit = await s.close({ force: true, deadline: by() });
      assert.deepEqual(exit, exitSeen(s));
      assert.equal(exit.signal, 'SIGKILL');
      await eventually('the job is gone', () => gone(job));
    });

    test('a wait and a watch from line 0 find a match in a kept line after the earliest lines were dropped', same, async () => {
      const s = await open(shell);
      await ran(s, 'seq 1 11100; echo KEPT-TARGET', 60_000);
      assert.ok(s.lines(0).dropped > 16, 'the earliest lines were dropped');
      const w = await s.wait({ kind: 'match', pattern: /^KEPT-TARGET$/ }, { waitMs: 30_000, from: 0 });
      assert.equal(w.by, 'match');
      const events: SessionEvent[] = [];
      s.onEvent((e) => events.push(e));
      const id = s.watch(/^KEPT-TARGET$/, 0);
      await eventually('the watch', () => events.some((e) => e.kind === 'match' && e.watch === id), 30_000);
    });

    test('a line over 64 Ki characters that ends a command keeps its numbers when it freezes, so the command and the next one read their own lines', same, async () => {
      const s = await open(shell);
      const c = await ran(s, "head -c 66000 /dev/zero | tr '\\0' 0; echo", 30_000);
      const next = await ran(s, 'seq 1 200', 30_000);
      assert.equal(out(s, c).join(''), '0'.repeat(66_000));
      assert.deepEqual(out(s, next), Array.from({ length: 200 }, (_, i) => String(i + 1)));
    });

    test('an end mark that lands exactly where a line passes 64 Ki characters ends the command there', same, async () => {
      const s = await open(shell);
      const c = await ran(s, "head -c 65536 /dev/zero | tr '\\0' 0", 30_000);
      assert.equal(out(s, c).join(''), '0'.repeat(65_536));
      assert.deepEqual(out(s, await ran(s, 'echo after')), ['after']);
    });

    test('the live nonce wrapped across the screen\'s right edge never shows on the screen', async () => {
      const s = await open(shell);
      await ran(s, `printf '%95s%s\\n' '' "$__tsm_r"`);
      const rows = s.screen().rows;
      const k = rows.findIndex((r) => r.startsWith(' '.repeat(95)));
      assert.ok(k >= 0, rows.join('\n'));
      assert.equal(rows[k]!.slice(95), '[reda');
      assert.ok(rows[k + 1]!.startsWith('cted]..........'), rows[k + 1]);
    });

    test('the live nonce across the cut of a long line that freezes as it goes on never shows in the frozen lines', async () => {
      const s = await open(shell);
      const c = await ran(s, `head -c 65526 /dev/zero | tr '\\0' 1; printf %s "$__tsm_r"; head -c 70000 /dev/zero | tr '\\0' 1; echo`, 30_000);
      const text = out(s, c).join('');
      const around = s.lines(Math.max(0, c.from - 1), (c.to ?? c.from) + 1);
      const edges = `output: lines ${c.from} up to ${c.to}, ${text.length} characters; each line from ${around.from}, its length, its head and its tail:\n${around.lines.map((l, k) => `${around.from + k}: ${l.length} ${JSON.stringify(l.slice(0, 80))} … ${JSON.stringify(l.slice(-80))}`).join('\n')}`;
      assert.equal(text.length, 135_546, edges);
      assert.equal(text.slice(65_526, 65_546), '[redacted]..........', edges);
    });

    test('the live nonce whose head crosses a 64 Ki cut at the end of a freeze never shows, and no line changes as it freezes', { skip: sh.name !== 'bash' ? 'the transcript is the same in every shell' : false }, async () => {
      // At 21 columns a row ends at 65,541 = 3,121 × 21 characters: a cut at 65,536, then 5 more. The
      // nonce starts 8 characters before that row's end, so its head crosses the cut and its tail starts
      // the next row. Entering the alternate screen freezes through the row above the cursor, which is
      // that row; the rows above the screen never reach the cut before it.
      const s = await open(shell, { cols: 21 });
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(`head -c 65533 /dev/zero | tr '\\0' x; printf '%sxxxx' "$__tsm_r"; ${holdJob(gate)}; printf '\\033[?1049h\\033[?1049l'; echo`, { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const c = (r as { command: Command }).command;
      const before = await eventually(
        'the line written',
        () => {
          const l = s.lines(c.from);
          return l.lines.join('').length === 65_557 && l;
        },
        30_000,
      );
      assert.deepEqual(before.lines, [`${'x'.repeat(65_533)}[re`, 'dacted]..........xxxx']);
      fs.rmSync(gate);
      await eventually('the end', () => c.end, 30_000);
      assert.deepEqual(s.lines(before.from, before.to).lines, before.lines);
      assert.equal(out(s, c).join(''), `${'x'.repeat(65_533)}[redacted]..........xxxx`);
    });

    test('the line at the cursor is not padded to the screen\'s width once the emulator\'s rows are full', { skip: sh.name !== 'bash' ? 'the transcript is the same in every shell' : false }, async () => {
      const s = await open(shell);
      // 20,000 characters fill 200 rows at 100 columns, more than the emulator keeps. So every row it
      // still keeps, but the prompt's, goes on from the row above.
      await ran(s, "head -c 20000 /dev/zero | tr '\\0' x; echo", 30_000);
      const screen = s.screen();
      const all = s.lines(0).lines;
      assert.equal(all[all.length - 1], screen.rows[screen.cursor.row]);
    });

    test('two waits that take one command\'s end hold the same object, which counts them both', async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const c = (r as { command: Command }).command;
      const a = s.wait({ kind: 'end' }, { waitMs: 30_000, from: s.lines(0).to });
      const b = s.wait({ kind: 'end' }, { waitMs: 30_000, from: s.lines(0).to });
      fs.rmSync(gate);
      const [ea, eb] = await Promise.all([a, b]);
      assert.deepEqual([ea.by, eb.by], ['end', 'end']);
      const ta = ea.took.find((e) => e.kind === 'ended' && e.command === c);
      assert.ok(ta, JSON.stringify(ea.took));
      assert.equal(eb.took.find((e) => e.kind === 'ended' && e.command === c), ta);
      assert.equal(ta.takers, 2);
    });

    test('a wait cancelled after a command ended returns that end among what it took', async () => {
      const s = await open(shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 200 });
      assert.equal(r.kind, 'running');
      const c = (r as { command: Command }).command;
      const ac = new AbortController();
      const w = s.wait({ kind: 'match', pattern: /^NEVER-MATCHED$/ }, { waitMs: 30_000, from: s.lines(0).to, signal: ac.signal });
      fs.rmSync(gate);
      await eventually('the end', () => c.end);
      ac.abort();
      const o = await w;
      assert.equal(o.by, 'cancelled');
      assert.deepEqual(o.took.map((e) => (e.kind === 'ended' ? e.command.id : e.kind)), [c.id]);
    });

    test('a pattern wait when close begins returns that the session closed', async () => {
      const s = await open(shell);
      const w = s.wait({ kind: 'match', pattern: /^NEVER-MATCHED$/ }, { waitMs: 30_000, from: 0 });
      await s.close({ deadline: by() });
      assert.equal((await w).by, 'closed');
    });

    test('a second start mark with the live nonce during a command is counted as refused', async () => {
      const s = await open(shell);
      const c = await ran(s, sh.name === 'fish' ? "printf '\\e]133;C;%s.%s;\\a' $__tsm_c $__tsm_r" : `printf '\\033]133;C;%s.%s;\\007' "$__tsm_c" "$__tsm_r"`);
      assert.equal(c.end?.refusedMarks, 1);
    });

    test('a command leaves the shell\'s own INT handling as it was', async () => {
      const rc = sh.name === 'fish' ? '' : "trap 'echo USER_INT' INT\n";
      const s = await open(shell, { rc });
      await ran(s, 'true');
      if (sh.name === 'fish') assert.deepEqual(out(s, await ran(s, 'functions -q __tsm_noint; echo $status')), ['1']);
      else assert.match(out(s, await ran(s, sh.name === 'zsh' ? 'trap' : 'trap -p INT')).join('\n'), /echo USER_INT/);
    });

    test('in fish 4, a command given to run is in the shell\'s history', { skip: sh.name !== 'fish' ? 'fish only' : false }, async (t) => {
      if (Number(execFileSync(shell, ['-c', 'string split -f1 . -- $FISH_VERSION'], { encoding: 'utf8' }).trim()) < 4) return t.skip('fish 3 has no way to add it');
      const s = await open(shell);
      await ran(s, 'echo HISTORY-PROBE');
      assert.deepEqual(out(s, await ran(s, "history search --prefix 'echo HISTORY-PROBE' --max 1 | string collect")), ['echo HISTORY-PROBE']);
    });

    test('the oldest commands go once the kept commands\' text passes its bound', same, async () => {
      const s = await open(shell);
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) ids.push((await ran(s, `: '${'x'.repeat(2 * 1024 * 1024)}'`, 60_000)).id);
      assert.equal(s.command(ids[0]!), undefined);
      assert.ok(s.command(ids[3]!));
    });

    test('close with force reports a group its KILL did not reach', { skip: sh.name !== 'bash' || process.platform !== 'linux' ? 'bash on Linux, with a sudo that runs its command in a group of its own' : false }, async (t) => {
      try {
        execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
      } catch {
        return t.skip('sudo asks for a password here');
      }
      const s = await open(shell);
      // Its own length, so no other root sleep is taken for it.
      const length = `301.${process.pid}${++gates}`;
      await ran(s, `sudo -n sleep ${length} & echo started`);
      const pid = await eventually('the root sleep', () => {
        try {
          return Number(execFileSync('pgrep', ['-u', '0', '-f', `^sleep ${length.replace('.', '\\.')}$`], { encoding: 'utf8' }).trim().split('\n')[0]) || undefined;
        } catch {
          return undefined;
        }
      });
      try {
        const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
        if (pgid !== pid) return t.skip("this sudo doesn't run its command in a group of its own");
        const exit = await s.close({ force: true, deadline: by() });
        assert.ok(exit.unreached?.some((u) => u.pgid === pgid && u.signal === 'SIGKILL' && u.error === 'EPERM'), JSON.stringify(exit));
      } finally {
        try {
          execFileSync('sudo', ['-n', 'kill', '-9', String(pid)], { stdio: 'ignore' });
        } catch {}
      }
    });
  });
}

/** Takes the terminal out of canonical mode, as a shell's line editor does, says so, reads one line, and exits. */
const READ_LINE_RAW = "sh -c 'stty -icanon; echo RAW-READY; head -n 1 >/dev/null; stty icanon'";
/** Runs `READ_LINE_RAW` in `s` and returns once it reads with the terminal out of canonical mode. */
async function readingRaw(s: Session): Promise<void> {
  const from = s.lines(0).to - 1;
  const r = await s.run(READ_LINE_RAW, { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  const w = await s.wait({ kind: 'match', pattern: /^RAW-READY$/ }, { waitMs: 5000, from });
  assert.equal(w.by, 'match');
}
let relays = 0;
/**
 * A command that starts `shell`, with no startup files and an environment of its own, on a terminal of its own through `script`, as
 * ssh would: the session's terminal is then held by the relay, which waits in poll. Its prompt is `far> `. `env` adds variables.
 */
function relayed(shell: string, env: Record<string, string> = {}, args: string[] = []): string {
  const name = path.basename(shell);
  const argv =
    name === 'fish' ? `'${shell}' ${env.XDG_CONFIG_HOME ? '' : '--no-config '}-i -C 'function fish_prompt; echo -n "far> "; end'` : name === 'zsh' ? `'${shell}' -f -i` : name === 'bash' ? `'${shell}' --norc --noprofile -i` : `'${shell}' -i`;
  const vars = Object.entries({ HOME: lastHome(), PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', PS1: 'far> ', ...env }).map(([k, v]) => `${k}='${v}'`);
  const launcher = path.join(tmp, `far-${++relays}`);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec env -i ${vars.join(' ')} ${argv} ${args.join(' ')}\n`, { mode: 0o755 });
  return process.platform === 'darwin' ? `script -q /dev/null ${launcher}` : `script -qfc ${launcher} /dev/null`;
}

/** Starts `relayed(shell, env)` in `s` and waits for its prompt. */
async function reachFar(s: Session, shell: string, env: Record<string, string> = {}, args: string[] = []): Promise<void> {
  const from = s.lines(0).to - 1;
  const r = await s.run(relayed(shell, env, args), { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  const w = await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from });
  assert.equal(w.by, 'match', 'the far prompt is drawn');
}

/** `reachFar`, then `integrate`, which must succeed. */
async function far(s: Session, shell: string, env: Record<string, string> = {}): Promise<void> {
  await reachFar(s, shell, env);
  const r = await s.integrate({ waitMs: 10_000 });
  assert.equal(r.kind, 'integrated', JSON.stringify({ r, tail: s.lines(Math.max(0, s.lines(0).to - 30)).lines.map((l) => l.slice(0, 160)) }));
  assert.equal(r.kind === 'integrated' && r.printed, undefined, 'the shell printed nothing while it took the hooks');
}

for (const sh of shells) {
  describe(`${sh.name} given the integration through a relay`, { skip: sh.path ? false : `${sh.name} is not installed` }, () => {
    const shell = sh.path!;

    test('run there has statuses, the pipeline\'s and the directory; once it exits, the session\'s own shell is in front, as before', async () => {
      const s = await open(shell);
      const home = s.cwd();
      await reachFar(s, shell);
      const r = await s.integrate({ waitMs: 10_000 });
      assert.equal(r.kind, 'integrated', JSON.stringify(r));
      assert.equal(r.kind === 'integrated' && r.shell, sh.name);
      assert.equal(r.kind === 'integrated' && r.printed, undefined, JSON.stringify(r));
      assert.equal(r.front.state, 'prompt');
      assert.match((r.front.state === 'prompt' && r.front.within?.argv) || '', /script/);
      const cd = await ran(s, 'cd /');
      assert.equal(cd.end?.status, 0);
      assert.equal(s.cwd(), '/');
      const p = await ran(s, 'false | sh -c "exit 3"');
      assert.equal(p.end?.status, 3);
      assert.deepEqual(p.end?.pipeline, [1, 3]);
      const t = await ran(s, "printf '%s|%s|%s|%s|%s\\n' 'a!b' '~x' 'tab\there' \"it's\" 'back\\slash é'\necho two");
      // The terminal draws the tab as spaces. It reached the shell as a tab, not as a key that completes.
      assert.match(out(s, t).join('\n'), /^a!b\|~x\|tab +here\|it's\|back\\slash é\ntwo$/);
      const e = await s.run('exit', { waitMs: 10_000 });
      assert.equal(e.kind, 'ended', JSON.stringify(e));
      // fish runs its postexec handlers for exit, so its end mark comes; bash and zsh exit first, and the command ends with no status.
      assert.equal(e.kind === 'ended' ? e.command.end?.status : 'x', sh.name === 'fish' ? 0 : undefined);
      if (sh.name !== 'fish') assert.equal(e.kind === 'ended' ? e.command.end?.unfollowed?.how : 'x', 'ended', JSON.stringify(e));
      await s.wait({ kind: 'end' }, { waitMs: 10_000, from: 0 });
      const f = s.front();
      assert.equal(f.state, 'prompt');
      assert.equal(f.state === 'prompt' ? f.within : 'x', undefined);
      assert.equal(s.cwd(), home);
      assert.deepEqual(out(s, await ran(s, 'echo home')), ['home']);
    });

    test('of what the session types, only the probe line, and in zsh the line that turns saving off, reach a history file the far shell saves as it goes', async (t) => {
      const s = await open(shell);
      const home = lastHome();
      const file = sh.name === 'fish' ? path.join(home, 'far-data', 'fish', 'fish_history') : path.join(home, 'far-history');
      // This fish starts with an empty configuration directory, rather than --no-config, as a user's starts with theirs.
      const env: Record<string, string> = sh.name === 'fish' ? { XDG_DATA_HOME: path.join(home, 'far-data'), XDG_CONFIG_HOME: path.join(home, 'far-config') } : sh.name === 'bash' ? { HISTFILE: file, PROMPT_COMMAND: 'history -w' } : { HISTFILE: file, SAVEHIST: '1000', HISTSIZE: '1000' };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // As in `open`: fish 3 looks for this directory under its data directory.
      if (sh.name === 'fish') fs.mkdirSync(path.join(home, 'far-data', 'fish', 'generated_completions'));
      fs.writeFileSync(file, '');
      await reachFar(s, shell, env, sh.name === 'zsh' ? ['-o', 'incappendhistory'] : []);
      const typed = await s.send('echo before-integrate\r', { waitMs: 5000, until: /^before-integrate$/ });
      assert.equal(typed.by, 'match');
      await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 5000, from: typed.matched!.line });
      // fish writes its history file at exit, or when asked.
      if (sh.name === 'fish') await s.send('history save\r', { waitMs: 5000, quietMs: 300 });
      await eventually('the far shell saves what was typed before', () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('before-integrate'));
      const r = await s.integrate({ waitMs: 10_000 });
      assert.equal(r.kind, 'integrated', JSON.stringify(r));
      assert.deepEqual(out(s, await ran(s, 'echo after-integrate')), ['after-integrate']);
      await s.run('exit', { waitMs: 10_000 });
      await s.wait({ kind: 'end' }, { waitMs: 10_000, from: 0 });
      const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      t.diagnostic(`saved: ${JSON.stringify(saved)}`);
      assert.match(saved, /before-integrate/, 'the far shell saved what was typed before');
      // What may be there is plumbing with no nonce: the probe line, and in zsh, which saves a line as it's entered, the line
      // that turns saving off.
      assert.doesNotMatch(saved, /after-integrate|__tsm|\d{20}/, saved);
      const after = saved.slice(saved.indexOf('before-integrate'));
      assert.ok(after.split('\n').filter((l) => /\b(printf|HISTFILE|fish_history)\b/.test(l)).length <= 2, saved);
    });

    test('a far command reads as running, never waiting; stop types only C-c there, and a signal is refused', async () => {
      const s = await open(shell);
      await far(s, shell);
      const waits: SessionEvent[] = [];
      const off = s.onEvent((e) => e.kind === 'waiting' && waits.push(e));
      const r = await s.run('read x', { waitMs: 1500 });
      assert.equal(r.kind, 'running');
      const f = s.front();
      assert.equal(f.state, 'running');
      assert.ok(f.state === 'running' && f.within && !f.waitVisible, JSON.stringify(f));
      const refused = await s.stop('SIGTERM');
      assert.deepEqual([refused.within, refused.steps.length, refused.front.state], [true, 0, 'running']);
      const st = await s.stop();
      assert.deepEqual(st.steps.map((x) => x.sent), ['C-c']);
      assert.equal(st.within, true);
      assert.equal(st.front.state, 'prompt');
      off();
      assert.deepEqual(waits, []);
      const c = s.command(r.kind === 'running' ? r.command.id : -1);
      assert.notEqual(c?.end?.status, 0);
    });

    test('text sent during a far command that never reads it comes back as flushed, and doesn\'t run', async () => {
      const s = await open(shell);
      await far(s, shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 300 });
      assert.equal(r.kind, 'running');
      await s.send('echo SHOULD_NOT_RUN\r', { waitMs: 1000, quietMs: 200 });
      fs.rmSync(gate);
      const w = await s.wait({ kind: 'end' }, { waitMs: 10_000, from: 0 });
      assert.equal(w.by, 'end');
      const c = s.command(r.kind === 'running' ? r.command.id : -1)!;
      assert.match(c.end?.flushed ?? '', /echo SHOULD_NOT_RUN/);
      const after = await ran(s, 'echo after');
      assert.ok(!s.lines(c.from, after.to).lines.includes('SHOULD_NOT_RUN'), JSON.stringify(s.lines(c.from, after.to).lines));
    });

    test('text typed ahead of a far command, within what the far terminal holds at once, comes back whole, and none of it runs', async () => {
      const s = await open(shell);
      await far(s, shell);
      const gate = newGate();
      fs.writeFileSync(gate, '');
      const r = await s.run(holdJob(gate), { waitMs: 300 });
      assert.equal(r.kind, 'running');
      // Under 1 KiB, macOS's MAX_INPUT, so every line fits in what the far terminal holds at once, and echoes while the job holds.
      const typed = Array.from({ length: 50 }, (_, i) => `echo LEAKED_${i}\r`).join('');
      assert.ok(typed.length < 1024);
      assert.equal((await s.send(typed, { waitMs: 10_000, until: /^echo LEAKED_49$/ })).by, 'match');
      fs.rmSync(gate);
      assert.equal((await s.wait({ kind: 'end' }, { waitMs: 20_000, from: 0 })).by, 'end');
      const c = s.command(r.kind === 'running' ? r.command.id : -1);
      assert.deepEqual(missingLeaked(c?.end?.flushed, 50), [], JSON.stringify({ end: { ...c?.end, flushed: c?.end?.flushed?.length }, front: s.front() }));
      assert.deepEqual(out(s, await ran(s, 'echo AFTER')), ['AFTER']);
      assert.ok(!s.lines(0).lines.some((l) => /^LEAKED_\d+$/.test(l)));
    });

    test('integrate is refused at a prompt with the integration, the session\'s own or a far one, and shows no nonce', async () => {
      const s = await open(shell);
      assert.equal((await s.integrate({ waitMs: 2000 })).kind, 'refused');
      await far(s, shell);
      assert.equal((await s.integrate({ waitMs: 2000 })).kind, 'refused');
      assert.ok(!/\d{20}/.test(s.lines(0).lines.join('\n')), 'no nonce in the transcript');
    });

    test('integrate is refused from an end mark on, while a prompt hook holds the prompt, and types nothing', async () => {
      const gate = newGate();
      const s = await open(shell, { rc: gateHook(sh.name, gate) });
      await heldAfter(s, gate, 'true', 'run');
      const r = await s.integrate({ waitMs: 2000 });
      assert.equal(r.kind, 'refused', JSON.stringify(r));
      assert.equal(r.kind === 'refused' && r.sent, undefined);
      fs.rmSync(gate);
      assert.deepEqual(out(s, await ran(s, 'echo home')), ['home']);
    });

    test('integrate is refused, saying so, while a line sent at the prompt hasn\'t started, and types nothing', async () => {
      const s = await open(shell);
      // A trailing backslash continues the line, so the shell has it and nothing has started.
      await s.send('echo un\\\r', { waitMs: 2000, quietMs: 200 });
      const r = await s.integrate({ waitMs: 2000 });
      assert.deepEqual([r.kind, r.kind === 'refused' && r.sent], ['refused', true], JSON.stringify(r));
      const done = await s.send('finished\r', { waitMs: 5000, until: /^unfinished$/ });
      assert.equal(done.by, 'match', JSON.stringify(done.lines));
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.deepEqual(out(s, await ran(s, 'echo home')), ['home']);
    });

    test('integrate is refused, saying so, while what is in front reads whole lines, and types nothing', async () => {
      const s = await open(shell);
      const r0 = await s.run('head -n 1', { waitMs: 200 });
      assert.equal(r0.kind, 'running', JSON.stringify(r0));
      await inFront(s, /head/);
      const r = await s.integrate({ waitMs: 2000 });
      assert.deepEqual([r.kind, r.kind === 'refused' && r.canonical], ['refused', true], JSON.stringify(r));
      await s.send('typed-after\r', { waitMs: 5000, quietMs: 200 });
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      const o = out(s, s.command(r0.kind === 'running' ? r0.command.id : -1)!);
      assert.ok(o.includes('typed-after') && !o.some((l) => l.includes('printf')), JSON.stringify(o));
    });

    test('a probe line typed into a program that reads it and ends stops the call at once, by exited', async () => {
      const s = await open(shell);
      await readingRaw(s);
      const r = await s.integrate({ waitMs: 10_000 });
      assert.deepEqual(r.kind === 'incomplete' && [r.step, r.by], ['probe', 'exited'], JSON.stringify(r));
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      assert.deepEqual(out(s, await ran(s, 'echo home')), ['home']);
    });

    test('a second integrate while one is typing is refused, saying so, and the first still integrates', async () => {
      const s = await open(shell);
      await reachFar(s, shell);
      const first = s.integrate({ waitMs: 10_000 });
      const second = await s.integrate({ waitMs: 2000 });
      assert.deepEqual([second.kind, second.kind === 'refused' && second.integrating], ['refused', true], JSON.stringify(second));
      const r = await first;
      assert.equal(r.kind, 'integrated', JSON.stringify(r));
      assert.equal(r.kind === 'integrated' && r.printed, undefined);
      assert.deepEqual(out(s, await ran(s, 'echo far')), ['far']);
    });

    test('an end mark with the lower chain\'s nonce and a wrong next counter is refused, and the far chain stays in front', async () => {
      const s = await open(shell);
      await far(s, shell);
      const lower = (s as unknown as { chains: Array<{ expected: { counter: number; random: string } }> }).chains[0]!.expected;
      const c = await ran(s, `printf '\\033]133;D;%s;%s;0;;;\\007' '${lower.counter}.${lower.random}' '${lower.counter + 5}.1'`);
      assert.equal(c.end?.refusedMarks, 1, JSON.stringify(c.end));
      const f = s.front();
      assert.ok(f.state === 'prompt' && f.within !== undefined, JSON.stringify(f));
      assert.deepEqual(out(s, await ran(s, 'echo still-far')), ['still-far']);
    });

    test('a run whose typed line would be longer than a far shell takes is refused, naming the limit', async () => {
      const s = await open(shell);
      await far(s, shell);
      const r = await s.run(`echo ${'x'.repeat(8192)}`, { waitMs: 2000 });
      assert.equal(r.kind, 'refused');
      const tooLong = r.kind === 'refused' ? r.tooLong : undefined;
      assert.equal(tooLong?.max, 8192);
      assert.ok(tooLong && tooLong.typed > 8192, JSON.stringify(tooLong));
      const ok = await ran(s, `echo ${'y'.repeat(7000)} | wc -c`, 20_000);
      assert.equal(out(s, ok).at(-1)?.trim(), '7001');
    });

    test('a second relay from the far shell takes the integration on top; when the first relay ends, both are gone', async () => {
      const s = await open(shell);
      await far(s, shell);
      const outer = s.front();
      assert.equal(outer.state, 'prompt');
      await far(s, shell);
      assert.deepEqual(out(s, await ran(s, 'echo deep')), ['deep']);
      const hold = await s.run('sleep 300', { waitMs: 300 });
      assert.equal(hold.kind, 'running');
      const relay = outer.state === 'prompt' ? outer.within!.pgid : 0;
      // TERM, as a dropped connection ends ssh. util-linux's script then puts the terminal back as it found it; BSD's leaves it
      // without output processing, so a newline there moves down without returning, and a line of spaces can follow.
      process.kill(-relay, 'SIGTERM');
      await s.wait({ kind: 'end' }, { waitMs: 10_000, from: 0 });
      const f = s.front();
      assert.equal(f.state, 'prompt');
      assert.equal(f.state === 'prompt' ? f.within : 'x', undefined);
      const c = s.command(hold.kind === 'running' ? hold.command.id : -1);
      assert.equal(c?.end?.status, undefined);
      assert.ok(c?.end, 'the far command ended with no status');
      assert.deepEqual(out(s, await ran(s, 'echo home')).filter((l) => l.trim()), ['home']);
    });

    test('a wait that runs out types nothing more: a probe that answers late changes nothing, and a new call integrates', async () => {
      const s = await open(shell);
      await reachFar(s, shell);
      const r = await s.integrate({ waitMs: 0 });
      assert.deepEqual(r.kind === 'incomplete' && [r.step, r.by], ['probe', 'timeout']);
      const from = s.lines(0).to - 1;
      const w = await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from });
      assert.equal(w.by, 'match', 'the probe line ran');
      // The call has returned, so nothing more is typed for it. A line typed now comes after anything the session typed before.
      const marker = await s.send('echo AFTER-PROBE\r', { waitMs: 5000, until: /^AFTER-PROBE$/ });
      assert.equal(marker.by, 'match');
      assert.ok(!s.lines(from).lines.some((l) => l.includes('eval')), 'no hooks were typed');
      assert.equal(s.front().state, 'running');
      assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
    });

    test('hooks whose prompt is drawn after the wait ran out still give the shell the integration', { skip: sh.name !== 'bash' ? 'the held prompt is a PROMPT_COMMAND' : false }, async () => {
      const s = await open(shell);
      const gate = newGate();
      // The prompt holds only once the hooks ran, so their prompt is what's late.
      await reachFar(s, shell, { PROMPT_COMMAND: `[ -z "\${__tsm_c-}" ] || while [ -e ${gate} ]; do sleep 0.05; done` });
      fs.writeFileSync(gate, '');
      const r = await s.integrate({ waitMs: 1500 });
      assert.deepEqual(r.kind === 'incomplete' && [r.step, r.by], ['hooks', 'timeout'], JSON.stringify(r));
      fs.rmSync(gate);
      await eventually('the far prompt with the integration', () => {
        const f = s.front();
        return f.state === 'prompt' && f.within !== undefined;
      });
      assert.deepEqual(out(s, await ran(s, 'echo late')), ['late']);
    });

    test('a far shell that ends while the hooks go in stops the call at once, by exited', { skip: sh.name !== 'bash' ? 'the far shell ends from a PROMPT_COMMAND' : false }, async () => {
      const s = await open(shell);
      // After the probe line runs, the far prompt hook reads the next line, the first of the hooks, and exits.
      await reachFar(s, shell, { PROMPT_COMMAND: 'if [ -n "${__n-}" ]; then read -r __x; exit; fi; __n=1' });
      const r = await s.integrate({ waitMs: 10_000 });
      assert.deepEqual(r.kind === 'incomplete' && [r.step, r.by], ['hooks', 'exited'], JSON.stringify(r));
      await s.wait({ kind: 'end' }, { waitMs: 5000, from: 0 });
      const f = s.front();
      assert.equal(f.state === 'prompt' ? f.within : 'x', undefined, JSON.stringify(f));
      assert.deepEqual(out(s, await ran(s, 'echo home')), ['home']);
    });

    test('what a far shell prints while it takes the hooks comes back as printed: from the last typed line\'s run to its end mark', { skip: sh.name !== 'bash' ? 'xtrace is turned on through SHELLOPTS' : false }, async () => {
      const s = await open(shell);
      await reachFar(s, shell, { SHELLOPTS: 'xtrace' });
      const r = await s.integrate({ waitMs: 10_000 });
      assert.equal(r.kind, 'integrated', JSON.stringify(r));
      const printed = r.kind === 'integrated' ? (r.printed ?? []) : [];
      const show = JSON.stringify(printed.map((l) => l.slice(0, 120)));
      assert.ok(printed.some((l) => /^\++ eval /.test(l)), show);
      assert.ok(printed.some((l) => /^\++ unset __tsm_h$/.test(l)), show);
      assert.ok(!printed.some((l) => /133;P;/.test(l)), `the last line's own trace is before its mark: ${show}`);
      assert.ok(!printed.some((l) => /^\++ __tsm_tail$/.test(l) || l.startsWith('far>')), `nothing after the end mark: ${show}`);
      assert.ok(!/\d{20}/.test(printed.join('\n')), 'no nonce');
    });
  });
}

test('a shell that node-pty cannot spawn is refused with its reason, one sentence and one period', { skip: process.platform !== 'darwin' ? 'only macOS spawns through posix_spawn, which an environment past ARG_MAX fails' : false }, async () => {
  const home = path.join(tmp, `home-${++homes}`);
  fs.mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8', BIG: 'x'.repeat(2_000_000) };
  await assert.rejects(openSession({ name: 'unspawnable', shell: which('bash') ?? '/bin/bash', cwd: home, cols: 80, rows: 24, env, parent: tmp, nextCommandId: () => ++ids, waitMs: 10_000 }), (e: Error & { code?: string }) => {
    assert.equal(e.code, 'backend_failure');
    assert.match(e.message, /^the shell could not start: posix_spawnp failed\. If that error passes/);
    return true;
  });
});

test("an open whose integration files can't be written leaves no directory behind", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const home = path.join(tmp, `home-${++homes}`);
  const parent = path.join(tmp, `parent-${++homes}`);
  fs.mkdirSync(home);
  fs.mkdirSync(parent);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
  const real = fs.writeFileSync;
  const patched = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.startsWith(parent)) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${p}'`), { code: 'ENOSPC' });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.writeFileSync;
  const fsModule = (await import('node:fs')).default;
  fsModule.writeFileSync = patched;
  syncBuiltinESMExports();
  try {
    await assert.rejects(openSession({ name: 'unwritable', shell: which('bash')!, cwd: home, cols: 80, rows: 24, env, parent, nextCommandId: () => ++ids, waitMs: 10_000 }), /ENOSPC/);
  } finally {
    fsModule.writeFileSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a probe line typed into a program a shell without integration started, which reads it and ends, stops the call by exited', async () => {
  const s = await open('/bin/sh');
  await readingRaw(s);
  const r = await s.integrate({ waitMs: 10_000 });
  assert.deepEqual(r.kind === 'incomplete' && [r.step, r.by], ['probe', 'exited'], JSON.stringify(r));
});

test('a signal that aborts while opening waits for the first prompt ends that wait', async () => {
  const started = path.join(tmp, `started-${++gates}`);
  const gate = path.join(tmp, `gate-${++gates}`);
  const stop = new AbortController();
  const opening = open(which('bash') ?? '/bin/bash', { rc: `: > '${started}'\nwhile [ ! -e '${gate}' ]; do sleep 0.05; done\n`, waitMs: 300_000, signal: stop.signal });
  try {
    await eventually('the startup file is running', () => fs.existsSync(started));
    stop.abort();
    const ended = await Promise.race([opening.then(() => 'opened'), new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 20_000))]);
    assert.equal(ended, 'opened');
    assert.notEqual((await opening).front().state, 'prompt');
  } finally {
    fs.writeFileSync(gate, '');
    await opening;
  }
});

const darwinOnly = { skip: process.platform !== 'darwin' ? 'only macOS spawns ps to list' : false };

test('while close waits on a listing, another session runs', darwinOnly, async () => {
  const logs: string[] = [];
  const bash = which('bash') ?? '/bin/bash';
  const s = await open(bash, { log: (l) => logs.push(l) });
  const other = await open(bash);
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"'), 'JOB');
  const gate = path.join(tmp, `gate-${++gates}`);
  const held = path.join(tmp, `held-${++gates}`);
  const fake = fakePs(`*"-t "*) : > '${held}'; while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    let settled = false;
    const closing = s.close({ force: true, deadline: by() }).finally(() => (settled = true));
    await eventually('the close is held at its listing', () => fs.existsSync(held));
    assert.deepEqual(out(other, await ran(other, 'echo other-ran')), ['other-ran']);
    assert.equal(settled, false, 'close was still waiting on its listing');
    fs.writeFileSync(gate, '');
    const exit = await closing;
    process.env.PATH = keep;
    assert.equal(exit.unlisted, undefined, logs.join('\n'));
    await eventually('the job is gone', () => gone(job));
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
    killPid(job);
  }
});

test('close with a deadline already past runs no listing, says what it started may live on, and still ends the shell', darwinOnly, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"; disown'), 'JOB');
  const record = path.join(tmp, `ps-calls-${++gates}`);
  const fake = fakePs(`*) echo "$*" >> '${record}';;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const exit = await s.close({ deadline: performance.now() - 1 });
    process.env.PATH = keep;
    const calls = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '';
    assert.doesNotMatch(calls, /-t |stat=/, calls);
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), /close couldn't list the processes on the terminal: no time was left before the deadline/);
    await eventually('the shell is gone', () => gone(s.pid));
  } finally {
    process.env.PATH = keep;
    killPid(job);
  }
});

test('close that runs out of time while ps lists logs how long ps had', darwinOnly, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"'), 'JOB');
  const reached = path.join(tmp, `reached-${++gates}`);
  const fake = fakePs(`*"-t "*) : > '${reached}'; exec sleep 300;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const exit = await s.close({ force: true, deadline: by(3000) });
    process.env.PATH = keep;
    assert.ok(fs.existsSync(reached), 'the ps that never answers was reached');
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), /close couldn't list the processes on the terminal: ps took longer than \d+ ms/);
  } finally {
    process.env.PATH = keep;
    killPid(job);
  }
});

test('close returns at its deadline though the ps it waits on outlives the signal that ends its time', darwinOnly, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"'), 'JOB');
  const held = path.join(tmp, `held-${++gates}`);
  const fake = fakePs(`*"-t "*) trap '' TERM; sleep 300 & echo $! > '${held}'; wait;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const closing = s.close({ force: true, deadline: by(3000) });
    const ended = await Promise.race([closing.then(() => 'closed'), new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 20_000))]);
    process.env.PATH = keep;
    assert.equal(ended, 'closed');
    assert.ok(fs.existsSync(held), 'the ps that outlives TERM was reached and started its child');
    const exit = await closing;
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), /close couldn't list the processes on the terminal: ps took longer than \d+ ms/);
  } finally {
    process.env.PATH = keep;
    if (fs.existsSync(held)) killPid(Number(fs.readFileSync(held, 'utf8')));
    killPid(job);
  }
});

test('close of a shell that had already exited says what it left running may live on', async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const r = await s.run('sleep 300 & echo "JOB:$!"; disown; exit', { waitMs: 10_000 });
  assert.notEqual(r.kind, 'refused', JSON.stringify(r));
  await eventually('the shell exited', () => s.front().state === 'exited');
  const job = Number(/JOB:(\d+)/.exec(s.lines(0).lines.join('\n'))?.[1]);
  try {
    const exit = await s.close({ deadline: by() });
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), /the shell had already exited/);
  } finally {
    if (job > 0) killPid(job);
  }
});

test("a scan of the terminal's processes that doesn't find the shell fails close's listing, since a shell that exited mid-scan took the terminal from the rest", { skip: process.platform !== 'linux' ? 'only Linux scans /proc' : false }, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const real = fs.readdirSync;
  // The scan sees every process but the shell, as when the shell exits once its terminal was read.
  const patched = ((p: fs.PathLike, ...rest: unknown[]) => {
    const out = (real as (...a: unknown[]) => unknown)(p, ...rest);
    return p === '/proc' ? (out as string[]).filter((d) => d !== String(s.pid)) : out;
  }) as typeof fs.readdirSync;
  const fsModule = (await import('node:fs')).default;
  fsModule.readdirSync = patched;
  syncBuiltinESMExports();
  try {
    const exit = await s.close({ deadline: by() });
    fsModule.readdirSync = real;
    syncBuiltinESMExports();
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), /the processes on the terminal: the shell itself wasn't among them/);
  } finally {
    fsModule.readdirSync = real;
    syncBuiltinESMExports();
  }
});

test("a /proc read that fails for a reason other than the process being gone fails close's listing, rather than leaving that process out", { skip: process.platform !== 'linux' ? 'only Linux lists from /proc' : false }, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"; disown'), 'JOB');
  const hidden = `/proc/${job}/stat`;
  const real = fs.readFileSync;
  const patched = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (p === hidden) throw Object.assign(new Error(`EACCES: permission denied, open '${hidden}'`), { code: 'EACCES' });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync;
  const fsModule = (await import('node:fs')).default;
  fsModule.readFileSync = patched;
  syncBuiltinESMExports();
  try {
    const exit = await s.close({ deadline: by() });
    fsModule.readFileSync = real;
    syncBuiltinESMExports();
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), new RegExp(`/proc/${job}/stat couldn't be read: EACCES`));
  } finally {
    fsModule.readFileSync = real;
    syncBuiltinESMExports();
    killPid(job);
  }
});

test('a write to the terminal that throws leaves no call open behind it', async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const pty = (s as unknown as { p: { write: (d: string) => void } }).p;
  const write = pty.write;
  pty.write = () => {
    throw new Error('EIO');
  };
  try {
    await assert.rejects(s.run('echo x', { waitMs: 1000 }), /EIO/);
    await assert.rejects(s.send('x', { waitMs: 1000 }), /EIO/);
  } finally {
    pty.write = write;
  }
  assert.equal((s as unknown as { calls: Set<unknown> }).calls.size, 0);
  await s.close({ force: true, deadline: by() });
});

test('a line break inside a paste at a prompt is held for editing, so the shell is still at its prompt', async (t) => {
  const s = await open(which('bash') ?? '/bin/bash');
  const r = await s.send('echo one\necho two', { waitMs: 3000, paste: true });
  if (!r.sent && r.by === 'paste_off') {
    await s.close({ force: true, deadline: by() });
    return t.skip("this bash's line editor doesn't turn bracketed paste on");
  }
  assert.equal(r.sent, true, JSON.stringify(r));
  const f = s.front();
  assert.equal(f.state, 'prompt', JSON.stringify(f));
  assert.equal((await s.run('echo x', { waitMs: 1000 })).kind, 'refused', 'the pasted text is pending at the prompt');
  await s.close({ force: true, deadline: by() });
});

test("a shell that exits with the alternate screen up keeps that screen in its last command's output", async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  // The command line holds "ALT SHOWN"; only the screen it draws holds "ALT-SHOWN".
  const r = await s.run(`printf '\\033[?1049h\\033[H%s-%s\\n' ALT SHOWN; exit 3`, { waitMs: 10_000 });
  await eventually('the shell exited', () => s.front().state === 'exited');
  const c = s.command(r.kind === 'refused' ? -1 : r.command.id);
  assert.ok(c?.end, JSON.stringify(r));
  assert.ok(s.lines(c.from, c.to).lines.some((l) => l.includes('ALT-SHOWN')), JSON.stringify(s.lines(0).lines));
  await s.close({ force: true, deadline: by() });
});

test('a ps that exits 1 with a message is a failed check, not a listing of nothing, so close signals none and says so', darwinOnly, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"; disown'), 'JOB');
  const fake = fakePs(`*stat=*) echo 'ps: cannot read the process table' >&2; exit 1;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const exit = await s.close({ deadline: by() });
    process.env.PATH = keep;
    assert.equal(exit.unlisted, true, JSON.stringify(exit));
    assert.match(logs.join('\n'), /ps exited with status 1: ps: cannot read the process table/);
    assert.equal(gone(job), false, 'the disowned job was left alone');
  } finally {
    process.env.PATH = keep;
    killPid(job);
  }
});

test('a synchronous ps that ignores TERM is killed at its timeout, so front returns without waiting for it', darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const finished = path.join(tmp, `finished-${++gates}`);
  // Twenty seconds of a loop that ignores TERM, then a mark that it ran to its end. KILL ends it before the mark.
  const started = path.join(tmp, `started-${++gates}`);
  const fake = fakePs(`*tpgid=*) : > '${started}'; trap '' TERM; i=0; while [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done; : > '${finished}'; exit 1;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const f = s.front();
    process.env.PATH = keep;
    assert.equal(fs.existsSync(started), true, 'front ran the ps that ignores TERM');
    assert.equal(f.state, 'unknown');
    assert.equal(fs.existsSync(finished), false, 'front returned before the ps that ignores TERM ran to its end');
  } finally {
    process.env.PATH = keep;
    await s.close({ force: true, deadline: by() });
  }
});

test('stop sends nothing more once a close has begun', darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const r = await s.run(`sh -c "trap '' INT; sleep 300"`, { waitMs: 300 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  await eventually('the job in front', () => {
    const now = s.front();
    return now.state === 'running' && !now.process.shell && now;
  });
  const gate = path.join(tmp, `gate-${++gates}`);
  const fake = fakePs(`*"-t "*) while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    // stop types C-c before its first wait, which the job ignores; close then holds at its listing, with the shell still up.
    const stopping = s.stop();
    const closing = s.close({ deadline: by() });
    const stopped = await stopping;
    assert.deepEqual(stopped.steps.map((x) => x.sent), ['C-c']);
    fs.writeFileSync(gate, '');
    await closing;
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
  }
});

test('a second close waits for the first, which hangs up what it listed once the shell is gone', darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const job = pidOf(s, await ran(s, 'sleep 300 & echo "JOB:$!"; disown'), 'JOB');
  const gate = path.join(tmp, `gate-${++gates}`);
  const held = path.join(tmp, `held-${++gates}`);
  const fake = fakePs(`*stat=*) : > '${held}'; while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const first = s.close({ deadline: by() });
    await eventually('the check before the hangup is held, after the shell has gone', () => fs.existsSync(held));
    let firstDone = false;
    void first.then(() => (firstDone = true));
    // A close that joins settles with the first, after the callback above; one that didn't would settle on its own.
    const second = s.close({ deadline: by() }).then(() => firstDone);
    fs.writeFileSync(gate, '');
    assert.equal(await second, true, 'the second close returned only once the first had');
    await first;
    process.env.PATH = keep;
    await eventually('the disowned job is gone', () => gone(job));
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
    killPid(job);
  }
});

test("a stop whose signal was withheld doesn't mark the job stopped when something else stops it later", darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const flag = path.join(tmp, `fails-${++gates}`);
  // Only the whole-table listing fails, so the job's group can't be confirmed as the shell's, and the signal is withheld.
  const fake = fakePs(`*"-A "*) [ -e '${flag}' ] && { echo 'ps: listing failed' >&2; exit 1; };;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const r = await s.run('sleep 30', { waitMs: 200 });
    assert.equal(r.kind, 'running', JSON.stringify(r));
    await inFront(s, /sleep 30/);
    const f = s.front();
    const pgid = f.state === 'running' ? f.process.pgid : 0;
    fs.writeFileSync(flag, '');
    const o = await s.stop('SIGTSTP');
    assert.deepEqual(o.steps.map((x) => [x.sent, x.withheld]), [['SIGTSTP', true]], JSON.stringify(o));
    fs.rmSync(flag, { force: true });
    // Something other than stop suspends the job, and the shell reports it.
    process.kill(-pgid, 'SIGTSTP');
    const c = s.command(r.kind === 'running' ? r.command.id : -1);
    await eventually('the command ended', () => c?.end);
    assert.deepEqual([c?.end?.stopped, c?.end?.stoppedUnknown], [undefined, undefined], JSON.stringify(c?.end));
  } finally {
    process.env.PATH = keep;
    fs.rmSync(flag, { force: true });
    await s.close({ force: true, deadline: by() });
  }
});

test("a suspend signal whose stopped check can't be read leaves whether the job stopped unknown, not an exit status", darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const flag = path.join(tmp, `fails-${++gates}`);
  // Only the reading of each process's state fails, so stop still finds the job's group and signals it.
  const fake = fakePs(`*stat=*) [ -e '${flag}' ] && { echo 'ps: state reading failed' >&2; exit 1; };;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const r = await s.run('sleep 30', { waitMs: 200 });
    assert.equal(r.kind, 'running', JSON.stringify(r));
    await inFront(s, /sleep 30/);
    fs.writeFileSync(flag, '');
    const o = await s.stop('SIGTSTP');
    assert.equal(o.steps[0]?.sent, 'SIGTSTP', JSON.stringify(o));
    const c = s.command(r.kind === 'running' ? r.command.id : -1);
    await eventually('the command ended', () => c?.end);
    assert.deepEqual([c?.end?.stopped, c?.end?.stoppedUnknown], [undefined, true], JSON.stringify(c?.end));
  } finally {
    process.env.PATH = keep;
    fs.rmSync(flag, { force: true });
    await s.close({ force: true, deadline: by() });
  }
});

/** A job of its own group that ignores the hangup, as nohup's do, with its pid. */
const hupProof = async (s: Session): Promise<number> => pidOf(s, await ran(s, `sh -c 'trap "" HUP; while :; do sleep 1; done' & echo "JOB:$!"`), 'JOB');

test('a close with force that joins a gentle close held at its listing makes it forced, so a job that ignores the hangup is KILLed', darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const job = await hupProof(s);
  const gate = path.join(tmp, `gate-${++gates}`);
  const held = path.join(tmp, `held-${++gates}`);
  const fake = fakePs(`*"-t "*) : > '${held}'; while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const first = s.close({ deadline: by() });
    await eventually('the gentle close is held at its listing', () => fs.existsSync(held));
    const second = s.close({ force: true, deadline: by() });
    fs.writeFileSync(gate, '');
    const [a] = await Promise.all([first, second]);
    process.env.PATH = keep;
    assert.equal(a.signal, 'SIGKILL', JSON.stringify(a));
    await eventually('the job that ignores the hangup is gone', () => gone(job));
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
    killPid(job);
  }
});

test('a close with force that joins a gentle close after its hangup went out still KILLs what it listed', darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const job = await hupProof(s);
  // The shell ignores the hangup too, so the gentle close goes on resending it through its grace.
  await ran(s, "trap '' HUP");
  try {
    const first = s.close({ deadline: by() });
    await eventually('the hangup went out', () => (s as unknown as { sentShell?: string }).sentShell === 'SIGHUP');
    const second = s.close({ force: true, deadline: by() });
    await Promise.all([first, second]);
    await eventually('the job that ignores the hangup is gone', () => gone(job));
  } finally {
    killPid(job);
  }
});

test('a close with force that joins a gentle close held at its last listing makes that last step KILL, so a job that ignores the hangup is gone', darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const job = await hupProof(s);
  const gate = path.join(tmp, `gate-${++gates}`);
  const held = path.join(tmp, `held-${++gates}`);
  // Only the last step's check of which listed groups still hold a process asks ps for states.
  const fake = fakePs(`*"stat="*) : > '${held}'; while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const first = s.close({ deadline: by() });
    await eventually('the gentle close is held at its last listing', () => fs.existsSync(held));
    const second = s.close({ force: true, deadline: by() });
    fs.writeFileSync(gate, '');
    await Promise.all([first, second]);
    process.env.PATH = keep;
    await eventually('the job that ignores the hangup is gone', () => gone(job));
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
    killPid(job);
  }
});

test('a close whose every signal to the shell fails names none as sent', async () => {
  const s = await open('/bin/sh');
  const pty = (s as unknown as { p: { kill(signal?: string): void } }).p;
  const real = pty.kill.bind(pty);
  pty.kill = () => {
    throw new Error('refused');
  };
  try {
    const c = await s.close({ deadline: by(6000) });
    assert.deepEqual([c.unconfirmed, c.signal], [true, undefined], JSON.stringify(c));
  } finally {
    pty.kill = real;
    killPid(s.pid);
  }
});

test('a close whose log throws still closes', async () => {
  const s = await open('/bin/sh', {
    log: () => {
      throw new Error('log refused');
    },
  });
  await s.run('exit', { waitMs: 2000 });
  await eventually('the shell exited', () => s.front().state === 'exited');
  const c = await s.close({ deadline: by() });
  assert.equal(c.unlisted, true, JSON.stringify(c));
});

test('a close that fails leaves none under way, so the next close starts again and finishes', async () => {
  const s = await open('/bin/sh');
  const dir = (s as unknown as { dir: string }).dir;
  const t = (s as unknown as { t: { dispose(): void } }).t;
  const dispose = t.dispose.bind(t);
  let disposes = 0;
  t.dispose = () => {
    if (++disposes === 1) throw new Error('refused');
    dispose();
  };
  await assert.rejects(s.close({ deadline: by() }), /refused/);
  const c = await s.close({ deadline: by() });
  assert.deepEqual([disposes, c.underway, fs.existsSync(dir)], [2, undefined, false], JSON.stringify(c));
  assert.equal(s.front().state, 'exited');
});

/** A close whose deadline throws as it's read, so it fails before it signals anything. */
const failingClose = (): { deadline: number } => ({
  get deadline(): number {
    throw new Error('refused');
  },
});

test('after a close that fails before it signals, input stays blocked, and a wait for the running command still sees it end', async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const gate = newGate();
  fs.writeFileSync(gate, '');
  const from = s.lines(0).to - 1;
  const r = await s.run(holdJob(gate), { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  await assert.rejects(s.close(failingClose()), /refused/);
  assert.equal((await s.run('echo no', { waitMs: 300 })).kind, 'refused');
  const ending = s.wait({ kind: 'end' }, { waitMs: 10_000, from });
  fs.rmSync(gate);
  const w = await ending;
  assert.equal(w.by, 'end', JSON.stringify(w));
});

test('after a close that fails before it signals, the session goes on looking while a command runs, so its wait for input is reported', { skip: !proc.READS_VISIBLE ? 'only Linux on x64, arm64, riscv64 and loong64 shows reads' : false }, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const gate = newGate();
  fs.writeFileSync(gate, '');
  const r = await s.run(`${holdJob(gate)}; head -n 1 >/dev/null`, { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  await assert.rejects(s.close(failingClose()), /refused/);
  const events: SessionEvent[] = [];
  s.onEvent((e) => events.push(e));
  fs.rmSync(gate);
  await eventually('a wait for input is reported', () => events.some((e) => e.kind === 'waiting'));
});

test("a command whose command file can't be removed still ends with its status, and the failed removal is logged", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const logs: string[] = [];
  const s = await open(which('bash')!, { log: (l) => logs.push(l) });
  const dir = (s as unknown as { dir: string }).dir;
  try {
    const c = await ran(s, `chmod u-w '${dir}'; echo done`);
    assert.deepEqual([out(s, c), c.end?.status], [['done'], 0]);
    assert.match(logs.join('\n'), /couldn't be removed/);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("a close that joins one under way and whose own deadline comes first says it's under way, and names no signal before one was sent", darwinOnly, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  const gate = path.join(tmp, `gate-${++gates}`);
  const held = path.join(tmp, `held-${++gates}`);
  const fake = fakePs(`*"-t "*) : > '${held}'; while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const first = s.close({ deadline: by() });
    await eventually('the first close is held at its listing', () => fs.existsSync(held));
    const second = await s.close({ deadline: by(300) });
    assert.deepEqual([second.underway, second.signal, second.unconfirmed], [true, undefined, undefined], JSON.stringify(second));
    fs.writeFileSync(gate, '');
    const a = await first;
    process.env.PATH = keep;
    assert.equal(a.underway, undefined, JSON.stringify(a));
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
  }
});

test('close reads a ps that exits 1 because every listed process is gone as nothing left to hang up', darwinOnly, async () => {
  const logs: string[] = [];
  const s = await open(which('bash') ?? '/bin/bash', { log: (l) => logs.push(l) });
  const hung = pidOf(s, await ran(s, 'sleep 300 & echo "HUNG:$!"'), 'HUNG');
  const gate = path.join(tmp, `gate-${++gates}`);
  const fake = fakePs(`*stat=*) while [ ! -e '${gate}' ]; do sleep 0.05; done;;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    const closing = s.close({ deadline: by() });
    await eventually('the job the shell hung up is gone', () => {
      try {
        process.kill(hung, 0);
        return false;
      } catch {
        return true;
      }
    });
    fs.writeFileSync(gate, '');
    const exit = await closing;
    process.env.PATH = keep;
    assert.equal(exit.unlisted, undefined, logs.join('\n'));
  } finally {
    process.env.PATH = keep;
    fs.writeFileSync(gate, '');
    killPid(hung);
  }
});

test('integrate names a shell it has no hooks for, and types nothing more', { skip: which('dash') && which('bash') ? false : 'dash and bash are both needed' }, async () => {
  const s = await open(which('bash')!);
  await reachFar(s, which('dash')!);
  const r = await s.integrate({ waitMs: 10_000 });
  assert.equal(r.kind, 'unsupported', JSON.stringify(r));
  assert.equal(r.kind === 'unsupported' && r.shell, 'dash');
  assert.equal(s.front().state, 'running');
  assert.equal((await s.run('echo x', { waitMs: 500 })).kind, 'refused');
});

test("a shell given the integration through a program that ends is no longer followed, and what's typed next is the local shell's", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  await far(s, which('bash')!);
  const integrated = s.front();
  assert.notEqual(integrated.state === 'prompt' ? integrated.within : undefined, undefined);
  const e = await s.run('exit', { waitMs: 10_000 });
  assert.equal(e.kind, 'ended', JSON.stringify(e));
  const end = e.kind === 'ended' ? e.command.end : undefined;
  assert.equal(end?.status, undefined);
  // The far shell's own end wasn't seen, only its carrier's.
  assert.match(end?.unfollowed?.by ?? '', /script/, JSON.stringify(end));
  const f = await eventually('the local shell is in front', () => {
    const now = s.front();
    return now.state === 'prompt' && now;
  });
  assert.equal(f.state === 'prompt' ? f.within : 'x', undefined);
  assert.deepEqual(out(s, await ran(s, 'echo local')), ['local']);
  const job = await s.run('sleep 30', { waitMs: 300 });
  assert.equal(job.kind, 'running', JSON.stringify(job));
  const stopped = await s.stop();
  assert.equal(stopped.within, undefined);
  assert.equal(stopped.steps[0]?.sent, 'C-c');
  await s.close({ force: true, deadline: by() });
});

/** `reachFar` through `script`, with `then` run after the carrier on the same line, and `integrate`; returns the carrier's group. */
async function farThen(s: Session, then: string): Promise<number> {
  const from = s.lines(0).to - 1;
  const r = await s.run(`${relayed(which('bash')!)}; ${then}`, { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const f = s.front();
  assert.ok(f.state === 'prompt' && f.within, JSON.stringify(f));
  return f.state === 'prompt' ? f.within!.pgid : 0;
}

test('once the carrier ends and the same line starts another program in front, the far shell is no longer followed, and run types nothing into that program', { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  const capture = path.join(tmp, `capture-${++gates}`);
  const w = await farThen(s, `cat > '${capture}'`);
  // Ended from outside while the far shell is idle, as a dropped connection ends ssh: nothing typed there gives a mark.
  process.kill(-w, 'SIGTERM');
  await eventually('cat holds the terminal', () => {
    const shell = proc.info(s.pid);
    return shell?.tpgid !== undefined && shell.tpgid !== shell.pgrp && shell.tpgid !== w && proc.groupAlive(w) === false;
  });
  const f = s.front();
  // Waiting where the kernel shows cat reading its terminal, running where it can't.
  assert.ok(f.state === 'waiting' ? /cat/.test(f.process.argv) : f.state === 'running' && /cat/.test(f.process.argv) && f.within === undefined, JSON.stringify(f));
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', /MUST_NOT_REACH_CAT|__tsm/);
});

test("a shell reached through a program that a local shell with the integration started is followed only while that program holds the terminal, and the local shell stays followed", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  const local = await localFar(s);
  const capture = path.join(tmp, `capture-${++gates}`);
  await farThen(s, `cat > '${capture}'`);
  const integrated = s.front();
  // The program now in front, as the kernel shows it: script, a job of the local bash.
  const w = proc.info(s.pid)?.tpgid ?? 0;
  assert.ok(w > 0 && w !== local, JSON.stringify({ w, local }));
  // Ended from outside while the far shell is idle, as a dropped connection ends ssh.
  process.kill(-w, 'SIGTERM');
  await eventually('cat holds the terminal', () => {
    const shell = proc.info(s.pid);
    return shell?.tpgid !== undefined && shell.tpgid !== shell.pgrp && shell.tpgid !== w && shell.tpgid !== local && proc.groupAlive(w) === false;
  });
  const f = s.front();
  // cat is a job of the local bash, whose chain stays: its line is still running.
  assert.ok(f.state === 'running' && f.within?.pgid === local, JSON.stringify(f));
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', /MUST_NOT_REACH_CAT|__tsm/);
  assert.deepEqual(integrated.state === 'prompt' ? integrated.within?.pgid : 'x', w, 'the far shell was reached through script, not through the local bash');
});

test("a command in a far shell reached from another far shell, which ends there, is no longer followed with the shell below at its prompt again, not as left", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  await far(s, which('bash')!);
  // The second script runs inside the first far shell, on its terminal, so this terminal's foreground group is still the first.
  await far(s, which('bash')!);
  const f = s.front();
  assert.ok(f.state === 'prompt' && f.within, JSON.stringify(f));
  const e = await s.run('exit', { waitMs: 10_000 });
  assert.equal(e.kind, 'ended', JSON.stringify(e));
  const end = e.kind === 'ended' ? e.command.end : undefined;
  assert.deepEqual([end?.status, end?.unfollowed?.how], [undefined, 'back'], JSON.stringify(end));
  assert.match(end?.unfollowed?.by ?? '', /script/);
  const below = s.front();
  assert.ok(below.state === 'prompt' && below.within, JSON.stringify(below));
  await s.close({ force: true, deadline: by() });
});

test("the session's own shell, given the integration in place, is no longer followed once a command run from its line editor replaces it with another program", { skip: !which('bash') ? 'bash is needed' : bashBelow(which('bash')!, 5, 0) ? 'bind -x is tried only in bash 5 here' : false }, async () => {
  const s = await open('/bin/sh');
  const capture = path.join(tmp, `capture-${++gates}`);
  await s.run(`exec ${which('bash')} --norc --noprofile`, { waitMs: 5000 });
  await eventually('bash is at its prompt', () => /bash/.test(proc.argv(s.pid) ?? '') && s.front().state === 'prompt');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  // A key bound to a command runs it from the line editor at the prompt, with no mark of a command, as a trap would.
  await ran(s, `bind -x '"\\C-t": exec cat > "${capture}"'`);
  await s.send('', { waitMs: 2000, keys: ['C-t'], quietMs: 300 });
  await eventually('the shell is replaced by cat', () => /^cat\b/.test(proc.argv(s.pid) ?? ''));
  const f = s.front();
  assert.notEqual(f.state, 'prompt', JSON.stringify(f));
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', /MUST_NOT_REACH_CAT|__tsm/);
});

test("the session's own shell with the integration, replaced by a program a key bound at its prompt runs, isn't taken for its prompt, and run types nothing into that program", { skip: !which('bash') ? 'bash is needed' : bashBelow(which('bash')!, 5, 0) ? 'bind -x is tried only in bash 5 here' : false }, async () => {
  const s = await open(which('bash')!);
  const capture = path.join(tmp, `capture-${++gates}`);
  await ran(s, `bind -x '"\\C-t": exec cat > "${capture}"'`);
  await s.send('', { waitMs: 2000, keys: ['C-t'], quietMs: 300 });
  await eventually('the shell is replaced by cat', () => /^cat\b/.test(proc.argv(s.pid) ?? ''));
  const f = s.front();
  assert.ok((f.state === 'waiting' || f.state === 'running') && !f.process.shell && /^cat\b/.test(f.process.argv), JSON.stringify(f));
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.readFileSync(capture, 'utf8'), /MUST_NOT_REACH_CAT|__tsm/);
});

test("the session's own shell, given the integration in place, reads as unknown while its command line can't be read, and run types nothing", darwinOnly, async () => {
  const s = await open('/bin/sh');
  await s.run(`exec ${which('bash') ?? '/bin/bash'} --norc --noprofile`, { waitMs: 5000 });
  await eventually('bash is at its prompt', () => /bash/.test(proc.argv(s.pid) ?? '') && s.front().state === 'prompt');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const flag = path.join(tmp, `fails-${++gates}`);
  const fake = fakePs(`*command=*) [ -e '${flag}' ] && { echo 'ps: reading failed' >&2; exit 1; };;`);
  const keep = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${keep}`;
    assert.equal(s.front().state, 'prompt');
    fs.writeFileSync(flag, '');
    const f = s.front();
    assert.equal(f.state, 'unknown', JSON.stringify(f));
    assert.equal((await s.run('echo x', { waitMs: 300 })).kind, 'refused');
  } finally {
    process.env.PATH = keep;
    fs.rmSync(flag, { force: true });
  }
});

test("a run whose command file or terminal write fails leaves no command, file or submitted line behind", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  const dir = (s as unknown as { dir: string }).dir;
  const ran1 = await ran(s, 'echo one');
  // A file where the session's directory was makes the command file's write fail.
  fs.renameSync(dir, `${dir}.away`);
  fs.writeFileSync(dir, '');
  await assert.rejects(s.run('echo two', { waitMs: 2000 }));
  fs.rmSync(dir);
  fs.renameSync(`${dir}.away`, dir);
  assert.equal(s.command(ran1.id + 1), undefined);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(String(ran1.id + 1))), []);
  const pty = (s as unknown as { p: { write(d: string): void } }).p;
  const write = pty.write.bind(pty);
  pty.write = () => {
    throw new Error('refused');
  };
  await assert.rejects(s.run('echo three', { waitMs: 2000 }));
  pty.write = write;
  assert.equal(s.command(ran1.id + 2), undefined);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(String(ran1.id + 2))), []);
  assert.deepEqual(out(s, await ran(s, 'echo four')), ['four']);
  await s.close({ force: true, deadline: by() });
});

test("a send whose terminal write fails leaves the prompt's line as it was", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  await ran(s, 'echo one');
  const pty = (s as unknown as { p: { write(d: string): void } }).p;
  const write = pty.write.bind(pty);
  pty.write = () => {
    throw new Error('refused');
  };
  await assert.rejects(s.send('echo two\r', { waitMs: 2000 }));
  await assert.rejects(s.send('echo three', { waitMs: 2000 }));
  pty.write = write;
  const f = s.front();
  assert.ok(f.state === 'prompt' && f.pending === undefined, JSON.stringify(f));
  assert.deepEqual(out(s, await ran(s, 'echo four')), ['four']);
  await s.close({ force: true, deadline: by() });
});

test('a run whose terminal write fails takes no older command from those kept', { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  const first = await ran(s, 'echo one');
  const inner = s as unknown as { p: { write(d: string): void }; commandChars: number };
  inner.commandChars = Number.MAX_SAFE_INTEGER / 2;
  const write = inner.p.write.bind(inner.p);
  let writes = 0;
  inner.p.write = () => {
    writes++;
    throw new Error('refused');
  };
  try {
    await assert.rejects(s.run('echo two', { waitMs: 2000 }), /refused/);
  } finally {
    inner.p.write = write;
  }
  assert.equal(writes, 1);
  assert.equal(s.command(first.id), first);
});

for (const via of ['run', 'send'] as const) {
  test(`a ${via} whose terminal write fails at a quiet shell without the integration leaves its prompt in front`, async () => {
    const s = await open('/bin/sh');
    await eventually('the prompt is in front', () => s.front().state === 'prompt');
    const inner = s as unknown as { p: { write(d: string): void } };
    const write = inner.p.write.bind(inner.p);
    let writes = 0;
    inner.p.write = () => {
      writes++;
      throw new Error('refused');
    };
    try {
      await assert.rejects(via === 'run' ? s.run('echo two', { waitMs: 2000 }) : s.send('echo two', { waitMs: 2000 }), /refused/);
    } finally {
      inner.p.write = write;
    }
    assert.equal(writes, 1);
    const f = s.front();
    assert.equal(f.state, 'prompt', JSON.stringify(f));
  });
}

test("an integrate whose last hook write fails leaves no far shell followed, and a second integrate gives it the integration", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  const from = s.lines(0).to - 1;
  assert.equal((await s.run(relayed(which('bash')!), { waitMs: 200 })).kind, 'running');
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  const inner = s as unknown as { p: { write(d: string): void }; chains: unknown[] };
  const chains = inner.chains.length;
  const write = inner.p.write.bind(inner.p);
  // The far shell's chain is added just before the last hook is written, so that is the write that fails.
  inner.p.write = (d: string) => {
    if (inner.chains.length > chains) throw new Error('refused');
    write(d);
  };
  try {
    await assert.rejects(s.integrate({ waitMs: 10_000 }));
  } finally {
    inner.p.write = write;
  }
  assert.equal(inner.chains.length, chains);
  const f = s.front();
  assert.ok(f.state !== 'prompt' && !('within' in f && f.within), JSON.stringify(f));
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  await s.close({ force: true, deadline: by() });
});

test("an integrate that timed out doesn't hand its probe's late answer to the next one", { skip: which('bash') && which('zsh') ? false : 'bash and zsh are needed' }, async () => {
  const s = await open(which('bash')!);
  const gate = newGate();
  fs.writeFileSync(gate, '');
  const from = s.lines(0).to - 1;
  assert.equal((await s.run(relayed(which('bash')!), { waitMs: 200 })).kind, 'running');
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  // Until the gate goes, the far bash reads nothing, so the first probe waits. Then zsh runs that probe, and bash the second.
  await s.send(`while [ -e '${gate}' ]; do sleep 0.05; done; zsh -f -c "$(head -n 1)"\r`, { waitMs: 2000, quietMs: 200 });
  const first = await s.integrate({ waitMs: 300 });
  assert.deepEqual([first.kind, first.kind === 'incomplete' && first.step], ['incomplete', 'probe'], JSON.stringify(first));
  const second = s.integrate({ waitMs: 10_000 });
  fs.rmSync(gate);
  const r = await second;
  assert.deepEqual([r.kind, r.kind === 'integrated' && r.shell], ['integrated', 'bash'], JSON.stringify(r));
  await s.close({ force: true, deadline: by() });
});

test("a far shell's carrier whose own process ends, while its group goes on with another program, is no longer followed, and run types nothing into that program", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  const capture = path.join(tmp, `capture-${++gates}`);
  const from = s.lines(0).to - 1;
  // Without job control, sh -c runs script in its own group, then becomes cat in that same group.
  const r = await s.run(`sh -c '${relayed(which('bash')!)}; exec cat > "${capture}"'`, { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const w = proc.info(s.pid)?.tpgid ?? 0;
  // sh's own command line names script too, so the carrier is the process whose command is script.
  const carrier = (proc.descendants(s.pid, true) ?? []).find((d) => d.pgrp === w && /^\S*script /.test(proc.argv(d.pid) ?? ''));
  assert.ok(w > 0 && carrier, JSON.stringify({ w, carrier }));
  process.kill(carrier!.pid, 'SIGKILL');
  await eventually('the group goes on as cat', () => proc.groupAlive(w) && /^cat\b/.test(proc.argv(w) ?? '') && proc.info(s.pid)?.tpgid === w);
  const f = s.front();
  assert.ok(f.state === 'waiting' ? /cat/.test(f.process.argv) : f.state === 'running' && f.within === undefined, JSON.stringify(f));
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', /MUST_NOT_REACH_CAT|__tsm/);
});

test("a far command whose carrier is suspended is no longer followed, and its end says the carrier left the terminal, not that it ended", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  const w = await farThen(s, 'true');
  const r = await s.run('sleep 300', { waitMs: 300 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  // What Ctrl-Z does to a local ssh: its group stops, and the shell takes the terminal back.
  process.kill(-w, 'SIGSTOP');
  try {
    // Each try looks, as an agent's look does: on macOS nothing else reads the terminal while a command runs.
    const end = await eventually('the far command is no longer followed', () => (s.front(), r.kind === 'running' ? r.command.end : undefined));
    assert.deepEqual([end.status, end.unfollowed?.how], [undefined, 'left'], JSON.stringify(end));
    assert.match(end.unfollowed?.by ?? '', /script/);
    const f = s.front();
    assert.equal(f.state === 'prompt' || f.state === 'running' ? f.within : 'x', undefined);
  } finally {
    process.kill(-w, 'SIGKILL');
    await s.close({ force: true, deadline: by() });
  }
});

test("at the end mark of a shell with the integration, a far command whose carrier stopped is no longer followed, and its end says the carrier left the terminal", { ...darwinOnly, skip: darwinOnly.skip || (which('bash') ? false : 'bash is needed') }, async () => {
  const s = await open(which('bash')!);
  await reachFar(s, which('bash')!);
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const f = s.front();
  const w = f.state === 'prompt' && f.within ? f.within.pgid : 0;
  assert.ok(w > 0, JSON.stringify(f));
  const r = await s.run('sleep 300', { waitMs: 300 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  try {
    // With ps failing, nothing can read who holds the terminal, so only the session shell's end mark can drop the far chain.
    await failing('ps', '/bin/ps', async (ps) => {
      ps.on();
      // What Ctrl-Z does to a local ssh: its group stops, and the session's shell gives its end mark.
      process.kill(-w, 'SIGSTOP');
      const end = await eventually('the far command is no longer followed', () => (s.front(), r.kind === 'running' ? r.command.end : undefined));
      ps.off();
      assert.deepEqual([end.status, end.unfollowed?.how], [undefined, 'left'], JSON.stringify(end));
    });
  } finally {
    process.kill(-w, 'SIGKILL');
    await s.close({ force: true, deadline: by() });
  }
});

test("a local shell given the integration stays followed while a job it started holds the terminal", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  // A local bash, as su or sudo -i would start: its jobs take the terminal in groups of their own.
  await localFar(s);
  const job = await s.run('sleep 2', { waitMs: 500 });
  assert.equal(job.kind, 'running', JSON.stringify(job));
  const f = s.front();
  assert.ok(f.state === 'running' && f.within, JSON.stringify(f));
  const ended = await s.wait({ kind: 'end' }, { waitMs: 10_000, from: 0 });
  assert.equal(ended.by, 'end');
  const end = job.kind === 'running' ? job.command.end : undefined;
  assert.deepEqual([end?.status, end?.unfollowed], [0, undefined], JSON.stringify(end));
  await s.close({ force: true, deadline: by() });
});

test("a far shell reached in the same group as the local shell before it is no longer followed once its own carrier ends, while that local shell stays followed", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  const capture = path.join(tmp, `capture-${++gates}`);
  const w = await localFar(s);
  const chains = (s as unknown as { chains: unknown[] }).chains;
  const local = chains.length;
  // Without job control the local bash runs script in its own group, then cat in that same group.
  await ran(s, 'set +m');
  const from = s.lines(0).to - 1;
  assert.equal((await s.run(`${relayed(which('bash')!)}; cat > "${capture}"`, { waitMs: 200 })).kind, 'running');
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  assert.equal(chains.length, local + 1);
  const carrier = (proc.descendants(s.pid, true) ?? []).find((d) => d.pgrp === w && /^\S*script /.test(proc.argv(d.pid) ?? ''));
  assert.ok(w > 0 && carrier, JSON.stringify({ w, carrier }));
  process.kill(carrier!.pid, 'SIGKILL');
  await eventually('cat holds the local bash group', () => (proc.descendants(s.pid, true) ?? []).some((d) => d.pgrp === w && /^cat\b/.test(proc.argv(d.pid) ?? '')));
  const f = s.front();
  assert.ok(f.state !== 'prompt', JSON.stringify(f));
  assert.equal(chains.length, local, 'the local bash is still followed');
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', /MUST_NOT_REACH_CAT|__tsm/);
});

test("a far shell reached in the session shell's own group is no longer followed once its own carrier ends", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  const capture = path.join(tmp, `capture-${++gates}`);
  const chains = (s as unknown as { chains: unknown[] }).chains;
  const base = chains.length;
  // Without job control the session's bash runs script in its own group, then cat in that same group.
  await ran(s, 'set +m');
  const from = s.lines(0).to - 1;
  assert.equal((await s.run(`${relayed(which('bash')!)}; cat > "${capture}"`, { waitMs: 200 })).kind, 'running');
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const carrier = (proc.descendants(s.pid, true) ?? []).find((d) => d.pgrp === s.pid && /^\S*script /.test(proc.argv(d.pid) ?? ''));
  assert.ok(carrier, JSON.stringify(proc.descendants(s.pid, true)));
  process.kill(carrier!.pid, 'SIGKILL');
  await eventually("cat holds the session shell's group", () => (proc.descendants(s.pid, true) ?? []).some((d) => d.pgrp === s.pid && /^cat\b/.test(proc.argv(d.pid) ?? '')));
  const f = s.front();
  assert.ok(f.state !== 'prompt', JSON.stringify(f));
  assert.equal(chains.length, base);
  assert.equal((await s.run('echo MUST_NOT_REACH_CAT', { waitMs: 300 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
  assert.doesNotMatch(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', /MUST_NOT_REACH_CAT|__tsm/);
});

test('an integrate whose carrier ends while it waits for a hook to run stops as exited, naming that program, and types nothing more', async () => {
  const s = await open('/bin/sh');
  const capture = path.join(tmp, `capture-${++gates}`);
  const gate = newGate();
  const read = path.join(tmp, `read-${++gates}`);
  fs.writeFileSync(gate, '');
  // A stand-in far shell: it answers the probe as bash, reads the first hook piece, and holds until the gate goes.
  const fake = path.join(tmp, `fake-far-${++gates}`);
  fs.writeFileSync(
    fake,
    `#!/bin/sh\nIFS= read -r line\ncall=$(printf '%s\\n' "$line" | sed -n 's/.*133;K;\\([0-9]*\\);.*/\\1/p')\nprintf '\\033]133;K;%s;;;5.2.0(1)-release\\007' "$call"\nIFS= read -r piece\n: > '${read}'\nwhile [ -e '${gate}' ]; do sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  const carrierCommand = process.platform === 'darwin' ? `script -q /dev/null ${fake}` : `script -qfc ${fake} /dev/null`;
  // Without job control, sh -c runs script in its own group, then cat in that same group.
  assert.equal((await s.run(`sh -c '${carrierCommand}; exec cat > "${capture}"'`, { waitMs: 200 })).kind, 'running');
  await inFront(s, /script/);
  const pts = (s as unknown as { pts: string }).pts;
  await eventually('script holds the terminal out of canonical mode', () => proc.modes(pts)?.canonical === false);
  const integrating = s.integrate({ waitMs: 10_000 });
  await eventually('the stand-in read the first hook piece', () => fs.existsSync(read));
  fs.rmSync(gate);
  const r = await integrating;
  assert.deepEqual([r.kind, r.kind === 'incomplete' && r.step, r.kind === 'incomplete' && r.by], ['incomplete', 'hooks', 'exited'], JSON.stringify(r));
  assert.match((r.kind === 'incomplete' && r.ended) || '', /^\S*script /, JSON.stringify(r));
  await s.close({ force: true, deadline: by() });
  assert.equal(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : '', '');
});

test("an integrate whose second probe line gets no answer within the wait stops at the probe as timed out, rather than naming no shell", async () => {
  const s = await open('/bin/sh');
  const gate = newGate();
  const read = path.join(tmp, `read-${++gates}`);
  fs.writeFileSync(gate, '');
  const fake = path.join(tmp, `fake-far-${++gates}`);
  fs.writeFileSync(
    fake,
    `#!/bin/sh\nIFS= read -r line\ncall=$(printf '%s\\n' "$line" | sed -n 's/.*133;K;\\([0-9]*\\);.*/\\1/p')\nprintf '\\033]133;K;%s;;;\\007' "$call"\nIFS= read -r zero\n: > '${read}'\nwhile [ -e '${gate}' ]; do sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  assert.equal((await s.run(process.platform === 'darwin' ? `script -q /dev/null ${fake}` : `script -qfc ${fake} /dev/null`, { waitMs: 200 })).kind, 'running');
  await inFront(s, /script/);
  const pts = (s as unknown as { pts: string }).pts;
  await eventually('script holds the terminal out of canonical mode', () => proc.modes(pts)?.canonical === false);
  try {
    const r = await s.integrate({ waitMs: 3000 });
    assert.ok(fs.existsSync(read), 'the stand-in read the second probe line');
    assert.deepEqual([r.kind, r.kind === 'incomplete' && r.step, r.kind === 'incomplete' && r.by], ['incomplete', 'probe', 'timeout'], JSON.stringify(r));
  } finally {
    fs.rmSync(gate, { force: true });
  }
});

test('the nonce a shell below still expects stays redacted however many commands the shell above it runs', { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  const from = s.lines(0).to - 1;
  const r = await s.run(`env -i HOME='${lastHome()}' PATH='${process.env.PATH ?? '/usr/bin:/bin'}' TERM=xterm-256color PS1='far> ' SAVED="$__tsm_r" '${which('bash')!}' --norc --noprofile -i`, { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const below = (s as unknown as { chains: Array<{ expected: { random: string } }> }).chains[0]!.expected.random;
  for (let i = 0; i < 70; i++) await ran(s, 'true');
  const c = await ran(s, 'echo "S:$SAVED"');
  assert.deepEqual(out(s, c), [`S:${'[redacted]'.padEnd(below.length, '.')}`]);
  assert.ok(!s.lines(0).lines.some((l) => l.includes(below)));
  assert.ok(!s.screen().rows.some((l) => l.includes(below)));
});

/** A local bash given the integration in `s`, at its prompt; returns its group. */
async function localFar(s: Session): Promise<number> {
  const from = s.lines(0).to - 1;
  const r = await s.run(`env -i HOME='${lastHome()}' PATH='${process.env.PATH ?? '/usr/bin:/bin'}' TERM=xterm-256color PS1='far> ' '${which('bash')!}' --norc --noprofile -i`, { waitMs: 200 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  assert.equal((await s.wait({ kind: 'match', pattern: /^far> ?$/ }, { waitMs: 10_000, from })).by, 'match');
  assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  const f = s.front();
  return f.state === 'prompt' && f.within ? f.within.pgid : 0;
}

for (const [unseen, filter] of [
  ['the group in front', (w: number) => `awk '$2 != ${w}'`],
  ["the carrier's own processes", (w: number) => `awk '$1 != ${w}'`],
] as const) {
  test(`a listing that doesn't show ${unseen} leaves the far shell followed and the front unknown, rather than dropping it`, darwinOnly, async () => {
    const s = await open('/bin/sh');
    const w = await localFar(s);
    const gate = newGate();
    const fake = fakePs(`*"-A "*) /bin/ps "$@" | ${filter(w)}; exit 0;;`);
    const keep = process.env.PATH;
    try {
      process.env.PATH = `${fake}:${keep}`;
      fs.writeFileSync(gate, '');
      const job = await s.run(holdJob(gate), { waitMs: 300 });
      assert.equal(job.kind, 'running', JSON.stringify(job));
      assert.equal(s.front().state, 'unknown');
      process.env.PATH = keep;
      const f = s.front();
      assert.ok(f.state === 'running' && f.within, JSON.stringify(f));
      assert.equal(job.kind === 'running' ? job.command.end?.unfollowed : 'x', undefined);
    } finally {
      fs.rmSync(gate, { force: true });
      process.env.PATH = keep;
      await s.close({ force: true, deadline: by() });
    }
  });
}

test("with ps failing at a far shell's prompt, the front is unknown: the far marks don't say who holds this terminal", { ...darwinOnly, skip: darwinOnly.skip || (which('bash') ? false : 'bash is needed') }, async () => {
  const s = await open('/bin/sh');
  await far(s, which('bash')!);
  await failing('ps', '/bin/ps', async (ps) => {
    ps.on();
    assert.equal(s.front().state, 'unknown');
    ps.off();
  });
  const f = s.front();
  assert.ok(f.state === 'prompt' && f.within, JSON.stringify(f));
  await s.close({ force: true, deadline: by() });
});

/** Runs `body` with a `name` first on PATH that fails after `on()` and runs `real` otherwise. */
async function failing<T>(name: string, real: string, body: (fails: { on: () => void; off: () => void }) => Promise<T>): Promise<T> {
  const bin = fs.mkdtempSync(path.join(tmp, `${name}-bin-`));
  const flag = path.join(bin, 'fails');
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n[ -e '${flag}' ] && exit 1\nexec ${real} "$@"\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH ?? '/usr/bin:/bin'}`;
  try {
    return await body({ on: () => fs.writeFileSync(flag, ''), off: () => fs.rmSync(flag, { force: true }) });
  } finally {
    process.env.PATH = PATH;
  }
}

test("integrate types nothing while the terminal's modes can't be read, and reaches the far shell once they can", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open('/bin/sh');
  await reachFar(s, which('bash')!);
  await failing('stty', '/bin/stty', async (stty) => {
    const before = s.lines(0).to;
    stty.on();
    const r = await s.integrate({ waitMs: 5000 });
    assert.deepEqual(r.kind === 'refused' && r.unread, true, JSON.stringify(r));
    // Whatever the call typed would reach the far shell before a line typed after it.
    const mark = await s.send('echo AFTER_REFUSAL\r', { waitMs: 5000, until: /^AFTER_REFUSAL$/ });
    assert.equal(mark.by, 'match');
    assert.deepEqual(s.lines(before, mark.matched!.line).lines.filter((l) => l.trim() && !/^far> ?(echo AFTER_REFUSAL)?$/.test(l)), []);
    stty.off();
    assert.equal((await s.integrate({ waitMs: 10_000 })).kind, 'integrated');
  });
  await s.close({ force: true, deadline: by() });
});

test("with the terminal's foreground group unread, a program in front of a shell without integration is unknown, not at the prompt, and run types nothing", { skip: process.platform !== 'darwin' ? "here the shell's group is read from /proc, not from ps" : false }, async () => {
  const s = await open('/bin/sh');
  const r = await s.run("stty -icanon -echo; cat; stty sane", { waitMs: 300 });
  assert.equal(r.kind, 'running', JSON.stringify(r));
  await eventually('cat in front', () => {
    const now = s.front();
    return now.state === 'running' && /cat/.test(now.process.argv) && now;
  });
  await failing('ps', '/bin/ps', async (ps) => {
    ps.on();
    // With the shell taken to be in front, the shell reads as busy until its output has been quiet for a while, then as at its prompt.
    const f = await eventually('a state other than the shell busy', () => {
      const now = s.front();
      return now.state !== 'running' && now;
    });
    assert.equal(f.state, 'unknown');
    assert.equal(f.state === 'unknown' ? f.command : 'x', r.kind === 'running' ? r.command.id : 'y');
    const typed = await s.run('echo SHOULD_NOT_RUN', { waitMs: 1000 });
    assert.equal(typed.kind, 'refused');
    assert.equal(r.kind === 'running' ? r.command.end : 'x', undefined);
    ps.off();
  });
  assert.equal(s.front().state, 'running');
  await s.stop();
  assert.ok(!s.lines(0).lines.some((l) => l.includes('SHOULD_NOT_RUN')));
  await s.close({ force: true, deadline: by() });
});

test("with the terminal's foreground group unread, a shell with marks is unknown, running a command and at its prompt too, and run types nothing", { skip: process.platform !== 'darwin' ? "here the shell's group is read from /proc, not from ps" : false }, async () => {
  const s = await open(which('bash') ?? '/bin/bash');
  await failing('ps', '/bin/ps', async (ps) => {
    ps.on();
    assert.equal(s.front().state, 'unknown');
    assert.equal((await s.run('echo SHOULD_NOT_RUN', { waitMs: 300 })).kind, 'refused');
    ps.off();
    const r = await s.run('sleep 30', { waitMs: 300 });
    assert.equal(r.kind, 'running', JSON.stringify(r));
    ps.on();
    const f = s.front();
    assert.equal(f.state, 'unknown');
    assert.equal(f.state === 'unknown' ? f.command : 'x', r.kind === 'running' ? r.command.id : 'y');
    ps.off();
  });
  assert.equal(s.front().state, 'running');
  await s.stop();
  await s.close({ force: true, deadline: by() });
});

test('the descendants of a pid with no process cannot be listed', () => {
  assert.equal(proc.descendants(2 ** 22 + 12345), undefined);
  assert.ok(Array.isArray(proc.descendants(process.pid)));
});

test('a cwd that is not a directory is refused as invalid_argument', async () => {
  await assert.rejects(open(which('bash') ?? '/bin/sh', { cwd: path.join(tmp, 'missing') }), { code: 'invalid_argument' });
});

test("a no-break space typed at the prompt is pending, so run refuses, while ordinary spaces are not", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  await s.send('\u00a0', { waitMs: 2000, quietMs: 200 });
  await pendingIs(s, '\u00a0');
  assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
  await s.send('', { waitMs: 2000, keys: ['C-e', 'C-u'], quietMs: 200 });
  await s.send('  ', { waitMs: 2000, quietMs: 200 });
  assert.deepEqual(out(s, await ran(s, 'echo spaced')), ['spaced']);
  await s.close({ force: true, deadline: by() });
});

test('text on the prompt\'s line past the cursor is pending too, so run refuses until the line is cleared', { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  await s.send('echo UNWANTED', { waitMs: 2000, quietMs: 100 });
  await pendingIs(s, 'echo UNWANTED');
  // Ctrl-A moves readline's cursor to the start of the line, so nothing is left of it before the cursor.
  await s.send('', { waitMs: 2000, keys: ['C-a'], quietMs: 200 });
  await pendingIs(s, 'echo UNWANTED');
  assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
  await s.send('', { waitMs: 2000, keys: ['C-e', 'C-u'], quietMs: 200 });
  await eventually('nothing pending', () => {
    const f = s.front();
    return f.state === 'prompt' && f.pending === undefined;
  });
  assert.deepEqual(out(s, await ran(s, 'echo cleared')), ['cleared']);
  await s.close({ force: true, deadline: by() });
});

for (const [name, rc] of [
  ['zsh', "RPROMPT='RIGHT-SIDE'\n"],
  ['fish', 'function fish_right_prompt; echo RIGHT-SIDE; end\n'],
] as const) {
  test(`a right prompt ${name} draws on the prompt's line isn't taken for typed text`, { skip: which(name) ? false : `${name} is needed` }, async () => {
    const s = await open(which(name)!, { rc });
    await eventually('the right prompt is drawn', () => s.lines(0).lines.some((l) => l.includes('RIGHT-SIDE')));
    const f = s.front();
    assert.ok(f.state === 'prompt' && f.pending === undefined, JSON.stringify(f));
    assert.deepEqual(out(s, await ran(s, 'echo ran')), ['ran']);
    await s.send('echo half', { waitMs: 2000, quietMs: 200 });
    assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
    await s.close({ force: true, deadline: by() });
  });
}

test("text a line editor draws on the prompt's line with the cursor after it isn't taken for the prompt's own, even once the cursor moves to the end mark", { skip: which('zsh') ? false : 'zsh is needed' }, async () => {
  const s = await open(which('zsh')!);
  // print -z puts the text in the line editor at the next prompt, with the cursor after it, before anything is sent there.
  await ran(s, "print -z 'echo PUSHED'");
  await pendingIs(s, 'echo PUSHED');
  await s.send('', { waitMs: 2000, keys: ['C-a'], quietMs: 200 });
  await pendingIs(s, 'echo PUSHED');
  assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
});

test("text sent at the prompt stays pending, so run refuses, until the prompt's line or the cursor changes, though output that draws nothing there is parsed", { skip: which('zsh') ? false : 'zsh is needed' }, async () => {
  const s = await open(which('zsh')!);
  await ran(s, "__titled() { print -n '\\e]0;TITLED\\a' }; zle -N __titled; bindkey Q __titled");
  await s.send('Q', { waitMs: 2000, quietMs: 200 });
  await eventually('the title the key set is parsed', () => s.screen().title === 'TITLED');
  await pendingIs(s, 'Q');
  assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
  await s.send('', { waitMs: 2000, keys: ['C-c'], quietMs: 200 });
  assert.deepEqual(out(s, await ran(s, 'echo after')), ['after']);
  await s.close({ force: true, deadline: by() });
});

test("output a job prints onto the prompt's line, with the cursor after it, isn't taken for the prompt's own, so run refuses", { skip: which('bash') ? false : 'bash is needed' }, async () => {
  const s = await open(which('bash')!);
  const gate = path.join(tmp, `gate-${++gates}`);
  fs.writeFileSync(gate, '');
  await ran(s, `(while [ -e '${gate}' ]; do sleep 0.05; done; printf BGOUT) &`);
  // The prompt is drawn with the cursor at its end mark; then the job prints there.
  await eventually('the prompt is in front', () => s.front().state === 'prompt');
  fs.rmSync(gate);
  await eventually('the job printed on the prompt line', () => s.lines(0).lines.some((l) => l.includes('BGOUT')));
  await pendingIs(s, 'BGOUT');
  assert.equal((await s.run('echo x', { waitMs: 2000 })).kind, 'refused');
  await s.close({ force: true, deadline: by() });
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

test("a shell without integration whose terminal can't be read is in front as unknown, not running, and run types nothing", { skip: process.platform !== 'darwin' ? "here the kernel shows the shell reading its terminal, so the terminal's modes aren't asked" : false }, async () => {
  await failing('stty', '/bin/stty', async (stty) => {
    const s = await open('/bin/sh');
    for (let i = 0; i < 100 && s.front().state !== 'prompt'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(s.front().state, 'prompt');
    stty.on();
    assert.equal(s.front().state, 'unknown');
    const r = await s.run('echo SHOULD_NOT_RUN', { waitMs: 1000 });
    assert.equal(r.kind, 'refused');
    assert.equal(r.front.state, 'unknown');
    stty.off();
    assert.equal(s.front().state, 'prompt');
    const after = await s.run('echo plain', { waitMs: 5000 });
    assert.equal(after.kind, 'ended');
    assert.ok(!s.lines(0).lines.some((l) => l.includes('SHOULD_NOT_RUN')));
    await s.close({ force: true, deadline: by() });
  });
});

test('a shell without integration opens and runs, with no status', async () => {
  const s = await open('/bin/sh');
  assert.equal(s.kind, 'none');
  assert.equal(s.front().state, 'prompt');
  const r = await s.run('echo plain', { waitMs: 5000 });
  assert.equal(r.kind, 'ended');
  assert.equal(r.kind === 'ended' ? r.command.end?.status : 'x', undefined);
});
