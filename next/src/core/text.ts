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
 * LF of a CRLF. Never earlier, so a tail cut keeps its budget: tailStart's, and the segmenter's carry.
 */
export function pastSequence(text: string, index: number): number {
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

/**
 * A C0 control the emulator executes inside an escape sequence or a CSI, leaving the sequence open
 * (every C0 but CAN and SUB, which abort it, and ESC, which begins another), or DEL, which it ignores
 * there: `A ESC [ 3 LF C B` shows `A`, then `    B`, the LF moving the cursor down and `C` then ending
 * the CSI (the house's review of the 40 commits through f3750e4, #22, comment 6310921374).
 */
const executedInside = (c: number): boolean => (c < 0x20 && c !== 0x18 && c !== 0x1a && c !== 0x1b) || c === 0x7f;

/** Where the byte that says what an ESC begins lies: the first after it that is not executed or ignored in the escape state (`ESC LF [` opens a CSI). */
function escKind(data: string, e: number): number {
  let i = e + 1;
  while (i < data.length && executedInside(data.charCodeAt(i))) i++;
  return i;
}

/** Whether a control string (OSC, DCS, SOS, PM, APC) begins at `data[i]`: ESC and the byte that says what it begins, or the C1 form. */
export const isStringStart = (data: string, i: number): boolean => {
  const c = data.charCodeAt(i);
  return C1_STRING.has(c) || (c === 0x1b && /[\]PX^_]/.test(data[escKind(data, i)] ?? ''));
};

/**
 * The C0 controls inside the sequence `data[start..end)` that the emulator executes as it reads it, by
 * index: all of a CSI's or an escape sequence's, and of a control string's only those between its ESC
 * and the byte that says what it is, since its payload's are payload. A reader takes them out of the
 * sequence and applies them where they stand, as if written before it: no character of the sequence is
 * shown, and a LF among them ends a line (the same review: `sequenceEnd` ended a CSI at its LF, and the
 * CSI's rest read as text).
 */
export function executedIn(data: string, start: number, end: number): number[] {
  const stop = !isStringStart(data, start) ? end : data.charCodeAt(start) === 0x1b ? escKind(data, start) : start + 1;
  const out: number[] = [];
  for (let k = start + 1; k < stop; k++) if (data.charCodeAt(k) < 0x20) out.push(k);
  return out;
}

/** The CSI or escape sequence `data[start..end)` as the emulator parses it: without the C0 controls it executes and the DEL it ignores. */
export function sequenceText(data: string, start: number, end: number): string {
  let text = '';
  for (let k = start; k < end; k++) if (!executedInside(data.charCodeAt(k))) text += data[k];
  return text;
}

/**
 * The longest head `sequenceHead` keeps as written: a longer one, which only a malformed sequence
 * reaches, is kept in a short form that leaves the parser in the same state, so a carry stays small.
 */
const HEAD_MAX = 64;

/** The most intermediates a shortened head keeps (HeadReader). */
const INTERMEDIATES_MAX = 8;

/**
 * The part of the CSI or escape sequence beginning at `data[start]` that lies before `upto`, its
 * executed C0 controls and DEL taken out: what a piece of text that begins at `upto`, inside the
 * sequence, begins with to be read as the sequence goes on. A head longer than HEAD_MAX is shortened
 * to its introducer, a CSI's private marker, and what keeps the parser's state (a parameter, its
 * intermediates as written, or the state that ignores the rest), so it dispatches as the same family
 * of control (`CSI ? … h` a private mode, not SM; `CSI … ! p` DECSTR, not the `CSI SP p` that an
 * intermediate shortened to a space dispatched as: our review of the 40 commits through 4f4c067), and
 * only its parameters can read differently.
 */
export function sequenceHead(data: string, start: number, upto: number): string {
  return new HeadReader(data, start).at(upto);
}

