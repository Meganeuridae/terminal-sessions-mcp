import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/core/journal.js';
import { Session } from '../src/core/session.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { AGENT, fakeShellBackend, hasShell, scriptedSession, until } from './fake-shell.js';
import type { ExecutionBackend } from '../src/backends/types.js';

test('direct Session construction requires an explicit tempDir before spawning', async () => {
  let spawned = 0;
  const backend = { spawnShell() { spawned++; throw new Error('spawn before directory validation'); } } as unknown as ExecutionBackend;
  await assert.rejects(
    Session.start({
      id: 'missing-private-dir',
      owner: 'agent:a@test',
      shell: '/bin/fake',
      cwd: '/home/t',
      backend,
      journal: new Journal(),
      tempDir: undefined as unknown as string,
    }),
    /tempDir/,
  );
  assert.equal(spawned, 0, 'no directory supplied never starts the shell');
});

test('scripted Sessions have distinct private command directories', async () => {
  const a = await scriptedSession();
  const b = await scriptedSession();
  try {
    const ar = a.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
    const br = b.session.admit({ target: 'shell', line: 'echo hello', principal: AGENT });
    assert.ok(ar.admitted && br.admitted);
    const file = (written: string) => /'([^']*tsm-cmd-1)'/.exec(written)?.[1];
    const af = file(a.pty.written);
    const bf = file(b.pty.written);
    assert.ok(af && bf);
    assert.notEqual(path.dirname(af), path.dirname(bf), 'one fixture cannot unlink the other fixture’s pending command');
    assert.equal((await a.session.awaitRun(ar.run.runId, 500)).state, 'exited');
    assert.equal((await b.session.awaitRun(br.run.runId, 500)).state, 'exited');
  } finally {
    await a.session.close();
    await b.session.close();
  }
});

test('direct Session rejects a permissive or linked tempDir before spawning', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-direct-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  const broad = path.join(root, 'broad');
  fs.mkdirSync(broad, { mode: 0o777 });
  fs.chmodSync(broad, 0o777);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(target, linked, 'dir');
  for (const tempDir of [broad, linked]) {
    let spawned = 0;
    const backend = { spawnShell() { spawned++; throw new Error('spawned before private directory validation'); } } as unknown as ExecutionBackend;
    await assert.rejects(Session.start({ id: 'private-dir', owner: AGENT, shell: '/bin/fake', cwd: root, backend, journal: new Journal(), tempDir }), /private|directory/);
    assert.equal(spawned, 0, `a Session did not spawn under ${tempDir}`);
  }
});

test('registry refuses a preexisting permissive shell directory before spawning a new life', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-preexisting-shell-'));
  const backend = fakeShellBackend(() => {}, { marks: 'rich' });
  const reg = new SessionRegistry({ dataDir, backend, defaultShell: '/bin/bash', noUserRc: true });
  t.after(async () => { await reg.closeAll(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await reg.create({ id: 'private', owner: AGENT });
  await reg.close('private');
  const shell = path.join(dataDir, 'sessions', 'private', 'shell');
  fs.chmodSync(shell, 0o777);
  const before = backend.ptys.length;
  await assert.rejects(reg.create({ id: 'private', owner: AGENT }), /private|directory/);
  assert.equal(backend.ptys.length, before, 'the bad directory stopped the shell before spawn');
});

test('recovery does not follow an untrusted shell link or remove its command-like files', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-shell-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-outside-shell-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const options = { dataDir, backend: fakeShellBackend(() => {}, { marks: 'rich' }), defaultShell: '/bin/bash', noUserRc: true };
  const first = new SessionRegistry(options);
  await first.create({ id: 'linked', owner: AGENT });
  await first.close('linked');
  await first.closeAll();
  const shell = path.join(dataDir, 'sessions', 'linked', 'shell');
  fs.rmSync(shell, { recursive: true, force: true });
  const sentinel = path.join(outside, 'tsm-cmd-outside');
  fs.writeFileSync(sentinel, 'outside');
  fs.symlinkSync(outside, shell, 'dir');
  const warnings: Array<{ message: string; session: unknown }> = [];
  const second = new SessionRegistry({ ...options, log: (level, message, fields) => {
    if (level === 'warn' && message.includes('leftover')) warnings.push({ message, session: fields?.session });
  } });
  t.after(() => second.closeAll());
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside', 'cleanup left the linked target alone');
  assert.equal(warnings.length, 1, 'recovery names the single skipped cleanup');
  assert.ok(warnings[0]!.message.includes(shell), 'the warning names the directory that still holds any leftovers');
  assert.match(warnings[0]!.message, /not private/);
  assert.equal(warnings[0]!.session, 'linked', 'the warning is searchable by session ID');
  const before = options.backend.ptys.length;
  await assert.rejects(second.create({ id: 'linked', owner: AGENT }), /private|directory/);
  assert.equal(options.backend.ptys.length, before);
});

test('a missing old shell directory is not reported as a failed cleanup', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-shell-missing-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, backend: fakeShellBackend(() => {}, { marks: 'rich' }), defaultShell: '/bin/bash', noUserRc: true };
  const first = new SessionRegistry(options);
  await first.create({ id: 'missing', owner: AGENT });
  await first.closeAll();
  fs.rmSync(path.join(dataDir, 'sessions', 'missing', 'shell'), { recursive: true, force: true });
  const warnings: string[] = [];
  const second = new SessionRegistry({ ...options, log: (level, message) => { if (level === 'warn' && message.includes('leftover')) warnings.push(message); } });
  t.after(() => second.closeAll());
  assert.deepEqual(warnings, []);
});

