import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCli, runCli, USAGE, type CliOptions } from '../src/endpoint/cli-main.js';
import { runDaemon, type RunningDaemon } from '../src/endpoint/daemon-main.js';
import { helloLine, STOP } from '../src/endpoint/hello.js';
import type { OpenOptions } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

test('H9: the CLI maps its words to the nine tools\' arguments', () => {
  assert.deepEqual(parseCli(['--scope', 'agent-a', 'run', 'main', 'make', '-j8', 'test', '--wait', '30']), { scope: 'agent-a', call: { tool: 'run', args: { name: 'main', command: 'make -j8 test', wait: 30 } } });
  assert.deepEqual(parseCli(['send', 'main', '--text', 'y', '--keys', 'Enter']), { scope: 'default', call: { tool: 'send', args: { name: 'main', text: 'y', keys: ['Enter'] } } });
  assert.deepEqual(parseCli(['read', 'main', '--lines', '10:20']), { scope: 'default', call: { tool: 'read', args: { name: 'main', lines: [10, 20] } } });
  assert.deepEqual(parseCli(['close', 'main', '--force']), { scope: 'default', call: { tool: 'close', args: { name: 'main', force: true } } });
  assert.deepEqual(parseCli(['send', 'main', '--text', 'hi', '--keys', 'Enter', '--paste']), { scope: 'default', call: { tool: 'send', args: { name: 'main', text: 'hi', keys: ['Enter'], paste: true } } });
  assert.deepEqual(parseCli(['list']), { scope: 'default', call: { tool: 'list', args: {} } });
  assert.deepEqual(parseCli(['stop', 'main', '--signal', 'SIGUSR1']), { scope: 'default', call: { tool: 'stop', args: { name: 'main', signal: 'USR1' } } });
  assert.deepEqual(parseCli(['integrate', 'main', '--wait', '20']), { scope: 'default', call: { tool: 'integrate', args: { name: 'main', wait: 20 } } });
  assert.deepEqual(parseCli(['daemon', 'stop']), { scope: 'default', call: { daemonStop: true } });
  assert.deepEqual(parseCli(['run', 'main', '--wait', '5', '--', 'grep', '--color', 'x']), { scope: 'default', call: { tool: 'run', args: { name: 'main', wait: 5, command: 'grep --color x' } } });
  assert.deepEqual(parseCli(['run', 'main']), { error: 'run needs a command' });
  assert.deepEqual(parseCli(['look', 'main', '--bogus', 'x']), { error: 'look takes no --bogus' });
  assert.deepEqual(parseCli(['--json', '--scope', 'a', 'list']), { scope: 'a', json: true, call: { tool: 'list', args: {} } });
  assert.deepEqual(parseCli(['--json', 'daemon', 'stop']), { error: "--json prints a tool's result, and `tsm daemon stop` calls no tool" });
  assert.deepEqual(parseCli(['--scope', 'work', '--help']), { help: true });
  assert.deepEqual(parseCli(['--json', '--help', 'list']), { help: true });
});

test('tsm prints its usage and exits 0 for --help among the options before a command', () => {
  const tsm = fileURLToPath(new URL('../src/cli/tsm.js', import.meta.url));
  for (const argv of [['--scope', 'work', '--help'], ['--json', '--help', 'list']]) {
    const r = spawnSync(process.execPath, [tsm, ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, `${USAGE}\n`, argv.join(' '));
  }
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
    const listed = await cli('--json', '--scope', 'a', 'list');
    assert.equal(listed.code, 0);
    assert.equal(listed.err, '');
    assert.match(listed.out, /^[^\n]+\n$/, 'one line of JSON');
    assert.deepEqual((JSON.parse(listed.out) as { sessions: Array<{ name: string }> }).sessions.map((x) => x.name), ['main']);
    const refusedJson = await cli('--json', '--scope', 'b', 'look', 'main');
    assert.equal(refusedJson.code, 1);
    assert.equal((JSON.parse(refusedJson.out) as { error: string }).error, 'session_not_found');
    assert.match(refusedJson.err, /^No session named "main" is open in scope "b"/);
  } finally {
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('several words after the name are each quoted for the shell, one stays a command line, and an empty number is refused', () => {
  assert.deepEqual(parseCli(['run', 'demo', '--', 'printf', '%s\\n', 'hello world']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "printf '%s'\\\\'n' 'hello world'" } } });
  assert.deepEqual(parseCli(['run', 'demo', 'echo', '; rm -rf target']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "echo '; rm -rf target'" } } });
  assert.deepEqual(parseCli(['run', 'demo', "it's"]), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "it's" } } });
  assert.deepEqual(parseCli(['run', 'demo', 'make test | tee log']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: 'make test | tee log' } } });
  assert.deepEqual(parseCli(['run', 'demo', 'printf', '%s', '=ls', 'a^b']), { scope: 'default', call: { tool: 'run', args: { name: 'demo', command: "printf %s '=ls' 'a^b'" } } }, "zsh's = and ^ expansions get nothing unquoted");
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

