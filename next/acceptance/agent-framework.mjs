#!/usr/bin/env node
// Acceptance against a real MCPL host: agent-framework's host code (a built checkout, AGENT_FRAMEWORK)
// with a mock model and no LLM, launching tsm-relay over stdio as a recipe does.
//
//   AGENT_FRAMEWORK=/path/to/agent-framework node next/acceptance/agent-framework.mjs   (after npm run build:next)
//
// It checks the central promise: a persistent shell reached through the host's tools, a command that
// outlives its call reported as a wake the host takes, once, with no inference loop; and, when the
// daemon goes away, the host's own reconnect reaching a new daemon that runs nothing behind the
// agent's back.
//
// ACCEPTANCE_GATE=shipped runs it under a gate whose default is defer, with next/config/
// agent-framework.gate.json's rules merged in, as a resident whose gate defers unnamed events has
// it; ACCEPTANCE_GATE=defer-only runs the same gate without those rules, where the end must enter
// the context and wake no one, which shows the gate is in force.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const AF = process.env.AGENT_FRAMEWORK;
if (!AF || !fs.existsSync(path.join(AF, 'dist/src/index.js'))) {
  console.log(`${process.env.ACCEPTANCE_REQUIRED === '1' ? 'FAIL' : 'skip'}: agent-framework dist not found at ${AF ?? '(AGENT_FRAMEWORK unset)'}`);
  process.exit(process.env.ACCEPTANCE_REQUIRED === '1' ? 1 : 0);
}
const { AgentFramework } = await import(path.join(AF, 'dist/src/index.js'));
const { MockMembrane, createMockResponse } = await import(path.join(AF, 'dist/test/helpers/mock-membrane.js'));
const DIST = path.resolve(import.meta.dirname, '../dist/src');

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-accept-af-'));
const socket = path.join(tmp, 'run', 'daemon.sock');
const stopDaemon = () => {
  try {
    execFileSync(process.execPath, [path.join(DIST, 'cli/tsm.js'), '--socket', socket, 'daemon', 'stop'], { stdio: 'pipe', timeout: 20_000 });
  } catch {}
};
// A check that hangs ends here with a verdict, not at the CI job's limit.
const deadline = setTimeout(() => {
  log('FAIL: the check did not finish within 180 s');
  stopDaemon();
  process.exit(1);
}, 180_000);

const CONFIG = path.resolve(import.meta.dirname, '../config');
const shippedServer = JSON.parse(fs.readFileSync(path.join(CONFIG, 'agent-framework.recipe.json'), 'utf8')).mcplServers[0];
const GATE = process.env.ACCEPTANCE_GATE;
let gateOption = {};
if (GATE) {
  const shipped = JSON.parse(fs.readFileSync(path.join(CONFIG, 'agent-framework.gate.json'), 'utf8'));
  const configPath = path.join(tmp, 'gate.json');
  fs.writeFileSync(configPath, JSON.stringify({ default: 'defer', policies: GATE === 'shipped' ? shipped.policies : [] }));
  gateOption = { gate: { configPath } };
}
const wakes = GATE !== 'defer-only';
log(`gate: ${GATE ?? 'none'}`);

const membrane = new MockMembrane();
const framework = await AgentFramework.create({
  storePath: path.join(tmp, 'af.chronicle'),
  membrane: membrane.asMembrane(),
  agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'test' }],
  modules: [],
  ...gateOption,
  mcplServers: [
    {
      ...shippedServer,
      command: process.execPath,
      args: [path.join(DIST, 'relay.js'), '--socket', socket, ...shippedServer.args.map((a) => (a === 'AGENT' ? 'scout' : a))],
      reconnectIntervalMs: 300,
    },
  ],
});
framework.start();
const conn = framework.mcplServerRegistry.getServer('terminal');
const call = async (name, args) => {
  const r = await conn.sendToolsCall(name, args);
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
};
const messages = () => framework.agents.get('scout').getContextManager().getAllMessages();
const text = (m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
const ready = async (what) => {
  for (const until = now() + 30_000; !(conn.isConnected && conn.policyEstablished); await sleep(50)) if (now() > until) throw new Error(`timed out: ${what}`);
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    log('PASS', name);
  } catch (e) {
    failures++;
    log('FAIL', name, '\n  ', e.message);
  }
};

