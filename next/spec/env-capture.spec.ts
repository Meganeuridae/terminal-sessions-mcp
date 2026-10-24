/** Capture-file cleanup, owner-only permissions, and count-only journal output. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { AGENT, hasShell, ofType, realSession, scriptedSession } from './fake-shell.js';

const rawPath = (line: string): string => /^env -0 >\| '(.*)'$/.exec(line)![1]!;

for (const cancellation of ['works', 'running', 'throws']) {
  test(`env capture timeout cleans its file (cancellation ${cancellation})`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-env-timeout-'));
    let out = '';
    const h = await scriptedSession({ tempDir: dir, setup: (s) => s.on(/^env -0 >\| /, (line) => {
      out = rawPath(line);
      fs.writeFileSync(out, 'APP_VALUE=private\0');
      return { hang: true };
    }) });
    t.after(async () => { await h.session.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    if (cancellation !== 'works') t.mock.method(h.session, 'cancel', async (runId: string) => {
      if (cancellation === 'throws') throw new Error('cancel refused');
      return { runId, state: 'running' as const, contract: 'shell' as const, steps: [] };
    });
    await assert.rejects(h.session.captureEnv(AGENT, 0), /env capture did not complete/);
    assert.ok(out);
    assert.equal(fs.existsSync(out), false, 'the failed capture leaves no raw dump at return');
    if (cancellation === 'throws') assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => /env capture cancellation failed.*cancel refused/.test(e.text)));
    if (cancellation !== 'works') {
      fs.writeFileSync(out, 'LATE_VALUE=private\0');
      h.shell.finishHung(0);
      assert.equal(fs.existsSync(out), false, 'the Run ending reaps a file written after the timeout');
    } else {
      assert.ok(h.session.listRuns().every((r) => ['exited', 'lost', 'cancelled'].includes(r.state)), 'no internal capture remains running');
    }
    assert.equal(ofType(h.journal.since(0).events, 'env.snapshot').length, 0, 'a timeout never installs a snapshot');
  });
}

test('env capture journals a count, including when an ordinary variable holds a private value', async (t) => {
  const h = await scriptedSession({ setup: (s) => s.on(/^env -0 >\| /, (line) => {
    fs.writeFileSync(rawPath(line), 'APP_SECRET_CANARY=private-value-canary\0PATH=/bin\0');
    return { exit: 0 };
  }) });
  t.after(() => h.session.close());
  const snap = await h.session.captureEnv(AGENT);
  assert.equal(snap.vars.APP_SECRET_CANARY, 'private-value-canary', 'this value survives scrubbing and belongs in memory');
  const events = h.journal.since(0).events;
  const event = ofType(events, 'env.snapshot')[0]!;
  assert.equal(event.count, 2);
  assert.deepEqual(Object.keys(event).sort(), ['count', 'seq', 'ts', 'type']);
  assert.equal(JSON.stringify(events).includes('private-value-canary'), false);
  assert.equal(JSON.stringify(events).includes('APP_SECRET_CANARY'), false);
});

test('env capture reports removal failure without replacing its successful snapshot, and close retries', async (t) => {
  const fsc = createRequire(import.meta.url)('node:fs') as typeof fs;
  const remove = fsc.rmSync;
  let out = '';
  const h = await scriptedSession({ setup: (s) => s.on(/^env -0 >\| /, (line) => {
    out = rawPath(line);
    fs.writeFileSync(out, 'APP_VALUE=private\0');
    return { exit: 0 };
  }) });
  t.after(async () => { fsc.rmSync = remove; syncBuiltinESMExports(); await h.session.close(); });
  fsc.rmSync = ((file: fs.PathLike, opts?: fs.RmOptions) => {
    if (String(file) === out && out) throw Object.assign(new Error('capture cleanup denied'), { code: 'EACCES' });
    return remove(file, opts);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  const snap = await h.session.captureEnv(AGENT);
  assert.equal(snap.vars.APP_VALUE, 'private');
  assert.ok(ofType(h.journal.since(0).events, 'note').some((e) => e.text.includes(out) && /EACCES/.test(e.text)), 'the retained raw file is reported');
  assert.equal(fs.existsSync(out), true);
  fsc.rmSync = remove;
  syncBuiltinESMExports();
  await h.session.close();
  assert.equal(fs.existsSync(out), false, 'close retries the retained file');
});

test('env capture raw files are owner-only even with an ordinary shell umask', async (t) => {
  const oldMask = process.umask(0o022);
  let mode: number | undefined;
  const h = await scriptedSession({ setup: (s) => s.on(/^env -0 >\| /, (line) => {
    const out = rawPath(line);
    fs.writeFileSync(out, 'APP_VALUE=private\0');
    mode = fs.statSync(out).mode & 0o777;
    return { exit: 0 };
  }) });
  t.after(async () => { process.umask(oldMask); await h.session.close(); });
  await h.session.captureEnv(AGENT);
  assert.equal(mode, 0o600);
});

for (const [shell, enableNoclobber] of [
  ['/bin/bash', 'set -C'],
  [['/bin/zsh', '/usr/bin/zsh'].find(hasShell), 'setopt noclobber'],
] as const) {
  test(`${shell ?? 'zsh'}: environment capture works with noclobber enabled`, { skip: !shell || !hasShell(shell) }, async () => {
    const x = await realSession(shell!, { login: false });
    try {
      const set = await x.run(`${enableNoclobber}; export PROBE_NOCLOBBER=sentinel`, 5000);
      assert.equal(set.exit, 0);
      const snap = await x.session.captureEnv(AGENT, 5000);
      assert.equal(snap.vars.PROBE_NOCLOBBER, 'sentinel');
    } finally {
      await x.close();
    }
  });
}

const fish = ['/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'].find(hasShell);
test('fish environment capture uses its supported redirection into an existing file', { skip: !fish }, async () => {
  const x = await realSession(fish!, { login: false });
  try {
    const set = await x.run('set -gx PROBE_FISH_CAPTURE sentinel', 5000);
    assert.equal(set.exit, 0);
    const snap = await x.session.captureEnv(AGENT, 5000);
    assert.equal(snap.vars.PROBE_FISH_CAPTURE, 'sentinel');
  } finally {
    await x.close();
  }
});
