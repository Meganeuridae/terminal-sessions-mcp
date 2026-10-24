/**
 * What a name keeps across lives and restarts, and what recovery cleans up:
 * orphaned process groups of a dead daemon (jr2-4, G19c), command files in
 * the private shell directory (jr2-12, G26), creation options (ux-4), per-principal
 * delivery cursors (m2-4, mcpl-2; G22), the journal's epoch (mcpl-4), events a
 * failing disk refused (jr2-6; G10, G11), and age retention on live sessions
 * (jr2-7; G21). Each test is named for the finding it encodes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from '../src/api/app.js';
import { heldGroups, orphanGroups, SessionRegistry, type AnySession, type HistorySession, type LiveSession, type OrphanCandidate } from '../src/api/registry.js';
import type { ScriptedBackend } from '../src/backends/scripted.js';
import { Journal } from '../src/core/journal.js';
import { boots, groupAlive, listProcesses, procStart, PROC_START_SLACK_MS, type ProcessRow } from '../src/core/lock.js';
import type { Session } from '../src/core/session.js';
import { FileStore } from '../src/core/stores.js';
import type { JournalEvent, RunInfo } from '../src/core/types.js';
import { fakeShellBackend } from './fake-shell.js';
import { until } from './testhost.js';

const A = 'agent:a@test';
const B = 'agent:b@test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-recovery-'));
let dirs = 0;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

test('jr2-4: a recovery that could not judge a Run\'s group keeps the dead daemon\'s last evidence on the lost end, and the next recovery bounds the group by it, not by the first recovery\'s time (the house\'s read of the 36 commits, PR #22, comment 6269992150, item 2)', async () => {
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
  // An end a recovery wrote without the evidence: its time is the recovery's, so nothing bounds the group,
  // and it is left — the end time stood as the bound before (the house's read of the 38 commits, PR #22,
  // comment 6274857431, item 2).
  const { lastAliveTs: _recorded, ...older } = run;
  assert.deepEqual(sel({ ...cand({}), run: { ...older, pgid: 4242, endedAt: T_rec1, recoveredEnd: true } }, [row(4301, T_death + 20_000)]), [], 'without the recorded evidence nothing bounds the group');
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
  // Without ticks to compare (macOS, a Run recorded without them, or a listing from ps) the leader is judged
  // as an in-flight Run's is, by the wall clock: ticks alone left the Run's own live leader at every later
  // recovery (the house's review of 4f4c067..a8b6f28, PR #22, comment 6323055715, question 6).
  assert.deepEqual(sel(run({}), [leader({})]), [1001], 'no ticks: a leader that started with the Run is its own process');
  assert.deepEqual(sel(run({ bootId: 'boot-A', startTicks: 7777 }), [leader({})]), [1001], 'ticks on the Run, none on the row: the wall clock');
  assert.deepEqual(sel(run({}), [leader({ startMs: T + 30_000 })]), [], 'no ticks: a leader that started after the Run is a reuse');
  assert.deepEqual(sel(run({}), [leader({ startMs: T - 10_000 })]), [], 'no ticks: nor one that started before it');
  const { recoveredEnd: _flag, ...unflagged } = run({}).run;
  assert.deepEqual(sel({ key: 's\0r', run: { ...unflagged, reason: 'daemon-restart' }, lastTs: T + 5000 }, [leader({})]), [1001], 'an older recovery\'s unflagged end, by its reason');
  // An observed end means the leader was reaped: a present leader is a reuse whatever its ticks say of a lost pid.
  const { recoveredEnd: _r, ...observed } = run({ bootId: 'boot-A', startTicks: 7777 }).run;
  assert.deepEqual(sel({ key: 's\0r', run: { ...observed, state: 'exited', leftovers: true }, lastTs: T + 5000 }, [leader({ bootId: 'boot-A', startTicks: 7777 })]), [], 'an observed end: the leader is gone, so this one is not the Run\'s');
});

test('jr2-4: every end a recovery wrote bounds the group only by the evidence it recorded — flagged or as an older recovery wrote it, never by its own time (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 2)', () => {
  const self = { pid: 500, pgid: 400 };
  const T_death = 1_000_000;
  const T_rec = T_death + 60_000; // when a recovery wrote the end
  const cand = (over: Partial<RunInfo>): OrphanCandidate => ({
    key: 's\0r',
    run: { runId: 'r', sessionId: 's', target: 'process', origin: 'self', principal: A, state: 'lost', reason: 'daemon-restart', admittedAt: T_death - 20_010, startedAt: T_death - 20_000, endedAt: T_rec, seq: { admit: 1, start: 2, end: 3 }, attribution: 'exact', pgid: 4242, ...over },
    lastTs: T_rec + 5000,
  });
  const row = (pid: number, startMs: number, over: Partial<ProcessRow> = {}): ProcessRow => ({ pid, pgid: 4242, startMs, zombie: false, ...over });
  const sel = (c: OrphanCandidate, procs: ProcessRow[]) => [...orphanGroups([c], procs, self).keys()];
  const reused = [row(4301, T_death + 20_000)]; // a stranger's group formed between the death and the recovery
  const theRuns = [row(4301, T_death - 10_000)]; // a member that was there before the daemon died
  // Flagged, without the evidence (the recovery read no last event): the group is left, whoever is in it.
  assert.deepEqual(sel(cand({ recoveredEnd: true }), reused), [], 'flagged, no evidence: a stranger is not taken');
  assert.deepEqual(sel(cand({ recoveredEnd: true }), theRuns), [], 'flagged, no evidence: nothing bounds the group, so it is left');
  // As 78c4d6e's recovery wrote them, unflagged: the reason says whose end it is.
  for (const reason of ['daemon-restart', 'daemon-restart; process group 4242 terminated']) {
    assert.deepEqual(sel(cand({ reason }), reused), [], `unflagged "${reason}": not bounded by the recovery's time`);
    assert.deepEqual(sel(cand({ reason, lastAliveTs: T_death }), theRuns), [4242], `"${reason}" with the evidence: bounded by it`);
  }
  // The recorded evidence bounds it: a member from before the death is the Run's, one formed after is not.
  assert.deepEqual(sel(cand({ recoveredEnd: true, lastAliveTs: T_death }), theRuns), [4242]);
  assert.deepEqual(sel(cand({ recoveredEnd: true, lastAliveTs: T_death }), reused), []);
  // Ticks are evidence too: the Run's own leader, still alive, ties the group without a wall-clock bound.
  const ticks = { bootId: 'boot-A', startTicks: 7777 };
  assert.deepEqual(sel(cand({ reason: 'daemon-restart', ...ticks }), [row(4242, T_death - 20_000, ticks)]), [4242], 'the leader by its ticks');
  // An end the live daemon observed (its own shutdown) still bounds by its time.
  assert.deepEqual(sel(cand({ reason: 'daemon-shutdown', endedAt: T_death }), [row(4301, T_death - 1000)]), [4242], 'an observed lost end');
});

test('jr2-4: starts are compared at the listing\'s resolution — ticks against the Run\'s ticks, /proc\'s placed starts within their slack, ps\'s whole seconds within the second the docs state (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 3)', () => {
  const self = { pid: 500, pgid: 400 };
  const T = 50_000; // the Run's start
  const E = T + 5500; // its observed end
  const L = T + 20_000; // the dead daemon's last event
  const cand = (over: Partial<RunInfo>): OrphanCandidate => ({
    key: 's\0r',
    run: { runId: 'r', sessionId: 's', target: 'process', origin: 'self', principal: A, state: 'running', admittedAt: T - 10, startedAt: T, seq: { admit: 1, start: 2 }, attribution: 'exact', pgid: 2001, ...over },
    lastTs: L,
  });
  const ended: Partial<RunInfo> = { state: 'exited', endedAt: E, leftovers: true };
  const ps = (pid: number, startMs: number): ProcessRow => ({ pid, pgid: 2001, startMs, zombie: false });
  const proc = (pid: number, startMs: number, over: Partial<ProcessRow> = {}): ProcessRow => ({ pid, pgid: 2001, startMs, startSlackMs: PROC_START_SLACK_MS, zombie: false, ...over });
  const sel = (c: OrphanCandidate, procs: ProcessRow[]) => [...orphanGroups([c], procs, self).keys()];
  // After an observed end: a /proc row tells 30 ms after the end from 30 ms before it; ps's whole second
  // cannot, so a group formed within the second of the end is taken there — the window the docs state.
  assert.deepEqual(sel(cand(ended), [proc(2101, E + 30)]), [], '/proc: formed 30 ms after the end');
  assert.deepEqual(sel(cand(ended), [proc(2101, E - 30)]), [2001], '/proc: started 30 ms before it');
  assert.deepEqual(sel(cand(ended), [ps(2101, Math.floor(E / 1000) * 1000)]), [2001], 'ps: the same second as the end is taken');
  // In flight: one member must have started before the daemon's last event, at the row's resolution.
  assert.deepEqual(sel(cand({}), [proc(2101, L - 100)]), [2001], '/proc: 100 ms before the last event is before it');
  assert.deepEqual(sel(cand({}), [proc(2101, L - 10)]), [], '/proc: within its slack of the last event is not proven');
  assert.deepEqual(sel(cand({}), [ps(2101, L - 1000)]), [2001], 'ps: the whole second before it');
  assert.deepEqual(sel(cand({}), [ps(2101, L - 500)]), [], 'ps: a start that may lie after it');
  // With the Run's ticks recorded (Linux): no member started before its leader's tick, whatever the wall clock says.
  const ticks: Partial<RunInfo> = { bootId: 'boot-A', startTicks: 7000 };
  assert.deepEqual(sel(cand(ticks), [proc(2101, T, { bootId: 'boot-A', startTicks: 6990 })]), [], 'a tick before the leader: a stranger, though its wall start passes');
  assert.deepEqual(sel(cand(ticks), [proc(2101, T - 600_000, { bootId: 'boot-A', startTicks: 7005 })]), [2001], 'after the leader by ticks, across a wall-clock step');
});

test('jr2-4: before its SIGKILL recovery signals a group only while it holds a member recovery judged, or one that joined while such a member lived (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 4)', () => {
  const r = (pid: number, pgid: number, startMs: number, over: Partial<ProcessRow> = {}): ProcessRow => ({ pid, pgid, startMs, zombie: false, ...over });
  const linux = (pid: number, ticks: number, startMs: number) => r(pid, 3001, startMs, { startTicks: ticks, bootId: 'boot-A', startSlackMs: PROC_START_SLACK_MS });
  const keys = (m: Map<number, ProcessRow[]>) => [...m.keys()];
  const leader = linux(3001, 7000, 50_000);
  const child = linux(3002, 7010, 50_100);
  // The leader still there: held, and the child that joined meanwhile is known from now on.
  let held = heldGroups(new Map([[3001, [leader]]]), [leader, child]);
  assert.deepEqual(keys(held), [3001]);
  assert.deepEqual(held.get(3001)!.map((p) => p.pid), [3001, 3002]);
  // The leader gone, the child it left: still the group judged (the id cannot be reused while a member lives).
  held = heldGroups(held, [child]);
  assert.deepEqual(keys(held), [3001], 'a member that joined while a known one lived');
  // Every known member gone and the id taken again: a pid never seen, or a known pid reused (other ticks).
  assert.deepEqual(keys(heldGroups(held, [linux(3050, 8000, 60_000)])), [], 'a stranger\'s group in the reused id');
  assert.deepEqual(keys(heldGroups(held, [linux(3002, 9999, 50_100)])), [], 'the child\'s pid reused: other ticks');
  assert.deepEqual(keys(heldGroups(held, [{ ...child, zombie: true }])), [], 'a zombie holds nothing');
  // A member that started within a second of the judgment is no longer enough by itself: the old window did that.
  assert.deepEqual(keys(heldGroups(new Map([[3001, [leader]]]), [linux(3060, 7100, 50_900)])), [], 'a stranger formed within the old slack');
  // ps's rows (macOS): the same pid and start second.
  const psRow = r(4001, 4001, 50_000);
  assert.deepEqual(keys(heldGroups(new Map([[4001, [psRow]]]), [r(4001, 4001, 50_000)])), [4001]);
  assert.deepEqual(keys(heldGroups(new Map([[4001, [psRow]]]), [r(4001, 4001, 52_000)])), [], 'the pid reused two seconds later');
});

test('jr2-4: with no process listing after the SIGTERM, recovery sends no SIGKILL by pgid alone, and says so (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 4)', { timeout: 15_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'nk');
  const kids = detachedKids();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ready = path.join(dir, 'nk-ready');
    const stubborn = kids.spawn('/bin/sh', ['-c', "trap '' TERM; printf ready > \"$1\"; sleep 411; :", 'recovery-test', ready]);
    await until(() => fs.existsSync(ready));
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'nk' });
    journalProcess(j, 'r1-stubborn', stubborn);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    // The first listing judges the group; every one after it fails.
    let calls = 0;
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => (calls++ === 0 ? listProcesses() : undefined) });
    const h = hist(r.reg.get('nk'));
    assert.match(h.run('r1-stubborn').reason ?? '', new RegExp(`process group ${stubborn} was sent SIGTERM and not SIGKILL: no process listing answered`));
    // Not known to have ended, so not judged: stamped judged, a later recovery left the group alone (the
    // house's read of the 33 commits, PR #22, comment 6307350477, item 1).
    assert.equal(h.run('r1-stubborn').groupJudged, undefined, 'the Run stays a candidate');
    assert.ok(calls >= 2, 'the recheck asked for a listing');
    assert.ok(groupAlive(stubborn), 'it ignored the SIGTERM, and no SIGKILL went by pgid alone');
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: a recovery with no process listing ends no group and says so — a note per candidate Run, one warning in the log — and leaves the Runs candidates, so the next recovery that can list processes ends their groups (a reviewer\'s read of the fixes for #22; the house\'s read of the 36 commits, PR #22, comment 6269992150, item 6)', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'nq');
  const kids = detachedKids();
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Both groups leaderless (the leader exited, its child lives on): the next recovery ties them to their
    // Runs by their members' starts against the dead daemon's last event.
    const inFlight = kids.spawn('/bin/sh', ['-c', 'sleep 412 & exit 0']);
    const leftover = kids.spawn('/bin/sh', ['-c', 'sleep 413 & exit 0']);
    // Each shell forks its sleep before it exits, so the Runs' times are taken after both have: taken right
    // after the spawns, a fork a tenth of a second late started after the leftover's journaled end, and the
    // next recovery left that group running (the house's read of the 33 commits, PR #22, comment 6307350477,
    // item 10).
    await kids.exited(inFlight);
    await kids.exited(leftover);
    let ts = Date.now();
    assert.ok(groupAlive(inFlight) && groupAlive(leftover), 'the children keep their leaderless groups alive');
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'nq', now: () => ts });
    journalProcess(j, 'r1-flight', inFlight);
    journalProcess(j, 'r2-ended', leftover);
    j.append({ type: 'run.end', runId: 'r2-ended', state: 'exited', exit: 0, durationMs: 5, leftovers: true });
    // The dead daemon lived on after starting the Runs: its last event, the evidence the next recovery
    // bounds the groups by, is a second after the forks — past ps's whole-second starts and their slack —
    // and the daemon died before the recovery ran, so the recovery's own end does not come before it.
    ts += 1000;
    j.append({ type: 'output', data: 'still here\r\n', stream: 'pty', runId: 'r1-flight', attribution: 'temporal' });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    await until(() => Date.now() > ts, 3000, "the dead daemon's last event to be in the past");
    const warnings: Array<{ text: string; fields: Record<string, unknown> | undefined }> = [];
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => undefined, log: (level, text, fields) => void (level === 'warn' && warnings.push({ text, fields })) });
    const h = hist(r.reg.get('nq'));
    const notes = h.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'note' }> => e.type === 'note').map((e) => e.text);
    // Returned before any of this, the recovery left nothing in the history or the log.
    for (const [g, runId] of [[inFlight, 'r1-flight'], [leftover, 'r2-ended']] as const) {
      assert.ok(notes.includes(`recovery: process group ${g} left running (no process listing answered, so whose group it is cannot be told) · ${runId}`), JSON.stringify(notes));
    }
    const said = warnings.filter((w) => w.text.includes('no process listing answered'));
    assert.equal(said.length, 1, JSON.stringify(warnings));
    assert.deepEqual([...(said[0]!.fields!['groups'] as number[])].sort(), [inFlight, leftover].sort());
    assert.deepEqual(said[0]!.fields!['sessions'], ['nq']);
    assert.deepEqual([h.run('r1-flight').state, h.run('r1-flight').reason], ['lost', 'daemon-restart'], 'not the Run\'s to end: in a note, not its reason');
    assert.equal(h.run('r1-flight').groupJudged, undefined, 'nothing judged it: still a candidate');
    assert.equal(h.run('r2-ended').groupJudged, undefined, 'the ended Run too');
    assert.ok(groupAlive(inFlight) && groupAlive(leftover), 'nothing was signalled');
    await r.reg.closeAll();
    // The next recovery can list processes: it judges both groups by the dead daemon's evidence and ends them.
    const r2 = rig(dir, { terminateOrphans: true });
    const h2 = hist(r2.reg.get('nq'));
    assert.deepEqual([h2.run('r1-flight').groupJudged, h2.run('r2-ended').groupJudged], [true, true], 'both judged');
    await until(() => !groupAlive(inFlight) && !groupAlive(leftover), 3000, 'the next recovery to have ended both groups');
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

/** A daemon log that keeps what it is told, for the recovery tests that read it. */
const logBook = () => {
  const lines: Array<{ level: string; text: string; fields: Record<string, unknown> | undefined }> = [];
  return { lines, log: (level: 'warn' | 'info', text: string, fields?: Record<string, unknown>) => void lines.push({ level, text, fields }) };
};
const notesOf = (h: HistorySession) => h.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'note' }> => e.type === 'note').map((e) => e.text);

