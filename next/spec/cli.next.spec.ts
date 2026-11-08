import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseCli, runCli, type CliOptions } from '../src/endpoint/cli-main.js';
import { runDaemon, type RunningDaemon } from '../src/endpoint/daemon-main.js';
import type { OpenOptions } from '../src/session/types.js';
import { FakeSession } from './fake-session.js';

test('H9: the CLI maps its words to the eight tools\' arguments', () => {
  assert.deepEqual(parseCli(['--scope', 'agent-a', 'run', 'main', 'make', '-j8', 'test', '--wait', '30']), { scope: 'agent-a', call: { tool: 'run', args: { name: 'main', command: 'make -j8 test', wait: 30 } } });
  assert.deepEqual(parseCli(['send', 'main', '--text', 'y', '--keys', 'Enter']), { scope: 'default', call: { tool: 'send', args: { name: 'main', text: 'y', keys: ['Enter'] } } });
  assert.deepEqual(parseCli(['read', 'main', '--lines', '10:20']), { scope: 'default', call: { tool: 'read', args: { name: 'main', lines: [10, 20] } } });
  assert.deepEqual(parseCli(['close', 'main', '--force']), { scope: 'default', call: { tool: 'close', args: { name: 'main', force: true } } });
  assert.deepEqual(parseCli(['list']), { scope: 'default', call: { tool: 'list', args: {} } });
  assert.deepEqual(parseCli(['daemon', 'stop']), { scope: 'default', call: { daemonStop: true } });
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
    assert.match((await cli('--scope', 'a', 'list')).out, /1 ending not yet seen/);
    assert.match((await cli('--scope', 'a', 'list')).out, /1 ending not yet seen/, "the CLI's list left it unseen");
    const missing = await cli('--scope', 'b', 'look', 'main');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No session named "main" is open in scope "b"/);
  } finally {
    await d.stop('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
