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
import { orphanGroups, SessionRegistry, type AnySession, type HistorySession, type LiveSession, type OrphanCandidate } from '../src/api/registry.js';
import type { ScriptedBackend } from '../src/backends/scripted.js';
import { Journal } from '../src/core/journal.js';
import { groupAlive, type ProcessRow } from '../src/core/lock.js';
import type { Session } from '../src/core/session.js';
import { FileStore } from '../src/core/stores.js';
import type { JournalEvent, RunInfo } from '../src/core/types.js';
import { fakeShellBackend } from './fake-shell.js';
import { until } from './testhost.js';

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
  const backend = fakeShellBackend(
    (sh) => {
      sh.on(/^echo (.*)$/, (l) => ({ output: `${l.slice(5)}\r\n`, exit: 0 }));
      sh.on(/^sleep/, () => ({ hang: true }));
    },
    { marks: 'rich', exitDeferred: true },
  );
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

/** Real processes in their own groups, for the recovery tests; `end()` kills whatever is left of them. */
function detachedKids() {
  const kids: ChildProcess[] = [];
  const spawnOne = (cmd: string, args: string[]) => {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    kids.push(c);
    return c.pid!;
  };
  const end = () => {
    for (const c of kids) {
      try {
        process.kill(-c.pid!, 'SIGKILL');
      } catch {
        // gone
      }
    }
  };
  const exited = (pid: number) => until(() => kids.some((c) => c.pid === pid && (c.exitCode !== null || c.signalCode !== null)));
  return { kids, spawn: spawnOne, end, exited };
}

/** A process Run's admission and start, journaled as a session would. */
const journalProcess = (j: Journal, runId: string, pid: number) => {
  j.append({ type: 'run.admit', runId, target: 'process', line: runId, principal: A, origin: 'self', queued: false });
  j.append({ type: 'run.start', runId, cwd: '/', envBasis: 'configured', pid, pgid: pid });
};

