/** Real OpenSSH on loopback, with disposable keys/config and no user SSH configuration.
 * These checks exercise terminal/transport semantics, not a production VPN or remote OS. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { App } from '../src/api/app.js';
import { TokenMapResolver } from '../src/api/principals.js';
import { SessionRegistry } from '../src/api/registry.js';
import { NodePtyBackend } from '../src/backends/node-pty.js';
import { TermServer } from '../src/transport/server.js';
import { AGENT, realSession, until } from './fake-shell.js';
import { TestHost, sleep } from './testhost.js';

const SSH = '/usr/bin/ssh', SSHD = '/usr/sbin/sshd', KEYGEN = '/usr/bin/ssh-keygen';
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

describe('SSH workflows', { skip: ![SSH, SSHD, KEYGEN].every(fs.existsSync) }, () => {
  let dir: string, remote: string, args: string[], dest: string;
  let sshd: ChildProcess | undefined;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-ssh-'));
    remote = path.join(dir, 'remote');
    fs.mkdirSync(remote);
    for (const name of ['host', 'client']) execFileSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, name)]);
    const port = await freePort();
    const config = path.join(dir, 'sshd.conf');
    fs.writeFileSync(config, [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${dir}/host`, `PidFile ${dir}/pid`,
      `AuthorizedKeysFile ${dir}/client.pub`, 'StrictModes no', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'UsePAM no', `AllowUsers ${os.userInfo().username}`,
      `SetEnv HOME=${remote}`, 'AllowAgentForwarding no', 'AllowTcpForwarding local', 'LogLevel ERROR', '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${fs.readFileSync(path.join(dir, 'host.pub'), 'utf8')}`);
    args = ['-F', '/dev/null', '-p', String(port), '-i', path.join(dir, 'client'), '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${dir}/known_hosts`,
      '-o', 'ConnectTimeout=3', '-o', 'ForwardAgent=no'];
    dest = `${os.userInfo().username}@127.0.0.1`;
    sshd = spawn(SSHD, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    sshd.stderr!.on('data', (s) => { diagnostics += s; });
    await until(() => {
      assert.equal(sshd!.exitCode, null, diagnostics);
      try { return execFileSync(SSH, [...args, dest, 'printf ready'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }) === 'ready'; }
      catch { return false; }
    }, 6000, 'disposable SSH server');
  });
  after(async () => { await stop(sshd); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('interactive SSH stays one busy local Run; remote marks cannot admit local commands', async () => {
    const x = await realSession('/bin/bash');
    try {
      const command = [SSH, ...args, '-tt', dest, `cd ${quote(remote)}; printf REMOTE_READY; exec /bin/sh -i`].map(quote).join(' ');
      const run = await x.run(command, 20);
      await until(() => x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes('REMOTE_READY')), 5000);
      assert.equal(x.session.run(run.runId).state, 'running');
      const local = x.session.admit({ target: 'shell', line: 'echo WRONG-DESTINATION', principal: AGENT });
      assert.equal(local.admitted, false);
      x.session.input("printf '\\033]133;D;0\\007\\033]633;P;Cwd=/remote-fake\\007'; pwd\n", { principal: AGENT });
      await until(() => x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes(remote)), 3000);
      assert.equal(x.session.run(run.runId).state, 'running');
      assert.equal(x.session.cwd, x.tmp);
      x.session.input('exit 7\n', { principal: AGENT });
      assert.equal((await x.session.awaitRun(run.runId, 5000)).exit, 7);
      assert.equal((await x.run('echo local-again')).text, 'local-again');
    } finally { await x.close(); }
  });

  test('a declared remote shell over SSH: plain Runs run remotely with status and exact text, and the declaration ends with the connection', async () => {
    const x = await realSession('/bin/bash');
    try {
      const command = [SSH, ...args, '-tt', dest, `cd ${quote(remote)}; printf REMOTE_READY; exec /bin/sh -i`].map(quote).join(' ');
      const ssh = await x.run(command, 20);
      await until(() => x.journal.since(0).events.some((e) => e.type === 'output' && e.data.includes('REMOTE_READY')), 5000);
      assert.deepEqual(x.session.declareShell({ shell: 'sh', principal: AGENT }), { shell: 'sh', within: ssh.runId, depth: 1 });
      const where = await x.run('pwd; echo "pid=$$"; (exit 6)');
      assert.deepEqual([where.state, where.exit, where.within], ['exited', 6, ssh.runId]);
      assert.equal(where.text.split('\n')[0], remote, 'the command ran on the remote side');
      const payload = `it's "quoted" \\back\\slash %d\ttab ünïcødé 😀 $HOME \`x\` !bang`;
      const exact = await x.run(`cat <<'TSM_EOF'\n${payload}\nTSM_EOF`);
      assert.equal(exact.text.replace(/\s+/g, ' '), payload.replace(/\s+/g, ' '));
      const long = await x.run(`f() {\n${Array.from({ length: 80 }, (_, i) => `  echo remote-${i}-${'y'.repeat(40)}`).join('\n')}\n}\nf | wc -l`, 10_000);
      assert.deepEqual([long.state, long.text.trim()], ['exited', '80']);
      assert.equal((await x.run('cd /; pwd')).text.trim(), '/');
      // Leaving the remote shell ends ssh with its status; the declaration ends with it and the local shell is back.
      assert.equal((await x.run('exit 7')).state, 'lost');
      assert.equal((await x.session.awaitRun(ssh.runId, 5000)).exit, 7);
      assert.equal(x.session.info().declared, undefined);
      assert.equal((await x.run('echo local-again')).text, 'local-again');
    } finally { await x.close(); }
  });

  test('unattended SSH preserves observed exit and separate streams without occupying the shell', async () => {
    const x = await realSession('/bin/bash');
    try {
      const run = x.session.admit({ target: 'process', argv: [SSH, ...args, '-T', dest, 'sleep 0.3; printf remote-out; printf remote-err >&2; exit 7'], principal: AGENT });
      assert.ok(run.admitted);
      assert.ok(x.session.shellAvailable().ok);
      const done = await x.session.awaitRun(run.run.runId, 5000);
      assert.deepEqual([done.state, done.exit], ['exited', 7]);
      const output = x.journal.since(0).events.filter((e) => e.type === 'output' && e.runId === done.runId);
      assert.ok(output.some((e) => e.type === 'output' && e.stream === 'stdout' && e.data.includes('remote-out')));
      assert.ok(output.some((e) => e.type === 'output' && e.stream === 'stderr' && e.data.includes('remote-err')));
    } finally { await x.close(); }
  });

  test('SSH tunnel interruption preserves remote Run identity, output and completion delivery', async () => {
    const registry = new SessionRegistry({ dataDir: path.join(dir, 'termd'), backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
    const app = new App({ registry, segmenter: { runSettleMs: 30 } });
    const server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { test: AGENT } }), host: '127.0.0.1', port: 0, version: 'ssh-test', log: () => undefined });
    const endpoint = (await server.listen()).port;
    const forwarded = await freePort();
    const tunnel = () => spawn(SSH, [...args, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${forwarded}:127.0.0.1:${endpoint}`, dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let connection: ChildProcess | undefined;
    let a: TestHost | undefined, b: TestHost | undefined;
    const ready = async () => {
      let ok = false;
      for (let i = 0; i < 100 && !ok; i++) {
        assert.equal(connection!.exitCode, null, 'SSH forwarding process exited');
        try { ok = (await fetch(`http://127.0.0.1:${forwarded}/health`)).ok; } catch {}
        if (!ok) await sleep(20);
      }
      assert.ok(ok, 'SSH forwarding became ready');
    };
    try {
      connection = tunnel(); await ready();
      a = await new TestHost({ port: forwarded, token: 'test', connection: 'before', mcpl: true }).connect();
      const run = await a.call('run', { session: 'remote-build', command: 'sleep 1; echo survived-tunnel', wait: 0 });
      const id = run.structured!.runId;
      await stop(connection);
      await until(() => a!.closed, 2000, 'client to observe the tunnel loss');
      await sleep(1200); // completion occurs while the tunnel is absent
      connection = tunnel(); await ready();
      b = await new TestHost({ port: forwarded, token: 'test', connection: 'after', mcpl: true }).connect();
      const delivery = await b.delivery((d) => d.metadata.runId === id);
      assert.match(delivery.text, /survived-tunnel/);
      const outcome = await b.call('await', { session: 'remote-build', runId: id });
      assert.deepEqual([outcome.structured!.state, outcome.structured!.exit], ['exited', 0]);
      assert.equal(registry.get('remote-build')!.listRuns().length, 1, 'no re-execution on reconnect');
    } finally {
      await a?.close(); await b?.close(); await stop(connection);
      const closed = server.close(); await registry.closeAll(); await closed;
    }
  });
});
