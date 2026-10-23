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
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { askDataDir, connectionOf, procAddress, titlePort } from '../src/shim/running.js';
import { launchctlUnit, nextStart, plistUnit, procEnviron, sameDir, systemctlUnit, TERMD_BOOLEAN_FLAGS, unitArg, unitDataDir, unitPort, type UnitText } from '../src/shim/units.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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
  // A flag that takes no value has none: the word after it is an argument of its own, so `--headless ${X}` may hold an
  // option. Read as --headless's value, it passed unflagged (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715).
  for (const flag of ['--headless', '--no-usage-log']) {
    const after = read(['--port', '3101', '--data-dir', '/srv/unit', flag, '${X}']);
    assert.deepEqual(unitPort(after), loose, flag);
    assert.deepEqual(unitDataDir(after), loose, flag);
  }
  assert.equal(unitPort(read(['--headless', '--port', '3101', '--data-dir', '/srv/unit'])), '3101', 'a flag that takes no value, then a literal option');
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
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once('exit', r));
  assert.deepEqual(procEnviron(child.pid!), { error: 'it has gone', alive: false }, 'a process that has gone');
});

test("another user's process is not read for its environment: pid 1, whose /proc entry is root's", { skip: (process.platform !== 'linux' && 'Linux shows a process environment in /proc') || (process.getuid?.() === 0 && 'as root, pid 1 is this user\'s') }, () => {
  assert.deepEqual(procEnviron(1), { error: "it is another user's process", alive: false });
});

test("termd's flags that take no value are the shim's: read from daemon.ts's FLAGS, which a spec must not import (it starts a daemon)", () => {
  const source = fs.readFileSync(path.resolve(here, '../../src/daemon.ts'), 'utf8');
  const flags = /const FLAGS = \{([\s\S]*?)\n\} as const;/.exec(source)?.[1];
  assert.ok(flags, "daemon.ts's FLAGS table");
  const booleans = [...flags.matchAll(/^\s*'?([\w-]+)'?: \{ type: 'boolean'/gm)].map((m) => `--${m[1]}`);
  assert.deepEqual([...TERMD_BOOLEAN_FLAGS].sort(), booleans.sort());
});

test("this user's live termd whose environment cannot be read is alive and unreadable, not gone: its real uid, not its /proc entry's owner, says whose it is (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715)", { skip: process.platform !== 'linux' && 'Linux shows a process environment in /proc' }, async (t) => {
  // A process that is not dumpable has root's /proc entries and an environ only root reads, though it is this user's.
  const child = spawn('python3', ['-c', 'import ctypes,sys,time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print("ready", flush=True); time.sleep(30)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const ready = await new Promise<boolean>((resolve) => {
      child.stdout!.once('data', () => resolve(true));
      child.once('error', () => resolve(false));
      child.once('exit', () => resolve(false));
    });
    if (!ready) return t.skip('no python3 to make a process that is not dumpable');
    if (process.getuid?.() === 0) return t.skip('root reads every environ');
    assert.deepEqual(procEnviron(child.pid!), { error: 'EACCES', alive: true });
  } finally {
    child.kill();
  }
});

