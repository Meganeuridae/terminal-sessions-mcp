/**
 * Real bash 3.2 and zsh against the user's rc files (a fake HOME): another shell
 * integration in the rc, nested shells, `exec`, PROMPT_COMMAND and DEBUG-trap
 * interplay, bash-preexec, XDG ZDOTDIR layouts, login files, prompt rebuilders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JournalEvent } from '../src/core/types.js';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

/** A stand-in for Ghostty/iTerm2/kitty integrations: unkeyed 133 marks from the user's rc. */
const FOREIGN_ZSH = `
_foreign_precmd() { local ret=$?; print -n "\\e]133;D;$ret\\a\\e]133;A\\a"; precmd_functions=($\{precmd_functions:#_foreign_precmd} _foreign_precmd) }
_foreign_preexec() { print -n "\\e]133;C;\\a" }
precmd_functions+=(_foreign_precmd)
preexec_functions+=(_foreign_preexec)
PS1="$PS1%{$(print -n '\\e]133;B\\a')%}"
`;
const FOREIGN_BASH = `
_f_pc() { printf '\\033]133;D;%s\\007\\033]133;A\\007' "$?"; }
PROMPT_COMMAND=_f_pc
trap 'printf "\\033]133;C\\007"' DEBUG
PS1="$PS1"'\\[\\033]133;B\\007\\]'
`;

const prompts = (evs: JournalEvent[], phase: 'start' | 'end') => evs.filter((e) => e.type === 'prompt' && e.phase === phase).length;

test('realSession keeps its private HOME and XDG directories when a test supplies daemonEnv', { skip: !hasShell('/bin/bash') }, async () => {
  const supplied = {
    PATH: process.env.PATH,
    HOME: '/fixture-host-home',
    XDG_CONFIG_HOME: '/fixture-host-config',
    XDG_DATA_HOME: '/fixture-host-data',
    XDG_CACHE_HOME: '/fixture-host-cache',
    XDG_STATE_HOME: '/fixture-host-state',
    ZDOTDIR: '/fixture-host-zdotdir',
    KEEP_FIXTURE_VALUE: 'kept',
  };
  const x = await realSession('/bin/bash', { daemonEnv: supplied, login: false });
  try {
    assert.equal(supplied.ZDOTDIR, '/fixture-host-zdotdir', 'fixture setup preserves the caller-owned environment object');
    const r = await x.run("printf '%s\\n' \"$HOME\" \"$XDG_CONFIG_HOME\" \"$XDG_DATA_HOME\" \"$XDG_CACHE_HOME\" \"$XDG_STATE_HOME\" \"$KEEP_FIXTURE_VALUE\"");
    assert.equal(r.state, 'exited');
    assert.deepEqual(r.text.split('\n'), [x.home, path.join(x.home, '.config'), path.join(x.home, '.local', 'share'), path.join(x.home, '.cache'), path.join(x.home, '.local', 'state'), 'kept']);
  } finally {
    await x.close();
  }
});