test('jr2-4/G19c/G20/G29: recovery terminates the process groups a dead daemon left running — of Runs in flight and of Runs that had ended leaving children — SIGTERM, then SIGKILL, and says so', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'k1');
  const kids = detachedKids();
  try {
    const ready = path.join(dir, 'stubborn-ready');
    fs.mkdirSync(dir, { recursive: true });
    // A Run that exited before the daemon died, leaving a child in its group (`leftovers`): the group
    // has no leader now, and recovery ends it as the live daemon's shutdown drain would have (the
    // house's read of 2c35df8, #22). Another such group whose Run ended before the child started is
    // a stranger's orphans with a reused group id, and is left alone.
    const leftover = kids.spawn('/bin/sh', ['-c', 'sleep 404 & exit 0']);
    const strangers = kids.spawn('/bin/sh', ['-c', 'sleep 405 & exit 0']);
    const polite = kids.spawn('sleep', ['401']); // ends on SIGTERM
    const stubborn = kids.spawn('/bin/sh', ['-c', "trap '' TERM; printf ready > \"$1\"; sleep 402; :", 'recovery-test', ready]); // ignores SIGTERM, its sleep too
    const stranger = kids.spawn('sleep', ['403']); // a live group whose leader predates the Run: a reused pid
    const clean = kids.spawn('sleep', ['406']); // a live group of a Run that exited with its group empty, as its session saw: a reused pid
    const gone = kids.spawn('true', []);
    // The synthetic Runs start with these processes, not after an arbitrary delay.
    // Observe the installed trap before recovery tries to exercise SIGKILL escalation.
    let ts = Date.now();
    await until(() => fs.existsSync(ready) && !groupAlive(gone));
    await kids.exited(leftover);
    await kids.exited(strangers);
    assert.ok(groupAlive(leftover) && groupAlive(strangers), 'the children keep their leaderless groups alive');
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'k1', now: () => ts });
    const ended = (runId: string, pid: number, leftovers: boolean) => {
      journalProcess(j, runId, pid);
      j.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 5, ...(leftovers && { leftovers: true }) });
    };
    ts -= 30_000; // this Run ended half a minute before the child now in its group started
    ended('r6-strangers', strangers, true);
    ts += 30_000;
    journalProcess(j, 'r1-polite', polite);
    journalProcess(j, 'r2-stubborn', stubborn);
    journalProcess(j, 'r3-gone', gone);
    ended('r5-leftover', leftover, true);
    ended('r7-clean', clean, false);
    ts += 30_000; // this Run started half a minute after its "leader" did
    journalProcess(j, 'r4-stranger', stranger);
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
    await kids.exited(polite);
    await kids.exited(stubborn);
    assert.equal(kids.kids.find((c) => c.pid === polite)!.signalCode, 'SIGTERM');
    assert.equal(kids.kids.find((c) => c.pid === stubborn)!.signalCode, 'SIGKILL');
    assert.ok(!groupAlive(polite) && !groupAlive(stubborn), 'nothing of either group survives');
    assert.ok(groupAlive(stranger), 'the stranger still runs');
    assert.ok(!groupAlive(leftover), 'the child an exited Run left in its group is ended');
    assert.deepEqual([h.run('r5-leftover').state, h.run('r5-leftover').exit], ['exited', 0], 'the Run\'s own end stands');
    const notes = h.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'note' }> => e.type === 'note').map((e) => e.text);
    assert.ok(notes.some((t) => t.includes(`process group ${leftover} terminated`) && t.includes('r5-leftover')), `the journal says so: ${JSON.stringify(notes)}`);
    // A Run recovery ended `lost` just now did not have its group outlive it: the note says the group
    // went with the Run (the house's read of cc8c909..39787b3, #22).
    assert.ok(notes.includes(`recovery: process group ${polite} terminated with r1-polite, which recovery ended lost`), JSON.stringify(notes));
    assert.ok(!notes.some((t) => /outlived r1-(polite|stubborn)/.test(t)), `no note says a group recovery ended outlived its Run: ${JSON.stringify(notes)}`);
    assert.ok(groupAlive(strangers), 'a leaderless group whose members started after the Run ended is a stranger\'s');
    assert.ok(groupAlive(clean), 'a Run that exited with its group empty vouches for nothing now in it');
    // A candidate group recovery left running because it could not be told from a stranger's reuse of
    // the id is recorded, not left silently (the house's read of the 36 commits, #22).
    assert.ok(
      notes.some((t) => t.includes(`process group ${strangers} left running`) && t.includes('cannot be told apart') && t.includes('r6-strangers')),
      `the left leftover group is recorded: ${JSON.stringify(notes)}`,
    );
    assert.ok(
      notes.some((t) => t.includes(`process group ${stranger} left running`) && t.includes('r4-stranger')),
      `the left in-flight group is recorded: ${JSON.stringify(notes)}`,
    );
    // `clean` is not even a candidate (it exited with its group empty): nothing is said of it.
    assert.ok(!notes.some((t) => t.includes(`${clean}`)), `clean is not a candidate: ${JSON.stringify(notes)}`);
    await r.reg.closeAll();
    // A scripted backend's pids are not real processes: by default nothing is signalled, even a
    // living group a journal names.
    const sdir2 = path.join(tmp, `d${++dirs}`, 'sessions', 'k2');
    const bystander = kids.spawn('sleep', ['407']);
    const j2 = new Journal({ cold: new FileStore(sdir2), sessionId: 'k2' });
    journalProcess(j2, 'r1-bystander', bystander);
    j2.close();
    fs.writeFileSync(path.join(sdir2, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const plain = rig(path.join(tmp, `d${dirs}`));
    assert.equal(hist(plain.reg.get('k2')).run('r1-bystander').reason, 'daemon-restart');
    assert.ok(groupAlive(bystander), 'nothing was signalled under the scripted backend');
    await plain.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4/G21: a session past its age is removed only after its Runs\' process groups are ended with every other session\'s', { timeout: 10_000 }, async () => {
  // Recovery removed an aged session's directory first, and its running Run's group lived on (the house's read of 2c35df8, #22).
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'aged');
  const kids = detachedKids();
  try {
    const sleeper = kids.spawn('sleep', ['408']);
    const ts = Date.now();
    const j = new Journal({ cold: new FileStore(sdir, { maxAgeMs: 1000 }), sessionId: 'aged', now: () => ts });
    journalProcess(j, 'r1-sleeper', sleeper);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 1000 } }), { mode: 0o600 });
    await new Promise((res) => setTimeout(res, 1200));
    const r = rig(dir, { terminateOrphans: true });
    assert.equal(r.reg.get('aged'), undefined, 'past its age, the session is not surfaced');
    assert.equal(fs.existsSync(sdir), false, 'and its files are gone');
    await kids.exited(sleeper); // reaped once the loop runs: until then the zombie holds its pid
    assert.equal(kids.kids.find((c) => c.pid === sleeper)!.signalCode, 'SIGTERM');
    assert.ok(!groupAlive(sleeper), 'its Run\'s group was ended first');
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: which groups recovery signals — never its own, never 1, a leader that started with a Run in flight, leaderless members within the Run\'s life', () => {
  // The rules, on a listing of the machine's processes, without a signal: each guard here failed
  // no test when removed from the built registry (the house's read of 2c35df8, #22).
  const self = { pid: 500, pgid: 400 };
  const run = (runId: string, pgid: number, startedAt: number, end?: { endedAt: number; state: RunInfo['state']; leftovers?: true }): OrphanCandidate => ({
    key: `s\0${runId}`,
    run: { runId, sessionId: 's', target: 'process', origin: 'self', principal: A, state: end?.state ?? 'running', admittedAt: startedAt - 10, startedAt, seq: { admit: 1, start: 2 }, attribution: 'exact', pgid, ...(end && { endedAt: end.endedAt }), ...(end?.leftovers && { leftovers: true }) },
    lastTs: 100_000,
  });
  const row = (pid: number, pgid: number, startMs: number, zombie = false): ProcessRow => ({ pid, pgid, startMs, zombie });
  const T = 50_000; // the Runs' start; `ps` start times are whole seconds
  const select = (c: OrphanCandidate[], procs: ProcessRow[]) => [...orphanGroups(c, procs, self).keys()].sort((a, b) => a - b);
  // A leader that started with the Run (truncation allowed: 2 s before, 1 s after), not one that predates it or came later.
  const leaders = [row(1001, 1001, T - 2000), row(1002, 1002, T + 1000), row(1003, 1003, T - 3000), row(1004, 1004, T + 2000)];
  assert.deepEqual(select([run('a', 1001, T), run('b', 1002, T), run('c', 1003, T), run('d', 1004, T)], leaders), [1001, 1002]);
  // Never the daemon's own pid or group, whatever the times say; never group 1 (kill(-1) is every process) or 0.
  const own = [row(self.pid, self.pid, T), row(self.pgid, self.pgid, T), row(self.pid + 1, self.pgid, T), row(1, 1, T), row(2, 1, T)];
  assert.deepEqual(select([run('e', self.pid, T), run('f', self.pgid, T), run('g', 1, T), run('h', 0, T)], own), []);
  // A Run that ended: a leader now holds the freed pid (its process was reaped before its end was written), a stranger.
  assert.deepEqual(select([run('i', 1001, T, { endedAt: T + 500, state: 'exited', leftovers: true })], leaders), []);
  // Leaderless members: the Run's descendants when none predates the Run and one started before it ended.
  const ended = { endedAt: T + 5000, state: 'exited' as const, leftovers: true as const };
  assert.deepEqual(select([run('j', 2001, T, ended)], [row(2101, 2001, T), row(2102, 2001, T + 5000)]), [2001], 'a child forked as the Run exited is within its life');
  // A member that started after the Run ended descends from one that was there — a loop's newest
  // child; asking every member to predate the end left such a loop running (the house's read of
  // cc8c909..39787b3, #22). When every member started after the Run ended, the group cannot be told
  // apart from a stranger's reuse of the id, so it is left (the house's read of the 36 commits, #22).
  assert.deepEqual(select([run('k', 2001, T, ended)], [row(2101, 2001, T), row(2102, 2001, T + 6000)]), [2001], 'a member started within the Run: the later one is its descendant');
  assert.deepEqual(select([run('k2', 2001, T, ended)], [row(2101, 2001, T + 6000), row(2102, 2001, T + 7000)]), [], 'every member started after the Run ended: cannot be told from a reused id');
  assert.deepEqual(select([run('l', 2001, T, ended)], [row(2101, 2001, T - 3000), row(2102, 2001, T)]), [], 'one member predates the Run');
  assert.deepEqual(select([run('m', 2001, T, { endedAt: T + 5000, state: 'cancelled' })], [row(2101, 2001, T + 1000)]), [2001], 'a cancelled Run\'s group too');
  assert.deepEqual(select([run('n', 2001, T, { endedAt: T + 5000, state: 'lost' })], [row(2101, 2001, T + 1000)]), [2001], 'and a lost one\'s');
  // Leaderless members of a Run still in flight: one must predate the dead daemon's last event by a second.
  assert.deepEqual(select([run('o', 3001, T)], [row(3101, 3001, T + 1000), row(3102, 3001, 99_000)]), [3001]);
  assert.deepEqual(select([run('p', 3001, T)], [row(3101, 3001, 99_500), row(3102, 3001, 100_000)]), [], 'a group formed around the daemon\'s death is not the Run\'s');
  // Zombies hold no group: a group of zombies alone is gone.
  assert.deepEqual(select([run('q', 4001, T)], [row(4001, 4001, T, true), row(4101, 4001, T, true)]), []);
  // One group, two Runs: both named.
  assert.deepEqual([...orphanGroups([run('r', 1001, T), run('s', 1001, T)], leaders, self).get(1001)!], ['s\0r', 's\0s']);
});

