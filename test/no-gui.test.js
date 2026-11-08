// Runs against the compiled output: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { join } = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');

const root = join(__dirname, '..');
const stdioJs = join(root, 'dist', 'src', 'mcp', 'mcp-stdio-server.js');
const sessionServerJs = join(root, 'dist', 'src', 'server', 'start-session-server.js');
const ANSWER_WITHIN_MS = 10000;
const TOOLS = ['launch', 'runCommand', 'listSessions', 'tailLogs', 'sendInput', 'sendSignal', 'killSession', 'killAll', 'searchLogs'];

async function closedPorts() {
  const probes = [net.createServer(), net.createServer()];
  for (const probe of probes) {
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
  }
  const ports = probes.map((probe) => probe.address().port);
  await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  return ports;
}

async function fakeSessionServer() {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(JSON.stringify({ id: JSON.parse(data.toString()).id, result: null })));
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

function startStdioServer(url) {
  const child = spawn(process.execPath, [stdioJs], { env: { ...process.env, SESSION_SERVER_URL: url } });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.resolve(msg);
      waiting.delete(msg.id);
    }
  });
  child.once('close', (code, signal) => {
    for (const pending of waiting.values()) pending.reject(new Error(`server ended (code ${code}, signal ${signal}) before answering`));
    waiting.clear();
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${method} within ${ANSWER_WITHIN_MS} ms`));
    }, ANSWER_WITHIN_MS);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request };
}

async function startSessionServer({ args = [], env = {}, apiPort, guiPort }) {
  const child = spawn(process.execPath, [sessionServerJs, '--host', '127.0.0.1', ...args], {
    env: { ...process.env, SESSION_SERVER_PORT: String(apiPort), GUI_PORT: String(guiPort), ...env },
    stdio: 'ignore',
  });
  const deadline = performance.now() + ANSWER_WITHIN_MS;
  try {
    for (;;) {
      if (child.exitCode !== null) throw new Error(`session server exited with code ${child.exitCode} before answering /health`);
      const status = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/health' }, (res) => { res.resume(); resolve(res.statusCode); });
        req.setTimeout(1000, () => req.destroy());
        req.on('error', () => resolve(null));
      });
      if (status === 200) return child;
      if (performance.now() > deadline) throw new Error(`no /health answer within ${ANSWER_WITHIN_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

async function accepts(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('the stdio server offers no takeScreenshot, and answers a call to it as an unknown tool', async () => {
  const fake = await fakeSessionServer();
  const server = startStdioServer(fake.url);
  try {
    await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const list = await server.request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOLS);
    const call = await server.request('tools/call', { name: 'takeScreenshot', arguments: { session: 'any' } });
    assert.equal(call.error?.message, 'Unknown tool: takeScreenshot');
  } finally {
    server.child.kill('SIGKILL');
    await fake.close();
  }
});

test('the session server serves its API and nothing at GUI_PORT', async () => {
  const [apiPort, guiPort] = await closedPorts();
  const child = await startSessionServer({ apiPort, guiPort });
  try {
    assert.equal(await accepts('127.0.0.1', guiPort), false);
  } finally {
    child.kill('SIGKILL');
  }
});

for (const [how, options] of [['--headless', { args: ['--headless'] }], ['HEADLESS=true', { env: { HEADLESS: 'true' } }]]) {
  test(`the session server still starts with ${how}, and serves nothing at GUI_PORT`, async () => {
    const [apiPort, guiPort] = await closedPorts();
    const child = await startSessionServer({ ...options, apiPort, guiPort });
    try {
      assert.equal(await accepts('127.0.0.1', guiPort), false);
    } finally {
      child.kill('SIGKILL');
    }
  });
}
