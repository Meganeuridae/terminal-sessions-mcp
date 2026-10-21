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
  // The line boundary preferred is a real one (lineEnds): a newline inside a control string begins no
  // line. `start` lies outside every sequence, and a boundary farther than half the budget is no use.
  const e = lineEnds(text.slice(start, start + Math.floor(maxBytes / 2)), lineCarry(), 1)[0];
  const nl = e === undefined ? -1 : start + e;
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

/**
 * What a stream's data left unfinished for `lineEnds`: the introducer of the control sequence still
 * open at its end, and, after a string's, an ESC that may begin its terminator; empty when none is.
 */
export interface LineCarry {
  open: string;
}

export const lineCarry = (): LineCarry => ({ open: '' });

/** The C1 introducers of the control strings: DCS, SOS, OSC, PM, APC (U+0090, U+0098, U+009D–U+009F). */
const C1_STRING = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

/** Whether `c` begins a control sequence: ESC, the C1 CSI, or a C1 control string's introducer. */
export const isIntroducer = (c: number): boolean => c === 0x1b || c === 0x9b || C1_STRING.has(c);

/** Whether a control string (OSC, DCS, SOS, PM, APC) begins at `data[i]`: ESC and its second byte, or the C1 form. */
export const isStringStart = (data: string, i: number): boolean => {
  const c = data.charCodeAt(i);
  return C1_STRING.has(c) || (c === 0x1b && /[\]PX^_]/.test(data[i + 1] ?? ''));
};

/** The introducers, for finding the next one. */
const INTRODUCER = /[\x1b\x90\x98\x9b\x9d-\x9f]/g;

/**
 * The indices of `data`'s LFs that end lines (with `cr`, its CRs too), at most `max` of them: every
 * one outside a control string (OSC, DCS, SOS, PM, APC), whose payload the terminal does not execute,
 * so a LF in a window title ends no line. Strings and other sequences end as `sequenceEnd` reads them.
 * `carry` is what the stream's data before this left unfinished, and is updated, so a sequence open
 * across events is read whole; a new stream, or one after a hole, starts with a fresh carry. The one
 * rule for every reader of lines: the reader's pages and tails, search, the projection's interleave
 * and its cuts, `tailStart`, the segmenter's lines and the watches' (the house's read of the 33
 * commits, #22, comment 6307350650, item 2, and an independent read of the fix: only the tail kept it,
 * and a page, a search and the projection split a title in two).
 */
export function lineEnds(data: string, carry: LineCarry = lineCarry(), max = Number.POSITIVE_INFINITY, cr = false): number[] {
  const t = carry.open + data;
  const skip = carry.open.length;
  carry.open = '';
  const ends: number[] = [];
  // The next introducer, LF and CR at or after `i`, each searched for again only once `i` passes it: a
  // redraw flood of sequences with few line ends would otherwise search to the far line end once per sequence.
  let i = 0;
  const nextIntroducer = (from: number): number => {
    INTRODUCER.lastIndex = from;
    return INTRODUCER.exec(t)?.index ?? -1;
  };
  let at = nextIntroducer(0);
  let lf = t.indexOf('\n');
  let ret = cr ? t.indexOf('\r') : -1;
  const advance = () => {
    if (lf !== -1 && lf < i) lf = t.indexOf('\n', i);
    if (ret !== -1 && ret < i) ret = t.indexOf('\r', i);
  };
  while (ends.length < max) {
    const nl = lf === -1 ? ret : ret === -1 ? lf : Math.min(lf, ret);
    if (at !== -1 && (nl === -1 || at < nl)) {
      const e = sequenceEnd(t, at);
      if (e === undefined) {
        // Open to the end of the data: its introducer, and a last ESC that may begin a string's terminator.
        const intro = t.slice(at, at + (t.charCodeAt(at) === 0x1b ? 2 : 1));
        carry.open = intro + (isStringStart(t, at) && t.length > at + intro.length && t.endsWith('\x1b') ? '\x1b' : '');
        break;
      }
      // A string's payload is skipped whole; any other sequence's line feeds still execute.
      i = isStringStart(t, at) ? e : at + 1;
      at = nextIntroducer(i);
      advance();
      continue;
    }
    if (nl === -1) break;
    ends.push(nl - skip);
    i = nl + 1;
    advance();
  }
  return ends;
}

/** How many newlines `s` holds. */
export function countLines(s: string): number {
  let c = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) c++;
  return c;
}

/**
 * Output with its control sequences and control characters (other than tab and newline; DEL and
 * the C1 controls included) removed, and where each kept character came from, for cuts in the raw text. The sequences are read by
 * `sequenceEnd`, one grammar with `safeCut` and `unfinishedSequence`: a charset designation such as
 * `ESC ( B` goes whole (the house's read of ed4ecac, #22: a two-byte rule left its `B`). An
 * unfinished sequence takes the rest of the text with it.
 */