test('jr2-4/G21: a journal holding only a rotation header still ends its open Runs\' process groups — age retention had left just the header, read as empty (the house\'s read of the 36 commits, #22)', { timeout: 10_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'hdr');
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  const kids = detachedKids();
  try {
    const child = kids.spawn('sleep', ['409']);
    await until(() => groupAlive(child));
    const started = Date.now();
    // Every event has aged out; the active file holds only the rotation header the last rotation wrote,
    // naming a process Run still open with pgid `child`. The high water (a drop kept the numbering) makes
    // the session past its age, so the old code removed it — with the Run's process group running.
    const openRun = { runId: 'r1-headeronly', sessionId: 'hdr', target: 'process', origin: 'self', principal: A, state: 'running', admittedAt: started - 10, startedAt: started, seq: { admit: 1, start: 2 }, attribution: 'exact', pgid: child };
    fs.writeFileSync(path.join(sdir, 'journal.jsonl'), JSON.stringify({ header: { v: 1, openRuns: [openRun] } }) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(sdir, 'journal.meta.json'), JSON.stringify({ v: 1, epoch: 'a'.repeat(16), highWater: 5 }) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 1000 } }), { mode: 0o600 });
    const r = rig(dir, { terminateOrphans: true });
    assert.equal(r.reg.get('hdr'), undefined, 'past its age, the header-only session is removed');
    assert.equal(fs.existsSync(sdir), false, 'and its files are gone');
    await kids.exited(child);
    assert.ok(!groupAlive(child), 'but its open Run\'s process group was ended first');
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: on Linux recovery compares process starts frame-free — a boot id and clock ticks a wall-clock step cannot move (the house\'s read of the 36 commits, #22)', () => {
  const self = { pid: 500, pgid: 400 };
  const T = 50_000;
  const run = (over: Partial<RunInfo>): OrphanCandidate => ({
    key: 's\0r',
    run: { runId: 'r', sessionId: 's', target: 'process', origin: 'self', principal: A, state: 'running', admittedAt: T - 10, startedAt: T, seq: { admit: 1, start: 2 }, attribution: 'exact', pgid: 1001, ...over },
    lastTs: 100_000,
  });
  const row = (over: Partial<ProcessRow>): ProcessRow => ({ pid: 1001, pgid: 1001, startMs: T, zombie: false, ...over });
  const sel = (c: OrphanCandidate, procs: ProcessRow[]) => [...orphanGroups([c], procs, self).keys()];
  // Same boot, matching ticks: the Run's, even though the listing's wall-clock start was stepped far off.
  assert.deepEqual(sel(run({ bootId: 'boot-A', startTicks: 7777 }), [row({ bootId: 'boot-A', startTicks: 7777, startMs: T + 600_000 })]), [1001], 'ticks match across a wall-clock step');
  // A different boot id: nothing of a pre-restart Run survives, whatever the wall clock says.
  assert.deepEqual(sel(run({ bootId: 'boot-A', startTicks: 7777 }), [row({ bootId: 'boot-B', startTicks: 7777, startMs: T })]), [], 'a reboot leaves nothing of the Run');
  // Same boot, a leader whose ticks differ: the pid was reused, even with a wall-clock start that would pass.
  assert.deepEqual(sel(run({ bootId: 'boot-A', startTicks: 7777 }), [row({ bootId: 'boot-A', startTicks: 9999, startMs: T })]), [], 'ticks say the pid was reused');
  // No ticks recorded (macOS, or an older build): the wall-clock comparison with its tolerance stands.
  assert.deepEqual(sel(run({}), [row({ startMs: T })]), [1001], 'wall-clock fallback when ticks are absent');
});