test('jr2-4: a live leader under an end a recovery wrote without judging its group, recorded without ticks, is judged as the in-flight Run it was and ended by the next recovery that can list processes, not left at every later one (the house\'s review of 4f4c067..a8b6f28, PR #22, comment 6323055715, question 6)', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'nw');
  const kids = detachedKids();
  try {
    // The Run's own process leads its group and lives on; its start records no ticks, as on macOS or from an
    // older build, so only the wall clock can tie the leader to the Run.
    const g = kids.spawn('/bin/sh', ['-c', 'exec sleep 416']);
    const ts = Date.now();
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'nw', now: () => ts });
    journalProcess(j, 'r1-lead', g);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    // A recovery with no process listing ends the Run lost and leaves its group a candidate.
    const r1 = rig(dir, { terminateOrphans: true, listProcesses: () => undefined });
    const first = hist(r1.reg.get('nw')).run('r1-lead');
    assert.deepEqual([first.state, first.recoveredEnd, first.groupJudged, first.startTicks], ['lost', true, undefined, undefined]);
    assert.ok(groupAlive(g), 'nothing was signalled');
    await r1.reg.closeAll();
    // The next recovery lists processes: the leader started with the Run, so the group is the Run's and goes.
    const r2 = rig(dir, { terminateOrphans: true });
    const h2 = hist(r2.reg.get('nw'));
    assert.equal(h2.run('r1-lead').groupJudged, true, 'judged');
    assert.ok(notesOf(h2).includes(`recovery: process group ${g} terminated with r1-lead, which an earlier recovery ended lost`), JSON.stringify(notesOf(h2)));
    const said = notesOf(h2).filter((t) => t.includes(`process group ${g}`)).length;
    // The leader is this test's own child, a zombie until the loop reaps it: wait for its exit, not its group.
    await kids.exited(g);
    await r2.reg.closeAll();
    // Judged once: a third recovery adds no note.
    const r3 = rig(dir, { terminateOrphans: true });
    assert.equal(notesOf(hist(r3.reg.get('nw'))).filter((t) => t.includes(`process group ${g}`)).length, said, 'no note from a third recovery');
    await r3.reg.closeAll();
  } finally {
    kids.end();
  }
});


