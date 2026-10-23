/**
 * The MCPL lane's round-2 contract, end to end over the real endpoint against
 * real bash (one daemon per test): completions are held for a synchronous call
 * and released if it never returns them (G28), survive a close and a daemon
 * restart (G20, G22), are found however far behind the cursor is, carry ids that
 * never repeat, arrive once, and a first connection is not flooded. Notes are
 * bounded and visible to others; human input stays on open channels; a channel
 * opened on an ended shell starts nothing; a malformed or reduced grant binds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { CORE_TOOLS } from '../src/api/tools.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import type { Journal } from '../src/core/journal.js';
import type { SegmenterOptions } from '../src/core/segmenter.js';
import { seqOfMessageId } from '../src/core/segmenter.js';
import type { Session } from '../src/core/session.js';
import { Outbound, type Message } from '../src/transport/jsonrpc.js';
import { FEATURE_SETS, manifest, McplLane, NODE_NAME, summaryFloor } from '../src/transport/mcpl.js';
import { TermServer } from '../src/transport/server.js';
import { FULL_GRANT, TestHost, sleep, until, type Delivery, type Msg } from './testhost.js';

const A = 'agent:a@test';
const B = 'agent:b@test';

const aboutRun = (runId: unknown) => (d: Delivery) => d.metadata.runId === runId && d.tags.some((t) => t === 'terminal:run-finished' || t === 'terminal:run-lost');

async function daemon(o: { dataDir?: string; segmenter?: SegmenterOptions; retention?: { maxBytes?: number; maxAgeMs?: number } } = {}) {
  const dataDir = o.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lane-'));
  const registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true, ...(o.retention && { retention: o.retention }) });
  const app = new App({ registry, defaultWaitMs: 5000, segmenter: o.segmenter ?? { runSettleMs: 30, cadenceMs: 400, needsInputMs: 700 } });
  const logs: string[] = [];
  const server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { ta: A, tb: B, th: 'human:test:9' } }), host: '127.0.0.1', port: 0, version: 'lane-spec', log: (line) => logs.push(line) });
  const port = (await server.listen()).port;
  const host = (token: string, connection: string, extra: Partial<ConstructorParameters<typeof TestHost>[0]> = {}) => new TestHost({ port, token, connection, mcpl: true, ...extra }).connect();
  const stop = async (s: { keep?: boolean; reason?: string } = {}) => {
    const closing = server.close();
    await registry.closeAll(s.reason !== undefined ? { reason: s.reason } : {});
    await closing;
    if (!s.keep) fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, registry, app, server, port, host, stop, logs };
}

function live(registry: SessionRegistry, id: string): Session {
  const e = registry.get(id);
  assert.ok(e?.kind === 'live', `${id} is live`);
  return e.session;
}

for (const via of ['push', 'channel'] as const) {
  for (const recovery of ['retry', 'reconnect'] as const) {
    test(`G22: refused ${via} completion survives later acceptance and ${recovery}`, async () => {
      const d = await daemon();
      let allow = false;
      let refused: string | undefined;
      let attempts = 0;
      const accept = (id: string, tags: string[]) => {
        if (!tags.includes('terminal:run-finished')) return true;
        refused ??= id;
        if (id !== refused) return true;
        attempts++;
        return allow;
      };
      try {
        const a = await d.host('ta', 'refusal', { answer: (m) => {
          if (m.method === 'push/event') {
            const p = m.params as { eventId: string; tags: string[] };
            return { accepted: accept(p.eventId, p.tags), reason: 'queue_full' };
          }
          if (m.method === 'channels/incoming') {
            const p = m.params as { messages: Array<{ messageId: string; tags: string[] }> };
            return { results: p.messages.map((v) => ({ messageId: v.messageId, accepted: accept(v.messageId, v.tags), reason: 'queue_full' })) };
          }
          return undefined;
        } });
        await a.call('session_open', { session: 'refusal' });
        if (via === 'channel') await a.request('channels/open', { channelId: 'terminal:refusal' });
        const first = await a.call('run', { session: 'refusal', command: 'sleep 0.15; echo first', wait: 0 });
        const firstId = first.structured!.runId as string;
        const got = await a.delivery(aboutRun(firstId));
        assert.equal(got.via, via === 'channel' ? 'incoming' : 'push');
        const second = await a.call('run', { session: 'refusal', command: 'sleep 0.15; echo second', wait: 0 });
        await a.delivery(aboutRun(second.structured!.runId));
        await until(() => attempts >= 2, 3000, 'a retry with the same stable id');
        assert.ok(d.logs.some((l) => /refused/.test(l) && /queue_full/.test(l) && l.includes(got.messageId)), `a log line names the refusal, its reason and the message: ${d.logs.filter((l) => /refus/.test(l))}`);
        const s = live(d.registry, 'refusal');
        assert.ok(s.cursorsOf(A).delivered < s.run(firstId).seq.end!, 'later acceptance cannot skip the rejected outcome');
        assert.equal(new Set(a.deliveries().filter(aboutRun(firstId)).map((v) => v.messageId)).size, 1);
        if (recovery === 'retry') {
          allow = true;
          await until(() => s.cursorsOf(A).delivered >= s.run(second.structured!.runId as string).seq.end!, 5000, 'retry acceptance to release the cursor');
        } else {
          await a.close();
          const b = await d.host('ta', 'refusal-reconnect');
          const replay = await b.delivery(aboutRun(firstId));
          assert.equal(replay.messageId, got.messageId);
          await b.close();
        }
        await a.close();
      } finally { await d.stop(); }
    });
  }
}

test('G22: channel RPC errors and omitted per-message receipts both retry the same completion', async () => {
  const d = await daemon();
  let attempts = 0;
  let a: TestHost;
  try {
    a = await d.host('ta', 'receipt-errors', { answer: (m) => {
      if (m.method !== 'channels/incoming') return undefined;
      const p = m.params as { messages: Array<{ tags: string[] }> };
      if (!p.messages.some((v) => v.tags.includes('terminal:run-finished'))) return undefined;
      attempts++;
      if (attempts === 1) {
        queueMicrotask(() => a.respondError(m, -32000, 'temporary overload'));
        return new Promise(() => undefined);
      }
      if (attempts === 2) return { results: [] };
      return undefined;
    } });
    await a.call('session_open', { session: 'receipt-errors' });
    await a.request('channels/open', { channelId: 'terminal:receipt-errors' });
    const run = await a.call('run', { session: 'receipt-errors', command: 'sleep 0.15; echo receipt-test', wait: 0 });
    const id = run.structured!.runId as string;
    const s = live(d.registry, 'receipt-errors');
    await until(() => attempts >= 3 && s.cursorsOf(A).delivered >= s.run(id).seq.end!, 6000);
    assert.equal(new Set(a.deliveries().filter(aboutRun(id)).map((v) => v.messageId)).size, 1);
    await a.close();
  } finally { await d.stop(); }
});

for (const tracked of [false, true]) {
  for (const recovery of ['retry', 'reconnect'] as const) {
    test(`G22: a refused catch-up summary preserves every covered outcome (${tracked ? 'existing lane' : 'new lane'}, ${recovery})`, async () => {
      const d = await daemon();
      let allowSummary = false;
      const answer = (m: Msg) => {
        if (m.method === 'push/event' && (m.params as { tags: string[] }).tags.includes('terminal:missed')) {
          return { accepted: allowSummary, reason: 'queue_full' };
        }
        return undefined;
      };
      try {
        let a = await d.host('ta', 'summary-create', { mcpl: tracked, answer });
        await a.call('session_open', { session: 'summary-gap' });
        if (tracked) await a.request('featureSets/update', { effectiveCapabilities: ['tools'] });
        const ids: string[] = [];
        for (let i = 0; i < 30; i++) {
          const r = await a.call('run', { session: 'summary-gap', command: `echo summary-${i}`, target: 'process', wait: 0 });
          ids.push(r.structured!.runId as string);
        }
        const s = live(d.registry, 'summary-gap');
        await until(() => ids.every((id) => s.run(id).state === 'exited'), 8000);
        await sleep(200); // no pending live segment may stand in for catch-up
        if (tracked) await a.request('featureSets/update', { effectiveCapabilities: FULL_GRANT });
        else {
          await a.close();
          a = await d.host('ta', 'summary-catch-up', { answer });
        }
        const summary = await a.delivery((v) => v.tags.includes('terminal:missed'));
        await until(() => a.deliveries().filter((v) => ids.includes(v.metadata.runId as string)).length >= 20);
        await sleep(100); // let the accepted newer messages advance the cursor
        const ends = ids.map((id) => s.run(id).seq.end!);
        assert.ok(s.cursorsOf(A).delivered < Math.min(...ends), 'a rejected summary must pin before its oldest outcome');
        if (recovery === 'retry') {
          allowSummary = true;
          await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 5000, 'summary acceptance to settle all covered outcomes');
          assert.equal(new Set(a.deliveries().filter((v) => v.tags.includes('terminal:missed')).map((v) => v.messageId)).size, 1);
        } else {
          await a.close();
          a = await d.host('ta', 'summary-reconnect');
          const replay = await a.delivery((v) => v.tags.includes('terminal:missed'));
          assert.equal(replay.messageId, summary.messageId);
          assert.equal(replay.metadata.count, summary.metadata.count, 'all omitted outcomes remain represented');
          await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 5000);
        }
        await a.close();
      } finally { await d.stop(); }
    });
  }
}

test('mcpl-1: a completion held for a synchronous wait that never returned it goes out when the hold runs out; one it returned is settled, not sent', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'l1');
    await a.call('session_open', { session: 'l1' });
    const s = live(d.registry, 'l1');
    const r = await a.call('run', { session: 'l1', command: 'sleep 0.4; echo orphaned-result', wait: 20 });
    const runId = r.structured?.runId as string;
    // A synchronous wait of this principal is in flight at run.end — and its result never reaches the host.
    await s.awaitRun(runId, 20_000, A);
    const ended = Date.now();
    const got = await a.delivery(aboutRun(runId), 5000);
    assert.ok(Date.now() - ended >= 1000, 'held while the call could still return it');
    assert.match(got.text, /orphaned-result/);
    await until(() => s.cursorsOf(A).delivered >= s.run(runId).seq.end!, 2000, 'delivered to pass the accepted completion');

    const r2 = await a.call('run', { session: 'l1', command: 'sleep 0.4; echo returned-result', wait: 20 });
    const id2 = r2.structured?.runId as string;
    // This time the call's result goes out (the tool layer records it once written, G28).
    void s.awaitRun(id2, 20_000, A).then(() => setTimeout(() => s.markOutcomeDelivered(id2, A), 400));
    await a.noDelivery(aboutRun(id2), 3500, 'for an outcome the synchronous call returned');
    assert.ok(s.cursorsOf(A).delivered >= s.run(id2).seq.end!, 'the delivered cursor passes it: it reached the principal');
    await a.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-2/m2-4: after a daemon restart a Run lost at the restart is delivered with one recovery message; the session is a channel with history', { timeout: 30_000 }, async () => {
  const d1 = await daemon();
  let d2: Awaited<ReturnType<typeof daemon>> | undefined;
  try {
    const a = await d1.host('ta', 'rs-a');
    await a.call('session_open', { session: 'rs' });
    const r = await a.call('run', { session: 'rs', command: 'sleep 60', wait: 200 });
    assert.equal(r.structured?.state, 'running');
    const runId = r.structured?.runId;
    await d1.stop({ keep: true, reason: 'daemon-shutdown' });
    d2 = await daemon({ dataDir: d1.dataDir });
    assert.equal(d2.registry.get('rs')?.kind, 'history');
    const a2 = await d2.host('ta', 'rs-a2');
    const lost = await a2.delivery(aboutRun(runId), 5000);
    assert.equal(lost.via, 'push');
    assert.ok(lost.tags.includes('terminal:run-lost'), `${lost.tags}`);
    assert.match(lost.text, /`sleep 60` → outcome unknown \(daemon-shutdown\)/);
    const rec = await a2.delivery((x) => x.tags.includes('terminal:recovered=history-only'), 3000);
    assert.ok(rec.tags.includes('terminal:session-exited') && rec.tags.includes('terminal:recovered'), `${rec.tags}`);
    assert.match(rec.text, /daemon restarted/);
    await sleep(300);
    assert.equal(a2.deliveries().filter((x) => x.tags.includes('terminal:session-exited')).length, 1, 'the shell exit is part of the recovery, not a second message');
    const reg = await a2.message('channels/register', 3000);
    assert.ok((reg.params as { channels: Array<{ id: string }> }).channels.some((c) => c.id === 'terminal:rs'), 'a history-only session is a channel');
    const opened = (await a2.request('channels/open', { channelId: 'terminal:rs', history: { limit: 10 } })) as { history?: Array<{ content: Array<{ text: string }> }> };
    assert.ok(opened.history?.some((m) => /sleep 60/.test(m.content[0]!.text)), 'and its history is served');
    await a2.close();
    const a3 = await d2.host('ta', 'rs-a3');
    await a3.noDelivery(() => true, 800, 'after a second reconnect to the same daemon');
    await a3.close();
  } finally {
    await (d2 ?? d1).stop();
  }
});

test('mcpl-3: catch-up finds a completion more than 50,000 events past a lagging cursor', { timeout: 60_000 }, async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'big-a');
    await a.call('session_open', { session: 'big' });
    const r = await a.call('run', { session: 'big', command: 'sleep 1.5; echo big-done', wait: 20 });
    const runId = r.structured?.runId as string;
    await a.close();
    const s = live(d.registry, 'big');
    for (let i = 0; i < 55_000; i++) s.journal.append({ type: 'note', text: 'n', principal: 'system' });
    await until(() => s.run(runId).state === 'exited', 8000, 'the run to end');
    await sleep(500); // past the settle: only catch-up can deliver it now
    const a2 = await d.host('ta', 'big-a2');
    const got = await a2.delivery(aboutRun(runId), 10_000);
    assert.match(got.text, /big-done/);
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-4: message ids carry the node and the journal epoch; a forgotten name opened again never repeats one', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'fg-a');
    const ids: string[] = [];
    for (let life = 0; life < 2; life++) {
      await a.call('session_open', { session: 'fg' });
      const r = await a.call('run', { session: 'fg', command: 'sleep 0.2; echo life', wait: 20 });
      ids.push((await a.delivery(aboutRun(r.structured?.runId), 4000)).messageId);
      await a.call('session_close', { session: 'fg', forget: true });
    }
    const epochs = ids.map((id) => /^[^/]+\/fg~([^:]+):run:\d+$/.exec(id)?.[1]);
    assert.ok(epochs[0] && epochs[1], `ids: ${ids}`);
    assert.notEqual(epochs[0], epochs[1], 'a forgotten name’s successor has a new epoch');
    for (const id of ids) assert.ok(id.startsWith(`${NODE_NAME}/`), id);
    if (!process.env.TSM_NODE && os.hostname()) assert.notEqual(NODE_NAME, 'local');
    await a.close();
  } finally {
    await d.stop();
  }
});

test("mcpl-5: notes are small, rate-limited and never more than a share of retention; an observer cannot evict the owner's history", async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'nb-a');
    await a.call('session_open', { session: 'nb', visibility: 'shared', retention: { maxBytes: 64 * 1024 } });
    const r = await a.call('run', { session: 'nb', command: 'echo owner-history' });
    const b = await d.host('tb', 'nb-b');
    const pub = (session: string, text: string) => b.request('channels/publish', { channelId: `terminal:${session}`, content: [{ type: 'text', text }] });
    await assert.rejects(pub('nb', 'x'.repeat(5000)), (e: { code: number }) => e.code === -32602, 'over 4 KiB is refused');
    // 1/16 of 64 KiB: 4 KiB of notes at a time, as the store writes them (about 1,100 bytes for a 1,000-byte text).
    for (let i = 0; i < 3; i++) await pub('nb', 'y'.repeat(1000));
    await assert.rejects(pub('nb', 'y'.repeat(1000)), (e: { code: number; message: string }) => e.code === -32050 && /1\/16 of its retention/.test(e.message));
    const rd = await a.call('read', { session: 'nb', runId: r.structured?.runId });
    assert.match(rd.text, /owner-history/);
    assert.doesNotMatch(rd.text, / · (\d+ )?gaps? /, 'no hole: the owner’s history was not evicted');
    await a.call('session_open', { session: 'nr', visibility: 'shared' });
    const burst = await Promise.allSettled(Array.from({ length: 7 }, () => pub('nr', 'hi')));
    assert.equal(burst.filter((x) => x.status === 'fulfilled').length, 5, 'a burst of five');
    assert.ok(burst.some((x) => x.status === 'rejected' && (x.reason as { code: number }).code === -32050 && /a second/.test((x.reason as Error).message)));
    await a.close();
    await b.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-6: session_close delivers the completions of the Runs it cut short, to the owner and to an observer with the channel open', async () => {
  const d = await daemon({ segmenter: { runSettleMs: 400, cadenceMs: 10_000, needsInputMs: 5000 } });
  try {
    const a = await d.host('ta', 'cl-a');
    await a.call('session_open', { session: 'cl', visibility: 'shared' });
    const b = await d.host('tb', 'cl-b');
    await b.request('channels/open', { channelId: 'terminal:cl' });
    const r = await a.call('run', { session: 'cl', command: 'sleep 30', wait: 300 });
    assert.equal(r.structured?.state, 'running');
    await a.call('session_close', { session: 'cl' });
    const mine = await a.delivery(aboutRun(r.structured?.runId), 3000);
    assert.equal(mine.via, 'push');
    assert.ok(mine.tags.includes('terminal:run-lost'));
    const seen = await b.delivery(aboutRun(r.structured?.runId), 3000);
    assert.equal(seen.via, 'incoming');
    await a.close();
    await b.close();
  } finally {
    await d.stop();
  }
});

test("mcpl-7: after a close cut a Run short, the name's next life delivers each completion once and a reconnect replays none", async () => {
  const d = await daemon({ segmenter: { runSettleMs: 400, cadenceMs: 10_000, needsInputMs: 5000 } });
  try {
    const a = await d.host('ta', 'nl-a');
    await a.call('session_open', { session: 'nl' });
    const r = await a.call('run', { session: 'nl', command: 'sleep 30', wait: 200 });
    await a.call('session_close', { session: 'nl' });
    await a.delivery(aboutRun(r.structured?.runId), 3000);
    const later: string[] = [];
    for (let i = 0; i < 3; i++) {
      const x = await a.call('run', { session: 'nl', command: `sleep 0.2; echo bg-${i}`, wait: 20 });
      later.push(x.structured?.runId as string);
      await a.delivery(aboutRun(x.structured?.runId), 4000);
    }
    const s = live(d.registry, 'nl');
    await until(() => s.cursorsOf(A).delivered >= s.run(later[2]!).seq.end!, 3000, 'delivered not pinned by the earlier life');
    await a.close();
    const a2 = await d.host('ta', 'nl-a2');
    await a2.noDelivery((x) => later.includes(x.metadata.runId as string) || x.metadata.runId === r.structured?.runId || x.tags.includes('terminal:session-exited'), 1000, 'already accepted');
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('G22: a connection that cannot carry a completion (no pushEvents, channel closed) leaves it owed for one that can', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'np-a', { grant: ['tools', 'channels.register', 'channels.lifecycle', 'channels.incoming'] });
    await a.call('session_open', { session: 'np' });
    const r = await a.call('run', { session: 'np', command: 'sleep 0.3; echo owed-later', wait: 20 });
    await a.call('run', { session: 'np', command: 'echo more-activity' });
    await sleep(600);
    assert.equal(a.deliveries().filter(aboutRun(r.structured?.runId)).length, 0, 'nothing to carry it on');
    await a.close();
    const a2 = await d.host('ta', 'np-a2');
    const got = await a2.delivery(aboutRun(r.structured?.runId), 4000);
    assert.match(got.text, /owed-later/);
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('a completion refused once, whose channel closed during the retry delay, is delivered when the channel reopens (no grant update needed)', async () => {
  const d = await daemon();
  try {
    let refuse = 1;
    const a = await d.host('ta', 'ro-a', {
      grant: ['tools', 'channels.register', 'channels.lifecycle', 'channels.incoming'],
      // The host refuses the first incoming that carries the completion, as a busy host does.
      answer: (m) => {
        if (m.method !== 'channels/incoming') return undefined;
        const msgs = (m.params as { messages: Array<{ messageId: string; content: Array<{ text: string }> }> }).messages;
        if (refuse > 0 && msgs.some((x) => x.content.some((c) => /refused-then-reopened/.test(c.text)))) {
          refuse--;
          return { results: msgs.map((x) => ({ messageId: x.messageId, accepted: false, reason: 'busy' })) };
        }
        return undefined;
      },
    });
    await a.call('session_open', { session: 'ro' });
    await a.request('channels/open', { channelId: 'terminal:ro' });
    const r = await a.call('run', { session: 'ro', command: 'sleep 0.3; echo refused-then-reopened', wait: 20 });
    const runId = r.structured?.runId as string;
    await until(() => refuse === 0, 4000, 'the first delivery, refused');
    // The channel closes before the retry fires; the retry then finds nothing to carry the message on.
    await a.request('channels/close', { channelId: 'terminal:ro' });
    await sleep(900);
    assert.equal(a.deliveries().filter(aboutRun(runId)).filter((x) => x.via === 'incoming').length, 1, 'only the refused attempt so far');
    await a.request('channels/open', { channelId: 'terminal:ro' });
    await until(() => a.deliveries().filter(aboutRun(runId)).length >= 2, 4000, 'the completion delivered again, on the reopened channel');
    const got = a.deliveries().filter(aboutRun(runId)).at(-1)!;
    assert.equal(got.via, 'incoming');
    assert.match(got.text, /refused-then-reopened/);
    await a.close();
  } finally {
    await d.stop();
  }
});

test('two channels reopened together both resume refused completions', async () => {
  const d = await daemon();
  try {
    let refusing = true;
    const refused = new Set<string>();
    const a = await d.host('ta', 'reopen-two', {
      grant: ['tools', 'channels.register', 'channels.lifecycle', 'channels.incoming'],
      answer: (m) => {
        if (m.method !== 'channels/incoming' || !refusing) return undefined;
        const msgs = (m.params as { messages: Array<{ messageId: string; tags: string[] }> }).messages;
        return { results: msgs.map((x) => {
          const completion = x.tags.includes('terminal:run-finished');
          if (completion) refused.add(x.messageId);
          return { messageId: x.messageId, accepted: !completion, ...(completion && { reason: 'busy' }) };
        }) };
      },
    });
    const sessions = ['reopen-one', 'reopen-two'];
    for (const session of sessions) {
      await a.call('session_open', { session });
      await a.request('channels/open', { channelId: `terminal:${session}` });
    }
    const runs = await Promise.all(sessions.map((session) => a.call('run', { session, command: 'sleep 0.3; echo finished', wait: 20 })));
    await until(() => refused.size === 2, 4000, 'both initial completions refused');
    await Promise.all(sessions.map((session) => a.request('channels/close', { channelId: `terminal:${session}` })));
    await sleep(900);
    refusing = false;
    await Promise.all(sessions.map((session) => a.request('channels/open', { channelId: `terminal:${session}` })));
    await until(() => runs.every((r) => a.deliveries().filter(aboutRun(r.structured?.runId)).length >= 2), 4000, 'both reopened channels to deliver');
    for (let i = 0; i < sessions.length; i++) {
      const session = live(d.registry, sessions[i]!);
      const id = runs[i]!.structured!.runId as string;
      await until(() => session.cursorsOf(A).delivered >= session.run(id).seq.end!, 2000, 'accepted completion settles its debt');
    }
    await a.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-8: a reconnect inside the completion settle window delivers the completion once', async () => {
  const d = await daemon({ segmenter: { runSettleMs: 600, cadenceMs: 10_000, needsInputMs: 5000 } });
  try {
    const a = await d.host('ta', 'st-a');
    await a.call('session_open', { session: 'st' });
    const r = await a.call('run', { session: 'st', command: 'sleep 0.3; echo settle', wait: 20 });
    const runId = r.structured?.runId as string;
    const s = live(d.registry, 'st');
    await until(() => s.run(runId).state === 'exited', 3000, 'the run to end');
    a.ws.terminate();
    const a2 = await d.host('ta', 'st-a2');
    await sleep(1500);
    assert.equal(a2.deliveries().filter(aboutRun(runId)).length, 1);
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-9: opening the channel of a session whose shell exited serves its history and starts no shell', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'ex-a');
    await a.call('session_open', { session: 'ex' });
    const s = live(d.registry, 'ex');
    const pid = s.pid;
    await a.call('input', { session: 'ex', text: 'exit 3', keys: ['Enter'] });
    await until(() => s.exit !== undefined, 5000, 'the shell to exit');
    await a.close();
    const a2 = await d.host('ta', 'ex-a2');
    const opened = (await a2.request('channels/open', { channelId: 'terminal:ex', history: { limit: 5 } })) as { history?: Array<{ content: Array<{ text: string }> }> };
    const e = d.registry.get('ex');
    assert.ok(e?.kind === 'live' && e.session === s && e.session.exit?.exitCode === 3, 'still the exited shell');
    assert.equal(e.session.pid, pid);
    assert.ok(opened.history?.some((m) => /exited with code 3/.test(m.content[0]!.text)), JSON.stringify(opened.history));
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-10: a new life started while the host is slow to acknowledge the close stays followed', async () => {
  const d = await daemon();
  try {
    const slow = (m: Msg) => (m.method === 'channels/incoming' ? sleep(1500).then(() => TestHost.accept(m)) : undefined);
    const a = await d.host('ta', 'sl-a', { answer: slow });
    await a.call('session_open', { session: 'sl' });
    await a.request('channels/open', { channelId: 'terminal:sl' });
    await a.call('session_close', { session: 'sl' });
    await a.call('run', { session: 'sl', command: 'sleep 0.3; echo new-life', wait: 20 }); // a new life at once
    await sleep(2500);
    const later = await a.call('run', { session: 'sl', command: 'sleep 0.3; echo later', wait: 20 });
    await a.delivery(aboutRun(later.structured?.runId), 5000);
    await a.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-13 (lane half): a service status the start result carried is not pushed again; one it never returned is, after the hold', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'sv-a');
    await a.call('session_open', { session: 'sv' });
    const s = live(d.registry, 'sv');
    const start = () => a.call('start', { session: 'sv', command: "sh -c 'echo listening; sleep 5'", target: 'process', ready: { pattern: 'listening' }, wait: 5000 });
    const st = await start();
    assert.equal(st.structured?.service, 'ready', st.text);
    const runId = st.structured?.runId as string;
    // The start tool records the status event its result carried once the result is on the wire (onSent): that event, not every later `ready`.
    const readySeq = d.app.extras(s).services.get(runId)!.info().seq;
    assert.equal(s.outcomeDeliveredTo(`${runId}:service=ready@${readySeq}`, A), true);
    await a.noDelivery((x) => x.metadata.runId === runId && x.tags.includes('terminal:service-ready'), 3000, 'after a start that returned ready');
    // A status the start never returned is pushed.
    await a.call('cancel', { runId });
    const got = await a.delivery((x) => x.metadata.runId === runId && x.tags.includes('terminal:service-exited'), 5000);
    assert.equal(got.via, 'push');
    await a.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-14: a note reaches other principals with the channel open, never its author; publish says whether anyone could see it', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'nt-a');
    await a.call('session_open', { session: 'nt', visibility: 'shared' });
    await a.request('channels/open', { channelId: 'terminal:nt' });
    const b = await d.host('tb', 'nt-b');
    await b.request('channels/open', { channelId: 'terminal:nt' });
    const pub = (text: string) => b.request('channels/publish', { channelId: 'terminal:nt', content: [{ type: 'text', text }] }) as Promise<{ delivered: boolean }>;
    assert.equal((await pub('please do not deploy')).delivered, true);
    const got = await a.delivery((x) => x.tags.includes('terminal:note'), 3000);
    assert.equal(got.via, 'incoming');
    assert.match(got.text, /note from agent:b@test: please do not deploy/);
    assert.ok(got.tags.includes('chat:from-agent'), `${got.tags}`);
    await b.noDelivery((x) => x.tags.includes('terminal:note'), 400, 'to its author');
    await a.request('channels/close', { channelId: 'terminal:nt' });
    assert.equal((await pub('second note')).delivered, true, 'recorded, even with nobody watching');
    await a.noDelivery((x) => /second note/.test(x.text), 400, 'on a closed channel (notes are ambient)');
    await a.close();
    await b.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-15: human input reaches open channels only, once per burst, tagged chat:from-human once', async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'hi-a');
    const h = await d.host('th', 'hi-h', { mcpl: false, profile: 'full' });
    await a.call('session_open', { session: 'hi', visibility: 'shared', control: 'open' });
    const r = await a.call('run', { session: 'hi', command: 'cat', wait: 300 });
    await a.call('input', { session: 'hi', text: '', keys: ['C-u'] });
    const s = live(d.registry, 'hi');
    s.releaseControl(A);
    const took = await h.call('control', { session: 'hi', action: 'take' });
    assert.equal(took.isError, undefined, took.text);
    await h.call('input', { session: 'hi', text: 'hello from the human\n' });
    await a.noDelivery((x) => x.tags.includes('terminal:human-input'), 1200, 'to the owner with its channel closed');
    await a.request('channels/open', { channelId: 'terminal:hi' });
    await h.call('input', { session: 'hi', text: 'second line\n' });
    const got = await a.delivery((x) => x.tags.includes('terminal:human-input'), 3000);
    assert.equal(got.via, 'incoming');
    assert.match(got.text, /human:test:9 typed: second line$/);
    assert.equal(got.tags.filter((t) => t === 'chat:from-human').length, 1, `${got.tags}`);
    await sleep(500);
    assert.equal(a.deliveries().filter((x) => x.tags.includes('terminal:human-input')).length, 1);
    await a.call('cancel', { runId: r.structured?.runId });
    await a.close();
    await h.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-16: a malformed policy after a grant that denied tools keeps them closed (no pre-policy core)', async () => {
  const d = await daemon();
  try {
    const bad = await d.host('ta', 'fs16', { grant: ['pushEvents'] });
    assert.equal(((await bad.request('tools/list')) as { tools: unknown[] }).tools.length, 0);
    await assert.rejects(bad.request('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: ['pushEvents'] }), (e: { code: number }) => e.code === -32602);
    assert.equal(((await bad.request('tools/list')) as { tools: unknown[] }).tools.length, 0, 'still closed');
    const call = await bad.call('session_list', {});
    assert.equal(call.isError, true, call.text);
    await bad.close();
  } finally {
    await d.stop();
  }
});

test("mcpl-18: a closed session's channel has history, pages before a message, and a new life's history includes the earlier life's Runs", async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'hs-a');
    await a.call('session_open', { session: 'hs' });
    await a.call('run', { session: 'hs', command: 'echo first-life' });
    await a.call('session_close', { session: 'hs' });
    type Opened = { channel: { capabilities: { history: { supportsBeforeMessage: boolean } } }; history?: Array<{ messageId: string; content: Array<{ text: string }> }> };
    const closed = (await a.request('channels/open', { channelId: 'terminal:hs', history: { limit: 10 } })) as Opened;
    assert.equal(closed.channel.capabilities.history.supportsBeforeMessage, true);
    const texts = (o: Opened) => (o.history ?? []).map((m) => m.content[0]!.text.split('\n')[0]!);
    assert.ok(texts(closed).some((t) => /echo first-life/.test(t)), JSON.stringify(texts(closed)));
    assert.ok(texts(closed).some((t) => /the shell (exited|was ended)/.test(t)));
    await a.request('channels/close', { channelId: 'terminal:hs' });
    await a.call('run', { session: 'hs', command: 'echo second-life' }); // a new life
    const both = (await a.request('channels/open', { channelId: 'terminal:hs', history: { limit: 10 } })) as Opened;
    const t2 = texts(both);
    assert.ok(t2.some((t) => /echo first-life/.test(t)) && t2.some((t) => /echo second-life/.test(t)), JSON.stringify(t2));
    const second = both.history!.find((m) => /echo second-life/.test(m.content[0]!.text))!;
    await a.request('channels/close', { channelId: 'terminal:hs' });
    const before = (await a.request('channels/open', { channelId: 'terminal:hs', history: { limit: 10, beforeMessageId: second.messageId } })) as Opened;
    const t3 = texts(before);
    assert.ok(t3.some((t) => /echo first-life/.test(t)) && !t3.some((t) => /echo second-life/.test(t)), JSON.stringify(t3));
    // The ids carry the journal's epoch (<node>/<session>~<epoch>:<kind>:<seq>); a boundary that is not one of
    // ours is refused, not read as no boundary (the house's read of 07ab3dd, #22: it answered with the newest page).
    assert.match(second.messageId, new RegExp(`^${NODE_NAME}/hs~[^:/]+:run:\\d+$`), second.messageId);
    await a.request('channels/close', { channelId: 'terminal:hs' });
    await assert.rejects(
      a.request('channels/open', { channelId: 'terminal:hs', history: { limit: 10, beforeMessageId: `${NODE_NAME}/hs:run:5` } }),
      (e: Error & { code?: number }) => e.code === -32602 && /beforeMessageId/.test(e.message),
    );
    await a.close();
  } finally {
    await d.stop();
  }
});

test('mcpl-19: a message queued for an open channel is not sent as channels/incoming after a reduction revoked it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lane-'));
  const registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, segmenter: { runSettleMs: 10 } });
  const sent: Message[] = [];
  const out: Outbound = new Outbound((m) => {
    sent.push(m);
    const req = m as Msg;
    if (req.method !== undefined && req.id !== undefined) setImmediate(() => out.handleResponse({ jsonrpc: '2.0', id: req.id!, result: TestHost.accept(req) } as never));
  });
  const lane = new McplLane(app, { principal: A, connectionId: 'c19' }, out, () => undefined);
  try {
    await app.sessionOpen({ principal: A, connectionId: 'c19' }, { id: 'rd', visibility: 'shared' });
    const ctx = { isRequest: true, after: (fn: () => void) => fn() };
    await lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, ctx);
    await lane.handle('channels/open', { channelId: 'terminal:rd' }, ctx);
    await sleep(100);
    const s = live(registry, 'rd');
    // The control: the same append, with the grant intact, goes out as channels/incoming; without it the
    // revocation case passed when nothing was ever queued (the house's read of 78c4d6e, #22).
    const controls = () => sent.filter((m) => (m as Msg).method === 'channels/incoming').flatMap((m) => ((m as Msg).params as { messages: Array<{ tags: string[] }> }).messages).filter((x) => x.tags.includes('terminal:control'));
    s.journal.append({ type: 'control', controller: null, by: A, how: 'release' });
    await until(() => controls().length === 1, 2000, 'the seat change on channels/incoming');
    s.journal.append({ type: 'control', controller: null, by: A, how: 'release' });
    // Revoke channels.incoming while its message waits in the batch.
    lane.updatePolicy({ effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'channels.incoming') }, 'request');
    const mark = sent.length;
    await sleep(200);
    const after = sent.slice(mark).filter((m) => (m as Msg).method === 'channels/incoming');
    assert.equal(after.length, 0, 'nothing on channels/incoming after the reduction');
    assert.equal(controls().length, 1, 'the revoked message never went');
  } finally {
    lane.dispose();
    await registry.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ux-25: a first connection after plain-MCP use gets the completion it is owed, not a superseded exit or a returned outcome; too much owed is capped with one summary', { timeout: 30_000 }, async () => {
  const d = await daemon();
  try {
    const m = await d.host('ta', 'ux-m', { mcpl: false });
    await m.call('session_open', { session: 'ux' });
    await m.call('session_close', { session: 'ux' });
    const bg = await m.call('run', { session: 'ux', command: 'sleep 0.2; echo done-bg', wait: 20 }); // a new life
    await m.call('run', { session: 'ux', command: 'echo done-sync' });
    await sleep(400);
    await m.close();
    const a = await d.host('ta', 'ux-a');
    await a.delivery(aboutRun(bg.structured?.runId), 4000);
    await a.noDelivery((x) => x.tags.includes('terminal:session-exited'), 800, 'an exit a later life superseded');
    await a.noDelivery((x) => /done-sync/.test(x.text), 10, 'a completion its synchronous call returned');
    await a.close();

    const m2 = await d.host('ta', 'ux-m2', { mcpl: false });
    await m2.call('session_open', { session: 'ux2' });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push((await m2.call('run', { session: 'ux2', command: `echo n${i}`, target: 'process', wait: 0 })).structured?.runId as string);
    const s = live(d.registry, 'ux2');
    await until(() => ids.every((id) => s.run(id).state === 'exited'), 8000, 'the runs to end');
    await m2.close();
    const a2 = await d.host('ta', 'ux-a2');
    await sleep(1500);
    const about = a2.deliveries().filter((x) => ids.includes(x.metadata.runId as string));
    assert.equal(about.length, 20, 'at most twenty messages');
    // The newest completions: concurrent process Runs can end out of the order they started in.
    const newest = [...ids].sort((x, y) => s.run(x).seq.end! - s.run(y).seq.end!).slice(10);
    assert.deepEqual(about.map((x) => x.metadata.runId).sort(), newest.sort(), 'the newest ones');
    const summary = a2.deliveries().filter((x) => x.tags.includes('terminal:missed'));
    assert.equal(summary.length, 1);
    assert.match(summary[0]!.text, /^\[terminal\] ux2: 10 earlier messages while you were away not replayed \(10 completions\) · seq \d+–\d+ · read session=ux2 since=\d+ as=events$/);
    await a2.close();
    const a3 = await d.host('ta', 'ux-a3');
    await a3.noDelivery(() => true, 800, 'the summary settled what it covered');
    await a3.close();
  } finally {
    await d.stop();
  }
});

test('a catch-up that begins inside a retention gap tells the host the range it will never see (the segmenter\'s read, comment 6265082050)', { timeout: 30_000 }, async () => {
  // The scan reported the range as `lost`, but the catch-up built its work from the picked and omitted
  // messages alone: a host whose cursor lay inside the gap heard nothing of what was gone.
  const d = await daemon({ retention: { maxBytes: 16 * 1024 } });
  try {
    const m = await d.host('ta', 'rg-m', { mcpl: false });
    await m.call('session_open', { session: 'rg' });
    for (let i = 0; i < 4; i++) await m.call('run', { session: 'rg', command: 'seq 1 2000' });
    const bg = await m.call('run', { session: 'rg', command: 'sleep 0.3; echo done-rg', wait: 20 });
    const s = live(d.registry, 'rg');
    await until(() => s.run(bg.structured?.runId as string).state === 'exited', 8000, 'the run to end');
    await m.close();
    const oldest = s.journal.oldestSeq ?? 1;
    assert.ok(oldest > 1, `retention took the start of the journal (oldest seq ${oldest})`);
    const a = await d.host('ta', 'rg-a');
    const missed = await a.delivery((x) => x.tags.includes('terminal:missed'), 6000);
    assert.match(missed.text, /^\[terminal\] rg: seq 1–\d+ \(past retention\) gone, with whatever happened then · read session=rg since=\d+ as=events$/);
    const { lostFrom, lostTo } = missed.metadata as { lostFrom: number; lostTo: number };
    assert.equal(lostFrom, 1);
    // Retention moves on between the first look and the scan (the new host's own attach events evict
    // older ones under the byte cap), so the gone range ends at or past the first look and before
    // whatever is oldest now; a slow runner saw it reach the whole journal.
    const oldestNow = s.journal.oldestSeq ?? Number.POSITIVE_INFINITY;
    assert.ok(lostTo >= oldest - 1 && lostTo < oldestNow, `${JSON.stringify(missed.metadata)} (oldest ${oldest} at the first look, ${oldestNow} now)`);
    assert.equal(missed.metadata.count, 0, 'nothing was omitted: the summary is about the gap alone');
    await a.delivery(aboutRun(bg.structured?.runId), 6000);
    await a.close();
    // Accepted, the summary settles: the next connection is not told again.
    const a2 = await d.host('ta', 'rg-a2');
    await a2.noDelivery((x) => x.tags.includes('terminal:missed'), 800, 'the summary was accepted');
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('m2-18: a needs-input that fired while the host was away is caught up on reconnect', async () => {
  const d = await daemon({ segmenter: { runSettleMs: 30, cadenceMs: 10_000, needsInputMs: 500 } });
  try {
    const a = await d.host('ta', 'ni-a');
    await a.call('session_open', { session: 'ni' });
    const q = await a.call('run', { session: 'ni', command: "read -p 'Overwrite config? [y/N] ' ans; echo got-$ans", wait: 50 });
    await a.close();
    const s = live(d.registry, 'ni');
    await until(() => s.journal.since(0).events.some((e) => e.type === 'run.waiting'), 4000, 'needs-input to be journaled');
    const a2 = await d.host('ta', 'ni-a2');
    const ask = await a2.delivery((x) => x.tags.includes('terminal:needs-input'), 4000);
    assert.equal(ask.via, 'push');
    assert.match(ask.text, /Overwrite config\? \[y\/N\]/);
    await a2.call('input', { session: 'ni', text: 'y', keys: ['Enter'] });
    const done = await a2.delivery(aboutRun(q.structured?.runId), 4000);
    assert.match(done.text, /got-y/);
    await a2.close();
  } finally {
    await d.stop();
  }
});

test('MCPL 4: channels/close needs channels.lifecycle, as channels/open does; with it, close answers whether the channel was open', async () => {
  const d = await daemon();
  try {
    const without = await d.host('ta', 'cl-a', { grant: ['tools', 'pushEvents', 'channels.register', 'channels.incoming'] });
    await without.call('session_open', { session: 'cl' });
    await assert.rejects(without.request('channels/close', { channelId: 'terminal:cl' }), (e: { code: number; message: string }) => e.code === -32002 && /channels\.lifecycle not granted/.test(e.message));
    await without.close();
    const withIt = await d.host('ta', 'cl-b');
    await withIt.request('channels/open', { channelId: 'terminal:cl' });
    assert.deepEqual(await withIt.request('channels/close', { channelId: 'terminal:cl' }), { closed: true });
    assert.deepEqual(await withIt.request('channels/close', { channelId: 'terminal:cl' }), { closed: false }, 'a channel that was not open');
    await withIt.close();
  } finally {
    await d.stop();
  }
});

test("MCPL 2: a progress digest's id carries its Run, so two Runs digested at the same journal position never share one, and seqOfMessageId still reads the seq", async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'dg-a');
    await a.call('session_open', { session: 'dg' });
    await a.request('channels/open', { channelId: 'terminal:dg' });
    // Two process Runs back to back: each prints a line and goes quiet, so each gets a digest.
    const r1 = await a.call('run', { session: 'dg', command: 'echo one; sleep 1.5', target: 'process', wait: 20 });
    const r2 = await a.call('run', { session: 'dg', command: 'echo two; sleep 1.5', target: 'process', wait: 20 });
    assert.ok(typeof r1.structured?.runId === 'string' && typeof r2.structured?.runId === 'string', JSON.stringify([r1, r2]));
    await a.delivery(aboutRun(r1.structured.runId), 8000);
    await a.delivery(aboutRun(r2.structured.runId), 8000);
    const digests = a.deliveries().filter((x) => x.tags.includes('terminal:output'));
    const of = (runId: unknown) => digests.filter((x) => x.metadata.runId === runId);
    assert.ok(of(r1.structured.runId).length >= 1 && of(r2.structured.runId).length >= 1, `digests: ${JSON.stringify(digests.map((x) => [x.messageId, x.metadata.runId]))}`);
    for (const x of digests) {
      const runId = String(x.metadata.runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(x.messageId, new RegExp(`:output~${runId}:(\\d+)$`), x.messageId);
      assert.equal(seqOfMessageId(x.messageId.slice(NODE_NAME.length + 1), 'dg', live(d.registry, 'dg').journal), Number(/:(\d+)$/.exec(x.messageId)![1]), x.messageId);
    }
    assert.equal(new Set(digests.map((x) => x.messageId)).size, digests.length, 'no two digests share an id');
    await a.close();
  } finally {
    await d.stop();
  }
});

// ───────────── the house's read of 2f357bd (#22) ─────────────

for (const first of ['never carried', 'refused on an open channel'] as const) {
  test(`a channels-only host that reconnects and opens the channel after its grant gets the completion it was owed (${first})`, async () => {
    const d = await daemon();
    const grant = ['tools', 'channels.register', 'channels.lifecycle', 'channels.incoming'];
    try {
      const a = await d.host('ta', 'co-a', { grant, answer: (m) => {
        if (m.method !== 'channels/incoming') return undefined;
        const msgs = (m.params as { messages: Array<{ messageId: string; tags: string[] }> }).messages;
        return { results: msgs.map((x) => ({ messageId: x.messageId, accepted: !x.tags.includes('terminal:run-finished'), reason: 'busy' })) };
      } });
      await a.call('session_open', { session: 'co' });
      if (first === 'refused on an open channel') await a.request('channels/open', { channelId: 'terminal:co' });
      const r = await a.call('run', { session: 'co', command: 'sleep 0.3; echo owed-to-channel', wait: 20 });
      const runId = r.structured?.runId as string;
      const s = live(d.registry, 'co');
      await until(() => s.run(runId).state === 'exited', 4000, 'the run to end');
      if (first === 'refused on an open channel') await a.delivery(aboutRun(runId), 3000);
      else {
        await sleep(300);
        assert.equal(a.deliveries().filter(aboutRun(runId)).length, 0, 'nothing could carry it');
      }
      await a.close();
      const a2 = await d.host('ta', 'co-a2', { grant });
      await sleep(400); // the grant's catch-up had nothing to carry it on either
      assert.equal(a2.deliveries().filter(aboutRun(runId)).length, 0);
      await a2.request('channels/open', { channelId: 'terminal:co' });
      const got = await a2.delivery(aboutRun(runId), 4000);
      assert.equal(got.via, 'incoming');
      assert.match(got.text, /owed-to-channel/);
      await until(() => s.cursorsOf(A).delivered >= s.run(runId).seq.end!, 2000, 'accepted: the cursor passes it');
      await a2.close();
    } finally {
      await d.stop();
    }
  });
}

test("a second connection of the same principal never settles what the first still owes on its open channel", async () => {
  const d = await daemon();
  try {
    const b = await d.host('tb', 'two-b');
    await b.call('session_open', { session: 'two', visibility: 'shared' });
    let errors = 0;
    const a1: TestHost = await d.host('ta', 'two-a1', { answer: (m) => {
      if (m.method !== 'channels/incoming' || errors > 0) return undefined;
      const p = m.params as { messages: Array<{ tags: string[] }> };
      if (!p.messages.some((v) => v.tags.includes('terminal:run-finished'))) return undefined;
      errors++;
      queueMicrotask(() => a1.respondError(m, -32000, 'temporary overload'));
      return new Promise(() => undefined);
    } });
    await a1.request('channels/open', { channelId: 'terminal:two' });
    // Push on, channel closed: B's Run is none of this connection's business, but A still owes it on the other.
    const a2 = await d.host('ta', 'two-a2');
    const r = await b.call('run', { session: 'two', command: 'sleep 0.3; echo theirs', wait: 20 });
    const runId = r.structured?.runId as string;
    await until(() => errors === 1, 4000, 'the first delivery, failed');
    await until(() => a1.deliveries().filter(aboutRun(runId)).length >= 2, 4000, 'the completion sent again on the open channel');
    const s = live(d.registry, 'two');
    await until(() => s.cursorsOf(A).delivered >= s.run(runId).seq.end!, 2000, 'accepted: the cursor passes it');
    assert.equal(a2.deliveries().filter(aboutRun(runId)).length, 0, 'never by push to the connection whose channel is closed');
    await a1.close();
    await a2.close();
    await b.close();
  } finally {
    await d.stop();
  }
});

test("a service's return to ready after an unhealthy spell is pushed; only the ready its start returned is withheld", { timeout: 20_000 }, async () => {
  const d = await daemon();
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const a = await d.host('ta', 'flap-a');
    await a.call('session_open', { session: 'flap' });
    const st = await a.call('start', { session: 'flap', command: 'sleep 30', target: 'process', ready: { tcp: { port } }, health: { tcp: { port }, intervalMs: 250 }, wait: 5000 });
    assert.equal(st.structured?.service, 'ready', st.text);
    const runId = st.structured?.runId as string;
    const about = (status: string) => (x: Delivery) => x.metadata.runId === runId && x.tags.includes(`terminal:service-${status}`);
    await a.noDelivery(about('ready'), 2500, 'for the ready the start result carried');
    srv.close();
    await a.delivery(about('unhealthy'), 5000);
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    const back = await a.delivery(about('ready'), 5000);
    assert.equal(back.via, 'push');
    await a.call('cancel', { runId });
    await a.close();
  } finally {
    srv.close();
    await d.stop();
  }
});

test("the owner is not pushed another principal's watch; the one who set it is", async () => {
  const d = await daemon();
  try {
    const a = await d.host('ta', 'ow-a');
    await a.call('session_open', { session: 'ow', visibility: 'shared' });
    const b = await d.host('tb', 'ow-b');
    const w = await b.call('watch', { session: 'ow', pattern: 'needle-[0-9]+', label: 'theirs' });
    assert.equal(w.isError, undefined, w.text);
    await a.call('run', { session: 'ow', command: 'echo needle-42' });
    const got = await b.delivery((x) => x.tags.includes('terminal:watch'), 4000);
    assert.equal(got.via, 'push');
    await a.noDelivery((x) => x.tags.includes('terminal:watch'), 600, "to the owner about another principal's watch");
    await a.close();
    await b.close();
  } finally {
    await d.stop();
  }
});

test('a completion a synchronous call returned leaves nothing held or owed in the lane', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lane-'));
  const registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, segmenter: { runSettleMs: 10 } });
  const out: Outbound = new Outbound((m) => {
    const req = m as Msg;
    if (req.method !== undefined && req.id !== undefined) setImmediate(() => out.handleResponse({ jsonrpc: '2.0', id: req.id!, result: TestHost.accept(req) } as never));
  });
  const caller = { principal: A, connectionId: 'c-held' };
  const lane = new McplLane(app, caller, out, () => undefined);
  try {
    await app.sessionOpen(caller, { id: 'hd' });
    await lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, { isRequest: true, after: (fn) => fn() });
    for (let i = 0; i < 8; i++) {
      const r = await app.run(caller, { session: 'hd', command: `echo held-${i}` });
      assert.equal(r.state, 'exited');
      app.outcomeSent(caller, r); // what the tool layer does once the result is on the wire
    }
    await sleep(400);
    const st = (lane as unknown as { states: Map<string, { held: Map<string, unknown>; owed: Set<number> }> }).states.get('hd');
    assert.ok(st, 'the lane keeps state for the session');
    assert.equal(st.held.size, 0, `held: ${[...st.held.keys()]}`);
    assert.equal(st.owed.size, 0, `owed: ${[...st.owed]}`);
  } finally {
    lane.dispose();
    await registry.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the note budget counts what the journal stores, keeps to the share even for a small retention, and survives a daemon restart', { timeout: 30_000 }, async () => {
  const d1 = await daemon();
  let d2: Awaited<ReturnType<typeof daemon>> | undefined;
  const pub = (h: TestHost, session: string, text: string) => h.request('channels/publish', { channelId: `terminal:${session}`, content: [{ type: 'text', text }] });
  const overShare = (e: { code: number; message: string }) => e.code === -32050 && /1\/16 of its retention/.test(e.message);
  try {
    const a = await d1.host('ta', 'nb2-a');
    await a.call('session_open', { session: 'nb2', retention: { maxBytes: 64 * 1024 } });
    // 1/16 of 64 KiB is 4,096 bytes of notes as the store writes them: three 1,000-byte texts (about 1,100 stored each) fit, a fourth does not.
    for (let i = 0; i < 3; i++) await pub(a, 'nb2', 'y'.repeat(1000));
    await assert.rejects(pub(a, 'nb2', 'y'.repeat(1000)), overShare);
    // The smallest retention a session may ask for: the share is 1,024 bytes, and a note is never allowed past it.
    await a.call('session_open', { session: 'nb3', retention: { maxBytes: 16 * 1024 } });
    await assert.rejects(pub(a, 'nb3', 'z'.repeat(1000)), (e: { code: number; message: string }) => e.code === -32602 && /at most \d+ bytes/.test(e.message));
    await pub(a, 'nb3', 'ok');
    await a.close();
    await d1.stop({ keep: true });
    d2 = await daemon({ dataDir: d1.dataDir });
    const a2 = await d2.host('ta', 'nb2-a2');
    await a2.call('session_open', { session: 'nb2' }); // a new life of the name; its journal still holds the three notes
    await assert.rejects(pub(a2, 'nb2', 'y'.repeat(1000)), overShare);
    await a2.close();
  } finally {
    await (d2 ?? d1).stop();
  }
});

test('listing channels reads the sessions once, not once per session, and the core set names every core tool', () => {
  let reads = 0;
  const entries = Array.from({ length: 1000 }, (_, i) => ({ kind: 'history', id: `h${i}`, owner: A, visibility: 'private', closed: false, recovered: 'history-only', journal: { lastSeq: 1, runs: {} }, retention: {} }));
  const app = {
    registry: { list: () => (reads++, entries), get: (id: string) => entries.find((e) => e.id === id) },
    can: () => true,
    sessionList: () => (reads++, entries.map((e) => ({ id: e.id, owner: e.owner, state: 'exited' }))),
    // A descriptor is the header alone: the full summary lists every Run of a session (a review of the consolidated branch of #22).
    summary: () => {
      throw new Error('a channel listing must not build full summaries');
    },
    // The real helper, so a header that came to be built from the full summary fails here; a stub showed only that the lane called it (the house's read of 78c4d6e, #22).
    summaryHeader: App.prototype.summaryHeader,
  } as unknown as App;
  const lane = new McplLane(app, { principal: A, connectionId: 'c-list' }, new Outbound(() => undefined), () => undefined);
  try {
    const channels = lane.listChannels();
    assert.equal(channels.length, 1000);
    assert.equal(channels[7]!.metadata.owner, A);
    assert.equal(channels[7]!.metadata.state, 'exited');
    assert.ok(reads <= 2, `the sessions were read ${reads} times`);
  } finally {
    lane.dispose();
  }
  for (const name of CORE_TOOLS) assert.ok(FEATURE_SETS['terminal.core'].description.includes(name), `terminal.core names ${name}`);
});

test('G23: a completion reaches the host with terminal:* tags and its sender facet, never chat:addressed; the declared ontology names no such tag', async () => {
  // The lane adds the per-recipient tags (origin, chat:from-*); nothing checked that the set
  // stays descriptive (the house's read of 07ab3dd, #22: a run message tagged chat:addressed
  // passed the suite).
  const d = await daemon();
  try {
    const a = await d.host('ta', 'g23');
    await a.call('session_open', { session: 'g23' });
    await a.request('channels/open', { channelId: 'terminal:g23' });
    const r = await a.call('run', { session: 'g23', command: 'sleep 0.3; echo g23-done', wait: 20 });
    const got = await a.delivery(aboutRun(r.structured?.runId), 4000);
    assert.ok(got.tags.includes('terminal:run-finished') && got.tags.includes('terminal:origin=self') && got.tags.includes('chat:from-self'), got.tags.join(', '));
    assert.ok(!got.tags.includes('chat:addressed'), got.tags.join(', '));
    for (const t of got.tags) assert.ok(t.startsWith('terminal:') || /^chat:from-(human|agent|self)$/.test(t), t);
    assert.doesNotMatch(JSON.stringify(manifest()), /chat:addressed/, 'the manifest declares no chat:addressed');
    await a.close();
  } finally {
    await d.stop();
  }
});

test('G24: no feature set declares rollback, in the declarations and in the manifest the host receives', () => {
  // A journal position is evidence, not a checkpoint of shell side effects (G24). The built
  // code could declare `rollback: true` on terminal.core without a test noticing (the house's
  // read of 07ab3dd, #22). `manifest()` is what initialize sends.
  for (const [name, decl] of Object.entries(FEATURE_SETS)) assert.equal((decl as { rollback?: unknown }).rollback, undefined, `${name} declares rollback`);
  const sets = (manifest().featureSets ?? {}) as Record<string, { rollback?: unknown }>;
  assert.ok(Object.keys(sets).length >= 9, 'the manifest carries the feature sets');
  for (const [name, decl] of Object.entries(sets)) assert.ok(!decl.rollback, `${name} declares rollback in the manifest`);
  assert.doesNotMatch(JSON.stringify(manifest()), /"rollback"\s*:\s*true/);
});

// ───────────── the house's read of 78c4d6e (#22) ─────────────

/**
 * Hold a live session's renders of one Run (what a history page reads for it) until `release` is called;
 * `reached` resolves at the first. Only that Run's: a `run` result and the live segmenter render Runs the
 * same way, and a gate on every render deadlocks the caller whose Run should end during the hold.
 */
