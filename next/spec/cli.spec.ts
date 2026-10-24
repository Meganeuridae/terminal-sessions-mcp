/**
 * tsm as a process: its exit codes are the contract scripts rely on — a Run's
 * exit code, 128+N for a signal, 124 while running, 75 when busy, 1 on error,
 * including a daemon connection lost before the result (jr-18) — its argument
 * forms (`await <runId>`, durations, `--`, values typed by the tool's schema),
 * its output to a slow reader, `tsm gui` and `tsm usage`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { TOOLS } from '../src/api/tools.js';
import type { UsageRecord } from '../src/api/usage.js';
import { TermServer } from '../src/transport/server.js';
import { fakeShellBackend, until, type FakeShell } from './fake-shell.js';
import { unusedPort } from './testhost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TSM = path.resolve(here, '../src/cli/tsm.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run tsm; `readAfterMs` starts reading its stdout only then, as a slow consumer of a pipe would. */
function tsm(argv: string[], env: NodeJS.ProcessEnv, opts: { readAfterMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSM, ...argv], { env: { ...process.env, TSM_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const read = () => child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    if (opts.readAfterMs) setTimeout(read, opts.readAfterMs);
    else read();
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    // 'close' follows the last byte of both pipes; 'exit' can come before stdout is drained.
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('tsm exit codes: the Run exit code, 124 while running, 75 when busy, 1 on error', async () => {
  const backend = fakeShellBackend((sh) => {
    sh.on(/^exit (\d+)$/, (l) => ({ exit: Number(l.split(' ')[1]) }));
    sh.on(/^sleep/, () => ({ hang: true }));
    sh.on('echo hi', () => ({ output: 'hi\r\n', exit: 0 }));
  });
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd'), backend, defaultShell: '/bin/bash', noUserRc: true });
  const usage: UsageRecord[] = [];
  const server = new TermServer({
    app: new App({ registry, defaultWaitMs: 2000 }),
    resolver: new TokenMapResolver({ tokens: { tk: 'agent:cli@test' } }),
    host: '127.0.0.1',
    port: 0,
    usage: { record: (r) => usage.push(r) },
  });
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
    assert.match(denied.stderr, /refused this credential \(401\).*Ask its operator.*TSM_TOKEN/, 'ux-18: a bad token directs the agent to the operator');
    // The CLI is the native family, with the GUI: `tsm usage` does not read its calls as an agent's.
    assert.ok(usage.length >= 6, `usage records: ${usage.length}`);
    assert.deepEqual(new Set(usage.map((u) => u.host)), new Set(['native']), JSON.stringify(usage.map((u) => [u.tool, u.host])));
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

test('CLI recovery commands distinguish active Runs from completed journal records', async () => {
  const backend = fakeShellBackend((sh) => sh.on('echo done', () => ({ output: 'done\r\n', exit: 0 })));
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd-recover-advice'), backend, defaultShell: '/bin/bash', noUserRc: true });
  const server = new TermServer({ app: new App({ registry, defaultWaitMs: 2000 }), resolver: new TokenMapResolver({ tokens: { tk: 'agent:cli@test' } }), host: '127.0.0.1', port: 0 });
  const { port } = await server.listen();
  const env = { TSM_URL: `ws://127.0.0.1:${port}`, TSM_TOKEN: 'tk' };
  try {
    const r = await tsm(['run', 'recovery', 'echo', 'done', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const run = JSON.parse(r.stdout) as { runId: string; state: string };
    assert.equal(run.state, 'exited');
    const listed = await tsm(['sessions', '--json'], env);
    assert.equal(listed.code, 0, listed.stderr);
    const sessions = (JSON.parse(listed.stdout) as { sessions: Array<{ id: string; runs?: Array<{ runId: string }> }> }).sessions;
    const summary = sessions.find((s) => s.id === 'recovery');
    assert.ok(summary);
    assert.ok(!summary.runs?.some((candidate) => candidate.runId === run.runId), 'sessions lists only active Runs');
    const read = await tsm(['read', 'recovery', '--as', 'events', '--since', '0', '--json'], env);
    assert.equal(read.code, 0, read.stderr);
    const events = (JSON.parse(read.stdout) as { events: Array<{ type: string; runId?: string }> }).events;
    assert.ok(events.some((e) => e.type === 'run.admit' && e.runId === run.runId), 'an events read shows the admission');
    assert.ok(events.some((e) => e.type === 'run.end' && e.runId === run.runId), 'an events read shows the completion');
    const waited = await tsm(['await', run.runId, '--json'], env);
    assert.equal(waited.code, 0, waited.stderr);
    const awaited = JSON.parse(waited.stdout) as { runId: string; state: string };
    assert.equal(awaited.runId, run.runId);
    assert.equal(awaited.state, 'exited');
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

test('a connection lost during initialization says the command was not sent', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws) => ws.once('message', (data) => {
    assert.equal((JSON.parse(data.toString()) as { method: string }).method, 'initialize');
    ws.terminate();
  }));
  try {
    const port = (wss.address() as { port: number }).port;
    const r = await tsm(['run', 'build', 'echo never-sent'], { TSM_URL: `ws://127.0.0.1:${port}` });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no command was sent/i);
    assert.doesNotMatch(r.stderr, /outcome is unknown|\(1006\)/, 'a pre-command drop does not claim an unknown command result');
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test('jr-18: tsm exits 1 with a message when the daemon connection closes before the result', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  let sawToolCall = false;
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { id: number; method: string };
      if (m.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      else if (m.method === 'tools/list') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'run', inputSchema: TOOLS.find((tool) => tool.name === 'run')!.inputSchema }] } }));
      else {
        assert.equal(m.method, 'tools/call');
        sawToolCall = true;
        setTimeout(() => ws.terminate(), 100); // the daemon dies after receiving the command
      }
    });
  });
  try {
    const port = (wss.address() as { port: number }).port;
    const r = await tsm(['run', 'build', 'npm test'], { TSM_URL: `ws://127.0.0.1:${port}` });
    assert.equal(sawToolCall, true, 'the fake daemon received the command before the connection failed');
    assert.equal(r.code, 1, `exit ${String(r.code)}; stdout=${r.stdout}`);
    assert.match(r.stderr, /outcome is unknown/);
    assert.match(r.stderr, /tsm read <session> --as events --since 0.*tsm await <runId>/i, 'a lost response names journal and known-run checks before retrying');
    assert.match(r.stderr, /original.*--idempotency-key.*retention is bounded/i, 'a keyed retry needs the original key and a retention warning');
    assert.match(r.stderr, /outcome stays unclear.*ask.*operator.*before resubmitting/i, 'uncertain mutating work asks for help rather than repeating');
    assert.doesNotMatch(r.stderr, /tsm sessions/, 'an active-only list cannot establish completed Run outcomes');
    assert.doesNotMatch(r.stderr, /closed \(1006\)|Unexpected server response/, 'protocol details do not replace the next step');
    assert.equal(r.stdout, '');
  } finally {
    await new Promise<void>((r) => wss.close(() => r()));
  }
});

