/**
 * The session registry against the scripted backend: name ownership (G18),
 * case-insensitive names, concurrent creation (G10), close into readable
 * history (G19), history Runs and recovery (G20), retention (G21), and the
 * modes of what it writes (G26). Each test is named for the guarantee or the
 * review finding it encodes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry, type AnySession, type HistorySession, type LiveSession, type RegistryChange } from '../src/api/registry.js';

/** node:fs as stores.js sees it: a patch here plus syncBuiltinESMExports reaches its `import * as fs` bindings. */
const fsc = createRequire(import.meta.url)('node:fs') as { fsyncSync: typeof fs.fsyncSync; fstatSync: typeof fs.fstatSync; renameSync: typeof fs.renameSync };
/**
 * Every rename into a file named `name` while `fn` runs is counted, and refused with EIO while `refuse()`
 * says so: writeDurably renames its temporary into place, so a count is a count of writes, and a refusal
 * is a write that did not happen.
 */
async function renamesInto<T>(name: string, fn: (count: () => number) => Promise<T> | T, refuse: () => boolean = () => false): Promise<T> {
  const real = fsc.renameSync;
  let n = 0;
  fsc.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(to)) === name) {
      if (refuse()) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      n++;
    }
    return real(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    return await fn(() => n);
  } finally {
    fsc.renameSync = real;
    syncBuiltinESMExports();
  }
}
/** A directory fsync that fails with EIO while `fn` runs (file fsyncs still work). */
function withDirFsyncEIO<T>(fn: () => T): T {
  const real = fsc.fsyncSync;
  fsc.fsyncSync = ((fd: number) => {
    if (fsc.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    return real(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsc.fsyncSync = real;
    syncBuiltinESMExports();
  }
}
import type { ScriptedBackend, ScriptedProcess } from '../src/backends/scripted.js';
import { TermError } from '../src/core/errors.js';
import { FileStore } from '../src/core/stores.js';
import { Journal } from '../src/core/journal.js';
import type { Session } from '../src/core/session.js';
import type { JournalEvent } from '../src/core/types.js';
import { clocks } from '../src/core/clock.js';
import { fakeShellBackend, until, type FakeShell } from './fake-shell.js';

const A = 'agent:a@test';
const B = 'agent:b@test';

interface Rig {
  dir: string;
  backend: ScriptedBackend;
  shells: FakeShell[];
  reg: SessionRegistry;
  changes: RegistryChange[];
}

function scripted(): { backend: ScriptedBackend; shells: FakeShell[] } {
  const shells: FakeShell[] = [];
  const backend = fakeShellBackend(
    (sh) => {
      sh.on(/^echo (.*)$/, (l) => ({ output: `${l.slice(5)}\r\n`, exit: 0 }));
      sh.on(/^fail$/, () => ({ output: 'nope\r\n', exit: 3 }));
      sh.on(/^sleep/, () => ({ hang: true }));
      sh.on(/^big (\d+)$/, (l) => ({ output: `${'x'.repeat(Number(l.split(' ')[1]))}\r\n`, exit: 0 }));
      shells.push(sh);
    },
    { marks: 'rich', exitDeferred: true },
  );
  return { backend, shells };
}

function registry(dir: string, backend: ScriptedBackend): SessionRegistry {
  return new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir() });
}

function rig(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'))): Rig {
  const { backend, shells } = scripted();
  const reg = registry(dir, backend);
  const changes: RegistryChange[] = [];
  reg.onChange((c) => changes.push(c));
  return { dir, backend, shells, reg, changes };
}

/** A new registry over the same data dir: the daemon after a restart. */
function restart(r: Rig): Rig {
  return rig(r.dir);
}

async function run(session: Session, principal: string, line: string, opts: { queue?: boolean; wait?: number } = {}) {
  if (!session.listAttachments().some((a) => a.principal === principal)) session.attach(principal, `conn-${principal}`);
  const ao: Parameters<Session['admitWhenAvailable']>[0] = { target: 'shell', line, principal };
  if (opts.queue) ao.queue = true;
  const a = await session.admitWhenAvailable(ao);
  assert.ok(a.admitted, `admitted ${line}: ${!a.admitted && a.reason}`);
  return session.awaitRun(a.run.runId, opts.wait ?? 2000);
}

const code = (e: unknown) => (e instanceof TermError ? e.code : String(e));
const rejectsWith = async (p: Promise<unknown>, c: string) => assert.equal(await p.then(() => 'resolved', code), c);
const hist = (s: AnySession | undefined): HistorySession => {
  assert.ok(s && s.kind === 'history', `expected history, got ${s?.kind}`);
  return s;
};
const live = (s: AnySession | undefined): LiveSession => {
  assert.ok(s && s.kind === 'live', `expected live, got ${s?.kind}`);
  return s;
};
const text = (events: JournalEvent[]) => events.map((e) => (e.type === 'output' ? e.data : '')).join('');
const xs = (events: JournalEvent[]) => (text(events).match(/x/g) ?? []).length;
const seqsOnDisk = (dir: string) =>
  fs
    .readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { seq?: number }).seq)
    .filter((s): s is number => typeof s === 'number');
const cleanup = async (...rigs: Rig[]) => {
  for (const r of rigs) await r.reg.closeAll();
  const dir = rigs[0]!.dir;
  // Command directories live in /tmp, outside the data dir (jr2-12).
  for (const id of fs.readdirSync(path.join(dir, 'sessions'))) {
    fs.rmSync(path.join(`/tmp/tsm-${process.getuid!()}`, createHash('sha256').update(`${path.resolve(dir)}\0${id}`).digest('hex').slice(0, 8)), { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
};

test('jr-1/api-2/tg-1/G18: after a restart, another principal cannot take over a private session name', async () => {
  const r1 = rig();
  const s = (await r1.reg.ensure({ id: 'secret', owner: A })).session;
  const secret = await run(s, A, 'echo AWS_SECRET=hunter2');
  const before = s.journal.lastSeq;
  await r1.reg.closeAll();
  const r2 = restart(r1);
  const h = hist(r2.reg.get('secret'));
  assert.equal(h.owner, A);
  assert.equal(h.closed, false);
  await rejectsWith(r2.reg.ensure({ id: 'secret', owner: B }), 'forbidden');
  await rejectsWith(r2.reg.create({ id: 'secret', owner: B }), 'forbidden');
  assert.equal(hist(r2.reg.get('secret')).owner, A, 'the history keeps its owner');
  assert.equal((JSON.parse(fs.readFileSync(path.join(r1.dir, 'sessions/secret/session.json'), 'utf8')) as { owner: string }).owner, A);
  assert.equal(r2.backend.ptys.length, 0, 'no shell was started for the refused caller');
  // The owner starts a new life: the journal and its numbering continue, and old runIds stay valid.
  const again = await r2.reg.ensure({ id: 'secret', owner: A });
  assert.equal(again.created, true);
  assert.ok(again.session.journal.since(before).events[0]!.seq > before);
  const l = live(r2.reg.get('secret'));
  const old = l.run(secret.runId);
  assert.equal(old.state, 'exited');
  assert.equal(old.exit, 0);
  assert.match(text(l.runOutput(secret.runId).events), /AWS_SECRET=hunter2/);
  assert.ok(l.listRuns().some((x) => x.runId === secret.runId));
  assert.deepEqual(seqsOnDisk(path.join(r1.dir, 'sessions/secret')), [...new Set(seqsOnDisk(path.join(r1.dir, 'sessions/secret')))].sort((a, b) => a - b), 'seq strictly increasing on disk');
  await cleanup(r2, r1);
});

test('jr-1/jr-12/tg-1/G18/G19: a closed session stays readable history, and its name stays its owner\'s', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'priv', owner: A })).session;
  const tok = await run(s, A, 'echo TOKEN=abc123');
  await r.reg.close('priv', { reason: 'done' });
  const h = hist(r.reg.get('priv'));
  assert.equal(h.closed, true);
  assert.equal(h.owner, A);
  assert.match(text(h.journal.since(0).events), /TOKEN=abc123/, 'history stays readable after close');
  assert.equal(h.run(tok.runId).state, 'exited');
  assert.deepEqual(r.changes.map((c) => c.type), ['created', 'closed'], 'close emits closed, not removed');
  assert.ok(r.reg.list().includes(h));
  await rejectsWith(r.reg.ensure({ id: 'priv', owner: B }), 'forbidden');
  await rejectsWith(r.reg.create({ id: 'priv', owner: B }), 'forbidden');
  await r.reg.close('priv'); // closing history again changes nothing
  assert.throws(() => r.reg.live('priv'), (e: TermError) => e.code === 'session_exited' && /closed/.test(e.message));
  // After a restart it is still a closed history entry, and no second `recovered` marker is written.
  const r2 = restart(r);
  const h2 = hist(r2.reg.get('priv'));
  assert.equal(h2.closed, true);
  assert.equal(h2.journal.since(0).events.filter((e) => e.type === 'recovered').length, 0);
  // remove deletes the entry and its files.
  await r2.reg.remove('priv');
  assert.equal(r2.reg.get('priv'), undefined);
  assert.equal(fs.existsSync(path.join(r.dir, 'sessions/priv')), false);
  assert.deepEqual(r2.changes.map((c) => c.type), ['removed']);
  await rejectsWith(r2.reg.remove('priv'), 'session_not_found');
  const other = (await r2.reg.ensure({ id: 'livebox', owner: A })).session;
  assert.ok(other);
  await rejectsWith(r2.reg.remove('livebox'), 'invalid_argument');
  await cleanup(r2, r);
});