test('jr2-4: a group recovery signalled, with no listing answering after it, is not judged — its Run stays a candidate, and the next recovery that can list processes ends the group (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 1)', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'nu');
  const kids = detachedKids();
  try {
    // Leaderless, so the next recovery ties it to the Run by its member's start against the dead daemon's last
    // event; its member ignores SIGTERM.
    const g = kids.spawn('/bin/sh', ['-c', "trap '' TERM; sleep 414 & exit 0"]);
    await kids.exited(g);
    let ts = Date.now();
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'nu', now: () => ts });
    journalProcess(j, 'r1-term', g);
    ts += 1000; // the dead daemon's last event: past ps's whole-second start and its slack
    j.append({ type: 'output', data: 'still here\r\n', stream: 'pty', runId: 'r1-term', attribution: 'temporal' });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    await until(() => Date.now() > ts, 3000, "the dead daemon's last event to be in the past");
    // The first listing judges the group the Run's; none answers after the SIGTERM.
    let calls = 0;
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => (calls++ === 0 ? listProcesses() : undefined) });
    const first = hist(r.reg.get('nu')).run('r1-term');
    assert.match(first.reason ?? '', new RegExp(`process group ${g} was sent SIGTERM and not SIGKILL: no process listing answered`));
    assert.equal(first.groupJudged, undefined, 'whether it ended is not known: not judged');
    assert.ok(groupAlive(g), 'it ignored the SIGTERM');
    await r.reg.closeAll();
    const r2 = rig(dir, { terminateOrphans: true });
    assert.equal(hist(r2.reg.get('nu')).run('r1-term').groupJudged, true, 'the next recovery judged it');
    await until(() => !groupAlive(g), 3000, 'the next recovery to have ended the group');
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: a group whose processes recovery tied to the Run are gone, while it still holds one recovery cannot tie, is reported left running, not terminated (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 2)', { timeout: 15_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'tr');
  const kids = detachedKids();
  try {
    // The group is real, so the signal and the probe reach it, and it ignores SIGTERM; the listings are the
    // test's: the first shows the Run's leader, every later one only a process recovery never saw — as when
    // a TERM trap starts a new member and the leader exits.
    const ready = path.join(dir, 'tr-ready');
    fs.mkdirSync(dir, { recursive: true });
    const g = kids.spawn('/bin/sh', ['-c', "trap '' TERM; printf ready > \"$1\"; exec sleep 415", 'recovery-test', ready]);
    await until(() => fs.existsSync(ready)); // the trap is set: a group that merely exists may not ignore SIGTERM yet
    const ts = Date.now();
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'tr', now: () => ts });
    journalProcess(j, 'r1-trap', g);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const leader: ProcessRow = { pid: g, pgid: g, startMs: ts, zombie: false };
    const newcomer: ProcessRow = { pid: g + 100_000, pgid: g, startMs: ts + 60_000, zombie: false };
    let calls = 0;
    const book = logBook();
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => (calls++ === 0 ? [leader] : [newcomer]), log: book.log });
    const h = hist(r.reg.get('tr'));
    const run1 = h.run('r1-trap');
    assert.deepEqual([run1.state, run1.reason], ['lost', 'daemon-restart'], 'not "terminated" in its reason');
    assert.equal(run1.groupJudged, true, 'a listing judged it');
    const notes = notesOf(h);
    assert.ok(notes.some((t) => t.startsWith(`recovery: process group ${g} left running: it was sent SIGTERM`) && t.endsWith('· r1-trap')), JSON.stringify(notes));
    assert.ok(!notes.some((t) => t.includes('terminated')), JSON.stringify(notes));
    const ended = book.lines.find((l) => l.text === 'recovery ended process groups a previous daemon left running');
    assert.ok(ended, JSON.stringify(book.lines));
    assert.deepEqual([ended.fields!['groups'], ended.fields!['leftRunning']], [[], [g]], 'the log lists it as left running, not among the groups recovery ended');
    // The leader is this test's own child: until the loop reaps it, a killed leader is a zombie that keeps the
    // pgid, so groupAlive alone cannot tell, and a fixed wait for its exit proves nothing under load (the house's
    // review of the 77 commits through 4f4c067, PR #22). So the test ends it itself, with a signal its trap does
    // not ignore, and waits for its exit: the signal it died of says whether recovery's came first.
    const leader1 = kids.kids.find((c) => c.pid === g)!;
    const died = new Promise<NodeJS.Signals | null>((res) => leader1.once('exit', (_code, signal) => res(signal)));
    const exited = leader1.exitCode !== null || leader1.signalCode !== null;
    if (!exited) process.kill(g, 'SIGHUP');
    assert.equal(exited ? leader1.signalCode : await died, 'SIGHUP', 'and nothing was sent after the SIGTERM: the leader ran until the test ended it');
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4/G21: a session past its age whose Runs\' groups no listing judged is kept — at recovery and by expire — until a recovery that can list processes judges them, and expires after that (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 3)', { timeout: 15_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'aged2');
  const kids = detachedKids();
  try {
    // A real leaderless group (the signal and the probe reach it); the dead daemon ran a minute ago, past the
    // session's age of a second, and the second recovery's listing shows the group's member at a start
    // within the Run's life, before the daemon's last event.
    const g = kids.spawn('/bin/sh', ['-c', 'sleep 416 & exit 0']);
    await kids.exited(g);
    const T = Date.now() - 60_000;
    let ts = T;
    const j = new Journal({ cold: new FileStore(sdir, { maxAgeMs: 1000 }), sessionId: 'aged2', now: () => ts });
    journalProcess(j, 'r1-aged', g);
    ts = T + 5000;
    j.append({ type: 'output', data: 'still here\r\n', stream: 'pty', runId: 'r1-aged', attribution: 'temporal' });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 1000 } }), { mode: 0o600 });
    const book = logBook();
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => undefined, log: book.log });
    // Removed here, a later recovery that can list had nothing naming the group.
    const h = hist(r.reg.get('aged2'));
    assert.equal(h.run('r1-aged').groupJudged, undefined);
    assert.ok(fs.existsSync(sdir), 'its files stay');
    assert.ok(book.lines.some((l) => l.level === 'warn' && l.text.startsWith('a session past its retention is kept') && l.fields?.['session'] === 'aged2'), JSON.stringify(book.lines));
    assert.deepEqual(await r.reg.expire(Date.now() + 3_600_000), [], 'expire keeps it while its groups are unjudged');
    assert.ok(fs.readdirSync(sdir).includes('journal.jsonl') && hist(r.reg.get('aged2')).run('r1-aged').pgid === g, 'with the Run that names the group');
    assert.ok(groupAlive(g));
    await r.reg.closeAll();
    const member: ProcessRow = { pid: g + 100_000, pgid: g, startMs: T + 1000, zombie: false };
    const r2 = rig(dir, { terminateOrphans: true, listProcesses: () => [member] });
    assert.equal(hist(r2.reg.get('aged2')).run('r1-aged').groupJudged, true, 'the recovery that can list judged it');
    await until(() => !groupAlive(g), 3000, 'the group to be ended');
    assert.deepEqual(await r2.reg.expire(Date.now() + 10_000), ['aged2'], 'judged, it expires');
    assert.equal(fs.existsSync(sdir), false);
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4/G21: an unjudged session keeps every file through a new life its owner starts, and through its record being repaired, until a recovery that can list processes judges its groups (the house\'s read of the 40 commits, PR #22)', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const kids = detachedKids();
  try {
    // Two real leaderless groups, each a Run's in a session past its age of a second, with enough output after the
    // Run's start that its run.start sits in a rotated file, which the record's retention would drop.
    const T = Date.now() - 60_000;
    const make = async (id: string, record: string) => {
      const sdir = path.join(dir, 'sessions', id);
      const g = kids.spawn('/bin/sh', ['-c', 'sleep 420 & exit 0']);
      await kids.exited(g);
      let ts = T;
      const j = new Journal({ cold: new FileStore(sdir, { maxFileBytes: 4096 }), sessionId: id, now: () => ts });
      journalProcess(j, `r1-${id}`, g);
      ts = T + 5000;
      for (let i = 0; i < 120; i++) j.append({ type: 'output', data: `line ${i} ${'x'.repeat(80)}\r\n`, stream: 'pty', runId: `r1-${id}`, attribution: 'temporal' });
      j.close();
      fs.writeFileSync(path.join(sdir, 'session.json'), record, { mode: 0o600 });
      return { sdir, g };
    };
    const valid = JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 1000 } });
    const reopened = await make('reopened', valid);
    const repaired = await make('repaired', '{ not a record');
    const files = (sdir: string) => fs.readdirSync(sdir).filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n)).length;
    const holdsStart = (sdir: string) => fs.readdirSync(sdir).some((n) => /^journal(\.\d+)?\.jsonl$/.test(n) && fs.readFileSync(path.join(sdir, n), 'utf8').includes('"type":"run.start"'));
    const counts = [files(reopened.sdir), files(repaired.sdir)];
    assert.ok(counts.every((n) => n > 1), `the run.start is in a rotated file (${counts})`);
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => undefined });
    // The owner starts a new life; the other name's record is repaired and read again.
    await r.reg.ensure({ id: 'reopened', owner: A });
    fs.writeFileSync(path.join(repaired.sdir, 'session.json'), valid, { mode: 0o600 });
    assert.equal(hist(r.reg.rereadIfRefused('repaired')).owner, A, 'the repaired record reads');
    [reopened, repaired].forEach(({ sdir }, i) => {
      assert.ok(holdsStart(sdir) && files(sdir) >= counts[i]!, `${sdir}: the files that name the group stay (${files(sdir)} of ${counts[i]})`);
    });
    await r.reg.closeAll();
    // The next recovery can list processes: it judges both groups by the Runs' records and ends them.
    const member = (g: number): ProcessRow => ({ pid: g + 100_000, pgid: g, startMs: T + 1000, zombie: false });
    const r2 = rig(dir, { terminateOrphans: true, listProcesses: () => [member(reopened.g), member(repaired.g)] });
    assert.equal(hist(r2.reg.get('reopened')).run('r1-reopened').groupJudged, true);
    assert.equal(hist(r2.reg.get('repaired')).run('r1-repaired').groupJudged, true);
    await until(() => !groupAlive(reopened.g) && !groupAlive(repaired.g), 3000, 'both groups to be ended');
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4/G21: a journal recovery never read, opened for a new life, keeps every file naming a Run\'s process group until a recovery that can list processes judges it, and its entry says the retention waits (our read of the house\'s fixes for its review of f3750e4, PR #22: 2f7e9e7)', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const kids = detachedKids();
  try {
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => undefined });
    // Written after the registry started, so its recovery never read it: a Run in flight with a real leaderless
    // group, and enough output after its start that its run.start sits in a rotated file the record's age drops.
    const T = Date.now() - 60_000;
    const sdir = path.join(dir, 'sessions', 'late');
    const g = kids.spawn('/bin/sh', ['-c', 'sleep 420 & exit 0']);
    await kids.exited(g);
    let ts = T;
    const j = new Journal({ cold: new FileStore(sdir, { maxFileBytes: 4096 }), sessionId: 'late', now: () => ts });
    journalProcess(j, 'r1-late', g);
    ts = T + 5000;
    for (let i = 0; i < 120; i++) j.append({ type: 'output', data: `line ${i} ${'x'.repeat(80)}\r\n`, stream: 'pty', runId: 'r1-late', attribution: 'temporal' });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 1000 } }), { mode: 0o600 });
    const files = () => fs.readdirSync(sdir).filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n)).length;
    const holdsStart = () => fs.readdirSync(sdir).some((n) => /^journal(\.\d+)?\.jsonl$/.test(n) && fs.readFileSync(path.join(sdir, n), 'utf8').includes('"type":"run.start"'));
    const count = files();
    assert.ok(count > 1 && holdsStart(), `the run.start is in a rotated file (${count})`);
    await r.reg.ensure({ id: 'late', owner: A });
    assert.ok(holdsStart() && files() >= count, `the files that name the group stay (${files()} of ${count})`);
    assert.equal(r.reg.awaitsJudgement('late'), true, 'the name awaits a recovery that can judge its group');
    assert.deepEqual(await r.reg.expire(), [], 'expire keeps it too');
    // The entry reports what the store applies, and the record's retention as waiting.
    const app = new App({ registry: r.reg });
    const entry = app.sessionList({ principal: A, connectionId: 'c' }).find((s) => s.id === 'late');
    assert.deepEqual([entry?.retention, entry?.pendingRetention], [{}, { maxAgeMs: 1000 }]);
    await r.reg.closeAll();
    // The next recovery can list processes: it judges the group by the Run's record and ends it.
    const member: ProcessRow = { pid: g + 100_000, pgid: g, startMs: T + 1000, zombie: false };
    const r2 = rig(dir, { terminateOrphans: true, listProcesses: () => [member] });
    assert.equal(hist(r2.reg.get('late')).run('r1-late').groupJudged, true);
    assert.equal(r2.reg.awaitsJudgement('late'), false);
    await until(() => !groupAlive(g), 3000, 'the group to be ended');
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: a group a working listing shows gone is judged — no note — so a later restart that finds a stranger in its pgid writes nothing and warns of nothing (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 4)', { timeout: 10_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'gj');
  const kids = detachedKids();
  try {
    // A group that has really ended (no signal can reach anything of it); the listings are the test's.
    const g = kids.spawn('true', []);
    await kids.exited(g);
    await until(() => !groupAlive(g));
    const T = Date.now() - 60_000;
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'gj', now: () => T });
    journalProcess(j, 'r1-gone', g);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => [] });
    const h = hist(r.reg.get('gj'));
    assert.deepEqual([h.run('r1-gone').state, h.run('r1-gone').reason, h.run('r1-gone').groupJudged], ['lost', 'daemon-restart', true], 'gone, judged, nothing to say');
    assert.ok(!notesOf(h).some((t) => t.includes(String(g))), JSON.stringify(notesOf(h)));
    await r.reg.closeAll();
    const stranger: ProcessRow = { pid: g + 100_000, pgid: g, startMs: Date.now(), zombie: false };
    const book = logBook();
    const r2 = rig(dir, { terminateOrphans: true, listProcesses: () => [stranger], log: book.log });
    assert.ok(!notesOf(hist(r2.reg.get('gj'))).some((t) => t.includes('left running')), JSON.stringify(notesOf(hist(r2.reg.get('gj')))));
    assert.ok(!book.lines.some((l) => l.text.startsWith('recovery left process groups')), JSON.stringify(book.lines));
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4: a group set aside as untied whose last process goes while recovery still waits on another group is reported terminated, not left running (the house\'s read of the 33 commits, PR #22, comment 6307350477; an independent read of the fix)', { timeout: 15_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'ut');
  const kids = detachedKids();
  try {
    // Two real groups that ignore SIGTERM, so the signal and the probe reach them; the listings are the test's.
    // The first shows both leaders; the next, a process recovery never saw in the first group (untied) beside
    // the second's leader, which keeps the wait going; the one after, the untied process gone; then nothing.
    fs.mkdirSync(dir, { recursive: true });
    const ready = (n: number) => path.join(dir, `ut-ready-${n}`);
    const g1 = kids.spawn('/bin/sh', ['-c', "trap '' TERM; printf ready > \"$1\"; exec sleep 417", 'recovery-test', ready(1)]);
    const g2 = kids.spawn('/bin/sh', ['-c', "trap '' TERM; printf ready > \"$1\"; exec sleep 418", 'recovery-test', ready(2)]);
    await until(() => fs.existsSync(ready(1)) && fs.existsSync(ready(2))); // both traps set
    const ts = Date.now();
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'ut', now: () => ts });
    journalProcess(j, 'r1-untied', g1);
    journalProcess(j, 'r2-waited', g2);
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const leader = (g: number): ProcessRow => ({ pid: g, pgid: g, startMs: ts, zombie: false });
    const listings: ProcessRow[][] = [[leader(g1), leader(g2)], [{ pid: g1 + 100_000, pgid: g1, startMs: ts + 60_000, zombie: false }, leader(g2)], [leader(g2)]];
    let calls = 0;
    const book = logBook();
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => listings[calls++] ?? [], log: book.log });
    assert.ok(calls >= 4, `the wait went on past the untied process's exit (${calls} listings)`);
    const h = hist(r.reg.get('ut'));
    assert.equal(h.run('r1-untied').reason, `daemon-restart; process group ${g1} terminated`);
    assert.ok(!notesOf(h).some((t) => t.includes('left running')), JSON.stringify(notesOf(h)));
    const ended = book.lines.find((l) => l.text === 'recovery ended process groups a previous daemon left running');
    assert.deepEqual([ended?.fields?.['leftRunning'], [...((ended?.fields?.['groups'] as number[]) ?? [])].sort()], [undefined, [g1, g2].sort()], JSON.stringify(book.lines));
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('jr2-4/G21: recovery judges a Run\'s process group before it applies the record\'s retention — the aged file that names the group is pruned only after (the house\'s read of the 33 commits, PR #22, comment 6307350477; an independent read of the fix)', { timeout: 15_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'ra');
  const kids = detachedKids();
  try {
    // A Run that ended leaving a child in its group, journaled in a file that has since rotated and aged past
    // the record's second; only later events, in the active file, are young. Opened with the record's
    // retention, the store pruned that file at once, and recovery never knew the Run's group.
    const g = kids.spawn('/bin/sh', ['-c', 'sleep 419 & exit 0']);
    await kids.exited(g);
    let ts = Date.now();
    const j = new Journal({ cold: new FileStore(sdir, { maxFileBytes: 4096 }), sessionId: 'ra', now: () => ts });
    journalProcess(j, 'r1-left', g);
    j.append({ type: 'run.end', runId: 'r1-left', state: 'exited', exit: 0, durationMs: 5, leftovers: true });
    for (let i = 0; i < 60; i++) j.append({ type: 'output', data: 'x'.repeat(200), stream: 'pty' });
    const aged = ts;
    ts += 2000;
    j.append({ type: 'output', data: 'young\r\n', stream: 'pty' });
    j.close();
    const rotated = () => fs.readdirSync(sdir).filter((n) => /^journal\.\d+\.jsonl$/.test(n));
    assert.ok(rotated().length >= 2, `rotated files: ${JSON.stringify(rotated())}`);
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 1000 } }), { mode: 0o600 });
    await until(() => Date.now() > aged + 1000, 3000, 'the rotated files to age past the record\'s second');
    const r = rig(dir, { terminateOrphans: true });
    const h = hist(r.reg.get('ra'));
    assert.equal(h.run('r1-left').groupJudged, true, 'the Run, and its group, were known to recovery');
    await until(() => !groupAlive(g), 3000, 'the leftover group to be ended');
    assert.deepEqual(rotated(), [], 'and the record\'s retention pruned the aged files after');
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

