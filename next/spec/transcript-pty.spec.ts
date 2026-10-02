/**
 * The projection over bytes a real shell and real terminfo produce: `clear`
 * (ED 2 + ED 3), `tput smcup`/`rmcup` (the alternate screen) and a line wider
 * than the terminal (emu-5, emu-8), captured through a real PTY.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as pty from 'node-pty';
import { project } from '../src/core/transcript.js';

const has = (p: string) => fs.existsSync(p);

async function capture(shell: string, script: string, cols: number, rows: number): Promise<string[]> {
  const p = pty.spawn(shell, ['-c', script], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  const chunks: string[] = [];
  p.onData((d) => chunks.push(d));
  await new Promise<void>((r) => p.onExit(() => r()));
  await new Promise((r) => setTimeout(r, 50));
  return chunks;
}

for (const shell of ['/bin/bash', '/bin/zsh'].filter(has)) {
  test(`${shell}: emu-8 / emu-5: real clear, a real full-screen visit and a wide line all survive projection`, async () => {
    const script = [
      'echo before-clear',
      'clear',
      'echo after-clear',
      "printf 'W%.0s' $(seq 1 150); echo",
      'tput smcup; tput cup 5 3; echo in-the-frame; sleep 0.1; tput rmcup',
      'echo done',
    ].join('; ');
    const chunks = await capture(shell, script, 80, 24);
    const r = await project(chunks, { cols: 80, rows: 24 });
    assert.equal(r.truncated, false);
    const lines = r.text.split('\n').filter((l) => l !== '');
    assert.deepEqual(lines, ['before-clear', 'after-clear', 'W'.repeat(150), '   in-the-frame', 'done']);
  });
}
