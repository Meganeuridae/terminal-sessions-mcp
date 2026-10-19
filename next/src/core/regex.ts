/**
 * Caller-supplied regular expressions (search, watches, readiness and fail
 * patterns, compat searchLogs). JavaScript regexes backtrack and run on the
 * daemon's one thread, so one pattern with exponential behaviour, like `(a+)+$`,
 * would freeze every session (G19).
 *
 * Patterns therefore run on V8's linear-time engine (the `l` flag, enabled here
 * with `--enable-experimental-regexp-engine`): matching costs O(pattern × input)
 * whatever the pattern. How a pattern is prepared for it:
 *
 * - That engine has no back-references or lookahead: those patterns are refused.
 *   Lookbehind depends on the engine's capabilities (Node 20's engine refuses it).
 *   A pattern the linear engine rejects is refused, never silently moved to backtracking.
 * - It has no case-insensitive mode: `i` is compiled by rewriting each letter
 *   into the class of what `i` equates it with (`a` → `[Aa]`, see `foldCase`).
 * - Groups are compiled non-capturing: callers use the match, never its groups,
 *   and every capture multiplies the engine's work (a match's `groups` and
 *   indices past 0 are therefore absent).
 * - It takes counted repetition only up to 16 copies along one nesting of
 *   quantifiers (`x{17}` and `(?:x{4}){5}` are refused by it, and `x+` counts as
 *   two copies, `xx*`, to Node 20's engine), so a larger count is written out
 *   here (`x{2,20}` → `xx` and eighteen `x?`) while the result stays within
 *   MAX_EXPANDED_LENGTH; beyond that the pattern is refused, saying why.
 *
 * The engine's cost still grows with the pattern: a thousand-character pattern
 * matched against a 64 KiB line takes seconds. So each compiled pattern gets a
 * match window, `matchWindow(re)`: MAX_MATCH_INPUT characters for an ordinary
 * pattern, fewer for a large one, sized so that one match costs about the same
 * (tens of milliseconds) whatever the pattern. `testBounded` matches the head of
 * a line within that window and says when it cut (G11: truncation is visible).
 *
 * Where the engine is unavailable, patterns fall back to the backtracking engine
 * behind a refusal of the classic catastrophic shapes; `LINEAR_REGEX` says which
 * is in force.
 */
import v8 from 'node:v8';
import { err } from './errors.js';

/** The longest pattern accepted. */
export const MAX_PATTERN_LENGTH = 1000;

/** The longest pattern after `i` folding and the expansion of counted repetition. */
export const MAX_EXPANDED_LENGTH = 2000;

/** The most characters of one line a caller's pattern is matched against (its head). */
export const MAX_MATCH_INPUT = 64 * 1024;

/** The smallest match window any accepted pattern gets. */
const MIN_WINDOW = 2048;

/** Engine work allowed per match: pattern size (atoms × copies) × input characters; about 20–170 ns each. */
const MATCH_COST = 1_000_000;

/** Flags a caller may pass. `g`, `y` and `d` are accepted and dropped (matching is stateless). */
const ALLOWED_FLAGS = /^[imsgyd]*$/;

function enableLinearEngine(): boolean {
  try {
    v8.setFlagsFromString('--enable-experimental-regexp-engine');
    new RegExp('a', 'l');
    return true;
  } catch {
    return false;
  }
}

/** True when caller patterns run on the linear-time engine. */
export const LINEAR_REGEX = enableLinearEngine();

/** Whether this Node's linear engine accepts lookbehind; Node 20's does not. */
export const LINEAR_LOOKBEHIND =
  LINEAR_REGEX &&
  (() => {
    try {
      new RegExp('(?<=a)b', 'l');
      return true;
    } catch {
      return false;
    }
  })();

/** Older linear engines choose an empty optional group before its nonempty match. */
export const LINEAR_NULLABLE_REPETITION = LINEAR_REGEX && new RegExp('a(?:b*?)?', 'l').exec('ab')?.[0] === 'ab';

