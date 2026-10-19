/**
 * core 4 with a slow prompt (the house's read of f6fe640): the typed-ahead grace used to start at
 * the prompt's start mark, before PS1 is expanded; a PS1 with a command substitution (`__git_ps1`,
 * here a `sleep`) ate the grace, and the queued Run ran before the person pressed Enter, its clear
 * keys and line behind the typed text, which then never ran. The grace now starts at the prompt's
 * end mark, after PS1, when readline shows the typed text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

test('a line typed ahead during a Run is seen even when PS1 takes longer than the grace: the queued Run waits for Enter, and the typed line runs first', { skip: !hasShell('/bin/bash') }, async () => {
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': "PS1='$(sleep 0.4)\\$ '\n" }, editingStaleMs: 5000 });
  try {
    assert.equal((await x.run('echo ready')).text.trim(), 'ready');
    const a = x.session.admit({ target: 'shell', line: 'sleep 0.6', principal: AGENT });
    assert.ok(a.admitted);
    // A person types their next command while the Run runs, without Enter; an agent queues one.
    x.session.input('echo typed-ahead-marker', { principal: AGENT });
    const q = x.session.admit({ target: 'shell', line: 'echo queued-ran', principal: AGENT, queue: true });
    assert.ok(q.admitted);
    await x.session.awaitRun(a.run.runId, 5000);
    // The prompt takes 0.4 s to print; the editor shows the typed text after it.
    await until(() => { const a = x.session.shellAvailable(); return !a.ok && a.reason === 'human-editing'; }, 3000, 'the typed text seen in the editor');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(x.session.run(q.run.runId).state, 'queued', 'the queued Run waits for the typed line');
    x.session.input('\r', { principal: AGENT });
    const ran = await x.session.awaitRun(q.run.runId, 8000);
    assert.deepEqual([ran.state, ran.exit], ['exited', 0]);
    const outputs = x.journal.since(0).events.filter((e) => e.type === 'output').map((e) => (e as { data: string }).data).join('');
    const typedAt = outputs.indexOf('typed-ahead-marker\r\n');
    const queuedAt = outputs.indexOf('queued-ran\r\n');
    assert.ok(typedAt !== -1 && queuedAt !== -1 && typedAt < queuedAt, `the typed line ran, before the queued Run: ${JSON.stringify(outputs.slice(-400))}`);
  } finally {
    await x.close();
  }
});