test('jr2-4: a recovery that could not judge a Run\'s group keeps the dead daemon\'s last evidence on the lost end, and the next recovery bounds the group by it, not by the first recovery\'s time (the house\'s read of the 36 commits, #22, item 2)', async () => {
  // First recovery, unable to judge (the scripted backend disables endOrphans, which leaves the same
  // journal a missing process listing does: a lost end with no groupJudged). The dead daemon's last
  // event is the Run's start, at T_death.
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'nl');
  const T_death = 1_000_000;
  const j = new Journal({ cold: new FileStore(sdir), sessionId: 'nl', now: () => T_death });
  journalProcess(j, 'r1-unjudged', 4242);
  j.close();
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
  const r = rig(dir);
  const run = hist(r.reg.get('nl')).run('r1-unjudged');
  assert.equal(run.state, 'lost');
  assert.equal(run.recoveredEnd, true, 'the end is recovery\'s');
  assert.equal(run.groupJudged, undefined, 'nothing judged the group');
  assert.equal(run.lastAliveTs, T_death, 'the dead daemon\'s last evidence rides on the end');
  assert.ok(run.endedAt !== undefined && run.endedAt > T_death, 'the end itself carries the recovery\'s (later) time');
  await r.reg.closeAll();

  // Second recovery, through the rule: a leaderless group in the old pgid whose members started after
  // the daemon died but before the first recovery cannot be the Run's — the cap at lastAliveTs leaves it.
  const self = { pid: 500, pgid: 400 };
  const T_rec1 = T_death + 60_000;
  const cand = (over: Partial<RunInfo>): OrphanCandidate => ({
    key: 'nl\0r1-unjudged',
    run: { ...run, pgid: 4242, endedAt: T_rec1, recoveredEnd: true, ...over },
    lastTs: T_rec1 + 5000, // the first-recovery daemon's own last event: not the bound
  });
  const row = (pid: number, startMs: number): ProcessRow => ({ pid, pgid: 4242, startMs, zombie: false });
  const sel = (c: OrphanCandidate, procs: ProcessRow[]) => [...orphanGroups([c], procs, self).keys()];
  assert.deepEqual(sel(cand({ lastAliveTs: T_death }), [row(4301, T_death + 20_000), row(4302, T_death + 40_000)]), [], 'members started between the death and the first recovery: left alone');
  assert.deepEqual(sel(cand({ lastAliveTs: T_death }), [row(4301, T_death - 1000), row(4302, T_death + 40_000)]), [4242], 'a member that was there before the daemon died: the Run\'s, the later one its descendant');
  // An end written by an older recovery, before lastAliveTs was recorded: the end time stands as before.
  const { lastAliveTs: _recorded, ...older } = run;
  assert.deepEqual(sel({ ...cand({}), run: { ...older, pgid: 4242, endedAt: T_rec1, recoveredEnd: true } }, [row(4301, T_death + 20_000)]), [4242], 'without the recorded evidence the bound falls back to the end');
});

