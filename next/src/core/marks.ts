/**
 * Shell-integration marks (§7): OSC 133 (prompt/command lifecycle) and OSC 633
 * (VS Code's extensions: `E` carries the command line, `P;Cwd=` the cwd, and the
 * daemon's own `P;TsmHello=` announces that the integration is loading).
 *
 * Marks are authenticated. The integration appends the session's key to every mark
 * it emits (`133;D;0;k=<key>`), and a parser constructed with that key turns only
 * keyed 133/633 sequences into marks. Everything else — a second integration in the
 * user's rc (Ghostty, iTerm2, kitty, VS Code), a nested shell or ssh session, a
 * program printing a recorded log — stays ordinary output for the emulator, so it
 * can neither end a Run nor move the cwd (G2, G4, G7). OSC 7 is never a mark: the
 * cwd comes only from the keyed `633;P;Cwd=` (VS Code escaping, no percent-decoding).
 *
 * The parser splits a PTY chunk into pieces so that every mark has an exact journal
 * position: `[output before the OSC][mark][output…]`. The key never reaches observers
 * through this parser (atc-3): a keyed mark's bytes are not output — the mark is journaled as what it means
 * (prompt, cwd, run.start, run.end) — and the key's literal text in output (a `set` or
 * `declare -p` in the shell prints the integration's variables) is replaced with
 * `[redacted]`, so `read as: events`, raw renderings, followers, the GUI and the screen
 * never carry it, and nobody who can observe a session can forge its marks. Unkeyed
 * sequences stay in the output byte for byte. Sequences split across chunks are
 * reassembled; only a tail that can still become one of ours — an OSC, or the start of
 * the key's text — is held back (bounded), so ordinary output is not delayed by it.
 */

export type Mark133 = { osc: 133; code: 'A' | 'B' | 'C' | 'D' | string; exit?: number; params: string[] };
export type Mark633 = {
  osc: 633;
  code: string;
  params: string[];
  /** `E`: the command line, decoded. */
  line?: string;
  /** `P`: the property name (`Cwd`, `TsmHello`) and its decoded value. */
  property?: string;
  value?: string;
};
export type Mark = Mark133 | Mark633;

export type Piece = { kind: 'output'; data: string } | { kind: 'mark'; mark: Mark; raw: string };

/** The env name that carries the session's mark key into the shell (the integration unsets it). */
export const MARK_KEY_ENV = 'TSM_MARK_KEY';

/** What the key's literal text in output is replaced with. */
export const KEY_REDACTED = '[redacted]';

/**
 * Typed before every daemon line while an integration is live (ss-1): two keys no
 * keyboard sends in practice (ctrl-alt-shift-F12, ctrl-alt-shift-F11 in xterm's encoding),
 * which every integration binds to "empty the line editor" in every keymap — bash
 * readline's emacs, vi-insert and vi-command (F12 there enters insert mode first), zsh's
 * emacs, viins and vicmd, fish's default, insert and visual modes. Whatever a human or a
 * typeahead left in the editor, in whatever mode, can then never merge with the line.
 */
export const CLEAR_LINE_KEYS = '\x1b[24;8~\x1b[23;8~';

const ESC = '\x1b';
const BEL = '\x07';
const C1_ST = '\u009c';
/** A held candidate longer than this is released as output (a 633;E of a long pasted command can be large). */
const MAX_PENDING = 64 * 1024;
/** Prefixes a mark's payload starts with; a held tail is released as soon as it cannot be one. */
const IDENTS = ['133;', '633;'];

/** Decode VS Code's OSC value escaping: `\\` → `\`, `\xNN` → byte. */
export function decodeVscodeValue(value: string): string {
  return value.replace(/\\(\\|x[0-9a-fA-F]{2})/g, (_, g: string) =>
    g === '\\' ? '\\' : String.fromCharCode(parseInt(g.slice(1), 16)),
  );
}