test('tsm gui prints the GUI URL, with the token when one is configured, as JSON with --json', async () => {
  const plain = await tsm(['gui'], { TSM_URL: 'ws://127.0.0.1:3101' });
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout.trim(), 'http://127.0.0.1:3101/');
  const withToken = await tsm(['gui'], { TSM_URL: 'wss://term.example:8443', TSM_TOKEN: 'a b&c' });
  assert.equal(withToken.stdout.trim(), 'https://term.example:8443/?token=a+b%26c');
  const inUrl = await tsm(['gui'], { TSM_URL: 'ws://localhost:3175/?token=t1', TSM_TOKEN: '' });
  assert.equal(inUrl.stdout.trim(), 'http://localhost:3175/?token=t1');
  // An empty TSM_URL is unset: the default address (the house's read, #22 comment 6269721389).
  const empty = await tsm(['gui'], { TSM_URL: '' });
  assert.equal(empty.stdout.trim(), 'http://127.0.0.1:3101/');
  const json = await tsm(['gui', '--json'], { TSM_URL: 'ws://127.0.0.1:3101' });
  assert.deepEqual(JSON.parse(json.stdout), { url: 'http://127.0.0.1:3101/' });
});

test('atc-5/tsg-2/atc-25/ux-18: a signal exits 128+N; await <runId>; durations; -- ends option parsing', async () => {
  const backend = fakeShellBackend((sh) => {
    sh.on(/^sleep/, () => ({ hang: true }));
    sh.on(/^echo /, (l) => ({ output: `${l.slice(5)}\r\n`, exit: 0 }));
    sh.on(/^git /, (l) => ({ output: `ran: ${l}\r\n`, exit: 0 }));
  });
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
    // -- stops option parsing: the command's own flags reach the command, plain words as they are.
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

interface Canned {
  port: number;
  /** Every tools/call, in order. */
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** The request target of every connection (the CLI's query string). */
  urls: string[];
  close(): Promise<void>;
}

/**
 * A daemon stand-in for outcomes a scripted session cannot stage quickly: it lists the real
 * tools (the CLI types each flag by their schemas), records every tools/call and answers it
 * with a canned envelope — the next of a list when a tool is asked more than once, the last
 * one repeating.
 */
async function cannedDaemon(answers: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>, opts: { without?: string[]; rpcError?: string } = {}): Promise<Canned> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const calls: Canned['calls'] = [];
  const urls: string[] = [];
  const left = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  // `without`: tools this stand-in does not list, as a daemon of another version would not.
  const tools = TOOLS.filter((t) => !opts.without?.includes(t.name));
  wss.on('connection', (ws, req) => {
    urls.push(req.url ?? '');
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { id: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {} });
      if (m.method === 'tools/list') return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      const call = m.params!;
      calls.push({ name: call.name, arguments: call.arguments });
      // `rpcError`: the call is answered with a JSON-RPC error, a failure outside the tool layer.
      if (opts.rpcError !== undefined) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: opts.rpcError } }));
      const queue = left[call.name] ?? [];
      const structured = queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
      reply({ content: [{ type: 'text', text: '[canned]' }], structuredContent: structured });
    });
  });
  return { port: (wss.address() as { port: number }).port, calls, urls, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

test('atc-20: exit codes agree with the header for every state of run, await, start and cancel', async () => {
  const cases: Array<[string[], Record<string, unknown>, number, string]> = [
    [['cancel', 'r9'], { runId: 'r9', state: 'running', contract: 'shell', escalation: 'session_close', steps: ['^C', '^\\', 'SIGTERM', 'SIGKILL'] }, 1, 'cancel: the Run survived'],
    [['cancel', 'r9'], { runId: 'r9', state: 'cancelled', contract: 'shell', steps: ['^C'] }, 0, 'cancel: ended'],
    [['cancel', 'r9'], { runId: 'r9', state: 'exited', exit: 0, contract: 'shell' }, 0, 'cancel: the Run had already ended'],
    [['cancel', 'r9'], { runId: 'r9', state: 'lost', reason: 'daemon-shutdown', contract: 'shell' }, 1, 'cancel: lost — its end was never observed'],
    [['start', '--session', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'ready' }, 0, 'start: ready'],
    [['start', '--session', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'running' }, 0, 'start: alive with no readiness condition to check is success'],
    [['start', '--session', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'starting' }, 124, 'start: starting'],
    [['start', '--session', 's', '--command', 'x'], { runId: 'r1', state: 'running', service: 'unhealthy' }, 1, 'start: unhealthy'],
    [['start', '--session', 's', '--command', 'x'], { runId: 'r1', state: 'exited', exit: 0, service: 'exited' }, 1, 'start: exited'],
    [['start', '--session', 's', '--command', 'x'], { runId: 'r1', state: 'lost', service: 'lost' }, 1, 'start: lost'],
    [['start', '--session', 's', '--command', 'x'], { state: 'busy', busy: { runId: 'r0', reason: 'running' } }, 75, 'start: busy'],
    [['await', 'r1'], { runId: 'r1', state: 'exited', signal: 'SIGTERM' }, 143, 'await: a signal'],
    [['await', 'r1'], { runId: 'r1', state: 'exited', signal: 'SIGWHAT' }, 1, 'await: an unknown signal is never success'],
    [['await', 'r1'], { runId: 'r1', state: 'exited' }, 1, 'await: exited with neither a code nor a signal — status unknown'],
    [['await', 'r1'], { runId: 'r1', state: 'lost', reason: 'daemon-restart' }, 1, 'await: lost'],
    [['await', 'r1'], { runId: 'r1', state: 'queued' }, 124, 'await: queued'],
    [['run', 'q', 'x'], { runId: 'r1', state: 'exited', exit: 300 }, 255, 'run: a code past 255 is clamped'],
    [['run', 'q', 'x'], { state: 'busy', busy: { reason: 'human-editing', line: 'git sta' } }, 75, 'run: busy with a person editing a line'],
    [['run', 'q', '--until-done', '--', 'timeout', '1', 'sleep', '5'], { runId: 'r1', state: 'exited', exit: 124 }, 124, 'run --until-done: a 124 is the command’s own'],
  ];
  for (const [argv, answer, code, why] of cases) {
    const d = await cannedDaemon({ [argv[0]!]: answer });
    try {
      const r = await tsm(argv, { TSM_URL: `ws://127.0.0.1:${d.port}` });
      assert.equal(r.code, code, `${why}: ${argv.join(' ')} → ${JSON.stringify(answer)}: ${r.stderr}`);
    } finally {
      await d.close();
    }
  }
});

test('ux-18: after --, each word is one argument of the command under sh, bash, zsh, dash and fish', async () => {
  const d = await cannedDaemon({ run: { runId: 'r1', state: 'exited', exit: 0 } });
  const env = { TSM_URL: `ws://127.0.0.1:${d.port}` };
  try {
    // Every kind of word a shell would split, expand or read as syntax.
    const words = ['a;b', 'x  y', "it's", 'back\\slash', 'two\\\\back', "q\\'t", '$HOME', '*', '', '~/x', '~user', '==', '=ls', 'FOO=bar', '#no comment', 'a|b', 'c&d', '(e)', '`f`', '"g"', 'h>i', '{j,k}', 'l\nm', '!bang'];
    // Each word is framed in brackets, so a word split at a newline (two frames) cannot read as the one (the house's read, #22).
    const r = await tsm(['run', 'q', '--', 'printf', '[%s]\\n', ...words], env);
    assert.equal(r.code, 0, r.stderr);
    const command = d.calls[0]!.arguments.command as string;
    assert.ok(command.startsWith('printf '), command);
    const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'].filter((s) => fs.existsSync(s));
    assert.ok(shells.length >= 2, `shells found: ${shells.join(', ')}`);
    for (const shell of shells) {
      const out = await new Promise<string>((resolve, reject) => execFile(shell, ['-c', command], { env: { PATH: '/usr/bin:/bin', HOME: tmp } }, (e, stdout, stderr) => (e ? reject(new Error(`${shell}: ${e.message} ${stderr}`)) : resolve(stdout))));
      assert.equal(out, `${words.map((w) => `[${w}]`).join('\n')}\n`, shell);
    }
    // Plain words stay as they are; without --, the words are a command line for the shell to parse.
    await tsm(['run', 'q', '--', 'git', '-C', 'repo', 'log', '--oneline', '-5'], env);
    assert.equal(d.calls[1]!.arguments.command, 'git -C repo log --oneline -5');
    await tsm(['run', 'q', 'echo a | cat; echo "b c"'], env);
    assert.equal(d.calls[2]!.arguments.command, 'echo a | cat; echo "b c"');
    await tsm(['run', 'q', 'env', '--', 'FOO=a b', 'cmd'], env);
    assert.equal(d.calls[3]!.arguments.command, "env 'FOO=a b' cmd");
    // `--json` after `--` is the command's word, not tsm's flag: the result renders as transcript
    // text; before `--` it is tsm's and the result is JSON (the house's read, #22 comment 6269721389).
    const after = await tsm(['run', 'q', '--', 'echo', '--json'], env);
    assert.equal(d.calls[4]!.arguments.command, 'echo --json');
    assert.equal(after.stdout, '[canned]\n', 'transcript text, not JSON');
    assert.match(d.urls[4]!, /resultText=transcript/);
    const before = await tsm(['run', 'q', '--json', '--', 'echo', 'hi'], env);
    assert.equal(d.calls[5]!.arguments.command, 'echo hi');
    assert.deepEqual(JSON.parse(before.stdout), { runId: 'r1', state: 'exited', exit: 0 });
    assert.match(d.urls[5]!, /resultText=json/);
  } finally {
    await d.close();
  }
});

test('a large --json result reaches a reader that starts late, whole, and tsm still exits by its code', async () => {
  const text = 'x'.repeat(1_200_000);
  const d = await cannedDaemon({ read: { nextCursor: 1, text } });
  try {
    const r = await tsm(['read', 'big', '--since', '0', '--json'], { TSM_URL: `ws://127.0.0.1:${d.port}` }, { readAfterMs: 1000 });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.length, JSON.stringify({ nextCursor: 1, text }, null, 2).length + 1, 'every byte arrived');
    assert.equal((JSON.parse(r.stdout) as { text: string }).text.length, text.length);
  } finally {
    await d.close();
  }
});

