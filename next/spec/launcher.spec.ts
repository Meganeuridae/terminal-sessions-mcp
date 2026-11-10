import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { loginShell, unrunnableHelper } from '../src/core/launch.js';

const LAUNCHER = path.resolve(import.meta.dirname, '../../config/termd-launch.sh');

/** A stand-in node that prints which one it is and the PATH it was given, and answers --version. */
function fakeNode(file: string, version = 'v24.22.2'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "node=$0"\necho "PATH=$PATH"\n`, { mode: 0o755 });
}

function launch(env: Record<string, string>): { node: string; path: string } {
  const out = execFileSync('/bin/sh', [LAUNCHER], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  return { node: /^node=(.*)$/m.exec(out)![1]!, path: /^PATH=(.*)$/m.exec(out)![1]! };
}

test("the launcher takes nvm's default version, not the one `current` was last pointed at", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-launch-'));
  try {
    const nvm = path.join(home, '.nvm');
    fakeNode(path.join(nvm, 'versions/node/v22.12.0/bin/node'), 'v22.12.0');
    fakeNode(path.join(nvm, 'versions/node/v24.22.2/bin/node'), 'v24.22.2');
    fs.mkdirSync(path.join(nvm, 'alias'));
    fs.writeFileSync(path.join(nvm, 'alias/default'), '24\n');
    fs.symlinkSync(path.join(nvm, 'versions/node/v22.12.0'), path.join(nvm, 'current'));
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

test("the launcher refuses a node outside the package's engines range, naming it and the range", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-launch-'));
  try {
    const daemon = path.join(home, 'daemon.js');
    fs.writeFileSync(daemon, '');
    const engines = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { engines: { node: string } }).engines.node;
    for (const [version, runs] of [['v12.22.12', false], ['v22.11.0', false], ['v22.12.0-rc.1', false], ['v22.12.0', true], ['v24.22.2', true], ['v24.0.0-nightly20250101', false], ['v25.0.0', false]] as const) {
      const node = path.join(home, version, 'bin/node');
      fakeNode(node, version);
      const r = spawnSync('/bin/sh', [LAUNCHER], { env: { PATH: '/usr/bin:/bin', HOME: home, TSM_DAEMON: daemon, TSM_NODE_BIN: node }, encoding: 'utf8' });
      if (runs) assert.equal(r.status, 0, `${version}: ${r.stderr}`);
      else {
        assert.equal(r.status, 127, version);
        assert.ok(r.stderr.includes(`${node} is Node ${version}, and termd runs on Node ${engines};`), `${version}: ${r.stderr}`);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the daemon takes the first shell that is executable: the passwd entry\'s, then $SHELL, then /bin/sh', () => {
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

// node-pty keeps the native module it loaded in require's cache, from which unrunnableHelper takes it. Each fixture
// holds a copy of that module, loaded the way node-pty's loader does: the first directory whose require succeeds.
const req = createRequire(import.meta.url);
const ptyAddon = (): string => {
  const ptyDir = path.dirname(req.resolve('node-pty/package.json'));
  req('node-pty');
  const loaded = Object.keys(req.cache).find((f) => f.startsWith(ptyDir + path.sep) && path.basename(f) === 'pty.node');
  assert.ok(loaded, "node-pty's native module is in require's cache once node-pty has loaded");
  return loaded;
};
const ptyFixture = (dirs: Record<string, { addon: string; helper?: number }>): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pty-')));
  for (const [d, { addon, helper }] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    if (fs.existsSync(addon)) fs.copyFileSync(addon, path.join(dir, d, 'pty.node'));
    else fs.writeFileSync(path.join(dir, d, 'pty.node'), addon);
    if (helper !== undefined) {
      fs.writeFileSync(path.join(dir, d, 'spawn-helper'), '');
      fs.chmodSync(path.join(dir, d, 'spawn-helper'), helper);
    }
  }
  for (const d of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    try {
      req(path.join(dir, d, 'pty.node'));
      break;
    } catch {}
  }
  return dir;
};
const dropFixture = (dir: string): void => {
  for (const f of Object.keys(req.cache)) if (f.startsWith(dir + path.sep)) delete req.cache[f];
  fs.rmSync(dir, { recursive: true, force: true });
};

test("on macOS, the spawn-helper named is the one beside the native module node-pty loaded, not beside the first one present", () => {
  const prebuilds = `prebuilds/darwin-${process.arch}`;
  const dir = ptyFixture({ 'build/Release': { addon: 'not a native module', helper: 0o755 }, [prebuilds]: { addon: ptyAddon(), helper: 0o644 } });
  try {
    const helper = path.join(dir, prebuilds, 'spawn-helper');
    assert.equal(unrunnableHelper(dir, 'darwin'), helper);
    assert.equal(unrunnableHelper(dir, 'linux'), undefined);
    fs.chmodSync(helper, 0o755);
    assert.equal(unrunnableHelper(dir, 'darwin'), undefined);
  } finally {
    dropFixture(dir);
  }
});

test('on macOS, a spawn-helper that is missing is not named, since chmod cannot fix it', () => {
  const prebuilds = `prebuilds/darwin-${process.arch}`;
  const dir = ptyFixture({ [prebuilds]: { addon: ptyAddon() } });
  try {
    assert.ok(req.cache[path.join(dir, prebuilds, 'pty.node')], "the fixture's native module loaded, so the helper beside it is what's checked");
    assert.equal(unrunnableHelper(dir, 'darwin'), undefined);
  } finally {
    dropFixture(dir);
  }
});
