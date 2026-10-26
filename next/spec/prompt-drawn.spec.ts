import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AGENT, hasShell, realSession, scriptedSession as harness, tick, until } from './fake-shell.js';

test('a Run queued behind a running one is typed once the next prompt is drawn, not at its start', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(a.admitted, JSON.stringify(a));
  await until(() => h.session.run(a.run.runId).state === 'running', 2000, 'the first Run running');
  const b = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
  assert.ok(b.admitted && b.run.state === 'queued', JSON.stringify(b));
  h.shell.finishHung(0, undefined, { prompt: false });
  h.pty.emit(h.shell.mark('133;A') + '$ ');
  await tick(50);
  assert.equal(h.session.run(b.run.runId).state, 'queued', 'not typed before the prompt is drawn');
  assert.deepEqual(h.session.shellAvailable(), { ok: false, reason: 'prompt-pending' });
  h.pty.emit(h.shell.mark('133;B'));
  const rb = await h.session.awaitRun(b.run.runId, 2000);
  assert.deepEqual([rb.state, rb.exit], ['exited', 0], JSON.stringify(rb));
  await h.session.close();
});

test('a caller waiting for the shell is admitted once the prompt is drawn, not at its start', async () => {
  const h = await harness();
  const a = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(a.admitted, JSON.stringify(a));
  await until(() => h.session.run(a.run.runId).state === 'running', 2000, 'the first Run running');
  h.shell.finishHung(0, undefined, { prompt: false });
  let admitted = false;
  const waiting = h.session.admitWhenAvailable({ target: 'shell', line: 'echo hello', principal: AGENT }).then((r) => {
    admitted = true;
    return r;
  });
  h.pty.emit(h.shell.mark('133;A') + '$ ');
  await tick(50);
  assert.equal(admitted, false, 'not admitted before the prompt is drawn');
  h.pty.emit(h.shell.mark('133;B'));
  const r = await waiting;
  assert.ok(r.admitted, JSON.stringify(r));
  const rr = await h.session.awaitRun(r.run.runId, 2000);
  assert.deepEqual([rr.state, rr.exit], ['exited', 0], JSON.stringify(rr));
  await h.session.close();
});

test('a prompt whose end mark never comes holds a queued Run only for the drawing wait, and the prompts after it hold none', async () => {
  const h = await harness({ promptDrawnWaitMs: 300 });
  h.shell.drawsPromptEnd = false;
  const a = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
  assert.ok(a.admitted, JSON.stringify(a));
  await until(() => h.session.run(a.run.runId).state === 'running', 2000, 'the first Run running');
  const b = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
  assert.ok(b.admitted && b.run.state === 'queued', JSON.stringify(b));
  const t0 = performance.now();
  h.shell.finishHung(0);
  await until(() => h.session.run(b.run.runId).state !== 'queued', 3000, 'the queued Run typed once the wait ends');
  const waited = performance.now() - t0;
  assert.ok(waited >= 280, `not before the wait (${Math.round(waited)} ms)`);
  const rb = await h.session.awaitRun(b.run.runId, 2000);
  assert.deepEqual([rb.state, rb.exit], ['exited', 0], JSON.stringify(rb));
  const c = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(c.admitted, `the next prompt, again without its end mark, holds nothing: ${JSON.stringify(c)}`);
  await h.session.close();
});

test('a shell whose prompts never carry the end mark is available from its first prompt, once the session is ready', async () => {
  const h = await harness({ setup: (s) => (s.drawsPromptEnd = false) });
  const r = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
  assert.ok(r.admitted, JSON.stringify(r));
  const rr = await h.session.awaitRun(r.run.runId, 2000);
  assert.deepEqual([rr.state, rr.exit], ['exited', 0], JSON.stringify(rr));
  await h.session.close();
});

for (const carries of ['a prompt whose end mark never comes', 'prompts that never carry the end mark'] as const) {
  test(`keys a program took during a Run, then ${carries}: a queued Run is typed once the typed-ahead grace has passed`, async () => {
    const h = await harness({ promptDrawnWaitMs: 300, ...(carries === 'prompts that never carry the end mark' && { setup: (s) => (s.drawsPromptEnd = false) }) });
    const a = h.session.admit({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(a.admitted, JSON.stringify(a));
    await until(() => h.session.run(a.run.runId).state === 'running', 2000, 'the first Run running');
    h.session.input('qq', { principal: AGENT });
    const b = h.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT, queue: true });
    assert.ok(b.admitted && b.run.state === 'queued', JSON.stringify(b));
    h.shell.drawsPromptEnd = false;
    h.shell.finishHung(0);
    await until(() => h.session.run(b.run.runId).state !== 'queued', 3000, 'the queued Run typed');
    const rb = await h.session.awaitRun(b.run.runId, 2000);
    assert.deepEqual([rb.state, rb.exit], ['exited', 0], JSON.stringify(rb));
    await h.session.close();
  });
}

for (const how of ['queued', 'waiting'] as const) {
  test(`bash with a prompt slow to draw: a ${how} Run's line reaches the line editor, shown once and never echoed by the terminal`, { skip: !hasShell('/bin/bash'), timeout: 30_000 }, async () => {
    const x = await realSession('/bin/bash', { rc: { '.bashrc': `PS1='$(sleep 0.3)'"$PS1"\n` }, login: false, cols: 250 });
    try {
      await until(() => x.session.shellAvailable().ok, 5000, 'the first prompt');
      const first = x.session.admit({ target: 'shell', line: 'sleep 0.3; echo one', principal: AGENT });
      assert.ok(first.admitted, JSON.stringify(first));
      let second: string;
      if (how === 'queued') {
        const q = x.session.admit({ target: 'shell', line: 'echo two', principal: AGENT, queue: true });
        assert.ok(q.admitted, JSON.stringify(q));
        second = q.run.runId;
        await x.session.awaitRun(first.run.runId, 5000);
      } else {
        await x.session.awaitRun(first.run.runId, 5000);
        second = (await x.run('echo two')).runId;
      }
      const done = await x.session.awaitRun(second, 5000);
      assert.deepEqual([done.state, done.exit], ['exited', 0], JSON.stringify(done));
      const events = x.journal.since(0).events;
      const endOf = (id: string) => events.find((e) => e.type === 'run.end' && e.runId === id)!.seq;
      const between = events
        .flatMap((e) => (e.type === 'output' && e.seq > endOf(first.run.runId) && e.seq < endOf(second) ? [e.data] : []))
        .join('')
        .replace(/\x1b\][^\x07]*\x07/g, '');
      assert.equal(between.split("tsm-cmd-2'").length - 1, 1, `its line once: ${JSON.stringify(between)}`);
      assert.ok(!between.includes('^[['), `no key echoed by the terminal: ${JSON.stringify(between)}`);
    } finally {
      await x.close();
    }
  });
}