/**
 * The heads of one CSI or escape sequence (sequenceHead) at points a reader comes to in order, each
 * byte read once however many heads are asked for: a head asked at each LF the sequence executes was
 * read from the sequence's start each time, and a 64 KiB read of `ESC [` and line feeds held the event
 * loop for 5.7 s in lineEnds, 43.5 s with parameters before the line feeds (an independent read of the
 * house's fixes for #22).
 */
class HeadReader {
  /** The head as written, while it is no longer than HEAD_MAX. */
  private text = '';
  /** The head's length, its executed controls not counted. */
  private n = 0;
  private pos: number;
  /** A CSI's introducer's length once read: 2 for ESC [, 1 for the C1 CSI; 0 for an escape sequence. */
  private csi = 0;
  /** A CSI's parameters' state (csiStep). */
  private st: CsiState = 0;
  /** A CSI's private marker: its first parameter byte, when that is one of `<=>?`. */
  private priv = '';
  /** The intermediates read so far, as written: the last INTERMEDIATES_MAX of them, since no control has more than two. */
  private inter = '';

  constructor(private readonly data: string, start: number) {
    this.pos = start;
  }

  /** The head before `upto`, at or after the point asked for last. */
  at(upto: number): string {
    const d = this.data;
    for (; this.pos < upto; this.pos++) {
      const c = d.charCodeAt(this.pos);
      if (executedInside(c)) continue;
      const k = this.n++;
      if (k < HEAD_MAX) this.text += d[this.pos];
      if (k === 0) this.csi = c === 0x9b ? 1 : 0;
      else if (k === 1 && this.csi === 0 && c === 0x5b) this.csi = 2;
      else if (this.csi > 0) {
        if (k === this.csi && c >= 0x3c && c <= 0x3f) this.priv = d[this.pos]!;
        this.st = csiStep(this.st, c);
        if (this.st === 2) this.inter = (this.inter + d[this.pos]).slice(-INTERMEDIATES_MAX);
      } else if (c >= 0x20 && c <= 0x2f) this.inter = (this.inter + d[this.pos]).slice(-INTERMEDIATES_MAX);
    }
    if (this.n <= HEAD_MAX) return this.text;
    if (this.csi === 0) return `\x1b${this.inter}`;
    return (this.csi === 1 ? '\x9b' : '\x1b[') + this.priv + ['', '0', this.inter, '0?'][this.st]!;
  }
}

type CsiState = 0 | 1 | 2 | 3;

/** Where one parameter or intermediate byte (0x20–0x3f) moves a CSI's parser from state `st`, as the emulator's table moves it: 0 entry, 1 parameter, 2 intermediate, 3 ignoring the rest. */
function csiStep(st: CsiState, c: number): CsiState {
  if (st === 3) return 3;
  if (c <= 0x2f) return 2; // an intermediate
  if (st === 2) return 3; // a parameter byte after an intermediate
  if (st === 1 && c >= 0x3c) return 3; // a private marker after parameters
  return 1;
}

/**
 * The head of the CSI or escape sequence that `data[index]` lies inside (sequenceHead), '' when none does or it is a control
 * string. Its start is looked for through the whole of `data`, a whole event as its callers hold it: looked for 4096 units
 * back, a line begun after a LF that a 6,000-unit CSI executed read the CSI's rest as text (our review of the 40 commits
 * through 4f4c067, PR #22).
 */
