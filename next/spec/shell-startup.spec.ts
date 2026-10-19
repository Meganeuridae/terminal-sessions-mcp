/**
 * The integration handshake (G5) against real shells whose rc takes longer than the
 * 3 s grace (nvm, conda, a loaded machine): the hello mark goes out before the
 * user's rc runs, so the daemon keeps waiting for the first prompt instead of
 * declaring `none`; and a Run issued before that prompt waits for it rather than
 * being typed into the rc (core-9, shell-7). The shells run concurrently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, hasShell, realSession } from './fake-shell.js';

const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);

/** Each shell's rc, 5 s slow, exporting a variable the first Run can see. */
const slowRc = (shell: string): Record<string, string> => {
  if (shell.endsWith('zsh')) return { '.zshrc': 'sleep 5\nexport FROM_RC=yes\n' };
  if (shell.endsWith('fish')) return { '.config/fish/config.fish': 'sleep 5\nset -gx FROM_RC yes\n' };
  return { '.bash_profile': 'sleep 5\nexport FROM_RC=yes\n' }; // a login shell (the default)
};

test('G5 (core-9, shell-7): an rc slower than the grace still integrates, and the first Run waits for the prompt', async () => {
  const shells = ['/bin/bash', '/bin/zsh', FISH].filter((s): s is string => s !== undefined && hasShell(s));
  const outcomes = await Promise.all(
    shells.flatMap((shell) => [
      // Default: start resolves at the first prompt (after the rc), integrated.
      (async () => {
        const x = await realSession(shell, { rc: slowRc(shell) });
        try {
          assert.ok(x.startMs >= 4500, `${shell}: start waited for the rc (${x.startMs} ms)`);
          assert.equal(x.session.integration, 'rich', `${shell}: not declared none after the grace`);
          assert.ok(await x.session.waitAvailable(2000), 'the prompt confirmed the shell is available');
          assert.equal(x.session.state, 'idle');
          const r = await x.run('echo "rc=$FROM_RC"; sh -c "exit 5"');
          assert.equal(r.state, 'exited', `${shell}: ${r.state} ${r.reason ?? ''}`);
          assert.equal(r.exit, 5);
          assert.equal(r.text, 'rc=yes');
        } finally {
          await x.close();
        }
        return shell;
      })(),
      // Capped startup: start resolves in `starting`; a Run issued at once is refused
      // (busy 'starting') unless queued, and the queued one runs after the rc.
      (async () => {
        const x = await realSession(shell, { rc: slowRc(shell), startupCapMs: 1000 });
        try {
          assert.ok(x.startMs < 3000, `${shell}: start resolved at the cap (${x.startMs} ms)`);
          assert.equal(x.session.state, 'starting');
          assert.equal(x.session.integration, 'unknown', `${shell}: the hello arrived, so not none`);
          const now = x.session.admit({ target: 'shell', line: 'echo too-early', principal: AGENT });
          assert.ok(!now.admitted && now.reason === 'starting', `${shell}: ${JSON.stringify(now)}`);
          const q = x.session.admit({ target: 'shell', line: 'echo "rc=$FROM_RC"; sh -c "exit 7"', principal: AGENT, queue: true });
          assert.ok(q.admitted);
          const r = await x.session.awaitRun(q.run.runId, 10_000);
          assert.equal(r.state, 'exited', `${shell}: ${r.state} ${r.reason ?? ''}`);
          assert.equal(r.exit, 7);
          assert.equal((await x.session.runTranscript(r.runId)).text, 'rc=yes');
          assert.equal(x.session.integration, 'rich');
          assert.deepEqual(
            x.session.listRuns().map((run) => run.origin),
            ['self'],
            `${shell}: no phantom Run from the plumbing`,
          );
        } finally {
          await x.close();
        }
        return shell;
      })(),
    ]),
  );
  assert.equal(outcomes.length, shells.length * 2);
});