test('sec-5/G10: session names are unique case-insensitively, live and on disk', async () => {
  const r = rig();
  await r.reg.ensure({ id: 'Box', owner: A });
  const clash = await r.reg.create({ id: 'box', owner: B }).then(
    () => undefined,
    (e: TermError) => e,
  );
  assert.equal(clash?.code, 'session_exists');
  assert.equal(clash?.data?.existing, 'Box', 'the error names the existing session');
  await rejectsWith(r.reg.ensure({ id: 'BOX', owner: B }), 'session_exists');
  assert.equal(r.reg.get('box'), undefined);
  assert.equal(r.backend.ptys.length, 1);
  await r.reg.closeAll();
  const r2 = restart(r);
  hist(r2.reg.get('Box'));
  await rejectsWith(r2.reg.ensure({ id: 'bOx', owner: A }), 'session_exists');
  assert.deepEqual(fs.readdirSync(path.join(r.dir, 'sessions')), ['Box']);
  await cleanup(r2, r);
});

test('jr-3/api-7/G10: concurrent opens of one new name make one shell and one journal', async () => {
  const r = rig();
  const results = await Promise.all([r.reg.ensure({ id: 'dup', owner: A }), r.reg.ensure({ id: 'dup', owner: A }), r.reg.ensure({ id: 'dup', owner: B })]);
  assert.equal(r.backend.ptys.length, 1, 'one shell');
  assert.deepEqual(results.map((x) => x.created), [true, false, false]);
  assert.ok(results.every((x) => x.session === results[0]!.session), 'every caller gets the same session');
  assert.equal(results[0]!.session.owner, A, 'the first caller owns it');
  const creates = await Promise.allSettled([r.reg.create({ id: 'dup2', owner: A }), r.reg.create({ id: 'dup2', owner: A })]);
  assert.deepEqual(creates.map((c) => c.status), ['fulfilled', 'rejected']);
  assert.equal(code((creates[1] as PromiseRejectedResult).reason), 'session_exists');
  assert.equal(r.backend.ptys.length, 2);
  const s = results[0]!.session;
  await Promise.all([run(s, A, 'echo one'), run(s, A, 'echo two', { queue: true })]);
  const seqs = seqsOnDisk(path.join(r.dir, 'sessions/dup'));
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seqs on disk');
  await r.reg.closeAll();
  assert.ok(r.backend.ptys.every((p) => p.exited), 'no shell leaked past closeAll');
  await cleanup(r);
});

test('jr-4/api-9/tg-11/G20: a history session reconstructs its Runs from the journal; in-flight ones are lost', async () => {
  const r1 = rig();
  const s = (await r1.reg.ensure({ id: 'h', owner: A })).session;
  const first = await run(s, A, 'echo first-run-output');
  const second = await run(s, A, 'fail');
  const slow = await run(s, A, 'sleep 100', { wait: 20 });
  assert.equal(slow.state, 'running');
  const queued = await run(s, A, 'echo queued', { queue: true, wait: 0 });
  assert.equal(queued.state, 'queued');
  // The daemon dies here: a new registry recovers while the old one is never closed.
  const r2 = restart(r1);
  const h = hist(r2.reg.get('h'));
  assert.equal(h.recovered, 'history-only');
  assert.deepEqual(h.listRuns().map((x) => x.runId), [first.runId, second.runId, slow.runId, queued.runId]);
  const one = h.run(first.runId);
  assert.deepEqual([one.state, one.exit, one.line], ['exited', 0, 'echo first-run-output']);
  assert.deepEqual([h.run(second.runId).state, h.run(second.runId).exit], ['exited', 3]);
  for (const id of [slow.runId, queued.runId]) {
    const x = h.run(id);
    assert.deepEqual([x.state, x.reason], ['lost', 'daemon-restart'], `${id} was in flight`);
  }
  const outOne = h.runOutput(first.runId);
  // Keyed marks are not output (atc-3); what matters is that no other Run's output is in it.
  assert.match(text(outOne.events), /^first-run-output\r\n(\x1b\]133;D;0(;k=[^\x07]*)?\x07)?$/, 'only that Run\'s output');
  assert.equal(live(r1.reg.get('h')).runOutput(first.runId).events.map((e) => e.seq).join(), outOne.events.map((e) => e.seq).join(), 'the same events the live session attributes');
  assert.equal(outOne.truncated, false);
  assert.ok(outOne.to - outOne.from < 10);
  assert.equal(text(h.runOutput(queued.runId).events), '');
  // Bounded: only the newest output, walking the Run's range backwards.
  const capped = h.runOutput(first.runId, { maxBytes: 5 });
  assert.deepEqual([capped.truncated, capped.to], [outOne.truncated || capped.events.length < outOne.events.length, outOne.to]);
  assert.ok(text(capped.events).length >= 5 && outOne.events.slice(-capped.events.length).every((e, i) => e.seq === capped.events[i]!.seq));
  assert.deepEqual(h.runOutput(first.runId, { maxBytes: 1 << 20 }).events.map((e) => e.seq), outOne.events.map((e) => e.seq));
  assert.throws(() => h.run('r99-bogus'), (e: TermError) => e.code === 'run_not_found');
  assert.throws(() => h.runOutput('r99-bogus'), (e: TermError) => e.code === 'run_not_found');
  // A second restart ends nothing twice and marks the restart once.
  const r3 = restart(r1);
  const events = hist(r3.reg.get('h')).journal.since(0).events;
  assert.equal(events.filter((e) => e.type === 'run.end' && e.runId === slow.runId).length, 1);
  assert.equal(events.filter((e) => e.type === 'recovered').length, 1);
  await cleanup(r3, r2, r1);
});