for (const shell of ['/bin/bash', '/bin/zsh'].filter(hasShell)) {
  const zsh = shell.endsWith('zsh');

  test(`${shell}: tg-2/shell-2: a second OSC 133 integration in the user's rc does not disturb Runs`, async () => {
    const x = await realSession(shell, { rc: zsh ? { '.zshrc': FOREIGN_ZSH } : { '.bashrc': FOREIGN_BASH }, login: false });
    try {
      assert.equal(x.session.integration, 'rich');
      const hi = await x.run('echo hi');
      assert.equal(hi.state, 'exited');
      assert.equal(hi.text, 'hi');
      assert.equal((await x.run('false')).exit, 1);
      assert.equal((await x.run('sh -c "exit 7"')).exit, 7);
      x.session.input('echo typed; (exit 4)\n', { principal: AGENT });
      await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 3000, 'typed Run');
      const typed = x.session.listRuns().find((r) => r.origin === 'agent')!;
      assert.equal(typed.line, 'echo typed; (exit 4)');
      assert.equal(typed.exit, 4);
      assert.equal(x.session.listRuns().length, 4, 'no phantom Runs from the foreign marks');
    } finally {
      await x.close();
    }
  });

  test(`${shell}: shell-3: a nested shell inside a Run neither ends it nor receives the key`, async () => {
    const x = await realSession(shell, { rc: zsh ? { '.zshrc': FOREIGN_ZSH } : { '.bashrc': FOREIGN_BASH }, login: false });
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: `${shell} -i`, principal: AGENT });
      assert.ok(a.admitted);
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(x.session.run(a.run.runId).state, 'running', 'the nested prompt (with its own marks) did not end the outer Run');
      assert.ok(!x.session.shellAvailable().ok, 'nothing is typed into the nested shell');
      x.session.input('echo "nested[${TSM_MARK_KEY-}]"; exit 5\n', { principal: AGENT });
      const r = await x.session.awaitRun(a.run.runId, 5000);
      assert.equal(r.state, 'exited');
      assert.equal(r.exit, 5);
      assert.match((await x.session.runTranscript(r.runId)).text, /nested\[\]/);
      assert.equal((await x.run('echo after')).text, 'after');
    } finally {
      await x.close();
    }
  });

  test(`${shell}: shell-17: \`exec ${shell}\` re-integrates; the Run in flight is lost, not left running`, async () => {
    const x = await realSession(shell);
    try {
      const r = await x.run(`exec ${shell}`, 5000);
      assert.equal(r.state, 'lost');
      assert.equal(r.reason, 'shell-replaced', 'the new shell announced itself (ss-4)');
      const after = await x.run('sh -c "exit 3"');
      assert.equal(after.exit, 3, 'the replaced shell is integrated');
      assert.equal((await x.run('echo "[${TSM_MARK_KEY-}][${TSM_MARK_PID-}][${TSM_BASH_RC-}]"')).text, '[][][]', 'nothing leaked into the environment');
      // An exec that does not replace the shell (redirection only) is disarmed at the prompt.
      assert.equal((await x.run('exec 3>&1')).exit, 0);
      assert.equal((await x.run('echo "[${TSM_MARK_KEY-}]"; false')).exit, 1);
    } finally {
      await x.close();
    }
  });

  test(`${shell}: shell-15: a prompt rebuilt at every prompt still ends with the prompt-end mark`, async () => {
    const rc = zsh ? { '.zshrc': "precmd() { PROMPT='rebuilt %# ' }\n" } : { '.bashrc': "PROMPT_COMMAND='PS1=\"rebuilt \\$ \"'\n" };
    const x = await realSession(shell, { rc, login: false });
    try {
      await x.run('true');
      await x.run('true');
      await until(() => prompts(x.journal.since(0).events, 'end') >= 3, 2000, 'prompt ends');
      assert.equal(prompts(x.journal.since(0).events, 'end'), prompts(x.journal.since(0).events, 'start'));
    } finally {
      await x.close();
    }
  });

  test(`${shell}: shell-14: session shells are login shells by default (login: false opts out)`, async () => {
    const rc = zsh
      ? { '.zprofile': 'export M_PROFILE=p\n', '.zlogin': 'export M_LOGIN=l\n', '.zshrc': 'export M_RC=r\n' }
      : { '.bash_profile': 'export M_PROFILE=p\n', '.profile': 'export M_LOGIN=never\n', '.bashrc': 'export M_RC=r\n' };
    const probe = 'echo "${M_PROFILE-}/${M_LOGIN-}/${M_RC-}"';
    const login = await realSession(shell, { rc });
    try {
      assert.equal((await login.run(probe)).text, zsh ? 'p/l/r' : 'p//');
    } finally {
      await login.close();
    }
    const plain = await realSession(shell, { rc, login: false });
    try {
      assert.equal((await plain.run(probe)).text, '//r');
    } finally {
      await plain.close();
    }
  });
}

test('/bin/bash: shell-5/core-13: PROMPT_COMMAND reassigned at runtime (reassign, prepend, append, re-sourced rc) never breaks exits or wedges', async () => {
  const x = await realSession('/bin/bash', { rc: { '.bashrc': "PROMPT_COMMAND='history -a'\n" }, login: false });
  try {
    assert.equal((await x.run("PROMPT_COMMAND='history -a'")).state, 'exited');
    assert.equal((await x.run('false')).exit, 1);
    assert.equal((await x.run('PROMPT_COMMAND="history -a; $PROMPT_COMMAND"')).state, 'exited');
    assert.equal((await x.run('sh -c "exit 9"')).exit, 9, 'the prepend idiom does not turn every exit into 0');
    assert.equal((await x.run('PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }history -n"')).state, 'exited');
    assert.equal((await x.run('sh -c "exit 7"')).exit, 7, 'the append idiom does not start phantom Runs');
    assert.equal((await x.run('source ~/.bashrc')).state, 'exited', 'a re-sourced rc that assigns PROMPT_COMMAND');
    assert.equal((await x.run('false')).exit, 1);
    assert.ok(x.session.listRuns().every((r) => r.origin === 'self' && r.state === 'exited'), 'no phantom Runs');
  } finally {
    await x.close();
  }
});