const windows = new WeakMap<RegExp, number>();

const REFUSED =
  'patterns run on a linear-time engine, which has no back-references (\\1, \\k<name>) or lookahead ((?=…), (?!…)): rewrite the pattern without them (lookbehind, (?<=…) and (?<!…), works)';

/**
 * Compile a caller's pattern, or throw invalid_argument. The result is not global
 * or sticky and captures nothing (see the module comment). Flags: `i`, `m` and
 * `s` (`u` and `v` are refused).
 */
export function compileUserRegex(pattern: string, flags = ''): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) throw err('invalid_argument', `pattern longer than ${MAX_PATTERN_LENGTH} characters`);
  if (!ALLOWED_FLAGS.test(flags)) throw err('invalid_argument', `unsupported regex flags '${flags}': use i, m and s`);
  const base = [...new Set(flags.replace(/[gyd]/g, ''))].join('');
  try {
    new RegExp(pattern, base);
  } catch (e) {
    throw err('invalid_argument', `invalid pattern: ${(e as Error).message}`);
  }
  if (!LINEAR_REGEX) return backtracking(pattern, base);
  const source = base.includes('i') ? foldCase(pattern) : pattern;
  // Syntax the parser does not model is compiled as written, on the smallest window.
  const parsed = parse(source);
  let final = source;
  let size: Node | undefined;
  if (parsed) {
    if (parsed.backref || parsed.lookahead) throw err('invalid_argument', REFUSED);
    final = emit(parsed.node, 1);
    if (final.length > MAX_EXPANDED_LENGTH) throw tooLarge();
    size = parse(final)?.node;
  }
  if (!LINEAR_NULLABLE_REPETITION && (size === undefined || nullableBoundedRepetition(size))) {
    throw err('invalid_argument', 'this Node\'s linear-time regex engine misorders nullable bounded repetitions; simplify optional groups or use a newer Node');
  }
  let re: RegExp;
  try {
    re = new RegExp(final, `${base.replace('i', '')}l`);
  } catch {
    throw err('invalid_argument', 'pattern is not supported by this Node\'s linear-time regex engine; lookbehind requires an engine that supports it');
  }
  windows.set(re, size === undefined ? MIN_WINDOW : Math.max(MIN_WINDOW, Math.min(MAX_MATCH_INPUT, Math.floor(MATCH_COST / Math.max(1, sizeOf(size))))));
  return re;
}

/** How many characters of one line `re` (from compileUserRegex) is matched against; MAX_MATCH_INPUT for any other regex. */
export function matchWindow(re: RegExp): number {
  return windows.get(re) ?? MAX_MATCH_INPUT;
}

/**
 * Test `re` against the head of `text` within its match window, so one enormous
 * line costs a bounded match. `clipped` says the text was cut: a match beyond
 * the window is not seen. The regex's `lastIndex` is reset first.
 */
export function testBounded(re: RegExp, text: string): { matched: boolean; clipped: boolean } {
  const w = matchWindow(re);
  const clipped = text.length > w;
  re.lastIndex = 0;
  return { matched: re.test(clipped ? text.slice(0, w) : text), clipped };
}

/** The fallback: refuse back-references and the classic exponential shapes. */
function backtracking(pattern: string, flags: string): RegExp {
  if (/\\[1-9]|\\k</.test(pattern)) throw err('invalid_argument', 'back-references are not supported in patterns');
  // A quantified group that itself contains a quantifier: `(a+)+`, `(\\w*x)*`.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) throw err('invalid_argument', 'nested quantifiers (like (a+)+) are refused: they can take exponential time');
  return new RegExp(pattern, flags);
}

// ───────────── the pattern's structure: groups and counted repetition ─────────────

/** The engine's limit on copies along one nesting of quantifiers. */
const MAX_COPIES = 16;

