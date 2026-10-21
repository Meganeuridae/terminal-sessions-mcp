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
import { launchctlUnit, plistUnit, systemctlUnit, unitArg, unitDataDir, unitPort, type UnitText } from '../src/shim/units.js';

/** ExecStart as systemd 255 prints it: the argv joined by one space each, unquoted. */
const execStart = (argv: string[]) => `{ path=/bin/sh ; argv[]=${['/bin/sh', '/pkg/next/config/termd-launch.sh', ...argv].join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

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
  // systemd expands ${NAME} from the environment the files are part of, so an argument naming one is unknown, HOME too.
  assert.equal(systemctlUnit(execStart(['--data-dir', '${HOME}/d']), '', { files }), undefined);
  assert.equal(systemctlUnit(execStart(['--data-dir', '${BASE}/d']), 'BASE=/srv', { files }), undefined);
  // No file named: as before.
  assert.equal(unitPort(systemd([], 'TSM_PORT=4200')), '4200');
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