test('/bin/bash: shell-13: the user\'s PROMPT_COMMAND sees the command\'s $?, and a DEBUG trap from the rc is chained', async () => {
  const x = await realSession('/bin/bash', {
    rc: { '.bashrc': 'PROMPT_COMMAND=\'printf "[status=%s]" "$?"\'\ntrap \'dbg=$(( ${dbg:-0} + 1 ))\' DEBUG\n' },
    login: false,
  });
  try {
    assert.equal((await x.run('false')).exit, 1);
    await x.session.waitAvailable(2000); // the prompt (and the user's PROMPT_COMMAND) follows the end mark
    await x.session.screen.settled();
    assert.ok(x.session.snapshot().lines.some((l) => l.startsWith('[status=1]')), 'the status the user\'s prompt shows is the command\'s');
    assert.ok(Number((await x.run('echo "$dbg"')).text) > 0, 'the rc\'s DEBUG trap still runs');
    // A DEBUG trap typed at the prompt replaces ours; the next prompt chains it. (A daemon
    // Run cannot set one on bash 3.2: bash restores the DEBUG trap around \`source\`.)
    x.session.input("trap 'seen=1' DEBUG\n", { principal: AGENT });
    await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 3000, 'typed trap');
    assert.equal((await x.run('sh -c "exit 6"')).exit, 6);
    assert.equal((await x.run('echo "${seen-}"')).text, '1');
  } finally {
    await x.close();
  }
});

test('/bin/bash: shell-13: with bash-preexec loaded, the integration joins its arrays instead of replacing its hooks', async () => {
  const BP = `
bash_preexec_imported=defined
precmd_functions=(); preexec_functions=()
__bp_setst() { return "$1"; }
__bp_interactive=
__bp_precmd() { local ret=$? f; for f in "$\{precmd_functions[@]}"; do __bp_setst "$ret"; "$f"; done; __bp_interactive=on; }
__bp_preexec() {
  [ -n "$__bp_interactive" ] || return 0
  [ "$BASH_COMMAND" = __bp_precmd ] && return 0
  __bp_interactive=
  local c f; c=$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')
  for f in "$\{preexec_functions[@]}"; do "$f" "$c"; done
}
PROMPT_COMMAND=__bp_precmd
trap '__bp_preexec' DEBUG
ran=0
my_preexec() { ran=$((ran + 1)); }
preexec_functions+=(my_preexec)
`;
  const x = await realSession('/bin/bash', { rc: { '.bashrc': BP }, login: false });
  try {
    assert.equal(x.session.integration, 'rich');
    assert.equal((await x.run('echo hi')).text, 'hi');
    assert.equal((await x.run('sh -c "exit 5"')).exit, 5);
    assert.ok(Number((await x.run('echo "$ran"')).text) >= 3, 'the user\'s preexec functions still run');
    assert.equal((await x.run('echo "$PROMPT_COMMAND"')).text, '__bp_precmd', 'bash-preexec keeps PROMPT_COMMAND');
    // (source unsets the DEBUG trap while a file runs: ask at the prompt.)
    x.session.input('trap -p DEBUG\n', { principal: AGENT });
    await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 3000, 'typed trap -p');
    const typed = x.session.listRuns().find((r) => r.origin === 'agent')!;
    assert.equal(typed.line, 'trap -p DEBUG');
    assert.match((await x.session.runTranscript(typed.runId)).text, /__bp_preexec/, 'bash-preexec keeps its trap');
  } finally {
    await x.close();
  }
});

test('/bin/zsh: shell-11: a ZDOTDIR chosen in ~/.zshenv (XDG layout) is honoured, and ZDOTDIR is the user\'s afterwards', { skip: !hasShell('/bin/zsh') }, async () => {
  const x = await realSession('/bin/zsh', {
    rc: {
      '.zshenv': 'export ZDOTDIR="$HOME/.config/zsh"\n',
      '.config/zsh/.zprofile': 'export XDG_PROFILE=yes\n',
      '.config/zsh/.zshrc': "export FROM_XDG=yes\nalias ll='ls -l'\n",
    },
  });
  try {
    assert.equal((await x.run('echo "$FROM_XDG $XDG_PROFILE $ZDOTDIR"')).text, `yes yes ${x.home}/.config/zsh`);
    assert.equal((await x.run('alias ll')).exit, 0);
    // A nested zsh reads the user's own files, not the shim.
    assert.equal((await x.run('zsh -ic \'echo "$FROM_XDG"\'')).text, 'yes');
  } finally {
    await x.close();
  }
});

