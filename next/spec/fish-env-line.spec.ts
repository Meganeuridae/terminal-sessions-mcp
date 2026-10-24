import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, realSession, scriptedSession, until } from './fake-shell.js';

test('captureEnv types redirection for a declared fish, rather than its outer Bash', async (t) => {
  const x = await realSession('/bin/bash', { noUserRc: true });
  t.after(() => x.close());
  const opener = x.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(opener.admitted);
  await until(() => x.session.run(opener.run.runId).state === 'running', 5000, 'outer Run to hold the terminal');
  assert.equal(x.session.declareShell({ shell: 'fish', principal: AGENT }).shell, 'fish');
  let typed: string | undefined;
  x.session.admitWhenAvailable = async (o) => { typed = (typeof o === 'function' ? o() : o).line; throw new Error('line captured before typing'); };
  await assert.rejects(x.session.captureEnv(AGENT), /line captured before typing/);
  assert.ok(typed?.startsWith("env -0 > '"), `fish needs a redirect, not a pipe: ${typed}`);
});

test('captureEnv types POSIX noclobber redirection for a declared Bash inside outer fish', async () => {
  const h = await scriptedSession({ shell: '/usr/bin/fish', helloKind: 'fish' });
  try {
    const opener = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(opener.admitted);
    await until(() => h.session.run(opener.run.runId).state === 'running', 5000, 'outer fish Run to hold the terminal');
    assert.equal(h.session.declareShell({ shell: 'bash', principal: AGENT }).shell, 'bash');
    let typed: string | undefined;
    h.session.admitWhenAvailable = async (o) => { typed = (typeof o === 'function' ? o() : o).line; throw new Error('line captured before typing'); };
    await assert.rejects(h.session.captureEnv(AGENT), /line captured before typing/);
    assert.ok(typed?.startsWith("env -0 >| '"), `declared POSIX shell needs noclobber override: ${typed}`);
  } finally {
    await h.session.close();
  }
});

test('captureEnv re-renders its internal line when the declared shell changes while admission waits', async (t) => {
  const x = await realSession('/bin/bash', { noUserRc: true });
  t.after(() => x.close());
  const opener = x.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(opener.admitted);
  await until(() => x.session.run(opener.run.runId).state === 'running', 5000, 'outer Run to hold the terminal');
  x.session.declareShell({ shell: 'fish', principal: AGENT });
  const actualAdmit = x.session.admit.bind(x.session);
  const actualWait = x.session.waitAvailable.bind(x.session);
  let attempts = 0;
  let secondLine: string | undefined;
  try {
    x.session.admit = (o) => {
      if (++attempts === 1) return { admitted: false, busy: null, reason: 'prompt-pending' };
      secondLine = o.line;
      throw new Error('second admission captured');
    };
    x.session.waitAvailable = async () => {
      x.session.declareShell({ shell: 'bash', principal: AGENT, within: opener.run.runId });
      return true;
    };
    await assert.rejects(x.session.captureEnv(AGENT), /second admission captured/);
    assert.equal(attempts, 2);
    assert.ok(secondLine?.startsWith("env -0 >| '"), `the new POSIX front must get its own grammar: ${secondLine}`);
  } finally {
    x.session.admit = actualAdmit;
    x.session.waitAvailable = actualWait;
  }
});