test("a running termd is asked for its data dir on the port its title names, and only the pid asked about counts as its answer (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question 1)", async () => {
  // /health as termd answers it, from a stand-in whose answer the test sets; the connection taken for the pid's.
  const proven = { prove: async () => undefined };
  let answer: Record<string, unknown> = {};
  /** Set, the status and body sent instead of `answer`. */
  let raw: { status: number; body: string } | undefined;
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(raw?.status ?? (req.url === '/health' ? 200 : 404), { 'content-type': 'application/json' });
    res.end(raw?.body ?? JSON.stringify(answer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    answer = { status: 'ok', pid: 4242, dataDir: '/srv/running' };
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, ...proven }), { dataDir: '/srv/running' });
    assert.deepEqual(await askDataDir(port, 4343, { timeoutMs: 1500, ...proven }), { error: `port ${port} answers as pid 4242, not as it` }, 'another process on the port');
    answer = { status: 'ok', pid: 4242, detail: 'present a token (?token= or Authorization: Bearer) for sessions' };
    assert.match(JSON.stringify(await askDataDir(port, 4242, { timeoutMs: 1500, ...proven })), /its \/health names no data dir: no credential was presented/);
    // The shim's credential goes on a proven connection, and nothing at all on one that is not.
    assert.equal(seen.pop(), undefined);
    answer = { status: 'ok', pid: 4242, dataDir: '/srv/running' };
    await askDataDir(port, 4242, { timeoutMs: 1500, token: 'shim-token', ...proven });
    assert.equal(seen.pop(), 'Bearer shim-token');
    const before = seen.length;
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, token: 'shim-token', prove: async () => 'not shown' }), { error: 'not shown' });
    assert.equal(seen.length, before, 'an unproven listener is sent no request, so no credential');
    // What isn't termd's answer is refused, each for its own reason (the house's read of the 17 commits over our fixes, #22).
    raw = { status: 503, body: JSON.stringify({ status: 'ok', pid: 4242, dataDir: '/srv/running' }) };
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, ...proven }), { error: 'its /health answered 503' });
    raw = { status: 200, body: '<html>not termd</html>' };
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, ...proven }), { error: 'its /health answer is not JSON' });
    raw = { status: 200, body: '42' };
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, ...proven }), { error: 'its /health answer is not an object' });
    raw = undefined;
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, ...proven }), { error: `nothing listens on port ${port}` });
  // Linux shows a process's title in its cmdline, as termd sets it; only a systemd unit's termd is asked, so only Linux's /proc is read.
  if (process.platform === 'linux') {
    const child = spawn(process.execPath, ['-e', "process.title = 'termd --port 4321'; console.log('ready'); setTimeout(() => {}, 30_000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((r) => child.stdout!.once('data', r));
      assert.equal(titlePort(child.pid!), 4321);
    } finally {
      child.kill();
    }
  }
  assert.match(JSON.stringify(titlePort(process.pid)), process.platform === 'linux' ? /its title is not a termd's with a port/ : /its title cannot be read/);
});

test("the ask has one deadline for the whole exchange and reads at most 1 MiB, however the answer trickles in (a reviewer's read of the fixes for #22)", async () => {
  // A listener that wrote a byte every 200 ms held a 300 ms ask for 10 s: the socket's timeout fired only when it was idle.
  const body = JSON.stringify({ status: 'ok', pid: 4242, dataDir: '/elsewhere' });
  const timers = new Set<NodeJS.Timeout>();
  /** The requests the trickle listener got, and the body's bytes it wrote. */
  let asked = 0;
  let wrote = 0;
  const trickle = http.createServer((req, res) => {
    asked++;
    res.writeHead(200, { 'content-type': 'application/json' });
    let i = 0;
    const t = setInterval(() => (i < body.length ? (res.write(body[i++]!), wrote++) : (clearInterval(t), res.end())), 200);
    timers.add(t);
    req.on('close', () => clearInterval(t));
  });
  const flood = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('"' + 'x'.repeat(2 << 20) + '"');
  });
  await Promise.all([trickle, flood].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  const portOf = (s: http.Server) => (s.address() as { port: number }).port;
  try {
    const t0 = performance.now();
    assert.deepEqual(await askDataDir(portOf(trickle), 4242, { timeoutMs: 300, prove: async () => undefined }), { error: 'it did not answer /health within 300 ms' });
    const took = performance.now() - t0;
    assert.ok(took < 1500, `the 300 ms ask took ${took.toFixed(0)} ms`);
    // A trickle it was: the request arrived and a byte went out before the deadline, so a timeout that only an idle
    // socket fires would have been put off (the house's read of the 17 commits over our fixes, #22).
    assert.equal(asked, 1, 'the listener got the request');
    assert.ok(wrote >= 1, `a byte went out before the deadline (${wrote})`);
    assert.deepEqual(await askDataDir(portOf(flood), 4242, { timeoutMs: 5000, prove: async () => undefined }), { error: 'its /health answer is over 1048576 bytes' });
  } finally {
    for (const t of timers) clearInterval(t);
    trickle.closeAllConnections();
    flood.closeAllConnections();
    await Promise.all([trickle, flood].map((s) => new Promise((r) => s.close(r))));
  }
});