for (const [name, shell] of [
  ['bash', '/bin/bash'],
  ['zsh', ['/bin/zsh', '/usr/bin/zsh'].find(hasShell)],
  ['fish', ['/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'].find(hasShell)],
] as const) {
  test(`${name}: a command under an apostrophe in the data-dir path is quoted and recognised`, { skip: !shell || !hasShell(shell) }, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm-path-'$; quote-"));
    const reg = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: shell!, noUserRc: true });
    t.after(async () => { await reg.closeAll(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const { session } = await reg.ensure({ id: 'quoted', owner: AGENT });
    session.attach(AGENT, 'c1');
    const admitted = await session.admitWhenAvailable({ target: 'shell', line: 'echo QUOTED_DIR_OK', principal: AGENT }, 3000);
    assert.ok(admitted.admitted);
    const result = await session.awaitRun(admitted.run.runId, 5000);
    assert.deepEqual([result.state, result.exit], ['exited', 0]);
    const transcript = await session.runTranscript(admitted.run.runId);
    assert.match(transcript.text, /QUOTED_DIR_OK/);
    assert.doesNotMatch(transcript.text, /tsm-cmd-/, 'the quoted path is still cut from the Run transcript');
    assert.equal(session.listRuns().filter((r) => r.origin === 'human').length, 0, 'the integration recognises its command-file basename');
  });
}

for (const [name, shell] of [
  ['bash', '/bin/bash'],
  ['zsh', ['/bin/zsh', '/usr/bin/zsh'].find(hasShell)],
] as const) {
  test(`${name}: a typed ordinary file under a tsm-cmd-named directory stays in history`, { skip: !shell || !hasShell(shell) }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-basename-'));
    const dataDir = path.join(root, 'tsm-cmd-7');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const script = path.join(dataDir, 'ordinary.sh');
    const prefixed = path.join(dataDir, 'ordinary-tsm-cmd-8');
    fs.writeFileSync(script, 'echo USER_SCRIPT_OK\n');
    fs.writeFileSync(prefixed, 'echo PREFIXED_FILE_OK\n');
    const reg = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: shell!, noUserRc: true });
    t.after(async () => { await reg.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
    const { session } = await reg.ensure({ id: 'typed', owner: AGENT });
    session.attach(AGENT, 'c1');
    const beforeControl = session.listRuns().length;
    session.input('echo TYPED_CONTROL_OK\n', { principal: AGENT });
    await until(() => session.listRuns().slice(beforeControl).some((r) => r.state === 'exited'), 5000, 'plain typed Run to finish');
    const before = session.listRuns().length;
    session.input(` . '${script}'\n`, { principal: AGENT });
    await until(() => session.listRuns().slice(before).some((r) => r.state === 'exited'), 5000, 'typed source Run to finish');
    const typed = session.listRuns().slice(before).find((r) => r.state === 'exited')!;
    assert.match((await session.runTranscript(typed.runId)).text, /USER_SCRIPT_OK/);
    const beforePrefixed = session.listRuns().length;
    session.input(` . '${prefixed}'\n`, { principal: AGENT });
    await until(() => session.listRuns().slice(beforePrefixed).some((r) => r.state === 'exited'), 5000, 'prefixed filename Run to finish');
    const prefixedRun = session.listRuns().slice(beforePrefixed).find((r) => r.state === 'exited')!;
    assert.match((await session.runTranscript(prefixedRun.runId)).text, /PREFIXED_FILE_OK/);
    const hist = await session.admitWhenAvailable({ target: 'shell', line: name === 'zsh' ? 'fc -ln 1' : 'history 5', principal: AGENT }, 3000);
    assert.ok(hist.admitted);
    await session.awaitRun(hist.run.runId, 5000);
    const history = (await session.runTranscript(hist.run.runId)).text;
    assert.match(history, /ordinary\.sh/, 'the user file remains in history despite its parent name');
    assert.match(history, /ordinary-tsm-cmd-8/, 'a user filename with that suffix remains distinct from a daemon filename');
    assert.doesNotMatch(history, /sessions\/typed\/shell\/tsm-cmd-[0-9]+/, 'daemon command files in that same parent stay out of history');
  });
}