try {
  await check('the host reaches the daemon through the relay, with a grant and the tools', async () => {
    await ready('the first connection and grant');
    const tools = framework.getAllTools().map((t) => t.name).filter((n) => n.startsWith('terminal'));
    for (const t of ['open', 'run', 'send', 'look', 'read', 'stop', 'integrate', 'list', 'close']) assert.ok(tools.some((n) => n.endsWith(t)), `${t} in ${tools.join(', ')}`);
  });

  const released = path.join(tmp, 'released');
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
  await check(wakes ? 'a command that outlives its call wakes the agent once, with its output, and no inference loop' : 'under a gate that defers what no rule names, the end enters the context and wakes no one', async () => {
    const opened = await call('open', { name: 'main', cwd: tmp });
    assert.equal(opened.isError, false, opened.text);
    const r = await call('run', { name: 'main', command: `until [ -e ${released} ]; do sleep 0.1; done; echo acceptance-out""put`, wait: 0 });
    assert.match(r.text, /still running/, r.text);
    fs.writeFileSync(released, '');
    const woke = () => messages().filter((m) => text(m).includes('acceptance-output'));
    for (const until = now() + 15_000; !woke().length && now() < until; ) await sleep(100);
    assert.equal(woke().length, 1, `the end's messages in the agent's context: ${woke().length}`);
    assert.match(text(woke()[0]), /\[main · command \d+ · exit 0 · /);
    if (!wakes) {
      await framework.runUntilIdle();
      await sleep(2000);
      assert.equal(membrane.calls.length, 0, `inference calls under defer: ${membrane.calls.length}`);
      return;
    }
    for (const until = now() + 15_000; !membrane.calls.length && now() < until; ) await sleep(50);
    assert.ok(membrane.calls.length >= 1, 'an inference call followed the wake');
    assert.ok(JSON.stringify(membrane.calls[0].messages).includes('acceptance-output'), 'the inference call carries the end');
    await framework.runUntilIdle();
    await sleep(1000);
    assert.equal(membrane.calls.length, 1, `inference calls: ${membrane.calls.length}`);
    const listed = await call('list', {});
    assert.doesNotMatch(listed.text, /not yet seen/, `the host accepted the push, so the end is seen:\n${listed.text}`);
  });

  await check('when the daemon goes away the host reconnects to a new one, which runs nothing behind the agent\'s back', async () => {
    const closed = new Promise((r) => conn.once('close', r));
    stopDaemon();
    await Promise.race([closed, sleep(10_000).then(() => { throw new Error('timed out: the relay closing'); })]);
    for (const until = now() + 30_000; ; await sleep(100)) {
      if (conn.isConnected && conn.policyEstablished) {
        const r = await call('list', {}).catch(() => undefined);
        if (r) break;
      }
      if (now() > until) throw new Error('timed out: the host reconnecting through a new relay');
    }
    const again = await call('run', { name: 'main', command: `touch ${path.join(tmp, 'SHOULD_NOT_EXIST')}` });
    assert.equal(again.isError, true, again.text);
    assert.match(again.text, /^No session named "main" is open in scope "scout", and none is opened for you\./);
    assert.ok(!fs.existsSync(path.join(tmp, 'SHOULD_NOT_EXIST')), 'nothing ran');
  });
} finally {
  clearTimeout(deadline);
  await framework.stop?.().catch?.(() => {});
  stopDaemon();
  fs.rmSync(tmp, { recursive: true, force: true });
}
log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
