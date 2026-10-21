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
import { startMark } from '../src/core/plumbing.js';
import { DEFAULT_GEOMETRY } from '../src/core/types.js';
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
      // A count that isn't a number says what the Run was and what the terminal showed: once in two macOS 22 runs of
      // one tree, the second count's text was no number, and the assertion gave only NaN (antra's run 39681219219).
      const count = async () => {
        const r = await run(x, 'cat $HOME/hook.log | wc -l');
        // The journal's last events, the output with the marks and Run events among it, as the session saw them.
        const seen = x.journal.since(0).events.slice(-60).map((e) => (e.type === 'output' ? `${e.seq} ${JSON.stringify(e.data)}` : `${e.seq} ${JSON.stringify(e).slice(0, 160)}`));
        assert.match(r.text, /^\s*\d+\s*$/, `the count's Run: ${JSON.stringify({ state: r.state, exit: r.exit, reason: r.reason, text: r.text })}\n${seen.join('\n')}`);
        return Number(r.text.trim());
      };
      const before = await count();
      await run(x, 'true');
      assert.equal(await count(), before, 'the user emptied PROMPT_COMMAND: their hook stays gone');
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
// The rc waits for a file the spec writes once the line is typed, so the banner comes after it.
const slowRc = path.join(markerDir, 'slow.rc');
fs.writeFileSync(slowRc, 'while [ ! -e "$TSM_SPEC_GATE" ]; do sleep 0.05; done\necho "Welcome, slow shell"\n');
for (const [name, shell] of [...(hasShell('/bin/dash') ? [['dash', '/bin/dash']] : []), ['bash as sh', bashAsSh]] as const) {
  test(`${name}: the marker strategy cuts at the start mark its command file prints: a still-starting shell's banner and second echo, the typed line's and the end mark's traces under set -x${name === 'dash' ? '' : ', and nothing before a history line with the echo off'}`, async () => {
    // $ENV runs before the first prompt, and a shell without integration takes the line at once: it is typed while the
    // shell waits in its rc, echoed by the terminal, then the banner, then (bash) the prompt shows it again. The rc waits
    // until the line is typed, where a 1 s sleep left the order to the session's start (ready at about 800 ms).
    const gate = path.join(markerDir, `gate-${name.replace(/ /g, '-')}`);
    const x = await realSession(shell, { env: { ENV: slowRc, TSM_SPEC_GATE: gate } });
    const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
    try {
      assert.equal(x.session.integration, 'none');
      const first = run(x, 'echo first; echo second', 8000);
      await until(() => output().includes('tsm-cmd-'), 5000, 'the line typed while the rc waits');
      fs.writeFileSync(gate, '');
      assert.equal((await first).text, 'first\nsecond', 'item 6');
      const seen = output();
      assert.ok(seen.indexOf('tsm-cmd-') < seen.indexOf('Welcome, slow shell'), `typed before the banner: ${JSON.stringify(seen.slice(0, 300))}`);
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

// The marker strategy's printf-built end mark and probe, and its start line's leftovers (the house's review of the 40 commits
// through f3750e4, PR #22, comment 6310921374, question 2 and the cutter's "left for later"), in dash, bash as sh, and zsh and
// fish started without their integration.
const MARKER = [
  ...(hasShell('/bin/dash') ? [{ name: 'dash', shell: '/bin/dash', fish: false }] : []),
  { name: 'bash as sh', shell: bashAsSh, fish: false },
  ...(hasShell('/bin/zsh') ? [{ name: 'zsh without its integration', shell: '/bin/zsh', fish: false }] : []),
  ...(FISH ? [{ name: 'fish without its integration', shell: FISH, fish: true }] : []),
];
for (const { name, shell, fish } of MARKER) {
  test(`${name}: under the marker strategy a trace with a PS4 of the body's own ends at the real mark, a cancel's probe leaves no trace, no temporary stays set, and a body of comments after a failed status keeps a set -e shell`, async () => {
    const x = await realSession(shell, { integration: false });
    try {
      assert.equal(x.session.integration, 'none');
      // The body turns tracing on with its own PS4 and its output has no line end: nothing of the end mark's command stays.
      const on = await run(x, fish ? 'set fish_trace 1; printf abc' : "PS4='>> '; set -x; printf abc");
      assert.deepEqual([on.state, on.exit], ['exited', 0]);
      assert.match(on.text, fish ? /^-*> printf abc\nabc$/ : /^>+ printf abc\nabc$/, JSON.stringify(on.text));
      const traced = await run(x, 'echo traced');
      assert.match(traced.text, fish ? /^-*> echo traced\ntraced$/ : /^>+ echo traced\ntraced$/, JSON.stringify(traced.text));
      // A cancel's probe, typed while tracing: the Run ends at the real answer, and neither the probe nor its trace is output.
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 5', principal: AGENT }, 3000);
      assert.ok(a.admitted);
      const nonce = x.session.listRuns().find((r) => r.runId === a.run.runId)!.nonce!;
      const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
      await until(() => output().includes(`<<<START:${nonce}:`), 3000, 'the command file ran');
      const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 1500 });
      assert.equal(c.state, 'cancelled', JSON.stringify(c));
      const cancelled = (await x.session.runTranscript(a.run.runId)).text;
      assert.doesNotMatch(cancelled, /printf|<<<|PRO/, JSON.stringify(cancelled));
      const after = await run(x, 'echo after');
      assert.match(after.text, fish ? /^-*> echo after\nafter$/ : /^>+ echo after\nafter$/, `the probe's answer is no later Run's output: ${JSON.stringify(after.text)}`);
      await run(x, fish ? 'set -e fish_trace' : 'set +x');
      // The start line's temporaries are gone, as the integrations' are.
      const left = await run(x, fish ? 'echo "[$__tsm_q]"; functions -q __tsm_start; and echo leaked; or echo clean' : 'echo "[${__tsm_q-unset}]"');
      assert.equal(left.text, fish ? '[]\nclean' : '[unset]');
      if (!fish) {
        // A failed status at the prompt, then a Run of comments: its start line restores none, so set -e keeps the shell.
        await run(x, 'set -e');
        x.session.input('! true\r', { principal: AGENT });
        const comment = await run(x, '# only a comment');
        assert.deepEqual([comment.state, comment.exit], ['exited', 0], JSON.stringify(comment));
        assert.equal((await run(x, 'echo alive')).text, 'alive');
        await run(x, 'set +e');
      }
    } finally {
      await x.close();
    }
  });
}

test('fish without its integration: a cancel’s probe that a long prompt wraps before its mark leaves no piece of its echo, wherever the margin falls', { skip: FISH === undefined ? 'fish is not installed' : false }, async () => {
  // CI's macOS runners (a long host name in fish's prompt): fish wraps the typed probe at the margin with a line end and a move
  // back up, writing the two cells before the margin again, and the cut, striking from the line where the mark began, kept
  // `[SIGINT]>  printf '%s>>>`. The prompt's length puts the margin inside `printf`, inside `'%s>>>`, and inside `"<<<`.
  for (const into of [4, 12, 19]) {
    const prompt = `${'p'.repeat(DEFAULT_GEOMETRY.cols - 11 - into)} [SIGINT]> `;
    const x = await realSession(FISH!, { integration: false, cols: DEFAULT_GEOMETRY.cols, rc: { '.config/fish/config.fish': `function fish_prompt; echo -n '${prompt}'; end\n` } });
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 5', principal: AGENT }, 3000);
      assert.ok(a.admitted);
      const nonce = x.session.listRuns().find((r) => r.runId === a.run.runId)!.nonce!;
      const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
      await until(() => output().includes(`<<<START:${nonce}:`), 3000, 'the command file ran');
      const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 1500 });
      assert.equal(c.state, 'cancelled', JSON.stringify(c));
      const text = (await x.session.runTranscript(a.run.runId)).text;
      assert.doesNotMatch(text, /printf|%s|<<<|PRO/, `margin ${into} cells into the typed line: ${JSON.stringify(text)}`);
    } finally {
      await x.close();
    }
  }
});

