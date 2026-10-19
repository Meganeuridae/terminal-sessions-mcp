/**
 * Restart with the file store, faithfully (tg-11, G20): a daemon process with a
 * real bash session is SIGKILLed mid-work, and a new registry recovers its data
 * dir. Every admitted Run must be terminal, each Run's output must be its own,
 * and the name stays its owner's. A process Run the dead daemon left running is
 * terminated by recovery once its run.start names its process group (jr2-4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry, type HistorySession } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { groupAlive } from '../src/core/lock.js';
import type { JournalEvent } from '../src/core/types.js';

const A = 'agent:a@test';

const alive = (needle: string): boolean => {
  try {
    return execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some((l) => l.trim() === needle);
  } catch {
    return false;
  }
};

/** The "daemon": a registry with one bash session doing four kinds of work, reporting their runIds. */
const child = (dataDir: string) => `
import { SessionRegistry } from ${JSON.stringify(new URL('../src/api/registry.js', import.meta.url).href)};
import { NodePtyBackend } from ${JSON.stringify(new URL('../src/backends/node-pty.js', import.meta.url).href)};
const P = ${JSON.stringify(A)};
const reg = new SessionRegistry({ dataDir: ${JSON.stringify(dataDir)}, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
const { session } = await reg.ensure({ id: 'k', owner: P });
session.attach(P, 'c1');
const shell = async (line) => {
  const a = await session.admitWhenAvailable({ target: 'shell', line, principal: P });
  if (!a.admitted) throw new Error('not admitted: ' + a.reason);
  return a.run.runId;
};
const one = await shell('echo marker-one');
await session.awaitRun(one, 5000);
await session.waitAvailable(2000);
const two = await shell('echo marker-two');
await session.awaitRun(two, 5000);
await session.waitAvailable(2000);
const slow = await shell('sleep 31.25');
for (let i = 0; i < 100 && session.run(slow).state !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
const queued = session.admit({ target: 'shell', line: 'echo never-ran', principal: P, queue: true });
const proc = session.admit({ target: 'process', line: 'sleep 2', principal: P });
const orphan = session.admit({ target: 'process', line: 'sleep 30.75', principal: P });
for (let i = 0; i < 100 && session.run(orphan.run.runId).state !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
// A Run that ends at once, leaving background work that keeps starting processes in its group. The
// daemon dies more than a second after the Run ended, so the loop's newest child — whose start ps
// truncates to the second — started after the end by any reading: the case the house ran.
const loop = session.admit({ target: 'process', line: '(while true; do sleep 0.3; done) & exit 0', principal: P });
await session.awaitRun(loop.run.runId, 5000);
await new Promise((r) => setTimeout(r, 1500));
process.stdout.write(JSON.stringify({ one, two, slow, slowState: session.run(slow).state, queued: queued.run.runId, proc: proc.run.runId, orphan: orphan.run.runId, loop: loop.run.runId, loopPgid: String(session.run(loop.run.runId).pgid ?? '') }) + '\\n');
setInterval(() => {}, 1000);
`;