test('G10/G21: a session within its age whose power loss took every line is recovered — the reservation it left is not retention\'s floor, so it is not removed as past its age (the house\'s read of the 33 commits, PR #22, comment 6307350477; an independent read of the fix)', async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'pl');
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  // A session with an hour's age limit, created seconds before the power loss: its journal had reserved its
  // seqs (synced, on a boot that is not this one) and its lines, never synced, are gone.
  fs.writeFileSync(path.join(sdir, 'journal.jsonl'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(sdir, 'journal.meta.json'), JSON.stringify({ v: 1, epoch: 'c'.repeat(16), reserved: 10_000, boot: 'the-boot-before-the-power-loss' }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', createdAt: Date.now() - 5000, retention: { maxAgeMs: 3_600_000 } }), { mode: 0o600 });
  const r = rig(dir);
  const h = hist(r.reg.get('pl'));
  assert.ok(fs.existsSync(sdir), 'its files stay');
  const gaps = h.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
  assert.deepEqual(gaps.map((g) => [g.from, g.to]), [[1, 10_000]], 'the lost seqs are a recorded hole');
  assert.equal(h.owner, A);
  await r.reg.closeAll();
});

test('G10/G21: a session whose oldest files aged out to a floor and whose newer lines a power loss took is recovered, since a reservation above the floor that the journal honours says seqs were issued after it (the house\'s read of the 40 commits, PR #22)', async (t) => {
  t.mock.method(boots, 'current', () => 'this-boot');
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'pf');
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  // Age retention dropped the files up to seq 100 and kept their floor; the journal went on to reserve a block
  // above it on the boot before the power loss, which took every line written since.
  fs.writeFileSync(path.join(sdir, 'journal.jsonl'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(sdir, 'journal.meta.json'), JSON.stringify({ v: 1, epoch: 'd'.repeat(16), highWater: 100, reserved: 10_100, boot: 'the-boot-before-the-power-loss' }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', createdAt: Date.now() - 86_400_000, retention: { maxAgeMs: 3_600_000 } }), { mode: 0o600 });
  const r = rig(dir);
  const h = hist(r.reg.get('pf'));
  assert.ok(fs.existsSync(sdir), 'its files stay');
  const gaps = h.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'gap' }> => e.type === 'gap');
  assert.deepEqual(gaps.map((g) => [g.from, g.to]), [[101, 10_100]], 'the seqs above the floor are a recorded hole');
  await r.reg.closeAll();
  // A reservation above the floor written on this boot covers nothing issued, as the journal reads it after
  // a daemon crash that lost nothing the page cache held; nor does one at the floor. Either way every file
  // aged out, and the session goes.
  for (const reservation of [{ reserved: 20_100, boot: 'this-boot' }, { reserved: 10_101 }]) {
    fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sdir, 'journal.meta.json'), JSON.stringify({ v: 1, epoch: 'd'.repeat(16), highWater: 10_101, ...reservation }) + '\n', { mode: 0o600 });
    for (const f of fs.readdirSync(sdir).filter((n) => /^journal(\.\d+)?\.jsonl$/.test(n))) fs.writeFileSync(path.join(sdir, f), '', { mode: 0o600 });
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', createdAt: Date.now() - 86_400_000, retention: { maxAgeMs: 3_600_000 } }), { mode: 0o600 });
    const r2 = rig(dir);
    assert.equal(r2.reg.get('pf'), undefined, `past its age with nothing honoured above the floor, it is removed (${JSON.stringify(reservation)})`);
    assert.equal(fs.existsSync(sdir), false);
    await r2.reg.closeAll();
  }
});

