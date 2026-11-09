import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loginShell } from '../src/core/launch.js';

const LAUNCHER = path.resolve(import.meta.dirname, '../../config/termd-launch.sh');

/** A stand-in node that prints which one it is and the PATH it was given. */
function fakeNode(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\necho "node=$0"\necho "PATH=$PATH"\n', { mode: 0o755 });
}

function launch(env: Record<string, string>): { node: string; path: string } {
  const out = execFileSync('/bin/sh', [LAUNCHER], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  return { node: /^node=(.*)$/m.exec(out)![1]!, path: /^PATH=(.*)$/m.exec(out)![1]! };
}

test("the launcher takes nvm's default version, not the one `current` was last pointed at", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-launch-'));
  try {
    const nvm = path.join(home, '.nvm');
    fakeNode(path.join(nvm, 'versions/node/v20.19.0/bin/node'));
    fakeNode(path.join(nvm, 'versions/node/v24.22.2/bin/node'));
    fs.mkdirSync(path.join(nvm, 'alias'));
    fs.writeFileSync(path.join(nvm, 'alias/default'), '24\n');
    fs.symlinkSync(path.join(nvm, 'versions/node/v20.19.0'), path.join(nvm, 'current'));
    const daemon = path.join(home, 'daemon.js');
    fs.writeFileSync(daemon, '');
    assert.equal(launch({ HOME: home, TSM_DAEMON: daemon }).node, path.join(nvm, 'versions/node/v24.22.2/bin/node'));
    fs.rmSync(path.join(nvm, 'alias/default'));
    assert.equal(launch({ HOME: home, TSM_DAEMON: daemon }).node, path.join(nvm, 'current/bin/node'), 'with no default, current');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("TSM_NODE_BIN's directory comes first on the daemon's PATH, moved there when PATH already holds it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-launch-'));
  try {
    const node = path.join(home, 'custom/bin/node');
    fakeNode(node);
    const daemon = path.join(home, 'daemon.js');
    fs.writeFileSync(daemon, '');
    const r = launch({ HOME: home, TSM_DAEMON: daemon, TSM_NODE_BIN: node });
    assert.equal(r.node, node);
    assert.equal(r.path.split(':')[0], path.join(home, 'custom/bin'));
    const later = launch({ HOME: home, TSM_DAEMON: daemon, TSM_NODE_BIN: node, PATH: `/usr/bin:/bin:${path.join(home, 'custom/bin')}` });
    assert.deepEqual(later.path.split(':').filter((d) => d === path.join(home, 'custom/bin') || d === '/usr/bin'), [path.join(home, 'custom/bin'), '/usr/bin'], 'moved ahead of /usr/bin, and only once');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the daemon takes the first shell that can run: the passwd entry\'s, then $SHELL, then /bin/sh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-shell-'));
  try {
    const usable = path.join(dir, 'zsh');
    fs.writeFileSync(usable, '#!/bin/sh\n', { mode: 0o755 });
    const plain = path.join(dir, 'fish');
    fs.writeFileSync(plain, '', { mode: 0o644 });
    const nologin = path.join(dir, 'nologin');
    fs.writeFileSync(nologin, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(loginShell([usable, '/bin/sh']), usable);
    assert.equal(loginShell([path.join(dir, 'missing'), usable]), usable, 'missing');
    assert.equal(loginShell([plain, usable]), usable, 'not executable');
    assert.equal(loginShell([nologin, usable]), usable, 'nologin');
    assert.equal(loginShell([dir, usable]), usable, 'a directory');
    assert.equal(loginShell([undefined, '', 'zsh', usable]), usable, 'unset, empty or relative');
    assert.equal(loginShell([nologin, path.join(dir, 'missing')]), '/bin/sh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a version manager's directory already on PATH is moved ahead of the system's, so its node is the one found", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-launch-'));
  try {
    const sys = path.join(home, 'sys/bin');
    fakeNode(path.join(sys, 'node'));
    const volta = path.join(home, '.volta/bin');
    fakeNode(path.join(volta, 'node'));
    const daemon = path.join(home, 'daemon.js');
    fs.writeFileSync(daemon, '');
    const r = launch({ HOME: home, TSM_DAEMON: daemon, PATH: `${sys}:/usr/bin:/bin:${volta}` });
    assert.equal(r.node, path.join(volta, 'node'));
    assert.equal(r.path.split(':').filter((d) => d === volta).length, 1, 'on PATH once');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
