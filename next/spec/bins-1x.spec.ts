/**
 * A compiled 1.x bin runs on this Node. session-cli is CommonJS and requires strip-ansi 7, an ES module,
 * which is why the engines range starts at the Node versions whose require() loads one; the 1.x suite's
 * bins test reads only the shebangs, so nothing ran a bin (the house's read of the 38 commits, #22
 * comment 6274806357). The test lives here, beside 2.0's, because 2.0 makes no change of its own to the
 * 1.x tree (`src/`, `cli/`, `gui/`, `test/`, `tsconfig.json`): those paths are main's as of the last
 * merge of main, and the next merge keeps main's side (the house's read of the 33 commits, #22, comment
 * 6307351806: they were 1.7.1's while main had moved to 1.7.2). It needs
 * the 1.x build (`npm test` or `npm run build` makes it; CI runs `npm test` first) and says so when absent.
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