test('a flag’s value takes the type of the tool’s parameter: text stays text, a yes/no flag stands alone', async () => {
  const d = await cannedDaemon({});
  const env = { TSM_URL: `ws://127.0.0.1:${d.port}` };
  try {
    const expected: Array<[string[], string, Record<string, unknown>]> = [
      [['search', '--session', 'q', '--pattern', '404'], 'search', { session: 'q', pattern: '404' }],
      [['input', 'q', '--text', '012345'], 'input', { session: 'q', text: '012345' }],
      [['run', 'q', '--command', 'true'], 'run', { session: 'q', command: 'true' }],
      [['run', 'q', '--queue', 'echo', 'hi'], 'run', { session: 'q', queue: true, command: 'echo hi' }],
      [['run', 'q', '--queue=false', 'echo', 'hi'], 'run', { session: 'q', queue: false, command: 'echo hi' }],
      [['input', 'q', '--keys', 'Enter,C-c', '--sensitive'], 'input', { session: 'q', keys: ['Enter', 'C-c'], sensitive: true }],
      [['input', 'q', '--keys', '["Enter","C-c"]'], 'input', { session: 'q', keys: ['Enter', 'C-c'] }],
      [['start', '--session', 's', '--command', 'x', '--ready', '{"pattern":"ok"}', '--wait=5s', '--name', '42'], 'start', { session: 's', command: 'x', ready: { pattern: 'ok' }, wait: 5000, name: '42' }],
      [['read', 'q', '--since', '0', '--tail=3', '--run-id', 'r7', '--as', 'events'], 'read', { session: 'q', since: 0, tail: 3, runId: 'r7', as: 'events' }],
      [['open', 's', '--cwd', '123', '--shell', '/bin/sh'], 'session_open', { session: 's', cwd: '123', shell: '/bin/sh' }],
      // A text parameter's value that looks like JSON is text: nothing is parsed before the schema
      // says what the parameter is (the house's read, #22 comment 6269721389).
      [['open', 's', '--cwd', '{work}'], 'session_open', { session: 's', cwd: '{work}' }],
      [['run', 'q', '--command', '{"a":1}'], 'run', { session: 'q', command: '{"a":1}' }],
      [['close', 's', '--force'], 'session_close', { session: 's', force: true }],
      [['await', 'r1', '--wait', '250'], 'await', { runId: 'r1', wait: 250 }],
    ];
    // The canned answers carry no state, so the exit code says nothing here; a parse error would show on stderr.
    for (const [argv] of expected) assert.equal((await tsm(argv, env)).stderr, '', argv.join(' '));
    assert.deepEqual(
      d.calls.map((c) => [c.name, c.arguments]),
      expected.map(([, name, args]) => [name, args]),
    );
    const missing = await tsm(['run', 'q', '--wait'], env);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--wait needs a value/);
    const badJson = await tsm(['start', '--session', 's', '--command', 'x', '--ready', '{bad'], env);
    assert.equal(badJson.code, 1);
    assert.match(badJson.stderr, /--ready: not valid JSON/);
    const stray = await tsm(['start', 's', '--command', 'x'], env);
    assert.equal(stray.code, 1);
    assert.match(stray.stderr, /start takes --flags only \(unexpected word s\)/);
    const extra = await tsm(['screen', 's', 'extra'], env);
    assert.equal(extra.code, 1);
    assert.match(extra.stderr, /screen: unexpected word extra/);
    // A flags-only tool's stray-word hint is built from the tool's schema: session_list takes no
    // parameters, so the hint says so and never suggests a --session it does not have (the house's
    // read, #22 comment 6264958172).
    const none = await tsm(['session_list', 'foo'], env);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /session_list takes no arguments \(unexpected word foo\)/);
    assert.doesNotMatch(none.stderr, /--session/);
    // The hint shows each flag as the parser takes it: a yes/no flag alone, never `--force <value>`,
    // which the parser then refused (the house's read, #22 comment 6269721389).
    const typedHint = await tsm(['session_close', 'foo'], env);
    assert.equal(typedHint.code, 1);
    assert.match(typedHint.stderr, /tsm session_close --session <value> --force --forget --idempotency-key <value>/);
    assert.doesNotMatch(typedHint.stderr, /--force <value>/);
    // A misspelt name is an unknown command, with the nearest names, not a hint about a tool that
    // does not exist; with or without a stray word (the house's read, #22 comment 6269721389).
    for (const argv of [['sesions', 'foo'], ['sesions'], ['sesions', '--json']]) {
      const typo = await tsm(argv, env);
      assert.equal(typo.code, 1, argv.join(' '));
      assert.match(typo.stderr, /^sesions is not a command or a tool the daemon lists \(did you mean sessions\?\); tsm --help lists the commands/m, argv.join(' '));
      assert.doesNotMatch(typo.stderr, /takes --flags only/, argv.join(' '));
      // tsm's own refusal is text on stderr, --json or not; only a daemon's error is {"error": …} on stdout.
      assert.equal(typo.stdout, '', argv.join(' '));
    }
    assert.equal(d.calls.length, expected.length, 'none of the errors reached the daemon');
  } finally {
    await d.close();
  }
});

