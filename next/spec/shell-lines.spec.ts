/**
 * Real bash 3.2 and zsh: every line shape that used to wedge a session completes
 * with a truthful state (the temp-file route, G6; Runs that never start, G3/G4);
 * program output cannot forge marks (G2/G7); the cwd is exact; the session's history
 * is its own; the environment is clean. The "user's" rc files live in a fake HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasShell, realSession, until, withoutSetpgidWarning } from './fake-shell.js';

const shells = ['/bin/bash', '/bin/zsh'].filter(hasShell);

for (const shell of shells) {
  test(`${shell}: G3/G4/G6 (core-1, core-2, shell-1, shell-4, tg-3, tg-14, api-8): every line shape completes truthfully and nothing wedges`, async () => {
    const x = await realSession(shell);
    try {
      const shapes: Array<[string, (r: { state: string; exit?: number; text: string }) => void]> = [
        ['# a comment', (r) => assert.equal(r.exit, 0)],
        ['   ', (r) => assert.equal(r.exit, 0)],
        ['', (r) => assert.equal(r.exit, 0)],
        ['echo (', (r) => assert.notEqual(r.exit, 0)],
        ['(echo sub)', (r) => assert.equal(r.text, 'sub')],
        ['echo "Done!"', (r) => assert.equal(r.text, 'Done!')],
        ['echo "x!!y" "!$"', (r) => assert.equal(r.text, 'x!!y !$')],
        ["printf '[%s]' 'a\tb' | od -c | head -1", (r) => assert.match(r.text, /\[ +a +\\t +b +\]/, 'the tab reached printf')],
        ['fi', (r) => assert.notEqual(r.exit, 0)],
        ["echo 'oops", (r) => assert.notEqual(r.exit, 0)],
        ['f() { echo hi; }', (r) => assert.equal(r.exit, 0)],
        ['f', (r) => assert.equal(r.text, 'hi')],
        ['sh -c "exit 42"', (r) => assert.equal(r.exit, 42)],
      ];
      for (const [line, check] of shapes) {
        const r = await x.run(line);
        assert.equal(r.state, 'exited', `${JSON.stringify(line)} → ${r.state} ${r.reason ?? ''}`);
        assert.equal(r.line, line, 'the Run records the requested text');
        check(r);
      }
      assert.equal(x.session.listRuns().length, shapes.length, 'no phantom Runs');
      assert.ok(await x.session.waitAvailable(2000), 'the prompt confirmed the shell is available');
      assert.equal(x.session.state, 'idle');
    } finally {
      await x.close();
    }
  });

  test(`${shell}: G2/G4/G7 (core-3, emu-6, shell-3): marks in program output end nothing and move nothing`, async () => {
    const x = await realSession(shell);
    try {
      const forged = "printf '\\033]133;D;0\\007\\033]133;A\\007\\033]7;file://remote/srv\\007\\033]633;P;Cwd=/srv\\007\\033]133;D;0;k=0000\\007'";
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: `${forged}; sleep 1; sh -c 'exit 3'`, principal: 'agent:a@test' });
      assert.ok(a.admitted);
      const early = await x.session.awaitRun(a.run.runId, 500);
      assert.equal(early.state, 'running', 'still running after the forged D and A');
      const busy = x.session.admit({ target: 'shell', line: 'echo intruder', principal: 'agent:a@test' });
      assert.ok(!busy.admitted, 'the forged prompt did not open the shell for the next Run');
      const r = await x.session.awaitRun(a.run.runId, 5000);
      assert.equal(r.state, 'exited');
      assert.equal(r.exit, 3, 'the exit the shell observed');
      assert.equal(x.session.cwd, x.tmp, 'the cwd did not move');
    } finally {
      await x.close();
    }
  });

  test(`${shell}: G7 (emu-14, shell-16): the cwd is exact — a directory named like "a%41b" stays that`, async () => {
    const x = await realSession(shell);
    try {
      fs.mkdirSync(path.join(x.tmp, 'a%41b b;c'));
      await x.run("cd 'a%41b b;c'");
      await x.session.waitAvailable(2000);
      assert.equal(x.session.cwd, path.join(x.tmp, 'a%41b b;c'));
      const p = x.session.admit({ target: 'process', argv: ['/bin/pwd'], principal: 'agent:a@test' });
      assert.ok(p.admitted);
      const r = await x.session.awaitRun(p.run.runId, 3000);
      assert.equal(r.state, 'exited');
      assert.equal(r.exit, 0);
      // The process Run ran in the cwd the `cd` moved to: its output is that directory (the house's
      // read of a6d0c35, #22: the test asserted only the exit, not where it ran). /bin/pwd prints the
      // physical path, so compare against the resolved one (macOS /var is a symlink to /private/var).
      assert.equal((await x.session.runTranscript(r.runId)).text.trim(), fs.realpathSync(path.join(x.tmp, 'a%41b b;c')));
    } finally {
      await x.close();
    }
  });

  test(`${shell}: shell-12: the session keeps its own history; daemon plumbing never enters it; the user's history is untouched`, async () => {
    const userHist = shell.endsWith('zsh') ? '.zsh_history' : '.bash_history';
    const rc = shell.endsWith('zsh') ? { '.zshrc': `HISTFILE=$HOME/${userHist}\nSAVEHIST=100\nHISTSIZE=100\nsetopt inc_append_history\n` } : { '.bashrc': `HISTFILE=$HOME/${userHist}\nshopt -s histappend\nPROMPT_COMMAND='history -a'\n` };
    const x = await realSession(shell, { rc, login: false });
    try {
      assert.equal((await x.run('echo "$HISTFILE"')).text, path.join(x.tmp, 'tsm-history-real'));
      x.session.input('echo typed-by-a-human\n', { principal: 'agent:a@test' });
      await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.line === 'echo typed-by-a-human'), 5000, 'the typed command recorded as a Run');
      await x.run('true');
      const hist = await x.run(shell.endsWith('zsh') ? 'fc -ln 1' : 'history');
      assert.match(hist.text, /echo typed-by-a-human/, 'typed commands are in the session history');
      assert.doesNotMatch(hist.text, /tsm-cmd-/, 'no plumbing in history');
      // While the session (and its fake HOME) still exist: the user's own history file was not written
      // by it. After close the fake HOME is gone, so this check belongs here (the house's read of a6d0c35, #22).
      assert.ok(!fs.existsSync(path.join(x.home, userHist)) || !/tsm-cmd|typed-by/.test(fs.readFileSync(path.join(x.home, userHist), 'utf8')), "the user's history file was not written");
    } finally {
      await x.close();
    }
  });

  test(`${shell}: G7/G26 (core-7, api-4, jr-6, sec-4, shell-2): the shell sees neither the daemon's credentials nor the launching terminal's identity, nor its own mark key`, async () => {
    const x = await realSession(shell, {
      daemonEnv: { ...process.env, TSM_TOKEN: 'daemon-secret-4242', TSM_URL: 'ws://x', GHOSTTY_RESOURCES_DIR: '/nonexistent/ghostty', TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-x,1,0', ITERM_SESSION_ID: 'w0' },
    });
    try {
      const r = await x.run('echo "[${TSM_TOKEN-}][${TSM_URL-}][${GHOSTTY_RESOURCES_DIR-}][${TMUX-}][${ITERM_SESSION_ID-}][${TSM_MARK_KEY-}][$TERM_PROGRAM][$COLORTERM][$TERM]"');
      assert.equal(r.text, '[][][][][][][tsm][truecolor][xterm-256color]');
      const env = await x.run('env | grep -c "^TSM_" || true');
      assert.equal(env.text, '0', 'no TSM_* variable reaches programs');
      await x.session.captureEnv('agent:a@test');
      assert.ok(!JSON.stringify(x.journal.since(0).events).includes('daemon-secret-4242'));
    } finally {
      await x.close();
    }
  });

  test(`${shell}: shell-6: set -u and set -euo pipefail in the session shell keep integration working`, async () => {
    const x = await realSession(shell);
    try {
      assert.equal((await x.run(shell.endsWith('zsh') ? 'setopt nounset' : 'set -u')).exit, 0);
      assert.equal((await x.run('echo one')).text, 'one');
      assert.equal((await x.run('set -euo pipefail')).exit, 0);
      const two = await x.run('echo two');
      assert.equal(two.state, 'exited');
      assert.equal(two.text, 'two');
      assert.equal((await x.run('set +euo pipefail')).exit, 0);
      assert.equal((await x.run('false')).exit, 1, 'the shell survived and still reports exits');
      assert.ok(x.session.listRuns().every((r) => r.origin === 'self'), 'no phantom Runs');
    } finally {
      await x.close();
    }
  });
}

test('/bin/zsh: emu-11/shell-8: output without a trailing newline has no PROMPT_SP "%" in its transcript', { skip: !hasShell('/bin/zsh') }, async () => {
  const x = await realSession('/bin/zsh');
  try {
    assert.equal((await x.run('printf abc')).text, 'abc');
    assert.equal((await x.run('printf \'{"ok":true}\'')).text, '{"ok":true}');
    assert.equal((await x.run("printf 'x\\ny'")).text, 'x\ny');
    await x.session.screen.settled();
    assert.ok(x.session.snapshot().lines.some((l) => l.startsWith('abc%')), 'humans still see the partial-line mark on screen');
  } finally {
    await x.close();
  }
});

test('/bin/bash: emu-12/shell-10: a typed command that history did not keep is recorded as itself, not the previous entry', async () => {
  const x = await realSession('/bin/bash', { env: { HISTCONTROL: 'ignoreboth' }, login: false });
  try {
    const typedRuns = () => x.session.listRuns().filter((r) => r.origin === 'agent');
    x.session.input('echo first-command\n', { principal: 'agent:a@test' });
    await until(() => typedRuns().length >= 1, 5000, 'the first typed command recorded');
    x.session.input(' echo second-with-leading-space\n', { principal: 'agent:a@test' });
    await until(() => typedRuns().length >= 2, 5000, 'the second typed command recorded');
    const typed = typedRuns();
    assert.deepEqual(typed.map((r) => r.line), ['echo first-command', 'echo second-with-leading-space']);
  } finally {
    await x.close();
  }
});

test('/bin/bash: shell-10: after a bind -x widget at the prompt, the next daemon Run is still matched by its own line', async () => {
  // bash 3.2 has no READLINE_LINE, so its DEBUG trap cannot tell a widget from an
  // accepted line (bash-preexec has the same limit there): the widget's command is
  // recorded as a typed Run. What must never happen is that the history numbers it
  // leaves stale mislabel the daemon's own line (its 633;E comes from BASH_COMMAND).
  const x = await realSession('/bin/bash', { rc: { '.bashrc': `bind -x '"\\C-t": echo widget-ran'\n` }, login: false });
  try {
    const before = await x.run('echo before');
    assert.equal(before.text, 'before');
    const events = () => x.journal.since(0).events;
    const shown = () => events().flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
    const ended = () => events().find((e) => e.type === 'run.end' && e.runId === before.runId)?.seq ?? Number.POSITIVE_INFINITY;
    await until(() => events().some((e) => e.type === 'prompt' && e.phase === 'end' && e.seq > ended()), 5000, 'the prompt drawn after the Run');
    x.session.input('\x14', { principal: 'agent:a@test' });
    await until(() => shown().includes('widget-ran'), 5000, 'the widget ran');
    // Its output, which its echoed line doesn't hold, and not a Run of its own: on bash 3.2 the widget's command
    // opened the prompt's Run, so a line typed after it at the same prompt runs inside that Run.
    x.session.input("echo typ''ed\r", { principal: 'agent:a@test' });
    await until(() => shown().includes('typed'), 5000, 'the typed command ran');
    const r = await x.run('echo after', 3000);
    assert.equal(r.state, 'exited', JSON.stringify(r));
    assert.equal(r.text, 'after');
    assert.equal(r.line, 'echo after');
  } finally {
    await x.close();
  }
});

test("a Run's text loses bash 3.2's child-setpgid warning line, and nothing else", () => {
  const warning = 'bash: child setpgid (51915 to 51915): Operation not permitted';
  assert.equal(withoutSetpgidWarning(`${warning}\nsub`), 'sub');
  assert.equal(withoutSetpgidWarning(`one\r\n${warning}\r\ntwo`), 'one\r\ntwo');
  assert.equal(withoutSetpgidWarning(`sh: child setpgid (71753 to 71753): Operation not permitted\nit's "quoted"`), `it's "quoted"`);
  for (const kept of ['sub', `x ${warning}`, `${warning} and more`, 'bash: child setpgid (1 to 2): No such process',
    'ksh: child setpgid (1 to 1): Operation not permitted', '<<<PROBE:ab12::>>>']) {
    assert.equal(withoutSetpgidWarning(kept), kept);
  }
});