function holdTranscripts(s: Session, runId: unknown): { reached: Promise<void>; release: () => void; restore: () => void } {
  let release = () => undefined as void;
  let reached = () => undefined as void;
  const gate = new Promise<void>((r) => (release = r));
  const first = new Promise<void>((r) => (reached = r));
  const orig = s.runTranscript.bind(s);
  (s as unknown as { runTranscript: Session['runTranscript'] }).runTranscript = async (id) => {
    if (id !== runId) return orig(id);
    reached();
    await gate;
    return orig(id);
  };
  return { reached: first, release, restore: () => delete (s as unknown as { runTranscript?: unknown }).runTranscript };
}

test("a channel opened while its session runs gets the Run that ended during the open's history read", { timeout: 20_000 }, async () => {
  // The open read its page and only then recorded the channel; a Run of another principal that ended
  // meanwhile was settled as owed to nobody, and the opener never heard of it. The control, with the
  // read not held, passed at the same head.
  const d = await daemon();
  try {
    const b = await d.host('tb', 'or-b');
    await b.call('session_open', { session: 'or', visibility: 'shared' });
    const first = await b.call('run', { session: 'or', command: 'echo or-first' }); // a Run for the page to render
    const s = live(d.registry, 'or');
    for (const held of [false, true]) {
      const a = await d.host('ta', held ? 'or-a-held' : 'or-a-control');
      const hold = held ? holdTranscripts(s, first.structured?.runId) : undefined;
      const opening = a.request('channels/open', { channelId: 'terminal:or', history: { limit: 10 } }) as Promise<{ history?: Array<{ metadata: Record<string, unknown> }> }>;
      if (hold) await hold.reached;
      // The second Run's message, once built, has reached every listener of the session's segmenter, the lane's
      // among them, before this promise settles: waiting on it, not on time, is what shows the hold (the house's
      // read of the 38 commits, PR #22, comment 6274370651).
      const built = hold
        ? new Promise<void>((r) => {
            const off = d.app.segmenter(s).subscribe((x) => {
              if (x.kind !== 'run' || x.runId === first.structured?.runId) return;
              off();
              r();
            });
          })
        : undefined;
      const second = await b.call('run', { session: 'or', command: 'echo or-second' });
      if (hold) {
        await built;
        hold.release();
      }
      const res = await opening;
      hold?.restore();
      const paged = (res.history ?? []).map((m) => m.metadata.runId);
      assert.ok(paged.includes(first.structured?.runId), `the page has the first Run: ${JSON.stringify(paged)}`);
      if (held) assert.ok(!paged.includes(second.structured?.runId), 'the page predates the second Run');
      const got = await a.delivery(aboutRun(second.structured?.runId), 4000);
      assert.equal(got.via, 'incoming', `${held ? 'held' : 'control'}: on the channel`);
      await sleep(300);
      assert.equal(a.deliveries().filter(aboutRun(second.structured?.runId)).length, 1, 'once');
      await a.request('channels/close', { channelId: 'terminal:or' });
      await a.close();
    }
    await b.close();
  } finally {
    await d.stop();
  }
});