test('jr-8/tg-11/G20: recovery ends a Run that was starting (admitted, written, no pre-execution mark yet)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const sdir = path.join(dir, 'sessions', 'st');
  const j = new Journal({ cold: new FileStore(sdir), sessionId: 'st' });
  j.append({ type: 'integration', level: 'rich' });
  j.append({ type: 'run.admit', runId: 'r1-aaaaaa', target: 'shell', line: 'make', principal: A, origin: 'self', queued: false });
  j.close();
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }));
  const r = rig(dir);
  const x = hist(r.reg.get('st')).run('r1-aaaaaa');
  assert.deepEqual([x.state, x.reason, x.principal, x.line], ['lost', 'daemon-restart', A, 'make']);
  await cleanup(r);
});

test('jr-10: a closed session\'s late events never reach the journal, and a new life numbers on without duplicates', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'p', owner: A })).session;
  s.attach(A, 'c1');
  const a = s.admit({ target: 'process', line: 'devserver', principal: A });
  assert.ok(a.admitted);
  await new Promise((res) => setTimeout(res, 10));
  const proc = r.backend.processes[0] as ScriptedProcess;
  const kill = proc.kill.bind(proc);
  // On SIGINT the process exits promptly (so close returns and a new life can start), then emits a
  // straggler well after the reopen — the case jr-10 is about: the straggler must reach neither the
  // sealed journal nor the new life's (the house's read of the 36 commits, #22: the old emit landed
  // inside close's grace, before the reopen, so nothing arrived after it).
  let straggle: (() => void) | undefined;
  proc.kill = (sig) => {
    kill(sig);
    if (sig === 'SIGINT') {
      setTimeout(() => proc.exit({ exitCode: 0 }), 0);
      straggle = () => proc.emitStdout('shutting down\n');
    }
  };
  await r.reg.close('p');
  const h = hist(r.reg.get('p'));
  const atClose = h.lastSeq;
  const outcome = h.run(a.run.runId);
  assert.ok(['exited', 'cancelled', 'lost'].includes(outcome.state), `the Run is terminal in history: ${outcome.state}`);
  await r.reg.ensure({ id: 'p', owner: A });
  // Captured, or the test would pass with nothing emitted (the house's read of the 38 commits, PR #22, comment 6274857431).
  assert.ok(straggle, 'the process took the SIGINT and armed its straggler');
  straggle(); // the old life's process speaks after the reopen
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(h.lastSeq, atClose, 'nothing appended to the closed journal');
  const seqs = seqsOnDisk(path.join(r.dir, 'sessions/p'));
  assert.equal(new Set(seqs).size, seqs.length, `no duplicate seqs: ${seqs.join(',')}`);
  assert.ok(seqs.every((q, i) => i === 0 || q > seqs[i - 1]!), 'monotonic on disk');
  await cleanup(r);
});

test('api-15/G19: a live session whose shell exited is replaced for its owner; anyone else gets what is there', async () => {
  const r = rig();
  const old = (await r.reg.ensure({ id: 'x', owner: A, visibility: 'shared' })).session;
  const ran = await run(old, A, 'echo before-exit');
  r.backend.ptys[0]!.exit({ exitCode: 0 });
  assert.equal(old.state, 'exited');
  await rejectsWith(r.reg.create({ id: 'x', owner: B }), 'forbidden');
  const forB = await r.reg.ensure({ id: 'x', owner: B });
  assert.deepEqual([forB.created, forB.session === old], [false, true], 'a non-owner is not given a new life');
  const lastOld = old.journal.lastSeq;
  const forA = await r.reg.ensure({ id: 'x', owner: A });
  assert.equal(forA.created, true);
  assert.notEqual(forA.session, old);
  assert.equal(r.backend.ptys.length, 2);
  assert.ok(forA.session.journal.since(lastOld).events.length > 0 && forA.session.journal.since(lastOld).events[0]!.seq === lastOld + 1, 'seq continues');
  assert.equal(live(r.reg.get('x')).run(ran.runId).state, 'exited', 'the old life\'s run stays reachable');
  assert.deepEqual(r.changes.map((c) => c.type), ['created', 'closed', 'created']);
  await rejectsWith(r.reg.create({ id: 'x', owner: A }), 'session_exists');
  await cleanup(r);
});

test('G21: retention is explicit per session, recorded, reported, and kept by a new life', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'ret', owner: A, retention: { maxBytes: 128 * 1024, maxAgeMs: 3_600_000 } })).session;
  const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'sessions/ret/session.json'), 'utf8')) as { retention: unknown };
  assert.deepEqual(meta.retention, { maxBytes: 131072, maxAgeMs: 3_600_000 });
  const st = s.journal.stats();
  assert.deepEqual(st.retention, { maxBytes: 131072, maxAgeMs: 3_600_000, memoryBytes: 131072 });
  assert.equal(st.oldestSeq, 1);
  assert.equal(st.coldFailed, null);
  assert.deepEqual(live(r.reg.get('ret')).retention, { maxBytes: 131072, maxAgeMs: 3_600_000 });
  await rejectsWith(r.reg.ensure({ id: 'bad', owner: A, retention: { maxBytes: 10 } }), 'invalid_argument');
  await rejectsWith(r.reg.ensure({ id: 'bad', owner: A, retention: { maxAgeMs: -1 } }), 'invalid_argument');
  const d = (await r.reg.ensure({ id: 'dflt', owner: A })).session;
  // By default nothing is deleted: no byte or age limit, only the in-memory cache (G21).
  assert.deepEqual(d.journal.stats().retention, { maxBytes: null, maxAgeMs: null, memoryBytes: 8 * 1024 * 1024 });
  assert.deepEqual(live(r.reg.get(d.id)).retention, {});
  await r.reg.close('ret');
  assert.deepEqual(hist(r.reg.get('ret')).retention, { maxBytes: 131072, maxAgeMs: 3_600_000 });
  const again = (await r.reg.ensure({ id: 'ret', owner: A })).session;
  assert.equal(again.journal.stats().retention.maxBytes, 131072, 'a new life keeps the recorded retention');
  await cleanup(r);
});

test('sec-9/G26: the data layout is private: sessions 0700, session.json and journals 0600, fixed on recovery', async () => {
  const r = rig();
  await r.reg.ensure({ id: 'm', owner: A });
  const mode = (p: string) => fs.statSync(path.join(r.dir, p)).mode & 0o777;
  assert.equal(mode('sessions'), 0o700);
  assert.equal(mode('sessions/m'), 0o700);
  assert.equal(mode('sessions/m/session.json'), 0o600);
  assert.equal(mode('sessions/m/journal.jsonl'), 0o600);
  await r.reg.closeAll();
  for (const p of ['sessions', 'sessions/m']) fs.chmodSync(path.join(r.dir, p), 0o755);
  for (const p of ['sessions/m/session.json', 'sessions/m/journal.jsonl']) fs.chmodSync(path.join(r.dir, p), 0o644);
  const r2 = restart(r);
  assert.deepEqual(['sessions', 'sessions/m', 'sessions/m/session.json', 'sessions/m/journal.jsonl'].map(mode), [0o700, 0o700, 0o600, 0o600]);
  await cleanup(r2, r);
});