test('a shorthand whose tool the daemon does not list is told the versions differ, with the remedy', async () => {
  // tsm asks for the full profile, which lists every tool of the daemon's version, so this branch is
  // met only across versions (the house's read, #22 comment 6274806357).
  const d = await cannedDaemon({}, { without: ['session_env_capture'] });
  try {
    const r = await tsm(['env-capture', 's'], { TSM_URL: `ws://127.0.0.1:${d.port}` });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^session_env_capture, the tool behind env-capture, is not one the daemon lists: this tsm and that termd are of different versions; update one to match, or call a tool the daemon lists by its name \(tsm <tool> --arg value\): run, /m);
    // The remedy names every tool the daemon lists, since tsm has no other way to show them (the house's read of the 33 commits, #22, comment 6307351372).
    for (const t of TOOLS.filter((x) => x.name !== 'session_env_capture')) assert.ok(r.stderr.includes(t.name), `${t.name} is named: ${r.stderr}`);
    assert.ok(!/[:,] session_env_capture\b/.test(r.stderr), 'the missing tool is not offered');
    assert.equal(r.stdout, '', 'a refusal of tsm’s own is text on stderr');
    assert.equal(d.calls.length, 0, 'nothing reached the daemon');
  } finally {
    await d.close();
  }
});

test('a daemon’s JSON-RPC error answer is {"error": ...} on stdout under --json, as the help says, and text on stderr without it', async () => {
  // request() rejected on the error answer and main's catch printed it on stderr either way (the house's read of
  // the 33 commits, #22, comment 6307351372).
  const message = 'internal error: the call failed outside the tool layer';
  const d = await cannedDaemon({}, { rpcError: message });
  const env = { TSM_URL: `ws://127.0.0.1:${d.port}` };
  try {
    const json = await tsm(['run', 's', '--json', '--', 'echo', 'hi'], env);
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.stdout), { error: message });
    assert.equal(json.stderr, '');
    const text = await tsm(['run', 's', '--', 'echo', 'hi'], env);
    assert.equal(text.code, 1);
    assert.equal(text.stdout, '');
    assert.equal(text.stderr.trim(), message);
    const help = await tsm(['--help'], env);
    assert.match(help.stdout.replace(/\s+/g, ' '), /a daemon's error \(a tool's error result, or an error the daemon answers a request with\) as \{"error": "\.\.\."\} on stdout with exit 1/);
  } finally {
    await d.close();
  }
});