test('jr2-4: a torn last line does not move the dead daemon\'s last evidence to the recovery\'s clock — lastAliveTs is the last whole event (a reviewer\'s read of the fixes for #22 comment 6269992150)', async () => {
  // Opening the journal over a torn tail appends a torn-write gap stamped now; read after that, `last`
  // was the gap, so the lost end's lastAliveTs (and the orphan bound) became the recovery's own time.
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'torn');
  const T_death = 1_000_000;
  const j = new Journal({ cold: new FileStore(sdir), sessionId: 'torn', now: () => T_death });
  journalProcess(j, 'r1-torn', 4242);
  j.append({ type: 'output', data: 'tick\n', stream: 'stdout', runId: 'r1-torn' });
  j.close();
  const file = path.join(sdir, 'journal.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, -5)); // the crash tore the last line
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
  const r = rig(dir);
  const h = hist(r.reg.get('torn'));
  const run = h.run('r1-torn');
  assert.equal(run.state, 'lost');
  assert.equal(run.lastAliveTs, T_death, `the last whole event's time, not the recovery's: ${run.lastAliveTs}`);
  assert.ok(h.journal.since(0).events.some((e) => e.type === 'gap' && e.reason === 'torn-write'), 'the torn tail is still recorded as a gap');
  await r.reg.closeAll();
});

