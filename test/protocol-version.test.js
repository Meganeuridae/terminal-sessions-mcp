// On initialize the stdio MCP server replies with the protocol revision the
// client asked for when it supports that revision, and with its latest
// otherwise (MCP lifecycle: version negotiation). Runs against the compiled
// output: `npm test`. Initialize opens no session server connection, so the
// server is pointed at a closed loopback port it never dials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const serverJs = join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');

function initializeWith(protocolVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverJs], {
      env: { ...process.env, SESSION_SERVER_URL: 'ws://127.0.0.1:9' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no answer to initialize; stderr: ${stderr.trim()}`)); }, 10000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      child.kill('SIGKILL');
      try { resolve(JSON.parse(buffer.slice(0, nl))); } catch (error) { reject(error); }
    });
    const params = { capabilities: {}, clientInfo: { name: 'test', version: '0' } };
    if (protocolVersion !== undefined) params.protocolVersion = protocolVersion;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params }) + '\n');
  });
}

for (const version of ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
  test(`initialize answers ${version} when the client asks for it`, async () => {
    const reply = await initializeWith(version);
    assert.equal(reply.result.protocolVersion, version);
  });
}

test('initialize answers the latest revision for one it does not support', async () => {
  const reply = await initializeWith('1999-01-01');
  assert.equal(reply.result.protocolVersion, '2025-06-18');
});

test('initialize answers the latest revision when the client names none', async () => {
  const reply = await initializeWith(undefined);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
});