test('the CLI decodes a character split across chunks, reports a line that is not JSON, and names the pid of a daemon that doesn\'t answer a stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const run = async (socket: string, ...argv: string[]) => {
    const silentStop = argv[0] === 'daemon';
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (b) => (out += b));
    stderr.on('data', (b) => (err += b));
    const code = await runCli({ ...(parseCli(argv) as CliOptions), socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout, stderr, ...(silentStop ? { reachMs: 300 } : {}) });
    return { code, out, err };
  };
  const daemon = { version: '2.0.0', pid: 4242, startedAt: '2026-11-08T19:00:00.000Z' };
  try {
    const whole = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'café' }] } })}\n`, 'utf8');
    const at = whole.indexOf(Buffer.from('é', 'utf8')) + 1;
    const split = await standIn(dir, daemon, () => [whole.subarray(0, at), whole.subarray(at)]);
    assert.equal((await run(split.socket, 'list')).out, 'café\n');
    const stopped = await run(split.socket, 'daemon', 'stop');
    assert.equal(stopped.code, 1);
    assert.match(stopped.err, /^tsm: the daemon \(pid 4242, as it named itself\) didn't stop within 300 ms; if it is stuck, `kill -KILL 4242` ends it, and each shell gets the hangup a closing terminal sends: the shell ends, with the jobs it hangs up, and a job it disowned or started with nohup lives on\n$/);
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

test('tsm daemon stop asks the daemon over its connection, and it stops and hangs up its shells', async () => {
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
  const call = async (...argv: string[]) => {
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (b) => (out += b));
    const code = await runCli({ ...(parseCli(argv) as CliOptions), socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout, stderr: new PassThrough() });
    return { code, out };
  };
  try {
    await call('open', 'main');
    const r = await call('daemon', 'stop');
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`^Stopped the daemon \\(pid ${process.pid}, running since [^)]*\\)\\. It hung up each shell it held, and its log names any session whose processes may live on\\.\n$`));
    await d.stopped;
    assert.ok(sessions[0]!.closedWith, 'its shell was hung up');
  } finally {
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a word given as several is quoted so that bash, zsh, fish and sh each read it back as given', () => {
  const words = ['abc\\', 'a\\\\b', "it's", 'a b', '$HOME', '*', '\\n', "'\\'", ''];
  const quoted = (w: string): string => (parseCli(['run', 'demo', 'printf', w]) as unknown as { call: { args: { command: string } } }).call.args.command.slice('printf '.length);
  const shells = ['bash', 'zsh', 'fish', 'sh', 'dash'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
  assert.ok(shells.length >= 2, `shells found: ${shells.join(', ')}`);
  for (const sh of shells) for (const w of words) {
    const r = spawnSync(sh, ['-c', `printf '%s' ${quoted(w)}`], { encoding: 'utf8' });
    assert.equal(r.stdout, w, `${sh} read ${quoted(w)} as ${JSON.stringify(r.stdout)}: ${r.stderr}`);
  }
});

test("tsm daemon stop doesn't say the daemon stopped while it is still hanging up its shells", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const socket = path.join(dir, 'daemon.sock');
  let closed = false;
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const d = (await runDaemon({
    socket,
    openSession: async (o: OpenOptions) => {
      const s = new FakeSession(o.name, o);
      const close = s.close.bind(s);
      s.close = async (opts) => {
        entered = true;
        await held;
        closed = true;
        return close(opts);
      };
      return s;
    },
    shell: '/bin/bash', env: {}, version: '2.0.0', log: () => {}, confirmMs: 50,
  })) as RunningDaemon;
  let err = '';
  const stderr = new PassThrough();
  stderr.on('data', (b) => (err += b));
  const call = (argv: string[], reachMs?: number) => runCli({ ...(parseCli(argv) as CliOptions), socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout: new PassThrough(), stderr, ...(reachMs === undefined ? {} : { reachMs }) });
  try {
    await call(['open', 'main']);
    assert.equal(await call(['daemon', 'stop'], 1000), 1);
    assert.equal(entered, true, 'the premise: the stop reached the session\'s close, which is held');
    assert.equal(closed, false);
    assert.match(err, /didn't stop within 1000 ms/);
    release();
    await d.stopped;
    assert.equal(closed, true);
  } finally {
    release();
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tsm daemon stop says it can't tell when the socket can't be probed after the stop was answered", { skip: process.getuid?.() === 0 ? 'root connects through a socket of mode 000' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const socket = path.join(dir, 'daemon.sock');
  let answered = false;
  const server = net.createServer((c) => {
    c.on('error', () => {});
    c.write(helloLine({ version: '2.0.0', pid: 4242, startedAt: '2026-11-08T19:00:00.000Z' } as never));
    let buf = '';
    c.on('data', (b) => {
      buf += String(b);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as { id?: unknown; method?: unknown };
        buf = buf.slice(nl + 1);
        if (m.method !== STOP) continue;
        answered = true;
        fs.chmodSync(socket, 0);
        c.end(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (b) => (out += b));
  stderr.on('data', (b) => (err += b));
  try {
    const code = await runCli({ ...(parseCli(['daemon', 'stop']) as CliOptions), socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout, stderr, reachMs: 1000 });
    assert.equal(answered, true, 'the stand-in answered the stop');
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /^tsm: the daemon \(pid 4242\) was asked to stop, but whether it did can't be seen: /);
  } finally {
    fs.chmodSync(socket, 0o600);
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function silentStop(dir: string, daemon: ReturnType<typeof spawn>): Promise<{ socket: string; done: () => Promise<void> }> {
  const socket = path.join(dir, 'daemon.sock');
  const server = net.createServer((c) => {
    c.on('error', () => {});
    c.write(helloLine({ version: '2.0.0', pid: daemon.pid!, startedAt: '2026-11-08T19:00:00.000Z' } as never));
    let buf = '';
    c.on('data', (b) => {
      buf += String(b);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as { method?: unknown };
        buf = buf.slice(nl + 1);
        if (m.method !== STOP) continue;
        server.close();
        c.destroy();
      }
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  return { socket, done: () => new Promise<void>((r) => server.close(() => r())) };
}

function stopCall(socket: string, reachMs: number) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const seen = { out: '', err: '' };
  stdout.on('data', (b) => (seen.out += b));
  stderr.on('data', (b) => (seen.err += b));
  const code = runCli({ ...(parseCli(['daemon', 'stop']) as CliOptions), socket, version: '2.0.0', startDaemon: () => assert.fail('a daemon answers'), stdout, stderr, reachMs });
  return { code, seen };
}

test("tsm daemon stop that gets no answer waits for the daemon's pid to be gone before saying it exited", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const daemon = spawn('sleep', ['60'], { stdio: 'ignore' });
  const exited = new Promise<void>((r) => daemon.once('exit', () => r()));
  const kill = process.kill;
  let polled!: () => void;
  const polling = new Promise<void>((r) => (polled = r));
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === daemon.pid && signal === 0) polled();
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  const d = await silentStop(dir, daemon);
  try {
    let returned = false;
    const call = stopCall(d.socket, 10_000);
    void call.code.then(() => (returned = true));
    await Promise.race([polling, call.code]);
    assert.equal(returned, false, `it returned while the pid was alive: ${call.seen.out}${call.seen.err}`);
    daemon.kill('SIGKILL');
    await exited;
    assert.equal(await call.code, 0, call.seen.err);
    assert.equal(call.seen.out, `The daemon (pid ${daemon.pid}, running since 2026-11-08T19:00:00.000Z) closed its connection without answering the stop, and has exited. Its log says whether it closed its sessions first.\n`);
  } finally {
    process.kill = kill;
    daemon.kill('SIGKILL');
    await d.done().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tsm daemon stop that gets no answer fails, saying so, when the daemon's pid outlives its bound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const daemon = spawn('sleep', ['60'], { stdio: 'ignore' });
  const d = await silentStop(dir, daemon);
  try {
    const call = stopCall(d.socket, 300);
    assert.equal(await call.code, 1);
    assert.equal(call.seen.out, '');
    assert.equal(call.seen.err, `tsm: the daemon (pid ${daemon.pid}) closed its connection without answering the stop, and its socket no longer answers, but it is still running\n`);
  } finally {
    daemon.kill('SIGKILL');
    await d.done().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second tsm daemon stop, while the first daemon is closing its connections, waits for it to go and says it was already stopping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const socket = path.join(dir, 'daemon.sock');
  let accepted = 0;
  const server = net.createServer((c) => {
    c.on('error', () => {});
    accepted++;
    c.destroy();
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const call = stopCall(socket, 5000);
    let returned = false;
    void call.code.then(() => (returned = true));
    const end = Date.now() + 3000;
    while (accepted < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.equal(returned, false, 'it waits while the daemon closes its connections');
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(socket, { force: true });
    assert.equal(await call.code, 0, call.seen.err);
    assert.equal(call.seen.out, `A daemon at ${socket} was already stopping; its socket no longer answers.\n`);
  } finally {
    if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second tsm daemon stop whose daemon still closes its connections at the deadline fails, saying what it saw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-cli-'));
  const socket = path.join(dir, 'daemon.sock');
  const server = net.createServer((c) => {
    c.on('error', () => {});
    c.destroy();
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const call = stopCall(socket, 400);
    assert.equal(await call.code, 1);
    assert.match(call.seen.err, /still accepted connections and closed them before its hello after 400 ms, as one that is stopping does/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
