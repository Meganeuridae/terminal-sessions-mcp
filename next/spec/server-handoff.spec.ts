/**
 * The startup port handoff (API 3, the house's review of #11). termd holds its port from
 * before it reads the data dir until the endpoint listens (daemon.ts); the endpoint takes
 * over the held socket itself, so the port is never unbound in between, and the connections
 * that arrived during recovery are served rather than refused or reset — a refused shim
 * starts a daemon of its own. Here a plain request and a WebSocket handshake arrive while the
 * port is only held, and are answered once the server listens on that handle; a client that
 * connects afterwards is served the ordinary way; closing the server frees the port.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { TermServer } from '../src/transport/server.js';
import { until } from './testhost.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-handoff-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** What daemon.ts does before recovery: hold the port, park whoever connects. */
function hold(): Promise<{ server: net.Server; parked: net.Socket[]; port: number }> {
  return new Promise((resolve, reject) => {
    const parked: net.Socket[] = [];
    const server = net.createServer((sock) => {
      sock.pause();
      parked.push(sock);
    });
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve({ server, parked, port: (server.address() as net.AddressInfo).port }));
  });
}

function request(ws: WebSocket, id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (m: WebSocket.RawData): void => {
      const msg = JSON.parse(m.toString()) as { id?: number; result?: Record<string, unknown> };
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg.result ?? {});
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

const opens = (ws: WebSocket): Promise<void> =>
  new Promise((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });

test('API 3: clients that connected while the port was held are answered once the endpoint listens on the same socket; later clients and the close work as before', async () => {
  const held = await hold();
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd1'), backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
  const server = new TermServer({ app: new App({ registry, defaultWaitMs: 2000 }), resolver: new TokenMapResolver({ tokens: { ta: 'agent:a@x' } }), host: '127.0.0.1', port: held.port, version: 'handoff' });
  try {
    // Two clients arrive during "recovery": a plain HTTP request and a WebSocket handshake.
    const raw = net.connect(held.port, '127.0.0.1');
    let answer = '';
    raw.on('data', (d) => (answer += d.toString()));
    raw.on('error', () => undefined);
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const early = new WebSocket(`ws://127.0.0.1:${held.port}/?token=ta&connection=early`);
    const earlyOpen = opens(early);
    await until(() => held.parked.length === 2, 3000, 'both connections to be parked');
    assert.equal(answer, '', 'neither is answered before the endpoint exists');
    // Recovery done: the endpoint takes the socket over and serves what waited.
    const bound = await server.listen(held.server);
    assert.equal(bound.port, held.port);
    for (const sock of held.parked.splice(0)) server.adopt(sock);
    await earlyOpen;
    const init = (await request(early, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'early', version: '0' } })) as { serverInfo?: { version?: string } };
    assert.equal(init.serverInfo?.version, 'handoff', JSON.stringify(init));
    await until(() => /^HTTP\/1\.1 \d{3}/.test(answer), 3000, 'the request that waited to be answered');
    // Served, not refused: the health check it asked for, with a body (the house's read of 2f357bd, #22).
    assert.match(answer, /^HTTP\/1\.1 200 OK/, `the request that waited is served: ${JSON.stringify(answer.slice(0, 80))}`);
    assert.match(answer, /"status":"ok"/);
    early.close(1000);
    // A client connecting after the handoff is served the ordinary way.
    const later = new WebSocket(`ws://127.0.0.1:${held.port}/?token=ta&connection=later`);
    await opens(later);
    const init2 = (await request(later, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'later', version: '0' } })) as { serverInfo?: { version?: string } };
    assert.equal(init2.serverInfo?.version, 'handoff');
    later.close(1000);
  } finally {
    await server.close();
    await registry.closeAll();
  }
  // The held socket went with the server: the port is free again.
  await assert.rejects(
    new Promise((_, j) => {
      const c = net.connect(held.port, '127.0.0.1');
      c.once('error', j);
      c.once('connect', () => {
        c.destroy();
        j(new Error('still listening'));
      });
    }),
    /ECONNREFUSED/,
  );
});

test('API 3: a paused socket keeps its bytes until it is resumed, which is what serving a parked connection later relies on', async () => {
  // Parking (daemon.ts) relies on this shape. Note that today recovery runs synchronously in the
  // registry's constructor, so nothing is parked in practice: connections wait in the kernel's
  // accept queue until the endpoint owns the socket (the house's read of 59605dd); the parking
  // would matter if recovery ever yielded to the event loop.
  const held = await hold();
  try {
    const c = net.connect(held.port, '127.0.0.1');
    await new Promise<void>((r) => c.once('connect', () => r()));
    c.write('kept until resumed');
    await until(() => held.parked.length === 1, 3000, 'the connection to be parked');
    const sock = held.parked[0]!;
    let got = '';
    sock.on('data', (d) => (got += d.toString()));
    // The bytes are in the kernel by now (written before the connection was even parked); a socket that
    // was not paused would deliver them on the next turn, so the check gives it one (2f357bd, #22).
    await sleep(50);
    assert.equal(got, '', 'paused: nothing read yet');
    sock.resume();
    await until(() => got !== '', 3000, 'the bytes after resume');
    assert.equal(got, 'kept until resumed');
    c.destroy();
    sock.destroy();
  } finally {
    await new Promise<void>((r) => held.server.close(() => r()));
  }
});
