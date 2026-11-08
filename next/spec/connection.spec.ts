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

const DAEMON = { version: '2.0.0', pid: 777, startedAt: Date.parse('2026-11-08T13:00:00.000Z') };

interface Client {
  send(m: unknown): void;
  next(pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
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
  const server = net.createServer((c) => serveConnection(c, host, DAEMON));
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
      const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; from: number }> = [];
      let nextId = 1;
      const client: Client = {
        messages,
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
    host, sessions, connect,
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
    const same = await h.connect(relayHello('a', '2.0.0'));
    const r2 = await same.request('initialize', MCPL_INIT);
    assert.doesNotMatch(String((r2.result as { instructions: string }).instructions), /relay that reached it/);
  } finally {
    await h.done();
  }
});

test('H6: a plain MCP client lists the eight tools and calls them in its scope', async () => {
  const h = await harness();
  try {
    const c = await h.connect(relayHello('mine'));
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const list = await c.request('tools/list');
    assert.deepEqual((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name), ['open', 'run', 'send', 'look', 'read', 'stop', 'list', 'close']);
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
