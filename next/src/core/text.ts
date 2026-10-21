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
 * Keep at most `maxBytes` UTF-8 bytes from the end of `text` (never more: the cut moves forward,
 * see `tailStart`). The kept text starts just after a newline when the first newline in it lies
 * in its first half.
 */
export function cutTail(text: string, maxBytes: number): { text: string; cut: boolean } {
  const start = tailStart(text, maxBytes);
  return start === 0 ? { text, cut: false } : { text: text.slice(start), cut: true };
}

/**
 * Where the last `maxBytes` UTF-8 bytes of `text` start (0 when it all fits), moved to the line
 * boundary after a newline that lies in the first half of them, so a torn first line is dropped
 * only when it costs at most half the budget; a newline that is the text's last character begins
 * no line and never moves the start. The start never falls inside a control sequence, a surrogate
 * pair or a CRLF, so the kept tail begins with no half of an escape shown as text (the house's read
 * of 78c4d6e, #22: a cut inside `ESC [ 31 m` kept `31mHello`, and one inside an OSC 8 link the
 * link's tail). It moves *forward*, past the sequence it would have started inside, never back to
 * its start: the budget holds, and a long control string (an OSC 52 clipboard, whose base64 may
 * hold newlines) is looked back through whole, however long (the house's read of the 38 commits,
 * #22, comment 6274773484: a cut moved back kept 58 bytes of a 30-byte budget, and one inside a
 * 6,000-character OSC 52 began in its payload). What the forward move drops renders nothing: a
 * payload is not text. The one rule for every tail cut: results, pages, the segmenter's bodies and
 * the transcript's input.
 */
export function tailStart(text: string, maxBytes: number): number {
  if (utf8Length(text) <= maxBytes) return 0;
  const start = pastSequence(text, tailIndex(text, Math.max(0, maxBytes)));
  // The line boundary preferred is a real one: a newline inside a control string begins no line.
  let nl = text.indexOf('\n', start);
  while (nl !== -1 && nl + 1 < text.length) {
    const inside = enclosingSequence(text, nl + 1, Number.POSITIVE_INFINITY);
    if (!inside) break;
    nl = text.indexOf('\n', inside.end ?? text.length);
  }
  return nl !== -1 && nl + 1 < text.length && utf8Length(text.slice(start, nl + 1)) <= maxBytes / 2 ? nl + 1 : start;
}

/**
 * `index` moved forward to a point that splits nothing: past the control sequence it lies inside
 * (looked for through the whole text before it), past the low half of a surrogate pair, past the
 * LF of a CRLF. Never earlier, so a tail cut keeps its budget.
 */
function pastSequence(text: string, index: number): number {
  let i = Math.min(index, text.length);
  const inside = enclosingSequence(text, i, Number.POSITIVE_INFINITY);
  if (inside) i = inside.end ?? text.length;
  if (i > 0 && i < text.length && isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1))) i++;
  if (i > 0 && i < text.length && text[i - 1] === '\r' && text[i] === '\n') i++;
  return i;
}

/** How many newlines `s` holds. */
export function countLines(s: string): number {
  let c = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) c++;
  return c;
}

/**
 * Output with its control sequences and control characters (other than tab and newline; DEL
 * included) removed, and where each kept character came from, for cuts in the raw text. The sequences are read by
 * `sequenceEnd`, one grammar with `safeCut` and `unfinishedSequence`: a charset designation such as
 * `ESC ( B` goes whole (the house's read of ed4ecac, #22: a two-byte rule left its `B`). An
 * unfinished sequence takes the rest of the text with it.
 */
export function stripEscapes(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 0x1b || c === 0x9b) {
      const end = sequenceEnd(s, i);
      if (end === undefined) break;
      i = end;
      continue;
    }
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) {
      i++;
      continue;
    }
    map.push(i);
    text += s[i];
    i++;
  }
  return { text, map };
}

