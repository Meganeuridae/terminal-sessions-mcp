/** Completion credentials must not travel with ordinary child environments. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

const shells = ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', '/usr/bin/fish'].filter(hasShell);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

for (const shell of shells) {
  test(`${shell}: quoted exec, exported prompts and delayed children cannot forge completion`, async () => {
    const rc = shell.endsWith('fish') ? {} : { [shell.endsWith('zsh') ? '.zshrc' : '.bashrc']: 'export PS1="exported> "\nset -a\n' };
    const x = await realSession(shell, { rc, login: false });
    try {
      const child = path.join(x.tmp, 'child.cjs');
      const receipt = path.join(x.tmp, 'receipt');
      fs.writeFileSync(child, `
const fs = require('node:fs');
const key = Object.values(process.env).flatMap(v => [...v.matchAll(/(?:^|;k=)([a-f0-9]{32})(?=\\x07|$)/g)]).map(m => m[1])[0];
fs.writeFileSync(${JSON.stringify(receipt)}, key ? 'leaked' : 'private');
setTimeout(() => {
  if (key) process.stdout.write('\\x1b]133;D;0;k=' + key + '\\x07');
  setTimeout(() => { console.log('ACTUAL-END'); process.exit(7); }, 200);
}, process.argv[2] === 'later' ? 700 : 0);
`);
      const cmd = `${quote(process.execPath)} ${quote(child)}`;
      const result = await x.run(`: ' exec '; ${cmd}`);
      assert.equal(fs.readFileSync(receipt, 'utf8'), 'private');
      assert.deepEqual([result.state, result.exit], ['exited', 7]);
      assert.match(result.text, /ACTUAL-END/);
      // Disarming a hint must not leave a background child with a reusable credential.
      await x.run(`: ' exec '; ${cmd} later &`);
      const later = await x.run('sleep 1.2; false');
      assert.deepEqual([later.state, later.exit], ['exited', 1]);
      assert.equal(fs.readFileSync(receipt, 'utf8'), 'private');
      assert.equal(fs.readdirSync(path.join(x.tmp, 'integration')).filter((f) => f.startsWith('key-')).length, 0);
    } finally { await x.close(); }
  });

  test(`${shell}: replacement by a reader never drains queued commands`, async () => {
    const x = await realSession(shell, { integrationGraceMs: 150 });
    try {
      const first = x.session.admit({ target: 'shell', line: 'exec /bin/cat', principal: AGENT });
      assert.ok(first.admitted);
      const queued = x.session.admit({ target: 'shell', line: 'echo NEVER-A-COMMAND', principal: AGENT, queue: true });
      assert.ok(queued.admitted);
      const result = await x.session.awaitRun(first.run.runId, 3000);
      assert.deepEqual([result.state, result.reason], ['lost', 'shell-replaced']);
      assert.equal(x.session.info().state, 'unavailable');
      assert.equal(x.session.run(queued.run.runId).state, 'queued');
      assert.deepEqual(x.session.shellAvailable(), { ok: false, reason: 'shell-unavailable' });
      assert.equal(x.journal.since(0).events.filter((e) => e.type === 'run.start' && e.runId === queued.run.runId).length, 0);
      x.session.input('explicit input\n', { principal: AGENT });
      await until(() => x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes('explicit input')), 2000);
      assert.equal((await x.session.cancel(queued.run.runId, AGENT)).state, 'cancelled');
      assert.equal(x.session.info().state, 'unavailable');
    } finally { await x.close(); }
  });
}

test('a startup rc replacing the shell with a reader never becomes ready through a timer', async () => {
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': 'exec /bin/cat\n' }, integrationGraceMs: 100, startupCapMs: 400 });
  try {
    assert.equal(x.session.info().state, 'unavailable');
    assert.deepEqual(x.session.shellAvailable(), { ok: false, reason: 'shell-unavailable' });
    assert.equal(x.session.admit({ target: 'shell', line: 'echo never', principal: AGENT, queue: true }).admitted, false);
  } finally { await x.close(); }
});

const fish = shells.find((s) => s.endsWith('fish'));
test('replacement before the first hello cannot turn into marker fallback', { skip: !fish }, async () => {
  const x = await realSession(fish!, {
    rc: { '.config/fish/conf.d/aaa-replace.fish': 'exec /bin/cat\n' },
    integrationGraceMs: 100, startupCapMs: 400,
  });
  try {
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(x.session.shellAvailable(), { ok: false, reason: 'shell-unavailable' });
    assert.equal(x.session.admit({ target: 'shell', line: 'echo never', principal: AGENT, queue: true }).admitted, false);
  } finally { await x.close(); }
});

test('initial fish startup children do not inherit completion authority before vendor configuration', { skip: !fish }, async () => {
  const probe = `/bin/sh -c '[ -z "\${TSM_MARK_KEY-}\${__tsm_key-}" ] || echo STARTUP-KEY-LEAK'\n`;
  const x = await realSession(fish!, { login: false, rc: { '.config/fish/conf.d/aaa-child.fish': probe } });
  try {
    assert.equal(x.session.integration, 'rich');
    assert.ok(!x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes('STARTUP-KEY-LEAK')));
    assert.equal((await x.run('false')).exit, 1);
  } finally { await x.close(); }
});

test('bash allexport and DEBUG children cannot observe the key between handoff read and unexport', async () => {
  const probe = `/bin/sh -c '[ -z "\${__tsm_key-}\${TSM_MARK_KEY-}" ] || echo DEBUG-KEY-LEAK'`;
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': `set -aT\ntrap ${quote(probe)} DEBUG\n` } });
  try {
    const handoff = await x.run('exec /bin/bash');
    assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
    assert.equal((await x.run('false')).exit, 1);
    assert.ok(!x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes('DEBUG-KEY-LEAK')));
  } finally { await x.close(); }
});

test('an unintegrated shell remains available after a command file failed before writing to the terminal', async () => {
  const x = await realSession('/bin/sh', { login: false });
  try {
    const obstruction = path.join(x.tmp, 'tsm-cmd-1');
    fs.mkdirSync(obstruction);
    const failed = await x.run('echo never');
    assert.equal(failed.state, 'lost');
    assert.match(failed.reason!, /temp-file/);
    fs.rmdirSync(obstruction);
    assert.ok(x.session.shellAvailable().ok);
    assert.equal((await x.run('echo after')).text, 'after');
  } finally { await x.close(); }
});
