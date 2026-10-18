/**
 * Real bash 3.2 and zsh against the user's rc files (a fake HOME): another shell
 * integration in the rc, nested shells, `exec`, PROMPT_COMMAND and DEBUG-trap
 * interplay, bash-preexec, XDG ZDOTDIR layouts, login files, prompt rebuilders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
