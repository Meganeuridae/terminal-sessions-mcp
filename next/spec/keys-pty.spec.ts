/**
 * emu-7 against a real curses program: ncurses keypad() sends smkx (`CSI ? 1 h`,
 * DECCKM), after which xterm-256color's terminfo expects SS3 arrows. The screen
 * observes the mode, and the named keys follow it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { inputBytes } from '../src/core/keys.js';
import { Screen } from '../src/core/screen.js';
import { until } from './testhost.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-keys-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A python3 on PATH whose curses module loads, or undefined. */
function pythonWithCurses(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, 'python3');
    if (!fs.existsSync(p)) continue;
    if (spawnSync(p, ['-c', 'import curses'], { stdio: 'ignore' }).status === 0) return p;
  }
  return undefined;
}
const python = pythonWithCurses();

// Reads keys until 'q' and writes their curses names; READY once keypad mode is on.
const READER = `
import curses, sys
def main(w):
    w.keypad(True)
    w.addstr(0, 0, "READY")
    w.refresh()
    names = []
    while True:
        c = w.getch()
        if c == ord('q'):
            break
        names.append(curses.keyname(c).decode())
    open(sys.argv[1], 'w').write(' '.join(names))
curses.wrapper(main)
`;

/** Run the reader in a real PTY, feed its output to a Screen, send `keys`, return what curses read. */
async function readKeys(keys: string[], useMode: boolean): Promise<{ read: string; appCursor: boolean }> {
  const script = path.join(tmp, 'reader.py');
  const out = path.join(tmp, `read-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(script, READER);
  const p = pty.spawn(python!, [script, out], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: tmp,
    env: { ...process.env, TERM: 'xterm-256color', ESCDELAY: '25' } as Record<string, string>,
  });
  const screen = new Screen({ cols: 80, rows: 24 });
  let seq = 0;
  p.onData((d) => void screen.write(d, ++seq));
  screen.onReply((r) => p.write(r)); // G25: the screen answers the program's queries
  const exited = new Promise<void>((r) => p.onExit(() => r()));
  try {
    await until(() => screen.snapshot().lines.some((l) => l.includes('READY')), 15_000, 'the curses program to be ready');
    await screen.settled();
    const appCursor = screen.applicationCursorKeys;
    p.write(inputBytes(undefined, keys, { appCursor: useMode && appCursor }));
    // A pause before `q`, so a lone ESC in the keys is resolved by ESCDELAY and not joined with the q
    // as Alt-q. Its length is a floor, not a verdict: a slower machine only makes it longer.
    await new Promise((r) => setTimeout(r, 150));
    p.write('q');
    // The verdict waits for the program to exit and write its file; a loaded runner gets time.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    await until(() => fs.existsSync(out), 2000).catch(() => undefined);
    return { read: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '(no output)', appCursor };
  } finally {
    try {
      p.kill();
    } catch {
      // already gone
    }
    screen.dispose();
  }
}

test('emu-7: a curses program in keypad mode reads Up/Down/Left/Right/Home/End as keys (real PTY)', { skip: python ? false : 'python3 with curses not found' }, async () => {
  const r = await readKeys(['Up', 'Down', 'Left', 'Right', 'Home', 'End'], true);
  assert.equal(r.appCursor, true, 'the screen observed DECCKM from keypad()');
  assert.equal(r.read, 'KEY_UP KEY_DOWN KEY_LEFT KEY_RIGHT KEY_HOME KEY_END');
});

test('emu-7 control: the normal-mode forms are not keys to that program (what the mode fixes)', { skip: python ? false : 'python3 with curses not found' }, async () => {
  const r = await readKeys(['Up'], false);
  assert.equal(r.appCursor, true);
  assert.notEqual(r.read, 'KEY_UP', `curses read: ${r.read}`);
  assert.ok(r.read.includes('^['), `a bare Escape reached the program: ${r.read}`);
});