test('jr2-4: an end a recovery wrote is bounded by the evidence it recorded as the in-flight rule is — a member proven to have started before it, not one that may have started after (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 5)', () => {
  const self = { pid: 500, pgid: 400 };
  const L = 1_000_000; // the dead daemon's last event
  const cand = (over: Partial<RunInfo>): OrphanCandidate => ({
    key: 's\0r',
    run: { runId: 'r', sessionId: 's', target: 'process', origin: 'self', principal: A, state: 'running', admittedAt: L - 20_010, startedAt: L - 20_000, seq: { admit: 1, start: 2 }, attribution: 'exact', pgid: 2001, ...over },
    lastTs: L,
  });
  const inFlight = cand({});
  const byRecovery = cand({ state: 'lost', reason: 'daemon-restart', recoveredEnd: true, endedAt: L + 60_000, lastAliveTs: L, seq: { admit: 1, start: 2, end: 3 } });
  const proc = (startMs: number): ProcessRow => ({ pid: 2101, pgid: 2001, startMs, startSlackMs: PROC_START_SLACK_MS, zombie: false });
  const ps = (startMs: number): ProcessRow => ({ pid: 2101, pgid: 2001, startMs, zombie: false });
  const sel = (c: OrphanCandidate, procs: ProcessRow[]) => [...orphanGroups([c], procs, self).keys()];
  for (const [name, c] of [['in flight', inFlight], ['ended by a recovery', byRecovery]] as const) {
    // 10 ms before the last event with 25 ms of slack: it may have started after the daemon died.
    assert.deepEqual(sel(c, [proc(L - 10)]), [], `${name}: a /proc start within its slack of the last event`);
    assert.deepEqual(sel(c, [proc(L - 100)]), [2001], `${name}: a /proc start proven before it`);
    assert.deepEqual(sel(c, [ps(L - 500)]), [], `${name}: a ps start that may lie after it`);
    assert.deepEqual(sel(c, [ps(L - 1000)]), [2001], `${name}: ps's whole second before it`);
  }
});

