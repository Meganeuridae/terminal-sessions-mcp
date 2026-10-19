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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
      // A producer the next command stopped reading ends on SIGPIPE: the statuses say 141, the exit is head's.
      const head = await x.run('seq 1 1000000 | head -n 1');
      assert.deepEqual([head.exit, head.pipeStatus, head.text.trim()], [0, [141, 0], '1']);
      if (!fish) {
        // A heredoc the text never terminates ends at the end of the file: the capture line must not
        // become part of it (it did: the file held `__tsm_st=0 …`). No capture, so no pipeStatus.
        const out = path.join(x.tmp, 'heredoc-out.txt');
        const open = await x.run(`cat > '${out}' <<EOF\nkey=value`);
        assert.equal(open.exit, 0);
        assert.equal(fs.readFileSync(out, 'utf8'), 'key=value\n', 'the file holds the heredoc body alone');
        assert.equal(open.pipeStatus, undefined);
        // A terminated heredoc feeding a pipeline still gets its statuses.
        const closed = await x.run(`sh -c 'cat; exit 4' <<EOF | tail -n 1\nbody\nEOF`);
        assert.deepEqual([closed.exit, closed.pipeStatus, closed.text.trim()], [0, [4, 0], 'body']);
        // A `<<` inside a closed quoted heredoc body is text, not a second heredoc: the statuses are still captured
        // (the house's read of a6d0c35, #22: this came back with no pipeStatus).
        const bodyShift = await x.run(`cat <<'A' | tail -n 1\nx << y\nA`);
        assert.deepEqual([bodyShift.exit, bodyShift.pipeStatus, bodyShift.text.trim()], [0, [0, 0], 'x << y']);
      }
    } finally {
      await x.close();
    }
  });
}

test('an open heredoc is recognised, quoted or not, with <<- and tab-indented terminators; here-strings and closed heredocs are not', async () => {
  const { hasOpenHeredoc } = await import('../src/core/session.js');
  assert.equal(hasOpenHeredoc('cat > f <<EOF\nkey=value\n'), true);
  assert.equal(hasOpenHeredoc("cat <<'EOF'\nbody\n"), true);
  assert.equal(hasOpenHeredoc('cat <<"EOF"\nbody\nEOF\n'), false);
  assert.equal(hasOpenHeredoc('cat <<EOF\nbody\nEOF\n'), false);
  assert.equal(hasOpenHeredoc('cat <<-EOF\n\tbody\n\tEOF\n'), false);
  assert.equal(hasOpenHeredoc('cat <<-EOF\n\tbody\n'), true);
  assert.equal(hasOpenHeredoc('cat <<< "a string"\n'), false);
  assert.equal(hasOpenHeredoc('echo plain | tail -n 1\n'), false);
  assert.equal(hasOpenHeredoc('cat <<A\nx\nA\ncat <<B\ny\n'), true, 'the second heredoc is open');
  // The delimiter is the whole word the shell reads, not just an identifier (the house's read of a6d0c35, #22).
  assert.equal(hasOpenHeredoc('cat > out <<123\nkey=value\n'), true, 'a numeric delimiter still opens a heredoc');
  assert.equal(hasOpenHeredoc('cat > out <<123\nkey=value\n123\n'), false, 'and its own terminator closes it');
  assert.equal(hasOpenHeredoc('cat > out <<EOF.txt\nkey=value\nEOF\n'), true, 'EOF does not close a heredoc whose delimiter is EOF.txt');
  assert.equal(hasOpenHeredoc('cat > out <<EOF.txt\nkey=value\nEOF.txt\n'), false);
  assert.equal(hasOpenHeredoc('cat <<"E"OF\nbody\nEOF\n'), false, 'quotes in the delimiter are removed');
  // A `<<` inside a closed heredoc body is text, not a second heredoc (it dropped the pipeline statuses).
  assert.equal(hasOpenHeredoc("cat <<'A' | tail -n 1\nx << y\nA\n"), false, 'the << in a closed heredoc body is not a heredoc');
  assert.equal(hasOpenHeredoc('echo "a << b"\n'), false, 'a << inside a double-quoted string is not a heredoc');
  assert.equal(hasOpenHeredoc('x=$((1 << 4))\n'), false, 'a left shift in arithmetic is not a heredoc');
  assert.equal(hasOpenHeredoc('echo hi # cat <<EOF\n'), false, 'a << in a comment is not a heredoc');
});
