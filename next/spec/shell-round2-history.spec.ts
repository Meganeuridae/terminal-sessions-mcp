/**
 * G6 for history tools (ux-3): with atuin loaded by the user's rc, a session's Up and
 * Ctrl-R walk the session's own history, and what is typed at a session prompt goes to a
 * database of the session's own — never the user's. Also: atuin's bash integration brings
 * bash-preexec, which calls preexec functions only for lines it finds in history; daemon
 * lines are never there, and Runs still start. Runs only where atuin is installed; every
 * shell runs with a fake HOME, so the real atuin database is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

const ATUIN = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v atuin'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
})();
const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);
const BASH5 = process.env.TSM_TEST_BASH5 && hasShell(process.env.TSM_TEST_BASH5) ? process.env.TSM_TEST_BASH5 : undefined;
const skip = ATUIN === undefined ? 'atuin is not installed' : false;

const CASES: Array<{ shell: string | undefined; rc: Record<string, string>; keys: string; reason?: string }> = [
  { shell: '/bin/zsh', rc: { '.zshrc': 'eval "$(atuin init zsh)"\n' }, keys: "bindkey '^[[A'; bindkey '^R'" },
  { shell: FISH, rc: { '.config/fish/config.fish': 'atuin init fish | source\n' }, keys: 'bind up; bind ctrl-r', reason: 'fish is not installed' },
  { shell: BASH5, rc: { '.bash_profile': 'eval "$(atuin init bash)"\n' }, keys: "bind -s | grep -E '^\"(\\\\C-r|\\\\e\\[A)\"' | grep -c . || true", reason: 'set TSM_TEST_BASH5 to a bash 5 binary' },
];

for (const c of CASES) {
  const name = c.shell?.split('/').pop() ?? 'bash5';
  test(`${name}: ux-3: with atuin in the rc, Up and Ctrl-R walk the session's own history and typed lines stay out of the user's atuin database`, { skip: skip || (c.shell === undefined ? c.reason! : hasShell(c.shell) ? false : `${c.shell} is not installed`) }, async () => {
    const x = await realSession(c.shell!, { rc: c.rc, startupCapMs: 20_000 });
    try {
      const keys = await x.run(c.keys, 15_000);
      assert.equal(keys.state, 'exited', `${keys.state} ${keys.reason ?? ''}: daemon Runs work with atuin's hooks loaded`);
      assert.doesNotMatch(keys.text, /atuin/, keys.text);
      if (name.startsWith('bash')) assert.equal(keys.text.trim(), '0', 'no key macro into atuin');
      const db = await x.run('echo "$ATUIN_DB_PATH"', 15_000);
      assert.ok(db.text.startsWith(x.tmp), `atuin writes to the session's own directory: ${db.text}`);
      x.session.input('echo typed-into-session\r', { principal: AGENT });
      // (atuin creates and migrates a fresh database at the first command: slow under load)
      await until(() => x.session.listRuns().some((r) => r.line === 'echo typed-into-session' && r.state === 'exited'), 10_000, 'typed Run');
      await until(() => fs.existsSync(db.text), 10_000, 'the session database');
      assert.ok(!fs.existsSync(path.join(x.home, '.local', 'share', 'atuin', 'history.db')), 'the user\'s atuin database was not created');
      // Up recalls the session's last line in the editor — no full-screen search over anybody's history.
      x.session.input('\x1b[A', { principal: AGENT });
      await until(() => x.session.snapshot().lines.filter((l) => l.includes('echo typed-into-session')).length >= 2, 6000, 'recalled line');
      assert.equal(x.session.snapshot().alt, false);
      x.session.input('\x15', { principal: AGENT });
    } finally {
      await x.close();
    }
  });
}
