/**
 * Shell tools 3 (the house's review of #11): `sh -c 'echo tests failed; exit 1' | tail -1` came
 * back `exited 0` and nothing more. The command file now captures the pipeline's statuses in the
 * same statement as `$?` and returns with the command's own status; the integration's end mark
 * carries them (`p=1,0`), the result carries `pipeStatus`, and the shell keeps `$?` for its prompt
 * and the next line. After `. file` the shell's own PIPESTATUS/pipestatus are those of `.` itself,
 * which is why the capture lives in the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasShell, realSession } from './fake-shell.js';

const shells = ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', '/usr/bin/fish'].filter(hasShell);

for (const shell of shells) {
  const fish = shell.endsWith('fish');
  test(`${shell}: a failure piped into another command is reported beside the exit; a single command carries no pipeline; the shell keeps its own status`, async () => {
    const x = await realSession(shell);
    try {
      const masked = await x.run("sh -c 'echo tests failed; exit 1' | tail -n 1");
      assert.deepEqual([masked.state, masked.exit, masked.pipeStatus, masked.text.trim()], ['exited', 0, [1, 0], 'tests failed']);
      const both = await x.run("sh -c 'exit 3' | sh -c 'exit 1'");
      assert.deepEqual([both.exit, both.pipeStatus], [1, [3, 1]]);
      const single = await x.run("sh -c 'exit 7'");
      assert.deepEqual([single.exit, single.pipeStatus], [7, undefined]);
      // The shell's own status after a Run is the command's, as a person typing it would see.
      const seen = await x.run(fish ? 'echo $status' : 'echo $?');
      assert.equal(seen.text.trim(), '7');
      // A line whose last line continues with a backslash still runs whole, and alone.
      const cont = await x.run("printf '%s\\n' alpha \\");
      assert.deepEqual([cont.exit, cont.text.trim()], [0, 'alpha']);
      if (!fish) {
        // Under nounset the capture still works: the other shell's variable is defaulted.
        await x.run('set -u');
        const strict = await x.run("sh -c 'exit 2' | tail -n 1");
        assert.deepEqual([strict.exit, strict.pipeStatus], [0, [2, 0]]);
        await x.run('set +u');
      }
      // Nothing of the capture stays in the shell between Runs.
      const leak = await x.run(fish ? 'set -q __tsm_pst; and echo leaked; or echo clean' : '[ -n "${__tsm_ps+x}${__tsm_st+x}" ] && echo leaked || echo clean');
      assert.equal(leak.text.trim(), 'clean');
    } finally {
      await x.close();
    }
  });
}
