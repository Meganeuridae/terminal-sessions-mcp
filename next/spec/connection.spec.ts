import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { serveConnection } from '../src/endpoint/connection.js';
import { helloLine, parseDaemonHello, type ClientHello } from '../src/endpoint/hello.js';
import { Host } from '../src/tools/host.js';
import type { OpenOptions } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

const DAEMON = { version: '2.0.0', pid: 777, startedAt: Date.parse('2026-11-08T13:00:00.000Z'), socket: '/run/user/1000/terminal-sessions/other.sock' };

interface Client {
  send(m: unknown): void;
  next(pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  order: Array<Record<string, unknown>>;
  daemonHello: string;
  close(): void;
}

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-conn-'));
  const socket = path.join(dir, 's.sock');
  const sessions: FakeSession[] = [];
  const host = new Host({
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      sessions.push(s);
      return s;
    },
    shell: '/bin/bash', env: {}, sessionsDir: dir, startedAt: DAEMON.startedAt,
  });
  const stops: string[] = [];
  const server = net.createServer((c) => serveConnection(c, host, DAEMON, (why) => stops.push(why)));
  await new Promise<void>((r) => server.listen(socket, r));
  const clients: net.Socket[] = [];
  const connect = (hello: ClientHello | string): Promise<Client> =>
    new Promise((resolve) => {
      const c = net.connect(socket);
      clients.push(c);
      c.on('error', () => {});
      let buf = '';
      let first: string | undefined;
      const messages: Array<Record<string, unknown>> = [];
      const order: Array<Record<string, unknown>> = [];
      const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; from: number }> = [];
      let nextId = 1;
      const client: Client = {
        messages,
        order,
        get daemonHello() {
          return first ?? '';
        },
        send: (m) => c.write(`${JSON.stringify(m)}\n`),
        next: (pred) =>
          new Promise((res, rej) => {
            const hit = messages.find(pred);
            if (hit) {
              messages.splice(messages.indexOf(hit), 1);
              return res(hit);
            }
            const w = { pred, resolve: (m: Record<string, unknown>) => (clearTimeout(t), res(m)), from: 0 };
            const t = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error('no such message within 3 s'));
            }, 3000);
            waiters.push(w);
          }),
        request: (method, params) => {
          const id = nextId++;
          client.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
          return client.next((m) => m.id === id && !('method' in m));
        },
        close: () => c.destroy(),
      };
      c.on('data', (b) => {
        buf += b;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (first === undefined) {
            first = line;
            resolve(client);
            continue;
          }
          const m = JSON.parse(line) as Record<string, unknown>;
          order.push(m);
          const w = waiters.find((x) => x.pred(m));
          if (w) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(m);
          } else messages.push(m);
        }
      });
      c.on('connect', () => c.write(typeof hello === 'string' ? hello : helloLine(hello)));
    });
  return {
    host, sessions, connect, stops,
    done: async () => {
      for (const c of clients) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const relayHello = (scope = 'a', version = '2.0.0'): ClientHello => ({ version, scope, client: 'relay' });
const MCPL_INIT = { protocolVersion: '2025-06-18', capabilities: { experimental: { mcpl: { version: '0.5', eventCoalescing: true } } }, clientInfo: { name: 'af', version: '1' } };
const GRANT = { effectiveCapabilities: ['tools', 'pushEvents'], enabled: ['terminal.tools', 'terminal.events'] };

test('H1: the daemon greets with its hello, and refuses a connection whose first message is not a hello', async () => {
  const h = await harness();
  try {
    const c = await h.connect('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    assert.deepEqual(parseDaemonHello(c.daemonHello), { version: '2.0.0', pid: 777, startedAt: '2026-11-08T13:00:00.000Z' });
    const err = await c.next(() => true);
    assert.match(String((err.error as { message: string }).message), /the first message on this socket must be terminal-sessions\/hello/);
  } finally {
    await h.done();
  }
});

test('H4: a client of another version is told so in initialize\'s instructions', async () => {
  const h = await harness();
  try {
    const old = await h.connect(relayHello('a', '1.9.0'));
    const r = await old.request('initialize', MCPL_INIT);
    assert.match(String((r.result as { instructions: string }).instructions), /daemon is version 2\.0\.0, running since 2026-11-08T13:00:00\.000Z, and the relay that reached it is 1\.9\.0/);
    assert.match(String((r.result as { instructions: string }).instructions), /restarting it is for whoever runs it to choose: `tsm --socket \/run\/user\/1000\/terminal-sessions\/other\.sock daemon stop`, then any call/);
    const same = await h.connect(relayHello('a', '2.0.0'));
    const r2 = await same.request('initialize', MCPL_INIT);
    assert.doesNotMatch(String((r2.result as { instructions: string }).instructions), /relay that reached it/);
  } finally {
    await h.done();
  }
});

test('H6: a plain MCP client lists the nine tools and calls them in its scope', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('mine'));
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const list = await c.request('tools/list');
    assert.deepEqual((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name), ['open', 'run', 'send', 'look', 'read', 'stop', 'integrate', 'list', 'close']);
    const r = await c.request('tools/call', { name: 'open', arguments: { name: 'main', cwd: '/srv' } });
    assert.match(String(((r.result as { content: Array<{ text: string }> }).content[0]!).text), /^\[main · at the prompt · \/srv\]/);
    const listed = await h.host.call({ scope: 'mine', takes: false, pushes: false }, 'list', {});
    assert.deepEqual((listed.structured.sessions as Array<{ name: string }>).map((s) => s.name), ['main']);
  } finally {
    await h.done();
  }
});

