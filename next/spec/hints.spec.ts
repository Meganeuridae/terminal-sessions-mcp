/**
 * Hints in a result's status line that are never evidence (§8.1): a line that turned on
 * `set -e` in the shell, a one-shot `ssh host cmd` whose remote command has no terminal,
 * and the shell having exited under a Run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeErrexit, oneShotSshWithoutTty, renderRun } from '../src/api/tools.js';
import type { RunResult } from '../src/api/app.js';

const base = (over: Partial<RunResult>): RunResult => ({
  runId: 'r1', session: 's', target: 'shell', state: 'exited', cwd: '/', attribution: 'temporal', line: 'true', durationMs: 120,
  output: { text: '', truncated: false, seq: [1, 2], nextCursor: 2 }, ...(over.state === undefined || over.state === 'exited' ? { exit: 0 } : {}), ...over,
});
const text = (r: RunResult) => renderRun(r, 'transcript').text;

test('set -e at a command position is recognized; set +e, set -x and set -e inside quotes are not', () => {
  for (const line of ['set -e', 'set -eu', 'set -euo pipefail', 'set -Eeuo pipefail', 'set -o errexit', 'cd /w && set -e', 'echo a; set -e\nmake', 'if true; then set -e; fi']) assert.ok(looksLikeErrexit(line), line);
  for (const line of ['set +e', 'set -x', 'set -u', 'set -o pipefail', 'grep "set -e" build.sh', 'echo set -e', 'bash -e build.sh', 'setenv -e']) assert.ok(!looksLikeErrexit(line), line);
});

test('a one-shot ssh without -t is recognized with its host; a shell-opening ssh, ssh -t/-tt and non-ssh lines are not', () => {
  assert.equal(oneShotSshWithoutTty('ssh workbox make test'), 'workbox');
  assert.equal(oneShotSshWithoutTty('ssh -p 2222 -o StrictHostKeyChecking=no deploy@host ./deploy.sh'), 'deploy@host');
  assert.equal(oneShotSshWithoutTty('ssh -T host cmd'), 'host');
  assert.equal(oneShotSshWithoutTty('env FOO=1 ssh host cmd'), 'host');
  assert.equal(oneShotSshWithoutTty('sudo ssh host cmd'), 'host');
  for (const line of ['ssh workbox', 'ssh -t host cmd', 'ssh -tt host cmd', 'ssh -At host cmd', 'ssh -p 22 -t host cmd', 'scp a host:b', 'echo ssh host cmd', 'sleep 5', '']) {
    assert.equal(oneShotSshWithoutTty(line), undefined, line);
  }
});

test('the status line hints: set -e armed, a one-shot ssh running or cancelled, the shell gone under a Run', () => {
  assert.match(text(base({ line: 'set -euo pipefail' })), /turned on set -e in the shell itself.*set \+e turns it off/);
  assert.doesNotMatch(text(base({ line: 'set -euo pipefail', target: 'process' })), /set -e/, 'a process does not change the shell');
  assert.doesNotMatch(text(base({ line: 'make test' })), /set -e/);
  const running = base({ state: 'running', line: 'ssh build01 make -j8', durationMs: 30000 });
  assert.match(text(running), /a cancel would end the local ssh client, not the command on build01/);
  assert.match(text(running), /ssh -t in the shell lets terminal interrupts reach it.*ssh -tt as a process Run hangs it up/);
  assert.match(text(running), /can only confirm that ssh ended/);
  assert.doesNotMatch(text(base({ ...running, line: 'ssh -t build01 make -j8' })), /local ssh client/);
  assert.match(text(base({ state: 'cancelled', line: 'ssh build01 make -j8', durationMs: 31000 })), /ended the local ssh client only; the command on build01 had no terminal there.*may still be running/);
  assert.doesNotMatch(text(base({ state: 'cancelled', line: 'make -j8', durationMs: 31000 })), /still be running/);
  const lost = text(base({ state: 'lost', reason: 'shell-exited (status 2)', line: 'npm test' }));
  assert.match(lost, /outcome unknown: shell-exited \(status 2\) — the shell running this command exited under it.*set -e is on in the shell and a command fails/);
  assert.doesNotMatch(text(base({ state: 'lost', reason: 'daemon-shutdown', line: 'npm test' })), /exited under it/);
});

test('the status line says when a process Run left children running in its group, and how to end them', () => {
  const left = text(base({ target: 'process', line: 'sleep 30 & echo started', leftovers: true }));
  assert.match(left, /exited 0 .* — it left processes running in its group/);
  assert.match(left, /cancel r1 ends them, as does closing the session/);
  assert.doesNotMatch(text(base({ target: 'process', line: 'echo alone' })), /left processes running/);
});