test('jr-2/G19: a session whose journal becomes unwritable stays alive and reports it', async () => {
  if (process.getuid?.() === 0) return; // root ignores modes
  const r = rig();
  // Small files, so the flood below needs a rotation, which a read-only directory refuses (EACCES on rename).
  const s = (await r.reg.ensure({ id: 'ro', owner: A, retention: { maxBytes: 16 * 1024 } })).session;
  const sdir = path.join(r.dir, 'sessions/ro');
  fs.chmodSync(sdir, 0o500);
  let ran;
  try {
    ran = await run(s, A, 'big 6000');
    assert.equal(ran.state, 'exited', 'the session kept working');
    assert.match(s.journal.stats().coldFailed ?? '', /EACCES|EPERM/);
    assert.equal(xs(live(r.reg.get('ro')).runOutput(ran.runId).events), 6000, 'served from the ring');
  } finally {
    fs.chmodSync(sdir, 0o700);
  }
  assert.equal(s.journal.retryCold(), true);
  assert.equal(s.journal.stats().coldFailed, null);
  await r.reg.closeAll();
  const r2 = restart(r);
  assert.equal(xs(hist(r2.reg.get('ro')).runOutput(ran.runId).events), 6000, 'nothing lost once the disk healed');
  await cleanup(r2, r);
});

test('closeAll passes the reason to Session.close and leaves every session readable', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'c1', owner: A })).session;
  const seen: unknown[] = [];
  const orig = s.close.bind(s);
  s.close = (o) => {
    seen.push(o);
    return orig(o);
  };
  await r.reg.closeAll({ reason: 'daemon-shutdown' });
  assert.equal((seen[0] as { reason?: string }).reason, 'daemon-shutdown');
  const h = hist(r.reg.get('c1'));
  assert.equal(h.closed, false, 'a shutdown is not the owner closing it');
  assert.ok(h.journal.since(0).events.length > 0);
  await cleanup(r);
});

test('G19: a new life that fails to start keeps the history, readable and owned', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'f', owner: A })).session;
  await run(s, A, 'echo keep-me');
  await r.reg.close('f');
  const spawn = r.backend.spawnShell.bind(r.backend);
  r.backend.spawnShell = () => {
    throw new Error('spawn failed');
  };
  await rejectsWith(r.reg.ensure({ id: 'f', owner: A }), 'Error: spawn failed');
  // A start that failed is not a life: the record keeps the last life's options and its closedAt,
  // not the attempt's (the house's read of 2c35df8, #22).
  await rejectsWith(r.reg.ensure({ id: 'f', owner: A, shell: '/bin/sh', cwd: os.homedir() }), 'Error: spawn failed');
  const record = JSON.parse(fs.readFileSync(path.join(r.dir, 'sessions', 'f', 'session.json'), 'utf8')) as { options: { shell: string; cwd: string }; closedAt?: number };
  assert.deepEqual([record.options.shell, record.options.cwd, typeof record.closedAt], ['/bin/bash', os.tmpdir(), 'number']);
  r.backend.spawnShell = spawn;
  const h = hist(r.reg.get('f'));
  assert.equal(h.owner, A);
  assert.deepEqual([h.options.shell, h.options.cwd, h.closed], ['/bin/bash', os.tmpdir(), true]);
  assert.match(text(h.journal.since(0).events), /keep-me/);
  await rejectsWith(r.reg.ensure({ id: 'f', owner: B }), 'forbidden');
  assert.equal((await r.reg.ensure({ id: 'f', owner: A })).created, true);
  assert.equal(r.backend.ptys[r.backend.ptys.length - 1]!.opts.shell, '/bin/bash', 'a plain reopen starts the shell the name had');
  await cleanup(r);
});

test('G18: a session whose record cannot be read is nobody\'s to reopen — not the system\'s — until it is repaired; its history stays readable', async () => {
  // Recovery read a damaged session.json as `{}` and made the system principal the owner, who could
  // start a new life on it while the real owner was refused (the house's read of 2c35df8, #22).
  const r = rig();
  const s = (await r.reg.ensure({ id: 'dmg', owner: A })).session;
  await run(s, A, 'echo keep-me');
  await r.reg.close('dmg');
  await r.reg.closeAll();
  const file = path.join(r.dir, 'sessions', 'dmg', 'session.json');
  fs.writeFileSync(file, '{');
  const warnings: string[] = [];
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: r.dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), log: (level, msg, fields) => void (level === 'warn' && warnings.push(`${msg} ${JSON.stringify(fields)}`)) });
  const r2: Rig = { dir: r.dir, backend, shells, reg, changes: [] };
  const h = hist(reg.get('dmg'));
  assert.equal(h.owner, 'unknown');
  assert.match(text(h.journal.since(0).events), /keep-me/);
  assert.ok(warnings.some((w) => /record \(session\.json\) cannot be read/.test(w) && /"session":"dmg"/.test(w)), JSON.stringify(warnings));
  for (const owner of [A, B, 'system']) {
    await rejectsWith(reg.ensure({ id: 'dmg', owner }), 'forbidden');
    await rejectsWith(reg.create({ id: 'dmg', owner }), 'forbidden');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{', 'the file is left for repair');
  await assert.rejects(reg.ensure({ id: 'dmg', owner: A }), /cannot be read/);
  // Repaired: the same daemon reads the record again at the next attempt, as the refusal promised — the
  // recorded owner reopens it, nobody else, with no restart (the house's read of cc8c909..39787b3, #22).
  fs.writeFileSync(file, JSON.stringify({ owner: A, visibility: 'private' }));
  await assert.rejects(reg.ensure({ id: 'dmg', owner: B }), /belongs to another principal/);
  assert.equal(hist(reg.get('dmg')).owner, A);
  assert.equal((await reg.ensure({ id: 'dmg', owner: A })).created, true);
  await reg.close('dmg');
  await reg.closeAll();
  const r3 = restart(r2);
  assert.equal(hist(r3.reg.get('dmg')).owner, A);
  await rejectsWith(r3.reg.ensure({ id: 'dmg', owner: B }), 'forbidden');
  assert.equal((await r3.reg.ensure({ id: 'dmg', owner: A })).created, true);
  await cleanup(r3, r2, r);
});

test('G18: a session whose record is missing beside its history is nobody\'s to reopen, and the refusal says the record is missing — not that the name is someone else\'s', async () => {
  // With session.json gone, recovery made the system principal the owner: the owner and everyone
  // else were refused as if the name belonged to another principal, and a caller acting as the
  // system could take it (the house's read of cc8c909..39787b3, #22).
  const r = rig();
  const s = (await r.reg.ensure({ id: 'norec', owner: A })).session;
  await run(s, A, 'echo keep-me');
  await r.reg.close('norec');
  await r.reg.closeAll();
  const file = path.join(r.dir, 'sessions', 'norec', 'session.json');
  fs.rmSync(file);
  const warnings: string[] = [];
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: r.dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), log: (level, msg, fields) => void (level === 'warn' && warnings.push(`${msg} ${JSON.stringify(fields)}`)) });
  const r2: Rig = { dir: r.dir, backend, shells, reg, changes: [] };
  const h = hist(reg.get('norec'));
  assert.equal(h.owner, 'unknown');
  assert.match(text(h.journal.since(0).events), /keep-me/);
  assert.ok(warnings.some((w) => /session\.json is missing/.test(w) && /"session":"norec"/.test(w)), JSON.stringify(warnings));
  const missing = (e: unknown) => e instanceof TermError && e.code === 'forbidden' && /session\.json is missing/.test(e.message) && !/another principal/.test(e.message);
  for (const owner of [A, B, 'system']) {
    await assert.rejects(reg.ensure({ id: 'norec', owner }), missing);
    await assert.rejects(reg.create({ id: 'norec', owner }), missing);
  }
  assert.equal(fs.existsSync(file), false, 'nothing is written in its place');
  // A record written there names the owner again: it reopens the session on the same daemon, nobody else.
  fs.writeFileSync(file, JSON.stringify({ owner: A, visibility: 'private' }));
  await assert.rejects(reg.ensure({ id: 'norec', owner: B }), /belongs to another principal/);
  assert.equal((await reg.ensure({ id: 'norec', owner: A })).created, true);
  await cleanup(r2, r);
});