/** Encode a value the way the integration scripts do (the inverse of `decodeVscodeValue`). */
export function encodeVscodeValue(value: string): string {
  return value.replace(/[\\;\x00-\x1f]/g, (c) => (c === '\\' ? '\\\\' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
}

/** Could `payload` (the OSC body seen so far) still grow into a mark's payload? */
function couldBeMark(payload: string): boolean {
  return IDENTS.some((id) => (payload.length <= id.length ? id.startsWith(payload) : payload.startsWith(id)));
}

/** Only 133/633 sequences whose last parameter is `k=<key>` (the session's mark key) are marks. */
export class MarksParser {
  private pending = '';
  /** The output so far ended inside a CSI sequence: this is its start (a final byte in the next read is not text). */
  private csiTail = '';

  constructor(private key: string) {}

  /** Trust a different key from now on (a key that leaked to a foreign program is retired, ss-4). */
  rekey(key: string): void {
    this.key = key;
  }

  /** Output with the key's text redacted. */
  private clean(data: string): string {
    return data.includes(this.key) ? data.split(this.key).join(KEY_REDACTED) : data;
  }

  /**
   * How many trailing characters of `data` could be the start of the key's text (held until
   * more arrives). Characters of an escape sequence are never text: a query such as DA1
   * (`ESC [ 0 c`) ending in the key's first character is released at once, since the
   * program that sent it waits for the emulator's answer.
   */
  private keyPrefixTail(data: string): number {
    const seen = this.csiTail + data;
    for (let n = Math.min(this.key.length - 1, data.length); n > 0; n--) {
      if (data.endsWith(this.key.slice(0, n)) && !openEscape(seen.slice(0, seen.length - n))) return n;
    }
    return 0;
  }

  private parseMark(payload: string): Mark | undefined {
    // The key is the last parameter: `133;D;0;k=<key>`, or `133;k=<key>` with no others.
    const m = /^(133|633);(?:(.*);)?k=(.*)$/s.exec(payload);
    return m && m[3] === this.key ? parseParams(m[1]!, m[2] ?? '') : undefined;
  }

  feed(chunk: string): Piece[] {
    const pieces: Piece[] = [];
    const data = this.pending + chunk;
    this.pending = '';
    let out = '';
    let i = 0;
    while (i < data.length) {
      const start = data.indexOf(ESC, i);
      if (start === -1) {
        out += data.slice(i);
        break;
      }
      if (start === data.length - 1) {
        // A lone ESC at the end of a read may be the first byte of a mark (emu-1): hold it.
        out += data.slice(i, start);
        this.pending = ESC;
        break;
      }
      if (data[start + 1] !== ']') {
        out += data.slice(i, start + 1);
        i = start + 1;
        continue;
      }
      // An OSC. Find its terminator: BEL or ESC \ (C1 ST is accepted for non-marks only).
      let end = -1;
      let termLen = 0;
      let broken = false;
      for (let k = start + 2; k < data.length; k++) {
        const c = data[k];
        if (c === BEL) {
          end = k;
          termLen = 1;
          break;
        }
        if (c === ESC) {
          if (k === data.length - 1) break; // ESC at the end of the read: maybe ST split in two
          if (data[k + 1] === '\\') {
            end = k;
            termLen = 2;
          } else broken = true; // an ESC that is not ST: malformed OSC, plain output
          break;
        }
        if (c === C1_ST) {
          end = k;
          termLen = 1;
          break;
        }
      }
      if (end === -1) {
        const tail = data.slice(start);
        if (!broken && tail.length < MAX_PENDING && couldBeMark(data.slice(start + 2).replace(/\x1b$/, ''))) {
          // Possibly one of ours split across reads: hold the tail.
          out += data.slice(i, start);
          this.pending = tail;
          i = data.length;
          break;
        }
        out += data.slice(i, start + 2);
        i = start + 2;
        continue;
      }
      const payload = data.slice(start + 2, end);
      const seqEnd = end + termLen;
      const mark = data[end] === C1_ST ? undefined : this.parseMark(payload);
      // A mark's bytes stay out of the output (atc-3).
      out += data.slice(i, mark ? start : seqEnd);
      i = seqEnd;
      if (!mark) continue;
      if (out) pieces.push({ kind: 'output', data: this.clean(out) });
      out = '';
      pieces.push({ kind: 'mark', mark, raw: data.slice(start, seqEnd) });
    }
    out = this.clean(out);
    if (out && this.pending === '') {
      // The key's text split across reads is held until it can be redacted whole.
      const hold = this.keyPrefixTail(out);
      if (hold > 0) {
        this.pending = out.slice(out.length - hold);
        out = out.slice(0, out.length - hold);
      }
    }
    if (out) pieces.push({ kind: 'output', data: out });
    // (A mark or a held OSC ends any CSI: it cannot continue into the next read.)
    this.csiTail = pieces.length && pieces[pieces.length - 1]!.kind === 'output' && this.pending === '' ? openEscape(this.csiTail + out) : '';
    return pieces;
  }

  /** Emit whatever is held (e.g. at session exit). */
  flush(): Piece[] {
    if (!this.pending) return [];
    const data = this.pending;
    this.pending = '';
    return [{ kind: 'output', data: this.clean(data) }];
  }
}

/**
 * The escape sequence `data` ends inside of, within its last 64 characters: a lone ESC, or a
 * CSI still missing its final byte (the next character belongs to the sequence) — or ''.
 */
const openEscape = (data: string): string => /\x1b(?:\[[\x20-\x3f]*)?$/.exec(data.slice(-64))?.[0] ?? '';

function parseParams(ident: string, rest: string): Mark {
  const params = rest === '' ? [] : rest.split(';');
  const code = params.shift() ?? '';
  if (ident === '133') {
    const mark: Mark133 = { osc: 133, code, params };
    if (code === 'D' && params[0] !== undefined && /^-?\d+$/.test(params[0])) mark.exit = Number(params[0]);
    return mark;
  }
  const mark: Mark633 = { osc: 633, code, params };
  if (code === 'E' && params[0] !== undefined) mark.line = decodeVscodeValue(params[0]);
  if (code === 'P' && params[0] !== undefined) {
    const eq = params[0].indexOf('=');
    mark.property = eq === -1 ? params[0] : params[0].slice(0, eq);
    mark.value = eq === -1 ? '' : decodeVscodeValue(params[0].slice(eq + 1));
  }
  return mark;
}
