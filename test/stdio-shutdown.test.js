// The stdio MCP server must end on SIGINT, on SIGTERM and when its stdin
// closes (MCP's stdio shutdown), whatever state it is in: before any tool
// call, when no session server connection exists yet, and after one, when
// the open WebSocket would otherwise keep the process alive (#17). Spawns the
// compiled server against a fake session server on a loopback port. Runs
// against the compiled output: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');

const serverJs = join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');
const EXIT_WITHIN_MS = 2000;
const ANSWER_WITHIN_MS = 10000;

// A session server that answers session.list with no sessions, after
// `delayMs` when given. The stdio server's first tool call opens a WebSocket
// to it; that socket is what keeps the process alive once stdin is gone.
async function fakeSessionServer({ delayMs = 0 } = {}) {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const { id, method } = JSON.parse(data.toString());
      const result = method === 'session.list' ? [] : null;
      setTimeout(() => ws.send(JSON.stringify({ id, result })), delayMs);
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  return { url, close: () => new Promise((resolve) => wss.close(() => resolve())) };
}

// Spawns the stdio server with a JSON-RPC line client over its pipes. Each
// test kills the child in its `finally`, before closing the fake session
// server, whose close waits for the child's WebSocket.
function startStdioServer(url) {
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, SESSION_SERVER_URL: url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const pending = waiting.get(msg.id);
      if (pending) { waiting.delete(msg.id); pending.resolve(msg); }
    }
  });
  // Kept for a failure's message; the first tool call logs its connection details here.
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // A request fails its test, rather than leaving it waiting forever, when
  // no answer comes within ANSWER_WITHIN_MS, or once the server has ended and
  // its output has all been read ('close').
  let ended = null;
  child.once('close', (code, signal) => {
    ended = new Error(`server ended (code ${code}, signal ${signal}) before answering; its stderr: ${stderr.trim()}`);
    for (const pending of waiting.values()) pending.reject(ended);
    waiting.clear();
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(ended); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${method} within ${ANSWER_WITHIN_MS} ms`));
    }, ANSWER_WITHIN_MS);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  // What stdout held after its last newline: a line the server began and never finished.
  const unfinished = () => buffer;
  return { child, request, exited, unfinished };
}

// Resolves to the exit (code, signal) when the child ends within the window,
// or to null when it is still running, in which case it is killed.
async function exitWithin(server, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const result = await Promise.race([server.exited, timeout]);
  clearTimeout(timer);
  if (result === null) server.child.kill('SIGKILL');
  return result;
}

async function initialize(server) {
  const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'terminal-sessions-mcp');
}

// Has the client read nothing while the server answers 40 tools/list
// requests, more than the pipe and the client's buffer hold, so answers wait
// in the server's queue. The answers' ids are none the client waits on.
function fillUnread(server) {
  server.child.stdout.pause();
  for (let i = 0; i < 40; i++) {
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: `unread-${i}`, method: 'tools/list' }) + '\n');
  }
}

// On Windows, child.kill() with a named signal terminates the process
// outright rather than delivering a signal the server could ignore, so the
// signal cases prove nothing there.
const signalsReachNode = process.platform !== 'win32';

// A signal ends the server at once in each state: before any tool call, and
// after one, with stdin closed and answers queued that the client hasn't read,
// where the close is still waiting for them to leave.
const states = {
  'before any tool call': async (server) => {
    const list = await server.request('tools/list');
    assert.ok(list.result.tools.length > 0);
  },
  'after a tool call, with stdin closed and answers unread': async (server) => {
    const call = await server.request('tools/call', { name: 'listSessions', arguments: {} });
    assert.equal(call.error, undefined, 'listSessions against the fake session server succeeds');
    fillUnread(server);
    server.child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.child.exitCode, null, 'the server is still waiting for its answers to leave');
  },
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  for (const [state, reach] of Object.entries(states)) {
    test(`${signal} ends the server ${state}`, { skip: signalsReachNode ? false : 'Windows has no signals to ignore: child.kill() terminates the process directly' }, async () => {
      const fake = await fakeSessionServer();
      const server = startStdioServer(fake.url);
      try {
        await initialize(server);
        await reach(server);
        server.child.kill(signal);
        const exit = await exitWithin(server, EXIT_WITHIN_MS);
        assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after ${signal}`);
      } finally {
        server.child.kill('SIGKILL');
        await fake.close();
      }
    });
  }
}

test('a closed stdin ends the server after a tool call has opened the session server connection', async () => {
  const fake = await fakeSessionServer();
  const server = startStdioServer(fake.url);
  try {
    await initialize(server);
    const call = await server.request('tools/call', { name: 'listSessions', arguments: {} });
    assert.equal(call.error, undefined, 'listSessions against the fake session server succeeds');
    server.child.stdin.end();
    const exit = await exitWithin(server, EXIT_WITHIN_MS);
    assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after stdin closed`);
    assert.equal(exit.code, 0);
  } finally {
    server.child.kill('SIGKILL');
    await fake.close();
  }
});

test('a closed stdin ends the server before any tool call', async () => {
  const fake = await fakeSessionServer();
  const server = startStdioServer(fake.url);
  try {
    await initialize(server);
    server.child.stdin.end();
    const exit = await exitWithin(server, EXIT_WITHIN_MS);
    assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after stdin closed`);
    assert.equal(exit.code, 0);
  } finally {
    server.child.kill('SIGKILL');
    await fake.close();
  }
});

// A client may close stdin while answers the server has already written are
// still on their way to it. Here the client reads nothing for 600 ms. The
// answers fill the pipe and wait in the server's queue, and a tool call's
// answer arrives from the session server only after stdin has closed. The
// server must let out the answers it had written, write no other, and exit
// once they have left. Writes to a pipe are synchronous on Windows, so no
// answer waits in the server's queue there, and the case shows nothing.
test('on a closed stdin the server lets out the answers it has written to a client slow to read them, and no others', { skip: process.platform === 'win32' ? 'Windows writes to a pipe synchronously: no answer waits in the server' : false }, async () => {
  const fake = await fakeSessionServer({ delayMs: 300 });
  const server = startStdioServer(fake.url);
  try {
    await initialize(server);
    server.child.stdout.pause();
    const answers = Array.from({ length: 40 }, () => server.request('tools/list'));
    const call = server.request('tools/call', { name: 'listSessions', arguments: {} });
    server.child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 600));
    server.child.stdout.resume();
    const all = await Promise.all(answers);
    assert.ok(all.every((msg) => msg.result.tools.length > 0));
    const exit = await exitWithin(server, EXIT_WITHIN_MS);
    assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after its answers were read`);
    assert.equal(exit.code, 0);
    await assert.rejects(call, /server ended/);
    assert.equal(server.unfinished(), '', 'no answer was cut off partway');
  } finally {
    server.child.kill('SIGKILL');
    await fake.close();
  }
});
