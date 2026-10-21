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
import { launchctlUnit, systemctlUnit, unitArg, unitDataDir, unitPort, type UnitText } from '../src/shim/units.js';

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

const systemd = (argv: string[], environment = ''): UnitText => {
  const u = systemctlUnit(execStart(argv), environment);
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
  assert.equal(unitDataDir(systemd(['--port', '3101', '--data-dir', ''])), undefined);
  assert.equal(unitDataDir(systemd(['--data-dir='])), undefined);
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
