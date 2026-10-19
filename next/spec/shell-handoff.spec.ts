/** Completion credentials must not travel with ordinary child environments. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { processLaunch } from '../src/core/launch.js';
import type { JournalEvent } from '../src/core/types.js';
import { prepareIntegration } from '../src/shell/integration.js';
import { AGENT, hasShell, realSession, until } from './fake-shell.js';

const shells = ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', '/usr/bin/fish'].filter(hasShell);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

for (const shell of shells) {
  test(`${shell}: quoted exec, exported prompts and delayed children cannot forge completion`, async () => {
    const rc = shell.endsWith('fish') ? {} : { [shell.endsWith('zsh') ? '.zshrc' : '.bashrc']: 'export PS1="exported> "\nset -a\n' };
    const x = await realSession(shell, { rc, login: false, env: { UNRELATED_HEX: '0123456789abcdef0123456789abcdef' } });
    try {
      assert.ok(x.integrationKey);
      const expectedHash = createHash('sha256').update(x.integrationKey).digest('hex');
      const child = path.join(x.tmp, 'child.cjs');
      const receipt = path.join(x.tmp, 'receipt');
      const bgReceipt = path.join(x.tmp, 'receipt-bg');
      fs.writeFileSync(child, `
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const key = Object.values(process.env).flatMap(v => [...v.matchAll(/(?:^|;k=)([a-f0-9]{32})(?=\\x07|$)/g)]).map(m => m[1]).find(k => createHash('sha256').update(k).digest('hex') === ${JSON.stringify(expectedHash)});
fs.writeFileSync(process.env.RECEIPT || ${JSON.stringify(receipt)}, key ? 'leaked' : 'private');
setTimeout(() => {
  if (key) process.stdout.write('\\x1b]133;D;0;k=' + key + '\\x07');
  setTimeout(() => { console.log('ACTUAL-END'); process.exit(7); }, 200);
}, process.argv[2] === 'later' ? 700 : 0);
`);
      const control = spawnSync(process.execPath, [child], { env: { ...process.env, CONTROL_MARK_KEY: x.integrationKey }, stdio: 'ignore' });
      assert.equal(control.status, 7);
      assert.equal(fs.readFileSync(receipt, 'utf8'), 'leaked', 'the probe detects the actual key when deliberately supplied');
      const cmd = `${quote(process.execPath)} ${quote(child)}`;
      const result = await x.run(`: ' exec '; ${cmd}`);
      assert.equal(fs.readFileSync(receipt, 'utf8'), 'private');
      assert.deepEqual([result.state, result.exit], ['exited', 7]);
      assert.match(result.text, /ACTUAL-END/);
      // Disarming a hint must not leave a background child with a reusable credential. The background
      // child writes a receipt of its own, so the check proves it ran and found no key, rather than
      // passing on the foreground run's receipt (the house's read of a6d0c35, #22).
      await x.run(`: ' exec '; env RECEIPT=${quote(bgReceipt)} ${cmd} later &`);
      const later = await x.run('sleep 1.2; false');
      assert.deepEqual([later.state, later.exit], ['exited', 1]);
      assert.equal(fs.readFileSync(receipt, 'utf8'), 'private');
      assert.equal(fs.readFileSync(bgReceipt, 'utf8'), 'private', 'the background child ran and inherited no reusable key');
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
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': 'sleep 0.8; exec /bin/cat\n' }, integrationGraceMs: 100, startupCapMs: 400 });
  try {
    // The cap resolves `start` at 400 ms whatever the shell has done by then; on a loaded machine
    // bash may not have reached its rc yet, and the session is still `starting` (never `idle`).
    assert.notEqual(x.session.info().state, 'idle');
    await until(() => x.session.info().state !== 'starting', 5000);
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

test("the launcher's owner-only mask covers the key file alone: the shell starts with the mask it inherited and creates ordinary files", async () => {
  const x = await realSession('/bin/bash');
  try {
    const inherited = process.umask().toString(8).padStart(4, '0');
    const r = await x.run('umask');
    assert.equal(r.text.trim(), inherited, 'the shell has the mask termd has');
    const file = path.join(x.tmp ?? process.env.TMPDIR ?? '/tmp', `tsm-umask-${process.pid}`);
    assert.equal((await x.run(`rm -f '${file}'; touch '${file}'`)).exit, 0);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), (0o666 & ~process.umask()).toString(8), 'a file the session creates has the usual mode, not 0600');
    fs.rmSync(file, { force: true });
  } finally {
    await x.close();
  }
});

test("the shells' oom_score_adj is the daemon's setting: written when set, absent at 0 or unset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-oom-'));
  try {
    const none = prepareIntegration('/bin/bash', { dir: path.join(dir, 'a'), noUserRc: true });
    assert.doesNotMatch(fs.readFileSync(none.launcher!, 'utf8'), /oom_score_adj/);
    const zero = prepareIntegration('/bin/bash', { dir: path.join(dir, 'b'), noUserRc: true, oomScoreAdj: 0 });
    assert.doesNotMatch(fs.readFileSync(zero.launcher!, 'utf8'), /oom_score_adj/);
    const some = prepareIntegration('/bin/bash', { dir: path.join(dir, 'c'), noUserRc: true, oomScoreAdj: 300 });
    assert.match(fs.readFileSync(some.launcher!, 'utf8'), /echo 300 > \/proc\/self\/oom_score_adj/);
    assert.doesNotMatch(processLaunch(false, 0), /oom_score_adj/);
    assert.match(processLaunch(true, 200), /echo 200 > \/proc\/self\/oom_score_adj/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [how, rc] of [
  ['assigns', "PROMPT_COMMAND='history -a'\n"],
  ['appends to', "PROMPT_COMMAND+='; history -a'\n"],
] as const) {
  test(`an exec into a bash whose rc ${how} PROMPT_COMMAND still integrates, and the rc's own command is never a Run`, { skip: !hasShell('/bin/bash') }, async () => {
    const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': rc }, startupCapMs: 1500 });
    try {
      const handoff = await x.run('exec /bin/bash', 20_000);
      assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
      const back = await x.run('echo back', 20_000);
      assert.deepEqual([back.state, back.exit, back.text.trim()], ['exited', 0, 'back']);
      assert.equal(x.session.integration, 'rich');
      assert.ok(!x.session.listRuns().some((r) => (r.line ?? '').includes('history -a')), "the rc's command opened no Run");
      const notes = x.journal.since(0).events.filter((e) => e.type === 'note').map((e) => (e as { text: string }).text);
      if (how === 'assigns') assert.ok(notes.some((t) => /did not load the shell integration/.test(t)), `the daemon reloaded it: ${JSON.stringify(notes)}`);
      assert.equal((await x.run('echo again')).text.trim(), 'again');
    } finally {
      await x.close();
    }
  });
}

const handoffOutput = (x: Awaited<ReturnType<typeof realSession>>): string =>
  x.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'output' }> => e.type === 'output').map((e) => e.data).join('');

const handoffNotes = (x: Awaited<ReturnType<typeof realSession>>): string[] =>
  x.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'note' }> => e.type === 'note').map((e) => e.text);

const PY = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(hasShell);

test('/bin/bash: the reinit is never typed into an rc that reads a line before its first prompt', { skip: !hasShell('/bin/bash') }, async () => {
  // The post-exec bash replaces PROMPT_COMMAND (no hello) and reads a line before any prompt. The
  // daemon must not type its reinit into that read — the terminal is canonical then, not readline
  // (the house's read, #22 comment 6264958172). It waits, then gives up as a replacement.
  const x = await realSession('/bin/bash', {
    login: false,
    rc: { '.bashrc': 'PROMPT_COMMAND=:\nif [ -n "${SECOND-}" ]; then IFS= read -r -p "rc-read> " __x; printf "RC-GOT:[%s]\\n" "$__x"; fi\n' },
    startupCapMs: 400,
    integrationGraceMs: 300,
  });
  try {
    await until(() => x.session.shellAvailable().ok, 5000, 'first shell ready');
    const handoff = await x.run('export SECOND=1; exec /bin/bash', 20_000);
    assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
    await until(() => x.session.info().state === 'unavailable', 8000, 'unavailable');
    // Complete the still-blocked read and read back what it captured: nothing, not the reinit line.
    x.session.input('\n', { principal: AGENT });
    await until(() => /RC-GOT:\[[^\]]*\]/.test(handoffOutput(x)), 3000, 'the rc read completed');
    const out = handoffOutput(x);
    assert.ok(!out.includes('reinit typed'), `the reinit leaked into the read: ${out.match(/RC-GOT:\[[^\]]*\]/)?.[0]}`);
    assert.match(out, /RC-GOT:\[\]/);
  } finally {
    await x.close();
  }
});

test('/bin/bash: exec into `bash --noediting` gets the honest note, not a false give-up, and the reinit is not typed', { skip: !hasShell('/bin/bash') }, async () => {
  // A --noediting prompt is canonical, like a `read -p`, and the two cannot be told apart: the daemon
  // does not type the reinit, and says exactly that (with the manual recovery and that --noediting is
  // unsupported) instead of the old false "a program read its input" give-up (the house's read, #22
  // comment 6269901528).
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': 'PROMPT_COMMAND=:\n' }, startupCapMs: 500, integrationGraceMs: 400 });
  try {
    await until(() => x.session.shellAvailable().ok, 5000, 'first shell ready');
    const handoff = await x.run('exec /bin/bash --noediting', 20_000);
    assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
    await until(() => x.session.info().state === 'unavailable', 10_000, 'unavailable');
    assert.ok(!handoffOutput(x).includes('reinit typed'), 'the reinit was not typed at the canonical prompt');
    const note = handoffNotes(x).join(' | ');
    assert.match(note, /canonical mode/);
    assert.match(note, /--noediting is unsupported for the handoff/);
    assert.match(note, /TSM_BASH_RC" reinit typed/, 'the note gives the manual recovery');
    assert.doesNotMatch(note, /while a program read its input/, 'not the old false give-up wording');
  } finally {
    await x.close();
  }
});

test('/bin/bash: the reinit is not typed while a program the rc started is reading (a child), even non-canonical', { skip: !hasShell('/bin/bash') || PY === undefined }, async () => {
  // A raw-mode reader the rc started is a child and leaves the terminal non-canonical; non-canonical
  // does not prove readline. Without the child check the daemon would type the reinit into that
  // program (the house's read, #22 comment 6269901528). `read -e`/`read -n` builtins have no child
  // and stay a stated limit; this is the external-reader case the child check catches.
  const reader = `${PY} -c 'import sys,tty; tty.setcbreak(sys.stdin.fileno()); sys.stdout.write("PYREADY\\n"); sys.stdout.flush(); d=sys.stdin.read(1); sys.stdout.write("PYGOT:["+d+"]\\n"); sys.stdout.flush()'`;
  const x = await realSession('/bin/bash', {
    login: false,
    rc: { '.bashrc': `PROMPT_COMMAND=:\nif [ -n "\${SECOND-}" ]; then ${reader}; fi\n` },
    startupCapMs: 500,
    integrationGraceMs: 400,
  });
  try {
    await until(() => x.session.shellAvailable().ok, 5000, 'first shell ready');
    const handoff = await x.run('export SECOND=1; exec /bin/bash', 20_000);
    assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
    await until(() => /PYREADY/.test(handoffOutput(x)), 8000, 'the child reader started');
    await until(() => x.session.info().state === 'unavailable', 10_000, 'unavailable');
    const out = handoffOutput(x);
    assert.ok(!out.includes('reinit typed'), 'nothing was typed into the child reader');
    assert.doesNotMatch(out, /PYGOT:/, 'the child reader received nothing from the daemon');
    assert.ok(handoffNotes(x).some((t) => /a program it started is reading its input/.test(t)), `the note names the reading program: ${JSON.stringify(handoffNotes(x))}`);
  } finally {
    await x.close();
  }
});

test('/bin/bash: with promptvars off, exec bash integrates and the next Runs exit 0', { skip: !hasShell('/bin/bash') }, async () => {
  // __tsm_reinit_pending is cleared by PS1's arithmetic, which promptvars off never expands; the
  // hook now clears it at the end of PROMPT_COMMAND when it stands alone, so the DEBUG trap does not
  // stand down for good after exec bash (the house's read, #22 comment 6264958172).
  const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': 'shopt -u promptvars\n' }, startupCapMs: 1500 });
  try {
    const handoff = await x.run('exec /bin/bash', 20_000);
    assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
    const a = await x.run('echo one', 20_000);
    const b = await x.run('echo two', 20_000);
    assert.deepEqual([a.state, a.exit, a.text.trim()], ['exited', 0, 'one']);
    assert.deepEqual([b.state, b.exit, b.text.trim()], ['exited', 0, 'two']);
  } finally {
    await x.close();
  }
});

for (const [how, rc] of [
  ['replaces', "PROMPT_COMMAND='history -a'\nshopt -u promptvars\n"],
  ['appends to', "PROMPT_COMMAND+='; history -a'\nshopt -u promptvars\n"],
] as const) {
  test(`/bin/bash: with promptvars off, exec into a bash whose rc ${how} PROMPT_COMMAND still runs the next Runs to exit 0`, { skip: !hasShell('/bin/bash') }, async () => {
    // "replaces" takes the typed reinit path (no hello; the daemon types the reinit), which left
    // __tsm_reinit_pending set for good with promptvars off; "appends to" has a part of the inherited
    // value still to run after the hook, where PS1 cannot clear the flag either: the DEBUG trap stands
    // down for that part's commands and clears the flag at the first command that is not one of them,
    // so no phantom Run opens and the next Run is detected (the reviewer's read of 2f32e8a..a088780, #22).
    const x = await realSession('/bin/bash', { login: false, rc: { '.bashrc': rc }, startupCapMs: 1500 });
    try {
      const handoff = await x.run('exec /bin/bash', 20_000);
      assert.deepEqual([handoff.state, handoff.reason], ['lost', 'shell-replaced']);
      const a = await x.run('echo one', 20_000);
      const b = await x.run('echo two', 20_000);
      assert.deepEqual([a.state, a.exit, a.text.trim()], ['exited', 0, 'one'], how);
      assert.deepEqual([b.state, b.exit, b.text.trim()], ['exited', 0, 'two'], how);
    } finally {
      await x.close();
    }
  });
}