test('every shorthand reaches its tool, over a connection that asks for the full profile as the native family', async () => {
  const d = await cannedDaemon({});
  const env = { TSM_URL: `ws://127.0.0.1:${d.port}` };
  try {
    const expected: Array<[string[], string, Record<string, unknown>]> = [
      [['sessions'], 'session_list', {}],
      [['open', 's', '--cwd', '/tmp'], 'session_open', { session: 's', cwd: '/tmp' }],
      [['close', 's'], 'session_close', { session: 's' }],
      [['declare', 's', 'fish'], 'session_declare_shell', { session: 's', shell: 'fish' }],
      [['screen', 's'], 'screen', { session: 's' }],
      [['input', 's', 'hello', 'world'], 'input', { session: 's', text: 'hello world' }],
      [['signal', 's', '--signal', 'SIGINT'], 'signal', { session: 's', signal: 'SIGINT' }],
      [['control', 's', 'take'], 'control', { session: 's', action: 'take' }],
      [['env-capture', 's'], 'session_env_capture', { session: 's' }],
      [['await', 's', 'r1'], 'await', { session: 's', runId: 'r1' }],
      [['cancel', 'r1'], 'cancel', { runId: 'r1' }],
      [['wait_for', '--session', 's', '--pattern', 'ok'], 'wait_for', { session: 's', pattern: 'ok' }],
    ];
    // The canned answers carry no state, so the exit code says nothing here; a parse error would show on stderr.
    for (const [argv] of expected) assert.equal((await tsm(argv, env)).stderr, '', argv.join(' '));
    assert.deepEqual(
      d.calls.map((c) => [c.name, c.arguments]),
      expected.map(([, name, args]) => [name, args]),
    );
    assert.equal(d.urls.length, expected.length);
    for (const u of d.urls) {
      const q = new URL(u, 'ws://x').searchParams;
      assert.equal(q.get('profile'), 'full', u);
      assert.equal(q.get('client'), 'cli', u);
    }
  } finally {
    await d.close();
  }
});

