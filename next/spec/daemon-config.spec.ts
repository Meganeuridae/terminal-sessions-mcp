/**
 * The shipped configurations work as written (next/config): under the agent-framework
 * recipe a completion names no channel to reply in and a reply published into the
 * terminal is refused, so an answer to a wake goes to the person, not into the terminal
 * (mcpl-17); the bridge entry registers channels, so `mcpl_open` and
 * `mcpl_send` work (mcpl-20); the bridge's wake list and the gate match what the
 * server marks immediate; the package ships what the units run; and the supervisor
 * launcher starts termd under a supervisor's bare PATH, in $HOME, with process Runs
 * that find the toolchain and an owner-only log (tsg-21, ux-16), finds nvm's default
 * node, keeps TSM_NODE for termd, works by a relative path and says when the hard
 * file limit holds it low (the house's read of 59f660b, #22).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { askDataDir, titlePort } from '../src/shim/running.js';
import { TermServer } from '../src/transport/server.js';
import { fakeShellBackend, type FakeShell } from './fake-shell.js';
import { until, unusedPort } from './testhost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(here, '../../config');
const ROOT = path.resolve(CONFIG, '../..');
const LAUNCHER = path.join(CONFIG, 'termd-launch.sh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-config-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Msg = { id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

// launchd's environment: this PATH has no node on it.
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Stands in for termd under the launcher (through TSM_DAEMON): reports how it was started, then exits. No daemon runs. */
const STAND_IN = path.join(tmp, 'stand-in.mjs');
fs.writeFileSync(
  STAND_IN,
  "import { execFileSync } from 'node:child_process';\n" +
    "const nofile = execFileSync('/bin/sh', ['-c', 'ulimit -Sn'], { encoding: 'utf8' }).trim();\n" +
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), nofile }));\n',
);

interface Launched {
  code: number | null;
  stdout: string;
  stderr: string;
  /** What the stand-in reported, when the launcher got as far as starting it. */
  started?: { argv: string[]; env: Record<string, string>; cwd: string; nofile: string };
}

/**
 * Runs the launcher as a supervisor does: a bare PATH, the given HOME, the stand-in for
 * termd unless `env` says otherwise. `through` wraps the launcher in a shell command
 * (`$0` is the script, `$@` its arguments) for a test that must set limits first.
 */