type Node =
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; branches: Node[] }
  | { kind: 'group'; open: string; capture: boolean; body: Node }
  | { kind: 'atom'; src: string }
  | { kind: 'quant'; body: Node; min: number; max: number; lazy: boolean; src: string };

interface Parsed {
  node: Node;
  /** A back-reference to a group that exists (`\\1` with a group 1, `\\k<n>` with named groups). */
  backref: boolean;
  lookahead: boolean;
}

/**
 * Parse a valid, non-unicode pattern into sequences, alternations, groups, atoms
 * and quantifiers, with Annex B's readings (a `{` that is no quantifier is a
 * literal; `\\12` is a back-reference only when there are 12 groups). Undefined
 * for syntax this parser does not know, so the caller does not guess.
 */
function parse(p: string): Parsed | undefined {
  let i = 0;
  const refs: number[] = [];
  let named = false;
  let kref = false;
  let caps = 0;
  let lookahead = false;
  const fail = (): never => {
    throw new SyntaxError('unparsed');
  };
  // An escape at p[i] ('\\'): its full text. Outside a class, `\\N` is a back-reference
  // when group N exists (decided at the end), otherwise a legacy octal escape.
  const escape = (inClass: boolean): string => {
    const start = i;
    const c = p[i + 1];
    if (c === undefined) fail();
    if (!inClass && /[1-9]/.test(c!)) refs.push(Number(/^\d+/.exec(p.slice(i + 1))![0]));
    if (c === 'k' && !inClass) kref = true;
    i = readEscape(p, i, inClass).end;
    return p.slice(start, i);
  };
  const cls = (): string => {
    const start = i;
    i++; // [
    if (p[i] === '^') i++;
    while (i < p.length && p[i] !== ']') {
      if (p[i] === '\\') escape(true);
      else i++;
    }
    if (p[i] !== ']') fail();
    i++;
    return p.slice(start, i);
  };
  // A quantifier at p[i], or undefined (a `{` that is not one is a literal).
  const quant = (): { min: number; max: number; lazy: boolean; src: string } | undefined => {
    const start = i;
    let min: number;
    let max: number;
    const c = p[i];
    if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '?') [min, max] = [0, 1];
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) return undefined;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      i += m[0].length - 1;
    } else return undefined;
    i++;
    const lazy = p[i] === '?';
    if (lazy) i++;
    return { min, max, lazy, src: p.slice(start, i) };
  };
  const alternation = (): Node => {
    const branches: Node[] = [sequence()];
    while (p[i] === '|') {
      i++;
      branches.push(sequence());
    }
    return branches.length === 1 ? branches[0]! : { kind: 'alt', branches };
  };
  const sequence = (): Node => {
    const items: Node[] = [];
    while (i < p.length && p[i] !== '|' && p[i] !== ')') {
      let atom: Node;
      const c = p[i]!;
      if (c === '(') {
        const open = /^\((\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>|\?)?/.exec(p.slice(i))![0];
        if (open === '(?') fail(); // modifiers and other extensions this parser does not model
        if (open === '(?=' || open === '(?!') lookahead = true;
        const capture = open === '(' || /^\(\?<[A-Za-z_$]/.test(open);
        if (capture) caps++;
        if (open.startsWith('(?<') && capture) named = true;
        i += open.length;
        const body = alternation();
        if (p[i] !== ')') fail();
        i++;
        atom = { kind: 'group', open, capture, body };
      } else if (c === '[') atom = { kind: 'atom', src: cls() };
      else if (c === '\\') atom = { kind: 'atom', src: escape(false) };
      else {
        atom = { kind: 'atom', src: c };
        i++;
      }
      for (;;) {
        const q = quant();
        if (!q) break;
        atom = { kind: 'quant', body: atom, ...q };
      }
      items.push(atom);
    }
    return items.length === 1 ? items[0]! : { kind: 'seq', items };
  };
  try {
    const node = alternation();
    if (i !== p.length) return undefined;
    return { node, backref: refs.some((n) => n <= caps) || (kref && named), lookahead };
  } catch {
    return undefined;
  }
}

/** True when `n` can match the empty string. */
function nullable(n: Node): boolean {
  switch (n.kind) {
    case 'atom':
      return /^(?:\^|\$|\\[bB])$/.test(n.src);
    case 'seq':
      return n.items.every(nullable);
    case 'alt':
      return n.branches.some(nullable);
    case 'group':
      return n.open.startsWith('(?<=') || n.open.startsWith('(?<!') || nullable(n.body);
    case 'quant':
      return n.min === 0 || nullable(n.body);
  }
}

/**
 * How many copies of its body a quantifier asks the engine for, as V8's linear
 * compiler counts them: `{n}` and `{m,n}` n (at least one: `{0}` still compiles
 * its body), `*` one, `{m,}` m, and one more when the body can match empty
 * (`(?:a{8}|)+` is 16, `(?:a{9}|)+` is refused).
 */
const copies = (q: Extract<Node, { kind: 'quant' }>): number => (q.max !== Infinity ? Math.max(1, q.max) : q.min === 0 ? 1 : q.min + (nullable(q.body) ? 1 : 0));

/** The copies the engine itself makes of a quantifier's body: `x{m,}` is `x{m}x*` to it, so `x+` is two (Node 20's engine counts so; Node 22's is more lenient). */
const engineCopies = (q: Extract<Node, { kind: 'quant' }>): number => (q.max !== Infinity ? Math.max(1, q.max) : q.min === 0 ? 1 : q.min + 1);

function nullableBoundedRepetition(n: Node): boolean {
  switch (n.kind) {
    case 'atom': return false;
    case 'seq': return n.items.some(nullableBoundedRepetition);
    case 'alt': return n.branches.some(nullableBoundedRepetition);
    case 'group': return nullableBoundedRepetition(n.body);
    case 'quant': return (n.max !== Infinity && nullable(n.body)) || nullableBoundedRepetition(n.body);
  }
}

/** The most copies along one nesting of quantifiers within `n`, as the engine counts them. */
function nesting(n: Node): number {
  switch (n.kind) {
    case 'atom':
      return 1;
    case 'seq':
      return Math.max(1, ...n.items.map(nesting));
    case 'alt':
      return Math.max(1, ...n.branches.map(nesting));
    case 'group':
      return nesting(n.body);
    case 'quant':
      return engineCopies(n) * nesting(n.body);
  }
}

/** The engine's work per input character, roughly: atoms times the copies they are repeated in. */
function sizeOf(n: Node): number {
  switch (n.kind) {
    case 'atom':
      return 1;
    case 'seq':
      return n.items.reduce((a, x) => a + sizeOf(x), 0);
    case 'alt':
      return n.branches.reduce((a, x) => a + sizeOf(x), 0);
    case 'group':
      return sizeOf(n.body);
    case 'quant':
      return sizeOf(n.body) * copies(n);
  }
}

const tooLarge = () =>
  err('invalid_argument', `counted repetition over 16 is written out for the linear-time engine, and this pattern would grow past ${MAX_EXPANDED_LENGTH} characters: use + or * for long runs, or smaller counts`);

/**
 * The pattern text of `n` for the engine: every group non-capturing, and any
 * quantifier that would take the copies along its nesting (`product`) past 16
 * written out as copies. Throws invalid_argument past MAX_EXPANDED_LENGTH.
 */
function emit(n: Node, product: number): string {
  switch (n.kind) {
    case 'atom':
      return n.src;
    case 'seq':
      return n.items.map((x) => emit(x, product)).join('');
    case 'alt':
      return n.branches.map((x) => emit(x, product)).join('|');
    case 'group':
      return `${n.capture ? '(?:' : n.open}${emit(n.body, product)})`;
    case 'quant': {
      const c = engineCopies(n);
      if (product * c * nesting(n.body) <= MAX_COPIES) return `${emit(n.body, product * c)}${n.src}`;
      // Too many copies for the engine: write them out. A body is an atom or a
      // group, so each copy takes a quantifier as it stands.
      const body = emit(n.body, product);
      const lazy = n.lazy ? '?' : '';
      const count = n.max === Infinity ? n.min + 1 : n.max;
      if (count * (body.length + 2) > MAX_EXPANDED_LENGTH) throw tooLarge();
      let out = body.repeat(n.min);
      if (n.max === Infinity) out += `${body}*${lazy}`;
      else out += `${body}?${lazy}`.repeat(n.max - n.min);
      return out;
    }
  }
}

// ───────────── case folding for the linear-time engine ─────────────

/**
 * Canonicalize (ECMA-262 22.2.2.7.3, non-unicode `i`): the upper case when it is
 * one code unit, except that a non-ASCII unit never folds onto ASCII.
 */
function canon(c: number): number {
  const u = String.fromCharCode(c).toUpperCase();
  if (u.length !== 1) return c;
  const uc = u.charCodeAt(0);
  return c >= 128 && uc < 128 ? c : uc;
}

let foldClasses: Map<number, number[]> | undefined;

/** Every code unit that `i` treats as equal to `c` (itself included). */
function equivalents(c: number): number[] {
  if (!foldClasses) {
    // Once: group the BMP by canonical form (a few milliseconds).
    const byCanon = new Map<number, number[]>();
    for (let x = 0; x <= 0xffff; x++) {
      if (x >= 0xd800 && x <= 0xdfff) continue;
      const k = canon(x);
      const list = byCanon.get(k);
      if (list) list.push(x);
      else byCanon.set(k, [x]);
    }
    foldClasses = new Map();
    for (const list of byCanon.values()) if (list.length > 1) for (const v of list) foldClasses.set(v, list);
  }
  return foldClasses.get(c) ?? [c];
}

/** A code unit written for use inside a class. */
const unit = (c: number): string => {
  const ch = String.fromCharCode(c);
  return c >= 0x20 && c < 0x7f ? (/[\\\]^-]/.test(ch) ? `\\${ch}` : ch) : `\\u${c.toString(16).padStart(4, '0')}`;
};