/** `p`, or `otherwise` if it hasn't settled within `ms`, with the timer cleared either way. */
async function within<T, U>(p: Promise<T>, ms: number, otherwise: U): Promise<T | U> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<U>((r) => (timer = setTimeout(() => r(otherwise), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

test("the ask's one deadline covers the proof too: a proof still running at the deadline ends the ask, and no request follows it (the house's read of the 17 commits over our fixes, #22)", async () => {
  let asked = 0;
  const server = http.createServer((_req, res) => {
    asked++;
    res.end(JSON.stringify({ status: 'ok', pid: 4242, dataDir: '/srv/running' }));
  });
  // The listener's side of the ask's one connection closing.
  const closed = new Promise<'closed'>((r) => server.once('connection', (c: net.Socket) => c.once('close', () => r('closed'))));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // A proof that shows the socket as the pid's only when the test releases it, once the ask has given up: the ask must
    // end at its deadline while the proof is still running. Judged by a 900 ms wall-clock bound and a fixed sleep, a
    // loaded host could fail a correct deadline, and a late proof's request could land after the check (the house's read
    // of the 14 commits over our fixes, #22).
    const proof: { entered: boolean; release?: () => void } = { entered: false };
    const slow = () => {
      proof.entered = true;
      return new Promise<undefined>((r) => (proof.release = () => r(undefined)));
    };
    const ask = askDataDir(port, 4242, { timeoutMs: 300, prove: slow });
    // Generous: only a deadline that waits for the proof leaves the ask pending this long.
    assert.deepEqual(await within(ask, 10_000, 'pending'), { error: 'it did not answer /health within 300 ms' }, 'the ask ended while its proof ran');
    // The ask destroyed its connection at the deadline. Once the listener's side has closed, nothing the proof does after
    // can reach it, which a count of requests taken a turn after the release could not show: the listener reads a request
    // only on a later I/O turn (Abigail-2459's read).
    assert.equal(await within(closed, 10_000, 'open'), 'closed', 'the ask closed its connection at the deadline');
    assert.ok(proof.entered && proof.release, 'the proof was entered');
    proof.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(asked, 0, 'nothing reached the listener before its connection closed');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("a listener on 127.0.0.1 not shown to be termd's is passed over for ::1 within the same deadline, and is sent nothing (the house's review of a8b6f28..4860d4c, #22 comment 6341260318, question 5)", async (t) => {
  // Stopped at the first address whose listener was not shown to be termd's, the ask never reached a termd on ::1.
  const asked: string[] = [];
  const answer = (dataDir: string) => (req: http.IncomingMessage, res: http.ServerResponse) => {
    asked.push(`${dataDir} ${req.headers.authorization ?? '-'}`);
    res.end(JSON.stringify({ status: 'ok', pid: 4242, dataDir }));
  };
  const v6 = http.createServer(answer('/v6'));
  const bound = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(0, '::1', () => resolve(true));
  });
  if (!bound) return t.skip('no ::1 here');
  const port = (v6.address() as { port: number }).port;
  const v4 = http.createServer(answer('/v4'));
  await new Promise<void>((r) => v4.listen(port, '127.0.0.1', r));
  // The proof says no for the IPv4 connection and yes for the IPv6 one, as for an impostor on 127.0.0.1 beside termd on ::1.
  const prove = async (socket: net.Socket) => (socket.remoteFamily === 'IPv4' ? 'the socket that answered is not its' : undefined);
  try {
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 3000, token: 'shim-token', prove }), { dataDir: '/v6' });
    assert.deepEqual(asked, ['/v6 Bearer shim-token'], 'nothing went to 127.0.0.1, the credential to ::1 alone');
    // With nothing on ::1, the reason said is the unproven listener's, not that nothing listens.
    v6.closeAllConnections();
    await new Promise((r) => v6.close(r));
    assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 3000, token: 'shim-token', prove }), { error: 'the socket that answered is not its' });
    assert.equal(asked.length, 1);
  } finally {
    v6.closeAllConnections();
    v4.closeAllConnections();
    await Promise.all([v6, v4].map((s) => new Promise((r) => s.close(() => r(undefined)))));
  }
});