test("a lane disposed while an open reads history registers nothing, follows nothing and answers the open with an error", async () => {
  // The open resumed after its read on a disposed lane and followed the session: a segmenter and journal
  // subscription nothing would ever remove, and a result for a connection that was gone.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lane-'));
  const registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, segmenter: { runSettleMs: 10 } });
  const out = new Outbound(() => undefined);
  const caller = { principal: A, connectionId: 'c-od' };
  const lane = new McplLane(app, caller, out, () => undefined);
  const watched = (lane as unknown as { watched: Map<string, unknown> }).watched;
  try {
    const ctx = { isRequest: true, after: (fn: () => void) => fn() };
    await lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, ctx);
    // Opened after the grant, with no endpoint to announce it: nothing follows it until a channel opens.
    await app.sessionOpen(caller, { id: 'od', visibility: 'shared' });
    const one = await app.run(caller, { session: 'od', command: 'echo od-one', wait: 5000 });
    const s = live(registry, 'od');
    const hold = holdTranscripts(s, one.runId);
    assert.equal(watched.size, 0);
    const opening = lane.handle('channels/open', { channelId: 'terminal:od', history: { limit: 5 } }, ctx);
    await hold.reached;
    lane.dispose();
    hold.release();
    await assert.rejects(opening, (e: Error & { code?: number }) => e.code === -32603 && /closed/.test(e.message));
    hold.restore();
    assert.equal(watched.size, 0, 'a disposed lane follows nothing');
    assert.equal((lane as unknown as { open: Set<string> }).open.size, 0, 'and opens nothing');
  } finally {
    lane.dispose();
    await registry.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const recovery of ['retry', 'reconnect'] as const) {
  test(`a catch-up summary of both omitted messages and a gone range pins the cursor below the range, and a refusal keeps the range (${recovery})`, { timeout: 60_000 }, async () => {
    // With both, the summary pinned at the omitted range's start, the later one: the cursor passed the gone
    // range while the host still refused the summary, and the reconnect's summary named only the omitted messages.
    const d = await daemon({ retention: { maxBytes: 64 * 1024 } });
    let allowSummary = false;
    const answer = (m: Msg) => (m.method === 'push/event' && (m.params as { tags: string[] }).tags.includes('terminal:missed') ? { accepted: allowSummary, reason: 'queue_full' } : undefined);
    try {
      const m = await d.host('ta', 'bl-m', { mcpl: false });
      await m.call('session_open', { session: 'bl' });
      for (let i = 0; i < 4; i++) await m.call('run', { session: 'bl', command: 'seq 1 5000' });
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const r = await m.call('run', { session: 'bl', command: `echo bl-${i}`, target: 'process', wait: 0 });
        ids.push(r.structured!.runId as string);
      }
      const s = live(d.registry, 'bl');
      await until(() => ids.every((id) => s.run(id).state === 'exited'), 10_000, 'the thirty Runs to end');
      await sleep(200);
      await m.close();
      const ends = ids.map((id) => s.run(id).seq.end!);
      const oldest = s.journal.oldestSeq ?? 1;
      assert.ok(oldest > 1 && oldest < Math.min(...ends), `retention took the start of the journal and none of the thirty (oldest ${oldest}, first end ${Math.min(...ends)})`);
      let a = await d.host('ta', 'bl-a', { answer });
      const summary = await a.delivery((v) => v.tags.includes('terminal:missed'), 8000);
      const meta = summary.metadata as { count: number; from: number; lostFrom?: number; lostTo?: number };
      assert.ok(meta.count >= 1 && meta.lostFrom === 1 && meta.lostTo !== undefined && meta.lostTo < meta.from, `both an omitted count and a gone range: ${JSON.stringify(meta)}`);
      await until(() => a.deliveries().filter((v) => ids.includes(v.metadata.runId as string)).length >= 20, 8000, 'the replayed completions');
      await sleep(100); // let the accepted newer messages advance the cursor
      assert.ok(s.cursorsOf(A).delivered < meta.lostFrom, `the refused summary pins the cursor below the gone range (delivered ${s.cursorsOf(A).delivered})`);
      if (recovery === 'reconnect') {
        await a.close();
        a = await d.host('ta', 'bl-a2', { answer });
        const again = await a.delivery((v) => v.tags.includes('terminal:missed'), 8000);
        assert.equal(again.messageId, summary.messageId);
        assert.equal(again.metadata.count, meta.count, 'the omitted messages are still represented');
        assert.equal(again.metadata.lostFrom, 1, 'and so is the gone range');
        assert.ok((again.metadata.lostTo as number) >= meta.lostTo!, JSON.stringify(again.metadata));
      }
      allowSummary = true;
      await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 10_000, 'the accepted summary to release the cursor');
      await a.close();
    } finally {
      await d.stop();
    }
  });
}