test('G21: a reopen that fails to start prunes nothing — the history keeps the retention it had, on disk and in memory', async () => {
  // The store took the requested retention, and pruned to it, before the shell was spawned: a failed
  // reopen asking for less deleted rotated files the record still kept, and the entry reported the
  // retention it never got (the house's read of cc8c909..39787b3, #22).
  const r = rig();
  const s = (await r.reg.ensure({ id: 'keep', owner: A, retention: { maxBytes: 256 * 1024 } })).session;
  for (let i = 0; i < 20; i++) await run(s, A, 'big 16000');
  await r.reg.close('keep');
  const none = (await r.reg.ensure({ id: 'none', owner: A })).session;
  await run(none, A, 'echo kept');
  await r.reg.close('none');
  const sdir = path.join(r.dir, 'sessions', 'keep');
  const rotated = () => fs.readdirSync(sdir).filter((n) => /^journal\.\d+\.jsonl$/.test(n)).sort();
  const recorded = (id: string) => (JSON.parse(fs.readFileSync(path.join(r.dir, 'sessions', id, 'session.json'), 'utf8')) as { retention: unknown }).retention;
  const files = rotated();
  assert.ok(files.length >= 3, `rotated files under 256 KiB: ${JSON.stringify(files)}`);
  const spawn = r.backend.spawnShell.bind(r.backend);
  r.backend.spawnShell = () => {
    throw new Error('spawn failed');
  };
  await rejectsWith(r.reg.ensure({ id: 'keep', owner: A, retention: { maxBytes: 64 * 1024 } }), 'Error: spawn failed');
  assert.deepEqual(rotated(), files, 'the history is still there');
  assert.deepEqual(hist(r.reg.get('keep')).retention, { maxBytes: 262144 });
  assert.deepEqual(recorded('keep'), { maxBytes: 262144 });
  // A session with no limit, asked to take one: the same.
  await rejectsWith(r.reg.ensure({ id: 'none', owner: A, retention: { maxBytes: 1024 * 1024 } }), 'Error: spawn failed');
  assert.deepEqual(hist(r.reg.get('none')).retention, {});
  assert.deepEqual(recorded('none'), {});
  r.backend.spawnShell = spawn;
  // Started, the new life's retention applies.
  const again = (await r.reg.ensure({ id: 'keep', owner: A, retention: { maxBytes: 64 * 1024 } })).session;
  assert.ok(rotated().length < files.length, `pruned to 64 KiB: ${JSON.stringify(rotated())}`);
  assert.equal(again.journal.stats().retention.maxBytes, 65536);
  assert.deepEqual(recorded('keep'), { maxBytes: 65536 });
  await cleanup(r);
});

test('G21: a damaged record is recovered with retention off, so a repair brings back what the daemon default would have pruned, and the reread applies the record\'s retention (the house\'s read of the 36 commits, #22)', async () => {
  const r = rig();
  // 256 KiB cap forces rotation into several files; the record keeps that retention.
  const s = (await r.reg.ensure({ id: 'dr', owner: A, retention: { maxBytes: 256 * 1024 } })).session;
  for (let i = 0; i < 20; i++) await run(s, A, 'big 16000');
  await r.reg.close('dr');
  await r.reg.closeAll();
  const sdir = path.join(r.dir, 'sessions', 'dr');
  const rotated = () => fs.readdirSync(sdir).filter((n) => /^journal\.\d+\.jsonl$/.test(n)).sort();
  const before = rotated();
  assert.ok(before.length >= 3, `rotated files to prune: ${JSON.stringify(before)}`);
  // The record is damaged, and the daemon it restarts into carries a small default retention that would
  // prune at open. A damaged record must not be pruned by a default it did not ask for: the repair the
  // refusal invites could not then bring the history back.
  fs.writeFileSync(path.join(sdir, 'session.json'), '{');
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: r.dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), retention: { maxBytes: 64 * 1024 } });
  const r2: Rig = { dir: r.dir, backend, shells, reg, changes: [] };
  assert.equal(hist(reg.get('dr')).owner, 'unknown');
  assert.deepEqual(rotated(), before, 'nothing pruned while the record is unreadable');
  // Repaired without a per-session retention: the reread applies the daemon default — to the store too,
  // not only to what the entry reports — so the history is pruned to it now that the record reads.
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }));
  await rejectsWith(reg.ensure({ id: 'dr', owner: B }), 'forbidden'); // triggers the reread; B is refused
  assert.equal(hist(reg.get('dr')).owner, A);
  assert.deepEqual(hist(reg.get('dr')).retention, { maxBytes: 65536 }, 'the record read applies the retention');
  assert.ok(rotated().length < before.length, `and the store is pruned to it now: ${JSON.stringify(rotated())}`);
  await cleanup(r2, r);
});

test('G18: a brand-new name is owned from its first byte — its record is written before the start, so a daemon that dies mid-start leaves owned history, not an unknown owner (a reviewer\'s read of the fixes for #22 comment 6269992150)', async () => {
  const r = rig();
  const spawn = r.backend.spawnShell.bind(r.backend);
  r.backend.spawnShell = () => {
    throw new Error('spawn failed');
  };
  await rejectsWith(r.reg.ensure({ id: 'fresh', owner: A }), 'Error: spawn failed');
  // The record is on disk although the start never succeeded: whatever a dying daemon had journaled by
  // then would recover as A's, not as owner-unknown.
  const file = path.join(r.dir, 'sessions', 'fresh', 'session.json');
  assert.ok(fs.existsSync(file), 'the record was written before the start');
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { owner: string }).owner, A);
  r.backend.spawnShell = spawn;
  // The owner's next attempt starts the shell: the name is theirs.
  assert.equal((await r.reg.ensure({ id: 'fresh', owner: A })).created, true);
  await rejectsWith(r.reg.create({ id: 'fresh', owner: B }), 'session_exists');
  await cleanup(r);
});

test('the integration preserves the environment the shell starts with — the session\'s over the daemon\'s — not the daemon\'s own', async () => {
  // zsh's ZDOTDIR and fish's XDG_DATA_DIRS were read from the daemon's environment, so a session's
  // own value appeared nowhere in its shell (the house's read of 2c35df8, #22).
  const { backend, shells } = scripted();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), daemonEnv: { ...process.env, ZDOTDIR: '/daemon/zdotdir', XDG_DATA_DIRS: '/daemon/share' } });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  const spawned = () => backend.ptys[backend.ptys.length - 1]!.opts.env;
  await reg.ensure({ id: 'z1', owner: A, shell: '/bin/zsh', env: { ZDOTDIR: '/session/zdotdir' } });
  assert.equal(spawned().TSM_USER_ZDOTDIR, '/session/zdotdir');
  assert.notEqual(spawned().ZDOTDIR, '/session/zdotdir', 'ZDOTDIR itself names the shim; the shim restores the user\'s');
  await reg.ensure({ id: 'z2', owner: A, shell: '/bin/zsh' });
  assert.equal(spawned().TSM_USER_ZDOTDIR, '/daemon/zdotdir', 'without a session value the daemon\'s stands, as for every variable');
  await reg.ensure({ id: 'f1', owner: A, shell: '/usr/bin/fish', env: { XDG_DATA_DIRS: '/session/share' } });
  assert.equal(spawned().TSM_XDG_DATA_DIRS, '/session/share');
  assert.match(spawned().XDG_DATA_DIRS!, /:\/session\/share$/);
  await cleanup(r);
});