test("one deadline covers both addresses: what 127.0.0.1's proof took is gone for ::1 (the house's read of the 14 commits over our fixes, #22)", async (t) => {
  // The fallback tests' proofs answered at once, so a fresh deadline per address passed them too.
  const asked: string[] = [];
  const answer = (dataDir: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    asked.push(dataDir);
    res.end(JSON.stringify({ status: 'ok', pid: 4242, dataDir }));
  };
  const v6 = http.createServer(answer('/v6'));
  const bound = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(0, '::1', () => resolve(true));
  });
  if (!bound) return t.skip('no ::1 here');
  const port = (v6.address() as { port: number }).port;
  const v4 = http.createServer(answer('/v4'));
  await new Promise<void>((r) => v4.listen(port, '127.0.0.1', r));
  // Each proof takes 250 ms: 127.0.0.1's says no, and ::1's would say yes, but past a 400 ms deadline for both.
  const prove = (socket: net.Socket) => new Promise<string | undefined>((r) => setTimeout(() => r(socket.remoteFamily === 'IPv4' ? 'the socket that answered is not its' : undefined), 250));
  try {
    // The ask fails, with the deadline's reason, or 127.0.0.1's if a stalled loop ran its proof's timer first; what a
    // deadline per address would change is that ::1 is asked and answers (Abigail-2459's read).
    const r = await askDataDir(port, 4242, { timeoutMs: 400, prove });
    assert.ok('error' in r, `the ask failed (it said ${JSON.stringify(r)})`);
    assert.deepEqual(asked, [], 'no address was asked');
  } finally {
    v6.closeAllConnections();
    v4.closeAllConnections();
    await Promise.all([v6, v4].map((s) => new Promise((r) => s.close(() => r(undefined)))));
  }
});

for (const when of ['as it is made', 'while it is proved'] as const) {
  test(`a listener on 127.0.0.1 that resets the connection ${when} is passed over for ::1 too (the house's read of the 14 commits over our fixes, #22)`, async (t) => {
    // Read as termd's own failure, the reset ended the ask, and the termd on ::1 was never asked.
    const asked: string[] = [];
    const v6 = http.createServer((req, res) => {
      asked.push(req.headers.authorization ?? '-');
      res.end(JSON.stringify({ status: 'ok', pid: 4242, dataDir: '/v6' }));
    });
    const bound = await new Promise<boolean>((resolve) => {
      v6.once('error', () => resolve(false));
      v6.listen(0, '::1', () => resolve(true));
    });
    if (!bound) return t.skip('no ::1 here');
    const port = (v6.address() as { port: number }).port;
    // Reset as accepted (on Linux, in the house's runs, the connect itself failed), or held and reset once the proof is
    // running, so that case is met on every host rather than only as a host's timing falls.
    const held: net.Socket[] = [];
    const resets = net.createServer((c) => {
      held.push(c);
      c.on('error', () => {});
      if (when === 'as it is made') c.resetAndDestroy();
    });
    const accepted = new Promise<net.Socket>((r) => resets.once('connection', r));
    await new Promise<void>((r) => resets.listen(port, '127.0.0.1', r));
    // Only a socket that reads as connected over IPv6 is shown as termd's, at once. Any other waits past the deadline, so
    // only the reset can end it: a reset socket's other end can read as unknown, and the real proof never shows such a
    // socket as anyone's (connectionOf). Passed for not reading as IPv4, a socket reset before its family was read was
    // shown, and the request went into the reset: `write EPIPE`, not unproven (macOS 24, the fork's run 39896549112).
    const prove = (socket: net.Socket) => {
      if (socket.remoteFamily === 'IPv6') return Promise.resolve(undefined);
      if (when === 'while it is proved') void accepted.then((c) => c.resetAndDestroy());
      return new Promise<string | undefined>((r) => {
        setTimeout(() => r(undefined), 2000).unref();
        // A host that reports the reset as a close with no error: the real proof shows no closed connection either. Where
        // the reset is an error, as on Linux, that comes first and decides (Abigail-2459's read).
        socket.once('close', () => r('the connection closed while it was proved'));
      });
    };
    try {
      assert.deepEqual(await askDataDir(port, 4242, { timeoutMs: 1500, prove }), { dataDir: '/v6' });
      assert.deepEqual(asked, ['-'], 'termd on ::1 was asked');
    } finally {
      v6.closeAllConnections();
      for (const c of held) c.destroy();
      await Promise.all([v6, resets].map((s) => new Promise((r) => s.close(() => r(undefined)))));
    }
  });
}