test('H8: pushes start only once a grant enables terminal.events, after its receipt, with coalesce.key when the host coalesces; accepted, the end is seen', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    await c.request('initialize', MCPL_INIT);
    await c.request('tools/call', { name: 'open', arguments: { name: 'main' } });
    const s = h.sessions[0]!;
    s.runMode = 'run';
    await c.request('tools/call', { name: 'run', arguments: { name: 'main', command: 'sleep 1', wait: 0 } });
    s.end(0);
    await c.request('ping');
    assert.equal(c.messages.filter((m) => m.method === 'push/event').length, 0, 'no push before a grant');

    const receipt = await c.request('featureSets/update', GRANT);
    assert.equal((receipt.result as { accepted: boolean }).accepted, true);
    await c.request('tools/call', { name: 'run', arguments: { name: 'main', command: 'sleep 2', wait: 0 } });
    s.end(0);
    const push = await c.next((m) => m.method === 'push/event');
    const p = push.params as { featureSet: string; tags: string[]; coalesce: { key: string }; payload: { content: Array<{ text: string }> } };
    assert.equal(p.featureSet, 'terminal.events');
    assert.deepEqual(p.tags, ['terminal:ended']);
    assert.deepEqual(p.coalesce, { key: 'a/main/2' });
    assert.match(p.payload.content[0]!.text, /^\[main · command 2 · exit 0 · /);
    c.send({ jsonrpc: '2.0', id: push.id, result: { accepted: true } });
    await c.request('ping');
    const unseen = (await h.host.call({ scope: 'a', takes: false, pushes: false }, 'list', {})).structured.unseen as string[];
    assert.equal(unseen.length, 1, 'only the end before the grant is still unseen');
    assert.match(unseen[0]!, /^\[main · command 1 · exit 0 · /);
  } finally {
    await h.done();
  }
});

test('H8: without eventCoalescing a push carries no coalesce, and a CLI connection is never pushed to', async () => {
  const h = await harness();
  try {
    const agent = await h.connect(relayHello('a'));
    await agent.request('initialize', { protocolVersion: '2025-06-18', capabilities: { experimental: { mcpl: { version: '0.5' } } } });
    await agent.request('featureSets/update', GRANT);
    const person = await h.connect({ version: '2.0.0', scope: 'a', client: 'cli' });
    await person.request('initialize', MCPL_INIT);
    await person.request('featureSets/update', GRANT);
    await agent.request('tools/call', { name: 'open', arguments: { name: 'main' } });
    const s = h.sessions[0]!;
    s.runMode = 'run';
    await agent.request('tools/call', { name: 'run', arguments: { name: 'main', command: 'x', wait: 0 } });
    s.end(0);
    const push = await agent.next((m) => m.method === 'push/event');
    assert.equal('coalesce' in (push.params as object), false);
    await person.request('ping');
    assert.equal(person.messages.filter((m) => m.method === 'push/event').length, 0);
  } finally {
    await h.done();
  }
});

