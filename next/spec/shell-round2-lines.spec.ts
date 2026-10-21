/**
 * Real shells, second review: daemon lines that never merge with what the line editor
 * holds (ss-1), PROMPT_COMMAND emptied, unset or turned into an array (ss-3, ss-9), the
 * marker strategy after an aborted line (ss-5), fish's first Run as marks appear (ss-12),
 * the marker strategy's start mark, and a key that never reaches a reader (atc-3). Every
 * shell runs with a fake HOME.
 *
 * bash >= 5.1 is not on macOS: set TSM_TEST_BASH5 to a bash 5 binary to run its tests.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT, hasShell, realSession, until, type Real } from './fake-shell.js';
import { sleep } from './testhost.js';

const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);
const BASH5 = process.env.TSM_TEST_BASH5 && hasShell(process.env.TSM_TEST_BASH5) ? process.env.TSM_TEST_BASH5 : undefined;
const SHELLS = ['/bin/bash', '/bin/zsh', ...(FISH ? [FISH] : [])].filter(hasShell);

/** Admit (waiting out prompt-pending), await, and return the Run with its transcript. */
async function run(x: Real, line: string, wait = 5000) {
  return x.run(line, wait);
}

for (const shell of SHELLS) {
  const name = shell.split('/').pop()!;

  test(`${name}: ss-1: typeahead the editor shows after a Run blocks the next run as human editing; cleared, the run is clean`, async () => {
    const x = await realSession(shell);
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 1', principal: AGENT });
      assert.ok(a.admitted);
      await sleep(300);
      x.session.input('echo PARTIAL', { principal: AGENT });
      await x.session.awaitRun(a.run.runId, 3000);
      await until(() => !x.session.shellAvailable().ok && (x.session.shellAvailable() as { reason: string }).reason === 'human-editing', 3000, 'human editing');
      x.session.input('\x15', { principal: AGENT });
      const r = await run(x, 'echo hi');
      assert.deepEqual([r.state, r.exit, r.text], ['exited', 0, 'hi']);
      assert.ok(!x.session.listRuns().some((q) => /PARTIAL/.test(q.line ?? '')), 'nothing merged, nothing ran');
    } finally {
      await x.close();
    }
  });

  test(`${name}: ss-1: a stale line with the cursor moved left is cleared whole before the daemon's line`, async () => {
    const x = await realSession(shell, { editingStaleMs: 300 });
    try {
      x.session.input('echo hello', { principal: AGENT });
      x.session.input('\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D', { principal: AGENT });
      await sleep(500);
      const r = await run(x, 'echo after-stale');
      assert.deepEqual([r.state, r.exit, r.text], ['exited', 0, 'after-stale']);
      assert.equal(x.session.listRuns().length, 1);
    } finally {
      await x.close();
    }
  });

  if (!shell.endsWith('fish')) {
    test(`${name}: ss-1: in vi command mode the daemon's line is still typed into an empty editor in insert mode`, async () => {
      const x = await realSession(shell, { editingStaleMs: 300 });
      try {
        await run(x, shell.endsWith('zsh') ? 'bindkey -v' : 'set -o vi');
        x.session.input('echo vi', { principal: AGENT });
        await sleep(100);
        x.session.input('\x1b', { principal: AGENT });
        await sleep(500);
        const r = await run(x, 'echo after-vi');
        assert.deepEqual([r.state, r.exit, r.text], ['exited', 0, 'after-vi']);
      } finally {
        await x.close();
      }
    });
  }
}

for (const bash of ['/bin/bash', ...(BASH5 ? [BASH5] : [])]) {
  test(`${bash}: ss-3: PROMPT_COMMAND= and unset PROMPT_COMMAND end their Run lost and heal at that prompt; the next command keeps its own exit`, async () => {
    const x = await realSession(bash, { rc: { '.bash_profile': 'PROMPT_COMMAND="echo USER-HOOK >> $HOME/hook.log"\n' } });
    try {
      for (const line of ['PROMPT_COMMAND=', 'unset PROMPT_COMMAND']) {
        const r = await run(x, line);
        assert.deepEqual([r.state, r.reason], ['lost', 'prompt-without-end-mark'], line);
        const after = await run(x, 'sh -c "exit 7"');
        assert.deepEqual([after.state, after.exit], ['exited', 7], `after ${line}`);
      }
      x.session.input('sh -c "exit 42"\r', { principal: AGENT });
      await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 3000, 'typed Run');
      assert.equal(x.session.listRuns().find((r) => r.origin === 'agent')!.exit, 42, 'the typed line is a Run with its own exit');
      const cleared = await run(x, 'cat $HOME/hook.log | wc -l');
      const before = Number(cleared.text.trim());
      await run(x, 'true');
      assert.equal(Number((await run(x, 'cat $HOME/hook.log | wc -l')).text.trim()), before, 'the user emptied PROMPT_COMMAND: their hook stays gone');
    } finally {
      await x.close();
    }
  });
}