/** Sorted code units as class items, runs written as ranges. */
function items(codes: number[]): string {
  const sorted = [...new Set(codes)].sort((a, b) => a - b);
  let out = '';
  for (let k = 0; k < sorted.length; ) {
    let e = k;
    while (e + 1 < sorted.length && sorted[e + 1] === sorted[e]! + 1) e++;
    out += e - k >= 2 ? `${unit(sorted[k]!)}-${unit(sorted[e]!)}` : sorted.slice(k, e + 1).map(unit).join('');
    k = e + 1;
  }
  return out;
}

/**
 * One escape at p[i] ('\\') in a non-unicode pattern: where it ends, and the code
 * unit it stands for when it stands for one (`\\x41`, `\\u0041`, `\\t`, `\\101`,
 * `\\a` → 'a'), or undefined for class escapes, assertions and `\\k`. A digit escape
 * is read as a legacy octal escape (Annex B), whether or not it is a back-reference.
 */
function readEscape(p: string, i: number, inClass: boolean): { end: number; code: number | undefined } {
  const c = p[i + 1] ?? '';
  if (c === 'x' && /^[0-9a-fA-F]{2}$/.test(p.slice(i + 2, i + 4))) return { end: i + 4, code: parseInt(p.slice(i + 2, i + 4), 16) };
  if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(p.slice(i + 2, i + 6))) return { end: i + 6, code: parseInt(p.slice(i + 2, i + 6), 16) };
  if (c === 'c' && /^[A-Za-z]$/.test(p[i + 2] ?? '')) return { end: i + 3, code: p.charCodeAt(i + 2) & 0x1f };
  if (c === 'b' && inClass) return { end: i + 2, code: 0x08 };
  if ('dDwWsSbB'.includes(c) || c === 'k') return { end: i + 2, code: undefined };
  if (/[0-7]/.test(c)) {
    // Up to three octal digits, at most 0o377 (`\\8` and `\\9` are identity escapes, below).
    const m = /^[0-7]{1,3}/.exec(p.slice(i + 1))![0];
    const digits = parseInt(m, 8) > 0o377 ? m.slice(0, 2) : m;
    return { end: i + 1 + digits.length, code: parseInt(digits, 8) };
  }
  const controls: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
  if (controls[c] !== undefined) return { end: i + 2, code: controls[c] };
  // An identity escape (`\\.`, `\\]`, and in Annex B `\\a`, `\\x` without hex digits).
  return { end: i + 2, code: c ? c.charCodeAt(0) : undefined };
}

