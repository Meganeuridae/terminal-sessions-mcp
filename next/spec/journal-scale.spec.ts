/**
 * Scale (jr-14, sec-8): a 200 MB journal is recovered by streaming it once for
 * Run lifecycle events, never by loading it; reads on the recovered history are
 * bounded by the range they ask for. Timings and memory are printed as
 * diagnostics and asserted with wide margins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry, type HistorySession } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import type { JournalEvent } from '../src/core/types.js';

const MB = 1024 * 1024;

/** Write a session dir holding `total` bytes of journal in 16 MiB files, with one long Run left open. */
function generate(dir: string, total: number): { lastSeq: number } {
  const sdir = path.join(dir, 'sessions', 'big');
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sdir, 'session.json'), JSON.stringify({ owner: 'agent:a@test', visibility: 'private', retention: { maxBytes: 256 * MB } }), { mode: 0o600 });
  const ts = Date.now();
  const payload = 'y'.repeat(4000);
  let seq = 0;
  let file = 1;
  let written = 0;
  let fd = fs.openSync(path.join(sdir, `journal.${file}.jsonl`), 'w', 0o600);
  let inFile = 0;
  let batch = '';
  const flush = () => {
    fs.writeSync(fd, batch);
    batch = '';
  };
  const emit = (ev: Record<string, unknown>) => {
    const line = JSON.stringify({ ...ev, seq: ++seq, ts }) + '\n';
    if (inFile + line.length > 16 * MB) {
      flush();
      fs.closeSync(fd);
      file++;
      fd = fs.openSync(path.join(sdir, `journal.${file}.jsonl`), 'w', 0o600);
      inFile = 0;
    }
    batch += line;
    inFile += line.length;
    written += line.length;
    if (batch.length > MB) flush();
  };
  emit({ type: 'run.admit', runId: 'r1-flood0', target: 'process', line: 'make flood', principal: 'agent:a@test', origin: 'self', queued: false });
  emit({ type: 'run.start', runId: 'r1-flood0', cwd: '/w', line: 'make flood', envBasis: 'configured' });
  while (written < total) emit({ type: 'output', data: payload, stream: 'stdout', runId: 'r1-flood0', attribution: 'exact' });
  emit({ type: 'run.admit', runId: 'r2-small0', target: 'shell', line: 'echo tail', principal: 'agent:a@test', origin: 'self', queued: false });
  emit({ type: 'run.start', runId: 'r2-small0', cwd: '/w', line: 'echo tail' });
  emit({ type: 'output', data: 'tail\r\n', stream: 'pty', runId: 'r2-small0', attribution: 'temporal' });
  emit({ type: 'run.end', runId: 'r2-small0', state: 'exited', exit: 0, durationMs: 3 });
  flush();
  fs.closeSync(fd);
  // The newest file is the active one.
  fs.renameSync(path.join(sdir, `journal.${file}.jsonl`), path.join(sdir, 'journal.jsonl'));
  return { lastSeq: seq };
}

test('jr-14/sec-8: a 200 MB journal recovers by streaming, and history reads stay bounded', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-scale-'));
  try {
    const { lastSeq } = generate(dir, 200 * MB);
    const onDisk = fs.readdirSync(path.join(dir, 'sessions/big')).reduce((a, n) => a + fs.statSync(path.join(dir, 'sessions/big', n)).size, 0);
    assert.ok(onDisk > 200 * MB);
    (globalThis as { gc?: () => void }).gc?.();
    const rss0 = process.memoryUsage().rss;
    const peak0 = process.resourceUsage().maxRSS * 1024;
    const t0 = performance.now();
    const reg = new SessionRegistry({ dataDir: dir, backend: new ScriptedBackend() });
    const recoverMs = performance.now() - t0;
    const peakGrowth = Math.max(0, process.resourceUsage().maxRSS * 1024 - Math.max(peak0, rss0));
    const h = reg.get('big') as HistorySession;
    assert.ok(h && h.kind === 'history');
    assert.equal(h.lastSeq, lastSeq + 2, 'the flood Run ended lost, and the restart marked');
    assert.deepEqual([h.run('r1-flood0').state, h.run('r1-flood0').reason], ['lost', 'daemon-restart']);
    assert.equal(h.run('r2-small0').exit, 0);

    let t = performance.now();
    const tail = h.journal.tail(10);
    const tailMs = performance.now() - t;
    assert.equal(tail[tail.length - 1]!.seq, h.lastSeq);
    t = performance.now();
    const recent = h.journal.since(h.lastSeq - 100);
    const sinceMs = performance.now() - t;
    assert.equal(recent.events.length, 100);
    t = performance.now();
    const small = h.runOutput('r2-small0');
    const runMs = performance.now() - t;
    assert.equal(small.events.map((e) => (e as Extract<JournalEvent, { type: 'output' }>).data).join(''), 'tail\r\n');
    t = performance.now();
    const floodTail = h.runOutput('r1-flood0', { maxBytes: 16 * 1024 });
    const floodMs = performance.now() - t;
    const floodBytes = floodTail.events.reduce((a, e) => a + (e as Extract<JournalEvent, { type: 'output' }>).data.length, 0);
    // At most the budget, in whole events (4000 bytes each here), newest first (narrowOutput's rule).
    assert.ok(floodTail.truncated && floodBytes <= 16 * 1024 && floodBytes > 16 * 1024 - 4000, `flood tail ${floodBytes} bytes`);
    assert.equal(floodTail.events[floodTail.events.length - 1]!.seq, lastSeq - 4, 'ends at the Run\'s last output');
    t = performance.now();
    const page = h.journal.since(0, 50);
    const headMs = performance.now() - t;
    assert.deepEqual([page.events.length, page.more], [50, true]);

    console.log(
      `# 200 MB recovery: ${recoverMs.toFixed(0)} ms, peak RSS growth ${(peakGrowth / MB).toFixed(0)} MB; ` +
        `tail(10) ${tailMs.toFixed(1)} ms, since(last-100) ${sinceMs.toFixed(1)} ms, runOutput(small) ${runMs.toFixed(1)} ms, runOutput(flood, 16 KB) ${floodMs.toFixed(1)} ms, since(0, 50) ${headMs.toFixed(1)} ms`,
    );
    // Loading the journal would cost several times its size in memory, and seconds.
    assert.ok(peakGrowth < 150 * MB, `peak RSS grew ${(peakGrowth / MB).toFixed(0)} MB during recovery`);
    assert.ok(recoverMs < 10_000, `recovery took ${recoverMs.toFixed(0)} ms`);
    for (const [what, ms] of [['tail', tailMs], ['since', sinceMs], ['runOutput', runMs], ['runOutput(flood)', floodMs], ['since(0, 50)', headMs]] as const) {
      assert.ok(ms < 1000, `${what} took ${ms.toFixed(0)} ms`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