test('bash >= 5.1 (TSM_TEST_BASH5): ss-9: an array PROMPT_COMMAND makes no phantom Runs, and every element runs once per prompt', { skip: BASH5 === undefined ? 'set TSM_TEST_BASH5 to a bash 5 binary' : false }, async () => {
  const rc = "PROMPT_COMMAND='history -a'\n__vte_osc7() { echo VTE >> $HOME/vte.log; }\nPROMPT_COMMAND+=(__vte_osc7 'echo TWO >> $HOME/two.log')\n";
  const x = await realSession(BASH5!, { rc: { '.bash_profile': rc } });
  try {
    for (const line of ['echo first', 'echo second', 'PROMPT_COMMAND+=("echo ADDED >> $HOME/added.log")', 'echo third']) {
      const r = await run(x, line);
      assert.equal(r.state, 'exited', `${line}: ${r.state} ${r.reason ?? ''}`);
    }
    assert.ok(x.session.listRuns().every((r) => r.origin === 'self'), 'no phantom Runs');
    const count = async (f: string) => Number((await run(x, `wc -l < $HOME/${f}`)).text.trim());
    assert.ok(await x.session.waitAvailable(3000));
    const prompts = x.journal.since(0).events.filter((e) => e.type === 'prompt' && e.phase === 'start').length;
    assert.equal(await count('vte.log'), prompts, 'once per prompt');
    assert.equal(await count('two.log'), prompts + 1);
    assert.ok((await count('added.log')) >= 2);
  } finally {
    await x.close();
  }
});

test('/bin/dash: ss-5: a syntax error or a failing special builtin under the marker strategy reports its status; nothing wedges', { skip: !hasShell('/bin/dash') }, async () => {
  const x = await realSession('/bin/dash');
  try {
    assert.equal(x.session.integration, 'none');
    for (const line of ['echo (', 'readonly RO=1; RO=2', 'set -o nosuchopt']) {
      const r = await run(x, line, 3000);
      assert.equal(r.state, 'exited', `${line}: ${r.state}`);
      assert.equal(r.exit, 2, line);
    }
    assert.equal((await run(x, 'echo fine')).text, 'fine');
  } finally {
    await x.close();
  }
});

test('fish: ss-12: the first Run of a none-to-rich transition keeps its output', { skip: FISH === undefined ? 'fish is not installed' : false }, async () => {
  const x = await realSession(FISH!, { integrationGraceMs: 800, rc: { '.config/fish/conf.d/aaa-slow.fish': 'sleep 2\n' } });
  try {
    assert.equal(x.session.integration, 'none');
    const r = await run(x, 'echo first; echo second', 8000);
    // The shell was still starting when the line was typed: the terminal echoed it, then fish printed its banner and
    // showed the line again at its first prompt. The command file's first line prints the Run's start mark after all
    // of that, and the output is cut up to it (the house's read of the 33 commits, #22, comment 6307351104, item 6).
    assert.deepEqual([r.state, r.exit], ['exited', 0]);
    assert.equal(r.text, 'first\nsecond');
    await until(() => x.session.integration === 'rich', 3000, 'rich');
    assert.equal((await run(x, 'echo third')).text, 'third');
  } finally {
    await x.close();
  }
});

// The marker strategy's start mark (the house's read of the 33 commits, #22, comment 6307351104, items 3, 6 and 9, and its
// answer 2), in dash and in bash run as sh, a readline sh with `fc` as macOS's /bin/sh is (dash has no `fc`).
const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-marker-start-'));
after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
const bashAsSh = path.join(markerDir, 'sh');
fs.symlinkSync('/bin/bash', bashAsSh);
const slowRc = path.join(markerDir, 'slow.rc');
fs.writeFileSync(slowRc, 'sleep 1\necho "Welcome, slow shell"\n');
for (const [name, shell] of [...(hasShell('/bin/dash') ? [['dash', '/bin/dash']] : []), ['bash as sh', bashAsSh]] as const) {
  test(`${name}: the marker strategy cuts at the start mark its command file prints: a still-starting shell's banner and second echo, the typed line's and the end mark's traces under set -x${name === 'dash' ? '' : ', and nothing before a history line with the echo off'}`, async () => {
    // $ENV runs before the first prompt, and a shell without integration takes the line at once: it is typed while the
    // shell sleeps, echoed by the terminal, then the banner, then (bash) the prompt shows it again.
    const x = await realSession(shell, { env: { ENV: slowRc } });
    try {
      assert.equal(x.session.integration, 'none');
      assert.equal((await run(x, 'echo first; echo second', 8000)).text, 'first\nsecond', 'item 6');
      // Item 9: no `+ command . <file>` at the head, no dangling `+ echo ` at the end, in the Run that turns tracing on and after.
      assert.match((await run(x, 'set -x; echo on')).text, /^\++ echo on\non$/);
      assert.match((await run(x, 'echo traced')).text, /^\++ echo traced\ntraced$/);
      await run(x, 'set +x');
      if (name !== 'dash') {
        // Item 3: `fc -l -1` prints the typed line, with the Run's nonce, after output began; what came before it stays.
        await run(x, 'stty -echo');
        assert.match((await run(x, 'echo out-1; fc -l -1; echo out-2')).text, /^out-1\n.*EXI""T.*\nout-2$/);
        await run(x, 'stty echo');
      }
    } finally {
      await x.close();
    }
  });
}

for (const shell of SHELLS) {
  const name = shell.split('/').pop()!;
  test(`${name}: atc-3: the mark key is in no journaled event and on no screen, even when the shell prints its variables`, async () => {
    const x = await realSession(shell);
    try {
      const key = (x.session as unknown as { markKey: string }).markKey;
      const dump = shell.endsWith('fish') ? 'set --show __tsm_key' : shell.endsWith('zsh') ? 'typeset __tsm_key __tsm_b' : 'set | grep "^__tsm_"';
      const r = await run(x, dump);
      assert.equal(r.state, 'exited');
      assert.match(r.text, /\[redacted\]/);
      await x.session.screen.settled();
      assert.deepEqual(x.journal.since(0).events.filter((e) => JSON.stringify(e).includes(key)).map((e) => e.type), []);
      assert.ok(!x.session.snapshot().lines.join('\n').includes(key));
    } finally {
      await x.close();
    }
  });
}