test('/bin/zsh: a ZDOTDIR the daemon inherited is where the user\'s files are read from, and it is restored', { skip: !hasShell('/bin/zsh') }, async () => {
  const x = await realSession('/bin/zsh', { rc: { 'zd/.zshrc': 'export FROM_ZD=yes\n', '.zshrc': 'export FROM_HOME=yes\n' }, userZdotdir: '~/zd' });
  try {
    assert.equal((await x.run('echo "${FROM_ZD-no} ${FROM_HOME-no} $ZDOTDIR"')).text, `yes no ${x.home}/zd`);
  } finally {
    await x.close();
  }
});

test('/bin/zsh: core-13: hooks removed at runtime heal at the next prompt; the Run that removed them is lost, never left running', { skip: !hasShell('/bin/zsh') }, async () => {
  const x = await realSession('/bin/zsh', { rc: { '.zshrc': 'precmd() { :; }\n' } });
  try {
    const cut = await x.run('precmd_functions=()', 3000);
    assert.equal(cut.state, 'lost', 'its end mark was removed with the hooks: the status is unknown (G3)');
    assert.equal(cut.reason, 'prompt-without-end-mark');
    assert.equal((await x.run('false')).exit, 1, 'integrated again');
    assert.equal((await x.run('preexec_functions=()')).exit, 0);
    assert.equal((await x.run('sh -c "exit 6"')).exit, 6, 'the pre-execution hook is back too');
    assert.ok(x.session.listRuns().every((r) => r.origin === 'self'), 'no phantom Runs');
    assert.ok(await x.session.waitAvailable(2000), 'the prompt confirmed the shell is available');
    assert.equal(x.session.state, 'idle');
  } finally {
    await x.close();
  }
});

test('/bin/bash: a DEBUG trap set by a sourced file or an eval does not lose the next Run', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash');
  try {
    const trapper = path.join(x.tmp, 'trapper.sh');
    fs.writeFileSync(trapper, "trap 'true' DEBUG\n");
    assert.equal((await x.run(`source '${trapper}'`)).exit, 0);
    const after = await x.run('echo after-source');
    assert.deepEqual([after.state, after.text.trim()], ['exited', 'after-source']);
    assert.equal((await x.run(`eval "trap 'true' DEBUG"`)).exit, 0);
    const after2 = await x.run('echo after-eval');
    assert.deepEqual([after2.state, after2.text.trim()], ['exited', 'after-eval']);
    assert.equal((await x.run(`. '${trapper}'`)).exit, 0);
    assert.deepEqual((await x.run('echo after-dot')).text.trim(), 'after-dot');
  } finally {
    await x.close();
  }
});

test('/bin/bash: a PROMPT_COMMAND bash runs differently from its text (a compound command, a leading blank) is healed, and the next Runs go on', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash');
  try {
    assert.equal((await x.run('__hpc_fn() { HPC_RAN=1; }')).exit, 0);
    assert.equal((await x.run("PROMPT_COMMAND='if true; then __hpc_fn; fi'")).exit, 0);
    const a = await x.run('echo next-1');
    assert.deepEqual([a.state, a.exit, a.text.trim()], ['exited', 0, 'next-1']);
    assert.equal((await x.run("PROMPT_COMMAND=' __hpc_fn'")).exit, 0);
    const b = await x.run('echo next-2');
    assert.deepEqual([b.state, b.exit, b.text.trim()], ['exited', 0, 'next-2']);
    assert.equal((await x.run('echo "$HPC_RAN"')).text.trim(), '1', "the user's command ran as the prompt's own");
  } finally {
    await x.close();
  }
});

test('/bin/zsh: a ZDOTDIR a startup file sets chooses the next file read and is the user’s afterwards', { skip: !hasShell('/bin/zsh') }, async () => {
  const x = await realSession('/bin/zsh', { login: true, rc: { '.zprofile': 'export ZDOTDIR="$HOME/zd"\n', 'zd/.zshrc': 'export FROM_ZD=yes\n' } });
  try {
    assert.equal((await x.run('echo "${FROM_ZD-no} $ZDOTDIR"')).text.trim(), `yes ${x.home}/zd`);
  } finally {
    await x.close();
  }
});