export function stripEscapes(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (isIntroducer(c)) {
      const end = sequenceEnd(s, i);
      if (end === undefined) break;
      i = end;
      continue;
    }
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) {
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
 * Index after the control sequence starting at `data[e]` (ESC, the C1 CSI, or a C1 string's
 * introducer), or undefined when it does not end within `data`. A string ends where the pinned
 * emulator ends it: at ST (`ESC \` or U+009C); at BEL only when it is an OSC, since in a DCS, SOS,
 * PM or APC a BEL is payload; where CAN or SUB aborts it, a new sequence's ESC abandons it, or any
 * other C1 control ends it, which then acts (U+009B opens a CSI, U+0090 a DCS, and so on); and an
 * SOS, PM or APC where a code point from U+00A0 abandons it, that code point with it. Those that end
 * it and act are not part of it. The C1 introducers open the strings and CSI as their ESC forms do
 * (an independent read of the fix for the house's read of the 33 commits, #22, comment 6307350650:
 * the emulator ended `ESC ] 0 ; my CAN` at the CAN, and opened an OSC at U+009D, where this read
 * on; and a reviewer's read of the fixes for #22: a BEL inside an APC ended it here and not there,
 * so the APC's payload was text, and a U+009B inside a title opened a CSI there and was payload here).
 */
export function sequenceEnd(data: string, e: number): number | undefined {
  let i = e + 1;
  const c0 = data.charCodeAt(e);
  let kind: 'csi' | 'string' | 'esc';
  // The string's own introducer, as its C1 form: OSC (U+009D), DCS (U+0090), SOS, PM, APC.
  let str = c0;
  if (c0 === 0x9b) kind = 'csi';
  else if (C1_STRING.has(c0)) kind = 'string';
  else {
    const c1 = data[i];
    if (c1 === undefined) return undefined;
    if (c1 === '[') kind = 'csi';
    else if (c1 === ']' || c1 === 'P' || c1 === 'X' || c1 === '^' || c1 === '_') {
      kind = 'string';
      str = c1.charCodeAt(0) + 0x40;
    } else kind = 'esc';
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
  // OSC, DCS, SOS, PM, APC: to ST, BEL for an OSC, or where something else ends it.
  const osc = str === 0x9d;
  const opaque = str === 0x98 || str === 0x9e || str === 0x9f; // SOS, PM, APC
  for (; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x07) {
      if (osc) return i + 1;
      continue;
    }
    if (c === 0x9c) return i + 1;
    if (c >= 0x80 && c <= 0x9f) return i; // any other C1 control ends the string, and acts
    if (c === 0x18 || c === 0x1a) return i;
    if (c === 0x1b && data[i + 1] === '\\') return i + 2;
    if (c === 0x1b && i + 1 < data.length) return i; // a new sequence abandons the string
    if (opaque && c >= 0xa0) return i + (isHigh(c) && i + 1 < data.length && isLow(data.charCodeAt(i + 1)) ? 2 : 1);
  }
  return undefined;
}

/** The last `ch` in `s`, -1 when none: the forward search proves absence far faster than the backward one. */
const lastOf = (s: string, ch: string): number => (s.indexOf(ch) === -1 ? -1 : s.lastIndexOf(ch));

/**
 * The last introducer (ESC, or a C1 one: isIntroducer) in `data[from..i]` (-1 when none), by native
 * searches over that window alone: a tail cut may look back through megabytes of plain text, and a
 * cut with a bounded lookback must not pay for the whole text. The C1 forms are looked for only after
 * the nearest ESC.
 */
function introducerBefore(data: string, i: number, from: number): number {
  if (i < from) return -1;
  const window = data.slice(from, i + 1);
  const esc = lastOf(window, '\x1b');
  const after = esc === -1 ? window : window.slice(esc + 1);
  const c1 = Math.max(...['\x9b', '\x90', '\x98', '\x9d', '\x9e', '\x9f'].map((ch) => lastOf(after, ch)));
  return c1 !== -1 ? from + esc + 1 + c1 : esc === -1 ? -1 : from + esc;
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
    if (!isIntroducer(ch)) continue;
    if (ch === 0x1b && data[e + 1] === '\\') continue; // an ST: the string it ends is judged at its start
    if (ch === 0x1b && e === data.length - 1) {
      // A lone ESC at the end may be the first half of an ST: then the string before it is what is open.
      const earlier = unfinishedSequence(data.slice(0, e), lookback);
      return earlier < e && isStringStart(data, earlier) ? earlier : e;
    }
    return sequenceEnd(data, e) === undefined ? e : data.length;
  }
  return data.length;
}