test('sessionOomScoreAdj reaches a shell started without integration through the backend, as it reaches one with it through its launcher', async () => {
  // With `integration: false` nothing set the shell's oom_score_adj: only the launcher did (the house's read of 2c35df8, #22).
  const { backend, shells } = scripted();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), sessionOomScoreAdj: 500 });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  const spawned = () => backend.ptys[backend.ptys.length - 1]!.opts;
  await reg.ensure({ id: 'plain', owner: A, integration: false });
  assert.deepEqual([spawned().oomScoreAdj, spawned().bootstrap], [500, undefined], 'no launcher: the backend sets it');
  await reg.ensure({ id: 'rich', owner: A });
  assert.deepEqual([spawned().oomScoreAdj, typeof spawned().bootstrap?.launcher], [500, 'string']);
  await cleanup(r);
});

test('jr-13/G21/G26: a history session whose newest event is past its maxAgeMs expires — at startup and by expire()', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'old', owner: A, retention: { maxAgeMs: 60_000 } })).session;
  await run(s, A, 'echo stale-secret');
  await r.reg.close('old');
  await r.reg.ensure({ id: 'alive', owner: A, retention: { maxAgeMs: 60_000 } });
  assert.deepEqual(await r.reg.expire(Date.now() + 10_000), [], 'nothing is past its age yet');
  assert.deepEqual(await r.reg.expire(Date.now() + 120_000), ['old'], 'a live session never expires');
  assert.equal(r.reg.get('old'), undefined);
  assert.equal(fs.existsSync(path.join(r.dir, 'sessions/old')), false);
  assert.ok(r.changes.some((c) => c.type === 'removed' && c.id === 'old'));
  live(r.reg.get('alive'));
  // At startup: a journal whose newest event is older than its retention is not recovered at all.
  const sdir = path.join(r.dir, 'sessions', 'ancient');
  const j = new Journal({ cold: new FileStore(sdir, { maxAgeMs: 60_000 }), now: () => Date.now() - 3_600_000 });
  j.append({ type: 'output', data: 'old news', stream: 'pty' });
  j.close();
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxAgeMs: 60_000 } }));
  await r.reg.closeAll();
  const r2 = restart(r);
  assert.equal(r2.reg.get('ancient'), undefined);
  assert.equal(fs.existsSync(sdir), false);
  hist(r2.reg.get('alive'));
  await cleanup(r2, r);
});

test('G19: one unreadable session directory does not keep the registry from starting', async () => {
  const r = rig();
  await r.reg.ensure({ id: 'fine', owner: A });
  await r.reg.closeAll();
  fs.mkdirSync(path.join(r.dir, 'sessions', 'weird', 'journal.jsonl'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'sessions', 'weird', 'journal.1.jsonl'), JSON.stringify({ type: 'cwd', path: '/', seq: 1, ts: Date.now() }) + '\n');
  const r2 = restart(r);
  hist(r2.reg.get('fine'));
  assert.equal(r2.reg.get('weird'), undefined);
  assert.deepEqual(r2.reg.recoveryErrors.map((e) => e.id), ['weird']);
  await cleanup(r2, r);
});

test('cursors written while their directory cannot be synced are logged once, not rewritten forever — the file holds them (the house\'s read of the 38 commits, PR #22, comment 6274603516, item 8)', async () => {
  const r = rig();
  const s = (await r.reg.ensure({ id: 'cur', owner: A })).session;
  await run(s, A, 'echo one');
  await r.reg.close('cur');
  await r.reg.closeAll();
  const warnings: string[] = [];
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: r.dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), log: (level, text) => void (level === 'warn' && warnings.push(text)) });
  const r2: Rig = { dir: r.dir, backend, shells, reg, changes: [] };
  const h = hist(reg.get('cur'));
  const file = path.join(r.dir, 'sessions', 'cur', 'cursors.json');
  const readOf = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { read: number }>)[A]!.read;
  const said = () => warnings.filter((w) => /cursors are written but their directory could not be synced/.test(w)).length;
  // The writes are counted while the directory fsync fails throughout: counted by warnings, with the EIO
  // lasting one dispose each, the test passed with a flush that rescheduled itself after every unsynced
  // write (the house's read of the 33 commits, PR #22, comment 6307350477, item 8).
  await renamesInto('cursors.json', (writes) =>
    withDirFsyncEIO(() => {
      // dispose() flushes the cursors; the directory fsync fails after the rename.
      h.markRead(A, 5);
      reg.dispose();
      assert.equal([readOf(), writes()].join(), '5,1', 'the file holds the cursors: they were written once');
      assert.equal(said(), 1, 'the sync failure is logged');
      // Nothing changed: an unsynced write left nothing to write again, at a flush or a timer's.
      reg.dispose();
      reg.dispose();
      assert.equal(writes(), 1, 'nothing is rewritten while the directory still cannot be synced');
      h.markRead(A, 6);
      reg.dispose();
      assert.equal([readOf(), writes()].join(), '6,2', 'a later change is still written, once');
      assert.equal(said(), 1, 'and the failure is said once');
    }),
  );
  await cleanup(r2, r);
});

test('G18/G20: a new life\'s record that cannot be written before its start does not keep the session from starting, and the record is written once it has (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 9)', async () => {
  const warnings: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), log: (level, text) => void (level === 'warn' && warnings.push(text)) });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  await reg.ensure({ id: 'pre', owner: A, visibility: 'shared' });
  await reg.close('pre');
  const file = path.join(dir, 'sessions', 'pre', 'session.json');
  // Only the first write, the one before the start, is refused.
  let attempts = 0;
  await renamesInto('session.json', () => reg.ensure({ id: 'pre', owner: A, visibility: 'private' }), () => attempts++ === 0);
  live(reg.get('pre'));
  assert.equal(attempts, 2, 'the record was tried before the start and after it');
  assert.ok(warnings.some((w) => w.startsWith("the new life's record could not be written before its start") && w.includes('EIO')), JSON.stringify(warnings));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { visibility: string; closedAt?: number };
  assert.deepEqual([rec.visibility, rec.closedAt], ['private', undefined], 'started, the record is the new life\'s');
  await cleanup(r);
});

test('G18/G20: a failed start whose old record cannot be written back still fails with the start\'s own error, and the entry is the old life\'s (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 9)', async () => {
  const warnings: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), log: (level, text) => void (level === 'warn' && warnings.push(text)) });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  await reg.ensure({ id: 'back', owner: A, visibility: 'shared' });
  await reg.close('back');
  const file = path.join(dir, 'sessions', 'back', 'session.json');
  // The record before the start is written; the start fails, and from then on the disk refuses the record.
  let refusing = false;
  const spawn = backend.spawnShell.bind(backend);
  backend.spawnShell = () => {
    refusing = true;
    throw new Error('spawn failed');
  };
  await renamesInto('session.json', () => rejectsWith(reg.ensure({ id: 'back', owner: A, visibility: 'private' }), 'Error: spawn failed'), () => refusing);
  backend.spawnShell = spawn;
  assert.ok(warnings.some((w) => w.startsWith('a new life failed to start and the old record could not be written back') && w.includes('EIO')), JSON.stringify(warnings));
  assert.deepEqual([hist(reg.get('back')).visibility, hist(reg.get('back')).closed], ['shared', true], 'in memory, the entry is the old life\'s');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { visibility: string; closedAt?: number };
  assert.deepEqual([rec.visibility, rec.closedAt], ['private', undefined], 'on disk, what the refused write-back left: the attempt\'s record');
  await cleanup(r);
});