test("a termd on ::1 alone is asked there once 127.0.0.1 refuses, and an IPv6 listener dialled on 127.0.0.1 is shown as its own through tcp6 (the house's read of the 17 commits over our fixes, #22)", async (t) => {
  const answer = (dataDir: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => res.end(JSON.stringify({ status: 'ok', pid: process.pid, dataDir }));
  const v6 = http.createServer(answer('/v6'));
  const bound = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(0, '::1', () => resolve(true));
  });
  if (!bound) return t.skip('no ::1 here');
  try {
    const port = (v6.address() as { port: number }).port;
    assert.deepEqual(await askDataDir(port, process.pid, { timeoutMs: 3000, prove: async () => undefined }), { dataDir: '/v6' }, 'nothing on 127.0.0.1, so ::1');
    if (process.platform === 'linux') assert.deepEqual(await askDataDir(port, process.pid, { timeoutMs: 3000 }), { dataDir: '/v6' }, "and its socket on ::1 is shown as this process's");
  } finally {
    v6.closeAllConnections();
    await new Promise((r) => v6.close(r));
  }
  if (process.platform !== 'linux') return;
  // An IPv4 connection to an IPv6 socket (here one bound to 127.0.0.1's mapped address, so nothing listens beyond
  // loopback): its server side is in tcp6, as ::ffff:127.0.0.1.
  const dual = http.createServer(answer('/dual'));
  const dualBound = await new Promise<boolean>((resolve) => {
    dual.once('error', () => resolve(false));
    dual.listen(0, '::ffff:127.0.0.1', () => resolve(true));
  });
  if (!dualBound) return t.skip('no IPv6 socket on ::ffff:127.0.0.1 here');
  try {
    const port = (dual.address() as { port: number }).port;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port });
      c.once('connect', () => resolve(c));
      c.once('error', reject);
    });
    try {
      assert.equal(socket.remoteFamily, 'IPv4');
      assert.equal(await connectionOf(socket, process.pid), undefined, "the IPv6 listener's side of an IPv4 connection is this process's");
    } finally {
      socket.destroy();
    }
    assert.deepEqual(await askDataDir(port, process.pid, { timeoutMs: 3000 }), { dataDir: '/dual' });
  } finally {
    dual.closeAllConnections();
    await new Promise((r) => dual.close(r));
  }
});

test("a connection the listener has yet to accept is looked up again until it is, and then shown as the listener's (the house's read of the 17 commits over our fixes, #22)", { skip: process.platform !== 'linux' && 'Linux shows whose a socket is' }, async (t) => {
  // A listener that accepts only when told to on its stdin: until then the connection's server side shows no inode.
  const late = spawn('python3', ['-c', "import socket, sys, time\ns = socket.socket()\ns.bind(('127.0.0.1', 0))\ns.listen(4)\nprint(s.getsockname()[1], flush=True)\nsys.stdin.readline()\nc, _ = s.accept()\ntime.sleep(30)"], { stdio: ['pipe', 'pipe', 'ignore'] });
  late.stdin!.on('error', () => {}); // gone already: the test fails on its own terms
  try {
    const port = await new Promise<number | undefined>((resolve) => {
      late.stdout!.once('data', (b: Buffer) => resolve(Number(b.toString().trim()) || undefined));
      late.once('error', () => resolve(undefined));
      late.once('exit', () => resolve(undefined));
    });
    if (port === undefined) return t.skip('no python3 to listen without accepting');
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port });
      c.once('connect', () => resolve(c));
      c.once('error', reject);
    });
    // The lookups, as /proc/net/tcp reads through node's fs: the stand-in is told to accept only once one has been made,
    // so the lookup is seen to run while the connection is unaccepted, with no sleep for a loaded host to stretch past
    // its second (the house's read of the 14 commits over our fixes, #22).
    let reads = 0;
    const read = fsModule.readFileSync;
    t.mock.method(fsModule, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (file === '/proc/net/tcp') reads++;
      return (read as (f: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(file, options);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try {
      const shown = connectionOf(socket, late.pid!);
      const before = reads;
      assert.ok(before >= 1, 'looked up while the connection is not yet accepted');
      late.stdin!.write('accept\n');
      assert.equal(await shown, undefined, 'shown once accepted');
      assert.ok(reads > before, `looked up again after the accept (${before} reads before it, ${reads} in all)`);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      socket.destroy();
    }
  } finally {
    late.kill();
  }
});

