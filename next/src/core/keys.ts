/**
 * Named keys for `input` (tmux send-keys style), carried over from 1.6 and
 * extended (G8: input is sent exactly as given; §11.1).
 *
 * Grammar, case-insensitive except for the character after `M-`:
 *   - a name from NAMED_KEYS (`Enter`, `Up`, `F5`, `PageDown`, tmux aliases such
 *     as `BSpace`, `BTab`, `DC`, `IC`, `NPage`, `PPage`), or a common spelling of
 *     one (KEY_ALIASES: `Return`, `BS`, `Del`, `Ins`, `PgDown`, `ArrowUp`,
 *     `Page Down`, `page_up`);
 *   - a single character, sent as itself (`q` to leave a pager);
 *   - `C-<c>` for a control character: `C-a`..`C-z`, `C-@` / `C-Space` (NUL),
 *     `C-[` (ESC), `C-\` (FS: SIGQUIT at a tty), `C-]` (GS: telnet/virsh escape),
 *     `C-^` (RS), `C-_` / `C-/` (US: readline undo), `C-?` (DEL); `^C` is the
 *     caret spelling of `C-c`;
 *   - `M-<c>` for ESC followed by the character, and `C-M-<c>` for ESC followed
 *     by the control character;
 *   - `C-`, `M-` and `S-` prefixes on the cursor, editing and function keys
 *     (`C-Left`, `S-Up`, `M-PageDown`, `C-S-F5`), encoded as xterm does
 *     (`CSI 1;<mod> X`, `CSI <n>;<mod> ~`); `S-Tab` is back-tab.
 *   - Modifiers may be spelled out and joined with `-` or `+`: `Ctrl-C`,
 *     `ctrl+c`, `Control-C`, `Alt-x`, `Meta-x`, `Option-x`, `Shift+Tab`,
 *     `Ctrl+Shift+Up`.
 *
 * An unknown name is `invalid_argument` naming close matches (§15), raised before
 * anything is written.
 *
 * The unmodified arrows, Home and End depend on the terminal's cursor-key mode:
 * `CSI A` normally, `SS3 A` once a program has set application cursor keys
 * (DECCKM, `CSI ? 1 h`, which ncurses sends with keypad()). The caller passes the
 * emulator's current mode as `appCursor`; without it a curses program reads
 * `ESC [ A` as Escape, `[`, `A`.
 */

import { err, type TermError } from './errors.js';

/** The normal-mode byte sequence for each named key. */
export const NAMED_KEYS: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  btab: '\x1b[Z',
  esc: '\x1b',
  escape: '\x1b',
  space: ' ',
  backspace: '\x7f',
  bspace: '\x7f',
  insert: '\x1b[2~',
  ic: '\x1b[2~',
  delete: '\x1b[3~',
  dc: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pgup: '\x1b[5~',
  ppage: '\x1b[5~',
  pagedown: '\x1b[6~',
  pgdn: '\x1b[6~',
  npage: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

/** Other spellings of the named keys (lower case, spaces and underscores removed). */
export const KEY_ALIASES: Record<string, string> = {
  bs: 'backspace',
  del: 'delete',
  ins: 'insert',
  pgdown: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  shifttab: 'shift-tab',
  backtab: 'shift-tab',
  spacebar: 'space',
};

/** Modifier words and the prefix each stands for. */
const MODIFIERS: Record<string, 'c' | 'm' | 's'> = { c: 'c', ctrl: 'c', ctl: 'c', control: 'c', m: 'm', meta: 'm', alt: 'm', opt: 'm', option: 'm', s: 's', shift: 's' };

export interface KeyOptions {
  /** The terminal is in application cursor-key mode (DECCKM set). */
  appCursor?: boolean;
}