function launch(script: string, args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; through?: string } = {}): Promise<Launched> {
  const merged: NodeJS.ProcessEnv = { PATH: BARE_PATH, TSM_DAEMON: STAND_IN, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const child = spawn('/bin/sh', [...(opts.through ? ['-c', opts.through] : []), script, ...args], { env: merged, cwd: opts.cwd ?? '/', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (b: Buffer) => (stdout += b.toString()));
  child.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
  return new Promise((resolve) =>
    child.on('close', (code) => {
      let started: Launched['started'];
      try {
        started = JSON.parse(stdout) as Launched['started'];
      } catch {
        started = undefined;
      }
      resolve({ code, stdout, stderr, ...(started && { started }) });
    }),
  );
}

/** A home with a node where Volta puts its shim: the way the toolchain is found when nothing else is at stake. */
function voltaHome(name: string): string {
  const home = path.join(tmp, name);
  const bin = path.join(home, '.volta', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return home;
}

/**
 * A home with nvm's layout: installed versions (the good one is this node; a wrong one
 * fails loudly, so a mistaken choice names itself) and alias files as nvm writes them.
 * The fixtures point at process.execPath, never at a `node` on PATH: a version manager's
 * shim there would resolve `node` through PATH back to the fixture, without end.
 */
function nvmHome(name: string, versions: Record<string, 'good' | 'bad'>, aliases: Record<string, string>): string {
  const home = path.join(tmp, name);
  const nvm = path.join(home, '.nvm');
  for (const [v, kind] of Object.entries(versions)) {
    const bin = path.join(nvm, 'versions', 'node', v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (kind === 'good') fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    else fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho "the wrong node: $0" >&2\nexit 97\n', { mode: 0o755 });
  }
  for (const [alias, target] of Object.entries(aliases)) {
    const file = path.join(nvm, 'alias', alias);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, target);
  }
  return home;
}

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
  let shell: FakeShell | undefined;
  const backend = fakeShellBackend((sh) => {
    shell = sh;
    sh.on('echo hi', () => ({ output: 'hi\r\n', exit: 0 }));
    sh.on(/^sleep/, () => ({ hang: true }));
  });
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

type BridgeEntry = { grant: string[]; enableFeatureSets: string[]; wake: { wake: string[][]; hold: string[][] } };
const bridgeEntry = (): BridgeEntry => (JSON.parse(fs.readFileSync(path.join(CONFIG, 'mcpl-bridge.json'), 'utf8')) as { servers: { terminal: BridgeEntry } }).servers.terminal;

test('mcpl-20: the shipped bridge entry registers sessions as channels (mcpl_open works), streams what happens in an open one, and records mcpl_send as a note', async () => {
  const entry = bridgeEntry();
  const d = await scriptedDaemon();
  try {
    const h = await host(d.port);
    await h.request('initialize', MCPL_INIT);
    await h.request('featureSets/update', { effectiveCapabilities: entry.grant, enabled: entry.enableFeatureSets });
    await h.request('tools/call', { name: 'session_open', arguments: { session: 'bridged' } });
    // Listing and opening a channel need only the granted capabilities; the entry's `terminal.channels`
    // is what makes the server announce a new session as a channel and stream on it while open (the
    // house's read of 59f660b, #22: the test passed without it).
    const announced = (m: Msg) => m.method === 'channels/changed' && ((m.params as { added?: Array<{ id: string }> }).added ?? []).some((c) => c.id === 'terminal:bridged');
    await until(() => h.received.some(announced), 3000, 'the new session announced as a channel');
    const list = await h.request('channels/list');
    assert.ok(((list.result?.channels as Array<{ id: string }>) ?? []).some((c) => c.id.endsWith('bridged')), `channels are registered: ${JSON.stringify(list)}`);
    const opened = await h.request('channels/open', { channelId: 'terminal:bridged' });
    assert.equal(opened.error, undefined, JSON.stringify(opened.error));
    const sent = await h.request('channels/publish', { channelId: 'terminal:bridged', content: [{ type: 'text', text: 'from the bridge' }] });
    assert.equal(sent.result?.delivered, true, JSON.stringify(sent));
    // A Run that outlives its wait: its end comes as a message on the open channel (what a result carried is never sent again, G28).
    const ran = await h.request('tools/call', { name: 'run', arguments: { session: 'bridged', command: 'sleep 1', wait: 50 } });
    assert.equal((ran.result?.structuredContent as { state?: string } | undefined)?.state, 'running', JSON.stringify(ran.result));
    d.shell().finishHung(0, 'done\r\n');
    const streamed = (m: Msg) => m.method === 'channels/incoming' && ((m.params as { messages?: Array<{ channelId: string }> }).messages ?? []).some((x) => x.channelId === 'terminal:bridged');
    await until(() => h.received.some(streamed), 5000, 'the Run on the open channel');
    h.close();
    // Watch firings wake the session once the watch tier is added: the wake list already names them.
    assert.ok(entry.wake.wake.flat().includes('terminal:watch'));
  } finally {
    await d.close();
  }
});

type Ontology = { tags: Record<string, unknown>; suggestedTreatment: Array<{ tagsAny: string[]; behavior: string }> };

test('the bridge entry and the gate wake on what the README promises and the server marks immediate, every service change among them, and hold or debounce the ambient tags', async () => {
  // The server's own word on its tags, as a host receives it.
  const d = await scriptedDaemon();
  let ontology: Ontology;
  try {
    const h = await host(d.port);
    const init = await h.request('initialize', MCPL_INIT);
    const sets = (init.result!.capabilities as { experimental: { mcpl: { featureSets: Record<string, { tagOntology?: Ontology }> } } }).experimental.mcpl.featureSets;
    ontology = sets['terminal.live']!.tagOntology!;
    h.close();
  } finally {
    await d.close();
  }
  const treated = (behavior: string) => ontology.suggestedTreatment.filter((t) => t.behavior === behavior).flatMap((t) => t.tagsAny);
  // What the README promises wakes a bridged session: completions, lost Runs, needs-input, session exits, watch firings and service changes.
  const promised = treated('immediate').filter((t) => /^terminal:(run-finished|run-lost|needs-input|session-exited|watch|service-)/.test(t));
  assert.ok(promised.includes('terminal:service-lost') && promised.includes('terminal:service-running'), 'the server marks every service change immediate');
  const ambient = treated('throttle');
  const { wake } = bridgeEntry();
  const wakes = wake.wake.flat();
  const holds = wake.hold.flat();
  assert.deepEqual(promised.filter((t) => !wakes.includes(t)), [], 'the bridge wakes on every promised tag (the house\'s read of 59f660b, #22: two service tags were missing)');
  assert.deepEqual(ambient.filter((t) => !holds.includes(t)), [], 'and holds every ambient one');
  assert.deepEqual([...wakes, ...holds].filter((t) => !(t in ontology.tags)), [], 'no entry names a tag the server never sends');
  // The gate: first match wins, and a trailing * matches a family.
  const gate = (JSON.parse(fs.readFileSync(path.join(CONFIG, 'agent-framework.gate.json'), 'utf8')) as { policies: Array<{ name: string; match: { source: string; tagsAny: string[] }; behavior: unknown }> }).policies;
  const matches = (tag: string, patterns: string[]) => patterns.some((p) => (p.endsWith('*') ? tag.startsWith(p.slice(0, -1)) : p === tag));
  const policyFor = (tag: string) => gate.find((p) => p.match.source === 'terminal' && matches(tag, p.match.tagsAny));
  for (const t of promised) assert.equal(policyFor(t)?.behavior, 'always', `${t} wakes a connectome agent`);
  // Notes travel only on channels, which the recipe does not enable; the other ambient tags are debounced, never wakes.
  for (const t of ambient.filter((t) => t !== 'terminal:note')) assert.deepEqual(policyFor(t)?.behavior, { debounce: 30000 }, `${t} is debounced`);
});

test('the package ships what the units run: the launcher, both units, the configs and every built bin are in `npm pack`', () => {
  // `npm pack --dry-run` is the package as npm would publish it (the house's read of 59f660b, #22: `.npmignore`'s *.sh took the launcher out).
  const npm = process.env.npm_execpath;
  const out = npm
    ? execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const shipped = new Set((JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path));
  for (const f of fs.readdirSync(CONFIG)) assert.ok(shipped.has(`next/config/${f}`), `next/config/${f} ships`);
  // What the units point at inside the package is in it.
  const unit = fs.readFileSync(path.join(CONFIG, 'termd.service'), 'utf8');
  const execStart = /^ExecStart=\/bin\/sh PACKAGE\/(\S+)/m.exec(unit);
  assert.ok(execStart && shipped.has(execStart[1]!), `the unit's ExecStart target ships: ${execStart?.[1]}`);
  const plist = fs.readFileSync(path.join(CONFIG, 'com.animalabs.termd.plist'), 'utf8');
  const program = /<string>PACKAGE\/([^<]+)<\/string>/.exec(plist);
  assert.ok(program && shipped.has(program[1]!), `the plist's program ships: ${program?.[1]}`);
  // 1.x's and 2.0's bins alike, as far as this tree has built them.
  const { bin } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  for (const [name, file] of Object.entries(bin)) if (fs.existsSync(path.join(ROOT, file))) assert.ok(shipped.has(file.replace(/^\.\//, '')), `${name} (${file}) ships`);
});

test("a daemon command written for 1.x starts termd: --headless is accepted, SESSION_SERVER_PORT and _HOST are read, and `localhost` binds 127.0.0.1", async () => {
  const dataDir = path.join(tmp, 'from-1x');
  // A port of this test's choosing, so the announcement shows the 1.x name was read (0 would match any port).
  const port = await unusedPort();
  const env: NodeJS.ProcessEnv = { ...process.env, SESSION_SERVER_PORT: String(port), SESSION_SERVER_HOST: 'localhost', SESSION_SERVER_TOKEN: 'old-token' };
  for (const k of ['TSM_PORT', 'TSM_HOST', 'TSM_TOKEN']) delete env[k];
  const child = spawn(process.execPath, [path.resolve(here, '../src/daemon.js'), '--headless', '--data-dir', dataDir, '--no-usage-log', '--shell', '/bin/bash'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    const end = Date.now() + 15_000;
    while (!stderr.includes('"listening"') && Date.now() < end && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
    assert.ok(stderr.includes('"listening"'), `termd did not start: ${stderr}`);
    const lines = stderr.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { msg: string; url?: string; auth?: string });
    assert.ok(lines.some((l) => /--headless is a 1\.x flag/.test(l.msg)), stderr);
    assert.ok(lines.some((l) => /using SESSION_SERVER_PORT \(a 1\.x setting\)/.test(l.msg)), stderr);
    assert.ok(lines.some((l) => /using SESSION_SERVER_HOST \(a 1\.x setting\)/.test(l.msg)), stderr);
    assert.ok(lines.some((l) => /using SESSION_SERVER_TOKEN \(a 1\.x setting\)/.test(l.msg)), stderr);
    assert.ok(lines.some((l) => /localhost binds 127\.0\.0\.1/.test(l.msg)), stderr);
    const listening = lines.find((l) => l.msg === 'listening')!;
    assert.equal(listening.url, `ws://127.0.0.1:${port}`, 'bound to the IPv4 loopback, on the port the 1.x name gave');
    assert.equal(listening.auth, 'token', 'the 1.x token name counted as the shared token');
  } finally {
    // A child that never started has exited already: waiting for its exit would wait forever.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test("termd tells its data dir on /health to a caller with a principal and a loopback peer address, and the shim asks a running termd for it on the port its title names (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question 1)", async () => {
  /** A termd of its own; its port, from the listening record. */
  const start = async (name: string, extra: string[]) => {
    const dataDir = path.join(tmp, name);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['TSM_PORT', 'TSM_HOST', 'TSM_TOKEN', 'TSM_DATA_DIR', 'SESSION_SERVER_PORT', 'SESSION_SERVER_HOST', 'SESSION_SERVER_TOKEN']) delete env[k];
    const child = spawn(process.execPath, [path.resolve(here, '../src/daemon.js'), '--port', '0', '--data-dir', dataDir, '--no-usage-log', '--shell', '/bin/bash', ...extra], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
    await until(() => stderr.includes('"listening"') || child.exitCode !== null, 15_000, 'termd to listen');
    const listening = stderr.split('\n').find((l) => l.includes('"listening"'));
    assert.ok(listening, `termd did not start: ${stderr}`);
    const port = Number(new URL((JSON.parse(listening) as { url: string }).url).port);
    const health = async (token?: string) => (await (await fetch(`http://127.0.0.1:${port}/health`, token ? { headers: { authorization: `Bearer ${token}` } } : {})).json()) as Record<string, unknown>;
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    return { child, dataDir, port, health, stop };
  };
  const open = await start('health-open', []);
  try {
    // Loopback-open, as a supervisor's termd runs: this caller is the anonymous principal, which may see sessions.
    assert.equal((await open.health()).dataDir, open.dataDir);
    // The shim takes an answer only from a socket shown to be the termd's, which Linux's /proc shows.
    const linux = process.platform === 'linux';
    assert.deepEqual(await askDataDir(open.port, open.child.pid!, { timeoutMs: 3000 }), linux ? { dataDir: open.dataDir } : { error: 'this system does not show whose a socket is' });
    if (linux) assert.equal(titlePort(open.child.pid!), open.port, "the port in termd's own title");
  } finally {
    await open.stop();
  }
  const closed = await start('health-token', ['--token', 'health-secret']);
  try {
    const anonymous = await closed.health();
    assert.equal(anonymous.dataDir, undefined, 'a caller without a credential is told only that it is alive');
    assert.equal((await closed.health('health-secret')).dataDir, closed.dataDir);
    // A termd that requires a credential tells the shim, which sends its own once the socket is shown to be the termd's
    // (a reviewer's read of the fixes for #22: asked without one, it was never told).
    if (process.platform === 'linux') {
      assert.match(JSON.stringify(await askDataDir(closed.port, closed.child.pid!, { timeoutMs: 3000 })), /its \/health names no data dir: no credential was presented/);
      assert.deepEqual(await askDataDir(closed.port, closed.child.pid!, { timeoutMs: 3000, token: 'health-secret' }), { dataDir: closed.dataDir });
    }
  } finally {
    await closed.stop();
  }
});


test("/health's data dir goes to a caller with a principal only from a loopback peer address: the same credential dialling from another address of this host is told the rest, and a ::ffff:127.0.0.1 peer is loopback (the house's read of the 17 commits over our fixes, #22)", async (t) => {
  const registry = new SessionRegistry({ dataDir: fs.mkdtempSync(path.join(tmp, 'hg-')), backend: fakeShellBackend(() => {}), defaultShell: '/bin/bash', noUserRc: true });
  /** A server bound to `host` that tells /health its data dir, the credential `tk` its principal. */
  const serve = async (host: string) => {
    const server = new TermServer({ app: new App({ registry }), resolver: new TokenMapResolver({ tokens: { tk: 'agent:health@test' } }), host, port: 0, dataDir: '/srv/told' });
    return { server, port: (await server.listen()).port };
  };
  /** /health with the credential, dialled on 127.0.0.1 from `from` (a local address), else from loopback. */
  const health = (port: number, from?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, localAddress: from, path: '/health', headers: { authorization: 'Bearer tk' } }, (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () => {
            try {
              resolve(JSON.parse(text) as Record<string, unknown>);
            } catch {
              reject(new Error(`/health answered ${res.statusCode}: ${text.slice(0, 200)}`));
            }
          });
        })
        .on('error', reject);
    });
  try {
    await t.test('a peer address of this host that is not loopback', async (t) => {
      // Bound to loopback, as termd ships, and dialled on it from another of this host's addresses: the peer the
      // server sees is that address, and nothing listens beyond loopback.
      const lan = Object.values(os.networkInterfaces()).flat().find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address;
      if (!lan) return t.skip('this host has no non-loopback IPv4 address to dial from');
      // What a listener on 127.0.0.1 sees as the peer of a connection from that address: a system that shows it as
      // loopback can't put this case (the house's read of the 17 commits over our fixes, #22).
      const seen = await new Promise<string | undefined>((resolve) => {
        const probe = net.createServer((c) => {
          resolve(c.remoteAddress);
          c.destroy();
        });
        probe.listen(0, '127.0.0.1', () => {
          const c = net.connect({ host: '127.0.0.1', port: (probe.address() as { port: number }).port, localAddress: lan });
          c.once('error', () => resolve(undefined));
          c.once('close', () => probe.close());
          c.resume();
        });
      });
      if (seen === undefined || seen === '127.0.0.1' || seen === '::ffff:127.0.0.1') return t.skip(`a connection from ${lan} to 127.0.0.1 shows its peer as ${seen ?? 'nothing (it failed)'} here`);
      const { server, port } = await serve('127.0.0.1');
      try {
        assert.equal((await health(port)).dataDir, '/srv/told', 'the credential from 127.0.0.1 is told the data dir');
        const remote = await health(port, lan);
        assert.ok(Array.isArray(remote.sessions), `the same credential from ${lan} is a viewer`);
        assert.equal(remote.dataDir, undefined, `from ${lan} it is not told the data dir`);
      } finally {
        await server.close();
      }
    });
    await t.test('an IPv6 socket\'s ::ffff:127.0.0.1 peer', async (t) => {
      // An IPv6 socket bound to the IPv4 loopback's mapped address: its peers show as ::ffff:127.0.0.1.
      let bound: Awaited<ReturnType<typeof serve>>;
      try {
        bound = await serve('::ffff:127.0.0.1');
      } catch (e) {
        return t.skip(`no IPv6 socket on ::ffff:127.0.0.1 here: ${(e as Error).message}`);
      }
      try {
        assert.equal((await health(bound.port)).dataDir, '/srv/told', 'a ::ffff:127.0.0.1 peer is loopback');
      } finally {
        await bound.server.close();
      }
    });
  } finally {
    await registry.closeAll();
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
  // KillMode=process: systemd signals termd alone, so termd can hang up its shells as a closing
  // terminal does and the jobs they detached on purpose survive, as the daemon header promises;
  // KillMode=mixed would SIGKILL the whole cgroup and take those with it (the house's read, #22).
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^WorkingDirectory=%h$/m);
  assert.match(unit, /termd-launch\.sh/);
  // Both supervisors raise the open-file limit to the same 65536 the launcher aims for (a session costs about five).
  const nofile = /^LimitNOFILE=(\d+)$/m.exec(unit);
  assert.equal(Number(nofile?.[1]), 65536, 'the unit');
  const limit = (kind: 'Soft' | 'Hard') => Number(new RegExp(`<key>${kind}ResourceLimits</key>\\s*<dict>\\s*<key>NumberOfFiles</key>\\s*<integer>(\\d+)</integer>`).exec(plist)?.[1]);
  assert.deepEqual([limit('Soft'), limit('Hard')], [65536, 65536], 'the plist');
  if (process.platform !== 'darwin') return t.skip('plutil is macOS only');
  execFileSync('plutil', ['-lint', path.join(CONFIG, 'com.animalabs.termd.plist')]);
});

test("the launcher finds nvm's default node without the optional `current` link: the alias chain is followed, versions compare as numbers, and an alias nothing answers to falls back to the newest installed", async () => {
  // Each case: the installed versions (good = this node; bad = exits 97 naming itself), nvm's alias files, the version the launcher must pick.
  const cases: Array<[string, Record<string, 'good' | 'bad'>, Record<string, string>, string]> = [
    ['nvm-lts', { 'v9.9.9': 'bad', 'v22.11.0': 'good', 'v24.1.0': 'bad' }, { default: 'lts/*', 'lts/*': 'lts/jod\n', 'lts/jod': 'v22.11.0\n' }, 'v22.11.0'],
    ['nvm-major', { 'v9.9.9': 'bad', 'v24.9.0': 'bad', 'v24.22.0': 'good' }, { default: '24\n' }, 'v24.22.0'],
    ['nvm-newest', { 'v9.9.9': 'bad', 'v10.0.0': 'good' }, {}, 'v10.0.0'],
    ['nvm-gone', { 'v9.9.9': 'bad', 'v20.0.0': 'good' }, { default: 'v18.0.0\n' }, 'v20.0.0'],
  ];
  for (const [name, versions, aliases, expected] of cases) {
    const home = nvmHome(name, versions, aliases);
    const r = await launch(LAUNCHER, ['--port', '0'], { HOME: home });
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.equal(r.started?.env.PATH?.split(':')[0], path.join(home, '.nvm', 'versions', 'node', expected, 'bin'), `${name}: the chosen version leads PATH, for process Runs too`);
  }
  // nvm's `current` link, where the user asked for it, wins over the alias.
  const home = nvmHome('nvm-current', { 'v9.9.9': 'bad', 'v24.22.0': 'good' }, { default: 'v9.9.9\n' });
  fs.symlinkSync(path.join(home, '.nvm', 'versions', 'node', 'v24.22.0'), path.join(home, '.nvm', 'current'));
  const r = await launch(LAUNCHER, ['--port', '0'], { HOME: home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.started?.env.PATH?.split(':')[0], path.join(home, '.nvm', 'current', 'bin'));
});

test("TSM_NODE is termd's MCPL node name, not the launcher's: it passes through untouched; TSM_NODE_BIN names the node to run, and neither launcher setting reaches termd", async () => {
  const home = voltaHome('identity');
  const identity = await launch(LAUNCHER, ['--port', '0'], { HOME: home, TSM_NODE: 'build-box' });
  assert.equal(identity.code, 0, `the launcher ran the identity as a program: ${identity.stderr}`);
  assert.equal(identity.started?.env.TSM_NODE, 'build-box', 'the node name reaches termd as given');
  // TSM_NODE_BIN is the launcher's: a wrapper that marks what it ran shows it was the one used.
  const wrapper = path.join(tmp, 'node-wrapper.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport RAN_THROUGH=wrapper\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  const named = await launch(LAUNCHER, ['--port', '0'], { HOME: home, TSM_NODE_BIN: wrapper });
  assert.equal(named.code, 0, named.stderr);
  assert.equal(named.started?.env.RAN_THROUGH, 'wrapper', 'the named node ran, not the one on PATH');
  assert.equal(named.started?.env.TSM_NODE_BIN, undefined, "the launcher's own settings stop at the launcher");
  assert.equal(named.started?.env.TSM_DAEMON, undefined);
  // Without any node to find, the way out named is the launcher's own variable.
  const bare = path.join(tmp, 'bare-home');
  fs.mkdirSync(bare, { recursive: true });
  const systemNode = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'].some((d) => fs.existsSync(path.join(d, 'node')));
  const none = await launch(LAUNCHER, ['--port', '0'], { HOME: bare });
  if (!systemNode) {
    assert.equal(none.code, 127, none.stderr);
    assert.match(none.stderr, /no node on PATH .*; set TSM_NODE_BIN=\/path\/to\/node/);
  }
  assert.doesNotMatch(none.stderr, /TSM_NODE=/, 'the advice never names the identity variable');
});

test('the launcher works by a relative path: its own directory is resolved before it changes to $HOME', async () => {
  const home = voltaHome('relative');
  const r = await launch('config/termd-launch.sh', ['--port', '0'], { HOME: home }, { cwd: path.join(ROOT, 'next') });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.started?.cwd, home, 'termd starts in $HOME');
  // And the daemon beside it is found the same way (--help: termd prints its usage and exits without starting).
  const real = await launch('config/termd-launch.sh', ['--help'], { HOME: home, TSM_DAEMON: undefined }, { cwd: path.join(ROOT, 'next') });
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /--port/, "termd's usage");
});

test('the launcher raises the open-file limit to what the hard limit allows and says so when that is under 65536; nothing is said when 65536 is reached', async () => {
  const home = voltaHome('limits');
  const capped = await launch(LAUNCHER, ['--port', '0'], { HOME: home }, { through: 'ulimit -Sn 300 && ulimit -Hn 600 && exec /bin/sh "$0" "$@"' });
  assert.equal(capped.code, 0, capped.stderr);
  assert.equal(capped.started?.nofile, '600', 'raised to the hard limit');
  assert.match(capped.stderr, /termd-launch: the open-file limit is 600 \(the hard limit is 600\).*fail near 120/);
  const low = await launch(LAUNCHER, ['--port', '0'], { HOME: home }, { through: 'ulimit -Sn 256 && exec /bin/sh "$0" "$@"' });
  assert.equal(low.code, 0, low.stderr);
  if (Number(low.started?.nofile) >= 65536) assert.doesNotMatch(low.stderr, /open-file limit/, 'a limit that reaches 65536 is not worth a line');
  else assert.match(low.stderr, /the open-file limit is \d+ \(the hard limit is \d+\)/, "this machine's hard limit is under 65536: the launcher says so");
});
