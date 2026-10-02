/**
 * Real shells, second review: `exec` into another shell (ss-4), fish jobs that cancel and
 * signal reaches (ss-2) and `set -l` that lasts (ss-11), close that leaves no foreground
 * job behind (ss-6), a creation PATH that login files cannot reorder (ss-7), process
 * groups outliving their leader (ss-10), the /tmp command directory (jr2-3), and a
 * password typed at a prompt (m2-2). Every shell runs with a fake HOME.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JournalEvent } from '../src/core/types.js';
import { AGENT, HUMAN, hasShell, pgrep, realSession, reap, until } from './fake-shell.js';

const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The leftovers an armed exec could leave in the environment of the shell it became. */
const LEAKS = 'echo "[${TSM_MARK_KEY-}][${TSM_MARK_PID-}][${TSM_BASH_RC-}][${TSM_USER_ZDOTDIR-}][${TSM_XDG_DATA_DIRS-}]"';

const PAIRS: Array<[string, string]> = [
  ['/bin/bash', '/bin/zsh'],
  ['/bin/zsh', '/bin/bash'],
  ...(FISH ? ([['/bin/bash', FISH]] as Array<[string, string]>) : []),
];
for (const [from, to] of PAIRS) {
  test(`ss-4: \`exec ${to}\` in a ${from.split('/').pop()} session re-integrates the new shell; the exec Run ends lost (shell-replaced)`, async () => {
    const x = await realSession(from);
    try {
      const r = await x.run(`exec ${to}`, 8000);
      assert.deepEqual([r.state, r.reason], ['lost', 'shell-replaced']);
      assert.equal(x.session.integration, 'rich');
      const next = await x.run('sh -c "exit 3"');
      assert.deepEqual([next.state, next.exit], ['exited', 3]);
      if (!to.endsWith('fish')) assert.equal((await x.run(LEAKS)).text, '[][][][][]', 'the arm left nothing in the new shell\'s environment');
      const c = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 30', principal: AGENT });
      assert.ok(c.admitted);
      await sleep(300);
      assert.equal((await x.session.cancel(c.run.runId, AGENT, { graceMs: 400 })).state, 'cancelled');
    } finally {
      await x.close();
    }
  });
}

test('ss-4: `exec dash` replaces the shell with one that has no integration: lost (shell-replaced), level none, marker strategy and its cancel serve', { skip: !hasShell('/bin/dash') }, async () => {
  const x = await realSession('/bin/zsh', { integrationGraceMs: 800 });
  try {
    const r = await x.run('exec /bin/dash', 6000);
    assert.deepEqual([r.state, r.reason], ['lost', 'shell-replaced']);
    assert.equal(x.session.integration, 'none');
    assert.ok(x.journal.since(0).events.some((e) => e.type === 'integration' && e.level === 'none'), 'the change is journaled');
    const next = await x.run('sh -c "exit 3"');
    assert.deepEqual([next.state, next.exit], ['exited', 3]);
    const c = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 30', principal: AGENT });
    assert.ok(c.admitted);
    await sleep(300);
    const cr = await x.session.cancel(c.run.runId, AGENT, { graceMs: 400 });
    assert.equal(cr.state, 'cancelled', JSON.stringify(cr));
    assert.equal((await x.run('echo after')).text, 'after');
  } finally {
    await x.close();
  }
});

