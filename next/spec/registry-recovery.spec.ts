/**
 * What a name keeps across lives and restarts, and what recovery cleans up:
 * orphaned process groups of a dead daemon (jr2-4, G19c), command files left in
 * /tmp (jr2-12, G26), the session's creation options (ux-4), per-principal
 * delivery cursors (m2-4, mcpl-2; G22), the journal's epoch (mcpl-4), events a
 * failing disk refused (jr2-6; G10, G11), and age retention on live sessions
 * (jr2-7; G21). Each test is named for the finding it encodes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry, type AnySession, type HistorySession, type LiveSession } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { Journal } from '../src/core/journal.js';
import { groupAlive } from '../src/core/lock.js';
import type { Session } from '../src/core/session.js';
import { FileStore } from '../src/core/stores.js';
import type { JournalEvent } from '../src/core/types.js';
import { FakeShell } from './fake-shell.js';

const A = 'agent:a@test';
const B = 'agent:b@test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-recovery-'));
let dirs = 0;
after(() => {
  // Command directories live in /tmp, outside the data dirs (jr2-12).
  for (let i = 1; i <= dirs; i++) {
    const dir = path.join(tmp, `d${i}`, 'sessions');
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(commandDirOf(path.join(tmp, `d${i}`), id), { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Rig {
  dir: string;
  backend: ScriptedBackend;
  reg: SessionRegistry;
}

function rig(dir = path.join(tmp, `d${++dirs}`), extra: Partial<ConstructorParameters<typeof SessionRegistry>[0]> = {}): Rig {
  const backend = new ScriptedBackend();
  backend.onSpawnShell = (p) => {
    const sh = new FakeShell(p, { marks: 'rich' });
    sh.on(/^echo (.*)$/, (l) => ({ output: `${l.slice(5)}\r\n`, exit: 0 }));
    sh.on(/^sleep/, () => ({ hang: true }));
    const kill = p.kill.bind(p);
    p.kill = (sig) => {
      kill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') queueMicrotask(() => p.exit({ exitCode: null, signal: sig }));
    };
  };
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), ...extra });
  return { dir, backend, reg };
}

const restart = (r: Rig) => rig(r.dir);

async function run(session: Session, line: string, principal = A) {
  if (!session.listAttachments().some((a) => a.principal === principal)) session.attach(principal, `conn-${principal}`);
  const a = await session.admitWhenAvailable({ target: 'shell', line, principal });
  assert.ok(a.admitted, `admitted ${line}`);
  return session.awaitRun(a.run.runId, 2000);
}

const hist = (s: AnySession | undefined): HistorySession => {
  assert.ok(s && s.kind === 'history', `expected history, got ${s?.kind}`);
  return s;
};
const live = (s: AnySession | undefined): LiveSession => {
  assert.ok(s && s.kind === 'live', `expected live, got ${s?.kind}`);
  return s;
};
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const shellExits = async (r: Rig, s: Session, code = 0) => {
  r.backend.ptys[r.backend.ptys.length - 1]!.exit({ exitCode: code });
  await until(() => s.state === 'exited');
};
const commandDirOf = (dataDir: string, id: string) =>
  path.join(`/tmp/tsm-${process.getuid!()}`, createHash('sha256').update(`${path.resolve(dataDir)}\0${id}`).digest('hex').slice(0, 8));
const onDisk = (sdir: string) =>
  fs
    .readdirSync(sdir)
    .filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n))
    .sort((a, b) => (a === 'journal.jsonl' ? 1 : b === 'journal.jsonl' ? -1 : Number(a.split('.')[1]) - Number(b.split('.')[1])))
    .flatMap((n) => fs.readFileSync(path.join(sdir, n), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as JournalEvent)
    .filter((e) => typeof e.seq === 'number');

// ───────────── jr2-4: orphaned process groups ─────────────

test('jr2-4/G19c/G20/G29: recovery terminates the process groups a dead daemon left running — SIGTERM, then SIGKILL — and says so in the lost Run', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'k1');
  const kids: ChildProcess[] = [];
  const detached = (cmd: string, args: string[]) => {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    kids.push(c);
    return c.pid!;
  };
  try {
    const ready = path.join(dir, 'stubborn-ready');
    fs.mkdirSync(dir, { recursive: true });
    const polite = detached('sleep', ['401']); // ends on SIGTERM
    const stubborn = detached('/bin/sh', ['-c', "trap '' TERM; printf ready > \"$1\"; sleep 402; :", 'recovery-test', ready]); // ignores SIGTERM, its sleep too
    const stranger = detached('sleep', ['403']); // a live group whose leader predates the Run: a reused pid
    const gone = detached('true', []);
    // The synthetic Run starts with these processes, not after an arbitrary delay.
    // Observe the installed trap before recovery tries to exercise SIGKILL escalation.
    let ts = Date.now();
    await until(() => fs.existsSync(ready) && !groupAlive(gone));
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'k1', now: () => ts });
    const proc = (runId: string, pid: number) => {
      j.append({ type: 'run.admit', runId, target: 'process', line: runId, principal: A, origin: 'self', queued: false });
      j.append({ type: 'run.start', runId, cwd: '/', envBasis: 'configured', pid, pgid: pid });
    };
    proc('r1-polite', polite);
    proc('r2-stubborn', stubborn);
    proc('r3-gone', gone);
    ts += 30_000; // this Run started half a minute after its "leader" did
    proc('r4-stranger', stranger);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });

    const t0 = Date.now();
    const r = rig(dir, { terminateOrphans: true });
    const took = Date.now() - t0;
    assert.ok(took < 3500, `startup delayed ${took} ms`);
    assert.ok(took >= 1900, `the stubborn group got its SIGTERM grace (${took} ms)`);
    const h = hist(r.reg.get('k1'));
    assert.deepEqual([h.run('r1-polite').state, h.run('r1-polite').reason], ['lost', `daemon-restart; process group ${polite} terminated`]);
    assert.deepEqual([h.run('r2-stubborn').state, h.run('r2-stubborn').reason], ['lost', `daemon-restart; process group ${stubborn} terminated`]);
    assert.equal(h.run('r3-gone').reason, 'daemon-restart');
    assert.equal(h.run('r4-stranger').reason, 'daemon-restart', 'a group that is not the Run\'s is left alone');
    await until(() => kids[0]!.exitCode !== null || kids[0]!.signalCode !== null);
    await until(() => kids[1]!.exitCode !== null || kids[1]!.signalCode !== null);
    assert.equal(kids[0]!.signalCode, 'SIGTERM');
    assert.equal(kids[1]!.signalCode, 'SIGKILL');
    assert.ok(!groupAlive(polite) && !groupAlive(stubborn), 'nothing of either group survives');
    assert.ok(groupAlive(stranger), 'the stranger still runs');
    await r.reg.closeAll();
    // A scripted backend's pids are not real processes: by default nothing is signalled.
    const plain = rig(path.join(tmp, `d${++dirs}`));
    await plain.reg.closeAll();
  } finally {
    for (const c of kids) {
      try {
        process.kill(-c.pid!, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
});

// ───────────── jr2-12: command files ─────────────

test('jr2-12/G26: recovery deletes a crashed life\'s command files, and forget deletes the command directory', async () => {
  const r1 = rig();
  const s = (await r1.reg.ensure({ id: 'k3', owner: A })).session;
  await run(s, 'echo export API_TOKEN=sekrit');
  const cmd = commandDirOf(r1.dir, 'k3');
  assert.ok(fs.readdirSync(cmd).some((n) => n.startsWith('tsm-cmd-')), 'the life keeps its command files while it runs');
  const shellDir = path.join(r1.dir, 'sessions', 'k3', 'shell');
  fs.writeFileSync(path.join(shellDir, 'tsm-cmd-9'), 'export API_TOKEN=fallback-copy\n', { mode: 0o600 });
  fs.writeFileSync(path.join(shellDir, 'tsm-history-k3'), ': the session history stays\n', { mode: 0o600 });
  // The daemon dies (never closed); a new one recovers the data dir.
  const r2 = restart(r1);
  assert.equal(fs.existsSync(cmd), false, 'the /tmp command directory is gone');
  // The session's history stays (its HISTFILE and atuin directory, ux-3), and the integration files the next life rewrites.
  assert.deepEqual(fs.readdirSync(shellDir).sort(), ['integration', 'tsm-history-k3', 'tsm-history-k3.d'], 'fallback command files go, the session history stays');
  // A crashed life's leftovers again, then forget.
  fs.mkdirSync(cmd, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cmd, 'tsm-cmd-3'), 'export API_TOKEN=sekrit; sleep 403\n', { mode: 0o600 });
  await r2.reg.remove('k3');
  assert.equal(fs.existsSync(cmd), false, 'forget removes the command directory');
  assert.equal(fs.existsSync(path.join(r2.dir, 'sessions', 'k3')), false);
  await r2.reg.closeAll();
  await r1.reg.closeAll();
});

// ───────────── ux-4: creation options ─────────────

test('ux-4: a new life — after the shell exits, and after a restart — keeps the shell, args, login, visibility, control, env, cwd and size', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const r1 = rig();
  const created = {
    id: 'bsh',
    owner: A,
    shell: '/bin/zsh',
    shellArgs: ['-o', 'NO_BEEP'],
    login: false,
    env: { MYVAR: 'set-at-create' },
    visibility: 'shared' as const,
    control: 'open' as const,
    cwd,
    cols: 100,
    rows: 40,
    retention: { maxAgeMs: 3_600_000 },
  };
  const s1 = (await r1.reg.ensure(created)).session;
  const spawned = (r: Rig) => r.backend.ptys[r.backend.ptys.length - 1]!.opts;
  const first = spawned(r1);
  assert.deepEqual([first.shell, first.cwd, first.cols, first.rows, first.env.MYVAR], ['/bin/zsh', cwd, 100, 40, 'set-at-create']);
  assert.ok(first.args.includes('NO_BEEP') && !first.args.includes('-l'));
  const expected = { shell: '/bin/zsh', shellArgs: ['-o', 'NO_BEEP'], login: false, visibility: 'shared', control: 'open', env: { MYVAR: 'set-at-create' }, cwd, cols: 100, rows: 40, retention: { maxAgeMs: 3_600_000 } };
  assert.deepEqual(live(r1.reg.get('bsh')).options, expected);
  const meta = path.join(r1.dir, 'sessions', 'bsh', 'session.json');
  assert.equal(fs.statSync(meta).mode & 0o777, 0o600, 'env may hold secrets');
  // The shell exits (`exit`, `set -e`); the owner's next run starts a new life with no options.
  await shellExits(r1, s1, 4);
  const s2 = (await r1.reg.ensure({ id: 'bsh', owner: A })).session;
  const second = spawned(r1);
  assert.notEqual(s2, s1);
  assert.deepEqual([second.shell, second.cwd, second.cols, second.rows, second.env.MYVAR, second.args], [first.shell, first.cwd, first.cols, first.rows, first.env.MYVAR, first.args]);
  assert.deepEqual([s2.visibility, s2.info().control], ['shared', 'open']);
  // Another principal still sees it: it stayed shared.
  const t = (await r1.reg.ensure({ id: 'bsh', owner: B })).session;
  assert.equal(t, s2);
  // After a restart the history reports the options, and its next life starts the same way.
  const r2 = restart(r1);
  assert.deepEqual(hist(r2.reg.get('bsh')).options, expected);
  const s3 = (await r2.reg.ensure({ id: 'bsh', owner: A })).session;
  const third = spawned(r2);
  assert.deepEqual([third.shell, third.cwd, third.env.MYVAR, third.args, s3.visibility], [first.shell, first.cwd, 'set-at-create', first.args, 'shared']);
  // Explicit options override and are recorded for the lives after.
  await shellExits(r2, s3);
  const s4 = (await r2.reg.ensure({ id: 'bsh', owner: A, visibility: 'private', env: { OTHER: '1' } })).session;
  assert.deepEqual([s4.visibility, spawned(r2).env.MYVAR, spawned(r2).env.OTHER, spawned(r2).shell], ['private', undefined, '1', '/bin/zsh']);
  await shellExits(r2, s4);
  const s5 = (await r2.reg.ensure({ id: 'bsh', owner: A })).session;
  assert.deepEqual([s5.visibility, spawned(r2).env.OTHER], ['private', '1']);
  await r2.reg.closeAll();
  await r1.reg.closeAll();
});

test('ux-4/G18: options recorded by another principal are never reused for a new owner of an unclaimed name', async () => {
  const r = rig();
  const sdir = path.join(r.dir, 'sessions', 'x');
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: B, visibility: 'shared', options: { shell: '/bin/zsh', env: { B_SECRET: 'b' }, visibility: 'shared', control: 'open' } }), { mode: 0o600 });
  const s = (await r.reg.ensure({ id: 'x', owner: A })).session;
  const opts = r.backend.ptys[r.backend.ptys.length - 1]!.opts;
  assert.deepEqual([opts.shell, opts.env.B_SECRET, s.visibility], ['/bin/bash', undefined, 'private']);
  await r.reg.closeAll();
});

// ───────────── m2-4 / mcpl-2: cursors ─────────────

test('m2-4/mcpl-2/G22: delivery cursors persist per principal — across a new life, a restart, and on a history session', async () => {
  const r1 = rig();
  const s1 = (await r1.reg.ensure({ id: 'c', owner: A })).session;
  await run(s1, 'echo one');
  s1.markDelivered(A, 5);
  s1.markRead(A, 3);
  s1.markDelivered(B, 2);
  const file = path.join(r1.dir, 'sessions', 'c', 'cursors.json');
  await until(() => fs.existsSync(file), 1500); // debounced, at most a second
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[A], { delivered: 5, read: 3 });
  // A new life of the name continues them.
  await shellExits(r1, s1);
  const s2 = (await r1.reg.ensure({ id: 'c', owner: A })).session;
  assert.deepEqual(s2.cursorsOf(A), { delivered: 5, read: 3 });
  s2.markRead(A, 4);
  // The daemon stops (closeAll flushes) and restarts: the history session knows them.
  await r1.reg.closeAll({ reason: 'daemon-shutdown' });
  const r2 = restart(r1);
  const h = hist(r2.reg.get('c'));
  assert.deepEqual(h.cursorsOf(A), { delivered: 5, read: 4 });
  assert.deepEqual(h.cursorsOf(B), { delivered: 2, read: 0 });
  assert.deepEqual(h.cursorsOf('agent:nobody@test'), { delivered: 0, read: 0 });
  h.markRead(A, 9);
  h.markDelivered(A, 8);
  h.markDelivered(A, 1); // never backwards
  assert.deepEqual(h.cursorsOf(A), { delivered: 8, read: 9 });
  r2.reg.dispose();
  const r3 = restart(r2);
  const s3 = (await r3.reg.ensure({ id: 'c', owner: A })).session;
  assert.deepEqual(s3.cursorsOf(A), { delivered: 8, read: 9 }, 'a new life after the restart starts from them');
  await r3.reg.closeAll();
  await r2.reg.closeAll();
});

// ───────────── mcpl-4: epoch ─────────────

test('mcpl-4: a name\'s journal epoch is kept by every life and across a restart, and is new after forget', async () => {
  const r1 = rig();
  const s1 = (await r1.reg.ensure({ id: 'e', owner: A })).session;
  const epoch = s1.journal.epoch;
  assert.match(epoch, /^[0-9a-f]{16}$/);
  await shellExits(r1, s1);
  const s2 = (await r1.reg.ensure({ id: 'e', owner: A })).session;
  assert.equal(s2.journal.epoch, epoch);
  await r1.reg.close('e');
  const r2 = restart(r1);
  assert.equal(hist(r2.reg.get('e')).journal.epoch, epoch);
  await r2.reg.remove('e');
  const s3 = (await r2.reg.ensure({ id: 'e', owner: A })).session;
  assert.notEqual(s3.journal.epoch, epoch, 'seq starts over, so the epoch changes');
  assert.equal(s3.journal.oldestSeq, 1);
  await r2.reg.closeAll();
  await r1.reg.closeAll();
});

// ───────────── jr2-6: a failing disk across lives and restarts ─────────────

function failingDisk(): { set(v: boolean): void; restore(): void } {
  let failing = false;
  const orig = FileStore.prototype.append;
  FileStore.prototype.append = function (this: FileStore, ev: JournalEvent) {
    if (failing) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return orig.call(this, ev);
  };
  return { set: (v) => (failing = v), restore: () => (FileStore.prototype.append = orig) };
}

test('jr2-6/G19: a new life after the disk healed writes what only the old ring held — nothing is lost, no gap', async () => {
  const disk = failingDisk();
  try {
    const r = rig();
    const s1 = (await r.reg.ensure({ id: 'x', owner: A })).session;
    await run(s1, 'echo before-the-disk-filled');
    disk.set(true);
    await run(s1, 'echo written-while-disk-full');
    assert.match(s1.journal.stats().coldFailed ?? '', /ENOSPC/);
    const issued = s1.journal.lastSeq;
    await shellExits(r, s1);
    disk.set(false); // freed, within the backoff
    const s2 = (await r.reg.ensure({ id: 'x', owner: A })).session;
    await run(s2, 'echo after');
    const events = onDisk(path.join(r.dir, 'sessions', 'x'));
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), 'every seq once, in order');
    assert.ok(seqs.includes(issued));
    assert.ok(events.some((e) => e.type === 'output' && e.data.includes('written-while-disk-full')));
    assert.equal(events.filter((e) => e.type === 'gap').length, 0);
    await r.reg.closeAll();
  } finally {
    disk.restore();
  }
});

test('jr2-6/G10/G11: a new life while the disk still refuses, and a shutdown while it refuses, never reissue a seq and record the hole', async () => {
  const disk = failingDisk();
  try {
    const r1 = rig();
    const s1 = (await r1.reg.ensure({ id: 'x', owner: A })).session;
    await run(s1, 'echo before');
    const persisted = s1.journal.lastSeq;
    disk.set(true);
    const seen: number[] = [];
    s1.journal.subscribe((e) => seen.push(e.seq));
    await run(s1, 'echo SEEN-BY-SUBSCRIBERS');
    await shellExits(r1, s1);
    const s2 = (await r1.reg.ensure({ id: 'x', owner: A })).session; // still refusing
    await run(s2, 'echo second-life');
    const seenUpTo = Math.max(...seen);
    assert.ok(s2.journal.lastSeq > seenUpTo);
    // The operator restarts termd while the disk is still full, then frees space.
    await r1.reg.closeAll({ reason: 'daemon-shutdown' });
    disk.set(false);
    const r2 = restart(r1);
    const h = hist(r2.reg.get('x'));
    assert.ok(h.lastSeq > s2.journal.lastSeq - 0, `numbering resumes above everything issued (${h.lastSeq})`);
    const events = onDisk(path.join(r2.dir, 'sessions', 'x'));
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'no seq twice');
    assert.ok(!seqs.some((q) => q > persisted && q <= seenUpTo && events.find((e) => e.seq === q)!.type !== 'gap'), 'no seq a subscriber saw was reissued');
    const gap = events.find((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
    assert.ok(gap && gap.reason === 'store-failed' && gap.from === persisted + 1 && gap.to >= s2.journal.lastSeq, JSON.stringify(gap));
    await r2.reg.closeAll();
  } finally {
    disk.restore();
  }
});

// ───────────── jr2-7: age retention on a live session ─────────────

test('jr2-7/G21/G26: a live session\'s aged output is gone after expire(), with a visible gap, and the session carries on', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'short', owner: A, retention: { maxAgeMs: 1000 } })).session;
  await run(s, 'echo SECRET-TOKEN-xyz');
  const before = s.journal.lastSeq;
  await new Promise((res) => setTimeout(res, 1200));
  assert.deepEqual(await r.reg.expire(), [], 'a live session is not removed');
  const read = s.journal.since(0);
  assert.ok(!read.events.some((e) => e.type === 'output' && e.data.includes('SECRET')), 'aged output is not readable');
  assert.ok(read.gap && read.gap.from === 1, 'the aged range reads as a gap');
  const res = await run(s, 'echo later');
  assert.equal(res.state, 'exited');
  assert.ok(s.journal.oldestSeq! > before, `oldestSeq ${s.journal.oldestSeq}`);
  assert.ok(!fs.readdirSync(path.join(r.dir, 'sessions', 'short')).some((n) => n.startsWith('journal') && n.endsWith('.jsonl') && fs.readFileSync(path.join(r.dir, 'sessions', 'short', n), 'utf8').includes('SECRET')), 'nor on disk');
  await r.reg.closeAll();
});
