import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

test("TSM_NODE_BIN's directory comes first on the sessions' PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-launch-'));
  try {
    const node = path.join(home, 'custom/bin/node');
    fakeNode(node);
    const daemon = path.join(home, 'daemon.js');
    fs.writeFileSync(daemon, '');
    const r = launch({ HOME: home, TSM_DAEMON: daemon, TSM_NODE_BIN: node });
    assert.equal(r.node, node);
    assert.equal(r.path.split(':')[0], path.join(home, 'custom/bin'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