test('fish: ss-2/ss-11: a daemon line\'s job has its own process group — SIGTERM reaches it, cancel escalates past a pager — and `set -l` lasts', { skip: FISH === undefined ? 'fish is not installed' : false }, async () => {
  const x = await realSession(FISH!);
  try {
    const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'sleep 31.25', principal: AGENT });
    assert.ok(a.admitted);
    await until(() => pgrep('sleep 31.25').length > 0, 3000, 'job');
    await sleep(200);
    const fg = execFileSync('ps', ['-o', 'pgid=', '-p', String(pgrep('sleep 31.25')[0])], { encoding: 'utf8' }).trim();
    assert.notEqual(Number(fg), x.session.pid, 'the job is not in fish\'s process group');
    x.session.signal('SIGTERM', AGENT);
    const r = await x.session.awaitRun(a.run.runId, 3000);
    assert.equal(r.state, 'exited');
    assert.notEqual(r.exit, 0);
    // A job that ignores ^C and ^\ (a pager's way) still ends: the SIGTERM step reaches it.
    const b = await x.session.admitWhenAvailable({ target: 'shell', line: `sh -c 'trap "" INT QUIT; exec sleep 31.5'`, principal: AGENT });
    assert.ok(b.admitted);
    await sleep(500);
    const c = await x.session.cancel(b.run.runId, AGENT, { graceMs: 300 });
    assert.equal(c.state, 'cancelled', JSON.stringify(c));
    assert.ok(c.steps.some((s) => s.startsWith('SIGTERM')), JSON.stringify(c.steps));
    await x.run('set -l local_one 1');
    assert.equal((await x.run('echo "[$local_one]"')).text, '[1]', 'a Run\'s `set -l` lasts as when typed');
    await x.run('false');
    assert.equal((await x.run('echo $status')).text, '1', 'the text sees the status the prompt had');
  } finally {
    await x.close();
    reap('sleep 31.25');
    reap('sleep 31.5');
  }
});

for (const shell of ['/bin/bash', '/bin/zsh', ...(FISH ? [FISH] : [])]) {
  test(`${shell.split('/').pop()}: ss-6: close leaves no foreground job behind that ignores the hangup`, async () => {
    const tag = `tsm-hup-${process.pid}-${shell.split('/').pop()}`;
    const x = await realSession(shell);
    try {
      const a = await x.session.admitWhenAvailable({ target: 'shell', line: `python3 -c 'import signal,time; signal.signal(signal.SIGHUP, signal.SIG_IGN); time.sleep(60)' ${tag}`, principal: AGENT });
      assert.ok(a.admitted);
      await until(() => pgrep(tag).length > 0, 5000, 'job');
      await sleep(300);
    } finally {
      await x.close();
    }
    try {
      assert.deepEqual(pgrep(tag), [], 'nothing survived the close');
      const notes = x.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'note' }> => e.type === 'note');
      assert.ok(notes.some((n) => /survived the hangup; sent SIGTERM/.test(n.text)), notes.map((n) => n.text).join(' | '));
    } finally {
      reap(tag);
    }
  });
}

