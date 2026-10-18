/**
 * tsm as a process: its exit codes are the contract scripts rely on — a Run's
 * exit code, 128+N for a signal, 124 while running, 75 when busy, 1 on error,
 * including a daemon connection lost before the result (jr-18) — its argument
 * forms (`await <runId>`, durations, `--`), and `tsm gui`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { TermServer } from '../src/transport/server.js';
import { FakeShell } from './fake-shell.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TSM = path.resolve(here, '../src/cli/tsm.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function tsm(argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSM, ...argv], { env: { ...process.env, TSM_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('tsm exit codes: the Run exit code, 124 while running, 75 when busy, 1 on error', async () => {
  const backend = new ScriptedBackend();
  backend.onSpawnShell = (p) => {
    const sh = new FakeShell(p);
    sh.on(/^exit (\d+)$/, (l) => ({ exit: Number(l.split(' ')[1]) }));
    sh.on(/^sleep/, () => ({ hang: true }));
    sh.on('echo hi', () => ({ output: 'hi\r\n', exit: 0 }));
    const kill = p.kill.bind(p);
    p.kill = (sig) => {
      kill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') p.exit({ exitCode: null, signal: sig });
    };
  };
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd'), backend, defaultShell: '/bin/bash', noUserRc: true });
  const server = new TermServer({ app: new App({ registry, defaultWaitMs: 2000 }), resolver: new TokenMapResolver({ tokens: { tk: 'agent:cli@test' } }), host: '127.0.0.1', port: 0 });
  const { port } = await server.listen();
  const env = { TSM_URL: `ws://127.0.0.1:${port}`, TSM_TOKEN: 'tk' };
  try {
    const ok = await tsm(['run', 'c1', 'echo', 'hi'], env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /hi\n\[run r\S+ exited 0/);
    assert.equal((await tsm(['run', 'c1', 'exit 3'], env)).code, 3);
    const running = await tsm(['run', 'c1', 'sleep 30', '--wait', '100', '--json'], env);
    assert.equal(running.code, 124, 'atc-20: not finished is not a command exit status');
    assert.equal((JSON.parse(running.stdout) as { state: string }).state, 'running');
    assert.equal((await tsm(['run', 'c2', 'exit 2'], env)).code, 2, 'a command that exited 2 is not "running"');
    const busy = await tsm(['run', 'c1', 'echo', 'hi', '--wait', '100'], env);
    assert.equal(busy.code, 75, busy.stdout);
    assert.match(busy.stdout, /busy/);
    const read = await tsm(['read', 'c1', '--since', '0', '--json'], env);
    assert.equal(read.code, 0);
    assert.ok((JSON.parse(read.stdout) as { nextCursor: number }).nextCursor > 0);
    const bad = await tsm(['run', 'c1'], env);
    assert.equal(bad.code, 1, 'a validation error');
    const denied = await tsm(['sessions'], { ...env, TSM_TOKEN: 'wrong' });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /refused the credential \(401\): set TSM_TOKEN/, 'ux-18: a bad token is reported as such');
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

test('jr-18: tsm exits 1 with a message when the daemon connection closes before the result', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { id: number; method: string };
      if (m.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      else setTimeout(() => ws.terminate(), 100); // the daemon dies mid-call
    });
  });
  try {
    const port = (wss.address() as { port: number }).port;
    const r = await tsm(['run', 'build', 'npm test'], { TSM_URL: `ws://127.0.0.1:${port}` });
    assert.equal(r.code, 1, `exit ${String(r.code)}; stdout=${r.stdout}`);
    assert.match(r.stderr, /closed .*before a result; the outcome is unknown/);
    assert.equal(r.stdout, '');
  } finally {
    await new Promise<void>((r) => wss.close(() => r()));
  }
});

test('tsm gui prints the GUI URL, with the token when one is configured', async () => {
  const plain = await tsm(['gui'], { TSM_URL: 'ws://127.0.0.1:3101' });
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout.trim(), 'http://127.0.0.1:3101/');
  const withToken = await tsm(['gui'], { TSM_URL: 'wss://term.example:8443', TSM_TOKEN: 'a b&c' });
  assert.equal(withToken.stdout.trim(), 'https://term.example:8443/?token=a+b%26c');
  const inUrl = await tsm(['gui'], { TSM_URL: 'ws://localhost:3175/?token=t1', TSM_TOKEN: '' });
  assert.equal(inUrl.stdout.trim(), 'http://localhost:3175/?token=t1');
});

test('atc-5/tsg-2/atc-25/ux-18: a signal exits 128+N; await <runId>; durations; -- ends option parsing', async () => {
  const backend = new ScriptedBackend();
  backend.onSpawnShell = (p) => {
    const sh = new FakeShell(p);
    sh.on(/^sleep/, () => ({ hang: true }));
    sh.on(/^echo /, (l) => ({ output: `${l.slice(5)}\r\n`, exit: 0 }));
    sh.on(/^git /, (l) => ({ output: `ran: ${l}\r\n`, exit: 0 }));
    const kill = p.kill.bind(p);
    p.kill = (sig) => {
      kill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') p.exit({ exitCode: null, signal: sig });
    };
  };
  // Process Runs: `die SIG` is killed by that signal.
  backend.onSpawnProcess = (p) => {
    const line = p.opts.line ?? p.opts.argv.join(' ');
    const sig = /die (SIG[A-Z]+)/.exec(line)?.[1];
    if (sig) setTimeout(() => p.exit({ exitCode: null, signal: sig }), 20);
  };
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd2'), backend, defaultShell: '/bin/bash', noUserRc: true });
  const server = new TermServer({ app: new App({ registry, defaultWaitMs: 2000 }), resolver: new TokenMapResolver({ tokens: { tk: 'agent:cli@test' } }), host: '127.0.0.1', port: 0 });
  const { port } = await server.listen();
  const env = { TSM_URL: `ws://127.0.0.1:${port}`, TSM_TOKEN: 'tk' };
  try {
    const killed = await tsm(['run', 'p1', '--target', 'process', 'die SIGKILL'], env);
    assert.equal(killed.code, 137, `SIGKILL is 128+9, never success: ${killed.stdout}`);
    assert.equal((await tsm(['run', 'p1', '--target', 'process', 'die SIGSEGV'], env)).code, 139);
    // `tsm await <runId>` with no session (README), and a duration with a unit (DESIGN §11).
    const started = await tsm(['run', 'p2', 'sleep 30', '--wait', '100ms', '--json'], env);
    assert.equal(started.code, 124);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    const waited = await tsm(['await', runId, '--wait', '0.2s', '--json'], env);
    assert.equal(waited.code, 124, waited.stdout + waited.stderr);
    assert.equal((JSON.parse(waited.stdout) as { runId: string }).runId, runId);
    const cancelled = await tsm(['cancel', runId], env);
    assert.equal(cancelled.code, 0, `a cancel that ended the Run: ${cancelled.stdout}`);
    // -- stops option parsing: the command's own flags reach the command.
    const git = await tsm(['run', 'g1', '--wait', '2s', '--', 'git', '-C', 'repo', 'log', '--oneline', '-5'], env);
    assert.equal(git.code, 0, git.stdout + git.stderr);
    assert.match(git.stdout, /ran: git -C repo log --oneline -5/);
    const without = await tsm(['run', 'g1', 'git', 'log', '--oneline'], env);
    assert.equal(without.code, 1);
    assert.match(without.stdout, /put the command after --/);
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

/** A daemon stand-in that answers every tools/call with a canned envelope, for outcomes a scripted session cannot stage quickly. */
async function cannedDaemon(answers: Record<string, Record<string, unknown>>): Promise<{ port: number; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { id: number; method: string; params: { name: string } };
      if (m.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '[canned]' }], structuredContent: answers[m.params.name] ?? {} } }));
    });
  });
  return { port: (wss.address() as { port: number }).port, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

test('atc-20: start and cancel exit nonzero on failure states; a signal with no exit code is never success', async () => {
  const cases: Array<[string[], Record<string, unknown>, number]> = [
    [['cancel', 'r9'], { runId: 'r9', state: 'running', contract: 'shell', escalation: 'session_close', steps: ['^C', '^\\', 'SIGTERM', 'SIGKILL'] }, 1],
    [['cancel', 'r9'], { runId: 'r9', state: 'cancelled', contract: 'shell', steps: ['^C'] }, 0],
    [['start', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'ready' }, 0],
    [['start', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'starting' }, 124],
    [['start', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'unhealthy' }, 1],
    [['start', 's', '--command', 'x'], { runId: 'r1', state: 'exited', exit: 0, service: 'exited' }, 1],
    [['await', 'r1'], { runId: 'r1', state: 'exited', signal: 'SIGTERM' }, 143],
    [['await', 'r1'], { runId: 'r1', state: 'exited', signal: 'SIGWHAT' }, 1],
    [['await', 'r1'], { runId: 'r1', state: 'lost', reason: 'daemon-restart' }, 1],
    [['await', 'r1'], { runId: 'r1', state: 'queued' }, 124],
  ];
  for (const [argv, answer, code] of cases) {
    const d = await cannedDaemon({ [argv[0] === 'await' ? 'await' : argv[0]!]: answer });
    try {
      const r = await tsm(argv, { TSM_URL: `ws://127.0.0.1:${d.port}` });
      assert.equal(r.code, code, `${argv.join(' ')} → ${JSON.stringify(answer)}: ${r.stderr}`);
    } finally {
      await d.close();
    }
  }
});

test('tsg-12/ux-18: a Host the daemon does not serve is explained, naming --allow-host', async (t) => {
  const backend = new ScriptedBackend();
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd3'), backend, defaultShell: '/bin/bash', noUserRc: true });
  const server = new TermServer({ app: new App({ registry }), resolver: new TokenMapResolver({ anonymous: 'token:local-test' }), host: '127.0.0.1', port: 0 });
  const { port } = await server.listen();
  try {
    // A name that is not a loopback name (resolves to loopback, so no network is involved).
    const r = await tsm(['sessions'], { TSM_URL: `ws://localhost.:${port}` });
    if (/ENOTFOUND|EAI_AGAIN/.test(r.stderr)) return t.skip('this resolver does not resolve localhost.');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--allow-host/, r.stderr);
  } finally {
    await server.close();
    await registry.closeAll();
  }
});
