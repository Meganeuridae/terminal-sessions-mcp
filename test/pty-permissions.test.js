const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('postinstall makes executable every spawn-helper node-pty can load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pty-'));
  try {
    const helpers = ['build/Release/spawn-helper', 'build/Debug/spawn-helper', 'prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper'];
    for (const f of helpers) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
      fs.chmodSync(path.join(dir, f), 0o644);
    }
    fs.mkdirSync(path.join(dir, 'prebuilds', 'win32-x64'), { recursive: true });
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pty-permissions.js'), dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.strictEqual(out, '');
    for (const f of helpers) assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o755, f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postinstall warns when it cannot read the prebuilds, and the install goes on', { skip: process.getuid?.() === 0 ? 'root reads a directory whatever its mode' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm pty's-"));
  const prebuilds = path.join(dir, 'prebuilds');
  try {
    fs.mkdirSync(path.join(prebuilds, 'darwin-arm64'), { recursive: true });
    fs.chmodSync(prebuilds, 0o000);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pty-permissions.js'), dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stderr.includes(`couldn't read ${prebuilds} (EACCES)`), r.stderr);
    assert.ok(r.stderr.includes(`chmod +x '${prebuilds.replace(/'/g, "'\\''")}'/*/spawn-helper`), r.stderr);
  } finally {
    fs.chmodSync(prebuilds, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postinstall warns with a chmod that works as printed when it cannot change a helper', { skip: process.getuid?.() === 0 ? 'root changes a file whatever its directory allows' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm pty's-"));
  const arch = path.join(dir, 'prebuilds', 'darwin-arm64');
  const helper = path.join(arch, 'spawn-helper');
  try {
    fs.mkdirSync(arch, { recursive: true });
    fs.writeFileSync(helper, '');
    fs.chmodSync(arch, 0o600);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pty-permissions.js'), dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stderr.includes(`chmod +x '${helper.replace(/'/g, "'\\''")}'`), r.stderr);
  } finally {
    fs.chmodSync(arch, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// node-pty keeps the native module it loaded in require's cache, from which unrunnableHelper takes it. Each fixture
// holds a copy of that module, loaded the way node-pty's loader does: the first directory whose require succeeds.
const ptyAddon = () => {
  require('../dist/src/server/session-server-v3.js');
  const ptyDir = path.dirname(require.resolve('node-pty/package.json'));
  const loaded = Object.keys(require.cache).find((f) => f.startsWith(ptyDir + path.sep) && path.basename(f) === 'pty.node');
  assert.ok(loaded, "node-pty's native module is in require's cache once node-pty has loaded");
  return loaded;
};
const ptyFixture = (dirs) => {
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
      require(path.join(dir, d, 'pty.node'));
      break;
    } catch {}
  }
  return dir;
};
const dropFixture = (dir) => {
  for (const f of Object.keys(require.cache)) if (f.startsWith(dir + path.sep)) delete require.cache[f];
  fs.rmSync(dir, { recursive: true, force: true });
};

test("1.x names, on macOS, the spawn-helper beside the native module node-pty loaded, not beside the first one present", () => {
  const { unrunnableHelper } = require('../dist/src/server/session-server-v3.js');
  const prebuilds = `prebuilds/darwin-${process.arch}`;
  const dir = ptyFixture({ 'build/Release': { addon: 'not a native module', helper: 0o755 }, [prebuilds]: { addon: ptyAddon(), helper: 0o644 } });
  try {
    const helper = path.join(dir, prebuilds, 'spawn-helper');
    assert.strictEqual(unrunnableHelper(dir, 'darwin'), helper);
    assert.strictEqual(unrunnableHelper(dir, 'linux'), undefined);
    fs.chmodSync(helper, 0o755);
    assert.strictEqual(unrunnableHelper(dir, 'darwin'), undefined);
  } finally {
    dropFixture(dir);
  }
});

test('1.x names no spawn-helper that is missing, since chmod cannot fix it', () => {
  const { unrunnableHelper } = require('../dist/src/server/session-server-v3.js');
  const dir = ptyFixture({ [`prebuilds/darwin-${process.arch}`]: { addon: ptyAddon() } });
  try {
    assert.strictEqual(unrunnableHelper(dir, 'darwin'), undefined);
  } finally {
    dropFixture(dir);
  }
});

test('postinstall ends well when writing its warning fails, so the install goes on', { skip: process.getuid?.() === 0 ? 'root reads a directory whatever its mode' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-pty-'));
  const failing = path.join(dir, 'failing-stderr.js');
  fs.writeFileSync(failing, "process.stderr.write = function () { const e = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); process.nextTick(() => this.emit('error', e)); return false; };\n");
  try {
    fs.mkdirSync(path.join(dir, 'prebuilds', 'darwin-arm64'), { recursive: true });
    fs.chmodSync(path.join(dir, 'prebuilds'), 0o000);
    const r = spawnSync(process.execPath, ['-r', failing, path.join(__dirname, '..', 'scripts', 'pty-permissions.js'), dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  } finally {
    fs.chmodSync(path.join(dir, 'prebuilds'), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