/** How long an impostor helper (a node process) may take to start listening on a loaded host before its test fails. */
const IMPOSTOR_START_MS = 20_000;

test("a read of /proc/net/tcp torn by sockets changing under it lists the connection's other end twice, or leaves it out: rows with one inode are one socket, a row left out is looked up again, and only two distinct inodes are refused (our fork's run of e8b55ad on Ubuntu)", { skip: process.platform !== 'linux' && 'Linux shows whose a socket is' }, async () => {
  // This process's own listener and a connection to it. The tables reach the lookup through its reader, each from a
  // real read of the file with the connection's row edited: the kernel hands the table out in page-sized pieces and,
  // once a piece has reached the table's end, counts its way back to its place from the top, so sockets added meanwhile
  // make the table's last rows come twice (seen on Ubuntu 24.04 under loopback churn: a third of the reads).
  const server = net.createServer(() => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port });
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
  try {
    assert.equal(await connectionOf(socket, process.pid), undefined, "listed once, it is shown as this process's");
    const serverSide = procAddress('127.0.0.1', port, false)!;
    const fields = (line: string) => line.trim().split(/\s+/);
    const withInode = (line: string, inode: string) => {
      const f = fields(line);
      f[9] = inode;
      return f.join(' ');
    };
    const tables = (edit: (line: string) => string[]) => (table: string) => {
      const text = fs.readFileSync(table, 'utf8');
      return table === '/proc/net/tcp' ? text.split('\n').flatMap((line) => (fields(line)[1] === serverSide ? edit(line) : [line])).join('\n') : text;
    };
    assert.equal(await connectionOf(socket, process.pid, { read: tables((line) => [line, line]) }), undefined, 'listed twice with one inode, it is one socket');
    // Before termd accepts, the row has no inode; a torn read can give the row before and after the accept.
    assert.equal(await connectionOf(socket, process.pid, { read: tables((line) => [withInode(line, '0'), line]) }), undefined, 'the row with an inode is the socket');
    // A row the tear left out is looked up again: the first read of the table lacks it, the next has it.
    let reads = 0;
    const leftOutOnce = (table: string) => tables((line) => (table === '/proc/net/tcp' && reads++ === 0 ? [] : [line]))(table);
    assert.equal(await connectionOf(socket, process.pid, { read: leftOutOnce }), undefined, 'found on a later read');
    assert.ok(reads >= 2, `the table was read again (${reads} reads)`);
    // Two rows with distinct inodes cannot be one socket, and which of them answered cannot be told.
    const another = (line: string) => withInode(line, String(Number(fields(line)[9]) + 1));
    assert.equal(await connectionOf(socket, process.pid, { read: tables((line) => [line, another(line)]) }), `more than one socket is the other end of this connection on port ${port}`);
  } finally {
    socket.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("an answer counts only from the termd's own socket: a listener of another process that echoes its pid is not asked, and is sent no credential (a reviewer's read of the fixes for #22)", async () => {
  if (process.platform !== 'linux') {
    // Whose a socket is cannot be shown here, so no answer is taken.
    const socket = new (await import('node:net')).Socket();
    assert.equal(await connectionOf(socket, process.pid), 'this system does not show whose a socket is');
    return;
  }
  // termd's pid is public: an impostor on its port, beside a termd on ::1, can claim it.
  const impostor = spawn(process.execPath, ['-e', `const http = require('node:http'); const s = http.createServer((req, res) => { process.stdout.write('asked ' + (req.headers.authorization || '-') + '\\n'); res.end(JSON.stringify({ status: 'ok', pid: ${process.pid}, dataDir: '/impostor' })); }); s.listen(0, '127.0.0.1', () => process.stdout.write('port ' + s.address().port + '\\n'));`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  impostor.stdout!.on('data', (b: Buffer) => (out += b.toString()));
  try {
    // Its start is awaited by its own line or its exit, and one that doesn't start fails the test: a skip let a slow
    // host drop the assertions below (the house's read of the 17 commits over our fixes, #22).
    const deadline = performance.now() + IMPOSTOR_START_MS;
    while (!/port \d+/.test(out) && impostor.exitCode === null && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const port = Number(/port (\d+)/.exec(out)?.[1]);
    assert.ok(port, `the impostor started (exit ${impostor.exitCode}, said ${JSON.stringify(out)})`);
    assert.deepEqual(await askDataDir(port, process.pid, { timeoutMs: 3000, token: 'shim-token' }), { error: `the socket that answered on port ${port} is not its` });
    assert.doesNotMatch(out, /asked/, 'no request reached it, so no credential');
    // The same ask of a listener this process owns is answered.
    const own = http.createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', pid: process.pid, dataDir: '/own' })));
    await new Promise<void>((r) => own.listen(0, '127.0.0.1', r));
    try {
      assert.deepEqual(await askDataDir((own.address() as { port: number }).port, process.pid, { timeoutMs: 3000 }), { dataDir: '/own' });
    } finally {
      own.closeAllConnections();
      await new Promise((r) => own.close(r));
    }
  } finally {
    impostor.kill();
  }
});

test("the other end of a connection is found by both its addresses whole, so a connection from the same port number to a termd on ::1 does not make an impostor's socket on 127.0.0.1 read as termd's (a reviewer's run of the fixes for #22)", async (t) => {
  // As /proc/net/tcp and tcp6 write them on a little-endian host: each 32-bit word of the address as the host reads it.
  if (os.endianness() === 'LE') {
    assert.equal(procAddress('127.0.0.1', 3101, false), '0100007F:0C1D');
    assert.equal(procAddress('::1', 3101, true), '00000000000000000000000001000000:0C1D');
    assert.equal(procAddress('::ffff:127.0.0.1', 80, true), '0000000000000000FFFF00000100007F:0050');
  }
  assert.equal(procAddress('not an address', 1, true), undefined);
  if (process.platform !== 'linux') return;
  // termd on ::1 only (this process), an impostor on 127.0.0.1 at the same port, claiming termd's pid.
  const credentials: Array<string | undefined> = [];
  const termd = http.createServer((req, res) => {
    credentials.push(req.headers.authorization);
    res.end(JSON.stringify({ status: 'ok', pid: process.pid, dataDir: '/real' }));
  });
  const bound = await new Promise<boolean>((resolve) => {
    termd.once('error', () => resolve(false));
    termd.listen(0, '::1', () => resolve(true));
  });
  if (!bound) return t.skip('no ::1 here');
  const port = (termd.address() as { port: number }).port;
  const impostor = spawn(process.execPath, ['-e', `const http = require('node:http'); const s = http.createServer((req, res) => { process.stdout.write('asked ' + (req.headers.authorization || '-') + '\\n'); res.end(JSON.stringify({ status: 'ok', pid: ${process.pid}, dataDir: '/impostor' })); }); s.listen(${port}, '127.0.0.1', () => process.stdout.write('listening\\n'));`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  impostor.stdout!.on('data', (b: Buffer) => (out += b.toString()));
  const sockets: net.Socket[] = [];
  try {
    const deadline = performance.now() + IMPOSTOR_START_MS;
    while (!out.includes('listening') && impostor.exitCode === null && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(out.includes('listening'), `the impostor started (exit ${impostor.exitCode}, said ${JSON.stringify(out)})`);
    const connect = (o: net.NetConnectOpts) =>
      new Promise<net.Socket>((resolve, reject) => {
        const c = net.connect(o);
        sockets.push(c);
        c.once('connect', () => resolve(c));
        c.once('error', reject);
      });
    const toImpostor = await connect({ host: '127.0.0.1', port });
    // A second connection, to termd on ::1, from the same port number as the one to the impostor.
    const toTermd = await connect({ host: '::1', port, localAddress: '::1', localPort: toImpostor.localPort! });
    assert.equal(await connectionOf(toImpostor, process.pid), `the socket that answered on port ${port} is not its`, 'the impostor stays an impostor');
    assert.equal(await connectionOf(toTermd, process.pid), undefined, "termd's own connection on ::1 is its");
    // The ask meets the impostor on 127.0.0.1 first: it is sent no request, so no credential, and the ask goes on
    // to termd on ::1, which tells it. Stopped at the impostor, it read the unit's text instead (the house's review of
    // a8b6f28..4860d4c, #22 comment 6341260318, question 5).
    assert.deepEqual(await askDataDir(port, process.pid, { timeoutMs: 3000, token: 'shim-token' }), { dataDir: '/real' });
    assert.doesNotMatch(out, /asked/);
    assert.deepEqual(credentials, ['Bearer shim-token'], 'the credential went to termd alone');
  } finally {
    for (const c of sockets) c.destroy();
    impostor.kill();
    termd.closeAllConnections();
    await new Promise((r) => termd.close(r));
  }
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

test("a running unit's text that names another port or data dir than its running termd's has changed, though systemd and the files say nothing: its next start is compared too (a reviewer's read of the fixes for #22)", () => {
  // Read only when a daemon-reload was pending or a file was newer than termd's start, the text was never compared here.
  const running = { port: '4100', dataDir: '/srv/run' };
  const read = (argv: string[], manager = 'HOME=/home/a') => {
    const u = systemctlUnit(execStart(argv), '', { manager });
    assert.ok(u, 'the ExecStart is read');
    return u;
  };
  // A drop-in that moved termd to port 4100, removed and then reloaded: the text names the unit's own port again,
  // and no file is newer than termd's start (a file copied with its times kept, or a package's install, reads the same).
  assert.deepEqual(nextStart(running, read(['--port', '3101', '--data-dir', '/srv/run']), ''), {
    why: "it names port 3101, which differs from its running termd's port 4100",
    certain: true,
    port: '3101',
    dataDir: '/srv/run',
  });
  // A data dir imported into the user manager since termd started (set-environment, import-environment): no file changed.
  assert.deepEqual(nextStart(running, read(['--port', '4100'], 'HOME=/home/a TSM_DATA_DIR=/srv/imported'), ''), {
    why: "it names the data dir /srv/imported, which differs from its running termd's /srv/run",
    certain: true,
    port: '4100',
    dataDir: '/srv/imported',
  });
  // The text naming what runs says nothing, and neither does one that cannot tell its values or cannot be read.
  assert.equal(nextStart(running, read(['--port', '4100', '--data-dir', '/srv/run']), ''), undefined);
  const filed = systemctlUnit(execStart([]), '', { manager: 'HOME=/home/a', files: ['/etc/termd.env (ignore_errors=no)'] });
  assert.ok(filed);
  assert.equal(nextStart(running, filed, ''), undefined);
  assert.equal(nextStart(running, { why: 'systemctl did not answer' }, ''), undefined);
  // Where systemd or the files say the text may have changed, that reason stands, the text naming what runs or not.
  assert.deepEqual(nextStart(running, read(['--port', '4100', '--data-dir', '/srv/run']), 'systemd says the unit needs a daemon-reload'), { why: 'systemd says the unit needs a daemon-reload', certain: false, port: '4100', dataDir: '/srv/run' });
  assert.deepEqual(nextStart(running, { why: 'systemctl did not answer' }, 'systemd says the unit needs a daemon-reload'), {
    why: 'systemd says the unit needs a daemon-reload',
    certain: false,
    port: { unknown: 'could not be read (systemctl did not answer)' },
    dataDir: { unknown: 'could not be read (systemctl did not answer)' },
  });
});

test('sameDir compares a directory not made yet by where it would be made, through a symlinked parent (the house\'s read of 4860d4c..bc4bc85, #22)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-samedir-'));
  try {
    fs.mkdirSync(path.join(tmp, 'real'));
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    assert.ok(sameDir(path.join(tmp, 'link'), path.join(tmp, 'real')), 'existing: one directory');
    assert.ok(sameDir(path.join(tmp, 'link', 'data', 'x'), path.join(tmp, 'real', 'data', 'x')), 'not made yet, under the link and under its target: one directory');
    assert.ok(!sameDir(path.join(tmp, 'link', 'data'), path.join(tmp, 'real', 'other')), 'not made yet and named apart: two');
    assert.ok(sameDir('relative-not-made', path.resolve('relative-not-made')), 'a relative path, by where it resolves');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
