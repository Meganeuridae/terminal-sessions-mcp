/**
 * The configured environment basis (G7) and history isolation (G6): what a session's
 * shell and process Runs inherit from whatever launched the daemon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredEnv, historyIsolationEnv, scrubDaemonEnv } from '../src/core/env.js';
import { AGENT, scriptedSession as harness } from './fake-shell.js';

test('ux-8: launcher state never reaches a session — Volta recursion, npm/npx lifecycle, the launching agent host\'s session identity', () => {
  const daemonEnv: NodeJS.ProcessEnv = {
    HOME: '/Users/u',
    VOLTA_HOME: '/Users/u/.volta',
    _VOLTA_TOOL_RECURSION: '1',
    npm_config_cache: '/Users/u/.npm',
    npm_lifecycle_event: 'start',
    npm_execpath: '/x/npm-cli.js',
    INIT_CWD: '/Users/u/some/project',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 's-1',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_PID: '123',
    AI_AGENT: 'claude-code',
    ATUIN_SESSION: 'abc',
    ATUIN_HISTORY_ID: 'def',
    ATUIN_SHLVL: '1',
    GIT_EDITOR: 'true',
    VTE_VERSION: '7600',
    TERMINFO: '/Applications/Ghostty.app/Contents/Resources/terminfo',
    NODE_OPTIONS: '--max-old-space-size=4096',
    ATUIN_CONFIG_DIR: '/Users/u/.config/atuin',
    PATH: '/Users/u/.volta/tools/image/node/22.22.0/bin:/Users/u/proj/node_modules/.bin:/Users/u/.npm/_npx/abc/node_modules/.bin:/Users/u/.volta/bin:/usr/bin:/bin',
  };
  const env = scrubDaemonEnv(daemonEnv);
  for (const gone of ['_VOLTA_TOOL_RECURSION', 'npm_config_cache', 'npm_lifecycle_event', 'npm_execpath', 'INIT_CWD', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'AI_AGENT', 'ATUIN_SESSION', 'ATUIN_HISTORY_ID', 'ATUIN_SHLVL', 'GIT_EDITOR', 'VTE_VERSION', 'TERMINFO']) {
    assert.equal(env[gone], undefined, gone);
  }
  for (const kept of ['HOME', 'VOLTA_HOME', 'NODE_OPTIONS', 'ATUIN_CONFIG_DIR']) assert.equal(env[kept], daemonEnv[kept], kept);
  assert.equal(env.PATH, '/Users/u/.volta/bin:/usr/bin:/bin', 'Volta\'s pinned image and npm\'s .bin chain leave PATH; the Volta shims stay');
  // A user's own GIT_EDITOR is not an automation marker.
  assert.equal(scrubDaemonEnv({ GIT_EDITOR: 'vim' }).GIT_EDITOR, 'vim');
  assert.equal(scrubDaemonEnv({ GIT_EDITOR: ':' }).GIT_EDITOR, undefined);
  // Without an npm launcher, node_modules/.bin a user put on PATH stays.
  assert.equal(scrubDaemonEnv({ PATH: '/p/node_modules/.bin:/usr/bin' }).PATH, '/p/node_modules/.bin:/usr/bin');
  // The session's creation-time env still wins.
  const configured = configuredEnv(daemonEnv, { CLAUDECODE: 'mine', PATH: '/given' });
  assert.equal(configured.CLAUDECODE, 'mine');
  assert.equal(configured.PATH, '/given');
});

test('ux-8/G7: a session\'s shell and process Runs get the scrubbed basis', async () => {
  const h = await harness({ daemonEnv: { PATH: '/bin', _VOLTA_TOOL_RECURSION: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'x', npm_config_prefix: '/p' } });
  const shellEnv = h.pty.opts.env;
  assert.equal(shellEnv._VOLTA_TOOL_RECURSION, undefined);
  assert.equal(shellEnv.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.equal(shellEnv.npm_config_prefix, undefined);
  const a = h.session.admit({ target: 'process', argv: ['env'], principal: AGENT });
  assert.ok(a.admitted);
  const proc = h.backend.processes[0]!;
  assert.equal(proc.opts.env._VOLTA_TOOL_RECURSION, undefined);
  proc.exit({ exitCode: 0 });
  await h.session.close();
});

test('ux-3/G6: history tools the rc loads are pointed at the session\'s own directory, for the shell only; a creation env naming them wins', async () => {
  const iso = historyIsolationEnv('/s/d');
  assert.equal(iso.ATUIN_DB_PATH, '/s/d/history.db');
  assert.equal(iso.ATUIN_DAEMON__ENABLED, 'false');
  assert.equal(iso.ATUIN_AUTO_SYNC, 'false');
  const h = await harness();
  const env = h.pty.opts.env;
  assert.ok(env.ATUIN_DB_PATH?.startsWith(env.HISTFILE!.replace(/tsm-history-[^/]*$/, '')), env.ATUIN_DB_PATH);
  const a = h.session.admit({ target: 'process', argv: ['env'], principal: AGENT });
  assert.ok(a.admitted);
  assert.equal(h.backend.processes[0]!.opts.env.ATUIN_DB_PATH, undefined, 'process Runs keep the configured basis (G7)');
  h.backend.processes[0]!.exit({ exitCode: 0 });
  await h.session.close();
  const g = await harness({ env: { ATUIN_DB_PATH: '/mine.db' } });
  assert.equal(g.pty.opts.env.ATUIN_DB_PATH, '/mine.db');
  assert.equal(g.pty.opts.env.ATUIN_AUTO_SYNC, undefined, 'the creation env took history in hand: nothing is added');
  await g.session.close();
});
