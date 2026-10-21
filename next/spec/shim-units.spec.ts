/**
 * The shim's readers of a supervisor's unit, run on texts of the spec's own on any platform: what
 * `systemctl show` and `launchctl print` say termd is started with, read as termd would take it, or
 * unknown where the text cannot tell (the house's read of the 33 commits, #22 comment 6307350861).
 * The shim's own supervisor check, end to end, is in shim.spec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { askDataDir, titlePort } from '../src/shim/running.js';
import { launchctlUnit, plistUnit, procEnviron, systemctlUnit, unitArg, unitDataDir, unitPort, type UnitText } from '../src/shim/units.js';

/** ExecStart as systemd 255 prints it: the argv joined by one space each, unquoted; `prefix` goes before the launcher (an `env …`). */
const execStart = (argv: string[], prefix: string[] = []) => `{ path=${prefix[0] ?? '/bin/sh'} ; argv[]=${[...prefix, '/bin/sh', '/pkg/next/config/termd-launch.sh', ...argv].join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

/** A `launchctl print` answer as macOS prints one: the job's keys one tab in, a block's entries two. */
const launchctlPrint = (o: { argv?: string[]; env?: Record<string, string> }) =>
  [
    'gui/501/com.animalabs.termd = {',
    '\tactive count = 1',
    '\tpath = /Users/a/Library/LaunchAgents/com.animalabs.termd.plist',
    '\ttype = LaunchAgent',
    '\tstate = running',
    '',
    '\tprogram = /bin/sh',
    ...(o.argv ? ['\targuments = {', ...['/bin/sh', '/pkg/next/config/termd-launch.sh', ...o.argv].map((a) => `\t\t${a}`), '\t}', ''] : []),
    '\tinherited environment = {',
    '\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.x/Listeners',
    '\t}',
    '',
    '\tenvironment = {',
    ...Object.entries(o.env ?? {}).map(([k, v]) => `\t\t${k} => ${v}`),
    '\t}',
    '}',
  ].join('\n');

/** A unit's `systemctl show` text, with the user manager's environment carrying HOME, as the shim's query of it does. */
const systemd = (argv: string[], environment = ''): UnitText => {
  const u = systemctlUnit(execStart(argv), environment, { manager: `HOME=${os.homedir()}` });
  assert.ok(u, 'the ExecStart is read');
  return u;
};

test('a data dir with a run of spaces, or a space at either end, reads back whole from systemctl show; `--flag=value` too', () => {
  // The house ran `--data-dir /home/a/my  data` through a copy of the reader: it came back with one space.
  assert.equal(unitArg(systemd(['--port', '3101', '--data-dir', '/home/a/my  data']), '--data-dir'), '/home/a/my  data');
  assert.equal(unitDataDir(systemd(['--data-dir', '/home/a/my  data', '--port', '3101'])), '/home/a/my  data');
  assert.equal(unitArg(systemd(['--data-dir', ' /srv/lead', '--port', '3101']), '--data-dir'), ' /srv/lead');
  assert.equal(unitArg(systemd(['--port', '3101', '--data-dir', '/srv/trail ']), '--data-dir'), '/srv/trail ');
  assert.equal(unitArg(systemd(['--data-dir=/srv/a   b']), '--data-dir'), '/srv/a   b');
  // An empty value is no value, as termd refuses it: the data dir is unknown, not $HOME.
  assert.deepEqual(unitDataDir(systemd(['--port', '3101', '--data-dir', ''])), { unknown: 'names --data-dir without a value' });
  assert.deepEqual(unitDataDir(systemd(['--data-dir='])), { unknown: 'names --data-dir without a value' });
});

test('an empty TSM_PORT or TSM_DATA_DIR in a unit is unset, as for termd: the next setting decides', () => {
  // The house's unit: `TSM_PORT= SESSION_SERVER_PORT=4100` read as port "", where termd listens on 4100.
  assert.equal(unitPort(systemd([], 'TSM_PORT= SESSION_SERVER_PORT=4100')), '4100');
  assert.equal(unitPort(systemd([], 'TSM_PORT=')), '3101');
  assert.equal(unitPort(systemd([], 'TSM_PORT=4200 SESSION_SERVER_PORT=4100')), '4200');
  assert.equal(unitDataDir(systemd([], 'TSM_DATA_DIR=')), path.join(os.homedir(), '.tsm'));
  const launchd = launchctlUnit(launchctlPrint({ argv: [], env: { TSM_PORT: '', SESSION_SERVER_PORT: '4100' } }));
  assert.ok(launchd);
  assert.equal(launchd.env.TSM_PORT, '', 'launchctl prints the empty value, and it is read as printed');
  assert.equal(unitPort(launchd), '4100');
});

test('a launchctl print with no arguments block is unknown, not termd with no arguments; with one, each entry is kept as printed past its indent', () => {
  // launchctl prints no arguments block for a job naming Program alone (com.apple.progressd is one).
  assert.equal(launchctlUnit(launchctlPrint({ env: { TSM_PORT: '4100' } })), undefined);
  const u = launchctlUnit(launchctlPrint({ argv: ['--port', '4100', '--data-dir', ' /srv/my  data '], env: { TSM_DATA_DIR: '/ignored' } }));
  assert.ok(u);
  assert.deepEqual(u.argv, ['/bin/sh', '/pkg/next/config/termd-launch.sh', '--port', '4100', '--data-dir', ' /srv/my  data ']);
  assert.equal(unitPort(u), '4100');
  assert.equal(unitArg(u, '--data-dir'), ' /srv/my  data ');
  // Only the job's own environment: the inherited one is another block.
  assert.deepEqual(u.env, { TSM_DATA_DIR: '/ignored' });
});

test('an option given twice is read as termd reads it, by its last value (the house\'s read of the 40 commits, #22)', () => {
  // The first value was read: `/a`, where termd's parseArgs takes `/b`.
  assert.equal(unitDataDir(systemd(['--data-dir', '/a', '--data-dir', '/b'])), '/b');
  assert.equal(unitArg(systemd(['--port', '4100', '--port=4200']), '--port'), '4200');
  assert.equal(unitPort(systemd(['--port', '4100', '--port', '4200'])), '4200');
});

test('a --port with no value is an unknown port, not the environment\'s or termd\'s default (the house\'s read of the 40 commits, #22)', () => {
  // termd refuses it, as it refuses a --data-dir with none: read on, it was TSM_PORT's 4100, and with no environment 3101.
  const valueless = { unknown: 'names --port without a value' };
  assert.deepEqual(unitPort(systemd(['--port'], 'TSM_PORT=4100')), valueless);
  assert.deepEqual(unitPort(systemd(['--port='])), valueless);
  assert.deepEqual(unitPort(systemd(['--port', '', '--data-dir', '/srv/d'])), valueless);
  const launchd = launchctlUnit(launchctlPrint({ argv: ['--port'], env: { SESSION_SERVER_PORT: '4100' } }));
  assert.ok(launchd);
  assert.deepEqual(unitPort(launchd), valueless);
});

test('an empty ExecStart is unknown, not termd with no arguments (the house\'s read of the 40 commits, #22)', () => {
  assert.equal(systemctlUnit('', ''), undefined);
  assert.equal(systemctlUnit('', 'TSM_PORT=4100'), undefined);
});

test('a data dir is read as termd will be given it: systemd expands ${NAME} when it runs the unit, nothing expands ~, and termd resolves from $HOME (the house\'s read of the 40 commits, #22)', () => {
  const home = os.homedir();
  // systemd 255 left `~/ab` as it was, ran `${HOME}/brace` as $HOME/brace, and passed no `$HOME/x` at all.
  assert.equal(unitDataDir(systemd(['--data-dir', '~/x'])), path.join(home, '~/x'));
  assert.equal(unitDataDir(systemd(['--data-dir', '${HOME}/y'])), path.join(home, 'y'));
  assert.equal(unitDataDir(systemd(['--data-dir', '${TSM_BASE}/z'], 'TSM_BASE=/srv/base')), '/srv/base/z');
  assert.equal(systemctlUnit(execStart(['--data-dir', '$HOME/x']), ''), undefined, 'an argument systemd drops leaves the argv unknown');
  assert.equal(systemctlUnit(execStart(['--data-dir', '${UNSET_HERE}/x']), ''), undefined, 'a variable not known here leaves the argv unknown');
  // An Environment value systemd passes as written (its `${...}` unexpanded); a relative one is from $HOME.
  assert.equal(unitDataDir(systemd([], 'TSM_DATA_DIR=~/env')), path.join(home, '~/env'));
  assert.equal(unitDataDir(systemd([], 'TSM_DATA_DIR=rel/d')), path.join(home, 'rel/d'));
  // launchd passes ProgramArguments as written.
  const launchd = launchctlUnit(launchctlPrint({ argv: ['--data-dir', '~/x'] }));
  assert.ok(launchd);
  assert.equal(unitDataDir(launchd), path.join(home, '~/x'));
});

test('a LaunchAgent plist\'s environment keeps every key past an empty <string/> (the house\'s read of the 40 commits, #22)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-plist-'));
  try {
    const file = path.join(dir, 'com.animalabs.termd.plist');
    fs.writeFileSync(
      file,
      '<plist><dict><key>ProgramArguments</key><array><string>/bin/sh</string></array>' +
        '<key>EnvironmentVariables</key><dict><key>EMPTY</key><string/><key>TSM_DATA_DIR</key><string>/data/t</string><key>OTHER</key><string /></dict></dict></plist>',
    );
    const u = plistUnit(file);
    assert.ok(!('error' in u), JSON.stringify(u));
    // The lazy key ran on over `<string/>`: the env was {"EMPTY</key><string/><key>TSM_DATA_DIR": "/data/t"}.
    assert.deepEqual(u.env, { EMPTY: '', TSM_DATA_DIR: '/data/t', OTHER: '' });
    assert.equal(unitDataDir(u), '/data/t');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a unit naming an EnvironmentFile= has every value termd takes from its environment unknown, and its command line's options known (the house's read of the 40 commits through f3750e4, #22 comment 6310921374)", () => {
  // As systemctl 257 prints them: one line each, an optional (`-`) file as ignore_errors=yes.
  const files = ['/home/a/.config/termd.env (ignore_errors=yes)', '/etc/termd/env (ignore_errors=no)'];
  const read = (argv: string[], environment = '') => {
    const u = systemctlUnit(execStart(argv), environment, { files });
    assert.ok(u, 'the ExecStart is read');
    return u;
  };
  // Read from Environment= alone, a file's TSM_PORT=4100 or TSM_DATA_DIR was taken for port 3101 and $HOME/.tsm.
  const which = 'EnvironmentFile=/home/a/.config/termd.env, /etc/termd/env';
  assert.deepEqual(unitPort(read([])), { unknown: `names no --port and reads ${which}, which may set TSM_PORT or SESSION_SERVER_PORT` });
  assert.deepEqual(unitPort(read([], 'TSM_PORT=4200')), { unknown: `names no --port and reads ${which}, which may set TSM_PORT or SESSION_SERVER_PORT` }, "a file's value wins over Environment='s");
  assert.deepEqual(unitDataDir(read(['--port', '3101'], 'TSM_DATA_DIR=/srv/d')), { unknown: `names no --data-dir and reads ${which}, which may set TSM_DATA_DIR` });
  // termd reads its options before its environment: what the command line says stands.
  const flags = read(['--port', '4100', '--data-dir', '/srv/unit']);
  assert.equal(unitPort(flags), '4100');
  assert.equal(unitDataDir(flags), '/srv/unit');
  // systemd expands ${NAME} from the environment the files are part of, so a value with one is unknown, HOME too.
  assert.deepEqual(unitDataDir(read(['--data-dir', '${HOME}/d'])), { unknown: `gives the data dir a value ${which} may set` });
  assert.deepEqual(unitDataDir(read(['--data-dir', '${BASE}/d'], 'BASE=/srv')), { unknown: `gives the data dir a value ${which} may set` });
  // No file named: as before.
  assert.equal(unitPort(systemd([], 'TSM_PORT=4200')), '4200');
});

test("under an EnvironmentFile=, a ${NAME} makes unknown only what it can be: the value it stands in, or any option where termd may read it as one (the house's review of f3750e4..4f4c067, #22 comment 6315636412)", () => {
  // One ${NAME} anywhere made the literal --port and --data-dir unknown too.
  const files = ['/etc/termd.env (ignore_errors=no)'];
  const which = 'EnvironmentFile=/etc/termd.env';
  const read = (argv: string[]) => {
    const u = systemctlUnit(execStart(argv), '', { manager: 'HOME=/home/a', files });
    assert.ok(u, 'the ExecStart is read');
    return u;
  };
  const both = read(['--log-file', '${LOG}', '--port', '3101', '--data-dir', '/srv/unit']);
  assert.equal(unitPort(both), '3101', 'a variable in another option leaves --port known');
  assert.equal(unitDataDir(both), '/srv/unit');
  const dir = read(['--port', '3101', '--data-dir', '${BASE}/d']);
  assert.equal(unitPort(dir), '3101');
  assert.deepEqual(unitDataDir(dir), { unknown: `gives the data dir a value ${which} may set` });
  assert.deepEqual(unitDataDir(read(['--port', '3101', '--data-dir', '${DIR}'])), { unknown: `gives the data dir a value ${which} may set` });
  const port = read(['--port', '${P}', '--data-dir', '/srv/unit']);
  assert.deepEqual(unitPort(port), { unknown: `gives the port a value ${which} may set` });
  assert.equal(unitDataDir(port), '/srv/unit');
  // systemd makes ${NAME} exactly one argument, so where termd may read that argument as an option, any option may be in it.
  const opts = read(['--data-dir', '/srv/unit', '--port', '3101', '${OPTS}']);
  const loose = { unknown: `passes an argument (\${…}) from ${which} where termd may read it as an option of its own` };
  assert.deepEqual(unitPort(opts), loose);
  assert.deepEqual(unitDataDir(opts), loose);
  assert.deepEqual(unitPort(read(['--${OPT}', '4100', '--data-dir', '/srv/unit'])), { unknown: `passes an option named by a variable (--\${…}) from ${which} where termd may read it as an option of its own` });
  // Before the first option stand the launcher and its script: a literal option after them wins.
  assert.equal(unitPort(read(['${OPTS}', '--port', '3101', '--data-dir', '/srv/unit'])), '3101');
  // A relative data dir is taken from $HOME, which the file may set; an absolute one is not.
  assert.deepEqual(unitDataDir(read(['--port', '3101', '--data-dir', 'rel/d'])), { unknown: `gives a data dir taken from $HOME, which ${which} may set` });
});

test("an env prefix in ExecStart or ProgramArguments is read as env applies it: its assignments, -u and -i change the environment, and an option it has that is not read leaves the unit unknown (the house's review of f3750e4..4f4c067, #22 comment 6315636412)", () => {
  // Read as arguments, `env TSM_PORT=4100 /bin/sh termd-launch.sh` was port 3101.
  const read = (prefix: string[], argv: string[] = [], environment = '', files?: string[]) => {
    const u = systemctlUnit(execStart(argv, prefix), environment, { manager: 'HOME=/home/a', ...(files && { files }) });
    assert.ok(u, 'the ExecStart is read');
    return u;
  };
  assert.equal(unitPort(read(['/usr/bin/env', 'TSM_PORT=4100'])), '4100');
  assert.equal(unitPort(read(['/usr/bin/env', 'TSM_PORT=4100'], ['--port', '4200'])), '4200', 'an option still wins over the environment');
  assert.equal(unitPort(read(['/usr/bin/env', '-u', 'TSM_PORT'], [], 'TSM_PORT=4200')), '3101');
  assert.equal(unitPort(read(['/usr/bin/env', '--unset=TSM_PORT', 'SESSION_SERVER_PORT=4300'], [], 'TSM_PORT=4200')), '4300');
  assert.equal(unitDataDir(read(['/usr/bin/env', '-i', 'HOME=/home/z'], [], 'TSM_DATA_DIR=/srv/x')), '/home/z/.tsm', '-i starts the environment empty');
  assert.equal(unitPort(read(['/usr/bin/env', 'A=1', '/usr/bin/env', 'TSM_PORT=4400'])), '4400', 'env run by env applies again');
  assert.equal(unitPort(read(['/usr/bin/env', '--', 'TSM_PORT=4500'])), '4500');
  // What env sets, no EnvironmentFile= decides.
  const filed = read(['/usr/bin/env', 'TSM_DATA_DIR=/srv/env'], ['--port', '3101'], '', ['/etc/termd.env (ignore_errors=no)']);
  assert.equal(unitDataDir(filed), '/srv/env');
  assert.equal(unitPort(filed), '3101');
  // -C changes the directory a relative data dir is taken from, -S splits a string: neither is read.
  assert.deepEqual(unitPort(read(['/usr/bin/env', '-C', '/srv'])), { unknown: 'runs env with -C, which is not read here' });
  assert.deepEqual(unitDataDir(read(['/usr/bin/env', '-S', 'TSM_PORT=1 /bin/sh'])), { unknown: 'runs env with -S, which is not read here' });
  // systemctl prints the argv unquoted: `"TSM_DATA_DIR=/my data"` reads as two words, and the second is not a program's path.
  assert.deepEqual(unitDataDir(read(['/usr/bin/env', 'TSM_DATA_DIR=/my', 'data'])), { unknown: "runs env with data after its assignments, which systemctl's unquoted text cannot tell from the rest of a value with a space in it" });
  // launchd's arguments are whole, so a value with a space is one entry, and env may find its program on PATH.
  const launchd = launchctlUnit(
    launchctlPrint({ argv: [] }).replace('\t\t/bin/sh\n\t\t/pkg', '\t\t/usr/bin/env\n\t\tTSM_DATA_DIR=/srv/my data\n\t\tsh\n\t\t/pkg'),
  );
  assert.ok(launchd);
  assert.equal(unitDataDir(launchd), '/srv/my data');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-plist-env-'));
  try {
    const file = path.join(dir, 'com.animalabs.termd.plist');
    fs.writeFileSync(file, '<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>TSM_PORT=4600</string><string>/bin/sh</string><string>/pkg/l.sh</string></array></dict></plist>');
    const u = plistUnit(file);
    assert.ok(!('error' in u), JSON.stringify(u));
    assert.equal(unitPort(u), '4600');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a running termd's environment is the one read when Linux shows it: whole, files and the manager's at its start included, and only this user's process (the house's review of f3750e4..4f4c067, #22 comment 6315636412)", { skip: process.platform !== 'linux' && 'Linux shows a process environment in /proc' }, async () => {
  // The manager's environment as it is now held a variable imported after the unit started, which the running termd never had.
  const child = spawn('sleep', ['30'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/run', TSM_DATA_DIR: '/srv/at-start', BASE: '/srv/base' }, stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const proc = procEnviron(child.pid!);
    assert.ok('env' in proc, JSON.stringify(proc));
    assert.equal(proc.env.TSM_DATA_DIR, '/srv/at-start');
    const u = systemctlUnit(execStart(['--port', '3101', '--log-file', '${BASE}/log']), 'TSM_DATA_DIR=/srv/unit', { manager: 'TSM_DATA_DIR=/srv/imported-since', files: ['/etc/termd.env (ignore_errors=no)'], running: proc.env });
    assert.ok(u, 'the ExecStart is read, ${BASE} from the running environment');
    assert.equal(unitDataDir(u), '/srv/at-start', 'what termd was given, not the manager or the unit text now');
    assert.equal(unitPort(u), '3101');
    if (process.getuid?.() !== 0) assert.deepEqual(procEnviron(1), { error: "it is another user's process" });
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once('exit', r));
  assert.deepEqual(procEnviron(child.pid!), { error: 'ENOENT' }, 'a process that has gone');
});

test("a running termd is asked for its data dir on the port its title names, and only the pid asked about counts as its answer (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question 1)", async () => {
  // /health as termd answers it, from a stand-in whose answer the test sets.
  let answer: Record<string, unknown> = {};
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    answer = { status: 'ok', pid: 4242, dataDir: '/srv/running' };
    assert.deepEqual(await askDataDir(port, 4242, 1500), { dataDir: '/srv/running' });
    assert.deepEqual(await askDataDir(port, 4343, 1500), { error: `port ${port} is served by pid 4242, not by it` }, 'another process on the port');
    answer = { status: 'ok', pid: 4242, detail: 'present a token (?token= or Authorization: Bearer) for sessions' };
    assert.match(JSON.stringify(await askDataDir(port, 4242, 1500)), /its \/health names no data dir/);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(await askDataDir(port, 4242, 1500), { error: `nothing listens on port ${port}` });
  // Linux shows a process's title in its cmdline, as termd sets it; elsewhere `ps` shows the start arguments.
  if (process.platform === 'linux') {
    const child = spawn(process.execPath, ['-e', "process.title = 'termd --port 4321'; console.log('ready'); setTimeout(() => {}, 30_000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((r) => child.stdout!.once('data', r));
      assert.equal(titlePort(child.pid!), 4321);
    } finally {
      child.kill();
    }
  }
  assert.match(JSON.stringify(titlePort(process.pid)), /its title is not a termd's with a port/);
});

test("a running unit's env prefix is not applied again to the environment its termd has, and a ${NAME} it sets in termd's arguments is unknown (the house's read of the 17 commits over our fixes, #22)", () => {
  // systemd expands every ${NAME} before env runs; the running termd's environment is what env then made. Applied
  // again, `env TSM_DATA_DIR=${TSM_DATA_DIR}/x` read the data dir as …/x/x.
  const running = { HOME: '/home/r', TSM_DATA_DIR: '/srv/b/x', BASE: '/srv/new' };
  const self = systemctlUnit(execStart(['--port', '3101'], ['/usr/bin/env', 'TSM_DATA_DIR=${TSM_DATA_DIR}/x']), '', { running });
  assert.ok(self, 'the ExecStart is read');
  assert.equal(unitDataDir(self), '/srv/b/x', 'the data dir termd has, not the prefix applied twice');
  // A ${NAME} in termd's own arguments that the prefix sets was expanded from the value before env ran.
  assert.equal(systemctlUnit(execStart(['--data-dir', '${BASE}/d'], ['/usr/bin/env', 'BASE=/srv/new']), '', { running }), undefined);
  assert.equal(systemctlUnit(execStart(['--data-dir', '${BASE}/d'], ['/usr/bin/env', '-i', 'HOME=/home/r']), '', { running }), undefined, 'any, after -i');
  // One the prefix leaves alone is the same before env and after it.
  const kept = systemctlUnit(execStart(['--data-dir', '${BASE}/d'], ['/usr/bin/env', 'TSM_PORT=4100']), '', { running });
  assert.ok(kept);
  assert.equal(unitDataDir(kept), '/srv/new/d');
});

test("a unit's environment starts from the user manager's, which Environment= overrides and UnsetEnvironment= takes from (systemd 257, probed with a user unit)", () => {
  const read = (argv: string[], environment: string, more: { manager?: string; unset?: string }) => {
    const u = systemctlUnit(execStart(argv), environment, more);
    assert.ok(u, 'the ExecStart is read');
    return u;
  };
  // A TSM_DATA_DIR a login imported into the manager reaches termd: read from Environment= alone, it was $HOME/.tsm.
  assert.equal(unitDataDir(read(['--port', '3101'], '', { manager: 'HOME=/home/a "TSM_DATA_DIR=/srv/my data"' })), '/srv/my data');
  assert.equal(unitPort(read([], '', { manager: 'TSM_PORT=4100' })), '4100');
  assert.equal(unitPort(read([], 'TSM_PORT=4200', { manager: 'TSM_PORT=4100' })), '4200', "the unit's own value wins");
  assert.equal(unitDataDir(read(['--data-dir', '${BASE}/d'], '', { manager: 'BASE=/srv/base' })), '/srv/base/d', '${NAME} expands from it too');
  // UnsetEnvironment= takes a variable by name, or one assignment of it only when the value matches.
  assert.equal(unitDataDir(read([], '', { manager: 'TSM_DATA_DIR=/srv/x', unset: 'TSM_DATA_DIR' })), path.join(os.homedir(), '.tsm'));
  assert.equal(unitPort(read([], 'TSM_PORT=4200', { manager: 'TSM_PORT=4100', unset: 'TSM_PORT=4100' })), '4200');
  assert.equal(unitPort(read([], '', { manager: 'TSM_PORT=4100', unset: 'TSM_PORT=4100' })), '3101');
});

test("a unit's port is read as termd reads it: trimmed and as a number, and one termd refuses is unknown (the house's read of the 40 commits over our fixes, #22)", () => {
  // Compared as written, `03101` and ` 3101` were another port than the shim's 3101.
  assert.equal(unitPort(systemd(['--port', '03101'])), '3101');
  assert.equal(unitPort(systemd([], '"TSM_PORT= 3101"')), '3101');
  assert.equal(unitPort(systemd([], 'SESSION_SERVER_PORT=04100')), '4100');
  const launchd = launchctlUnit(launchctlPrint({ argv: ['--port=03101'] }));
  assert.ok(launchd);
  assert.equal(unitPort(launchd), '3101');
  for (const bad of ['31o1', '70000', ' ']) {
    assert.deepEqual(unitPort(systemd([], `"TSM_PORT=${bad}"`)), { unknown: `gives the port ${JSON.stringify(bad)}, which termd refuses` }, bad);
  }
});

test("a unit's data dir is resolved from the HOME its environment gives termd, which the launcher starts in, and a ${HOME} it takes away is unknown (the house's read of the 40 commits over our fixes, #22)", () => {
  // systemd 255, transient user units: Environment=HOME=<dir> ran `${HOME}/x` as <dir>/x with HOME=<dir>,
  // and UnsetEnvironment=HOME ran it as /x with HOME unset. Taken from this shim's home, both were read wrong.
  const read = (argv: string[], environment: string, more: { manager?: string; unset?: string }) => {
    const u = systemctlUnit(execStart(argv), environment, more);
    assert.ok(u, 'the ExecStart is read');
    return u;
  };
  const manager = 'HOME=/home/a';
  assert.equal(unitDataDir(read(['--port', '3101'], '', { manager })), '/home/a/.tsm', "the manager's HOME");
  assert.equal(unitDataDir(read(['--data-dir', 'rel/d'], '', { manager })), '/home/a/rel/d');
  assert.equal(unitDataDir(read(['--data-dir', 'rel/d'], 'HOME=/srv/t', { manager })), '/srv/t/rel/d', "the unit's own HOME");
  assert.equal(unitDataDir(read([], 'HOME=/srv/t', { manager })), '/srv/t/.tsm');
  assert.equal(systemctlUnit(execStart(['--data-dir', '${HOME}/x']), '', { manager, unset: 'HOME' }), undefined, 'a ${HOME} the unit takes away is unknown, not this shim\'s home');
  // launchd: a job's own HOME is the one its launcher starts in.
  const launchd = launchctlUnit(launchctlPrint({ argv: ['--data-dir', 'rel/d'], env: { HOME: '/srv/l' } }));
  assert.ok(launchd);
  assert.equal(unitDataDir(launchd), '/srv/l/rel/d');
});