export function headAt(data: string, index: number): string {
  const inside = enclosingSequence(data, index, Number.POSITIVE_INFINITY);
  return inside && !isStringStart(data, inside.start) ? sequenceHead(data, inside.start, index) : '';
}

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
 *
 * A LF inside a CSI or an escape sequence ends a line too: the emulator executes it there, and the
 * sequence goes on into the next line (executedIn). Such an end is reported only when `inside` is given,
 * with the head the line after it begins with (sequenceHead), since a cut there would split the
 * sequence: a reader of lines passes it and starts the next line with that head; a reader that cuts at
 * the ends it gets passes none, and only counts one line fewer for each, which keeps more input, never
 * less (the house's review of the 40 commits through f3750e4, #22, comment 6310921374).
 */
export function lineEnds(data: string, carry: LineCarry = lineCarry(), max = Number.POSITIVE_INFINITY, cr = false, inside?: Map<number, string>): number[] {
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
  const next = () => (lf === -1 ? ret : ret === -1 ? lf : Math.min(lf, ret));
  while (ends.length < max) {
    const nl = next();
    if (at !== -1 && (nl === -1 || at < nl)) {
      const e = sequenceEnd(t, at);
      const str = isStringStart(t, at);
      // The line feeds the sequence executes end lines inside it (see above): a CSI's or an escape
      // sequence's anywhere in it, a control string's only before the byte that says what it is.
      const stop = !str ? (e ?? t.length) : t[at] === '\x1b' ? escKind(t, at) : at + 1;
      let heads: HeadReader | undefined;
      for (i = at + 1, advance(); next() !== -1 && next() < stop && ends.length < max; i = next() + 1, advance()) {
        if (!inside) continue;
        ends.push(next() - skip);
        inside.set(next() - skip, (heads ??= new HeadReader(t, at)).at(next()));
      }
      if (e === undefined) {
        if (str) {
          // Open to the end of the data: its introducer, and a last ESC that may begin a string's terminator.
          const body = t[at] === '\x1b' ? escKind(t, at) + 1 : at + 1;
          carry.open = (t[at] === '\x1b' ? `\x1b${t[body - 1]}` : t[at]!) + stringState(t, at, body) + (t.length > body && t.endsWith('\x1b') ? '\x1b' : '');
        } else if (ends.length < max) carry.open = (heads ?? new HeadReader(t, at)).at(t.length);
        break;
      }
      // Past the sequence: a string's payload is skipped whole.
      i = e;
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
 * `ESC ( B` goes whole (the house's read of ed4ecac, #22: a two-byte rule left its `B`). The tabs
 * and newlines a CSI or an escape sequence executes inside it stay, where they stand (executedIn):
 * `A ESC [ 3 LF C B` reads `A`, a newline, `B`. An unfinished sequence takes the rest of the text with
 * it, what it has executed so far excepted.
 */
export function stripEscapes(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (isIntroducer(c)) {
      const end = sequenceEnd(s, i);
      for (const k of executedIn(s, i, end ?? s.length)) {
        if (s[k] !== '\t' && s[k] !== '\n') continue;
        map.push(k);
        text += s[k];
      }
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
 * Whether `part` shows a character, read on from the data before it: its text without control sequences and controls
 * (stripEscapes), tabs and line ends aside, with the sequence that data left unfinished read first, so a part that
 * finishes one shows only what follows it. A line names the pipe of the first character it shows (§6 rule 6): an
 * escape sequence, a CSI head carried over a LF, or a control alone names none (our review of the 84 commits through
 * a8b6f28, PR #22: a cursor-hide on stdout before `boom` on stderr named stdout, and the line mixed).
 */
export function showsCharacter(before: string, part: string): boolean {
  return /[^\t\n]/.test(stripEscapes(before.slice(unfinishedSequence(before)) + part).text);
}

/**
 * How far back `safeCut` and `unfinishedSequence` look for the start of a control sequence by
 * default. A control string can be longer than this (an OSC 52 carries a clipboard): a caller
 * that holds the whole of a source's output passes a wider lookback, since a cut inside a string
 * it did not see the start of puts the string's payload into text (the house's read of 1cabc6a, #22).
 */
const SEQUENCE_LOOKBACK = 4096;

/** CAN and SUB, which abort an escape sequence or a CSI, ESC, which begins another, and the C1 controls, which end it and act. */
const endsEscape = (c: number): boolean => c === 0x18 || c === 0x1a || c === 0x1b || (c >= 0x80 && c <= 0x9f);

/** The UTF-16 units of the character at `data[k]`: a surrogate pair goes whole. */
const charUnits = (data: string, k: number): number => (isHigh(data.charCodeAt(k)) && k + 1 < data.length && isLow(data.charCodeAt(k + 1)) ? 2 : 1);

/**
 * Index after the control sequence starting at `data[e]` (ESC, the C1 CSI, or a C1 string's
 * introducer), or undefined when it does not end within `data`. A string ends where the pinned
 * emulator ends it: at ST (`ESC \` or U+009C); at BEL only when it is an OSC, since in a DCS, SOS,
 * PM or APC a BEL is payload; where CAN or SUB aborts it, a new sequence's ESC abandons it, or any
 * other C1 control ends it, which then acts (U+009B opens a CSI, U+0090 a DCS, and so on); and an
 * SOS, PM or APC where a code point from U+00A0 abandons it, that code point with it, as it abandons a
 * DCS that has not had its final byte yet (unless a misplaced byte set it to ignore the rest): Cyrillic
 * read as Latin-1 and written again (`А` as U+00D0 U+0090) opened a DCS at its second character that
 * the emulator ended at the next, and this read on to an ST, so its text and line ends were lost (an
 * independent read of the house's fixes for #22). Those that end it and act are not part of it. The C1 introducers open the strings and CSI as their ESC forms do
 * (an independent read of the fix for the house's read of the 33 commits, #22, comment 6307350650:
 * the emulator ended `ESC ] 0 ; my CAN` at the CAN, and opened an OSC at U+009D, where this read
 * on; and a reviewer's read of the fixes for #22: a BEL inside an APC ended it here and not there,
 * so the APC's payload was text, and a U+009B inside a title opened a CSI there and was payload here).
 *
 * An escape sequence and a CSI end where the emulator's table ends them too (the house's review of
 * the 40 commits through f3750e4, #22, comment 6310921374: `A ESC [ 3 LF C B` ended at the LF here,
 * and `C B` read as text where the emulator shows `    B`). A C0 control inside one is executed and
 * the sequence goes on (executedIn says which); DEL is ignored; CAN and SUB abort it, and ESC or any
 * C1 control ends it and acts. A CSI ends at its final byte (0x40–0x7e); a code point from U+00A0 is
 * an error that ends it, taken with it, except once a misplaced byte has set the CSI to ignore the rest,
 * where it is ignored. An ESC is followed by intermediates (0x20–0x2f) and one final byte (0x30–0x7e,
 * or a code point from U+00A0, taken as an error): ESC 7, ESC =, ESC M are two bytes, `ESC ( B` three
 * (the house's read of b047b92), and the byte after ESC and its C0 controls says whether it opens a
 * CSI or a string instead (`ESC LF [ 31 m` sets red).
 */
export function sequenceEnd(data: string, e: number): number | undefined {
  let i = e + 1;
  const c0 = data.charCodeAt(e);
  let kind: 'csi' | 'string';
  // The string's own introducer, as its C1 form: OSC (U+009D), DCS (U+0090), SOS, PM, APC.
  let str = c0;
  if (c0 === 0x9b) kind = 'csi';
  else if (C1_STRING.has(c0)) kind = 'string';
  else {
    i = escKind(data, e);
    if (i >= data.length) return undefined;
    const c1 = data.charCodeAt(i);
    if (endsEscape(c1)) return i;
    if (c1 === 0x5b) kind = 'csi';
    else if (c1 === 0x5d || c1 === 0x50 || c1 === 0x58 || c1 === 0x5e || c1 === 0x5f) {
      kind = 'string';
      str = c1 + 0x40;
    } else {
      for (; i < data.length; i++) {
        const c = data.charCodeAt(i);
        if (executedInside(c) || (c >= 0x20 && c <= 0x2f)) continue;
        return endsEscape(c) ? i : i + charUnits(data, i);
      }
      return undefined;
    }
    i++;
  }
  if (kind === 'csi') {
    let st: CsiState = 0;
    for (; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      if (endsEscape(c)) return i;
      if (executedInside(c)) continue;
      if (c >= 0xa0) {
        if (st === 3) {
          i += charUnits(data, i) - 1;
          continue;
        }
        return i + charUnits(data, i);
      }
      st = csiStep(st, c);
    }
    return undefined;
  }
  // OSC, DCS, SOS, PM, APC: to ST, BEL for an OSC, or where something else ends it.
  const osc = str === 0x9d;
  const opaque = str === 0x98 || str === 0x9e || str === 0x9f; // SOS, PM, APC
  // A DCS before its final byte: the state its parameter bytes leave it in (as a CSI's); undefined once it
  // has its final byte and the rest is payload, and for every other string.
  let params: CsiState | undefined = str === 0x90 ? 0 : undefined;
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
    if (opaque && c >= 0xa0) return i + charUnits(data, i);
    if (params === undefined) continue;
    if (c >= 0xa0 && params !== 3) return i + charUnits(data, i);
    if (c >= 0x40 && c <= 0x7e) params = undefined;
    else if (c >= 0x20 && c <= 0x3f) params = csiStep(params, c);
  }
  return undefined;
}

/**
 * What the carry of a control string open at the end of `data` holds after its introducer (lineEnds): for a
 * DCS, what its bytes from `from` on leave it in, so the next data reads on in the same state (a final byte
 * once it has one, its payload following; else a parameter, an intermediate, or the state ignoring the rest,
 * as sequenceHead shortens a CSI's); nothing for any other string.
 */
function stringState(data: string, at: number, from: number): string {
  const c = data.charCodeAt(at);
  if ((c === 0x1b ? data.charCodeAt(from - 1) + 0x40 : c) !== 0x90) return '';
  let st: CsiState = 0;
  for (let k = from; k < data.length; k++) {
    const b = data.charCodeAt(k);
    if (b >= 0x40 && b <= 0x7e) return 'p';
    if (b >= 0x20 && b <= 0x3f) st = csiStep(st, b);
  }
  return ['', '0', ' ', '0?'][st]!;
}

/** The last `ch` in `s`, -1 when none: the forward search proves absence far faster than the backward one. */
const lastOf = (s: string, ch: string): number => (s.indexOf(ch) === -1 ? -1 : s.lastIndexOf(ch));

/**
 * The last introducer (ESC, or a C1 one: isIntroducer) in `data[from..i]` (-1 when none), by native
 * searches over that window alone: a tail cut may look back through megabytes of plain text, and a
 * cut with a bounded lookback must not pay for the whole text. `firstEsc` is the window's first ESC
 * (-1 when it has none), found once by its caller, so a walk back over many introducers searches
 * backward from each only as far as the one before it: found by a forward search of the whole window
 * at each step, a walk over 50,000 STs after 1 MB of text took 496 ms (our review of the 40 commits
 * through 4f4c067, PR #22). The C1 forms are looked for only after the nearest ESC.
 */
function introducerBefore(data: string, i: number, from: number, firstEsc: number): number {
  if (i < from) return -1;
  const esc = firstEsc === -1 || firstEsc > i ? -1 : data.lastIndexOf('\x1b', i);
  const lo = esc === -1 ? from : esc + 1;
  const after = data.slice(lo, i + 1);
  const c1 = Math.max(...['\x9b', '\x90', '\x98', '\x9d', '\x9e', '\x9f'].map((ch) => lastOf(after, ch)));
  return c1 !== -1 ? lo + c1 : esc;
}

/**
 * The control sequence `data[index]` lies inside, if any, found by looking back at most `lookback`
 * units for its start: where it starts, and where it ends (undefined when it is unfinished).
 */
function enclosingSequence(data: string, index: number, lookback: number): { start: number; end: number | undefined } | undefined {
  const from = Math.max(0, index - lookback);
  const f = data.slice(from, index).indexOf('\x1b');
  const firstEsc = f === -1 ? -1 : from + f;
  let st: number | undefined;
  for (let e = introducerBefore(data, index - 1, from, firstEsc); e !== -1; e = introducerBefore(data, e - 1, from, firstEsc)) {
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