test('G18/G10: a refused open of a journal recovery did not surface leaves its files byte for byte as they were — the journal is opened only once the open is allowed (the house\'s read of the 33 commits, PR #22, comment 6307350477; an independent read of the fix)', async () => {
  // A journal opened over these files writes: the gap for the reservation it honours, when it opens, and its
  // reservation, when it closes. The refused opens below wrote both into a journal they did not own.
  const r = rig();
  const files = (sdir: string) => Object.fromEntries(fs.readdirSync(sdir).filter((n) => n.startsWith('journal')).sort().map((n) => [n, fs.readFileSync(path.join(sdir, n)).toString('base64')]));
  /** A crash on another boot: the reservation a block ahead stands, and a journal opened over it records the hole. */
  const crashed = (sdir: string, meta: Record<string, unknown>) => fs.writeFileSync(path.join(sdir, 'journal.meta.json'), JSON.stringify({ v: 1, ...meta, reserved: 20_000, boot: 'another-boot' }) + '\n', { mode: 0o600 });
  // One with lines that survived, and one whose every line a power loss took: both are A's history.
  const withLines = path.join(r.dir, 'sessions', 'held');
  const j = new Journal({ cold: new FileStore(withLines), sessionId: 'held' });
  j.append({ type: 'output', data: 'private\r\n', stream: 'pty' });
  j.close();
  crashed(withLines, { epoch: (JSON.parse(fs.readFileSync(path.join(withLines, 'journal.meta.json'), 'utf8')) as { epoch: string }).epoch });
  const linesLost = path.join(r.dir, 'sessions', 'lost');
  fs.mkdirSync(linesLost, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(linesLost, 'journal.jsonl'), '', { mode: 0o600 });
  crashed(linesLost, { epoch: 'd'.repeat(16) });
  // And one whose rotated files are past the age its record keeps: a store applies the retention it is given
  // at once, so an open refused for another owner pruned them when it opened the store with the record's.
  const agedDir = path.join(r.dir, 'sessions', 'aged');
  const old = Date.now() - 3_600_000;
  const k = new Journal({ cold: new FileStore(agedDir, { maxFileBytes: 4096, now: () => old }), sessionId: 'aged', now: () => old });
  for (let i = 0; i < 60; i++) k.append({ type: 'output', data: 'x'.repeat(200), stream: 'pty' });
  k.close();
  const rotated = () => fs.readdirSync(agedDir).filter((n) => /^journal\.\d+\.jsonl$/.test(n));
  assert.ok(rotated().length >= 2, `rotated files: ${JSON.stringify(rotated())}`);
  const keeps = { maxAgeMs: 60_000 };
  for (const [id, sdir, retention] of [['held', withLines, undefined], ['lost', linesLost, undefined], ['aged', agedDir, keeps]] as const) {
    const before = files(sdir);
    const record = path.join(sdir, 'session.json');
    fs.writeFileSync(record, JSON.stringify({ owner: A, visibility: 'private', ...(retention && { retention }) }), { mode: 0o600 });
    await rejectsWith(r.reg.create({ id, owner: B }), 'forbidden');
    assert.deepEqual(files(sdir), before, `${id}: another principal's refused open`);
    fs.writeFileSync(record, '{');
    await assert.rejects(r.reg.create({ id, owner: A }), /cannot be read/);
    assert.deepEqual(files(sdir), before, `${id}: an unreadable record's refused open`);
    fs.rmSync(record);
    await assert.rejects(r.reg.create({ id, owner: A }), /has history but no record/);
    assert.deepEqual(files(sdir), before, `${id}: a missing record's refused open`);
    assert.equal(r.reg.get(id), undefined);
  }
  // Allowed, the owner's open is the journal's first write: the hole goes on record then.
  fs.writeFileSync(path.join(linesLost, 'session.json'), JSON.stringify({ owner: A, visibility: 'private' }), { mode: 0o600 });
  const s = await r.reg.create({ id: 'lost', owner: A });
  assert.ok(s.journal.since(0).events.some((e) => e.type === 'gap' && e.from === 1 && e.to === 20_000), 'the owner\'s life records the lost seqs');
  // And the record's retention applies once the open is allowed: the aged files go then.
  fs.writeFileSync(path.join(agedDir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: keeps }), { mode: 0o600 });
  await r.reg.create({ id: 'aged', owner: A });
  assert.deepEqual(rotated(), [], 'the owner\'s open pruned what its record does not keep');
  await cleanup(r);
});

test('G18: a journal recovery did not surface that holds only a rotation header naming an open Run is history its owner stands on — another principal is refused, and its record is untouched (the house\'s read of the 33 commits, PR #22, comment 6307350477, item 6)', async () => {
  // The registry is already running, so recovery never surfaced this directory; age retention can leave just the header.
  const r = rig();
  const sdir = path.join(r.dir, 'sessions', 'hdronly');
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  const openRun = { runId: 'r1-header', sessionId: 'hdronly', target: 'shell', origin: 'self', principal: A, state: 'running', admittedAt: Date.now(), seq: { admit: 1, start: 2 }, attribution: 'temporal', line: 'echo private-line' };
  fs.writeFileSync(path.join(sdir, 'journal.jsonl'), JSON.stringify({ header: { v: 1, openRuns: [openRun] } }) + '\n', { mode: 0o600 });
  const record = JSON.stringify({ owner: A, visibility: 'private' });
  fs.writeFileSync(path.join(sdir, 'session.json'), record, { mode: 0o600 });
  await rejectsWith(r.reg.create({ id: 'hdronly', owner: B }), 'forbidden');
  assert.equal(r.reg.get('hdronly'), undefined, 'no life of it for B');
  assert.equal(fs.readFileSync(path.join(sdir, 'session.json'), 'utf8'), record, 'the record still names its owner');
  // With no record beside it, the owner is not known: nobody's.
  fs.rmSync(path.join(sdir, 'session.json'));
  await assert.rejects(r.reg.create({ id: 'hdronly', owner: B }), /has history but no record/);
  assert.equal(fs.existsSync(path.join(sdir, 'session.json')), false, 'and no record was written for B');
  await cleanup(r);
});

test('a session record written while its directory cannot be synced is said once per name, like the cursors and the lock, not at every write (a reviewer\'s read of the fixes for #22, comment 6274603516)', async () => {
  const warnings: string[] = [];
  const { backend, shells } = scripted();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), log: (level, text, fields) => void (level === 'warn' && warnings.push(`${String(fields?.['session'])}: ${text}`)) });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  const real = fsc.fsyncSync;
  fsc.fsyncSync = ((fd: number) => {
    if (fsc.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    return real(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    // A new name's record before its start; its closedAt at the close; a new life's record before and after its start.
    await reg.ensure({ id: 'rec', owner: A });
    await reg.close('rec');
    await reg.ensure({ id: 'rec', owner: A });
    await reg.ensure({ id: 'other', owner: A });
  } finally {
    fsc.fsyncSync = real;
    syncBuiltinESMExports();
  }
  const said = (id: string) => warnings.filter((w) => w.startsWith(`${id}: the session record is written but its directory could not be synced: EIO`)).length;
  assert.equal(said('rec'), 1, JSON.stringify(warnings));
  assert.equal(said('other'), 1, 'once per name');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'rec', 'session.json'), 'utf8')).owner, A, 'the record stands');
  await cleanup(r);
});

