/**
 * UTF-8-safe cutting for byte-capped results (G11: truncation is always visible),
 * and where output can be cut without splitting a control sequence.
 *
 * Caps are stated in UTF-8 bytes, the unit the journal and the wire count, but a
 * cut is made on the decoded string, so it never lands inside a character: a
 * code point (a surrogate pair included) is kept whole or dropped whole, and a
 * result never starts or ends with U+FFFD that the output did not contain.
 */

/** UTF-8 byte length of `text` (a lone surrogate counts as U+FFFD, as Node encodes it). */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** UTF-8 bytes of a BMP code unit that is not half of a pair (a lone surrogate encodes as U+FFFD). */
const bmpBytes = (c: number): number => (c < 0x80 ? 1 : c < 0x800 ? 2 : 3);
const isHigh = (c: number): boolean => (c & 0xfc00) === 0xd800;
const isLow = (c: number): boolean => (c & 0xfc00) === 0xdc00;

/**
 * The largest index `e` such that `text.slice(0, e)` is at most `maxBytes` UTF-8
 * bytes and does not end between the halves of a surrogate pair.
 */
export function headIndex(text: string, maxBytes: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const pair = isHigh(c) && i + 1 < text.length && isLow(text.charCodeAt(i + 1));
    const b = pair ? 4 : bmpBytes(c);
    if (bytes + b > maxBytes) break;
    bytes += b;
    i += pair ? 2 : 1;
  }
  return i;
}

/** The index at `bytes` UTF-8 bytes into `text`, rounded up to a character boundary. */
export function indexAtByte(text: string, bytes: number): number {
  const i = headIndex(text, bytes);
  if (i === text.length || utf8Length(text.slice(0, i)) >= bytes) return i;
  return i + (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1)) ? 2 : 1);
}

/**
 * The smallest index `s` such that `text.slice(s)` is at most `maxBytes` UTF-8
 * bytes and does not start between the halves of a surrogate pair.
 */
export function tailIndex(text: string, maxBytes: number): number {
  let bytes = 0;
  let i = text.length;
  while (i > 0) {
    const c = text.charCodeAt(i - 1);
    const pair = isLow(c) && i >= 2 && isHigh(text.charCodeAt(i - 2));
    const b = pair ? 4 : bmpBytes(c);
    if (bytes + b > maxBytes) break;
    bytes += b;
    i -= pair ? 2 : 1;
  }
  return i;
}

/**
 * Keep at most `maxBytes` UTF-8 bytes from the end of `text`. The kept text
 * starts just after a newline when the first newline in it lies in its first half.
 */
export function cutTail(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (utf8Length(text) <= maxBytes) return { text, cut: false };
  let start = tailIndex(text, Math.max(0, maxBytes));
  const nl = text.indexOf('\n', start);
  if (nl !== -1 && nl + 1 < text.length && utf8Length(text.slice(start, nl + 1)) <= maxBytes / 2) start = nl + 1;
  return { text: text.slice(start), cut: true };
}

/** How far back `safeCut` looks for the start of a control sequence (an OSC string can be long). */
const SEQUENCE_LOOKBACK = 4096;

/**
 * Index after the control sequence starting at `data[e]` (ESC, or C1 CSI), or
 * undefined when it does not end within `data`.
 */
export function sequenceEnd(data: string, e: number): number | undefined {
  let i = e + 1;
  const c0 = data.charCodeAt(e);
  let kind: 'csi' | 'string' | 'esc';
  if (c0 === 0x9b) kind = 'csi';
  else {
    const c1 = data[i];
    if (c1 === undefined) return undefined;
    if (c1 === '[') kind = 'csi';
    else if (c1 === ']' || c1 === 'P' || c1 === 'X' || c1 === '^' || c1 === '_') kind = 'string';
    else kind = 'esc';
    i++;
    if (kind === 'esc') {
      // ESC, intermediates (0x20–0x2f), then one final byte.
      while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) i++;
      return i < data.length ? i + 1 : undefined;
    }
  }
  if (kind === 'csi') {
    for (; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      if (c < 0x20 || c > 0x7e) return i; // malformed: taken as ending here
    }
    return undefined;
  }
  // OSC, DCS, SOS, PM, APC: to BEL or ST.
  for (; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x07 || c === 0x9c) return i + 1;
    if (c === 0x1b && data[i + 1] === '\\') return i + 2;
    if (c === 0x1b && i + 1 < data.length) return i; // a new sequence abandons the string
  }
  return undefined;
}

/**
 * The largest index `c <= index` at which `data` can be cut without splitting a
 * control sequence, a surrogate pair, or a CR from the LF after it, so each part
 * projects as the whole would (§6). 0 when there is no such point.
 */
export function safeCut(data: string, index: number): number {
  let c = Math.max(0, Math.min(index, data.length));
  if (c === 0 || c === data.length) return c;
  // Inside a control sequence: cut before it.
  const from = Math.max(0, c - SEQUENCE_LOOKBACK);
  for (let e = c - 1; e >= from; e--) {
    const ch = data.charCodeAt(e);
    if (ch !== 0x1b && ch !== 0x9b) continue;
    if (ch === 0x1b && data[e + 1] === '\\') {
      // A string terminator (ST): the string it ends began earlier, and is judged there.
      if (e + 1 >= c) c = e; // the cut splits the ST itself
      continue;
    }
    const end = sequenceEnd(data, e);
    if (end === undefined || end > c) c = e;
    break;
  }
  if (c > 0 && isLow(data.charCodeAt(c)) && isHigh(data.charCodeAt(c - 1))) c--;
  if (c > 0 && data[c - 1] === '\r' && data[c] === '\n') c--;
  return c;
}

/**
 * Where a control sequence left unfinished at the end of `data` starts (a PTY
 * read can end inside one), or `data.length` when every sequence in it is complete.
 */
export function unfinishedSequence(data: string): number {
  const from = Math.max(0, data.length - SEQUENCE_LOOKBACK);
  for (let e = data.length - 1; e >= from; e--) {
    const ch = data.charCodeAt(e);
    if (ch !== 0x1b && ch !== 0x9b) continue;
    if (ch === 0x1b && data[e + 1] === '\\') continue; // an ST: the string it ends is judged at its start
    if (ch === 0x1b && e === data.length - 1) {
      // A lone ESC at the end may be the first half of an ST: then the string before it is what is open.
      const earlier = unfinishedSequence(data.slice(0, e));
      return earlier < e && /[\]PX^_]/.test(data[earlier + 1] ?? '') ? earlier : e;
    }
    return sequenceEnd(data, e) === undefined ? e : data.length;
  }
  return data.length;
}