test("a history boundary is an id of this channel: another session's id, this session's under another epoch, and this session's under another node's name are refused", async () => {
  // The boundary was read by its suffix's shape, so any of the three paged this journal.
  const d = await daemon();
  try {
    const a = await d.host('ta', 'bd-a');
    const ids: Record<string, string> = {};
    for (const sid of ['bd1', 'bd2']) {
      await a.call('session_open', { session: sid });
      await a.request('channels/open', { channelId: `terminal:${sid}` });
      const r = await a.call('run', { session: sid, command: `sleep 0.2; echo ${sid}`, wait: 20 });
      ids[sid] = (await a.delivery(aboutRun(r.structured?.runId), 4000)).messageId;
    }
    await a.request('channels/close', { channelId: 'terminal:bd1' });
    const own = ids.bd1!;
    assert.match(own, new RegExp(`^${NODE_NAME}/bd1~[^:/]+:run:\\d+$`), own);
    const open = (before: string) => a.request('channels/open', { channelId: 'terminal:bd1', history: { limit: 10, beforeMessageId: before } }) as Promise<{ history?: Array<{ messageId: string }> }>;
    const refused = (e: Error & { code?: number }) => e.code === -32602 && /beforeMessageId/.test(e.message);
    await assert.rejects(open(ids.bd2!), refused, "another session's id");
    await assert.rejects(open(own.replace(/~[^:/]+:/, '~other-epoch:')), refused, 'this session under another epoch');
    await assert.rejects(open(own.replace(/^[^/]+\//, 'elsewhere/')), refused, "this session under another node's name");
    const res = await open(own);
    assert.ok(Array.isArray(res.history) && !res.history.some((x) => x.messageId === own), 'the real id pages before itself');
    await a.close();
  } finally {
    await d.stop();
  }
});

test('a catch-up summary of omitted messages and gone ranges names them apart, and its floor is the earliest start among them', () => {
  // The floor's pin is shown end to end above with one gone range; here the message itself, with two gone ranges
  // and with one past the omitted range (the house's read of 78c4d6e, #22; a reviewer's read of the fixes for #22 comment 6270045466).
  const lane = new McplLane({} as unknown as App, { principal: A, connectionId: 'c-sum' }, new Outbound(() => undefined), () => undefined);
  try {
    const t = { kind: 'history', id: 'sm', journal: { epoch: 'e1' } };
    const summary = (lane as unknown as { summary: (t: unknown, o: unknown, lost: unknown) => { seq: number; messageId: string; head: string; metadata: Record<string, unknown> } }).summary.bind(lane);
    const omitted = { count: 4, from: 228, to: 240, kinds: { run: 4 } };
    const both = summary(t, omitted, [{ from: 1, to: 226, reason: 'retention' }]);
    assert.equal(both.seq, 240);
    assert.equal(both.messageId, 'sm~e1:summary~1:240');
    // Its id names its range's start: a summary ending at the same seq, of another range, is another message
    // (the house's read of 4860d4c, #22: one in flight had its entry taken and settled what its host never heard of).
    assert.equal(summary(t, omitted, undefined).messageId, 'sm~e1:summary~228:240');
    assert.match(both.head, /^\[terminal\] sm: 4 earlier messages .*\(4 completions\) · seq 228–240 · seq 1–226 \(past retention\) gone, with whatever happened then · read session=sm since=227 as=events$/);
    assert.deepEqual([both.metadata.count, both.metadata.from, both.metadata.to, both.metadata.lostFrom, both.metadata.lostTo], [4, 228, 240, 1, 226]);
    assert.equal(summaryFloor(omitted, [{ from: 1 }]), 1);
    const two = summary(t, omitted, [{ from: 1, to: 100, reason: 'retention' }, { from: 150, to: 226, reason: 'retention' }]);
    assert.match(two.head, / · seq 1–100, 150–226 \(past retention\) gone, with whatever happened then · read session=sm since=227 as=events$/);
    assert.deepEqual([two.seq, two.metadata.lostFrom, two.metadata.lostTo], [240, 1, 226]);
    assert.equal(summaryFloor(omitted, [{ from: 1 }, { from: 150 }]), 1, 'the earliest of three starts');
    const after = summary(t, omitted, [{ from: 300, to: 310, reason: 'retention' }]);
    assert.deepEqual([after.seq, after.metadata.from, after.metadata.lostFrom, after.metadata.lostTo], [240, 228, 300, 310]);
    assert.equal(summaryFloor(omitted, [{ from: 300 }]), 228, 'a gone range past the omitted range: the omitted start pins');
    assert.equal(summaryFloor(undefined, [{ from: 5 }, { from: 2 }]), 2);
    const gapOnly = summary(t, undefined, [{ from: 1, to: 226, reason: 'retention' }]);
    assert.equal(gapOnly.seq, 226);
    assert.deepEqual([gapOnly.metadata.count, gapOnly.metadata.lostFrom, gapOnly.metadata.lostTo], [0, 1, 226]);
    assert.match(gapOnly.head, /since=226 as=events$/);
    // Each range says why it is gone, in a read's words: every range was called past retention, a failed store's
    // hole and a torn write's too (a reviewer's read of the fixes for #22). The metadata stays two scalars.
    const mixed = summary(t, undefined, [{ from: 6, to: 9, reason: 'retention' }, { from: 10, to: 30, reason: 'store-failed' }, { from: 80, to: 90, reason: 'store-failed' }, { from: 95, to: 96, reason: 'torn-write' }]);
    assert.match(mixed.head, /^\[terminal\] sm: seq 6–9 \(past retention\), 10–30, 80–90 \(the journal store never took them\), 95–96 \(a crash cut the journal short\) gone, with whatever happened then · read session=sm since=96 as=events$/);
    assert.deepEqual([mixed.metadata.lostFrom, mixed.metadata.lostTo], [6, 96]);
  } finally {
    lane.dispose();
  }
});

test('the hold for a synchronous call is measured on the monotonic clock: a wall-clock step neither ends it early nor stretches it', { timeout: 30_000 }, async (t) => {
  // The hold's start and age were read from Date.now (the house's correction, comment 6270946953 on #22):
  // stepped forward, the hold ended at its next check; stepped back, it lasted the step longer.
  const d = await daemon();
  const real = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => real() + offset);
  try {
    const a = await d.host('ta', 'hc');
    await a.call('session_open', { session: 'hc' });
    const s = live(d.registry, 'hc');
    for (const step of [10_000, -10_000]) {
      const r = await a.call('run', { session: 'hc', command: 'sleep 0.3; echo held', wait: 20 });
      const runId = r.structured?.runId as string;
      // As in mcpl-1: a synchronous wait of this principal is in flight at run.end, and its result never reaches the host.
      await s.awaitRun(runId, 20_000, A);
      const t0 = performance.now();
      offset = step; // the wall clock steps right after the hold began
      const got = await a.delivery(aboutRun(runId), 8000);
      const took = performance.now() - t0;
      assert.match(got.text, /held/);
      assert.ok(took >= 1500, `stepped ${step} ms: the hold was not cut short (${took.toFixed(0)} ms)`);
      assert.ok(took < 5000, `stepped ${step} ms: the hold was not stretched (${took.toFixed(0)} ms)`);
      offset = 0;
    }
    await a.close();
  } finally {
    await d.stop();
  }
});

// ───────────── a reviewer's read of the fixes for #22 comment 6270045466 ─────────────

/**
 * A lane over a real App with no endpoint, as the reviewer's probe drives it: the host accepts every
 * request until `refuse.value` is set. Registry changes reach the lane as the endpoint would send them
 * (`announce`), except a close, which the test orders itself (`closed` records them), and a removal
 * when `removals` is manual (`removed` records them).
 */
async function bareLane(connection: string, o: { announce?: boolean; removals?: 'manual' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lane-'));
  const registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, segmenter: { runSettleMs: 10 } });
  const sent: Msg[] = [];
  /** While `value` is set, the host refuses deliveries, or only those `only` names. */
  const refuse: { value: boolean; only?: (req: Msg) => boolean } = { value: false };
  const refusal = (req: Msg): unknown => {
    if (req.method === 'channels/incoming') return { results: (req.params as { messages: Array<{ messageId: string }> }).messages.map((x) => ({ messageId: x.messageId, accepted: false, reason: 'queue_full' })) };
    if (req.method === 'push/event') return { accepted: false, reason: 'queue_full' };
    return TestHost.accept(req);
  };
  /** While set, the host's answers to deliveries wait in `pending` until the test gives them, as a slow host's do. */
  const late = { value: false };
  const pending: Array<{ req: Msg; answer: () => void }> = [];
  const out: Outbound = new Outbound((m) => {
    const req = m as Msg;
    sent.push(req);
    if (req.method === undefined || req.id === undefined) return;
    const result = refuse.value && (refuse.only?.(req) ?? true) ? refusal(req) : TestHost.accept(req);
    const answer = () => out.handleResponse({ jsonrpc: '2.0', id: req.id!, result } as never);
    if (late.value && (req.method === 'push/event' || req.method === 'channels/incoming')) pending.push({ req, answer });
    else setImmediate(answer);
  });
  const caller = { principal: A, connectionId: connection };
  const logs: string[] = [];
  const lane = new McplLane(app, caller, out, (line) => logs.push(line));
  const closed: string[] = [];
  const removed: string[] = [];
  if (o.announce !== false) {
    registry.onChange((c) => {
      if (c.type === 'created') lane.sessionCreated(c.id);
      else if (c.type === 'closed') closed.push(c.id);
      else if (o.removals === 'manual') removed.push(c.id);
      else void lane.sessionRemoved(c.id);
    });
  }
  const ctx = { isRequest: true, after: (fn: () => void) => fn() };
  await lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, ctx);
  const inside = lane as unknown as {
    opening: Map<string, { held: Map<string, unknown> }>;
    open: Set<string>;
    registered: Set<string>;
    watched: Map<string, unknown>;
    states: Map<string, { owed: Set<number>; inflight: Map<string, number>; retries: Map<string, { kind: string }>; held: Map<string, { since: number; seq?: number }>; summaries: Map<string, { from: number; folded?: { count: number }; owes?: number; covered: Set<number> }> }>;
    closes: Map<string, number>;
    batch: unknown[];
    flush(): Promise<void>;
    startCatchUp(sessions: string[]): Promise<void>;
    catchingUp: Promise<void> | undefined;
    carried(t: Session, st: unknown): Set<number>;
    settleSegment(t: Session, seg: unknown, how: 'accepted'): void;
    retireSummaries(t: Session, st: unknown, ids: string[]): Set<number>;
    budgetOf(journal: Journal): { retained: unknown[]; seed(journal: Journal): Promise<void> };
    deliver(t: Session, seg: unknown, opts: { released: true }): void;
  };
  /** A Run whose outcome counts as returned by its call: once settled, nothing of it is held or owed. */
  const settledRun = async (session: string, command: string): Promise<string> => {
    const r = await app.run(caller, { session, command, wait: 5000 });
    const s = live(registry, session);
    s.markOutcomeDelivered(r.runId!, A);
    await until(() => s.cursorsOf(A).delivered >= s.run(r.runId!).seq.end!, 4000, `the completion of ${command} to settle`);
    return r.runId!;
  };
  const close = async () => {
    lane.dispose();
    await registry.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { registry, app, lane, caller, ctx, sent, refuse, late, pending, closed, removed, inside, settledRun, close, logs };
}

test("a refused completion whose resend waits for the host's late answer is not folded, so each refused message is counted once, retried alone or by a summary (an independent read of the fold, #22)", { timeout: 60_000 }, async () => {
  // The fold took a message whose resend was in flight; refused late, it was owed alone again: 30 refused
  // completions read as 4 retried alone and 33 counted by summaries when the host answered 700 ms late.
  const was = McplLane.retryMax;
  McplLane.retryMax = 4;
  const f = await bareLane('c-retry-late');
  try {
    await f.app.sessionOpen(f.caller, { id: 'rl' });
    const s = live(f.registry, 'rl');
    f.refuse.value = true;
    const st = () => f.inside.states.get('rl')!;
    const eventOf = (m: Msg) => (m.params as { eventId: string }).eventId;
    const pushes = (id: string) => f.sent.filter((m) => m.method === 'push/event' && eventOf(m) === id).length;
    const counted = () => [...st().retries.values()].filter((r) => r.kind !== 'summary').length + [...st().summaries.values()].reduce((n, x) => n + (x.folded?.count ?? 0), 0);
    const ends: number[] = [];
    /** A Run's completion, pushed once; its id. */
    const complete = async (i: number): Promise<string> => {
      const r = await f.app.run(f.caller, { session: 'rl', command: `echo rl-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
      ends.push(s.run(r.runId!).seq.end!);
      const id = `${NODE_NAME}/${s.id}~${s.journal.epoch}:run:${ends[ends.length - 1]}`;
      await until(() => pushes(id) >= 1, 5000, `the completion of Run ${i} pushed`);
      return id;
    };
    const answerAll = async () => {
      const ids = f.pending.splice(0).map((p) => (p.answer(), eventOf(p.req)));
      await until(() => ids.every((id) => !st().inflight.has(id)), 5000, 'the late refusals taken in');
    };
    // Four refused and retried alone, the bound.
    const four: string[] = [];
    for (let i = 0; i < 4; i++) {
      four.push(await complete(i));
      await until(() => st().retries.has(four[i]!), 5000, `Run ${i}'s completion retried`);
    }
    // The host now answers late, and each of the four is resent and waits for its answer.
    f.late.value = true;
    await until(() => four.every((id) => pushes(id) >= 2 && st().inflight.has(id)), 5000, 'the four resent');
    // A fifth is refused at once: the fold leaves the four waiting and takes the one it can.
    const fifth = await complete(4);
    f.pending.splice(f.pending.findIndex((p) => eventOf(p.req) === fifth), 1)[0]!.answer();
    await until(() => !st().inflight.has(fifth), 5000, 'the fifth refused');
    assert.ok(four.every((id) => st().retries.has(id)), 'the four waiting on an answer are still retried alone');
    assert.equal(counted(), 5);
    // The four are refused late, and the summary with them: each is still counted once.
    await answerAll();
    assert.equal(counted(), 5, 'refused late, a message is not owed alone a second time');
    // A later fold, with the host answering at once again, counts each once too.
    f.late.value = false;
    await complete(5);
    await until(() => counted() === 6 && st().inflight.size === 0, 5000, 'the sixth refused and folded');
    assert.ok([...st().retries.values()].filter((r) => r.kind !== 'summary').length <= McplLane.retryMax);
    // The host takes messages again: the cursor passes every completion, and nothing is left owed.
    f.refuse.value = false;
    await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 30_000, 'the cursor to pass the last completion');
    assert.equal(st().retries.size, 0);
    assert.equal(st().summaries.size, 0);
  } finally {
    McplLane.retryMax = was;
    f.late.value = false;
    for (const p of f.pending.splice(0)) p.answer();
    await f.close();
  }
});

test("refused lifecycle messages are retried one by one up to the bound, the oldest past it folded into one summary retried in their place, which keeps the cursor below them until the host accepts it (the house's read of the 40 commits through f3750e4, #22 comment 6310921374)", { timeout: 60_000 }, async () => {
  // A host that refused every lifecycle message held a retry entry, its message and a timer for each completion, without bound.
  const was = McplLane.retryMax;
  McplLane.retryMax = 4;
  const f = await bareLane('c-retry-bound');
  try {
    await f.app.sessionOpen(f.caller, { id: 'rb' });
    const s = live(f.registry, 'rb');
    f.refuse.value = true;
    const st = () => f.inside.states.get('rb')!;
    const pushed = (id: string) => f.sent.some((m) => m.method === 'push/event' && (m.params as { eventId: string }).eventId === id);
    /** What stands for the refused completions: each one retried alone, or counted by a summary that folded it. */
    const accounted = () => {
      const singles = [...st().retries.values()].filter((r) => r.kind !== 'summary').length;
      const folded = [...st().summaries.values()].reduce((n, x) => n + (x.folded?.count ?? 0), 0);
      return { singles, folded, summaries: [...st().summaries.values()].filter((x) => x.folded).length };
    };
    const N = 14;
    const ends: number[] = [];
    for (let i = 0; i < N; i++) {
      const r = await f.app.run(f.caller, { session: 'rb', command: `echo rb-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
      const end = s.run(r.runId!).seq.end!;
      ends.push(end);
      // Pushed and refused before the next one ends, so the entries are made in order.
      const id = `${NODE_NAME}/${s.id}~${s.journal.epoch}:run:${end}`;
      await until(() => pushed(id) && (st().retries.has(id) || accounted().folded + accounted().singles === i + 1), 5000, `the completion of Run ${i} refused`);
      const a = accounted();
      assert.ok(a.singles <= McplLane.retryMax && a.summaries <= 2 && st().retries.size <= McplLane.retryMax + 2, `${i}: ${JSON.stringify(a)}, ${st().retries.size} entries`);
      assert.equal(a.singles + a.folded, i + 1, `${i}: every refused completion is retried alone or counted by a summary`);
    }
    // With 4 retried alone at most, the oldest three of five folded each time: 12 in summaries, the newest 2 alone.
    assert.equal(accounted().singles, 2);
    assert.equal(accounted().folded, N - 2);
    for (const end of ends.slice(0, N - 2)) assert.ok(!st().owed.has(end), 'a folded completion is owed through its summary, not alone');
    assert.ok(s.cursorsOf(A).delivered < Math.min(...ends), `the cursor stays below the oldest refused completion (delivered ${s.cursorsOf(A).delivered}, first end ${Math.min(...ends)})`);
    const summaries = f.sent.filter((m) => m.method === 'push/event' && /:summary~refused-/.test((m.params as { eventId: string }).eventId));
    assert.ok(summaries.length >= 1, 'the summary went out in their place');
    const last = summaries[summaries.length - 1]!.params as { tags: string[]; origin: Record<string, unknown>; payload: { content: Array<{ text: string }> } };
    assert.ok(last.tags.includes('terminal:missed'));
    assert.equal(last.origin.refused, true);
    assert.match(last.payload.content[0]!.text, /^\[terminal\] rb: \d+ earlier messages refused on delivery and no longer sent one by one \(\d+ completions\) · seq \d+–\d+ · read session=rb since=\d+ as=events$/);
    assert.ok(f.logs.some((l) => /^the host refused more than 4 lifecycle messages of rb: the oldest 3 are folded into one summary \(\d+ in all, seq \d+–\d+\), retried in their place; they stay owed until the host accepts it$/.test(l)), f.logs.join('\n'));
    // The host takes messages again: the retries and the summary go, and the cursor passes every completion.
    const standing = [...st().summaries.keys()];
    const from = f.sent.length;
    f.refuse.value = false;
    await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 30_000, 'the cursor to pass the last completion');
    assert.equal(st().retries.size, 0);
    assert.equal(st().summaries.size, 0);
    const taken = f.sent.slice(from).filter((m) => m.method === 'push/event').map((m) => m.params as { eventId: string; origin: Record<string, unknown> });
    assert.equal(standing.reduce((n, id) => n + Number(taken.find((p) => p.eventId === id)?.origin.count ?? 0), 0), N - 2, 'the summaries the host took count every folded completion');
  } finally {
    McplLane.retryMax = was;
    await f.close();
  }
});

test("a message held for an open in flight keeps its debt when the session closes during the read, and the host's later refusal keeps it owed", { timeout: 20_000 }, async () => {
  // The reviewer's probe: the exit journaled during the read was owed and held; a catch-up lifted clearTo past
  // it; sessionClosed released its debt as a message that would never come, so `delivered` passed it before
  // any host received it, and the host's later refusal was settled as accepted.
  const f = await bareLane('c-release');
  try {
    await f.app.sessionOpen(f.caller, { id: 'oc', visibility: 'shared' });
    const one = await f.settledRun('oc', 'echo one');
    const s = live(f.registry, 'oc');
    const hold = holdTranscripts(s, one);
    const opening = f.lane.handle('channels/open', { channelId: 'terminal:oc', history: { limit: 5 } }, f.ctx);
    await hold.reached;
    await f.app.sessionClose(f.caller, { session: 'oc' });
    await until(() => f.closed.includes('oc'), 3000, 'the close to be announced');
    await until(() => (f.inside.opening.get('terminal:oc')?.held.size ?? 0) >= 1, 3000, 'the exit held for the opening channel');
    const exit = s.journal.since(0).events.find((e) => e.type === 'session.exit');
    assert.ok(exit, 'the exit is journaled');
    const st = f.inside.states.get('oc')!;
    assert.ok(st.owed.has(exit.seq), 'the exit is owed: the channel is opening');
    // A catch-up during the open (a grant widening does this) scans past the exit and lifts clearTo to the end.
    await f.inside.startCatchUp(['oc']);
    // The endpoint's sessionClosed releases what the closed life's segmenter will never send, not what the opening holds.
    await f.lane.sessionClosed('oc');
    assert.ok(s.cursorsOf(A).delivered < exit.seq, `delivered stays below the held exit (${s.cursorsOf(A).delivered} vs ${exit.seq})`);
    f.refuse.value = true;
    hold.release();
    // Closed during the read, the session is no longer the one the open began on: the open is refused, and the
    // held exit goes the closed channel's way, a push the host refuses.
    await assert.rejects(opening, (e: Error & { code?: number }) => e.code === -32023);
    hold.restore();
    await until(() => f.sent.some((m) => m.method === 'push/event' && /session-exit/.test(String((m.params as { eventId: string }).eventId))), 3000, 'the exit pushed');
    await until(() => st.retries.size >= 1, 3000, 'the refused exit queued for a retry');
    assert.ok(st.owed.has(exit.seq), 'refused, the exit stays owed');
    assert.ok(s.cursorsOf(A).delivered < exit.seq);
  } finally {
    await f.close();
  }
});

test("a session forgotten while its channel's history is read opens nothing: the open is refused and the channel is neither registered, open nor opening", { timeout: 20_000 }, async () => {
  const f = await bareLane('c-forget');
  try {
    await f.app.sessionOpen(f.caller, { id: 'fg', visibility: 'shared' });
    const one = await f.settledRun('fg', 'echo one');
    const s = live(f.registry, 'fg');
    const hold = holdTranscripts(s, one);
    const opening = f.lane.handle('channels/open', { channelId: 'terminal:fg', history: { limit: 5 } }, f.ctx);
    await hold.reached;
    await f.app.sessionClose(f.caller, { session: 'fg', forget: true });
    await until(() => f.registry.get('fg') === undefined, 3000, 'the name to be forgotten');
    hold.release();
    await assert.rejects(opening, (e: Error & { code?: number }) => e.code === -32023 && /nothing was opened/.test(e.message));
    hold.restore();
    assert.equal(f.inside.opening.size, 0, 'nothing left opening');
    assert.equal(f.inside.open.has('terminal:fg'), false, 'not open');
    assert.equal(f.inside.registered.has('terminal:fg'), false, 'not registered');
    assert.equal(f.inside.watched.size, 0, 'not followed');
  } finally {
    await f.close();
  }
});

test('an open whose follow fails leaves no channel opening, nothing registered and nothing owed', async () => {
  // Only the read and the disposal check had an abandon: a throw after them left the channel opening for good.
  const f = await bareLane('c-follow', { announce: false }); // nothing follows the session until a channel opens
  try {
    await f.app.sessionOpen(f.caller, { id: 'ff', visibility: 'shared' });
    await f.app.run(f.caller, { session: 'ff', command: 'echo one', wait: 5000 });
    const app = f.app as unknown as { segmenter?: () => never };
    app.segmenter = () => {
      throw new Error('segmenter unavailable');
    };
    try {
      await assert.rejects(f.lane.handle('channels/open', { channelId: 'terminal:ff', history: { limit: 5 } }, f.ctx), /segmenter unavailable/);
    } finally {
      delete app.segmenter;
    }
    assert.equal(f.inside.opening.size, 0, 'nothing left opening');
    assert.equal(f.inside.open.size, 0, 'nothing open');
    assert.equal(f.inside.registered.has('terminal:ff'), false, 'nothing registered');
    assert.equal(f.inside.states.get('ff')?.owed.size ?? 0, 0, 'nothing owed');
  } finally {
    await f.close();
  }
});

test("a young service Run stays hold-eligible across a wall-clock step: the ready its start returns is not pushed beside it", { timeout: 30_000 }, async (t) => {
  // The age was Date.now against the journaled admittedAt: stepped two minutes forward, the Run looked older than
  // any call could wait, its ready was not held, and the host got it twice (G28).
  const d = await daemon();
  const real = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => real() + offset);
  try {
    const a = await d.host('ta', 'sm-a');
    await a.call('session_open', { session: 'smono' });
    const starting = a.call('start', { session: 'smono', command: "sh -c 'sleep 1; echo listening; sleep 5'", target: 'process', ready: { pattern: 'listening' }, wait: 8000 });
    await sleep(300);
    offset = 120_000; // the wall clock steps forward while the start waits for ready
    const st = await starting;
    assert.equal(st.structured?.service, 'ready', st.text);
    const runId = st.structured?.runId as string;
    await a.noDelivery((x) => x.metadata.runId === runId && x.tags.includes('terminal:service-ready'), 3000, 'after a start that returned ready');
    offset = 0;
    await a.call('cancel', { runId });
    await a.close();
  } finally {
    await d.stop();
  }
});

// ───────────── the house's read of the 38 commits (PR #22, comment 6274370651) ─────────────

test("a close sent while the channel's history is read stands: it answers closed, what was held goes a closed channel's way, and the open leaves the channel closed", { timeout: 20_000 }, async () => {
  // closeChannel answered from `open` alone, false while the channel was opening, and the returning open
  // registered, opened and delivered what it held: the host's close was undone, while the host kept it.
  const f = await bareLane('c-close-mid');
  try {
    await f.app.sessionOpen(f.caller, { id: 'cm', visibility: 'shared' });
    const one = await f.settledRun('cm', 'echo one');
    const s = live(f.registry, 'cm');
    const hold = holdTranscripts(s, one);
    const opening = f.lane.handle('channels/open', { channelId: 'terminal:cm', history: { limit: 5 } }, f.ctx) as Promise<{ history?: unknown[] }>;
    await hold.reached;
    const seat = s.journal.append({ type: 'control', controller: null, by: A, how: 'release' }); // a message for the opening channel
    await until(() => (f.inside.opening.get('terminal:cm')?.held.size ?? 0) >= 1, 3000, 'the seat change held for the opening channel');
    assert.ok(s.cursorsOf(A).delivered < seat.seq, 'held, the seat change is not yet settled');
    const closed = await f.lane.handle('channels/close', { channelId: 'terminal:cm' }, f.ctx);
    assert.deepEqual(closed, { closed: true });
    assert.equal(f.inside.opening.size, 0, 'the opening is abandoned');
    // What it held went a closed channel's way: a seat change is no lifecycle message, so it is settled as
    // owed to nobody here, and the cursor passes it. Dropped with the opening, it was never settled (the
    // house's read of the 33 commits, #22 comment 6307350861: the test passed with the release removed).
    await until(() => s.cursorsOf(A).delivered >= seat.seq, 3000, 'the held seat change settled as not owed');
    hold.release();
    const res = await opening;
    hold.restore();
    assert.ok(Array.isArray(res.history), 'the open still answers with its page');
    assert.equal(f.inside.open.has('terminal:cm'), false, 'and leaves the channel closed');
    await sleep(200);
    assert.ok(!f.sent.some((m) => m.method === 'channels/incoming'), 'nothing went on the closed channel');
  } finally {
    await f.close();
  }
});

test("a name forgotten and re-created while its channel's history is read: the gone life's held messages go nowhere, and the new life's open starts its own opening", { timeout: 20_000 }, async () => {
  // The endpoint's sessionRemoved lands after the name is re-created and returned early, leaving the old
  // opening and its held messages; the new life's open joined it, and finishOpening sent the gone life's
  // messages on the channel the name now names.
  const f = await bareLane('c-recreate', { removals: 'manual' });
  try {
    await f.app.sessionOpen(f.caller, { id: 'rc', visibility: 'shared' });
    const one = await f.settledRun('rc', 'echo one');
    const old = live(f.registry, 'rc');
    const hold = holdTranscripts(old, one);
    const first = f.lane.handle('channels/open', { channelId: 'terminal:rc', history: { limit: 5 } }, f.ctx);
    await hold.reached;
    old.journal.append({ type: 'control', controller: null, by: A, how: 'release' }); // the gone life's message, held
    await until(() => (f.inside.opening.get('terminal:rc')?.held.size ?? 0) >= 1, 3000, 'held for the opening channel');
    await f.app.sessionClose(f.caller, { session: 'rc', forget: true });
    await until(() => f.removed.includes('rc'), 3000, 'the name forgotten');
    await f.app.sessionOpen(f.caller, { id: 'rc', visibility: 'shared' });
    await f.lane.sessionRemoved('rc'); // the endpoint's call, landing after the re-creation
    assert.equal(f.inside.opening.size, 0, "the gone life's opening is dropped");
    await f.lane.handle('channels/open', { channelId: 'terminal:rc', history: { limit: 5 } }, f.ctx);
    assert.equal(f.inside.open.has('terminal:rc'), true, "the new life's channel is open");
    hold.release();
    await assert.rejects(first, (e: Error & { code?: number }) => e.code === -32023);
    hold.restore();
    await sleep(200);
    const controls = f.sent.filter((m) => m.method === 'channels/incoming').flatMap((m) => (m.params as { messages: Array<{ tags: string[] }> }).messages).filter((x) => x.tags.includes('terminal:control'));
    assert.equal(controls.length, 0, "the gone life's seat change never reached the new session's channel");
  } finally {
    await f.close();
  }
});

// ───────────── a reviewer's read of the fixes for #22 ─────────────

/** The seat changes that went out on channels, by message id. */
const channelControls = (sent: Msg[]): string[] =>
  sent
    .filter((m) => m.method === 'channels/incoming')
    .flatMap((m) => (m.params as { messages: Array<{ messageId: string; tags: string[] }> }).messages)
    .filter((x) => x.tags.includes('terminal:control'))
    .map((x) => x.messageId);

test("a close sent while an open channel's history is paged back stands, and the open or close that comes last decides", { timeout: 20_000 }, async () => {
  // A page read of a channel already open made no opening, so the close during it had nothing to mark, and
  // the read's return reopened the channel the host had closed.
  const f = await bareLane('c-close-page');
  try {
    await f.app.sessionOpen(f.caller, { id: 'cp', visibility: 'shared' });
    const one = await f.settledRun('cp', 'echo one');
    const s = live(f.registry, 'cp');
    const page = () => f.lane.handle('channels/open', { channelId: 'terminal:cp', history: { limit: 5 } }, f.ctx) as Promise<{ history?: unknown[] }>;
    await f.lane.handle('channels/open', { channelId: 'terminal:cp' }, f.ctx);
    assert.equal(f.inside.open.has('terminal:cp'), true, 'open');
    let hold = holdTranscripts(s, one);
    let paging = page();
    await hold.reached;
    assert.deepEqual(await f.lane.handle('channels/close', { channelId: 'terminal:cp' }, f.ctx), { closed: true });
    hold.release();
    const res = await paging;
    hold.restore();
    assert.ok(Array.isArray(res.history), 'the page read still answers with its page');
    assert.equal(f.inside.open.has('terminal:cp'), false, 'and leaves the channel closed');
    // An open after the close opens it; a close and then an open during a later read leave it open.
    await page();
    assert.equal(f.inside.open.has('terminal:cp'), true, 'a later open opens it');
    hold = holdTranscripts(s, one);
    paging = page();
    await hold.reached;
    await f.lane.handle('channels/close', { channelId: 'terminal:cp' }, f.ctx);
    await f.lane.handle('channels/open', { channelId: 'terminal:cp' }, f.ctx);
    hold.release();
    await paging;
    hold.restore();
    assert.equal(f.inside.open.has('terminal:cp'), true, 'the open after the close stands');
  } finally {
    await f.close();
  }
});

test("a re-created name's open never joins the forgotten life's opening, and the old life's removal landing late leaves the new life's opening and follow alone", { timeout: 20_000 }, async () => {
  // The new life's open joined the gone life's opening by name; a removal landing after the re-creation dropped
  // the opening by name, the new life's messages with it, and letGo unfollowed whatever life the name had then.
  const f = await bareLane('c-late-removal', { removals: 'manual' });
  try {
    await f.app.sessionOpen(f.caller, { id: 'lr', visibility: 'shared' });
    const one = await f.settledRun('lr', 'echo one');
    const old = live(f.registry, 'lr');
    const oldHold = holdTranscripts(old, one);
    const oldOpen = f.lane.handle('channels/open', { channelId: 'terminal:lr', history: { limit: 5 } }, f.ctx);
    await oldHold.reached;
    old.journal.append({ type: 'control', controller: null, by: A, how: 'release' }); // the gone life's message
    await until(() => (f.inside.opening.get('terminal:lr')?.held.size ?? 0) >= 1, 3000, 'held for the opening channel');
    await f.app.sessionClose(f.caller, { session: 'lr', forget: true });
    await until(() => f.removed.includes('lr'), 3000, 'the name forgotten');
    await f.app.sessionOpen(f.caller, { id: 'lr', visibility: 'shared' });
    const two = await f.settledRun('lr', 'echo two');
    const s2 = live(f.registry, 'lr');
    const newHold = holdTranscripts(s2, two);
    const newOpen = f.lane.handle('channels/open', { channelId: 'terminal:lr', history: { limit: 5 } }, f.ctx);
    await newHold.reached;
    s2.journal.append({ type: 'control', controller: null, by: A, how: 'release' }); // the new life's message
    const held = () => [...(f.inside.opening.get('terminal:lr')?.held.keys() ?? [])];
    await until(() => held().some((id) => id.includes(`~${s2.journal.epoch}:`)), 3000, "the new life's message held for its opening");
    assert.ok(held().every((id) => id.includes(`~${s2.journal.epoch}:`)), `the new life's opening is its own: ${held().join(', ')}`);
    await f.lane.sessionRemoved('lr'); // the old life's removal, landing late
    assert.equal(held().length, 1, "the new life's opening keeps what it held");
    assert.equal((f.inside.watched.get('lr') as { session: Session } | undefined)?.session, s2, 'the new life is still followed');
    oldHold.release();
    await assert.rejects(oldOpen, (e: Error & { code?: number }) => e.code === -32023);
    oldHold.restore();
    newHold.release();
    await newOpen;
    newHold.restore();
    assert.equal(f.inside.open.has('terminal:lr'), true, "the new life's channel is open");
    await until(() => channelControls(f.sent).length >= 1, 3000, "the new life's seat change on its channel");
    // A gone life's late message (a draining segmenter's, a hold that ran out) goes a closed channel's way, not on the open channel.
    const late = { kind: 'run', lifecycle: true, seq: 999, ts: Date.now(), messageId: `lr~${old.journal.epoch}:run:999`, tags: ['terminal:control'], head: '[terminal] lr: late', metadata: {}, interested: [] };
    f.inside.deliver(old, late, { released: true });
    await sleep(100);
    const ids = channelControls(f.sent);
    assert.deepEqual(ids.filter((id) => !id.includes(`~${s2.journal.epoch}:`)), [], `only the new life's messages reached its channel: ${ids.join(', ')}`);
  } finally {
    await f.close();
  }
});

test('without a byte cap the note budget keeps no sizes, only the rates apply; under a cap each retained note counts', async () => {
  // Every note was recorded, and without retention nothing is ever pruned: a pair per note for the daemon's life.
  const f = await bareLane('c-notes');
  try {
    const publish = (channel: string, text: string) => f.lane.handle('channels/publish', { channelId: channel, content: [{ type: 'text', text }] }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'nn', visibility: 'shared' });
    // What the budget keeps is memory, which no reply shows: the spec reads its list through the lane, as it reads the lane's other state.
    const kept = (session: string) => f.inside.budgetOf(live(f.registry, session).journal).retained.length;
    for (let i = 0; i < 4; i++) await publish('terminal:nn', `note ${i}`);
    assert.equal(kept('nn'), 0, 'no cap: nothing to evict, nothing kept');
    await f.app.sessionOpen(f.caller, { id: 'nc', visibility: 'shared', retention: { maxBytes: 64 * 1024 } });
    for (let i = 0; i < 2; i++) await publish('terminal:nc', `note ${i}`);
    assert.equal(kept('nc'), 2, 'a cap: each retained note counts');
  } finally {
    await f.close();
  }
});

// ───────────── the house's read of the 33 commits (PR #22, comment 6307350861) ─────────────

test("a note whose publish waits on the note budget's first count is refused when the grant is revoked or the name re-created meanwhile, and nothing is noted", { timeout: 20_000 }, async () => {
  // publish checked the grant and the session, awaited the budget's seed, then noted by the session's name:
  // a featureSets/update landing during the read had the note go out under a revoked grant, and a close and
  // re-creation of the name put it into the name's next life.
  const f = await bareLane('c-publish-await');
  try {
    const publish = (text: string) => f.lane.handle('channels/publish', { channelId: 'terminal:pa', content: [{ type: 'text', text }] }, f.ctx);
    const notes = (s: Session) => s.journal.since(0).events.flatMap((e) => (e.type === 'note' ? [e.text] : []));
    const retention = { maxBytes: 64 * 1024 }; // a byte cap: the budget counts the journal's notes first
    await f.app.sessionOpen(f.caller, { id: 'pa', visibility: 'shared', retention });
    const old = live(f.registry, 'pa');
    // The update is handled while the publish waits on its count (the call runs to its first await).
    const revoked = publish('under a revoked grant');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'channels.publish') }, f.ctx);
    await assert.rejects(revoked, (e: Error & { code?: number }) => e.code === -32002 && /channels\.publish not granted/.test(e.message));
    assert.deepEqual(notes(old), [], 'nothing noted under the revoked grant');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    const disabled = publish('with terminal.annotate disabled');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT, enabled: ['terminal.live', 'terminal.channels'] }, f.ctx);
    await assert.rejects(disabled, (e: Error & { code?: number }) => e.code === -32017 && /terminal\.annotate is not enabled/.test(e.message));
    assert.deepEqual(notes(old), []);
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    // The name forgotten and re-created while the count is read (held here until the new life exists).
    const budget = f.inside.budgetOf(old.journal);
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    const seed = budget.seed.bind(budget);
    budget.seed = async (j) => {
      await gate;
      return seed(j);
    };
    const moved = publish('into the next life');
    await f.app.sessionClose(f.caller, { session: 'pa', forget: true });
    await f.app.sessionOpen(f.caller, { id: 'pa', visibility: 'shared', retention });
    release();
    await assert.rejects(moved, (e: Error & { code?: number }) => e.code === -32023 && /session pa was closed or replaced while the session's notes were counted; nothing was published/.test(e.message));
    assert.deepEqual(notes(live(f.registry, 'pa')), [], "nothing noted in the name's next life");
    assert.deepEqual(notes(old), []);
    // And with nothing changed, the same publish goes in.
    assert.equal(((await publish('a note')) as { delivered: boolean }).delivered, true);
    assert.deepEqual(notes(live(f.registry, 'pa')), ['a note']);
  } finally {
    await f.close();
  }
});