test('H8: a grant without the tools capability lists no tools and refuses calls', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    await c.request('initialize', MCPL_INIT);
    await c.request('featureSets/update', { effectiveCapabilities: ['pushEvents'], enabled: ['terminal.events'] });
    const changed = await c.next((m) => m.method === 'notifications/tools/list_changed');
    assert.ok(changed);
    assert.deepEqual((await c.request('tools/list')).result, { tools: [] });
    const r = await c.request('tools/call', { name: 'list', arguments: {} });
    assert.match(String((r.error as { message: string }).message), /tools are not granted/);
  } finally {
    await h.done();
  }
});

test('H8: a grant without terminal.events gets no push, and the end stays unseen', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    await c.request('initialize', MCPL_INIT);
    await c.request('featureSets/update', { effectiveCapabilities: ['tools'], enabled: ['terminal.tools'] });
    await c.request('tools/call', { name: 'open', arguments: { name: 'main' } });
    const s = h.sessions[0]!;
    s.runMode = 'run';
    await c.request('tools/call', { name: 'run', arguments: { name: 'main', command: 'x', wait: 0 } });
    s.end(0);
    await c.request('ping');
    assert.equal(c.messages.filter((m) => m.method === 'push/event').length, 0);
    const unseen = (await h.host.call({ scope: 'a', takes: false, pushes: false }, 'list', {})).structured.unseen as string[];
    assert.equal(unseen.length, 1);
  } finally {
    await h.done();
  }
});

test('no two pushes from one daemon share an eventId, across its connections', async () => {
  const h = await harness();
  try {
    const ids: string[] = [];
    for (const scope of ['a', 'b']) {
      const c = await h.connect(relayHello(scope));
      await c.request('initialize', MCPL_INIT);
      await c.request('featureSets/update', GRANT);
      await c.request('tools/call', { name: 'open', arguments: { name: 'main' } });
      const s = h.sessions.at(-1)!;
      s.runMode = 'run';
      await c.request('tools/call', { name: 'run', arguments: { name: 'main', command: 'x', wait: 0 } });
      s.end(0);
      const push = await c.next((m) => m.method === 'push/event');
      ids.push((push.params as { eventId: string }).eventId);
      c.send({ jsonrpc: '2.0', id: push.id, result: { accepted: true } });
    }
    assert.notEqual(ids[0], ids[1]);
  } finally {
    await h.done();
  }
});

test('initialize answers a revision it speaks; a notification\'s disabled hides tools before any policy; a malformed policy unsubscribes and says the tools changed', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    const init = await c.request('initialize', { ...MCPL_INIT, protocolVersion: '2099-01-01' });
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    const older = await h.connect(relayHello('a'));
    assert.equal(((await older.request('initialize', { ...MCPL_INIT, protocolVersion: '2025-03-26' })).result as { protocolVersion: string }).protocolVersion, '2025-03-26');
    c.send({ jsonrpc: '2.0', method: 'featureSets/update', params: { disabled: ['terminal.tools'] } });
    assert.deepEqual((await c.request('tools/list')).result, { tools: [] });

    const d = await h.connect(relayHello('a'));
    await d.request('initialize', MCPL_INIT);
    await d.request('featureSets/update', GRANT);
    await d.request('tools/call', { name: 'open', arguments: { name: 'other' } });
    const bad = await d.request('featureSets/update', { effectiveCapabilities: ['tools'], deniedCapabilities: ['tools'] });
    assert.ok(bad.error);
    await d.next((m) => m.method === 'notifications/tools/list_changed');
    const order = d.order.filter((m) => m.method === 'notifications/tools/list_changed' || m.id === bad.id);
    assert.deepEqual(order.map((m) => ('method' in m ? 'list_changed' : 'error')), ['list_changed', 'error'], 'its side effects come before its error');
    const s = h.sessions.at(-1)!;
    s.runMode = 'run';
    await h.host.call({ scope: 'a', takes: true, pushes: false }, 'run', { name: 'other', command: 'x', wait: 0 });
    s.end(0);
    assert.deepEqual((await d.request('ping')).result, {}, 'the connection stays open');
    assert.equal(d.messages.filter((m) => m.method === 'push/event').length, 0, 'unsubscribed');
  } finally {
    await h.done();
  }
});