test('/bin/zsh: a ZDOTDIR set in .zlogin is the user’s afterwards, not undone by the shim', { skip: !hasShell('/bin/zsh') }, async () => {
  // .zlogin is the last startup file; the .zlogin shim keeps a ZDOTDIR it set, as the .zprofile and
  // .zshrc shims do, so nested zsh read the user's files from there (the house's read, #22 comment
  // 6269901528: .zlogin's keep had no test, and without it the value is undone to what it was before).
  const x = await realSession('/bin/zsh', { login: true, rc: { '.zlogin': 'export ZDOTDIR="$HOME/zl"\n' } });
  try {
    assert.equal((await x.run('echo "${ZDOTDIR-unset}"')).text.trim(), `${x.home}/zl`);
  } finally {
    await x.close();
  }
});

test('/bin/zsh: a plugin that replaces the line-init widget after startup does not stop the prompt-end marks', { skip: !hasShell('/bin/zsh') }, async () => {
  const x = await realSession('/bin/zsh');
  try {
    assert.equal((await x.run('__plug_init() { :; }; zle -N zle-line-init __plug_init')).exit, 0);
    const r = await x.run('echo after-plugin');
    assert.deepEqual([r.state, r.text.trim()], ['exited', 'after-plugin']);
    await until(() => x.journal.since(r.seq.end ?? 0).events.some((e) => e.type === 'prompt' && e.phase === 'end'), 3000, 'a prompt-end mark after the Run');
    assert.equal((await x.run('echo still')).text.trim(), 'still');
  } finally {
    await x.close();
  }
});

for (const [how, line] of [
  ['', 'PROMPT_COMMAND="history -a"; history -a; echo ran-own-$((6*7)); sleep 6'],
  [', with install-shaped text quoted later in the line', `PROMPT_COMMAND="history -a"; history -a; echo ran-own-$((6*7)); sleep 6; echo 'PROMPT_COMMAND="history -a"' > /dev/null; echo typed-$((40+2))`],
] as const) {
  test(`/bin/bash: a typed line that sets PROMPT_COMMAND and runs one of its commands stays busy while it runs${how}`, { skip: !hasShell('/bin/bash') }, async () => {
    // The line's own `history -a` matches the PROMPT_COMMAND it just set; the heal must not mistake it
    // for the prompt's own and close the Run, leaving the session idle while `sleep 3` runs on (the
    // house's read, #22 comment 6264958172). A daemon `.`-sourced Run is unaffected (DEBUG suspended).
    // The quoted assignment after the run read as the line's last install, which hid the line's own
    // `history -a` before it: the Run closed at once (the house's read of the 38 commits, #22 comment
    // 6274841346).
    // The line prints a marker after its own `history -a`: the check waits for it, then reads busy with
    // `sleep 6` still ahead, where a fixed 1,200 ms wait failed falsely on a slow start and passed
    // falsely before the line reached its `history -a` (the house's read of the 33 commits, #22
    // comment 6307351617, item 9).
    const x = await realSession('/bin/bash', { login: false });
    const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
    try {
      x.session.input(`${line}\n`, { principal: AGENT });
      await until(() => output().includes('ran-own-42'), 5000, 'the line ran its own history -a');
      assert.equal(x.session.info().state, 'busy', 'busy while the typed command sleeps');
      await until(() => x.session.listRuns().every((r) => r.state === 'exited' || r.state === 'lost'), 12_000, 'ended');
      assert.ok(x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 'the typed Run ended exited');
      assert.equal((await x.run('echo back')).text.trim(), 'back');
    } finally {
      await x.close();
    }
  });
}