// The house's review of f3750e4..4f4c067 (PR #22, comment 6315636412), question 6 and the cutter's "left for later", in dash and
// bash run as sh: a probe typed into a program's prompt, and a trace sent past the typed lines' redirects by a BASH_XTRACEFD.
for (const [name, shell] of [...(hasShell('/bin/dash') ? [['dash', '/bin/dash']] : []), ['bash as sh', bashAsSh]] as const) {
  test(`${name}: a cancel's probe that a program read on its own prompt's line leaves the prompt: only the echo is struck`, async () => {
    // With `Continue? [y/N] ` printed and ^C ignored, the result showed only `not continuing`: the striker took the probe echo's
    // whole line, which suits a probe a shell answered at its prompt.
    const x = await realSession(shell);
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: "trap '' INT; printf 'Continue? [y/N] '; read x; echo not continuing; trap - INT", principal: AGENT }, 3000);
      assert.ok(a.admitted);
      const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
      await until(() => output().includes('Continue? [y/N] '), 3000, 'the program’s prompt');
      await x.session.cancel(a.run.runId, AGENT, { graceMs: 1500 });
      const r = await x.session.awaitRun(a.run.runId, 3000);
      assert.equal(r.exit, 0, JSON.stringify(r));
      assert.equal((await x.session.runTranscript(a.run.runId)).text, 'Continue? [y/N] ^C\nnot continuing');
    } finally {
      await x.close();
    }
  });

  // A program the Run started, and a subshell of the shell: the house's review of 4f4c067..a8b6f28 (PR #22, comment 6323055715),
  // question 7, found the subshell answering with the shell's own `$$`, so the Run ended cancelled and a queued Run ran inside it.
  for (const [reader, line] of [
    ['a reader', `sh -c 'trap "" INT QUIT; echo reader-ready; while read l; do eval "$l"; done'`],
    ['a subshell', `(trap "" INT QUIT; echo reader-ready; while read l; do eval "$l"; done)`],
  ] as const)
  test(`${name}: a probe ${reader} in the shell's own process group answers is no end: the Run runs on, and ends after the reader, by its end mark or the shell's own answer`, async () => {
    // An independent read of the fixes for #22: with job control off, a reader the Run started took the cancel's probe and
    // answered it, and the Run ended there and the shell counted as back while the reader held the terminal.
    const x = await realSession(shell);
    try {
      await run(x, 'set +m');
      const a = await x.session.admitWhenAvailable({ target: 'shell', line, principal: AGENT }, 3000);
      assert.ok(a.admitted);
      const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
      await until(() => output().includes('reader-ready'), 3000, 'the reader');
      const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 800 });
      assert.ok(output().includes(`<<<PROBE:${x.session.listRuns().find((r) => r.runId === a.run.runId)!.nonce!}:`), 'the reader answered a probe');
      assert.equal(c.state, 'running', JSON.stringify(c));
      assert.equal(x.session.shellAvailable().ok, false, 'the shell is not back');
      // The reader ends; bash runs the rest of the typed line, its end mark, and dash, which the ^C reached, abandoned it: a
      // second cancel's probe, answered by the shell itself now, ends the Run.
      x.session.input('exit\r', { principal: AGENT });
      let r = await x.session.awaitRun(a.run.runId, 1500);
      if (r.state === 'running') {
        await until(() => /\$ $/.test(output()), 3000, 'the shell’s prompt');
        await x.session.cancel(a.run.runId, AGENT, { graceMs: 800 });
        r = await x.session.awaitRun(a.run.runId, 3000);
      }
      assert.ok(r.state === 'exited' || r.state === 'cancelled', JSON.stringify(r));
      assert.doesNotMatch((await x.session.runTranscript(a.run.runId)).text, /PROBE|PRO""BE/);
      assert.equal((await run(x, 'echo back')).text, 'back');
    } finally {
      await x.close();
    }
  });

  test(`${name}: with a BASH_XTRACEFD and set -x on before the Run, nothing of the daemon's lines stays in a Run's result, and a last line with no line end stays`, async () => {
    // bash 4.1 and later write the trace to the BASH_XTRACEFD past the start line's and the end mark's redirects; macOS's 3.2
    // writes it to the redirected stderr, and the result is the same.
    const x = await realSession(shell);
    try {
      await run(x, 'exec 9>&2; BASH_XTRACEFD=9; set -x');
      assert.match((await run(x, 'printf abc')).text, /^\++ printf abc\nabc$/);
      assert.match((await run(x, 'false')).text, /^\++ false$/);
      // A status that is not 0 at the prompt (a line typed there failed): the start line keeps it through /bin/sh.
      x.session.input('false\r', { principal: AGENT });
      const kept = await run(x, 'echo "after $?"');
      assert.match(kept.text, /^\++ echo '?after 1'?\nafter 1$/, JSON.stringify(kept.text));
      // A cancel's probe: its pid's command substitution and its printf are traced past the redirect, and neither stays.
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 5', principal: AGENT }, 3000);
      assert.ok(a.admitted);
      const nonce = x.session.listRuns().find((r) => r.runId === a.run.runId)!.nonce!;
      const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
      await until(() => output().includes(`<<<START:${nonce}:`), 3000, 'the command file ran');
      assert.equal((await x.session.cancel(a.run.runId, AGENT, { graceMs: 1500 })).state, 'cancelled');
      const cancelled = (await x.session.runTranscript(a.run.runId)).text;
      assert.doesNotMatch(cancelled, /PPID|printf|<<</, JSON.stringify(cancelled));
      await run(x, 'set +x');
    } finally {
      await x.close();
    }
  });
}