test("an open whose history read sees the grant revoked opens nothing", { timeout: 20_000 }, async () => {
  // openChannel re-checked the disposal state and the session after its read, not the grant.
  const f = await bareLane('c-open-revoked');
  try {
    await f.app.sessionOpen(f.caller, { id: 'or2', visibility: 'shared' });
    const one = await f.settledRun('or2', 'echo one');
    const s = live(f.registry, 'or2');
    const hold = holdTranscripts(s, one);
    const opening = f.lane.handle('channels/open', { channelId: 'terminal:or2', history: { limit: 5 } }, f.ctx);
    await hold.reached;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'channels.lifecycle') }, f.ctx);
    hold.release();
    await assert.rejects(opening, (e: Error & { code?: number }) => e.code === -32002 && /channels\.lifecycle not granted/.test(e.message));
    hold.restore();
    assert.equal(f.inside.open.has('terminal:or2'), false, 'not open');
    assert.equal(f.inside.opening.size, 0, 'nothing left opening');
  } finally {
    await f.close();
  }
});

test('a close counts only for a channel open or opening: closes naming channels that are neither leave nothing behind', async () => {
  // Every close was counted, known channel or not, and an entry went only when its session closed.
  const f = await bareLane('c-close-count');
  try {
    for (let i = 0; i < 50; i++) assert.deepEqual(await f.lane.handle('channels/close', { channelId: `terminal:nobody-${i}` }, f.ctx), { closed: false });
    await f.app.sessionOpen(f.caller, { id: 'cc', visibility: 'shared' });
    await f.lane.handle('channels/close', { channelId: 'terminal:cc' }, f.ctx); // a session's, but not open
    assert.equal(f.inside.closes.size, 0, 'nothing counted');
    await f.lane.handle('channels/open', { channelId: 'terminal:cc' }, f.ctx);
    assert.deepEqual(await f.lane.handle('channels/close', { channelId: 'terminal:cc' }, f.ctx), { closed: true });
    assert.equal(f.inside.closes.get('terminal:cc'), 1, 'an open channel\'s close is counted, for a read that may be under way');
  } finally {
    await f.close();
  }
});