test('a second initialize is refused, and the policy from the first stays', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    await c.request('initialize', MCPL_INIT);
    await c.request('featureSets/update', { effectiveCapabilities: ['pushEvents'], enabled: ['terminal.events'] });
    const again = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.match(String((again.error as { message: string }).message), /already initialized/);
    assert.deepEqual((await c.request('tools/list')).result, { tools: [] });
    assert.ok((await c.request('tools/call', { name: 'list', arguments: {} })).error, 'calls stay refused');
  } finally {
    await h.done();
  }
});

test('terminal-sessions/stop stops the daemon for tsm, and is no method for a relay', async () => {
  const h = await harness();
  try {
    const relay = await h.connect(relayHello('a'));
    assert.ok((await relay.request('terminal-sessions/stop')).error);
    assert.deepEqual(h.stops, []);
    const cli = await h.connect({ version: '2.0.0', scope: 'a', client: 'cli' });
    assert.deepEqual((await cli.request('terminal-sessions/stop')).result, {});
    assert.deepEqual(h.stops, ['tsm daemon stop asked it to']);
  } finally {
    await h.done();
  }
});

test('a cancelled call stops its wait, and is answered to nobody', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await c.request('tools/call', { name: 'open', arguments: { name: 'main' } });
    const s = h.sessions.at(-1)!;
    let aborted = false;
    s.wait = (_until, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => {
          aborted = true;
          resolve({ by: 'cancelled', front: s.frontNow, ended: [], took: [] });
        });
      });
    c.send({ jsonrpc: '2.0', id: 'w', method: 'tools/call', params: { name: 'look', arguments: { name: 'main', until: 'end', wait: 30 } } });
    await new Promise((r) => setTimeout(r, 100));
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w' } });
    assert.deepEqual((await c.request('ping')).result, {});
    assert.equal(aborted, true, 'the session saw the abort');
    assert.equal(c.order.filter((m) => m.id === 'w').length, 0, 'no answer to the cancelled call');
  } finally {
    await h.done();
  }
});

test('a connection that closes aborts the calls it has in flight', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('a'));
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await c.request('tools/call', { name: 'open', arguments: { name: 'main' } });
    const s = h.sessions.at(-1)!;
    let aborted = false;
    let waiting!: () => void;
    const started = new Promise<void>((r) => (waiting = r));
    s.wait = (_until, opts) =>
      new Promise((resolve) => {
        waiting();
        opts.signal?.addEventListener('abort', () => {
          aborted = true;
          resolve({ by: 'cancelled', front: s.frontNow, ended: [], took: [] });
        });
      });
    c.send({ jsonrpc: '2.0', id: 'w', method: 'tools/call', params: { name: 'look', arguments: { name: 'main', until: 'end', wait: 30 } } });
    await started;
    c.close();
    const deadline = Date.now() + 2000;
    while (!aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(aborted, true, 'the session saw the abort');
  } finally {
    await h.done();
  }
});

test('an end a closed connection was waiting for is pushed to another connection of its scope', async () => {
  const h = await harness();
  try {
    const a = await h.connect(relayHello('a'));
    await a.request('initialize', MCPL_INIT);
    await a.request('featureSets/update', GRANT);
    const b = await h.connect(relayHello('a'));
    await b.request('initialize', MCPL_INIT);
    await b.request('featureSets/update', GRANT);
    await a.request('tools/call', { name: 'open', arguments: { name: 'main' } });
    const s = h.sessions[0]!;
    s.runMode = 'run';
    const run = s.run.bind(s);
    let started!: () => void;
    const waiting = new Promise<void>((r) => (started = r));
    let inFlight = false;
    let aborted!: () => void;
    const abort = new Promise<void>((r) => (aborted = r));
    s.run = async (text, opts) => {
      const r = await run(text, opts);
      inFlight = true;
      started();
      await new Promise<void>((res) => opts.signal?.addEventListener('abort', () => res()));
      inFlight = false;
      aborted();
      return r;
    };
    a.send({ jsonrpc: '2.0', id: 'r', method: 'tools/call', params: { name: 'run', arguments: { name: 'main', command: 'make', wait: 30 } } });
    await waiting;
    a.close();
    await abort;
    s.end(0, inFlight);
    const push = await b.next((m) => m.method === 'push/event');
    assert.match((push.params as { payload: { content: Array<{ text: string }> } }).payload.content[0]!.text, /^\[main · command 1 · exit 0 · /);
  } finally {
    await h.done();
  }
});