/**
 * Rewrite a pattern so it matches case-insensitively without the `i` flag, with
 * the equalities `i` has in a non-unicode pattern: a letter (or an escape that
 * stands for one) outside a class becomes a class of its case variants, and a
 * class gains the variants of every character and range it holds. Class escapes
 * (`\\w`, `\\d`, `\\s`) are closed under folding and are copied; group names
 * are copied untouched. Assumes the pattern is valid (it was compiled first).
 */
export function foldCase(p: string): string {
  let out = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '\\') {
      const e = readEscape(p, i, false);
      const text = p.slice(i, e.end);
      // `\\1`…`\\9` outside a class may be a back-reference: copied, never folded.
      const eq = e.code === undefined || /[1-9]/.test(p[i + 1]!) ? [] : equivalents(e.code);
      out += eq.length > 1 ? `[${text}${items(eq.filter((x) => x !== e.code))}]` : text;
      i = e.end;
    } else if (c === '(' && p.startsWith('(?<', i) && p[i + 3] !== '=' && p[i + 3] !== '!') {
      const end = p.indexOf('>', i) + 1;
      out += p.slice(i, end);
      i = end;
    } else if (c === '[') {
      // A class: collect what it holds, then add every variant it does not.
      let j = i + 1;
      if (p[j] === '^') j++;
      const held: number[] = [];
      const ranges: Array<[number, number]> = [];
      let dash = false; // the last item is a literal '-'
      const item = (k: number): { end: number; code: number | undefined } => (p[k] === '\\' ? readEscape(p, k, true) : { end: k + 1, code: p.charCodeAt(k) });
      while (j < p.length && p[j] !== ']') {
        const a = item(j);
        if (p[a.end] === '-' && a.end + 1 < p.length && p[a.end + 1] !== ']') {
          const b = item(a.end + 1);
          if (a.code !== undefined && b.code !== undefined) {
            ranges.push([a.code, b.code]);
            j = b.end;
            dash = false;
            continue;
          }
          // A class escape at either end makes the '-' a literal (Annex B).
        }
        if (a.code !== undefined) held.push(a.code);
        dash = p[j] === '-';
        j = a.end;
      }
      const extra: number[] = [];
      for (const x of held) extra.push(...equivalents(x));
      for (const [lo, hi] of ranges) for (let x = lo; x <= hi; x++) if (equivalents(x).length > 1) extra.push(...equivalents(x));
      const inRange = (x: number) => held.includes(x) || ranges.some(([lo, hi]) => x >= lo && x <= hi);
      const add = extra.filter((x) => !inRange(x));
      // A '-' ending the class would make a range with the first variant added: it is escaped.
      out += `${dash && add.length ? `${p.slice(i, j - 1)}\\-` : p.slice(i, j)}${items(add)}]`;
      i = j + 1;
    } else {
      const eq = equivalents(c.charCodeAt(0));
      out += eq.length > 1 ? `[${items(eq)}]` : c;
      i++;
    }
  }
  return out;
}
