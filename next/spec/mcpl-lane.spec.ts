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
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { CORE_TOOLS } from '../src/api/tools.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import type { SegmenterOptions } from '../src/core/segmenter.js';
import { seqOfMessageId } from '../src/core/segmenter.js';
import type { Session } from '../src/core/session.js';
import { Outbound, type Message } from '../src/transport/jsonrpc.js';
import { FEATURE_SETS, manifest, McplLane, NODE_NAME } from '../src/transport/mcpl.js';
import { TermServer } from '../src/transport/server.js';
import { FULL_GRANT, TestHost, sleep, until, type Delivery, type Msg } from './testhost.js';

const A = 'agent:a@test';
const B = 'agent:b@test';

const aboutRun = (runId: unknown) => (d: Delivery) => d.metadata.runId === runId && d.tags.some((t) => t === 'terminal:run-finished' || t === 'terminal:run-lost');

async function daemon(o: { dataDir?: string; segmenter?: SegmenterOptions } = {}) {
  const dataDir = o.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-lane-'));
  const registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
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
    assert.doesNotMatch(rd.text, /not retained/);
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
    s.journal.append({ type: 'control', controller: null, by: A, how: 'release' });
    // Revoke channels.incoming while its message waits in the batch.
    lane.updatePolicy({ effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'channels.incoming') }, 'request');
    const mark = sent.length;
    await sleep(200);
    const after = sent.slice(mark).filter((m) => (m as Msg).method === 'channels/incoming');
    assert.equal(after.length, 0, 'nothing on channels/incoming after the reduction');
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
      assert.equal(seqOfMessageId(x.messageId), Number(/:(\d+)$/.exec(x.messageId)![1]), x.messageId);
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