const SHIM = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-path-shim-'));
fs.writeFileSync(path.join(SHIM, 'python3'), '#!/bin/sh\necho SHIM-PYTHON\n', { mode: 0o755 });
after(() => fs.rmSync(SHIM, { recursive: true, force: true }));
for (const shell of ['/bin/bash', '/bin/zsh', ...(FISH ? [FISH] : [])]) {
  test(`${shell.split('/').pop()}: ss-7: a PATH given at creation comes first in a login shell, whatever the login files and the rc did`, async () => {
    const rc = shell.endsWith('fish') ? { '.config/fish/config.fish': 'set -gx PATH /opt/rc-added $PATH\n' } : { '.bash_profile': 'export PATH=/opt/rc-added:$PATH\n', '.zshrc': 'export PATH=/opt/rc-added:$PATH\n' };
    const given = `${SHIM}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const x = await realSession(shell, { env: { PATH: given }, login: true, rc });
    try {
      const r = await x.run(shell.endsWith('fish') ? 'string join : $PATH; python3' : 'echo "$PATH"; python3');
      const [p, py] = r.text.split('\n');
      assert.ok(p!.startsWith(`${given}:`), p);
      assert.ok(p!.includes('/opt/rc-added'), 'what the rc added is kept, after');
      assert.equal(py, 'SHIM-PYTHON', 'shell and process Runs run the same binaries');
    } finally {
      await x.close();
    }
  });
}

test('ss-10: members of a process Run\'s group that outlive the leader: output unattributed, cancel of the ended Run and close reach them', async () => {
  const tag = `${31 + (process.pid % 1000) / 1000}`;
  const x = await realSession('/bin/bash');
  try {
    const a = x.session.admit({ target: 'process', argv: ['sh', '-c', `sleep ${tag} & echo started; (sleep 0.4; echo late-output) &`], principal: AGENT });
    assert.ok(a.admitted);
    const r = await x.session.awaitRun(a.run.runId, 3000);
    assert.deepEqual([r.state, r.exit], ['exited', 0]);
    await until(() => x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes('late-output')), 3000, 'late output');
    const late = x.journal.since(0).events.find((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output' && e.data.includes('late-output'))!;
    assert.equal(late.runId, undefined);
    assert.equal((await x.session.runTranscript(r.runId)).text, 'started');
    assert.ok(pgrep(`sleep ${tag}`).length);
    const c = await x.session.cancel(r.runId, AGENT, { graceMs: 300 });
    assert.equal(c.state, 'exited', 'the recorded outcome stands');
    assert.ok(c.steps.length > 0, 'the group was signalled');
    await until(() => pgrep(`sleep ${tag}`).length === 0, 3000, 'group gone');
    // And close reaches a group whose leader already exited.
    const b = x.session.admit({ target: 'process', argv: ['sh', '-c', `sleep ${tag}1 & echo started`], principal: AGENT });
    assert.ok(b.admitted);
    await x.session.awaitRun(b.run.runId, 3000);
    assert.ok(pgrep(`sleep ${tag}1`).length);
  } finally {
    await x.close();
  }
  try {
    assert.deepEqual(pgrep(`sleep ${tag}1`), [], 'close tore the group down');
  } finally {
    reap(`sleep ${tag}`);
  }
});

test('jr2-3: after a cleaner, a command directory someone else recreated is not written through; the session falls back to its own', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cmdbase-'));
  fs.chmodSync(base, 0o700);
  const cmd = path.join(base, 'h1');
  fs.mkdirSync(cmd, { mode: 0o700 });
  const x = await realSession('/bin/bash', { commandDir: cmd });
  try {
    assert.equal((await x.run('echo first')).text, 'first');
    fs.rmSync(cmd, { recursive: true, force: true });
    fs.mkdirSync(cmd);
    fs.chmodSync(cmd, 0o777);
    const victim = path.join(base, 'victim');
    fs.writeFileSync(victim, 'untouched\n');
    fs.symlinkSync(victim, path.join(cmd, 'tsm-cmd-2'));
    const r = await x.run('echo second');
    assert.deepEqual([r.state, r.text], ['exited', 'second']);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n');
  } finally {
    await x.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('m2-2: a password typed at a real `read -s` prompt is journaled redacted and never promoted into a Run', async () => {
  const x = await realSession('/bin/bash');
  try {
    const a = await x.session.admitWhenAvailable({ target: 'shell', line: 'read -s -p "Password: " pw; echo; echo "got ${#pw}"', principal: AGENT });
    assert.ok(a.admitted);
    await until(() => x.session.snapshot().lines.some((l) => l.includes('Password:')), 3000, 'prompt');
    await x.session.screen.settled();
    x.session.releaseControl(AGENT);
    for (const ch of 'hunter2-S3cret') x.session.input(ch, { principal: HUMAN });
    x.session.input('\r', { principal: HUMAN });
    const r = await x.session.awaitRun(a.run.runId, 3000);
    assert.equal(r.state, 'exited');
    assert.match((await x.session.runTranscript(r.runId)).text, /got 14/);
    assert.ok(!JSON.stringify(x.journal.since(0).events).includes('hunter2'), 'the secret is in no event');
    const human = x.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'input' }> => e.type === 'input' && e.principal === HUMAN);
    assert.ok(human.every((e) => e.sensitive === true && e.data === '[redacted]'));
  } finally {
    await x.close();
  }
});
