import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import { parseCli, runCli, type CliOptions } from '../src/endpoint/cli-main.js';
import { runDaemon, type RunningDaemon } from '../src/endpoint/daemon-main.js';
import { helloLine } from '../src/endpoint/hello.js';
import type { OpenOptions } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

test('H9: the CLI maps its words to the eight tools\' arguments', () => {
  assert.deepEqual(parseCli(['--scope', 'agent-a', 'run', 'main', 'make', '-j8', 'test', '--wait', '30']), { scope: 'agent-a', call: { tool: 'run', args: { name: 'main', command: 'make -j8 test', wait: 30 } } });
  assert.deepEqual(parseCli(['send', 'main', '--text', 'y', '--keys', 'Enter']), { scope: 'default', call: { tool: 'send', args: { name: 'main', text: 'y', keys: ['Enter'] } } });
  assert.deepEqual(parseCli(['read', 'main', '--lines', '10:20']), { scope: 'default', call: { tool: 'read', args: { name: 'main', lines: [10, 20] } } });
  assert.deepEqual(parseCli(['close', 'main', '--force']), { scope: 'default', call: { tool: 'close', args: { name: 'main', force: true } } });
  assert.deepEqual(parseCli(['list']), { scope: 'default', call: { tool: 'list', args: {} } });
  assert.deepEqual(parseCli(['daemon', 'stop']), { scope: 'default', call: { daemonStop: true } });
  assert.deepEqual(parseCli(['run', 'main', '--wait', '5', '--', 'grep', '--color', 'x']), { scope: 'default', call: { tool: 'run', args: { name: 'main', wait: 5, command: 'grep --color x' } } });
  assert.deepEqual(parseCli(['run', 'main']), { error: 'run needs a command' });
  assert.deepEqual(parseCli(['look', 'main', '--bogus', 'x']), { error: 'look takes no --bogus' });
});

test('H9: the CLI calls the daemon in its scope, prints the text, and takes nothing an agent hasn\'t seen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const socket = path.join(dir, 'daemon.sock');
  const sessions: FakeSession[] = [];
  const d = (await runDaemon({
    socket,
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      sessions.push(s);
      return s;
    },
    shell: '/bin/bash', env: {}, version: '2.0.0', log: () => {}, confirmMs: 50,
  })) as RunningDaemon;
  const cli = async (...argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    const p = parseCli(argv) as CliOptions;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (b) => (out += b));
    stderr.on('data', (b) => (err += b));
    const code = await runCli({ ...p, socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout, stderr });
    return { code, out, err };
  };
  try {
    const opened = await cli('--scope', 'a', 'open', 'main', '--cwd', '/srv');
    assert.equal(opened.code, 0);
    assert.match(opened.out, /^\[main · at the prompt · \/srv\]/);
    const s = sessions[0]!;
    s.runMode = 'run';
    await cli('--scope', 'a', 'run', 'main', 'sleep', '5', '--wait', '0');
    s.end(0);
    assert.match((await cli('--scope', 'a', 'list')).out, /1 report not yet seen/);
    assert.match((await cli('--scope', 'a', 'list')).out, /1 report not yet seen/, "the CLI's list left it unseen");
    const missing = await cli('--scope', 'b', 'look', 'main');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No session named "main" is open in scope "b"/);
  } finally {
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('several words after the name are each quoted for the shell, one stays a command line, and an empty number is refused', () => {
  assert.deepEqual(parseCli(['run', 'demo', '--', 'printf', '%s\\n', 'hello world']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "printf '%s\\n' 'hello world'" } } });
  assert.deepEqual(parseCli(['run', 'demo', 'echo', '; rm -rf target']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "echo '; rm -rf target'" } } });
  assert.deepEqual(parseCli(['run', 'demo', "it's"]), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "it's" } } });
  assert.deepEqual(parseCli(['run', 'demo', 'make test | tee log']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: 'make test | tee log' } } });
  assert.deepEqual(parseCli(['read', 'demo', '--lines', ':10']), { error: '--lines takes a number, not ""' });
  assert.deepEqual(parseCli(['run', 'demo', 'x', '--wait', '']), { error: '--wait takes a number, not ""' });
});

async function standIn(dir: string, hello: object, reply: (id: unknown) => Buffer[]) {
  const socket = path.join(dir, 'daemon.sock');
  const server = net.createServer((c) => {
    c.on('error', () => {});
    c.write(helloLine(hello as never));
    let buf = '';
    c.on('data', (b) => {
      buf += b;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as { id?: unknown; method?: string };
        buf = buf.slice(nl + 1);
        if (m.method === 'initialize') c.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })}\n`);
        else if (m.method === 'tools/call') {
          // Two writes in a row can reach the reader as one chunk.
          const pieces = reply(m.id);
          const next = (): void => {
            const piece = pieces.shift();
            if (piece) c.write(piece, () => setTimeout(next, 50));
          };
          next();
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  return { socket, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('the CLI decodes a character split across chunks, reports a line that is not JSON, and signals no pid a daemon couldn\'t have', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const run = async (socket: string, ...argv: string[]) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (b) => (out += b));
    stderr.on('data', (b) => (err += b));
    const code = await runCli({ ...(parseCli(argv) as CliOptions), socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout, stderr, reachMs: 1000 });
    return { code, out, err };
  };
  const daemon = { version: '2.0.0', pid: 1, startedAt: '2026-11-08T19:00:00.000Z' };
  try {
    const whole = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'café' }] } })}\n`, 'utf8');
    const at = whole.indexOf(Buffer.from('é', 'utf8')) + 1;
    const split = await standIn(dir, daemon, () => [whole.subarray(0, at), whole.subarray(at)]);
    assert.equal((await run(split.socket, 'list')).out, 'café\n');
    const stopped = await run(split.socket, 'daemon', 'stop');
    assert.equal(stopped.code, 1);
    assert.match(stopped.err, /names pid 1, which can't be its own; nothing was signalled/);
    await split.close();
    const bad = await standIn(dir, daemon, () => [Buffer.from('not json\n')]);
    const r = await run(bad.socket, 'list');
    assert.equal(r.code, 1);
    assert.match(r.err, /the daemon sent a line that is not JSON/);
    await bad.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
