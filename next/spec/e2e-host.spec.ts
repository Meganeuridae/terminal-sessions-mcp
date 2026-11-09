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

const reads = (text: string): string[] => [...text.matchAll(/READ:("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string);

const READER = "process.stdin.setRawMode(true); if (process.argv[2] === 'on') process.stdout.write('\\x1b[?2004h'); console.log('ready'); process.stdin.on('data', (d) => { const s = d.toString(); console.log('READ:' + JSON.stringify(s)); if (s.endsWith('\\r')) { console.log('DONE'); process.exit(0); } });\n";

test('send: with paste, the text goes inside the bracketed-paste frame and the keys after it', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-paste-'));
  const reader = path.join(dir, 'reads.cjs');
  fs.writeFileSync(reader, READER);
  const h = new Host({ openSession, shell: '/bin/bash', env: configuredEnv(process.env, {}), sessionsDir: dir, startedAt: Date.now() });
  const caller = { scope: 'p', takes: true, pushes: false };
  try {
    assert.equal((await h.call(caller, 'open', { name: 'p', cwd: dir })).isError, undefined);
    const ran = await h.call(caller, 'run', { name: 'p', command: `'${process.execPath}' '${reader}' on`, wait: 0 });
    assert.equal(ran.isError, undefined, ran.text);
    assert.match((await h.call(caller, 'look', { name: 'p', match: '^ready$', wait: 20 })).text, /ready/);
    const text = 'x'.repeat(40);
    const sent = await h.call(caller, 'send', { name: 'p', text, keys: ['Enter'], paste: true, wait_for: '^DONE$', wait: 20 });
    assert.equal(sent.isError, undefined, sent.text);
    assert.equal(reads(sent.text).join(''), `\x1b[200~${text}\x1b[201~\r`, sent.text);
  } finally {
    await h.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send: paste is refused, with nothing typed, while the program hasn't turned bracketed paste on, or when the text holds the frame's end", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-paste-'));
  const reader = path.join(dir, 'reads.cjs');
  fs.writeFileSync(reader, READER);
  const h = new Host({ openSession, shell: '/bin/bash', env: configuredEnv(process.env, {}), sessionsDir: dir, startedAt: Date.now() });
  const caller = { scope: 'q', takes: true, pushes: false };
  try {
    assert.equal((await h.call(caller, 'open', { name: 'q', cwd: dir })).isError, undefined);
    const ran = await h.call(caller, 'run', { name: 'q', command: `'${process.execPath}' '${reader}' off`, wait: 0 });
    assert.equal(ran.isError, undefined, ran.text);
    assert.match((await h.call(caller, 'look', { name: 'q', match: '^ready$', wait: 20 })).text, /ready/);
    const off = await h.call(caller, 'send', { name: 'q', text: 'abc', keys: ['Enter'], paste: true, wait: 2 });
    assert.equal(off.isError, true, off.text);
    assert.match(off.text, /Nothing was typed: the program in front hasn't turned bracketed paste on\. `send` without `paste` types the text\./);
    const marker = await h.call(caller, 'send', { name: 'q', text: 'a\x1b[201~b', paste: true, wait: 2 });
    assert.equal(marker.isError, true, marker.text);
    assert.match(marker.text, /Nothing was typed: `text` holds the bracketed-paste end marker/);
    const keysOnly = await h.call(caller, 'send', { name: 'q', keys: ['Enter'], paste: true, wait: 2 });
    assert.equal(keysOnly.isError, true, keysOnly.text);
    assert.match(keysOnly.text, /Nothing was typed: `paste` sends `text` as a paste, so it needs `text`\./);
    const typed = await h.call(caller, 'send', { name: 'q', text: 'z', keys: ['Enter'], wait_for: '^DONE$', wait: 20 });
    assert.deepEqual(reads(typed.text), ['z\r'], typed.text);
    const all = await h.call(caller, 'read', { name: 'q', match: 'READ:' });
    assert.deepEqual(reads(all.text), ['z\r'], all.text);
  } finally {
    await h.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function gatedBash(rc: { extra: string; before: string; after: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-gated-'));
  const home = path.join(dir, 'home');
  const gate = path.join(dir, 'gate');
  fs.mkdirSync(home);
  const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    path.join(home, '.bash_profile'),
    `${rc.extra}__hk() { if [ -e ${q(gate)} ]; then printf '${rc.before}\\nHOOK_WAIT\\n'; while [ -e ${q(gate)} ]; do sleep 0.01; done; printf '${rc.after}'; fi; }\nPROMPT_COMMAND=__hk\n`,
  );
  let armed = false;
  const h = new Host({
    openSession: async (o) => {
      const s = await openSession(o);
      const send = s.send.bind(s);
      s.send = (text, opts) => {
        if (armed) fs.rmSync(gate, { force: true });
        return send(text, opts);
      };
      return s;
    },
    shell: '/bin/bash',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
    sessionsDir: dir,
    startedAt: Date.now(),
  });
  const caller = { scope: 'g', takes: true, pushes: false };
  return {
    call: (tool: string, args: Record<string, unknown>) => h.call(caller, tool, { name: 'g', ...args }),
    hold: async () => {
      assert.equal((await h.call(caller, 'open', { name: 'g', cwd: home })).isError, undefined);
      fs.writeFileSync(gate, '');
      const held = await h.call(caller, 'send', { name: 'g', text: 'true\r', wait_for: '^HOOK_WAIT$', wait: 20 });
      assert.match(held.text, /HOOK_WAIT/, held.text);
      armed = true;
    },
    done: async () => {
      fs.rmSync(gate, { force: true });
      await h.closeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('send: paste reads the mode when it writes, after its wait for a prompt, and a mode turned off during that wait refuses it', { timeout: 60_000 }, async () => {
  const g = gatedBash({ extra: "bind 'set enable-bracketed-paste off'\n", before: '\\033[?2004h', after: '\\033[?2004l' });
  try {
    await g.hold();
    const sent = await g.call('send', { text: 'echo PASTE_PROBE', keys: ['Enter'], paste: true, wait: 20 });
    assert.equal(sent.isError, true, sent.text);
    assert.match(sent.text, /Nothing was typed: the program in front hasn't turned bracketed paste on\./);
    const after = await g.call('run', { command: 'echo next', wait: 20 });
    assert.match(after.text, /^next$/m, after.text);
    assert.doesNotMatch(after.text, /PASTE_PROBE/, after.text);
  } finally {
    await g.done();
  }
});

test('send: keys are encoded by the cursor-key mode as it stands at the write, after the wait for a prompt', { timeout: 60_000 }, async () => {
  const g = gatedBash({ extra: `bind '"\\eOA": "echo APP_UP\\n"'\nbind '"\\e[A": "echo NORMAL_UP\\n"'\n`, before: '', after: '\\033[?1h' });
  try {
    await g.hold();
    const sent = await g.call('send', { keys: ['Up'], wait_for: '^(APP|NORMAL)_UP$', wait: 20 });
    assert.match(sent.text, /^APP_UP$/m, sent.text);
  } finally {
    await g.done();
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
