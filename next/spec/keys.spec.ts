/** Named keys for `send`'s `keys` (G8, §11.1): the vocabulary and the cursor-key mode. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeKey, inputBytes, NAMED_KEYS } from '../src/core/keys.js';

test('G8: 1.x\'s key names (its table, C-a to C-z and M-<char>) still decode to the same bytes in normal cursor mode', () => {
  const legacy = createRequire(import.meta.url)('../../../dist/src/server/keys.js') as { NAMED_KEYS: Record<string, string>; decodeKey(name: string): string };
  const names = [
    ...Object.keys(legacy.NAMED_KEYS),
    ...'abcdefghijklmnopqrstuvwxyz'.split('').flatMap((c) => [`C-${c}`, `C-${c.toUpperCase()}`]),
    ...' !"#$%&\'()*+,-./0123456789:;<=>?@[\\]^_`{|}~abcxyzABCXYZ'.split('').map((c) => `M-${c}`),
  ];
  for (const name of names) assert.equal(decodeKey(name), legacy.decodeKey(name), name);
});

test('emu-16: control chords beyond the letters, Insert, S-Tab and the tmux aliases', () => {
  const cases: Record<string, string> = {
    'C-\\': '\x1c', 'C-]': '\x1d', 'C-@': '\x00', 'C-Space': '\x00', 'C- ': '\x00', 'C-_': '\x1f', 'C-/': '\x1f',
    'C-^': '\x1e', 'C-[': '\x1b', 'C-?': '\x7f', Insert: '\x1b[2~', IC: '\x1b[2~', DC: '\x1b[3~', 'S-Tab': '\x1b[Z',
    BTab: '\x1b[Z', BSpace: '\x7f', NPage: '\x1b[6~', PPage: '\x1b[5~', PgUp: '\x1b[5~', PgDn: '\x1b[6~', Return: '\r',
    'C-M-a': '\x1b\x01', 'M-C-]': '\x1b\x1d', 'M-Enter': '\x1b\r', 'M-Space': '\x1b ', 'M-Tab': '\x1b\t', 'M--': '\x1b-',
  };
  for (const [name, bytes] of Object.entries(cases)) assert.equal(decodeKey(name), bytes, name);
});

test('modified cursor, editing and function keys use the xterm CSI modifier encoding', () => {
  const cases: Record<string, string> = {
    'C-Left': '\x1b[1;5D', 'S-Up': '\x1b[1;2A', 'M-Right': '\x1b[1;3C', 'C-S-Down': '\x1b[1;6B', 'C-M-S-Home': '\x1b[1;8H',
    'S-End': '\x1b[1;2F', 'C-Delete': '\x1b[3;5~', 'S-Insert': '\x1b[2;2~', 'M-PageDown': '\x1b[6;3~', 'C-F1': '\x1b[1;5P',
    'S-F5': '\x1b[15;2~', 'C-S-F12': '\x1b[24;6~',
  };
  for (const [name, bytes] of Object.entries(cases)) assert.equal(decodeKey(name), bytes, name);
  // A modifier is never mistaken for the application-mode form.
  assert.equal(decodeKey('C-Up', { appCursor: true }), '\x1b[1;5A');
});

test('emu-7: application cursor mode (DECCKM) sends SS3 arrows, Home and End; other keys are unchanged', () => {
  const app = { appCursor: true };
  assert.equal(inputBytes(undefined, ['Up', 'Down', 'Right', 'Left', 'Home', 'End'], app), '\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF');
  assert.equal(inputBytes(undefined, ['Up', 'Home'], { appCursor: false }), '\x1b[A\x1b[H');
  assert.equal(inputBytes(undefined, ['Up', 'Home']), '\x1b[A\x1b[H');
  for (const k of ['Enter', 'Tab', 'PageUp', 'Delete', 'Insert', 'F1', 'F5', 'C-c', 'M-x', 'S-Tab']) assert.equal(decodeKey(k, app), decodeKey(k), k);
});

test('§11.1: inputBytes is exactly text then keys, nothing appended', () => {
  assert.equal(inputBytes('ls', ['Enter']), 'ls\r');
  assert.equal(inputBytes('abc', undefined), 'abc');
  assert.equal(inputBytes(undefined, undefined), '');
});

test('unknown keys are rejected before anything is written, and the error names the vocabulary', () => {
  for (const bad of ['Hyper', 'C-1', 'C-Enter', 'S-x', 'C-Tab', 'c-', 'F13', 'S-Backspace']) {
    assert.throws(() => decodeKey(bad), (e: Error) => e.message.includes(`Unknown key '${bad}'`) && e.message.includes('C-\\') && e.message.includes('S-Tab'), bad);
  }
  assert.throws(() => inputBytes('typed', ['Enter', 'Nope']), /Unknown key 'Nope'/);
  assert.ok(Object.keys(NAMED_KEYS).includes('insert'));
});

test('a property of Object.prototype is no key: the lookups see own names only', () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Constructor']) {
    assert.throws(() => decodeKey(bad), (e: Error & { code?: string }) => e.code === 'invalid_argument' && e.message.includes(`Unknown key '${bad}'`), bad);
    assert.throws(() => inputBytes(undefined, [bad]), /Unknown key/, bad);
  }
  // Neither as a modifier word nor as the key under one.
  assert.throws(() => decodeKey('constructor-c'), /Unknown key 'constructor-c'/);
  assert.throws(() => decodeKey('C-constructor'), /Unknown key 'C-constructor'/);
  assert.throws(() => decodeKey('C-valueOf'), /Unknown key/);
});

test('ux-22: common spellings of keys and chords decode like the canonical names', () => {
  const same: Record<string, string> = {
    'Ctrl-C': 'C-c', 'Ctrl+C': 'C-c', 'ctrl-c': 'C-c', 'CTRL+c': 'C-c', '^C': 'C-c', '^c': 'C-c', 'Control-D': 'C-d', 'Ctl-z': 'C-z',
    '^[': 'Esc', '^?': 'C-?', '^@': 'C-@', '^\\': 'C-\\',
    Escape: 'Esc', Return: 'Enter', BS: 'Backspace', Del: 'Delete', Ins: 'Insert', PgUp: 'PageUp', PgDown: 'PageDown', PgDn: 'PageDown',
    'Page Down': 'PageDown', page_up: 'PageUp', 'Page-Up': 'PageUp', ArrowUp: 'Up', ArrowLeft: 'Left', 'Shift+Tab': 'S-Tab', BackTab: 'S-Tab',
    'Alt-x': 'M-x', 'Meta-x': 'M-x', 'Option-b': 'M-b', 'Alt+Enter': 'M-Enter', 'Ctrl+Alt+a': 'C-M-a',
    'Ctrl+Shift+Up': 'C-S-Up', 'Shift-Up': 'S-Up', 'Ctrl-Left': 'C-Left', 'Ctrl-Del': 'C-Delete', 'C-Page-Down': 'C-PageDown', 'Alt-PgUp': 'M-PageUp',
  };
  for (const [spelled, name] of Object.entries(same)) assert.equal(decodeKey(spelled), decodeKey(name), `${spelled} = ${name}`);
  // A chord is never read as a run-together name: C-r is reverse search, not a carriage return.
  assert.equal(decodeKey('C-r'), '\x12');
  // A single character is sent as itself (q to leave a pager).
  assert.equal(inputBytes(undefined, ['q']), 'q');
  assert.equal(decodeKey('é'), 'é');
  // Aliases follow the cursor-key mode like the names they stand for.
  assert.equal(decodeKey('ArrowUp', { appCursor: true }), '\x1bOA');
});

test('ux-22: an unknown key is invalid_argument (never internal), naming close matches', () => {
  const refused = (name: string, hint?: RegExp) =>
    assert.throws(
      () => inputBytes('typed', ['Enter', name]),
      (e: Error & { code?: string }) => e.code === 'invalid_argument' && e.message.includes(`Unknown key '${name}'`) && (hint === undefined || hint.test(e.message)),
      name,
    );
  refused('Entr', /Did you mean 'Enter'\?/);
  refused('PageDwn', /Did you mean 'PageDown'\?/);
  refused('Ctlr-C', /Did you mean 'C-C'\?/);
  refused('C-Enter', /no encoding for C-Enter; send 'Enter' alone/);
  refused('Ctrl-Shift-C', /use 'C-c'/);
  refused('S-x', /type 'X' as text/);
  refused('M-S-x', /use 'M-X'/);
  refused('ls -la', /Literal characters go in `text`/);
  refused('Hyper');
});

test('a key name far longer than any key costs no more than reading it a few hundred times, not a comparison with each key', () => {
  const ms = (f: () => void): number => {
    const start = process.cpuUsage();
    f();
    const { user, system } = process.cpuUsage(start);
    return (user + system) / 1000;
  };
  const least = (f: () => void): number => Math.min(...[0, 1, 2].map(() => ms(f)));
  const READS = 60;
  for (const name of ['x'.repeat(2_000_000), `${'x'.repeat(2_000_000)}-a`]) {
    const reads = least(() => {
      for (let i = 0; i < READS; i++) name.toLowerCase().replace(/[\s_-]/g, '');
    });
    const refused = least(() => assert.throws(() => inputBytes(undefined, [name], { appCursor: false })));
    assert.ok(refused < (reads / READS) * 292, `${name.length} characters: refused in ${refused.toFixed(2)} ms, ${READS} reads in ${reads.toFixed(2)} ms`);
  }
});
