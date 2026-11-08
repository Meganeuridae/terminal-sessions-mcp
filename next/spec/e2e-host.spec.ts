import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { configuredEnv } from '../src/core/env.js';
import { runDaemon, type RunningDaemon } from '../src/endpoint/daemon-main.js';
import { relay } from '../src/relay.js';
import { Host } from '../src/tools/host.js';
import { openSession } from '../src/session/session.js';

interface Line {
  [k: string]: unknown;
}

function host(socket: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const got: Line[] = [];
  const waiters: Array<{ pred: (m: Line) => boolean; resolve: (m: Line) => void }> = [];
  let buf = '';
  let err = '';
  stderr.on('data', (b) => (err += b));
  stdout.on('data', (b) => {
    buf += b;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)) as Line;
      buf = buf.slice(nl + 1);
      const w = waiters.find((x) => x.pred(m));
      if (w) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      } else got.push(m);
    }
  });
  const exited = relay({ socket, hello: { version: '2.0.0', scope: 'agent', client: 'relay' }, stdin, stdout, stderr, startDaemon: () => assert.fail('the test starts the daemon') });
  let id = 1;
  const next = (pred: (m: Line) => boolean, ms = 20_000): Promise<Line> =>
    new Promise((resolve, reject) => {
      const hit = got.find(pred);
      if (hit) {
        got.splice(got.indexOf(hit), 1);
        return resolve(hit);
      }
      const w = { pred, resolve: (m: Line) => (clearTimeout(t), resolve(m)) };
      const t = setTimeout(() => reject(new Error(`no such message within ${ms} ms; stderr: ${err}`)), ms);
      waiters.push(w);
    });
  const request = async (method: string, params?: unknown): Promise<Line> => {
    const n = id++;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params === undefined ? {} : { params }) })}\n`);
    return next((m) => m.id === n && !('method' in m));
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const r = (await request('tools/call', { name, arguments: args })).result as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
  };
  return { stdin, next, request, call, exited, stderr: () => err };
}

async function daemon(socket: string): Promise<RunningDaemon> {
  const d = await runDaemon({ socket, openSession, shell: '/bin/bash', env: configuredEnv(process.env, {}), version: '2.0.0', log: () => {} });
  assert.notEqual(d, 'running');
  return d as RunningDaemon;
}

test('through the relay to a real bash: a command\'s status and output, an end no call waited on pushed and accepted, and after a daemon restart no session reopened behind the agent\'s back', { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-e2e-'));
  const socket = path.join(dir, 'daemon.sock');
  let d = await daemon(socket);
  try {
    const h = host(socket);
    await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: { experimental: { mcpl: { version: '0.5', eventCoalescing: true } } } });
    await h.request('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], enabled: ['terminal.tools', 'terminal.events'] });

    const opened = await h.call('open', { name: 'main', cwd: dir });
    assert.equal(opened.isError, false, opened.text);
    assert.match(opened.text, /^\[main · at the prompt · /);

    const ran = await h.call('run', { name: 'main', command: 'cd sub 2>/dev/null || mkdir sub && cd sub; echo "hello $((6*7))"; false | true' });
    assert.match(ran.text, /^\[main · command \d+ · exit 0 · pipeline 1\|0 · [\d.]+ s · at the prompt · .*\/sub\]/, ran.text);
    assert.match(ran.text, /\nhello 42\n?/);

    const long = await h.call('run', { name: 'main', command: 'sleep 1; echo finished-later', wait: 0 });
    assert.match(long.text, /still running/);
    const push = await h.next((m) => m.method === 'push/event');
    const p = push.params as { tags: string[]; coalesce: { key: string }; payload: { content: Array<{ text: string }> } };
    assert.deepEqual(p.tags, ['terminal:ended']);
    assert.match(p.coalesce.key, /^agent\/main\/\d+$/);
    assert.match(p.payload.content[0]!.text, /finished-later/);
    h.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: push.id, result: { accepted: true } })}\n`);
    await h.request('ping');
    const listed = await h.call('list', {});
    assert.doesNotMatch(listed.text, /not yet seen/, listed.text);

    await d.stop('test: restart');
    assert.equal(await h.exited, 1);
    assert.match(h.stderr(), /This relay exits rather than reconnect/);

    d = await daemon(socket);
    const h2 = host(socket);
    await h2.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const again = await h2.call('run', { name: 'main', command: 'echo should-not-run' });
    assert.equal(again.isError, true);
    assert.match(again.text, /^No session named "main" is open in scope "agent", and none is opened for you\./);
    h2.stdin.end();
    assert.equal(await h2.exited, 0);
  } finally {
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send: an arrow key follows the cursor-key mode the program set', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-keys-'));
  const h = new Host({ openSession, shell: '/bin/bash', env: configuredEnv(process.env, {}), sessionsDir: dir, startedAt: Date.now() });
  const caller = { scope: 'k', takes: true, pushes: false };
  try {
    assert.equal((await h.call(caller, 'open', { name: 'k', cwd: dir })).isError, undefined);
    for (const [mode, expect] of [['h', "'\\EOA'"], ['l', "'\\E[A'"]] as const) {
      const ran = await h.call(caller, 'run', { name: 'k', command: `printf '\\033[?1${mode}'; echo ready-${mode}; IFS= read -rsn3 key; printf '[%q]\\n' "$key"`, wait: 0 });
      assert.equal(ran.isError, undefined, ran.text);
      const ready = await h.call(caller, 'look', { name: 'k', match: `^ready-${mode}$`, wait: 20 });
      assert.match(ready.text, new RegExp(`ready-${mode}`), ready.text);
      const sent = await h.call(caller, 'send', { name: 'k', keys: ['Up'], wait_for: '^\\[\\$', wait: 20 });
      assert.match(sent.text, new RegExp(`\\[\\$${expect.replace(/[\\[\]]/g, '\\$&')}\\]`), sent.text);
      await h.call(caller, 'look', { name: 'k', until: 'end', wait: 20 });
    }
  } finally {
    await h.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
