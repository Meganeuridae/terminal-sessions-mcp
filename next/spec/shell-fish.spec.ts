/**
 * fish (§7): real integration through a vendor_conf.d snippet — keyed marks from
 * fish_preexec / fish_postexec / fish_prompt, a fish_prompt wrapper for B, daemon
 * lines through `eval (__tsm_collect '<file>' $status)`. Skipped when fish is not installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);
const skip = FISH === undefined ? 'fish is not installed' : false;

test('fish: G5/G6/G2 rich integration, observed exits, cwd, multi-line bodies, untouched `!`', { skip }, async () => {
  const x = await realSession(FISH!);
  try {
    assert.equal(x.session.integration, 'rich');
    assert.ok(await x.session.waitAvailable(2000), 'the prompt confirmed the shell is available');
    assert.equal(x.session.state, 'idle');
    const cases: Array<[string, (r: { exit?: number; text: string }) => void]> = [
      ['sh -c "exit 5"', (r) => assert.equal(r.exit, 5)],
      ['false', (r) => assert.equal(r.exit, 1)],
      ['echo $status', (r) => assert.equal(r.text, '1', "fish's own $status")],
      ['echo "x!!y" (echo sub)', (r) => assert.equal(r.text, 'x!!y sub')],
      ["printf '[%s]' 'a\tb' | od -c | head -1", (r) => assert.match(r.text, /\[ +a +\\t +b +\]/)],
      ['set -l v 1\nif test $v = 1\n  echo multi\nend', (r) => assert.equal(r.text, 'multi')],
      ['# a comment', (r) => assert.equal(r.exit, 0)],
      ['echo (', (r) => assert.notEqual(r.exit, 0)],
    ];
    for (const [line, check] of cases) {
      const r = await x.run(line);
      assert.equal(r.state, 'exited', `${JSON.stringify(line)} → ${r.state} ${r.reason ?? ''}`);
      check(r);
    }
    await x.run(`cd ${x.home}`);
    await x.session.waitAvailable(2000);
    assert.equal(x.session.cwd, x.home, 'the cwd follows the keyed 633;P;Cwd');
    assert.ok(x.session.listRuns().every((r) => r.origin === 'self'), 'no phantom Runs');
  } finally {
    await x.close();
  }
});

test('fish: G1/G2/G7/G26 typed commands are Runs; forged marks do nothing; the key and the daemon env stay out', { skip }, async () => {
  const x = await realSession(FISH!, { daemonEnv: { ...process.env, TSM_TOKEN: 'daemon-secret', GHOSTTY_RESOURCES_DIR: '/nonexistent' } });
  try {
    x.session.input('echo typed-at-the-prompt\r', { principal: AGENT });
    await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 3000, 'typed Run');
    assert.equal(x.session.listRuns()[0]!.line, 'echo typed-at-the-prompt');
    const forged = await x.run("printf '\\e]133;D;0\\a\\e]133;A\\a\\e]633;P;Cwd=/srv\\a'; sleep 1; sh -c 'exit 3'");
    assert.equal(forged.exit, 3);
    assert.equal(x.session.cwd, x.tmp);
    const env = await x.run('echo "[$TSM_MARK_KEY][$TSM_TOKEN][$GHOSTTY_RESOURCES_DIR][$TERM_PROGRAM]"');
    assert.equal(env.text, '[][][][tsm]');
  } finally {
    await x.close();
  }
});

test('fish: G29 cancel (running and right after admit) and shell-3/shell-17 nested fish and `exec fish`', { skip }, async () => {
  const x = await realSession(FISH!);
  try {
    let a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(a.admitted);
    await x.session.awaitRun(a.run.runId, 300);
    let c = await x.session.cancel(a.run.runId, AGENT);
    assert.equal(c.state, 'cancelled', JSON.stringify(c));
    assert.equal(x.session.run(a.run.runId).exit, 130);
    for (let i = 0; i < 3; i++) {
      a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 30', principal: AGENT }, 3000);
      assert.ok(a.admitted);
      c = await x.session.cancel(a.run.runId, AGENT);
      assert.equal(c.state, 'cancelled', `round ${i}: ${JSON.stringify(c)}`);
    }
    // A nested interactive fish: its prompts carry no key, so the outer Run keeps running.
    a = await x.session.admitWhenAvailable({ target: 'shell', line: FISH!, principal: AGENT }, 3000);
    assert.ok(a.admitted);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(x.session.run(a.run.runId).state, 'running');
    x.session.input('exit 4\r', { principal: AGENT });
    const nested = await x.session.awaitRun(a.run.runId, 3000);
    assert.equal(nested.state, 'exited');
    assert.equal(nested.exit, 4);
    // `exec fish` keeps the pid and re-integrates; the Run in flight is lost, not left running.
    const ex = await x.session.admitWhenAvailable({ target: 'shell', line: `exec ${FISH}`, principal: AGENT }, 3000);
    assert.ok(ex.admitted);
    const re = await x.session.awaitRun(ex.run.runId, 5000);
    assert.equal(re.state, 'lost');
    const after = await x.run('sh -c "exit 4"');
    assert.equal(after.state, 'exited');
    assert.equal(after.exit, 4);
  } finally {
    await x.close();
  }
});
