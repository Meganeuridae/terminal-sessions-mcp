/**
 * The shipped configurations work as written (next/config): under the agent-framework
 * recipe a completion names no channel to reply in and a reply published into the
 * terminal is refused, so an answer to a wake goes to the person, not into the terminal
 * (mcpl-17); the bridge entry registers channels, so `mcpl_open` and
 * `mcpl_send` work (mcpl-20); and the supervisor launcher starts termd under a
 * supervisor's bare PATH, in $HOME, with process Runs that find the toolchain
 * and an owner-only log (tsg-21, ux-16).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { ScriptedBackend } from '../src/backends/scripted.js';
import { TermServer } from '../src/transport/server.js';
import { FakeShell } from './fake-shell.js';
import { until } from './testhost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(here, '../../config');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-config-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Msg = { id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** An MCPL host connection that does what a host with this config does: initialize, send its policy, then call. */
async function host(port: number): Promise<{ request(method: string, params?: unknown): Promise<Msg>; received: Msg[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=ta&resultText=transcript`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  let id = 0;
  const pending = new Map<number, (m: Msg) => void>();
  const received: Msg[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    if (m.method === undefined && m.id !== undefined) pending.get(m.id)?.(m);
    else if (m.method !== undefined) {
      received.push(m);
      if (m.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'push/event' ? { accepted: true } : {} })); // accept channels/register, push/event and the like
    }
  });
  return {
    received,
    request: (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
      }),
    close: () => ws.close(1000),
  };
}

async function scriptedDaemon(): Promise<{ port: number; registry: SessionRegistry; shell(): FakeShell; close(): Promise<void> }> {
  const backend = new ScriptedBackend();
  let shell: FakeShell | undefined;
  backend.onSpawnShell = (p) => {
    const sh = new FakeShell(p);
    shell = sh;
    sh.on('echo hi', () => ({ output: 'hi\r\n', exit: 0 }));
    sh.on(/^sleep/, () => ({ hang: true }));
    const kill = p.kill.bind(p);
    p.kill = (sig) => {
      kill(sig);
      if (sig === 'SIGHUP' || sig === 'SIGKILL') p.exit({ exitCode: null, signal: sig });
    };
  };
  const registry = new SessionRegistry({ dataDir: fs.mkdtempSync(path.join(tmp, 'd-')), backend, defaultShell: '/bin/bash', noUserRc: true });
  const server = new TermServer({ app: new App({ registry, defaultWaitMs: 2000 }), resolver: new TokenMapResolver({ tokens: { ta: 'agent:a@x' } }), host: '127.0.0.1', port: 0 });
  const { port } = await server.listen();
  return {
    port,
    registry,
    shell: () => shell!,
    async close() {
      await server.close();
      await registry.closeAll();
    },
  };
}

const MCPL_INIT = { protocolVersion: '2025-06-18', capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: 'config-spec', version: '0' } };
/** What agent-framework grants a server (every capability this server declares that the host honours). */
const AF_GRANT = ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish', 'contextHooks.beforeInference.inject.beforeUser'];

test("mcpl-17: with the shipped agent-framework recipe, a completion's push origin names the session's channel but no channel to reply in, and a reply published into the terminal is refused; annotate is an explicit opt-in", async () => {
  const recipe = (JSON.parse(fs.readFileSync(path.join(CONFIG, 'agent-framework.recipe.json'), 'utf8')) as { mcplServers: Array<{ enabledFeatureSets: string[] }> }).mcplServers[0]!;
  assert.ok(!recipe.enabledFeatureSets.includes('terminal.annotate'), 'the recipe does not turn notes on');
  const d = await scriptedDaemon();
  try {
    const h = await host(d.port);
    await h.request('initialize', MCPL_INIT);
    const receipt = await h.request('featureSets/update', { effectiveCapabilities: AF_GRANT, enabled: recipe.enabledFeatureSets });
    assert.equal(receipt.error, undefined, JSON.stringify(receipt));
    // A command that outlives its wait: its completion comes as a push event.
    const r = await h.request('tools/call', { name: 'run', arguments: { session: 'woke', command: 'sleep 1', wait: 50 } });
    assert.equal((r.result?.structuredContent as { state?: string } | undefined)?.state, 'running', JSON.stringify(r.result));
    d.shell().finishHung(0, 'woke up\r\n');
    await until(() => h.received.some((m) => m.method === 'push/event'), 5000, 'the completion push');
    const push = h.received.find((m) => m.method === 'push/event')!.params as { origin: Record<string, unknown>; tags?: string[] };
    assert.equal(push.origin.channelId, 'terminal:woke', 'the origin names the session');
    assert.ok(!('mcplChannelId' in push.origin), 'and no channel to reply in: a completion is news, not a message to answer');
    // Were a host to publish a reply into the terminal anyway, the recipe refuses it: notes are an opt-in.
    await h.request('channels/open', { channelId: 'terminal:woke' });
    const refused = await h.request('channels/publish', { conversationId: 'c', channelId: 'terminal:woke', content: [{ type: 'text', text: 'build looks good' }] });
    assert.equal(refused.error?.code, -32017, JSON.stringify(refused));
    const s = d.registry.get('woke');
    assert.ok(s && s.kind === 'live');
    assert.ok(!s.session.journal.since(0).events.some((e) => e.type === 'note'), 'nothing was recorded');
    // With terminal.annotate enabled on purpose, the same publish is a note for observers.
    await h.request('featureSets/update', { effectiveCapabilities: AF_GRANT, enabled: [...recipe.enabledFeatureSets, 'terminal.annotate'] });
    const published = await h.request('channels/publish', { conversationId: 'c', channelId: 'terminal:woke', content: [{ type: 'text', text: 'build looks good' }] });
    assert.equal(published.error, undefined, JSON.stringify(published.error));
    assert.equal(published.result?.delivered, true);
    assert.ok(s.session.journal.since(0).events.some((e) => e.type === 'note' && e.text === 'build looks good'), 'the note is in the journal');
    h.close();
  } finally {
    await d.close();
  }
});

test('mcpl-20: the shipped bridge entry registers sessions as channels (mcpl_open works) and records mcpl_send as a note', async () => {
  const entry = (JSON.parse(fs.readFileSync(path.join(CONFIG, 'mcpl-bridge.json'), 'utf8')) as { servers: { terminal: { grant: string[]; enableFeatureSets: string[]; wake: { wake: string[][] } } } }).servers.terminal;
  const d = await scriptedDaemon();
  try {
    const h = await host(d.port);
    await h.request('initialize', MCPL_INIT);
    await h.request('featureSets/update', { effectiveCapabilities: entry.grant, enabled: entry.enableFeatureSets });
    await h.request('tools/call', { name: 'session_open', arguments: { session: 'bridged' } });
    const list = await h.request('channels/list');
    assert.ok(((list.result?.channels as Array<{ id: string }>) ?? []).some((c) => c.id.endsWith('bridged')), `channels are registered: ${JSON.stringify(list)}`);
    const opened = await h.request('channels/open', { channelId: 'terminal:bridged' });
    assert.equal(opened.error, undefined, JSON.stringify(opened.error));
    const sent = await h.request('channels/publish', { channelId: 'terminal:bridged', content: [{ type: 'text', text: 'from the bridge' }] });
    assert.equal(sent.result?.delivered, true, JSON.stringify(sent));
    h.close();
    // The docs promise watch firings wake only with the watch tier: the config's README says so.
    const readme = fs.readFileSync(path.join(CONFIG, 'README.md'), 'utf8');
    assert.ok(entry.enableFeatureSets.includes('terminal.watch') || /Watch firings wake too once you add `terminal.watch`/.test(readme));
  } finally {
    await d.close();
  }
});

test('tsg-21/ux-16: the supervisor launcher starts termd under a bare PATH, in $HOME, with the toolchain on PATH for process Runs and an owner-only log', async () => {
  const home = path.join(tmp, 'home');
  const volta = path.join(home, '.volta', 'bin');
  fs.mkdirSync(volta, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(volta, 'node'));
  const dataDir = path.join(tmp, 'launched');
  // launchd's environment: this PATH has no node on it.
  const child = spawn('/bin/sh', [path.join(CONFIG, 'termd-launch.sh'), '--port', '0', '--data-dir', dataDir, '--no-usage-log', '--shell', '/bin/bash'], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: os.userInfo().username, HISTFILE: path.join(home, '.bash_history') },
    cwd: '/',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
  const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  const darwin = process.platform === 'darwin';
  const logFile = path.join(home, 'Library', 'Logs', 'termd', 'termd.log');
  const listening = () => (darwin ? (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '') : stderr).split('\n').find((l) => l.includes('"listening"'));
  try {
    const end = Date.now() + 15_000;
    while (!listening() && Date.now() < end && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
    assert.ok(listening(), `termd did not start: ${stderr}`);
    const { url } = JSON.parse(listening()!) as { url: string };
    const ws = new WebSocket(`${url}/?profile=full`);
    await new Promise<void>((r, j) => {
      ws.once('open', () => r());
      ws.once('error', j);
    });
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (m) => {
          const msg = JSON.parse(m.toString()) as { id?: number; result?: { structuredContent: Record<string, unknown> } };
          if (msg.id === id) resolve(msg.result?.structuredContent ?? {});
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
      });
    const where = await call(1, 'run', { session: 'sup', command: 'pwd', wait: 10_000 });
    assert.equal(((where.output as { text: string }).text ?? '').trim(), home, 'sessions start in $HOME, not launchd\'s /');
    const tools = await call(2, 'run', { session: 'sup', target: 'process', command: 'command -v node', wait: 10_000 });
    assert.equal(tools.state, 'exited', JSON.stringify(tools));
    assert.equal(((tools.output as { text: string }).text ?? '').trim(), path.join(volta, 'node'), 'a process Run finds the toolchain');
    ws.close();
    if (darwin) {
      assert.equal(fs.statSync(logFile).mode & 0o077, 0, 'the log is owner-only');
      assert.equal(fs.statSync(path.dirname(logFile)).mode & 0o077, 0);
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('tsg-21: the plist is valid and runs the launcher; the systemd unit lets termd drain before anything else is signalled', (t) => {
  const plist = fs.readFileSync(path.join(CONFIG, 'com.animalabs.termd.plist'), 'utf8');
  assert.match(plist, /<string>\/bin\/sh<\/string>\s*<string>PACKAGE\/next\/config\/termd-launch\.sh<\/string>/);
  assert.doesNotMatch(plist, /\/tmp\//, 'no log in world-writable /tmp');
  // No umask imposed by a supervisor: termd's files are owner-only by mode, and the sessions
  // inherit the mask, so files they create keep the usual permissions.
  assert.doesNotMatch(plist, /<key>Umask<\/key>/);
  const unit = fs.readFileSync(path.join(CONFIG, 'termd.service'), 'utf8');
  assert.doesNotMatch(unit, /^UMask=/m);
  assert.match(unit, /^OOMPolicy=continue$/m);
  assert.match(unit, /^LimitNOFILE=\d+$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.match(unit, /^WorkingDirectory=%h$/m);
  assert.match(unit, /termd-launch\.sh/);
  if (process.platform !== 'darwin') return t.skip('plutil is macOS only');
  execFileSync('plutil', ['-lint', path.join(CONFIG, 'com.animalabs.termd.plist')]);
});