for (const line of ['PROMPT_COMMAND="history -a"', 'PROMPT_COMMAND="if true; then history -a; fi"', 'echo x; PROMPT_COMMAND="history -a"']) {
  test(`/bin/bash: a typed line ending in a PROMPT_COMMAND assignment (${line}) is closed at the next prompt, and the next Run goes on`, { skip: !hasShell('/bin/bash') }, async () => {
    // Here the heal is the only closer: the new value runs at the next prompt in place of our hook.
    // A flag that stood the heal down for the whole line left this Run open and the next command's
    // start ignored (the reviewer's read of 2f32e8a..a088780, #22); the heal now stands down only for
    // a command the line itself runs, and a command named only inside the assignment's quoted value
    // does not count.
    const x = await realSession('/bin/bash', { login: false });
    try {
      x.session.input(`${line}\n`, { principal: AGENT });
      await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 5000, 'the typed Run ended');
      const back = await x.run('echo back');
      assert.deepEqual([back.state, back.exit, back.text.trim()], ['exited', 0, 'back']);
      assert.equal(x.session.listRuns().filter((r) => r.origin === 'agent').length, 1, 'one typed Run');
      assert.ok(x.session.listRuns().every((r) => r.state === 'exited'), 'nothing left running');
    } finally {
      await x.close();
    }
  });
}

for (const [kind, assignment] of [
  ['whitespace', 'PROMPT_COMMAND="   "$(exit 5)'],
  ['a comment', 'PROMPT_COMMAND="# nothing runs"$(exit 5)'],
  ['an array of noncommands', 'PROMPT_COMMAND=("   " "# nothing runs"$(exit 5))'],
  ['continued comment', String.raw`PROMPT_COMMAND=$'\\\n# nothing runs'$(exit 5)`],
] as const) {
  test(`/bin/bash: a commandless but nonempty PROMPT_COMMAND (${kind}) cannot turn an uncertain exit into success`, { skip: !hasShell('/bin/bash') }, async () => {
    const x = await realSession('/bin/bash', { login: false });
    try {
      // An earlier DEBUG firing saves zero. The final assignment installs a commandless
      // prompt value but its substitution exits 5. Nothing runs at the prompt to attest it.
      const line = `echo own; PROMPT_COMMAND=true; true; ${assignment}`;
      const before = x.session.listRuns().length;
      x.session.input(`${line}\n`, { principal: AGENT });
      await until(() => x.session.listRuns().slice(before).some((r) => r.origin === 'agent' && (r.state === 'exited' || r.state === 'lost')), 5000, 'the typed Run to settle at its prompt');
      const typed = x.session.listRuns().slice(before).find((r) => r.origin === 'agent')!;
      assert.deepEqual({ state: typed.state, exit: typed.exit, reason: typed.reason }, { state: 'lost', exit: undefined, reason: 'prompt-without-end-mark' }, 'a saved zero is not the final exit');
      await until(() => x.session.shellAvailable().ok, 3000, 'the shell to return to its prompt');
      const next = await x.run('echo recovered', 4000);
      assert.deepEqual([next.state, next.exit, next.text.trim()], ['exited', 0, 'recovered']);
    } finally {
      await x.close();
    }
  });
}

test('/bin/bash: an array cannot certify a typed line when its prompt hook was replaced', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { login: false });
  try {
    const line = 'echo own; PROMPT_COMMAND=true; true; PROMPT_COMMAND=("   " "true"$(exit 5))';
    const before = x.session.listRuns().length;
    x.session.input(`${line}\n`, { principal: AGENT });
    await until(() => x.session.listRuns().slice(before).some((r) => r.origin === 'agent' && (r.state === 'exited' || r.state === 'lost')), 5000, 'the mixed-array line to settle');
    const typed = x.session.listRuns().slice(before).find((r) => r.origin === 'agent')!;
    assert.deepEqual([typed.state, typed.reason], ['lost', 'prompt-without-end-mark'], 'the user prompt array supplies no authenticated end mark');
    const next = await x.run('echo recovered', 4000);
    assert.deepEqual([next.state, next.exit, next.text.trim()], ['exited', 0, 'recovered']);
  } finally {
    await x.close();
  }
});