test('a marker Run whose file another shell than the session’s program ran journals that shell on its run.end, which its history reads', { skip: !hasShell('/bin/dash') }, async () => {
  // The house's review of 4f4c067..a8b6f28 (PR #22, comment 6323055715), question 8: run.start names the session's program, here
  // a wrapper running dash in its own process group, and the start mark's `$$` rebound only the live record.
  const wrapper = path.join(markerDir, 'wrapper');
  fs.writeFileSync(wrapper, '#!/bin/sh\n/bin/dash +m -i\nexit\n', { mode: 0o755 });
  const x = await realSession(wrapper);
  try {
    assert.equal(x.session.integration, 'none');
    const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 5', principal: AGENT }, 3000);
    assert.ok(a.admitted);
    const nonce = x.session.listRuns().find((r) => r.runId === a.run.runId)!.nonce!;
    const output = () => x.journal.since(0).events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('');
    await until(() => output().includes(`<<<START:${nonce}:`), 3000, 'the command file ran');
    const c = await x.session.cancel(a.run.runId, AGENT, { graceMs: 800 });
    assert.equal(c.state, 'cancelled', JSON.stringify(c));
    const ends = x.journal.since(0).events.filter((e) => (e.type === 'run.start' || e.type === 'run.end') && e.runId === a.run.runId);
    const [start, end] = ends as Array<{ shellPid?: number }>;
    assert.ok(end!.shellPid !== undefined && end!.shellPid !== start!.shellPid, JSON.stringify(ends));
    assert.equal(end!.shellPid, Number(startMark(nonce).exec(output())![1]), 'the pid the start mark named');
    assert.equal(x.journal.runs.get(a.run.runId)!.shellPid, end!.shellPid, 'history reads it');
  } finally {
    await x.close();
  }
});
