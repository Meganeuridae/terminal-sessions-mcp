/**
 * Every shell text the daemon generates parses in the shell it is for: the integration
 * scripts (bash, zsh, fish), the private launcher, the process launcher, and the lines typed
 * for a declared shell. The real-shell specs exercise only the paths they run; nothing checked
 * the whole text, and zsh's went unexercised where zsh was absent (the house's review of #11).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { processLaunch, shellLaunch } from '../src/core/launch.js';
import { markerStartLine } from '../src/core/plumbing.js';
import { inlineLines } from '../src/core/session.js';
import { prepareIntegration } from '../src/shell/integration.js';
import { hasShell } from './fake-shell.js';

const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(hasShell);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-syntax-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Run a shell's syntax check; the shell's own complaint is the assertion message. */
function parses(shell: string, args: string[], what: string): void {
  try {
    execFileSync(shell, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000 });
  } catch (e) {
    assert.fail(`${what} does not parse in ${shell}: ${(e as { stderr?: string }).stderr ?? (e as Error).message}`);
  }
}

test('the bash integration and the private launcher parse', { skip: !hasShell('/bin/bash') }, () => {
  const i = prepareIntegration('/bin/bash', { dir: path.join(tmp, 'bash') });
  try {
    parses('/bin/bash', ['-n', path.join(tmp, 'bash', 'bash-rc.sh')], 'bash-rc.sh');
    parses('/bin/sh', ['-n', i.launcher!], 'launch.sh');
  } finally {
    i.cleanup();
  }
});

test('the zsh integration files parse', { skip: !hasShell('/bin/zsh') }, () => {
  const i = prepareIntegration('/bin/zsh', { dir: path.join(tmp, 'zsh') });
  try {
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) parses('/bin/zsh', ['-n', path.join(tmp, 'zsh', f)], f);
  } finally {
    i.cleanup();
  }
});

test('the fish integration parses', { skip: !FISH }, () => {
  const i = prepareIntegration(FISH!, { dir: path.join(tmp, 'fish') });
  try {
    parses(FISH!, ['--no-execute', path.join(tmp, 'fish', 'fish', 'vendor_conf.d', 'tsm-integration.fish')], 'tsm-integration.fish');
  } finally {
    i.cleanup();
  }
});

test('the process launcher and the lines typed for a declared shell parse in sh, bash, zsh and fish', () => {
  for (const keeps of [true, false]) parses('/bin/bash', ['-n', '-c', processLaunch(keeps)], `the process launcher (${keeps ? 'with' : 'without'} descriptor 3)`);
  // The text that starts a shell without an integration launcher runs under bash or, without one, /bin/sh.
  for (const sh of ['/bin/bash', '/bin/sh']) parses(sh, ['-n', '-c', shellLaunch(200)], `the shell launcher under ${sh}`);
  const bodies = [`printf '%s\\n' "it's" 'quoted' \\\\back %d; (exit 3)`, `f() {\n${Array.from({ length: 80 }, (_, i) => `  echo line-${i}-${'x'.repeat(40)}`).join('\n')}\n}\nf | wc -l`];
  for (const body of bodies) {
    const posix = inlineLines(body, 'abcd1234', false).join('\n');
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(hasShell)) parses(shell, ['-n', '-c', posix], `inline lines (${body.length} chars)`);
    if (FISH) {
      const file = path.join(tmp, `inline-${body.length}.fish`);
      fs.writeFileSync(file, inlineLines(body, 'abcd1234', true).join('\n') + '\n');
      parses(FISH, ['--no-execute', file], `fish inline lines (${body.length} chars)`);
    }
  }
});

test('the first line of a marker Run’s command file parses in sh, dash, bash and zsh, and fish’s in fish', () => {
  // The start mark the command file prints (the house's answer 2 on the 33 commits, #22, comment 6307351985).
  for (const shell of ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh'].filter(hasShell)) parses(shell, ['-n', '-c', markerStartLine('abcd1234', shell.endsWith('zsh') ? 'zsh' : 'posix')], 'the start line');
  if (FISH) {
    const file = path.join(tmp, 'start-line.fish');
    fs.writeFileSync(file, `${markerStartLine('abcd1234', 'fish')}\n`);
    parses(FISH, ['--no-execute', file], 'fish’s start line');
  }
});