test('jr2-4: a group recovery left for an ended Run with leftovers is judged once — a second restart adds no note (a reviewer\'s read of the fixes for #22 comment 6269992150)', { timeout: 15_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'once');
  const kids = detachedKids();
  try {
    // A leaderless group whose member started long after the Run ended: a stranger's by the rule, left.
    const strangers = kids.spawn('/bin/sh', ['-c', 'sleep 410 & exit 0']);
    await kids.exited(strangers);
    assert.ok(groupAlive(strangers));
    const ts = Date.now() - 30_000;
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'once', now: () => ts });
    journalProcess(j, 'r1-left', strangers);
    j.append({ type: 'run.end', runId: 'r1-left', state: 'exited', exit: 0, durationMs: 5, leftovers: true });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const leftNotes = (h: HistorySession) => h.journal.since(0).events.filter((e) => e.type === 'note' && e.text.includes('left running') && e.text.includes('r1-left')).length;
    const r1 = rig(dir, { terminateOrphans: true });
    const h1 = hist(r1.reg.get('once'));
    assert.equal(leftNotes(h1), 1, 'the first recovery records that it left the group');
    assert.equal(h1.run('r1-left').groupJudged, true, 'and that the group was judged');
    assert.ok(groupAlive(strangers), 'the group was left alone');
    await r1.reg.closeAll();
    const r2 = rig(dir, { terminateOrphans: true });
    const h2 = hist(r2.reg.get('once'));
    assert.equal(leftNotes(h2), 1, 'the second recovery does not judge it again');
    assert.equal(h2.run('r1-left').groupJudged, true, 'the judgement survives the restart');
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: a leader whose ticks equal a Run\'s recorded ticks is the Run\'s own process, still alive, even though recovery wrote the Run an end (a reviewer\'s read of the fixes for #22 comment 6269992150)', () => {
  const self = { pid: 500, pgid: 400 };
  const T = 50_000;
  const run = (over: Partial<RunInfo>): OrphanCandidate => ({
    key: 's\0r',
    run: { runId: 'r', sessionId: 's', target: 'process', origin: 'self', principal: A, state: 'lost', admittedAt: T - 10, startedAt: T, endedAt: T + 60_000, seq: { admit: 1, start: 2, end: 3 }, attribution: 'exact', pgid: 1001, recoveredEnd: true, ...over },
    lastTs: T + 5000,
  });
  const leader = (over: Partial<ProcessRow>): ProcessRow => ({ pid: 1001, pgid: 1001, startMs: T, zombie: false, ...over });
  const sel = (c: OrphanCandidate, procs: ProcessRow[]) => [...orphanGroups([c], procs, self).keys()];
  // A recovery that could not list processes ended the Run lost; the next one finds the leader itself alive, by ticks.
  assert.deepEqual(sel(run({ bootId: 'boot-A', startTicks: 7777 }), [leader({ bootId: 'boot-A', startTicks: 7777 })]), [1001], 'the Run\'s own process: ended, not left at every restart');
  assert.deepEqual(sel(run({ bootId: 'boot-A', startTicks: 7777 }), [leader({ bootId: 'boot-A', startTicks: 9999 })]), [], 'different ticks: a reused pid');
  // Without ticks the wall clock cannot tell the Run's process from a reuse: the recorded end stands.
  assert.deepEqual(sel(run({}), [leader({})]), [], 'no ticks: a leader after a recorded end is a stranger');
  // An observed end means the leader was reaped: a present leader is a reuse whatever its ticks say of a lost pid.
  const { recoveredEnd: _r, ...observed } = run({ bootId: 'boot-A', startTicks: 7777 }).run;
  assert.deepEqual(sel({ key: 's\0r', run: { ...observed, state: 'exited', leftovers: true }, lastTs: T + 5000 }, [leader({ bootId: 'boot-A', startTicks: 7777 })]), [], 'an observed end: the leader is gone, so this one is not the Run\'s');
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