test("a batch queued for a forgotten life's open channel never goes on the channel of the life re-created under the name", { timeout: 20_000 }, async () => {
  // flush re-routes what no longer may go on a channel; only its lineage check stops a message the old life
  // queued before the name was forgotten and re-created, the channel still open (the endpoint's removal
  // not yet landed), from going out on the new life's channel. All the lane tests passed without it.
  const f = await bareLane('c-batch-lineage', { removals: 'manual' });
  const lane = f.inside;
  const flush = lane.flush.bind(f.lane);
  let release = () => undefined as void;
  const gate = new Promise<void>((r) => (release = r));
  let flushed = false;
  try {
    await f.app.sessionOpen(f.caller, { id: 'bl', visibility: 'shared' });
    await f.lane.handle('channels/open', { channelId: 'terminal:bl' }, f.ctx);
    const old = live(f.registry, 'bl');
    lane.flush = async () => {
      await gate;
      await flush();
      flushed = true;
    };
    old.journal.append({ type: 'control', controller: null, by: A, how: 'release' }); // the old life's message
    await until(() => lane.batch.length >= 1, 3000, "the old life's seat change queued for the open channel");
    await f.app.sessionClose(f.caller, { session: 'bl', forget: true });
    await until(() => f.removed.includes('bl'), 3000, 'the name forgotten');
    await f.app.sessionOpen(f.caller, { id: 'bl', visibility: 'shared' });
    assert.equal(lane.open.has('terminal:bl'), true, 'the channel is still open: the removal has not landed');
    release();
    await until(() => flushed, 3000, 'the batch flushed');
    const ids = f.sent
      .filter((m) => m.method === 'channels/incoming')
      .flatMap((m) => (m.params as { messages: Array<{ messageId: string }> }).messages)
      .map((x) => x.messageId);
    assert.deepEqual(ids.filter((id) => id.includes(`~${old.journal.epoch}:`)), [], `nothing of the forgotten life on the channel: ${ids.join(', ')}`);
  } finally {
    release();
    lane.flush = flush;
    await f.close();
  }
});

// ───────────── the house's read of the 40 commits (PR #22) ─────────────

test("a closed or forgotten channel whose name another principal re-created as private is removed for this host, never described", { timeout: 20_000 }, async () => {
  // The server announces a created session only to a connection that may observe it, but a close to every one:
  // sessionClosed read the name again after its drain and sent this host an update describing B's private
  // session, and sessionRemoved returned early on the re-created name and left the channel registered.
  for (const how of ['closed', 'removed'] as const) {
    const f = await bareLane(`c-unseen-${how}`, { announce: false });
    try {
      const id = `u${how[0]}`;
      await f.app.sessionOpen(f.caller, { id, visibility: 'shared' });
      f.lane.sessionCreated(id); // the server's announcement to A, who may observe it
      assert.equal(f.inside.registered.has(`terminal:${id}`), true);
      await f.app.sessionClose(f.caller, { session: id, forget: true });
      await f.app.sessionOpen({ principal: B, connectionId: 'b' }, { id, visibility: 'private' }); // never announced to A
      f.sent.length = 0;
      if (how === 'closed') await f.lane.sessionClosed(id);
      else await f.lane.sessionRemoved(id);
      const changes = f.sent.filter((m) => m.method === 'channels/changed').map((m) => m.params as { updated?: Array<{ id: string }>; removed?: string[] });
      assert.deepEqual(changes.flatMap((c) => c.updated ?? []), [], `no update describes B's private session (${how})`);
      assert.deepEqual(changes.flatMap((c) => c.removed ?? []), [`terminal:${id}`], `the channel is removed for A (${how})`);
      assert.equal(f.inside.registered.has(`terminal:${id}`), false);
    } finally {
      await f.close();
    }
  }
});

test("a note budget whose first count failed counts again at the next note, and a lane disposed during the count publishes nothing", { timeout: 20_000 }, async () => {
  // NoteBudget.seed kept its first count's promise whether it resolved or failed: one page that could not be
  // read refused every later note on the lineage until the daemon restarted.
  const f = await bareLane('c-seed-fails');
  try {
    const publish = (text: string) => f.lane.handle('channels/publish', { channelId: 'terminal:sf', content: [{ type: 'text', text }] }, f.ctx);
    const notes = (s: Session) => s.journal.since(0).events.flatMap((e) => (e.type === 'note' ? [e.text] : []));
    await f.app.sessionOpen(f.caller, { id: 'sf', visibility: 'shared', retention: { maxBytes: 64 * 1024 } });
    const s = live(f.registry, 'sf');
    f.app.note(f.caller, { session: 'sf', text: 'an earlier note' }); // counted only by the seed
    // The count fails after it has counted its first page (Ambrose-2449's shape: failing before any page,
    // it had nothing to forget, and the spec passed with the counts kept).
    const journal = s.journal as Journal & { pages: Journal['pages'] };
    const pages = journal.pages.bind(journal);
    let failures = 1;
    journal.pages = function* (...a: Parameters<Journal['pages']>) {
      const it = pages(...a);
      const first = it.next();
      if (first.done) return;
      if (failures-- > 0) {
        yield { ...first.value, more: true };
        throw new Error('EIO: the second page could not be read');
      }
      yield first.value;
      yield* it;
    } as Journal['pages'];
    await assert.rejects(publish('during the failure'), /EIO: the second page could not be read/);
    assert.equal(((await publish('after it')) as { delivered: boolean }).delivered, true, 'the next note counts again and goes in');
    assert.deepEqual(notes(s), ['an earlier note', 'after it']);
    assert.equal(f.inside.budgetOf(s.journal).retained.length, 2, 'each note counted once: the failed count left nothing counted twice');
    const budget = f.inside.budgetOf(s.journal) as unknown as { retained: Array<[number, number]>; bytes: number };
    assert.equal(budget.bytes, budget.retained.reduce((n, [, b]) => n + b, 0), "the byte count is the retained notes' bytes: the failed count's went with its entries (the house's read of 4f4c067, #22)");
  } finally {
    await f.close();
  }
  // The re-check after the count covers a lane disposed while it ran.
  const g = await bareLane('c-seed-disposed');
  try {
    await g.app.sessionOpen(g.caller, { id: 'sd', visibility: 'shared', retention: { maxBytes: 64 * 1024 } });
    const s = live(g.registry, 'sd');
    const budget = g.inside.budgetOf(s.journal);
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    const seed = budget.seed.bind(budget);
    budget.seed = async (j) => {
      await gate;
      return seed(j);
    };
    const pending = g.lane.handle('channels/publish', { channelId: 'terminal:sd', content: [{ type: 'text', text: 'never' }] }, g.ctx);
    g.lane.dispose();
    release();
    await assert.rejects(pending, /the connection closed while the session's notes were counted; nothing was published/);
    assert.deepEqual(s.journal.since(0).events.filter((e) => e.type === 'note'), []);
  } finally {
    await g.close();
  }
});

// ───────────── the house's read of 4f4c067 (PR #22) ─────────────

test("a catch-up retires a refused fold summary that nothing carried, so the completions it stood for are sent and the cursor passes them", { timeout: 60_000 }, async () => {
  // A fold made while push events were off kept its summary with no retry entry: with push back on and the host
  // accepting, the cursor stayed below three completions that were never sent, for the life of the connection.
  const was = McplLane.retryMax;
  McplLane.retryMax = 4;
  const f = await bareLane('c-retire-fold');
  try {
    await f.app.sessionOpen(f.caller, { id: 'rf' });
    const s = live(f.registry, 'rf');
    const st = () => f.inside.states.get('rf')!;
    f.refuse.value = true;
    f.late.value = true;
    const ends: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await f.app.run(f.caller, { session: 'rf', command: `echo rf-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
      ends.push(s.run(r.runId!).seq.end!);
    }
    await until(() => f.pending.length >= 6, 5000, 'six completions pushed and held');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'pushEvents') }, f.ctx);
    for (const p of f.pending.splice(0)) p.answer();
    await until(() => [...st().summaries.values()].some((x) => x.folded), 5000, 'the refusals to fold');
    assert.equal(f.lane.carries('rf'), false);
    const folded = [...st().summaries.values()].find((x) => x.folded)!.folded!.count;
    assert.ok(folded >= 1, 'some completions were folded while nothing carried the session');
    const from = f.sent.length;
    f.refuse.value = false;
    f.late.value = false;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 10_000, 'the cursor to pass every completion');
    assert.equal(st().summaries.size, 0, 'the fold summary is retired, not left pinning the cursor');
    const pushedAfter = f.sent.slice(from).filter((m) => m.method === 'push/event').map((m) => (m.params as { eventId: string }).eventId);
    for (const end of ends) assert.ok(pushedAfter.some((id) => id.endsWith(`:run:${end}`)), `the completion at ${end} is sent once push events are back`);
    assert.ok(!pushedAfter.some((id) => /:summary~refused-/.test(id)), 'the retired summary is not sent beside the completions it counted');
  } finally {
    McplLane.retryMax = was;
    await f.close();
  }
});

test("a catch-up that retires a refused catch-up summary retires the seq it owed, so a gap's end that retention moved past doesn't pin the cursor", { timeout: 90_000 }, async () => {
  // A catch-up's summary owes its own seq, here the end of the gone range. Retired without it, that seq stayed
  // owed once retention moved past it: the next scan's gap ended later, nothing had the old seq, and the cursor
  // stayed below it for the life of the connection (Ambrose-2449's read of the retirement).
  const f = await bareLane('c-retire-owes');
  try {
    const st = () => f.inside.states.get('ro')!;
    const noPush = FULL_GRANT.filter((c) => c !== 'pushEvents');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'ro', retention: { maxBytes: 16 * 1024 } });
    const s = live(f.registry, 'ro');
    const flood = async () => {
      for (let i = 0; i < 4; i++) await f.app.run(f.caller, { session: 'ro', command: 'seq 1 2000', target: 'process', wait: 10_000 });
    };
    await flood();
    assert.ok((s.journal.oldestSeq ?? 1) > 1, 'retention took the start of the journal');
    f.refuse.value = true;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => [...st().summaries.values()].some((x) => !x.folded), 10_000, "the catch-up's summary of the gone range");
    const owed = [...st().summaries.values()].find((x) => !x.folded)!.owes!;
    assert.ok(st().owed.has(owed), 'the summary owes its own seq');
    await flood();
    assert.ok((s.journal.oldestSeq ?? 1) > owed + 1, `retention moved past the seq the summary owes (${owed}; oldest now ${s.journal.oldestSeq})`);
    const last = await f.app.run(f.caller, { session: 'ro', command: 'echo ro-last', target: 'process', wait: 5000 });
    const lastEnd = s.run(last.runId!).seq.end!;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    f.refuse.value = false;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => s.cursorsOf(A).delivered >= lastEnd, 15_000, `the cursor to pass the last completion (owed ${JSON.stringify([...st().owed])}, delivered ${s.cursorsOf(A).delivered})`);
  } finally {
    await f.close();
  }
});

test("a catch-up's summary of a lost range covers the debts in it, so completions retention took before a scan, or after a refused summary covered them, don't pin the cursor", { timeout: 90_000 }, async () => {
  // Debts nothing carries have no retry of their own. Those retention took before any catch-up lay in the range the
  // scan reported lost, and those a refused summary covered were left there once a catch-up retired it and retention
  // took them: no summary covered either, and the cursor stayed below them for the life of the connection (the
  // house's read of a8b6f28, #22: by run). A connection that can't carry the session drops each debt whose message it
  // meets with nothing to carry it on, so a debt nothing carries is one whose message is still to be built. The first ones are stood in for by hand, after the grant's regain and before its activation's catch-up.
  const f = await bareLane('c-lost-covered');
  try {
    const st = () => f.inside.states.get('rc')!;
    const noPush = FULL_GRANT.filter((c) => c !== 'pushEvents');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'rc', retention: { maxBytes: 16 * 1024 } });
    const s = live(f.registry, 'rc');
    const ended = async (command: string): Promise<number> => {
      const r = await f.app.run(f.caller, { session: 'rc', command, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 10_000, `${command} to end`);
      return s.run(r.runId!).seq.end!;
    };
    // Until retention has taken an owed completion: how many Runs that takes depends on the platform's event sizes
    // (a Linux run.start carries startTicks and bootId), so the spec counts what was taken, not Runs.
    const owedFirst: number[] = [];
    const goneNow = () => owedFirst.filter((seq) => seq < (s.journal.oldestSeq ?? 1));
    for (let i = 0; i < 400 && (owedFirst.length < 25 || goneNow().length < 1); i++) owedFirst.push(await ended(`echo rc-${i}`));
    const gone = goneNow();
    assert.ok(gone.length > 0, `retention took some owed completions before any catch-up (oldest ${s.journal.oldestSeq}, ${owedFirst.length} Runs)`);
    // The host takes the replayed completions and refuses the summary of the rest.
    const eventId = (req: { params?: unknown }) => (req.params as { eventId?: string } | undefined)?.eventId ?? '';
    f.refuse.value = true;
    f.refuse.only = (req) => req.method === 'push/event' && /:summary[:~]/.test(eventId(req));
    const later: Array<() => void> = [];
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, { isRequest: true, after: (fn: () => void) => later.push(fn) });
    for (const seq of owedFirst) st().owed.add(seq);
    for (const fn of later) fn();
    await until(() => [...st().summaries.values()].some((x) => !x.folded && x.covered.size > 0), 10_000, "the catch-up's summary covering omitted completions");
    const covered = [...[...st().summaries.values()].find((x) => !x.folded && x.covered.size > 0)!.covered];
    const refused = eventId(f.sent.find((m) => m.method === 'push/event' && /:summary[:~]/.test(eventId(m)))!);
    await until(() => f.inside.catchingUp === undefined, 5000, 'the first catch-up to finish');
    // More output than retention keeps, each Run's completion pushed and taken as it ends.
    for (let i = 0; i < 4; i++) await ended('seq 1 2000');
    assert.ok((s.journal.oldestSeq ?? 1) > Math.max(...covered), `retention took the covered completions (${JSON.stringify(covered)}; oldest now ${s.journal.oldestSeq})`);
    const lastEnd = await ended('echo rc-last');
    // Only the old summary is refused now: the next catch-up retires it, and the host takes what replaces it.
    f.refuse.only = (req) => req.method === 'push/event' && eventId(req) === refused;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => s.cursorsOf(A).delivered >= lastEnd, 15_000, `the cursor to pass the last completion (owed ${JSON.stringify([...st().owed].slice(0, 12))}, gone before the scan ${JSON.stringify(gone)}, covered ${JSON.stringify(covered)}, delivered ${s.cursorsOf(A).delivered})`);
  } finally {
    await f.close();
  }
});

test("a catch-up whose scan fails retires nothing: the refused fold summary still pins the cursor, and the next catch-up sends what it stood for", { timeout: 60_000 }, async () => {
  // Retired before the scan, a scan that threw left the summary gone and the floor lowered, so delivered could
  // pass the completions it stood for and nothing would scan them again (the house's read of a8b6f28, #22).
  const was = McplLane.retryMax;
  McplLane.retryMax = 4;
  const f = await bareLane('c-retire-fail');
  try {
    await f.app.sessionOpen(f.caller, { id: 'rx' });
    const s = live(f.registry, 'rx');
    const st = () => f.inside.states.get('rx')!;
    f.refuse.value = true;
    f.late.value = true;
    const ends: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await f.app.run(f.caller, { session: 'rx', command: `echo rx-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
      ends.push(s.run(r.runId!).seq.end!);
    }
    await until(() => f.pending.length >= 6, 5000, 'six completions pushed and held');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'pushEvents') }, f.ctx);
    for (const p of f.pending.splice(0)) p.answer();
    await until(() => [...st().summaries.values()].some((x) => x.folded), 5000, 'the refusals to fold');
    const folded = [...st().summaries.keys()];
    f.refuse.value = false;
    f.late.value = false;
    // The next catch-up's scan fails at its first page.
    const journal = s.journal as Journal & { pages: Journal['pages'] };
    const pages = journal.pages.bind(journal);
    let failures = 1;
    journal.pages = function* (...a: Parameters<Journal['pages']>) {
      if (failures-- > 0) throw new Error('EIO: the store could not be read');
      yield* pages(...a);
    } as Journal['pages'];
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => f.logs.some((l) => /catch-up failed: EIO/.test(l)), 5000, 'the catch-up failure logged');
    assert.deepEqual([...st().summaries.keys()].filter((k) => folded.includes(k)), folded, 'the fold summary still stands');
    assert.ok(s.cursorsOf(A).delivered < Math.min(...ends), `the cursor stays below the folded completions (delivered ${s.cursorsOf(A).delivered})`);
    await f.inside.startCatchUp(['rx']);
    await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 10_000, 'the cursor to pass every completion once a catch-up scans');
  } finally {
    McplLane.retryMax = was;
    await f.close();
  }
});