test('G18/G20: while a reopen starts, the record on disk is the new life\'s under the old retention; a failed start puts the old record back, and a start that succeeds takes the new retention (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 6)', async () => {
  // The old record stayed on disk until the start succeeded: a daemon that died mid-start left the old
  // life's visibility and closedAt beside the new life's journal, and recovery read the running life as the old.
  const r = rig();
  const s = (await r.reg.ensure({ id: 'mid', owner: A, visibility: 'shared', retention: { maxBytes: 256 * 1024 } })).session;
  await run(s, A, 'echo old-life');
  await r.reg.close('mid');
  type Rec = { owner: string; visibility: string; closedAt?: number; retention?: unknown };
  const file = path.join(r.dir, 'sessions', 'mid', 'session.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Rec;
  const old = read();
  assert.deepEqual([old.visibility, typeof old.closedAt, old.retention], ['shared', 'number', { maxBytes: 262144 }]);
  const spawn = r.backend.spawnShell.bind(r.backend);
  const seen: Rec[] = []; // the record at each spawn: what a daemon that died there would leave
  r.backend.spawnShell = () => {
    seen.push(read());
    throw new Error('spawn failed');
  };
  const reopen = { id: 'mid', owner: A, visibility: 'private' as const, retention: { maxBytes: 512 * 1024 } };
  await rejectsWith(r.reg.ensure(reopen), 'Error: spawn failed');
  assert.equal(seen.length, 1, 'the start reached the spawn');
  assert.deepEqual([seen[0]!.owner, seen[0]!.visibility, seen[0]!.closedAt, seen[0]!.retention], [A, 'private', undefined, { maxBytes: 262144 }], 'mid-start: the new life\'s record, under the old retention');
  assert.deepEqual(read(), old, 'the failed start put the old record back');
  assert.deepEqual([hist(r.reg.get('mid')).visibility, hist(r.reg.get('mid')).closed], ['shared', true], 'and the entry is the old one');
  r.backend.spawnShell = (...args: Parameters<typeof spawn>) => {
    seen.push(read());
    return spawn(...args);
  };
  await r.reg.ensure(reopen);
  assert.deepEqual([seen[1]?.visibility, seen[1]?.closedAt, seen[1]?.retention], ['private', undefined, { maxBytes: 262144 }], 'mid-start again');
  const now = read();
  assert.deepEqual([now.visibility, now.closedAt, now.retention], ['private', undefined, { maxBytes: 524288 }], 'started: the new retention');
  await cleanup(r);
});

test('G21: a refused open of a journal the registry did not surface prunes nothing — its store opens without retention until a record reads (the house\'s read of the 38 commits, PR #22, comment 6274857431, item 7)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir(), retention: { maxAgeMs: 1000 } });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  // Written after the registry started, so recovery never surfaced it, with rotated files old enough for the
  // daemon's default age to drop, and a record that cannot be read.
  const sdir = path.join(dir, 'sessions', 'late');
  const old = Date.now() - 60_000;
  const j = new Journal({ cold: new FileStore(sdir, { maxFileBytes: 4096, now: () => old }), sessionId: 'late', now: () => old });
  for (let i = 0; i < 60; i++) j.append({ type: 'output', data: 'x'.repeat(200), stream: 'pty' });
  j.close();
  fs.writeFileSync(path.join(sdir, 'session.json'), '{');
  const rotated = () => fs.readdirSync(sdir).filter((n) => /^journal\.\d+\.jsonl$/.test(n)).sort();
  const files = rotated();
  assert.ok(files.length >= 2, `rotated files: ${JSON.stringify(files)}`);
  await assert.rejects(reg.create({ id: 'late', owner: A }), /cannot be read/);
  assert.deepEqual(rotated(), files, 'the refused open pruned nothing a repaired record would keep');
  await cleanup(r);
});

test('ux-4/G21: a journal recovery did not surface, reopened by its owner, keeps the retention its record gives it, and the new record says it (our read of the house\'s fixes for its review of f3750e4, PR #22)', async () => {
  // The open of a name with no slot took the daemon's defaults, and the new record dropped the old one's retention.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-registry-'));
  const { backend, shells } = scripted();
  const reg = new SessionRegistry({ dataDir: dir, backend, defaultShell: '/bin/bash', noUserRc: true, defaultCwd: os.tmpdir() });
  const r: Rig = { dir, backend, shells, reg, changes: [] };
  const sdir = path.join(dir, 'sessions', 'late');
  const j = new Journal({ cold: new FileStore(sdir), sessionId: 'late' });
  j.append({ type: 'output', data: 'kept\r\n', stream: 'pty' });
  j.close();
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: A, visibility: 'private', retention: { maxBytes: 262144 } }), { mode: 0o600 });
  const s = (await reg.ensure({ id: 'late', owner: A })).session;
  assert.deepEqual(live(reg.get('late')).retention, { maxBytes: 262144 });
  assert.equal(s.journal.stats().retention.maxBytes, 262144, 'the store applies it');
  assert.deepEqual((JSON.parse(fs.readFileSync(path.join(sdir, 'session.json'), 'utf8')) as { retention: unknown }).retention, { maxBytes: 262144 });
  await cleanup(r);
});

test('G18: a record that is valid JSON but names no owner is refused as a damaged one is — for the system principal too (the house\'s read of the 38 commits, PR #22, comment 6274857431)', async () => {
  // With that refusal removed no spec broke: `{"visibility":"private"}` made the system the owner.
  const r = rig();
  const s = (await r.reg.ensure({ id: 'noown', owner: A })).session;
  await run(s, A, 'echo keep-me');
  await r.reg.closeAll();
  fs.writeFileSync(path.join(r.dir, 'sessions', 'noown', 'session.json'), JSON.stringify({ visibility: 'private' }));
  const r2 = restart(r);
  assert.equal(hist(r2.reg.get('noown')).owner, 'unknown');
  for (const owner of [A, 'system']) await assert.rejects(r2.reg.ensure({ id: 'noown', owner }), /names no owner/, `refused for ${owner}`);
  await cleanup(r2, r);
});

test('a Run the closing session could not end gets the session’s duration, on the monotonic clock, across a wall-clock step back', async (t) => {
  // A reviewer's read of the fixes for #22: the session-closed end took `now - startedAt` on the wall clock, a third rule
  // beside the session's monotonic one. A process that ignores every signal outlives the close, so the registry ends its Run.
  const realNow = Date.now;
  const realMono = clocks.monotonic;
  let wallStep = 0;
  let monoStep = 0;
  Date.now = () => realNow() + wallStep;
  clocks.monotonic = () => realMono() + monoStep;
  t.after(() => {
    Date.now = realNow;
    clocks.monotonic = realMono;
  });
  const r = rig();
  try {
    const s = (await r.reg.ensure({ id: 'dur', owner: A })).session;
    s.attach(A, 'c1');
    const a = s.admit({ target: 'process', line: 'stubborn', principal: A });
    assert.ok(a.admitted);
    await until(() => s.run(a.run.runId).state === 'running', 2000, 'the Run to start');
    wallStep -= 3000;
    monoStep += 2500;
    await r.reg.close('dur');
    const end = hist(r.reg.get('dur')).journal.since(0).events.find((e): e is Extract<JournalEvent, { type: 'run.end' }> => e.type === 'run.end' && e.runId === a.run.runId)!;
    assert.equal(end.reason, 'session-closed');
    assert.ok(end.durationMs >= 2500, `the session's monotonic measure: ${end.durationMs} ms`);
  } finally {
    await cleanup(r);
  }
});
