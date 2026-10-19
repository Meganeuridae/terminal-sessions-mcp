/**
 * G13 on a real shell: GUIs attaching while bash floods the terminal each get a
 * snapshot at N and exactly the events after N, and rebuild the daemon's screen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import xterm from '@xterm/headless';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import type { JournalEvent } from '../src/core/types.js';
import { TermServer } from '../src/transport/server.js';
import { sleep } from './testhost.js';

const { Terminal } = xterm;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pty-attach-'));
let registry: SessionRegistry;
let server: TermServer;
let port = 0;

before(async () => {
  registry = new SessionRegistry({ dataDir, backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  server = new TermServer({ app: new App({ registry, defaultWaitMs: 5000 }), resolver: new TokenMapResolver({ tokens: { ta: 'agent:a@test', tb: 'agent:b@test' } }), host: '127.0.0.1', port: 0 });
  port = (await server.listen()).port;
});

after(async () => {
  await server.close();
  await registry.closeAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Msg = { id?: number; method?: string; params?: { session: string; event: JournalEvent }; result?: unknown; error?: { message: string } };

async function client(token: string): Promise<{ request(method: string, params: unknown): Promise<unknown>; events: JournalEvent[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  let id = 0;
  const pending = new Map<number, (m: Msg) => void>();
  const events: JournalEvent[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    if (m.method === 'terminal/event' && m.params) events.push(m.params.event);
    else if (m.id !== undefined) pending.get(m.id)?.(m);
  });
  return {
    events,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}


test('G13 (real bash): attaching during a flood gives snapshot + exactly the later events, which rebuild the screen', async () => {
  const owner = await client('ta');
  await owner.request('tools/call', { name: 'session_open', arguments: { session: 'flood', visibility: 'shared', cols: 80, rows: 20 } });
  // Each viewer attaches before the producer is released into its next block. A timed
  // pause cannot guarantee this on a loaded runner: every viewer could arrive after exit.
  const cmd = `stty -echo; pad==================================================; for i in $(seq 1 1200); do printf '\\033[3%dmrow %d %s\\033[0m\\n' $((i%8)) $i "\${pad:0:$((i%50))}"; if [ $((i%300)) -eq 0 ]; then printf 'PHASE-%d\\n' $((i/300)); IFS= read -r next; fi; done; stty echo; printf '\\033[5;5HMARK'`;
  const run = (await owner.request('tools/call', { name: 'run', arguments: { session: 'flood', command: cmd, wait: 0 } })) as { structuredContent: { runId: string } };
  const s = registry.get('flood');
  assert.ok(s && s.kind === 'live');
  const viewers: Array<{ c: Awaited<ReturnType<typeof client>>; snap: { data: string; cols: number; rows: number; seq: number } }> = [];
  for (let k = 0; k < 4; k++) {
    const phase = `PHASE-${k + 1}`;
    const received = () => s.session.journal.since(0).events.filter((e) => e.type === 'output').map((e) => (e as { data: string }).data).join('').includes(phase);
    const deadline = Date.now() + 10_000;
    while (!received() && Date.now() < deadline) await sleep(10);
    assert.ok(received(), `${phase} reached the daemon before attaching`);
    const c = await client('tb');
    const r = (await c.request('terminal/attach', { session: 'flood' })) as { snapshot: { data: string; cols: number; rows: number; seq: number } };
    viewers.push({ c, snap: r.snapshot });
    await owner.request('tools/call', { name: 'input', arguments: { session: 'flood', text: '\n' } });
  }
  await owner.request('tools/call', { name: 'await', arguments: { session: 'flood', runId: run.structuredContent.runId, wait: 30_000 } });
  await sleep(300);
  await s.session.screen.settled();
  const last = s.session.journal.lastSeq;
  const expected = s.session.snapshot().lines.map((l) => l.replace(/\s+$/, ''));
  assert.ok(expected.some((l) => l.includes('MARK')), expected.join('\n'));
  const firstSnap = viewers[0]!.snap.seq;
  assert.ok(viewers.some((v) => v.snap.seq > firstSnap), 'the viewers attached at different points of the flood');
  for (const [k, { c, snap }] of viewers.entries()) {
    const end = Date.now() + 10_000;
    while ((c.events.at(-1)?.seq ?? snap.seq) < last && Date.now() < end) await sleep(20);
    const seqs = c.events.map((e) => e.seq).filter((q) => q <= last);
    assert.equal(seqs[0], snap.seq + 1, `viewer ${k}: first event follows the snapshot`);
    assert.equal(seqs.length, last - snap.seq, `viewer ${k}: no hole and no duplicate between ${snap.seq} and ${last}`);
    assert.ok(seqs.every((q, i) => q === snap.seq + 1 + i), `viewer ${k}: contiguous`);
    const t = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true });
    await new Promise<void>((r) => t.write(snap.data, r));
    for (const e of c.events) if (e.seq <= last && e.type === 'output') await new Promise<void>((r) => t.write(e.data, r));
    const buf = t.buffer.active;
    const got: string[] = [];
    for (let y = 0; y < t.rows; y++) got.push((buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
    assert.deepEqual(got, expected, `viewer ${k} (snapshot at ${snap.seq}) rebuilds the screen`);
    t.dispose();
  }
  for (const v of viewers) v.c.close();
  owner.close();
});