/** A session with a refused fold summary standing over six completions, as the failed-scan spec makes one. */
async function foldedSession(f: Awaited<ReturnType<typeof bareLane>>, id: string) {
  await f.app.sessionOpen(f.caller, { id });
  const s = live(f.registry, id);
  const st = () => f.inside.states.get(id)!;
  f.refuse.value = true;
  f.late.value = true;
  const ends: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await f.app.run(f.caller, { session: id, command: `echo ${id}-${i}`, target: 'process', wait: 0 });
    await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
    ends.push(s.run(r.runId!).seq.end!);
  }
  await until(() => f.pending.length >= 6, 5000, 'six completions pushed and held');
  await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'pushEvents') }, f.ctx);
  for (const p of f.pending.splice(0)) p.answer();
  await until(() => [...st().summaries.values()].some((x) => x.folded), 5000, 'the refusals to fold');
  f.refuse.value = false;
  f.late.value = false;
  return { s, st, ends, folded: [...st().summaries.keys()] };
}

/** At a session's next scan's first page, runs `at` (or throws, with no `at`). */
function onFirstPage(s: Session, at?: () => void): void {
  const journal = s.journal as Journal & { pages: Journal['pages'] };
  const pages = journal.pages.bind(journal);
  let first = true;
  journal.pages = function* (...a: Parameters<Journal['pages']>) {
    if (first) {
      first = false;
      if (!at) throw new Error('EIO: the store could not be read');
      at();
    }
    yield* pages(...a);
  } as Journal['pages'];
}

test("a catch-up retires no session's summaries until every session's scan has returned", { timeout: 90_000 }, async () => {
  // Retired as each session's own scan returned, the first session's summary was gone when the second's scan threw,
  // with the floor lowered (the house's read of 4860d4c, #22).
  const was = McplLane.retryMax;
  McplLane.retryMax = 4;
  const f = await bareLane('c-retire-two');
  try {
    const a = await foldedSession(f, 'ra');
    await f.app.sessionOpen(f.caller, { id: 'rb' });
    const b = live(f.registry, 'rb');
    await f.app.run(f.caller, { session: 'rb', command: 'echo rb', target: 'process', wait: 0 });
    onFirstPage(b);
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => f.logs.some((l) => /catch-up failed: EIO/.test(l)), 5000, 'the catch-up failure logged');
    assert.deepEqual([...a.st().summaries.keys()].filter((k) => a.folded.includes(k)), a.folded, "the first session's fold summary still stands");
    assert.ok(a.s.cursorsOf(A).delivered < Math.min(...a.ends), `its cursor stays below the folded completions (delivered ${a.s.cursorsOf(A).delivered})`);
  } finally {
    McplLane.retryMax = was;
    await f.close();
  }
});

test("a catch-up leaves a summary that went in flight during its scan, and one made during it", { timeout: 60_000 }, async () => {
  // The plan-time list is rechecked at retirement, and holds only what stood at plan time (the house's read of 4860d4c, #22).
  const was = McplLane.retryMax;
  McplLane.retryMax = 4;
  const f = await bareLane('c-retire-during');
  try {
    const a = await foldedSession(f, 'rd');
    const planned = a.folded[0]!;
    onFirstPage(a.s, () => {
      a.st().inflight.set(planned, a.ends[0]!);
      a.st().summaries.set('made-during-the-scan', { from: a.ends[0]!, covered: new Set() });
    });
    f.late.value = true;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => f.inside.catchingUp === undefined, 10_000, 'the catch-up to finish');
    assert.ok(a.st().summaries.has(planned), 'the summary in flight by retirement still stands');
    assert.ok(a.st().summaries.has('made-during-the-scan'), 'the summary made during the scan still stands');
    f.late.value = false;
    for (const p of f.pending.splice(0)) p.answer();
  } finally {
    McplLane.retryMax = was;
    await f.close();
  }
});

test("a summary's acceptance or retirement leaves its own seq owed while another message carries it, not its own retry or parked copy, and carried() reads only this lineage's opening", { timeout: 30_000 }, async () => {
  // Its own seq, a gap's end, can be a message still retried; settled with the summary, delivered could pass it and
  // its refusal was settled as accepted. Another lineage's opening holds another journal's seqs (the house's read of 4860d4c, #22).
  const f = await bareLane('c-own-seq');
  try {
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'pushEvents') }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'ro' });
    const s = live(f.registry, 'ro');
    const r = await f.app.run(f.caller, { session: 'ro', command: 'echo ro', target: 'process', wait: 0 });
    await until(() => s.run(r.runId!).seq.end !== undefined, 5000, 'the Run to end');
    const st = f.inside.states.get('ro')! as unknown as { owed: Set<number>; retries: Map<string, unknown>; summaries: Map<string, unknown> };
    const x = s.run(r.runId!).seq.end!;
    st.owed.add(x);
    st.retries.set('a-retried-completion', { seq: x, kind: 'run', attempt: 0 });
    st.summaries.set(`${NODE_NAME}/ro-gap-summary`, { from: 1, covered: new Set(), owes: x });
    f.inside.settleSegment(s, { kind: 'summary', lifecycle: true, seq: x, messageId: 'ro-gap-summary' }, 'accepted');
    assert.ok(st.owed.has(x), 'the retried completion is still owed after the summary is accepted');
    // Retired by a catch-up, the same: its owed seq stays while the retried message carries it.
    st.summaries.set(`${NODE_NAME}/ro-retired-summary`, { from: 1, covered: new Set(), owes: x });
    f.inside.retireSummaries(s, st, [`${NODE_NAME}/ro-retired-summary`]);
    assert.ok(st.owed.has(x), 'the retried completion is still owed after the summary is retired');
    st.retries.delete('a-retried-completion');
    // Its own retry and parked copy carry its seq too: retired, they go with it, and so does the debt (a reviewer's
    // run: asked before they went, a summary ever refused or parked kept its seq owed whatever else carried it).
    const own = `${NODE_NAME}/ro-own-summary`;
    st.summaries.set(own, { from: 1, covered: new Set(), owes: x });
    st.retries.set(own, { seq: x, kind: 'summary', attempt: 0 });
    (f.inside.opening as unknown as Map<string, unknown>).set('terminal:ro', { lineage: (s.journal as unknown as { runs: unknown }).runs, held: new Map([[own, { t: s, seg: { seq: x, lifecycle: true } }]]) });
    f.inside.retireSummaries(s, st, [own]);
    (f.inside.opening as unknown as Map<string, unknown>).delete('terminal:ro');
    assert.ok(!st.owed.has(x), 'retired with only its own retry and parked copy carrying its seq, the debt goes');
    // An opening parks a message at the same seq number: counted when it is this lineage's lifecycle message, not when
    // it is another lineage's, nor when it is ambient, which is neither retried nor owed (the house's lean on #22's lane
    // questions).
    const openings = f.inside.opening as unknown as Map<string, unknown>;
    const parked = new Map([['other', { t: s, seg: { seq: x, lifecycle: true } }]]);
    openings.set('terminal:ro', { lineage: (s.journal as unknown as { runs: unknown }).runs, held: parked });
    assert.ok(f.inside.carried(s, st).has(x), "this lineage's parked seq is carried");
    openings.set('terminal:ro', { lineage: {}, held: parked });
    assert.ok(!f.inside.carried(s, st).has(x), "another lineage's parked seq is not carried here");
    openings.set('terminal:ro', { lineage: (s.journal as unknown as { runs: unknown }).runs, held: new Map([['ambient', { t: s, seg: { seq: x, lifecycle: false } }]]) });
    assert.ok(!f.inside.carried(s, st).has(x), 'a parked ambient message carries no debt');
    openings.delete('terminal:ro');
    // On a lane that carries the session, the summary's acceptance lifts the cursor to just below the seq still
    // carried: what it settled is passed, what still goes out is not (the house's read of 4860d4c..bc4bc85, #22).
    const lane = f.inside as unknown as { carries: (id: string) => boolean };
    lane.carries = () => true;
    st.summaries.clear();
    st.owed.clear();
    st.owed.add(x);
    st.retries.set('a-carrier', { seq: x, kind: 'run', attempt: 0 });
    st.summaries.set(`${NODE_NAME}/ro-carried-summary`, { from: 1, covered: new Set(), owes: x });
    f.inside.settleSegment(s, { kind: 'summary', lifecycle: true, seq: x, messageId: 'ro-carried-summary' }, 'accepted');
    assert.equal(s.cursorsOf(A).delivered, x - 1, 'delivered rises to just below the carried seq');
    st.retries.delete('a-carrier');
    delete (lane as { carries?: unknown }).carries;
  } finally {
    await f.close();
  }
});

test("a catch-up keeps a summary whose delivery is still in flight, which settles by its answer", { timeout: 60_000 }, async () => {
  // Retired while its push awaited the host's answer, an accepted summary would settle nothing it covered.
  const f = await bareLane('c-retire-inflight');
  try {
    const noPush = FULL_GRANT.filter((c) => c !== 'pushEvents');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'ri' });
    const s = live(f.registry, 'ri');
    const st = () => f.inside.states.get('ri')!;
    const ends: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await f.app.run(f.caller, { session: 'ri', command: `echo ri-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
      ends.push(s.run(r.runId!).seq.end!);
    }
    // Past the catch-up's limit of 20, the oldest five are summarised; every push waits for the host's answer.
    f.late.value = true;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    const summaryPushed = () => f.pending.find((p) => /:summary[:~]/.test((p.req.params as { eventId?: string }).eventId ?? ''));
    await until(() => summaryPushed() !== undefined, 10_000, "the catch-up's summary pushed and held");
    const id = [...st().summaries.keys()][0]!;
    assert.ok(st().inflight.has(id), 'the summary is in flight');
    // A catch-up of its own, not the first one's still running: that one planned before the summary existed.
    await until(() => f.inside.catchingUp === undefined, 5000, 'the first catch-up to finish');
    await f.inside.startCatchUp(['ri']);
    assert.ok(st().summaries.has(id), 'a catch-up meanwhile keeps the summary in flight');
    f.late.value = false;
    for (const p of f.pending.splice(0)) p.answer();
    await until(() => s.cursorsOf(A).delivered >= Math.max(...ends), 10_000, 'the cursor to pass every completion');
    assert.equal(st().summaries.size, 0, 'the summary settled by its answer');
    const pushes = f.sent.filter((m) => m.method === 'push/event' && /:summary[:~]/.test((m.params as { eventId?: string }).eventId ?? ''));
    assert.equal(pushes.length, 1, 'the host heard of the summary once: the catch-up neither retired it nor sent it again');
  } finally {
    await f.close();
  }
});

test("a catch-up's summary leaves out a past-the-cap completion that a message of its own still carries, which stays owed and retried after the summary's acceptance", { timeout: 60_000 }, async () => {
  // Covered, the summary's acceptance settled the completion's debt and dropped its retry, so a refusal of the message
  // still carrying it was neither retried nor owed (the house's read of 4860d4c..bc4bc85, #22).
  const f = await bareLane('c-cap-carried');
  try {
    const noPush = FULL_GRANT.filter((c) => c !== 'pushEvents');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'cc' });
    const s = live(f.registry, 'cc');
    const st = () => f.inside.states.get('cc')! as unknown as { owed: Set<number>; retries: Map<string, unknown>; summaries: Map<string, { covered: Set<number> }> };
    const ends: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await f.app.run(f.caller, { session: 'cc', command: `echo cc-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `Run ${i} to end`);
      ends.push(s.run(r.runId!).seq.end!);
    }
    // Debts nothing carries when the catch-up plans, stood in for by hand after the grant's regain and before its
    // activation's catch-up (see the lost-range spec above). The oldest is past the catch-up's limit of 20, and a
    // message of its own still carries it: a retry waiting on its timer.
    const carriedSeq = ends[0]!;
    f.late.value = true;
    const later: Array<() => void> = [];
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, { isRequest: true, after: (fn: () => void) => later.push(fn) });
    for (const seq of ends) st().owed.add(seq);
    const waiting = setTimeout(() => undefined, 60_000);
    st().retries.set('cc-carrier', { seq: carriedSeq, kind: 'run', attempt: 0, timer: waiting });
    for (const fn of later) fn();
    await until(() => st().summaries.size === 1, 10_000, "the catch-up's summary");
    const [summary] = [...st().summaries.values()];
    assert.ok(summary!.covered.has(ends[1]!), 'a past-the-cap completion nothing else carries is covered');
    assert.ok(!summary!.covered.has(carriedSeq), 'the carried one is not');
    f.late.value = false;
    for (const p of f.pending.splice(0)) p.answer();
    await until(() => st().summaries.size === 0, 10_000, 'the summary settled by its answer');
    assert.ok(st().owed.has(carriedSeq), 'the carried completion is still owed after the summary is accepted');
    assert.ok(st().retries.has('cc-carrier'), 'and its own message is still retried');
    assert.ok(s.cursorsOf(A).delivered < carriedSeq, `the cursor stays below it (delivered ${s.cursorsOf(A).delivered})`);
    clearTimeout(waiting);
    st().retries.delete('cc-carrier');
  } finally {
    await f.close();
  }
});

test("a catch-up retires a summary parked for an opening channel, so the open sends only what replaced it", { timeout: 60_000 }, async () => {
  // A summary parked while the channel's history was read had no in-flight, sent or retry entry: retired, it
  // still went out when the open finished, beside the summary that replaced it (the house's read of a8b6f28, #22).
  const f = await bareLane('c-retire-opening');
  try {
    const noPush = FULL_GRANT.filter((c) => c !== 'pushEvents');
    await f.lane.handle('featureSets/update', { effectiveCapabilities: noPush }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'ro2', visibility: 'shared' });
    const s = live(f.registry, 'ro2');
    const ended = async (command: string): Promise<string> => {
      const r = await f.app.run(f.caller, { session: 'ro2', command, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 5000, `${command} to end`);
      return r.runId!;
    };
    const runs: string[] = [];
    for (let i = 0; i < 25; i++) runs.push(await ended(`echo ro2-${i}`));
    // The open's history reads every Run; the hold is on the oldest, which a catch-up only counts in its summary.
    const hold = holdTranscripts(s, runs[0]);
    const opening = f.lane.handle('channels/open', { channelId: 'terminal:ro2', history: { limit: 40 } }, f.ctx);
    await hold.reached;
    const held = () => [...(f.inside.opening.get('terminal:ro2')?.held.keys() ?? [])].filter((k) => /:summary[:~]/.test(k));
    // Push events carry the session again: the catch-up's summary is parked for the opening channel.
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => held().length === 1, 5000, "the first catch-up's summary parked for the opening");
    const first = held()[0]!;
    await until(() => f.inside.catchingUp === undefined, 5000, 'the first catch-up to finish');
    // Two more completions: the next catch-up omits more, so its summary ends later, under another id.
    for (let i = 0; i < 2; i++) await ended(`echo ro2-more-${i}`);
    await f.inside.startCatchUp(['ro2']);
    assert.ok(!held().includes(first), `the retired summary is no longer parked (${held().join(', ')})`);
    assert.equal(held().length, 1, 'only the summary that replaced it is parked');
    hold.release();
    await opening;
    hold.restore();
    await sleep(300);
    const summaries = new Set(f.sent.filter((m) => m.method === 'channels/incoming').flatMap((m) => (m.params as { messages: Array<{ messageId: string }> }).messages.map((x) => x.messageId)).filter((x) => /:summary[:~]/.test(x)));
    assert.equal(summaries.size, 1, `one summary went on the channel: ${[...summaries].join(', ')}`);
  } finally {
    await f.close();
  }
});

test("a catch-up's summary of a lost range leaves out a debt a held message still carries", { timeout: 60_000 }, async () => {
  // A completion held for a synchronous result (G28) goes out when its hold runs out. Covered by a summary of the
  // range retention took, the summary's acceptance let the cursor pass it, and the host's refusal of it was then
  // settled as accepted (a reviewer's read of the fixes for #22). The hold is stood in for by its entry.
  const f = await bareLane('c-lost-held');
  try {
    const st = () => f.inside.states.get('rh')!;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'pushEvents') }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'rh', retention: { maxBytes: 16 * 1024 } });
    const s = live(f.registry, 'rh');
    // Until retention has taken two owed completions, however many Runs the platform's event sizes need.
    const ends: number[] = [];
    const goneNow = () => ends.filter((seq) => seq < (s.journal.oldestSeq ?? 1));
    for (let i = 0; i < 400 && (ends.length < 25 || goneNow().length < 2); i++) {
      const r = await f.app.run(f.caller, { session: 'rh', command: `echo rh-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 10_000, `Run ${i} to end`);
      ends.push(s.run(r.runId!).seq.end!);
    }
    const gone = goneNow();
    assert.ok(gone.length >= 2, `retention took at least two owed completions (${JSON.stringify(gone)}; oldest ${s.journal.oldestSeq}, ${ends.length} Runs)`);
    // Debts nothing carries when the catch-up plans, stood in for by hand after the grant's regain and before its
    // activation's catch-up (see the lost-range spec above).
    f.late.value = true;
    const later: Array<() => void> = [];
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, { isRequest: true, after: (fn: () => void) => later.push(fn) });
    for (const seq of ends) st().owed.add(seq);
    st().held.set('rh-held', { since: performance.now(), seq: gone[0]! });
    for (const fn of later) fn();
    await until(() => [...st().summaries.values()].some((x) => !x.folded), 10_000, "the catch-up's summary");
    const covered = [...st().summaries.values()].find((x) => !x.folded)!.covered;
    assert.ok(!covered.has(gone[0]!), `the held completion's debt is not covered (${JSON.stringify([...covered])})`);
    assert.ok(gone.slice(1).every((seq) => covered.has(seq)), `the other gone completions are (${JSON.stringify([...covered])}, gone ${JSON.stringify(gone)})`);
    assert.ok(st().owed.has(gone[0]!), 'the held completion is still owed');
    f.late.value = false;
    for (const p of f.pending.splice(0)) p.answer();
  } finally {
    await f.close();
  }
});

test("a catch-up drops what a retired summary covered that its scan owes no more, so the cursor passes it", { timeout: 60_000 }, async () => {
  // A debt owed only while the session's channel was open is owed no more once it closes, and the rescan neither
  // replays nor covers it. Kept after its summary was retired, it pinned the cursor for the life of the connection
  // (a reviewer's read of the fixes for #22). The spec stands in for it with an output event's seq, which no scan owes.
  const f = await bareLane('c-retire-unowed');
  try {
    const st = () => f.inside.states.get('rn')!;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'pushEvents') }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'rn' });
    const s = live(f.registry, 'rn');
    let lastEnd = 0;
    for (let i = 0; i < 3; i++) {
      const r = await f.app.run(f.caller, { session: 'rn', command: `echo rn-${i}`, target: 'process', wait: 0 });
      await until(() => s.run(r.runId!).seq.end !== undefined, 10_000, `Run ${i} to end`);
      lastEnd = s.run(r.runId!).seq.end!;
    }
    const out = s.journal.since(0).events.find((e) => e.type === 'output')!.seq;
    st().owed.add(out);
    st().summaries.set('rn-retired-summary', { from: out, covered: new Set([out]) });
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => s.cursorsOf(A).delivered >= lastEnd, 10_000, `the cursor to pass the last completion (owed ${JSON.stringify([...st().owed])}, delivered ${s.cursorsOf(A).delivered})`);
    assert.ok(!st().owed.has(out), 'the debt the scan owes no more is dropped');
  } finally {
    await f.close();
  }
});