test('jr2-4: the dead daemon\'s last evidence passes over what an earlier recovery wrote before it died too — the journal\'s gap at open, and lost ends, whose recorded evidence is taken (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 5)', async () => {
  const T_death = 1_000_000;
  const T_rec1 = T_death + 60_000;
  const evidence = async (id: string, crashedRecovery: (sdir: string) => void) => {
    const dir = path.join(tmp, `d${++dirs}`);
    const sdir = path.join(dir, 'sessions', id);
    const j = new Journal({ cold: new FileStore(sdir), sessionId: id, now: () => T_death });
    journalProcess(j, 'r1-first', 4242);
    journalProcess(j, 'r2-second', 4343);
    j.append({ type: 'output', data: 'tick\n', stream: 'stdout', runId: 'r2-second' });
    j.close();
    crashedRecovery(sdir);
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const r = rig(dir);
    const run = hist(r.reg.get(id)).run('r2-second');
    await r.reg.closeAll();
    return run;
  };
  // The first recovery ended one Run, then died: its end, at its own time, is the store's newest event.
  const partway = await evidence('ends', (sdir) => {
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'ends', now: () => T_rec1 });
    j.append({ type: 'run.end', runId: 'r1-first', state: 'lost', reason: 'daemon-restart', durationMs: 1, recoveredEnd: true, lastAliveTs: T_death });
    j.close();
  });
  assert.deepEqual([partway.state, partway.lastAliveTs], ['lost', T_death], 'the evidence the first recovery recorded, not its time');
  // An older recovery's unflagged end carries no evidence: the dead daemon's own events are read past it.
  const older = await evidence('older', (sdir) => {
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'older', now: () => T_rec1 });
    j.append({ type: 'run.end', runId: 'r1-first', state: 'lost', reason: 'daemon-restart', durationMs: 1 });
    j.close();
  });
  assert.equal(older.lastAliveTs, T_death);
  // The first recovery opened the journal over a torn line — which writes a gap at its own time — and died.
  const torn = await evidence('gap', (sdir) => {
    const file = path.join(sdir, 'journal.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, -5));
    new Journal({ cold: new FileStore(sdir), sessionId: 'gap', now: () => T_rec1 }).close();
  });
  assert.equal(torn.lastAliveTs, T_death, 'the gap the journal wrote at open is not the dead daemon\'s');
});

