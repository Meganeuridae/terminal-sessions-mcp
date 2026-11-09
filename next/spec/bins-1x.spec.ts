/**
 * session-cli is CommonJS and requires strip-ansi 7, an ES module. The engines range starts at the Node
 * versions whose require() loads one. This test needs the 1.x build (`npm test` or `npm run build` makes
 * it; CI runs `npm test` first), and says so when it's absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// next/dist/spec → the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { bin } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };
const cli = join(root, bin['session-cli']!);

test('session-cli help prints the usage and exits 0, so its ES-module dependency loads on this Node', { skip: existsSync(cli) ? false : `the 1.x build is absent (${bin['session-cli']}): run npm run build` }, async () => {
  // `help` is its help command: `--help` is read as a command name and starts a connection.
  const { code, stdout, stderr } = await new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, 'help'], { timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^Usage: session-cli <command> \[options\]/, stdout);
  assert.match(stdout, /Commands:/);
});