test('--until-done awaits again and again until the Run has ended, not once', async () => {
  const d = await cannedDaemon({
    run: { runId: 'r1', state: 'running', session: 'u' },
    await: [{ runId: 'r1', state: 'running' }, { runId: 'r1', state: 'running' }, { runId: 'r1', state: 'exited', exit: 3 }],
  });
  try {
    const r = await tsm(['run', 'u', '--until-done', '--json', '--', 'sleep', '9'], { TSM_URL: `ws://127.0.0.1:${d.port}` });
    assert.equal(r.code, 3, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as { state: string; exit: number }).exit, 3);
    assert.deepEqual(
      d.calls.map((c) => c.name),
      ['run', 'await', 'await', 'await'],
    );
    assert.deepEqual(d.calls[1]!.arguments, { runId: 'r1', wait: 55_000, session: 'u' });
  } finally {
    await d.close();
  }
});

test('upgrade refusals give the agent an operator action without protocol text or a second daemon', async () => {
  let status = 401;
  const refused = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (_info, done) => done(false, status) });
  await new Promise<void>((resolve) => refused.once('listening', resolve));
  try {
    const port = (refused.address() as { port: number }).port;
    for (const [code, advice] of [
      [401, /ask.*operator.*token/i],
      [403, /ask.*operator.*(origin|proxy|url)/i],
      [421, /--allow-host.*restart/i],
      [429, /per-principal.*close.*connections.*retry/i],
      [503, /unavailable.*retry/i],
    ] as const) {
      status = code;
      const r = await tsm(['sessions'], { TSM_URL: `ws://127.0.0.1:${port}`, TSM_TOKEN: 'incorrect' });
      assert.equal(r.code, 1, `${code}: ${r.stderr}`);
      assert.match(r.stderr, advice, `${code}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /Unexpected server response|start termd with|--allow-host 127\.0\.0\.1/, `${code}: no raw protocol or second-daemon advice`);
    }
  } finally {
    await new Promise<void>((resolve) => refused.close(() => resolve()));
  }
});

test('--until-done keeps awaiting past the per-call wait until the Run has ended, and exits with its code', async () => {
  let sh!: FakeShell;
  const backend = fakeShellBackend((shell) => {
    sh = shell;
    sh.on(/^sleep/, () => ({ hang: true }));
  });
  const registry = new SessionRegistry({ dataDir: path.join(tmp, 'd-until'), backend, defaultShell: '/bin/bash', noUserRc: true });
  const app = new App({ registry, defaultWaitMs: 2000 });
  const waits: Array<number | undefined> = [];
  const awaitRun = app.awaitRun.bind(app);
  app.awaitRun = async (caller, o) => {
    waits.push(o.wait);
    return awaitRun(caller, o);
  };
  const server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { tk: 'agent:cli@test' } }), host: '127.0.0.1', port: 0 });
  const { port } = await server.listen();
  const env = { TSM_URL: `ws://127.0.0.1:${port}`, TSM_TOKEN: 'tk' };
  try {
    const pending = tsm(['run', 'u', '--wait', '0', '--until-done', '--json', '--', 'sleep', '9'], env);
    // A zero initial wait becomes one long poll, rather than thousands of immediate calls. Poll for
    // the shell to start and the long-poll await to be issued, so a loaded machine does not fail a
    // fixed wait (the house's read, #22 comment 6264958172).
    await until(() => Boolean(sh) && waits.length > 0, 5000);
    assert.ok(sh, 'the shell started');
    assert.deepEqual(waits, [55_000]);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(waits, [55_000], 'one long poll, not a loop of short ones');
    sh.finishHung(3, 'took a while\r\n');
    const r = await pending;
    assert.equal(r.code, 3, `exit code: ${r.stderr}`);
    const out = JSON.parse(r.stdout) as { state: string; exit: number };
    assert.deepEqual([out.state, out.exit], ['exited', 3]);
    // Without the flag the same call exits 124 once its wait ran out.
    const once = await tsm(['run', 'u', '--wait', '200ms', '--', 'sleep', '9'], env);
    assert.equal(once.code, 124);
    sh.finishHung(0);
  } finally {
    await server.close();
    await registry.closeAll({ graceful: false });
  }
});

test('tsm usage: the report and --since; a date that does not parse or a log that cannot be read is an error', async () => {
  const T0 = Date.parse('2026-10-19T10:00:00Z');
  const record = (ts: number, tool: string): UsageRecord => ({ ts, principal: 'agent:a@x', connection: 'c1', host: 'mcp', profile: 'full', tool, ok: true, ms: 5, args: [] });
  const file = path.join(tmp, 'usage.jsonl');
  fs.writeFileSync(file, [record(T0, 'run'), record(T0 + 1000, 'read'), record(T0 + 2000, 'await')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const all = await tsm(['usage', '--file', file, '--json'], {});
  assert.equal(all.code, 0, all.stderr);
  const report = JSON.parse(all.stdout) as { calls: number; agentCalls: number };
  assert.deepEqual([report.calls, report.agentCalls], [3, 3]);
  const since = await tsm(['usage', `--file=${file}`, '--since', new Date(T0 + 1500).toISOString(), '--json'], {});
  assert.equal((JSON.parse(since.stdout) as { calls: number }).calls, 1);
  const text = await tsm(['usage', '--file', file], {});
  assert.match(text.stdout, /^3 calls, /);
  const garbage = await tsm(['usage', '--file', file, '--since', 'garbage'], {});
  assert.equal(garbage.code, 1, garbage.stdout);
  assert.match(garbage.stderr, /--since: not a date/);
  assert.equal(garbage.stdout, '');
  const dir = await tsm(['usage', '--file', tmp], {});
  assert.equal(dir.code, 1, `a directory is not a log: ${dir.stdout}`);
  assert.match(dir.stderr, /cannot read the usage log/);
  if (process.getuid?.() !== 0) {
    const sealed = path.join(tmp, 'sealed.jsonl');
    fs.copyFileSync(file, sealed);
    fs.chmodSync(sealed, 0);
    const r = await tsm(['usage', '--file', sealed], {});
    assert.equal(r.code, 1, `mode 000: ${r.stdout}`);
    assert.match(r.stderr, /cannot read the usage log/);
    fs.chmodSync(sealed, 0o600);
  }
  const missing = await tsm(['usage', '--file', path.join(tmp, 'none.jsonl')], {});
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /^no usage recorded in /);
  const unknown = await tsm(['usage', '--bogus'], {});
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown argument --bogus/);
});

test('without a daemon, only what the syntax alone can tell is said: a stray word is; a flag’s missing value is not', async () => {
  const env = { TSM_URL: `ws://127.0.0.1:${await unusedPort()}` };
  // The schema-built hint needs the daemon; without one the stray word is still said first (a
  // reviewer's read of a088780, #22), and the hint says no daemon listed the flags.
  const r = await tsm(['session_list', 'foo'], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /session_list takes --flags only \(unexpected word foo\); no daemon answered to list them/);
  assert.doesNotMatch(r.stderr, /cannot reach|--session/);
  // A flag of unknown type with no value may be a yes/no flag, so before the schema nothing can call
  // its value missing: the connection error is the truth (the house's read, #22 comment 6269721389).
  for (const argv of [['run', 'q', '--wait'], ['open', 's', '--cwd']]) {
    const missing = await tsm(argv, env);
    assert.equal(missing.code, 1, argv.join(' '));
    assert.match(missing.stderr, /cannot reach the daemon/, argv.join(' '));
    assert.doesNotMatch(missing.stderr, /needs a value/, argv.join(' '));
  }
  // A text value that looks like JSON is not refused before the schema either.
  const json = await tsm(['open', 's', '--cwd', '{work}'], env);
  assert.match(json.stderr, /cannot reach the daemon/);
  assert.doesNotMatch(json.stderr, /not valid JSON/);
  const absent = await tsm(['sessions'], env);
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /ask.*operator.*URL/i, 'an unreachable daemon has a next step');
  assert.doesNotMatch(absent.stderr, /ECONNREFUSED|AggregateError/, 'the agent sees advice instead of library details');
});