test('jr2-4 (Linux): recovery ties a group to its Run by the leader\'s start ticks from the machine\'s own listing, where the wall clock would not (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 1)', { timeout: 10_000 }, async (t) => {
  // With `ps` read first, as before, the machine's rows carried no ticks on Linux and this group was left.
  if (process.platform !== 'linux') {
    t.skip(`/proc's start ticks are Linux's: skipped on ${process.platform}`);
    return;
  }
  const dir = path.join(tmp, `d${++dirs}`);
  const sdir = path.join(dir, 'sessions', 'tk');
  const kids = detachedKids();
  try {
    const sleeper = kids.spawn('sleep', ['412']);
    await until(() => procStart(sleeper) !== undefined);
    const start = procStart(sleeper)!;
    // The Run journaled ten minutes off its leader's start (a clock step since): by the wall clock the leader
    // came long after the Run and is a reused pid; its ticks say it is the Run's.
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'tk', now: () => Date.now() - 600_000 });
    j.append({ type: 'run.admit', runId: 'r1-ticks', target: 'process', line: 'sleep 412', principal: A, origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'r1-ticks', cwd: '/', envBasis: 'configured', pid: sleeper, pgid: sleeper, startTicks: start.startTicks, bootId: start.bootId });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    const rows = listProcesses()!;
    assert.ok(rows.every((p) => p.startTicks !== undefined && p.bootId === start.bootId), 'the machine\'s listing carries ticks and the boot id');
    const r = rig(dir, { terminateOrphans: true });
    assert.equal(hist(r.reg.get('tk')).run('r1-ticks').reason, `daemon-restart; process group ${sleeper} terminated`);
    await kids.exited(sleeper);
    assert.equal(kids.kids.find((c) => c.pid === sleeper)!.signalCode, 'SIGTERM');
    await r.reg.closeAll();
  } finally {
    kids.end();
  }
});