test('/bin/bash: an associative PROMPT_COMMAND is inert on Bash 5.1+', { skip: !hasShell('/bin/bash') }, async (t) => {
  const [major = 0, minor = 0] = execFileSync('/bin/bash', ['-c', 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).split('.').map(Number);
  if (!(major > 5 || (major === 5 && minor >= 1))) return t.skip('associative prompt commands are a Bash 5.1+ case');
  const x = await realSession('/bin/bash', { login: false });
  try {
    const line = 'echo own; PROMPT_COMMAND=true; true; unset PROMPT_COMMAND; declare -A PROMPT_COMMAND=([x]=true)';
    const before = x.session.listRuns().length;
    x.session.input(`${line}\n`, { principal: AGENT });
    await until(() => x.session.listRuns().slice(before).some((r) => r.origin === 'agent' && (r.state === 'exited' || r.state === 'lost')), 5000, 'the associative prompt line to settle');
    const typed = x.session.listRuns().slice(before).find((r) => r.origin === 'agent')!;
    assert.deepEqual([typed.state, typed.reason], ['lost', 'prompt-without-end-mark'], 'associative values were not run at the prompt');
    const next = await x.run('echo recovered', 4000);
    assert.deepEqual([next.state, next.exit, next.text.trim()], ['exited', 0, 'recovered']);
  } finally {
    await x.close();
  }
});

test('/bin/bash: promptvars off still marks successive empty prompts and admits the next Run', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': "shopt -u promptvars\nPS1='PV-OFF> '\n" } });
  try {
    const starts = () => prompts(x.journal.since(0).events, 'start');
    const visible = () => x.journal.since(0).events.flatMap((e) => e.type === 'output' && e.stream === 'pty' ? [e.data] : []).join('').split('PV-OFF> ').length - 1;
    const before = starts();
    const prompt = visible();
    assert.ok(prompt >= 1, 'the initial prompt is visible with promptvars off');
    const observed: number[] = [];
    for (let i = 1; i <= 2; i++) {
      x.session.input('\n', { principal: AGENT });
      await until(() => visible() >= prompt + i, 5000, `empty prompt ${i} to become visible`);
      observed.push(starts());
    }
    assert.deepEqual(observed, [before + 1, before + 2], 'each visible prompt has its own keyed A mark');
    assert.equal(x.session.shellAvailable().ok, true);
    const next = await x.run('echo after-empty', 5000);
    assert.deepEqual([next.state, next.exit, next.text.trim()], ['exited', 0, 'after-empty']);
  } finally {
    await x.close();
  }
});

test('/bin/bash: PS1 still expands the command status after its prompt-start prefix', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { rc: { '.bashrc': "PS1='[ps1=$?]$ '\n" }, login: false });
  try {
    const before = prompts(x.journal.since(0).events, 'end');
    assert.equal((await x.run('false')).exit, 1);
    await until(() => prompts(x.journal.since(0).events, 'end') > before, 3000, 'the prompt after false to finish');
    await x.session.screen.settled();
    const shown = x.session.snapshot().lines.filter((l) => l.includes('[ps1='));
    assert.match(shown.at(-1) ?? '', /\[ps1=1\]/, `the latest user PS1 sees the line's exit; screen: ${JSON.stringify(shown)}`);
  } finally {
    await x.close();
  }
});

test('/bin/bash: a negated status under set -e survives the PS1 marks', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { login: false });
  try {
    assert.equal((await x.run('set -e')).exit, 0);
    const before = x.session.listRuns().length;
    x.session.input('! true\n', { principal: AGENT });
    await until(() => x.session.listRuns().slice(before).some((r) => r.origin === 'agent' && r.state === 'exited'), 5000, 'the negated typed line to finish at its prompt');
    const typed = x.session.listRuns().slice(before).find((r) => r.origin === 'agent')!;
    assert.equal(typed.exit, 1, 'Bash keeps the negated exit as the Run status');
    const next = await x.run('echo still-here', 4000);
    assert.deepEqual([next.state, next.exit, next.text.trim()], ['exited', 0, 'still-here'], 'the shell survives a nonzero prompt status under errexit');
  } finally {
    await x.close();
  }
});

