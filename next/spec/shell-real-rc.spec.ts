/**
 * Opt-in: the developer's own rc files (TSM_TEST_REAL_RC=1). Everything else in the
 * suite uses a fake HOME; this one runs bash and zsh as login shells against the
 * real HOME, so whatever the rc brings — prompt themes, history tools, fzf, a
 * terminal's shell integration — meets the integration for real.
 *
 * Side effects are contained: the session keeps its own HISTFILE (under its temp
 * dir), atuin runs on a default config and a temp database, and nothing in the
 * rc files is written. When the daemon was started from Ghostty, Ghostty's own
 * integration is loaded on purpose (through the session's env, which the scrub of
 * the daemon's env does not touch) to prove keyed marks withstand it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

const skip = process.env.TSM_TEST_REAL_RC === '1' ? false : 'opt-in: set TSM_TEST_REAL_RC=1 to run against your own rc files';

for (const shell of ['/bin/zsh', '/bin/bash'].filter(hasShell)) {
  test(`${shell}: the user's real rc files (login shell): integrated, truthful, no phantom Runs`, { skip }, async () => {
    const atuin = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-atuin-'));
    fs.mkdirSync(path.join(atuin, 'config'));
    // atuin with its default config (no daemon, no sync) and every path in the temp dir.
    const env: Record<string, string> = {
      ATUIN_CONFIG_DIR: path.join(atuin, 'config'),
      ATUIN_DB_PATH: path.join(atuin, 'history.db'),
      ATUIN_RECORD_STORE_PATH: path.join(atuin, 'records.db'),
      ATUIN_KEY_PATH: path.join(atuin, 'key'),
      ATUIN_SESSION_PATH: path.join(atuin, 'session'),
      ATUIN_META__DB_PATH: path.join(atuin, 'meta.db'),
      ATUIN_DAEMON__ENABLED: 'false',
      ATUIN_DAEMON__AUTOSTART: 'false',
      ATUIN_DAEMON__SOCKET_PATH: path.join(atuin, 'sock'),
      ATUIN_AUTO_SYNC: 'false',
    };
    if (process.env.GHOSTTY_RESOURCES_DIR) env.GHOSTTY_RESOURCES_DIR = process.env.GHOSTTY_RESOURCES_DIR;
    const x = await realSession(shell, { daemonEnv: { ...process.env }, env });
    try {
      assert.equal(x.session.integration, 'rich', `integration with the real rc (start ${x.startMs} ms)`);
      assert.ok(await x.session.waitAvailable(2000), 'the prompt confirmed the shell is available');
      assert.equal(x.session.state, 'idle');
      const lines: Array<[string, (r: { exit?: number; text: string }) => void]> = [
        ['echo hi', (r) => assert.equal(r.text, 'hi')],
        ['false', (r) => assert.equal(r.exit, 1)],
        ['# a note', (r) => assert.equal(r.exit, 0)],
        ['echo "Done!"', (r) => assert.equal(r.text, 'Done!')],
        ['printf abc', (r) => assert.equal(r.text, 'abc')],
        ['sh -c "exit 9"', (r) => assert.equal(r.exit, 9)],
      ];
      for (const [line, check] of lines) {
        const r = await x.run(line);
        assert.equal(r.state, 'exited', `${JSON.stringify(line)} → ${r.state} ${r.reason ?? ''}`);
        check(r);
      }
      await x.run(`cd ${x.tmp}`);
      await x.session.waitAvailable(2000);
      assert.equal(x.session.cwd, x.tmp);
      x.session.input('echo typed-with-the-real-rc\r', { principal: AGENT });
      await until(() => x.session.listRuns().some((r) => r.origin === 'agent' && r.state === 'exited'), 3000, 'typed Run');
      const typed = x.session.listRuns().find((r) => r.origin === 'agent')!;
      assert.equal(typed.line, 'echo typed-with-the-real-rc');
      assert.equal(typed.exit, 0);
      assert.equal(x.session.listRuns().length, lines.length + 2, 'no phantom Runs');
      const ends = x.journal.since(0).events.filter((e) => e.type === 'prompt' && e.phase === 'end').length;
      assert.ok(ends >= lines.length, `prompt-end marks survive the rc's prompt (${ends})`);
      const hist = x.session.listRuns().map((r) => r.line).join('\n');
      assert.doesNotMatch(hist, /tsm-cmd-/);
    } finally {
      await x.close();
      fs.rmSync(atuin, { recursive: true, force: true });
    }
  });
}