// ───────────── jr2-12: command files ─────────────

test('jr2-12/G26: command files stay in the private shell directory; recovery deletes leftovers and forget removes the session', async () => {
  const r1 = rig();
  const s = (await r1.reg.ensure({ id: 'k3', owner: A })).session;
  await run(s, 'echo export API_TOKEN=sekrit');
  const shellDir = path.join(r1.dir, 'sessions', 'k3', 'shell');
  assert.equal(fs.statSync(shellDir).mode & 0o077, 0, 'the shell directory excludes other users');
  assert.ok(fs.readdirSync(shellDir).some((n) => n.startsWith('tsm-cmd-')), 'the session keeps command files inside its private shell directory');
  fs.writeFileSync(path.join(shellDir, 'tsm-cmd-9'), 'export API_TOKEN=stale-copy\n', { mode: 0o600 });
  fs.writeFileSync(path.join(shellDir, 'tsm-history-k3'), ': the session history stays\n', { mode: 0o600 });
  // The daemon dies (never closed); a new one recovers the data dir.
  const r2 = restart(r1);
  // The session's history stays (its HISTFILE and atuin directory, ux-3), and the integration files the next life rewrites.
  assert.deepEqual(fs.readdirSync(shellDir).sort(), ['integration', 'tsm-history-k3', 'tsm-history-k3.d'], 'command files go, session history stays');
  // A crashed life's leftovers again, then forget.
  fs.writeFileSync(path.join(shellDir, 'tsm-cmd-3'), 'export API_TOKEN=stale-copy\n', { mode: 0o600 });
  await r2.reg.remove('k3');
  assert.equal(fs.existsSync(path.join(r2.dir, 'sessions', 'k3')), false, 'forget removes the private directory and its command text');
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

test('jr2-4: a journal recovery never read, opened for a new life, ends the Runs it left in flight as recovery does, so the next recovery that can list processes ends a leader still running (the house\'s review of the 77 commits through 4f4c067, PR #22)', { timeout: 20_000 }, async () => {
  const dir = path.join(tmp, `d${++dirs}`);
  const kids = detachedKids();
  try {
    const r = rig(dir, { terminateOrphans: true, listProcesses: () => undefined });
    // Written after the registry started, so its recovery never read it: a Run in flight whose leader still runs,
    // with its start ticks and boot recorded.
    const T = Date.now() - 60_000;
    const sdir = path.join(dir, 'sessions', 'late');
    const g = kids.spawn('sleep', ['433']);
    const j = new Journal({ cold: new FileStore(sdir), sessionId: 'late', now: () => T });
    j.append({ type: 'run.admit', runId: 'r1-late', target: 'process', line: 'r1-late', principal: A, origin: 'self', queued: false });
    j.append({ type: 'run.start', runId: 'r1-late', cwd: '/', envBasis: 'configured', pid: g, pgid: g, startTicks: 4242, bootId: 'boot-X' });
    j.close();
    fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
    await r.reg.ensure({ id: 'late', owner: A });
    await r.reg.closeAll();
    const ends = onDisk(sdir).filter((e): e is Extract<JournalEvent, { type: 'run.end' }> => e.type === 'run.end' && e.runId === 'r1-late');
    assert.deepEqual(
      ends.map((e) => [e.state, e.reason, e.recoveredEnd, e.lastAliveTs, e.groupJudged]),
      [['lost', 'daemon-restart', true, T, undefined]],
      'one end, a recovery\'s: the dead daemon\'s last evidence, and no judgement',
    );
    // The next recovery lists the leader, with the Run's ticks under the Run's boot: the group is the Run's.
    const leader: ProcessRow = { pid: g, pgid: g, startMs: T + 200, zombie: false, startTicks: 4242, bootId: 'boot-X' };
    const r2 = rig(dir, { terminateOrphans: true, listProcesses: () => [leader] });
    assert.equal(hist(r2.reg.get('late')).run('r1-late').groupJudged, true);
    await kids.exited(g);
    const killed = kids.kids.find((c) => c.pid === g)!;
    assert.ok(killed.signalCode === 'SIGTERM' || killed.signalCode === 'SIGKILL', `ended by recovery (${killed.signalCode})`);
    await r2.reg.closeAll();
  } finally {
    kids.end();
  }
});

// ───────────── the house's review of 4f4c067..a8b6f28, PR #22 ─────────────

test('a removal the disk refuses leaves the name with a working cursor book: a later markRead is written', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'x', owner: A })).session;
  await run(s, 'echo one');
  await r.reg.close('x');
  // The removal is refused as a disk refuses it, for any user: node:fs as registry.js sees it, patched for the call.
  const fsc = createRequire(import.meta.url)('node:fs') as { rmSync: typeof fs.rmSync };
  const realRm = fsc.rmSync;
  fsc.rmSync = (() => {
    throw Object.assign(new Error('EACCES: permission denied, rmdir'), { code: 'EACCES' });
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  try {
    await assert.rejects(r.reg.remove('x'), /EACCES/);
  } finally {
    fsc.rmSync = realRm;
    syncBuiltinESMExports();
  }
  hist(r.reg.get('x')).markRead(A, 9);
  const file = path.join(r.dir, 'sessions', 'x', 'cursors.json');
  await until(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'))[A]?.read === 9, 2500, 'the cursors to be written');
  await r.reg.closeAll();
});

test('a Run the session does not hold, still open at a close that gives a reason, ends with that reason', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'y', owner: A })).session;
  s.journal.append({ type: 'run.admit', runId: 'unheld', target: 'process', line: 'unheld', principal: A, origin: 'self', queued: false });
  await r.reg.closeAll({ reason: 'daemon-shutdown' });
  const ends = onDisk(path.join(r.dir, 'sessions', 'y')).filter((e): e is Extract<JournalEvent, { type: 'run.end' }> => e.type === 'run.end');
  assert.deepEqual(ends.map((e) => [e.runId, e.reason]), [['unheld', 'daemon-shutdown']]);
});