test('an empty TSM_URL is unset: the default daemon address is dialled', async (t) => {
  // The empty value is unset, as the shell leaves a variable it exported and then cleared (the house's
  // read, #22 comment 6269721389).
  const dialled = await tsm(['sessions'], { TSM_URL: '', TSM_TOKEN: 'not-a-token' });
  // A daemon of this machine's own on 3101 that admits anyone would answer instead of refusing. The
  // TSM_DATA_DIR half is its own test, so this skip costs nothing else (the house's read, #22 comment 6274806357).
  if (dialled.code === 0) return t.skip('a daemon on this machine answers on 3101 without a token');
  assert.equal(dialled.code, 1, dialled.stdout);
  assert.match(dialled.stderr, /the daemon at ws:\/\/127\.0\.0\.1:3101/, dialled.stderr);
});

test('an empty TSM_DATA_DIR is unset: tsm usage reads ~/.tsm', async () => {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.tsm'), { recursive: true });
  const record = (ts: number, tool: string): UsageRecord => ({ ts, principal: 'agent:a@x', connection: 'c1', host: 'mcp', profile: 'full', tool, ok: true, ms: 5, args: [] });
  fs.writeFileSync(path.join(home, '.tsm', 'usage.jsonl'), [record(1, 'run'), record(2, 'read')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const other = path.join(tmp, 'other-data');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'usage.jsonl'), JSON.stringify(record(3, 'await')) + '\n');
  const calls = async (env: NodeJS.ProcessEnv) => {
    const r = await tsm(['usage', '--json'], { HOME: home, ...env });
    assert.equal(r.code, 0, r.stderr);
    return (JSON.parse(r.stdout) as { calls: number }).calls;
  };
  assert.equal(await calls({ TSM_DATA_DIR: '' }), 2, 'an empty TSM_DATA_DIR reads ~/.tsm');
  assert.equal(await calls({ TSM_DATA_DIR: other }), 1, 'a set one is read');
});