test('tg-11/G20: after a SIGKILLed daemon, every admitted Run is terminal and each Run reads as its own', { timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-restart-'));
  // The SIGKILLed child cannot remove its temp files: they go under the data dir.
  const childTmp = path.join(dataDir, 'tmp');
  fs.mkdirSync(childTmp);
  const proc = spawn(process.execPath, ['--input-type=module', '-e', child(dataDir)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: childTmp } });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  let loopPgid = 0;
  try {
    const ids = await new Promise<Record<string, string>>((resolve, reject) => {
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)) as Record<string, string>);
      });
      proc.once('exit', (c) => reject(new Error(`child exited ${c}: ${stderr}`)));
      setTimeout(() => reject(new Error(`child timed out: ${stderr}`)), 20_000).unref();
    });
    assert.equal(ids.slowState, 'running');
    loopPgid = Number(ids.loopPgid) || 0;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGKILL');
    await exited;

    const t0 = Date.now();
    const reg = new SessionRegistry({ dataDir, backend: new NodePtyBackend() });
    assert.ok(Date.now() - t0 < 3500, `recovery took ${Date.now() - t0} ms`);
    const h = reg.get('k') as HistorySession;
    assert.ok(h && h.kind === 'history' && h.recovered === 'history-only' && !h.closed);
    for (const l of fs.readFileSync(path.join(dataDir, 'sessions/k/journal.jsonl'), 'utf8').split('\n').filter(Boolean)) JSON.parse(l);
    const runs = h.listRuns();
    assert.deepEqual(runs.map((r) => r.runId), [ids.one, ids.two, ids.slow, ids.queued, ids.proc, ids.orphan, ids.loop]);
    for (const r of runs) assert.ok(['exited', 'cancelled', 'lost'].includes(r.state), `${r.line}: ${r.state}`);
    assert.deepEqual([h.run(ids.one!).state, h.run(ids.one!).exit], ['exited', 0]);
    for (const id of [ids.slow!, ids.queued!, ids.proc!, ids.orphan!]) {
      assert.equal(h.run(id).state, 'lost');
      assert.match(h.run(id).reason ?? '', /^daemon-restart(; process group \d+ (terminated|survived SIGKILL))?$/);
    }
    const notes = h.journal.since(0).events.filter((e): e is Extract<JournalEvent, { type: 'note' }> => e.type === 'note').map((e) => e.text);
    // jr2-4: a process Run whose group the journal names is not left running as an orphan.
    const orphan = h.run(ids.orphan!);
    if (orphan.pgid !== undefined) {
      assert.equal(orphan.reason, `daemon-restart; process group ${orphan.pgid} terminated`);
      assert.equal(alive('sleep 30.75'), false, 'the orphan was terminated at recovery');
      // Its note says the group went with the Run recovery ended, not that it outlived a Run that had ended (the house's read of cc8c909..39787b3, #22).
      assert.ok(notes.includes(`recovery: process group ${orphan.pgid} terminated with ${ids.orphan}, which recovery ended lost`), JSON.stringify(notes));
      assert.ok(!notes.some((t) => t.includes(`outlived ${ids.orphan}`)), JSON.stringify(notes));
    } else {
      console.log('# run.start carries no pgid in this build: the orphan check is skipped (the session workstream records it)');
    }
    // A Run that had ended leaving a loop in its group, whose newest child started after the Run ended:
    // the whole group is the Run's, and goes (the house's read of cc8c909..39787b3, #22).
    const loop = h.run(ids.loop!);
    assert.deepEqual([loop.state, loop.exit, loop.leftovers], ['exited', 0, true]);
    if (loop.pgid !== undefined) {
      assert.equal(groupAlive(loop.pgid), false, 'the loop and its newest child were terminated at recovery');
      assert.ok(notes.includes(`recovery: process group ${loop.pgid} terminated; it outlived ${ids.loop}, which had ended`), JSON.stringify(notes));
    }
    const textOf = (runId: string) =>
      h
        .runOutput(runId)
        .events.map((e) => (e as Extract<JournalEvent, { type: 'output' }>).data)
        .join('');
    assert.match(textOf(ids.one!), /marker-one/);
    assert.doesNotMatch(textOf(ids.one!), /marker-two|sleep/, 'no other Run\'s output');
    assert.match(textOf(ids.two!), /marker-two/);
    assert.doesNotMatch(textOf(ids.two!), /marker-one/);
    assert.equal(textOf(ids.queued!), '');
    await assert.rejects(reg.ensure({ id: 'k', owner: 'agent:b@test' }), (e: Error & { code?: string }) => e.code === 'forbidden');
    await reg.closeAll();
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    // The loop's group outlives everything unless recovery ended it; a failure must not leave it running.
    if (loopPgid > 1) {
      try {
        process.kill(-loopPgid, 'SIGKILL');
      } catch {
        // ended at recovery, as expected
      }
    }
    // The shell's foreground job dies with the PTY; clean up anyway so a failure leaves nothing behind.
    for (const leftover of ['sleep 31.25', 'sleep 30.75']) {
      try {
        execFileSync('pkill', ['-f', leftover]);
      } catch {
        // nothing left, as expected
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