/**
 * How far back `safeCut` and `unfinishedSequence` look for the start of a control sequence by
 * default. A control string can be longer than this (an OSC 52 carries a clipboard): a caller
 * that holds the whole of a source's output passes a wider lookback, since a cut inside a string
 * it did not see the start of puts the string's payload into text (the house's read of 1cabc6a, #22).
 */
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
      // ESC, intermediates (0x20–0x2f), then one final byte (0x30–0x7e). With no intermediate the
      // byte after ESC is the final one: ESC 7, ESC 8, ESC =, ESC >, ESC M are two bytes (the house's
      // read of b047b92: xterm's keypad modes are ESC = and ESC >).
      const first = data.charCodeAt(i - 1);
      if (first < 0x20 || first > 0x2f) return i; // the final byte, or a malformed sequence ending here
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

/** The last `ch` in `s`, -1 when none: the forward search proves absence far faster than the backward one. */
const lastOf = (s: string, ch: string): number => (s.indexOf(ch) === -1 ? -1 : s.lastIndexOf(ch));

/**
 * The last ESC or C1 CSI in `data[from..i]` (-1 when none), by native searches over that window
 * alone: a tail cut may look back through megabytes of plain text, and a cut with a bounded lookback
 * must not pay for the whole text. The C1 form is looked for only after the nearest ESC.
 */
function introducerBefore(data: string, i: number, from: number): number {
  if (i < from) return -1;
  const window = data.slice(from, i + 1);
  const esc = lastOf(window, '\x1b');
  const csi = lastOf(esc === -1 ? window : window.slice(esc + 1), '\x9b');
  return csi !== -1 ? from + esc + 1 + csi : esc === -1 ? -1 : from + esc;
}

/**
 * The control sequence `data[index]` lies inside, if any, found by looking back at most `lookback`
 * units for its start: where it starts, and where it ends (undefined when it is unfinished).
 */
function enclosingSequence(data: string, index: number, lookback: number): { start: number; end: number | undefined } | undefined {
  const from = Math.max(0, index - lookback);
  let st: number | undefined;
  for (let e = introducerBefore(data, index - 1, from); e !== -1; e = introducerBefore(data, e - 1, from)) {
    const ch = data.charCodeAt(e);
    if (ch === 0x1b && data[e + 1] === '\\') {
      // A string terminator (ST): the string it ends began earlier, and is judged there; a point
      // between its two bytes is inside the string, or inside the ST alone when no start is found.
      if (e + 1 >= index) st = e;
      continue;
    }
    const end = sequenceEnd(data, e);
    if (end === undefined || end > index) return { start: e, end };
    break;
  }
  return st === undefined ? undefined : { start: st, end: st + 2 };
}

/**
 * The largest index `c <= index` at which `data` can be cut without splitting a
 * control sequence, a surrogate pair, or a CR from the LF after it, so each part
 * projects as the whole would (§6). 0 when there is no such point.
 */
export function safeCut(data: string, index: number, lookback = SEQUENCE_LOOKBACK): number {
  let c = Math.max(0, Math.min(index, data.length));
  if (c === 0 || c === data.length) return c;
  // Inside a control sequence: cut before it.
  const inside = enclosingSequence(data, c, lookback);
  if (inside) c = inside.start;
  if (c > 0 && isLow(data.charCodeAt(c)) && isHigh(data.charCodeAt(c - 1))) c--;
  if (c > 0 && data[c - 1] === '\r' && data[c] === '\n') c--;
  return c;
}

/**
 * Where a control sequence left unfinished at the end of `data` starts (a PTY
 * read can end inside one), or `data.length` when every sequence in it is complete.
 */
export function unfinishedSequence(data: string, lookback = SEQUENCE_LOOKBACK): number {
  const from = Math.max(0, data.length - lookback);
  for (let e = data.length - 1; e >= from; e--) {
    const ch = data.charCodeAt(e);
    if (ch !== 0x1b && ch !== 0x9b) continue;
    if (ch === 0x1b && data[e + 1] === '\\') continue; // an ST: the string it ends is judged at its start
    if (ch === 0x1b && e === data.length - 1) {
      // A lone ESC at the end may be the first half of an ST: then the string before it is what is open.
      const earlier = unfinishedSequence(data.slice(0, e), lookback);
      return earlier < e && /[\]PX^_]/.test(data[earlier + 1] ?? '') ? earlier : e;
    }
    return sequenceEnd(data, e) === undefined ? e : data.length;
  }
  return data.length;
}
