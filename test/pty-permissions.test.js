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
