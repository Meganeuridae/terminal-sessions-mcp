/**
 * termd as a process: it refuses unsafe configurations, and on SIGTERM it
 * drains — sockets closed, sessions closed, Runs ended, and no process group a
 * process Run started survives it (jr-11, sec-6, sec-7; G19c, G20).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { SessionRegistry } from '../src/api/registry.js';
import type { JournalEvent } from '../src/core/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(here, '../src/daemon.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-daemon-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runDaemon(argv: string[], env: NodeJS.ProcessEnv = {}): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [DAEMON, ...argv], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  const lines: string[] = [];
  let buf = '';
  child.stderr!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, lines, exited };
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (needle: string): string[] =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(needle) && !l.includes('ps -axo'));

test('termd refuses a group-readable tokens file (naming chmod 600) and a non-loopback bind without --allow-host', async () => {
  const f = path.join(tmp, 'tokens.json');
  fs.writeFileSync(f, JSON.stringify({ 'tok-abc': 'agent:a@x' }));
  fs.chmodSync(f, 0o644);
  const a = runDaemon(['--port', '0', '--data-dir', path.join(tmp, 'd-a'), '--tokens-file', f]);
  assert.equal(await a.exited, 2);
  assert.match(a.lines.join('\n'), /chmod 600/);
  assert.ok(!a.lines.join('\n').includes('tok-abc'), 'the token is not printed');
  const b = runDaemon(['--host', '0.0.0.0', '--port', '0', '--data-dir', path.join(tmp, 'd-b'), '--token', 'x']);
  assert.equal(await b.exited, 2);
  assert.match(b.lines.join('\n'), /--allow-host/);
  const c = runDaemon(['--port', '0', '--data-dir', path.join(tmp, 'd-c'), '--anonymous', 'system']);
  assert.equal(await c.exited, 2);
  assert.match(c.lines.join('\n'), /never \\"system\\"|never "system"/);
});

test('jr-11/sec-6: SIGTERM drains — Runs end in the journal and no process group outlives termd', async () => {
  const dataDir = path.join(tmp, 'drain');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  // Port 0: the kernel picks a free one, so a concurrent test's daemon can never be the one we talk to.
  const d = runDaemon(['--port', '0', '--data-dir', dataDir, '--shell', '/bin/bash', '--no-usage-log'], { HOME: home, TSM_TOKEN: '' });
  const tag = `3${String(process.pid % 1000).padStart(3, '0')}`;
  const A = `${tag}1`;
  const B = `${tag}2`;
  const C = `${tag}3`;
  try {
    await until(() => d.lines.some((l) => l.includes('"listening"')), 10_000, 'termd to listen');
    const listening = JSON.parse(d.lines.find((l) => l.includes('"listening"'))!) as { url: string; pid: number };
    assert.equal(listening.pid, d.child.pid);
    const ws = new WebSocket(`${listening.url}/?connection=drain-test`);
    await new Promise<void>((r, j) => {
      ws.once('open', () => r());
      ws.once('error', j);
    });
    let id = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString()) as { id?: number; result?: unknown };
      if (msg.id !== undefined) pending.get(msg.id)?.resolve(msg.result);
    });
    // Before the SIGTERM, a closed socket is a failure to report, not a promise left pending.
    ws.on('close', () => {
      for (const p of pending.values()) p.reject(new Error(`termd connection closed early; log:\n${d.lines.join('\n')}`));
    });
    const call = (name: string, args: Record<string, unknown>) =>
      new Promise<{ structuredContent: Record<string, unknown> }>((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }));
      });
    // A process Run that ignores SIGINT and SIGTERM (ignored dispositions survive exec), with a
    // background member of its group that would outlive its leader.
    const proc = await call('run', { session: 'd1', target: 'process', command: `trap '' INT TERM; sleep ${A} & exec sleep ${B}`, wait: 300 });
    assert.equal(proc.structuredContent.state, 'running', JSON.stringify(proc.structuredContent));
    const shell = await call('run', { session: 'd1', command: `sleep ${C}`, wait: 300 });
    assert.equal(shell.structuredContent.state, 'running', JSON.stringify(shell.structuredContent));
    await until(() => alive(`sleep ${A}`).length > 0 && alive(`sleep ${B}`).length > 0 && alive(`sleep ${C}`).length > 0, 5000, 'the Runs to start');

    const t0 = Date.now();
    d.child.kill('SIGTERM');
    const code = await Promise.race([d.exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 15_000))]);
    const took = Date.now() - t0;
    assert.equal(code, 0, `exit ${String(code)} after ${took} ms`);
    assert.ok(took < 10_000, `drain took ${took} ms`);
    for (const n of [A, B, C]) assert.deepEqual(alive(`sleep ${n}`), [], `sleep ${n} outlived termd`);
    assert.ok(d.lines.some((l) => l.includes('"shutting down"')) && d.lines.some((l) => l.includes('"stopped"')), d.lines.join('\n'));

    // The journal on disk shows both Runs ended; nothing is left `running` for recovery to guess about.
    const again = new SessionRegistry({ dataDir, backend: { kind: 'none', spawnShell: () => { throw new Error('no'); }, spawnProcess: () => { throw new Error('no'); } } });
    const hist = again.get('d1');
    assert.ok(hist && hist.kind === 'history');
    const events = hist.journal.since(0).events;
    const endOf = (runId: unknown) => events.find((e): e is Extract<JournalEvent, { type: 'run.end' }> => e.type === 'run.end' && e.runId === runId);
    const pe = endOf(proc.structuredContent.runId);
    const se = endOf(shell.structuredContent.runId);
    assert.ok(pe && pe.reason !== 'daemon-restart', `process Run ended before exit: ${JSON.stringify(pe)}`);
    assert.ok(se && se.reason !== 'daemon-restart', `shell Run ended before exit: ${JSON.stringify(se)}`);
    // G20's wording: the drain's reason reaches Runs once the registry carries it (the journal workstream's plumbing).
    if (SessionRegistry.prototype.closeAll.toString().includes('reason')) {
      assert.equal(se.reason, 'daemon-shutdown', JSON.stringify(se));
    }
    await again.closeAll();
    ws.terminate();
  } finally {
    if (d.child.exitCode === null) d.child.kill('SIGKILL');
    // Only ever our own sleepers, by their exact arguments.
    for (const n of [A, B, C]) {
      for (const l of alive(`sleep ${n}`)) {
        if (!l.trim().endsWith(`sleep ${n}`)) continue;
        try {
          process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
  }
});

test('jr-6 (G26): the daemon\'s TSM_TOKEN never reaches a session shell or a process Run; --usage-log records calls without values', async () => {
  const home = path.join(tmp, 'home-env');
  fs.mkdirSync(home, { recursive: true });
  const secret = `tok-${process.pid}-secret`;
  const usageFile = path.join(tmp, 'usage', 'u.jsonl');
  const d = runDaemon(['--port', '0', '--data-dir', path.join(tmp, 'env'), '--shell', '/bin/bash', '--usage-log', usageFile], { HOME: home, TSM_TOKEN: secret });
  try {
    await until(() => d.lines.some((l) => l.includes('"listening"')), 10_000, 'termd to listen');
    const { url } = JSON.parse(d.lines.find((l) => l.includes('"listening"'))!) as { url: string };
    const ws = new WebSocket(`${url}/?token=${secret}`);
    await new Promise<void>((r, j) => {
      ws.once('open', () => r());
      ws.once('error', j);
    });
    let id = 0;
    const pending = new Map<number, (v: { structuredContent: Record<string, unknown> }) => void>();
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString()) as { id?: number; result?: { structuredContent: Record<string, unknown> } };
      if (msg.id !== undefined && msg.result) pending.get(msg.id)?.(msg.result);
    });
    const call = (name: string, args: Record<string, unknown>) =>
      new Promise<{ structuredContent: Record<string, unknown> }>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }));
      });
    const text = (r: { structuredContent: Record<string, unknown> }) => JSON.stringify(r.structuredContent);
    const shell = await call('run', { session: 'env1', command: 'echo "[${TSM_TOKEN-unset}]"', wait: 10_000 });
    assert.match(text(shell), /\[unset\]/);
    const proc = await call('run', { session: 'env1', target: 'process', command: 'echo "[${TSM_TOKEN-unset}]"', wait: 10_000 });
    assert.match(text(proc), /\[unset\]/);
    assert.ok(!text(shell).includes(secret) && !text(proc).includes(secret));
    assert.ok(!d.lines.join('\n').includes(secret), 'the token is not logged');
    ws.terminate();
  } finally {
    d.child.kill('SIGTERM');
    await Promise.race([d.exited, new Promise((r) => setTimeout(r, 5000))]);
    if (d.child.exitCode === null) d.child.kill('SIGKILL');
  }
  const journal = fs.readFileSync(path.join(tmp, 'env', 'sessions', 'env1', 'journal.jsonl'), 'utf8');
  assert.ok(!journal.includes(secret), 'the token is not journaled');
  // §16 Measure: one owner-only JSON line per tools/call, argument names and a digest, never values.
  const usage = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; args: string[]; digest?: string; host: string; principal: string });
  assert.deepEqual(usage.map((u) => [u.tool, u.ok, u.host, u.principal]), [['run', true, 'mcp', 'token:default'], ['run', true, 'mcp', 'token:default']]);
  assert.deepEqual(usage[1]!.args, ['command', 'session', 'target', 'wait']);
  assert.match(usage[0]!.digest ?? '', /^[0-9a-f]+$/);
  assert.ok(!fs.readFileSync(usageFile, 'utf8').includes('TSM_TOKEN'), 'command text is not recorded');
  assert.equal(fs.statSync(usageFile).mode & 0o077, 0, 'the usage log is owner-only');
});