test('/bin/bash: a typed line that replaces PROMPT_COMMAND last loses its unobserved exit, and the prompt stays usable', { skip: !hasShell('/bin/bash') }, async () => {
  // The line and the prompt can both run `true`: DEBUG's earlier saved status cannot certify
  // the typed line after it replaces the hook. PS1 marks the next prompt without an end mark,
  // making the Run lost. An empty replacement has the same outcome. The next line heals the hook.
  const x = await realSession('/bin/bash', { login: false });
  try {
    fs.mkdirSync(path.join(x.tmp, 'sub'));
    const initialCwd = x.session.info().cwd;
    for (const [line, want] of [
      ['cd sub; echo x-$((40+2)); PROMPT_COMMAND=true; true; PROMPT_COMMAND=true$(exit 4)', { state: 'lost', reason: 'prompt-without-end-mark' }],
      ['echo y-$((40+2)); PROMPT_COMMAND=true; true; PROMPT_COMMAND=$(exit 5)', { state: 'lost', reason: 'prompt-without-end-mark' }],
    ] as const) {
      const before = x.session.listRuns().length;
      x.session.input(`${line}\n`, { principal: AGENT });
      await until(() => x.session.listRuns().slice(before).some((r) => r.origin === 'agent' && (r.state === 'exited' || r.state === 'lost')), 5000, `the typed Run ended at its prompt: ${line}`);
      const typed = x.session.listRuns().slice(before).find((r) => r.origin === 'agent')!;
      assert.deepEqual({ state: typed.state, ...(typed.exit !== undefined && { exit: typed.exit }), ...(typed.reason !== undefined && { reason: typed.reason }) }, want, line);
      await until(() => x.session.shellAvailable().ok, 3000, `the session went idle: ${line}`);
    }
    assert.equal(x.session.info().cwd, initialCwd, 'no authenticated cwd mark followed those lost Runs');
    const back = await x.run('pwd; echo back', 4000);
    assert.deepEqual([back.state, back.exit], ['exited', 0]);
    assert.match(back.text, /\/sub/, 'the shell itself is still in the directory the lost line entered');
    assert.match(back.text, /back/, 'the next Run executes after the hook heals');
    await until(() => /\/sub$/.test(x.session.info().cwd), 3000, 'the healed prompt publishes its cwd mark');
    assert.match(x.session.info().cwd, /\/sub$/, 'the authenticated prompt updates the recorded cwd');
    assert.equal(x.session.listRuns().filter((r) => r.origin === 'agent').length, 2, 'one Run per typed line');
  } finally {
    await x.close();
  }
});

test('/bin/bash: healing a missed hook preserves a nonempty user prompt command', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { login: false });
  try {
    const stamp = path.join(x.tmp, 'user-prompt-stamps');
    const setupEnd = prompts(x.journal.since(0).events, 'end');
    assert.equal((await x.run(`user_pcstamp() { printf x >> ${JSON.stringify(stamp)}; }`)).exit, 0);
    await until(() => prompts(x.journal.since(0).events, 'end') > setupEnd, 5000, 'the setup command prompt to finish');
    const before = x.session.listRuns().length;
    const beforeEnd = prompts(x.journal.since(0).events, 'end');
    x.session.input('user_pcstamp; PROMPT_COMMAND=user_pcstamp; user_pcstamp; PROMPT_COMMAND=user_pcstamp$(exit 4)\n', { principal: AGENT });
    await until(() => x.session.listRuns().slice(before).some((r) => r.origin === 'agent' && r.state === 'lost'), 5000, 'the typed line to become lost at its missed prompt');
    await until(() => prompts(x.journal.since(0).events, 'end') > beforeEnd, 5000, 'the missed-hook prompt to finish');
    const size = () => fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').length : 0;
    assert.ok(size() >= 3, 'the user prompt command ran after the typed line');
    const previous = size();
    const nextEnd = prompts(x.journal.since(0).events, 'end');
    const next = await x.run('echo following', 4000);
    assert.deepEqual([next.state, next.exit, next.text.trim()], ['exited', 0, 'following']);
    await until(() => prompts(x.journal.since(0).events, 'end') > nextEnd, 5000, 'the healed prompt to finish');
    assert.equal(size(), previous + 1, 'the user prompt part runs once at the next prompt');
  } finally {
    await x.close();
  }
});

test('/bin/bash: a typed line that runs a prompt command and then installs it ends at the next prompt, and the session goes idle', { skip: !hasShell('/bin/bash') }, async () => {
  // `history -a; PROMPT_COMMAND="history -a"` runs history -a now, then installs it. At the next
  // prompt the installed PROMPT_COMMAND folds and runs; that fold is the prompt, so the open typed
  // Run's D mark belongs before it. Left unclosed, the session stayed busy for good until someone
  // typed another line (the house's read, #22 comment 6269901528).
  const x = await realSession('/bin/bash', { login: false });
  try {
    x.session.input('echo typed-$((40+2)); history -a; PROMPT_COMMAND="history -a"\n', { principal: AGENT });
    await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 6000, 'the typed Run ended');
    await until(() => x.session.shellAvailable().ok, 3000, 'the session went idle');
    assert.equal(x.session.info().state, 'idle');
    const back = await x.run('echo back', 4000);
    assert.deepEqual([back.state, back.exit, back.text.trim()], ['exited', 0, 'back'], 'a Run runs within a second');
    assert.equal(x.session.listRuns().filter((r) => r.origin === 'agent').length, 1, 'one typed Run');
  } finally {
    await x.close();
  }
});
