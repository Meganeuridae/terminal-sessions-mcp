/**
 * Named-key decoding for sendInput (tmux send-keys style).
 *
 * Raw control characters cannot pass through the MCP JSON tool layer, so
 * special keys are expressed as names and decoded to their terminal byte
 * sequences here.
 */

export const NAMED_KEYS: Record<string, string> = {
  'enter': '\r',
  'tab': '\t',
  'shift-tab': '\x1b[Z',
  'esc': '\x1b',
  'escape': '\x1b',
  'space': ' ',
  'backspace': '\x7f',
  'delete': '\x1b[3~',
  'up': '\x1b[A',
  'down': '\x1b[B',
  'right': '\x1b[C',
  'left': '\x1b[D',
  'home': '\x1b[H',
  'end': '\x1b[F',
  'pageup': '\x1b[5~',
  'pagedown': '\x1b[6~',
  'f1': '\x1bOP', 'f2': '\x1bOQ', 'f3': '\x1bOR', 'f4': '\x1bOS',
  'f5': '\x1b[15~', 'f6': '\x1b[17~', 'f7': '\x1b[18~', 'f8': '\x1b[19~',
  'f9': '\x1b[20~', 'f10': '\x1b[21~', 'f11': '\x1b[23~', 'f12': '\x1b[24~',
};

/**
 * Decode a single key name to its byte sequence.
 * Supports NAMED_KEYS (case-insensitive), C-a..C-z (Ctrl+letter),
 * and M-<char> (Alt/Meta, case-sensitive char).
 * @throws on unknown key names, listing the valid vocabulary.
 */
export function decodeKey(name: string): string {
  const k = name.toLowerCase();
  const named = NAMED_KEYS[k];
  if (named !== undefined) return named;
  const ctrl = /^c-([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  const meta = /^m-(.)$/i.exec(name);
  if (meta) return `\x1b${meta[1]}`;
  throw new Error(
    `Unknown key '${name}'. Valid: ${Object.keys(NAMED_KEYS).join(', ')}, C-a..C-z, M-<char>`
  );
}

/**
 * Build the byte string a sendInput call writes to the PTY. (sendInput adds
 * ^U and Enter after a lone ^C that gives up a body the shell is partway
 * through reading; see CLEAR_HELD_LINE in the session server.)
 *
 * - `input` is passed through verbatim, followed by decoded `keys`.
 * - Enter (\r — what a real Enter key sends; correct for canonical-mode
 *   shells and raw-mode TUIs alike) is appended by default when no keys
 *   are given. When `keys` are given the caller controls the bytes, so
 *   Enter is only appended if `appendNewline` is explicitly true.
 */
export function buildInputData(input: string, appendNewline?: boolean, keys?: string[]): string {
  const hasKeys = !!(keys && keys.length > 0);
  let data = input;
  if (hasKeys) {
    data += keys!.map(decodeKey).join('');
  }
  const shouldAppend = hasKeys ? appendNewline === true : appendNewline !== false;
  if (shouldAppend) data += '\r';
  return data;
}