test("a forgotten name's late settlement writes nothing into the cursors.json of the life re-created under it", { timeout: 60_000 }, async () => {
  // The old life's book was cancelled but still took a late acceptance's cursors and wrote them over the
  // re-created name's file: {delivered: 61} for a journal at seq 7, which a restart read for the new life.
  const f = await bareLane('c-late-forgotten');
  try {
    await f.app.sessionOpen(f.caller, { id: 'lf' });
    const old = live(f.registry, 'lf');
    for (let i = 0; i < 8; i++) await f.app.run(f.caller, { session: 'lf', command: `echo old-${i}`, target: 'process', wait: 5000 });
    f.late.value = true;
    const r = await f.app.run(f.caller, { session: 'lf', command: 'echo old-last', target: 'process', wait: 0 });
    await until(() => old.run(r.runId!).seq.end !== undefined, 5000, "the old life's last Run to end");
    await until(() => f.pending.length >= 1, 5000, 'its completion pushed and held');
    await f.app.sessionClose(f.caller, { session: 'lf', forget: true });
    f.late.value = false;
    await f.app.sessionOpen(f.caller, { id: 'lf' });
    const neu = live(f.registry, 'lf');
    assert.notEqual(neu, old);
    const file = path.join(f.registry['root' as never] as unknown as string, 'lf', 'cursors.json');
    const onDisk = (): number | undefined => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { delivered: number }>)[A]?.delivered : undefined);
    // The new life's book has written the file, so a file the old book overwrote is told from one never written
    // (read as 0, an absent file passed whether or not the stale write landed: the house's read of a8b6f28, #22).
    await until(() => onDisk() !== undefined && onDisk() === neu.cursorsOf(A).delivered, 5000, "the new life's book to write its own cursors");
    for (const p of f.pending.splice(0)) p.answer();
    await until(() => old.cursorsOf(A).delivered > neu.journal.lastSeq, 5000, 'the late acceptance to reach the old life');
    // Past the old book's write delay: its timer was set before this one, so it fires first under any load.
    await sleep(1500);
    const now = onDisk();
    assert.ok(now !== undefined && now <= neu.journal.lastSeq, `the file holds the new life's cursors, not the old life's ${old.cursorsOf(A).delivered} (read ${now}, new life at seq ${neu.journal.lastSeq})`);
  } finally {
    await f.close();
  }
});

// ───────────── a lane owes only what it can carry (the house's lean on Imago's two lane questions, #22) ─────────────

/** Another connection of `f`'s principal on the same App, with a host that accepts, or refuses deliveries while `refuse.value`. */
async function secondLane(f: Awaited<ReturnType<typeof bareLane>>, connection: string, grant: string[]) {
  const sent: Msg[] = [];
  const refuse = { value: false };
  const refusal = (req: Msg): unknown =>
    req.method === 'push/event'
      ? { accepted: false, reason: 'queue_full' }
      : { results: (req.params as { messages: Array<{ messageId: string }> }).messages.map((x) => ({ messageId: x.messageId, accepted: false, reason: 'queue_full' })) };
  const out: Outbound = new Outbound((m) => {
    const req = m as Msg;
    sent.push(req);
    if (req.method === undefined || req.id === undefined) return;
    const result = refuse.value && (req.method === 'push/event' || req.method === 'channels/incoming') ? refusal(req) : TestHost.accept(req);
    setImmediate(() => out.handleResponse({ jsonrpc: '2.0', id: req.id!, result } as never));
  });
  const lane = new McplLane(f.app, { principal: A, connectionId: connection }, out, () => undefined);
  f.registry.onChange((c) => {
    if (c.type === 'created') lane.sessionCreated(c.id);
  });
  await lane.handle('featureSets/update', { effectiveCapabilities: grant }, f.ctx);
  return { lane, sent, refuse, inside: lane as unknown as Awaited<ReturnType<typeof bareLane>>['inside'] };
}

/** The deliveries a lane's host was sent about a Run: push events and channel messages. */
const sentAbout = (sent: Msg[], runId: string): Msg[] =>
  sent.filter((m) => {
    if (m.method === 'push/event') return (m.params as { origin: Record<string, unknown> }).origin.runId === runId;
    if (m.method === 'channels/incoming') return (m.params as { messages: Array<{ metadata: Record<string, unknown> }> }).messages.some((x) => x.metadata.runId === runId);
    return false;
  });

const NO_PUSH = FULL_GRANT.filter((c) => c !== 'pushEvents');

test("a connection that can't carry a session owes it nothing, so another connection of the principal moves the cursor past what it delivers", { timeout: 30_000 }, async () => {
  // Owed on lineage alone, each completion the second connection could only push into a refusal pinned the first
  // connection's cursor, and its owed set grew for as long as it lived (Imago's question on #22, comment 6355747725).
  const f = await bareLane('nc-push');
  try {
    await f.app.sessionOpen(f.caller, { id: 'nc' });
    const s = live(f.registry, 'nc');
    const g = await secondLane(f, 'nc-channels', NO_PUSH);
    try {
      for (let i = 0; i < 3; i++) {
        const r = await f.app.run(f.caller, { session: 'nc', command: `echo nc-${i}`, target: 'process', wait: 0 });
        await until(() => s.run(r.runId!).seq.end !== undefined && s.cursorsOf(A).delivered >= s.run(r.runId!).seq.end!, 5000, `completion ${i} pushed and the cursor past it`);
      }
      assert.equal(g.inside.states.get('nc')?.owed.size ?? 0, 0, 'the connection that cannot carry the session owes it nothing');
    } finally {
      g.lane.dispose();
    }
  } finally {
    await f.close();
  }
});

test("a completion refused on a channel that then closed doesn't hold the cursor of the connection that delivers it, and what that delivered is paid when the channel reopens", { timeout: 30_000 }, async () => {
  const f = await bareLane('lc-push');
  try {
    await f.app.sessionOpen(f.caller, { id: 'lc' });
    const s = live(f.registry, 'lc');
    const g = await secondLane(f, 'lc-channels', NO_PUSH);
    try {
      await g.lane.openChannel({ channelId: 'terminal:lc' });
      f.refuse.value = true;
      g.refuse.value = true;
      const r = await f.app.run(f.caller, { session: 'lc', command: 'echo lc-refused', target: 'process', wait: 0 });
      const runId = r.runId!;
      await until(() => sentAbout(g.sent, runId).length >= 1 && sentAbout(f.sent, runId).length >= 1, 5000, 'the completion sent on both connections and refused');
      await until(() => [...(g.inside.states.get('lc')?.retries.values() ?? [])].some((x) => x.kind === 'run'), 5000, "the channel's refusal retried");
      g.lane.closeChannel('terminal:lc');
      await sleep(800); // the channel's retry fires with nothing to carry it on
      f.refuse.value = false;
      const end = s.run(runId).seq.end!;
      await until(() => s.cursorsOf(A).delivered >= end, 5000, 'pushed again and accepted: the cursor passes it, the closed channel counting for nothing');
      // Its retry went, with its debt, when its timer found nothing to carry it on: reopened, the channel owes nothing.
      g.refuse.value = false;
      await g.lane.openChannel({ channelId: 'terminal:lc' });
      const next = await f.app.run(f.caller, { session: 'lc', command: 'echo lc-next', target: 'process', wait: 0 });
      await until(() => s.run(next.runId!).seq.end !== undefined && s.cursorsOf(A).delivered >= s.run(next.runId!).seq.end!, 5000, 'the next completion delivered and the cursor past it');
      assert.ok(![...g.inside.states.get('lc')!.retries.values()].some((x) => x.kind === 'run'), 'no stranded retry is left');
    } finally {
      g.lane.dispose();
    }
  } finally {
    await f.close();
  }
});

test("a completion queued on a channel that closed before it went out leaves no debt to hold the cursor, then or when the channel reopens", { timeout: 30_000 }, async () => {
  const f = await bareLane('lb-push');
  try {
    await f.app.sessionOpen(f.caller, { id: 'lb' });
    const s = live(f.registry, 'lb');
    const g = await secondLane(f, 'lb-channels', NO_PUSH);
    try {
      await g.lane.openChannel({ channelId: 'terminal:lb' });
      await until(() => g.inside.catchingUp === undefined, 4000, "the channel's catch-up to finish");
      // The channel closes as the completion is queued on it, once the lane, subscribed first, has queued it: the
      // flush then finds nothing to carry it on, and the debt goes with it, the cursor staying where it is.
      let closed = false;
      const off = f.app.segmenter(s).subscribe((x) => {
        if (x.kind !== 'run' || closed) return;
        closed = true;
        g.lane.closeChannel('terminal:lb');
      });
      const r = await f.app.run(f.caller, { session: 'lb', command: 'echo lb-closed', target: 'process', wait: 0 });
      await until(() => closed && g.inside.batch.length === 0, 5000, 'the channel closed and its queued message routed again');
      off();
      const end = s.run(r.runId!).seq.end!;
      const gst = g.inside.states.get('lb')!;
      assert.ok(!gst.owed.has(end) && !g.inside.carried(s, gst).has(end), 'the closed channel owes it no more, and nothing of its own carries it');
      await until(() => s.cursorsOf(A).delivered >= end, 5000, 'pushed and accepted: the cursor passes it, the closed channel counting for nothing');
      await g.lane.openChannel({ channelId: 'terminal:lb' });
      const next = await f.app.run(f.caller, { session: 'lb', command: 'echo lb-next', target: 'process', wait: 0 });
      await until(() => s.run(next.runId!).seq.end !== undefined && s.cursorsOf(A).delivered >= s.run(next.runId!).seq.end!, 5000, 'the next completion delivered and the cursor past it');
    } finally {
      g.lane.dispose();
    }
  } finally {
    await f.close();
  }
});

test("a retry that fired onto a channel closed before its flush leaves neither the debt nor the retry", { timeout: 20_000 }, async () => {
  // Fired with the lane carrying, a retry keeps its entry, with no timer, until an answer settles it. Sent back from
  // the batch to the refused settle when the channel closed before the flush, that entry still counted as carrying
  // the seq, so the debt stayed, and the entry could never fire again (Abigail-2459's read of the drops).
  const f = await bareLane('rf');
  try {
    await f.lane.handle('featureSets/update', { effectiveCapabilities: NO_PUSH }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'rf' });
    const s = live(f.registry, 'rf');
    await f.lane.openChannel({ channelId: 'terminal:rf' });
    await until(() => f.inside.catchingUp === undefined, 4000, "the channel's catch-up to finish");
    const st = () => f.inside.states.get('rf')!;
    f.refuse.value = true;
    const r = await f.app.run(f.caller, { session: 'rf', command: 'echo rf', target: 'process', wait: 0 });
    const runId = r.runId!;
    await until(() => [...st().retries.values()].some((x) => x.kind === 'run'), 5000, 'the completion refused on the channel and retried');
    f.refuse.value = false;
    // When the retry's timer sends the completion onto the channel, the channel closes before the batch flushes.
    const lane = f.lane as unknown as { deliver: (t: Session, seg: { kind?: string; runId?: string }, o?: { released?: boolean }) => void };
    const deliver = lane.deliver.bind(f.lane);
    let closed = false;
    lane.deliver = (t, seg, o) => {
      deliver(t, seg, o);
      if (!closed && seg.kind === 'run' && seg.runId === runId && f.inside.batch.length > 0) {
        closed = true;
        f.lane.closeChannel('terminal:rf');
      }
    };
    try {
      await until(() => closed && f.inside.batch.length === 0, 5000, 'the retry sent onto the channel, the channel closed, and the flush sent it back');
    } finally {
      delete (lane as { deliver?: unknown }).deliver;
    }
    assert.ok(![...st().retries.values()].some((x) => x.kind === 'run'), 'no retry is left');
    assert.ok(!st().owed.has(s.run(runId).seq.end!), 'nor its debt');
  } finally {
    await f.close();
  }
});

test("a debt owed only while a channel was open, which no catch-up finds owed after it closed, goes when the connection carries the session again", { timeout: 30_000 }, async () => {
  // Another principal's completion is owed only on an open channel. Refused there, its retry's timer then found the
  // channel closed, and the debt stayed: kept at a grant's regain above `delivered`, it was never owed again by the
  // catch-up, scanning with the channel closed, and once the lane counted again it held the cursor below it for good
  // (Abigail-2459's read of the regain).
  const f = await bareLane('oo-a');
  try {
    await f.lane.handle('featureSets/update', { effectiveCapabilities: NO_PUSH }, f.ctx);
    const other = { principal: B, connectionId: 'oo-b' };
    await f.app.sessionOpen(other, { id: 'oo', visibility: 'shared' });
    const s = live(f.registry, 'oo');
    await f.lane.openChannel({ channelId: 'terminal:oo' });
    await until(() => f.inside.catchingUp === undefined, 4000, "the channel's catch-up to finish");
    f.refuse.value = true;
    const r = await f.app.run(other, { session: 'oo', command: 'echo theirs', target: 'process', wait: 0 });
    await until(() => [...(f.inside.states.get('oo')?.retries.values() ?? [])].some((x) => x.kind === 'run'), 5000, 'their completion refused on the channel and retried');
    f.lane.closeChannel('terminal:oo');
    await sleep(800); // the retry fires with nothing to carry it on
    f.refuse.value = false;
    const end = s.run(r.runId!).seq.end!;
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, f.ctx);
    await until(() => f.inside.catchingUp === undefined && s.cursorsOf(A).delivered >= end, 5000, `the cursor past it once push carries the session (delivered ${s.cursorsOf(A).delivered}, owed ${JSON.stringify([...(f.inside.states.get('oo')?.owed ?? [])])})`);
    assert.equal(sentAbout(f.sent, r.runId!).filter((m) => m.method === 'push/event').length, 0, 'never pushed: it is not this principal\'s');
  } finally {
    await f.close();
  }
});

test("a connection that couldn't carry a session regains it as its channel's open begins: a completion the open finishes settled doesn't lift the cursor past one it no longer owed", { timeout: 20_000 }, async () => {
  // Owing nothing while it could not carry the session, the lane has no floor there: without the pin, the first
  // settle after the open would lift `delivered` past the earlier completion before any catch-up pinned the session
  // (Abigail-2459's read of the house's lean on #22's shared cursor).
  const d = await daemon();
  try {
    const a = await d.host('ta', 'rg-a', { grant: NO_PUSH });
    await a.call('session_open', { session: 'rg' });
    const page = await a.call('run', { session: 'rg', command: 'echo rg-page' }); // a Run for the page to render
    const s = live(d.registry, 'rg');
    // A Run's message has reached the lane, subscribed first, once it reaches this listener: recorded whenever it
    // comes, since under load it can come before the run call's answer does. Waited on by its end alone, the Run's
    // message could come a moment later, during the open, and be parked and sent like any other.
    const built = new Set<unknown>();
    const off = d.app.segmenter(s).subscribe((x) => {
      if (x.kind === 'run') built.add(x.runId);
    });
    const unowed = await a.call('run', { session: 'rg', command: 'echo rg-unowed', wait: 0 });
    const unowedId = unowed.structured!.runId as string;
    await until(() => built.has(unowedId), 10_000, 'the Run to end, and its message to reach the lane, while nothing carries the session');
    const hold = holdTranscripts(s, page.structured?.runId);
    const opening = a.request('channels/open', { channelId: 'terminal:rg', history: { limit: 10 } });
    await hold.reached;
    // A Run that ends while the open reads is parked for the channel; its outcome then returned to an `await`, the
    // open's finish settles it at once.
    const parked = await a.call('run', { session: 'rg', command: 'sleep 0.2; echo rg-parked', wait: 0 });
    const parkedId = parked.structured!.runId as string;
    await until(() => s.run(parkedId).seq.end !== undefined, 10_000, 'the parked Run to end');
    await until(() => built.has(parkedId), 10_000, "the parked Run's message to reach the lane");
    off();
    await a.call('await', { runId: parkedId });
    hold.release();
    await opening;
    hold.restore();
    const got = await a.delivery(aboutRun(unowedId), 4000);
    assert.equal(got.via, 'incoming', 'the completion it no longer owed is found by the catch-up, on the channel');
    await a.close();
  } finally {
    await d.stop();
  }
});

test("a grant that lets a connection carry a session again pins it until the activation's catch-up: what settles before that doesn't lift the cursor past a completion it no longer owed", { timeout: 20_000 }, async () => {
  const f = await bareLane('rg-grant');
  try {
    await f.lane.handle('featureSets/update', { effectiveCapabilities: NO_PUSH }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'rw' });
    const s = live(f.registry, 'rw');
    const r = await f.app.run(f.caller, { session: 'rw', command: 'echo rw-unowed', target: 'process', wait: 0 });
    await until(() => s.run(r.runId!).seq.end !== undefined, 5000, 'the Run to end while nothing carries the session');
    await sleep(100);
    // The activation runs after the receipt is on the wire, as the endpoint's `after` does; meanwhile the live path settles.
    const later: Array<() => void> = [];
    await f.lane.handle('featureSets/update', { effectiveCapabilities: FULL_GRANT }, { isRequest: true, after: (fn: () => void) => later.push(fn) });
    const note = f.app.note(f.caller, { session: 'rw', text: 'a note before the activation' });
    const st = f.inside.states.get('rw') as unknown as { clearTo: number };
    await until(() => st.clearTo >= note.seq, 4000, 'the note settled as owed to nobody');
    for (const fn of later) fn();
    await until(() => sentAbout(f.sent, r.runId!).length >= 1, 4000, 'the completion pushed by the catch-up');
  } finally {
    await f.close();
  }
});

test("a regain pin set while a catch-up scans the session is the next catch-up's to release, not that one's", { timeout: 20_000 }, async () => {
  const f = await bareLane('rg-scan');
  try {
    await f.lane.handle('featureSets/update', { effectiveCapabilities: NO_PUSH }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'rs' });
    const s = live(f.registry, 'rs');
    const r = await f.app.run(f.caller, { session: 'rs', command: 'echo rs', target: 'process', wait: 0 });
    await until(() => s.run(r.runId!).seq.end !== undefined, 5000, 'the Run to end');
    const st = () => f.inside.states.get('rs') as unknown as { regainPin?: { at: number } };
    const hold = holdTranscripts(s, r.runId);
    let during: { at: number } | undefined;
    // In the middle of the open's catch-up scan, the channel closes and opens again: regained a second time, on the
    // next microtask, once the scanning catch-up is recorded as running, so the reopen's catch-up is queued behind it.
    let running = false;
    onFirstPage(s, () => {
      queueMicrotask(() => {
        running = f.inside.catchingUp !== undefined;
        f.lane.closeChannel('terminal:rs');
        void f.lane.openChannel({ channelId: 'terminal:rs' });
        during = st().regainPin;
      });
    });
    await f.lane.openChannel({ channelId: 'terminal:rs' });
    await hold.reached; // the first catch-up is past its scan, sending what it found
    assert.ok(running, 'the reopen came while the first catch-up ran');
    assert.ok(during !== undefined, 'the reopen pinned the session');
    assert.equal(st().regainPin, during, "the catch-up that was scanning when it was set leaves it");
    hold.release();
    hold.restore();
    await until(() => st().regainPin === undefined && f.inside.catchingUp === undefined, 5000, 'the queued catch-up releases it');
    await until(() => sentAbout(f.sent, r.runId!).length >= 1, 4000, 'the completion on the channel');
  } finally {
    await f.close();
  }
});

test("an ambient message carries no debt: a summary whose own seq it shares settles that seq when accepted", { timeout: 20_000 }, async () => {
  // Counted as carrying it, an ambient message refused, which is neither retried nor settled, left the summary's own
  // seq owed with nothing to carry it (the house's lean on #22's lane questions).
  const f = await bareLane('amb');
  try {
    await f.lane.handle('featureSets/update', { effectiveCapabilities: NO_PUSH }, f.ctx);
    await f.app.sessionOpen(f.caller, { id: 'am' });
    const s = live(f.registry, 'am');
    await f.lane.openChannel({ channelId: 'terminal:am' });
    await until(() => f.inside.catchingUp === undefined && f.inside.batch.length === 0, 4000, 'the open to settle');
    const x = s.journal.lastSeq;
    const st = f.inside.states.get('am')!;
    f.late.value = true;
    const ambient = `am-ambient-${x}`;
    f.inside.deliver(s, { kind: 'output', lifecycle: false, seq: x, ts: Date.now(), messageId: ambient, tags: ['terminal:output'], head: '[terminal] am: output', metadata: {}, interested: [] }, { released: true });
    await until(() => f.pending.length >= 1, 4000, 'the ambient message in flight');
    assert.ok(st.inflight.has(`${NODE_NAME}/${ambient}`), 'in flight');
    st.owed.add(x);
    st.summaries.set(`${NODE_NAME}/am-gap-summary`, { from: 1, covered: new Set(), owes: x });
    f.inside.settleSegment(s, { kind: 'summary', lifecycle: true, seq: x, messageId: 'am-gap-summary' }, 'accepted');
    assert.ok(!st.owed.has(x), "the summary's acceptance settles its own seq");
    f.late.value = false;
    for (const p of f.pending.splice(0)) p.answer();
  } finally {
    await f.close();
  }
});