/** Forms in NAMED_KEYS: cursor keys (`CSI A`; SS3 in application mode) and F1–F4 (`SS3 P`) modify as `CSI 1;<mod> A`, `CSI <n> ~` keys as `CSI <n>;<mod> ~`. */
const CURSOR = /^\x1b\[([A-DFH])$/;
const FINAL = /^\x1b[[O]([A-DFHP-S])$/;
const TILDE = /^\x1b\[(\d+)~$/;

/** Control characters for `C-<c>` beyond the letters. */
const CTRL_PUNCT: Record<string, number> = { '@': 0x00, ' ': 0x00, '[': 0x1b, '\\': 0x1c, ']': 0x1d, '^': 0x1e, '_': 0x1f, '/': 0x1f, '?': 0x7f };

/** Names offered in suggestions, as a caller would write them. */
const SUGGESTABLE = [
  'Enter', 'Tab', 'S-Tab', 'Esc', 'Space', 'Backspace', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

/** Levenshtein distance, for suggesting close names. */
export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Named keys within a small edit distance of `base`, keeping the caller's modifier prefix. */
function closeMatches(prefix: string, base: string): string[] {
  const b = base.toLowerCase().replace(/[\s_-]/g, '');
  if (b.length < 2) return [];
  const limit = Math.max(1, Math.floor(b.length / 3));
  const aliasesOf = (n: string) => Object.entries(KEY_ALIASES).filter(([, v]) => v === n.toLowerCase()).map(([a]) => distance(b, a));
  const scored = SUGGESTABLE.map((n) => ({ n, d: Math.min(distance(b, n.toLowerCase().replace('-', '')), ...aliasesOf(n)) }));
  return scored
    .filter((x) => x.d <= limit)
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map((x) => `${prefix}${x.n}`);
}

/** Why `name` is not a key, and what the caller may have meant. */
function hintFor(name: string, prefix: string, base: string): string {
  if (prefix) {
    // A real key under modifiers a terminal cannot encode (C-Enter, S-x, C-1).
    if ([...base].length === 1) {
      if (prefix.includes('C-') && ctrlChar(base) !== undefined) return ` A terminal sends the same byte with or without Shift: use '${prefix.replace('S-', '')}${base.toLowerCase()}'.`;
      if (prefix.includes('S-')) return ` Shift with a character is its shifted form: type '${base.toUpperCase()}' as text.`;
      return ` A terminal has no control character for '${base}'.`;
    }
    if (canonical(base, true) !== undefined) return ` A terminal has no encoding for ${prefix}${base}; send '${base}' alone.`;
  } else {
    // A misspelled modifier: Ctlr-C, Contrl+x.
    const m = /^([a-z]+)[-+](.+)$/i.exec(name);
    if (m) {
      const word = m[1]!.toLowerCase();
      const mod = Object.keys(MODIFIERS).find((w) => w.length > 2 && distance(word, w) <= (w.length > 5 ? 2 : 1));
      if (mod !== undefined) return ` Did you mean '${MODIFIERS[mod]!.toUpperCase()}-${m[2]}'?`;
    }
  }
  const close = closeMatches(prefix, base);
  if (close.length) return ` Did you mean ${close.map((c) => `'${c}'`).join(' or ')}?`;
  return /\s/.test(name) && !prefix ? ' Literal characters go in `text`.' : '';
}

function unknown(name: string, prefix = '', base = name): TermError {
  const hint = hintFor(name, prefix, base);
  return err(
    'invalid_argument',
    `Unknown key '${name}'.${hint} Valid: ${Object.keys(NAMED_KEYS).join(', ')} (also Return, BS, Del, Ins, PgDown, ArrowUp…); a single character; C-a..C-z (also Ctrl-C, Ctrl+C, ^C), C-@, C-Space, C-[, C-\\, C-], C-^, C-_, C-/, C-?; ` +
      `M-<char> (also Alt-, Meta-), C-M-<char>; C-, M- and S- on Up/Down/Left/Right/Home/End/Insert/Delete/PageUp/PageDown/F1..F12 (e.g. C-Left, Shift+Up); S-Tab`,
    { key: name },
  );
}

/**
 * A named key's canonical name (NAMED_KEYS), through the aliases and spellings
 * like `Page Down`; undefined when it is none. With `hyphens`, `Page-Down` counts
 * too: only once the name is known not to be a modifier chord (`C-r` is never `cr`).
 */
function canonical(name: string, hyphens = false): string | undefined {
  // Own properties only: `constructor` or `__proto__` is no key, whatever Object.prototype holds
  // (the house's read of ed4ecac, #22: `constructor` decoded to the text of a function).
  const k = name.toLowerCase();
  if (Object.hasOwn(NAMED_KEYS, k)) return k;
  let squeezed = k.replace(/[\s_]/g, '');
  if (hyphens) squeezed = squeezed.replace(/-/g, '');
  if (Object.hasOwn(NAMED_KEYS, squeezed)) return squeezed;
  return Object.hasOwn(KEY_ALIASES, squeezed) ? KEY_ALIASES[squeezed] : undefined;
}

/** Split `Ctrl+Shift+Up`, `C-M-a`, `Alt-x` into prefixes (`c`, `m`, `s`) and the base key; undefined when it has no modifier. */
function splitModifiers(name: string): { prefixes: Set<'c' | 'm' | 's'>; base: string; prefix: string } | undefined {
  const prefixes = new Set<'c' | 'm' | 's'>();
  let rest = name;
  for (;;) {
    const m = /^([a-z]+)[-+]/i.exec(rest);
    const word = m?.[1]!.toLowerCase();
    const mod = word !== undefined && Object.hasOwn(MODIFIERS, word) ? MODIFIERS[word] : undefined;
    if (!m || mod === undefined || rest.length === m[0].length) break;
    prefixes.add(mod);
    rest = rest.slice(m[0].length);
  }
  if (prefixes.size === 0) return undefined;
  const prefix = (['c', 'm', 's'] as const).filter((p) => prefixes.has(p)).map((p) => `${p.toUpperCase()}-`).join('');
  return { prefixes, base: rest, prefix };
}

function ctrlChar(ch: string): string | undefined {
  const c = ch.charCodeAt(0);
  if (ch.length === 1 && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return String.fromCharCode(c & 0x1f);
  const p = Object.hasOwn(CTRL_PUNCT, ch) ? CTRL_PUNCT[ch] : undefined;
  return p === undefined ? undefined : String.fromCharCode(p);
}

export function decodeKey(name: string, opts: KeyOptions = {}): string {
  const named = canonical(name);
  if (named !== undefined) {
    const bytes = NAMED_KEYS[named]!;
    return opts.appCursor && CURSOR.test(bytes) ? `\x1bO${bytes[2]}` : bytes;
  }
  // `^C`: the caret spelling of a control character.
  if (name.length === 2 && name[0] === '^') {
    const c = ctrlChar(name[1]!);
    if (c === undefined) throw unknown(name);
    return c;
  }
  // A single character is sent as itself.
  if ([...name].length === 1) return name;
  const m = splitModifiers(name);
  if (!m) {
    const spelled = canonical(name, true);
    if (spelled === undefined) throw unknown(name);
    return decodeKey(spelled, opts);
  }
  const ctrl = m.prefixes.has('c');
  const meta = m.prefixes.has('m');
  const shift = m.prefixes.has('s');
  const base = m.base;
  const esc = meta ? '\x1b' : '';
  const bad = () => unknown(name, m.prefix, base);
  if ([...base].length === 1) {
    // A character: C- makes it a control character, M- prefixes ESC.
    if (shift) throw bad();
    if (!ctrl) return esc + base;
    const c = ctrlChar(base);
    if (c === undefined) throw bad();
    return esc + c;
  }
  const b = canonical(base, true) ?? base.toLowerCase();
  if (b === 'space') {
    if (ctrl) return esc + '\x00';
    return esc + ' ';
  }
  if (b === 'tab') {
    if (ctrl) throw bad();
    return esc + (shift ? '\x1b[Z' : '\t');
  }
  const mod = 1 + (shift ? 1 : 0) + (meta ? 2 : 0) + (ctrl ? 4 : 0);
  const bytes = Object.hasOwn(NAMED_KEYS, b) ? NAMED_KEYS[b]! : '';
  const final = FINAL.exec(bytes)?.[1];
  if (final !== undefined) return `\x1b[1;${mod}${final}`;
  const code = TILDE.exec(bytes)?.[1];
  if (code !== undefined) return `\x1b[${code};${mod}~`;
  // Single-byte keys take only M- (ESC prefix); C-/S- on them have no encoding.
  if (bytes.length === 1 && !ctrl && !shift) return esc + bytes;
  throw bad();
}

/**
 * Exactly `text` followed by exactly `keys`; nothing is appended (DESIGN §11.1).
 * Pass the emulator's cursor-key mode as `opts.appCursor` (Screen.applicationCursorKeys).
 */
export function inputBytes(text: string | undefined, keys: string[] | undefined, opts: KeyOptions = {}): string {
  return (text ?? '') + (keys ?? []).map((k) => decodeKey(k, opts)).join('');
}
