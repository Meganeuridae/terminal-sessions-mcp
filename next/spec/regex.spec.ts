import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuMs } from './testhost.js';
import { compileUserRegex, execBounded, foldCase, LINEAR_LOOKBEHIND, LINEAR_NULLABLE_REPETITION, LINEAR_REGEX, MAX_MATCH_INPUT, MIN_WINDOW, matchWindow, testBounded } from '../src/core/regex.js';

test('regex: the linear-time engine is in force on this Node', () => {
  assert.equal(LINEAR_REGEX, true);
});

test('regex: catastrophic patterns match in linear time', () => {
  for (const p of ['(a+)+$', '(a|a)+$', '(\\w+\\s?)+$', '(.*a){16}', '^(([a-z])+.)+[A-Z]([a-z])+$']) {
    const re = compileUserRegex(p);
    const { ms } = cpuMs(() => re.test(`${'a'.repeat(5000)}!`));
    assert.ok(ms < 500, `${p} took ${Math.round(ms)} ms of CPU`);
  }
  const re = compileUserRegex('(a+)+$', 'i');
  const { value: matched, ms } = cpuMs(() => re.test(`${'A'.repeat(5000)}!`));
  assert.equal(matched, false);
  assert.ok(ms < 500, `took ${Math.round(ms)} ms of CPU`);
});

test('regex: i is honoured by folding letters into classes', () => {
  const cases: Array<[string, string, boolean]> = [
    ['error', 'ERROR: disk', true],
    ['Listening on port \\d+', 'listening ON PORT 8080', true],
    ['[a-f]+x', 'ABCX', true],
    ['[^a]', 'A', false],
    ['[^a]', 'b', true],
    ['\\x41', 'A', true],
    ['\\bready\\b', 'Server READY.', true],
    ['(?<word>fail)ed', 'FAILED', true],
    ['caf\\u00e9', 'CAFé', true],
    ['[\\]a-c]', 'B', true],
    ['\\W', 'a', false],
    ['[0-9A-F]{2}', 'ff', true],
    ['^[a.-]$', '5', false], ['^[a-z_-]+$', 'A-B_c', true], ['[\\101]', 'a', true], // a trailing '-', an octal escape in a class
  ];
  for (const [p, s, want] of cases) assert.equal(compileUserRegex(p, 'i').test(s), want, `${p} ~ ${s} (folded ${foldCase(p)})`);
});

test('regex: m and s work; g and y are dropped', () => {
  assert.ok(compileUserRegex('^b$', 'm').test('a\nb\nc'));
  assert.ok(compileUserRegex('a.b', 's').test('a\nb'));
  const re = compileUserRegex('a', 'gy');
  assert.equal(re.global, false);
  assert.equal(re.sticky, false);
  assert.ok(re.test('xa') && re.test('xa'));
});

test('regex: refusals are invalid_argument with a reason', () => {
  const refused = (p: string, f = '', why?: RegExp) =>
    assert.throws(() => compileUserRegex(p, f), (e: Error & { code?: string }) => e.code === 'invalid_argument' && (why === undefined || why.test(e.message)));
  refused('(a)\\1', '', /back-references/);
  refused('a(?=b)', '', /lookahead/);
  refused('a(?!b)', '', /lookahead/);
  refused('x{100000}', '', /grow past/);
  refused('(?:\\w+\\s?){1,300}$', '', /grow past/);
  refused('(?<n>a)\\k<n>', '', /back-references/);
  refused('(', '', /invalid pattern/);
  refused('a', 'u', /flags/);
  refused('x'.repeat(1001), '', /longer/);
});

// ───────────── er-9 / atc-2 / m2-5: bounded matching of caller patterns ─────────────

/** A small seeded PRNG, so a failing case reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random ASCII patterns over a small alphabet of both cases: classes, ranges, escapes, groups, alternation, quantifiers. */
function patternGen(r: () => number, maxCount: number): () => string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const letters = 'abcdeABCDExyzXYZ';
  const classItem = (): string => {
    const k = r();
    if (k < 0.4) return pick([...letters, '0', '_', '.', '-'].map((c) => (c === '-' ? '\\-' : c)));
    if (k < 0.7) return pick(['a-c', 'A-C', 'b-e', 'W-Z', 'x-z', '0-9', 'A-z', 'D-a']);
    if (k < 0.85) return pick(['\\d', '\\w', '\\s', '\\W']);
    return pick(['\\x41', '\\x62', '\\u0043', '\\x5f']);
  };
  // Large counts go on atoms only: on a group that can match empty, the backtracking
  // reference itself takes exponential time.
  const quant = (group: boolean): string => {
    const k = r();
    if (k < 0.45) return '';
    if (k < 0.85) return pick(['?', '*', '+', '??', '*?', '+?']);
    const limit = group ? Math.min(maxCount, 4) : maxCount;
    const m = Math.floor(r() * limit);
    const n = m + Math.floor(r() * limit);
    return pick([`{${m}}`, `{${m},}`, `{${m},${n}}`, `{${m},${n}}?`]);
  };
  const atom = (depth: number): string => {
    const k = r();
    if (k < 0.35) return pick([...letters]);
    if (k < 0.45) return pick(['.', '\\d', '\\w', '\\s', '\\x41', '\\u0062', '\\.']);
    if (k < 0.65) return `[${r() < 0.25 ? '^' : ''}${Array.from({ length: 1 + Math.floor(r() * 3) }, classItem).join('')}]`;
    if (k < 0.8 && depth < 2) return `${pick(['(', '(?:', '(?<g>'.replace('g', `g${Math.floor(r() * 1e6)}`)])}${alt(depth + 1)})`;
    return pick([...letters]);
  };
  const seq = (depth: number): string => {
    let out = '';
    for (let n = 1 + Math.floor(r() * 4); n > 0; n--) {
      const k = r();
      if (k < 0.06) out += pick(['^', '$', '\\b', '\\B']);
      else if (k < 0.09 && depth === 0 && LINEAR_LOOKBEHIND) out += `(?<=${pick([...letters])})`;
      else {
        const a = atom(depth);
        out += a + quant(a.startsWith('('));
      }
    }
    return out;
  };
  const alt = (depth: number): string => Array.from({ length: r() < 0.25 ? 2 : 1 }, () => seq(depth)).join('|');
  return () => alt(0);
}

function fuzz(seed: number, cases: number, maxCount: number, flags: string[]) {
  const r = rng(seed);
  const gen = patternGen(r, maxCount);
  const alphabet = 'abcdeABCDExyzXYZ01 _.-\n';
  let compared = 0;
  let refusedForSize = 0;
  for (let c = 0; c < cases; c++) {
    const p = gen();
    const f = flags[c % flags.length]!;
    let ref: RegExp;
    try {
      ref = new RegExp(p, f);
    } catch {
      continue; // e.g. a lookbehind quantified: invalid everywhere
    }
    let lin: RegExp;
    try {
      lin = compileUserRegex(p, f);
    } catch (e) {
      // Node 20's engine has a match-priority bug for a nullable bounded repetition.
      // Those patterns must be explicitly refused rather than return the wrong match.
      if (!LINEAR_NULLABLE_REPETITION && /misorders nullable bounded repetitions/.test((e as Error).message)) continue;
      // Only a nesting of large counts may be refused, and only for its size.
      assert.match((e as Error).message, /grow past/, `/${p}/${f}`);
      refusedForSize++;
      continue;
    }
    for (let k = 0; k < 12; k++) {
      const s = Array.from({ length: Math.floor(r() * 14) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
      const a = ref.exec(s);
      const b = lin.exec(s);
      assert.deepEqual(b && [b.index, b[0]], a && [a.index, a[0]], `/${p}/${f} on ${JSON.stringify(s)} (compiled as /${lin.source}/)`);
      compared++;
    }
  }
  assert.ok(refusedForSize < cases / 20, `refused for size: ${refusedForSize} of ${cases}`);
  return compared;
}

test('er-9 / atc-2: `i` folding agrees with the backtracking engine on random ASCII patterns and inputs', () => {
  const n = fuzz(20260924, 3000, 4, ['i', 'im', 'is', '']);
  assert.ok(n > 30_000, `compared ${n}`);
});

test('er-9 / m2-5: counted repetition over 16 is written out, and matches as the backtracking engine does', () => {
  const n = fuzz(4242, 1500, 40, ['', 'i']);
  assert.ok(n > 15_000, `compared ${n}`);
  // The shapes the engine refused on its own.
  for (const [p, yes, no] of [
    ['^x{17}$', 'x'.repeat(17), 'x'.repeat(16)],
    ['^[a-z]{1,100}!', `${'q'.repeat(100)}!`, `${'q'.repeat(101)}!`],
    ['^(?:ab){20}$', 'ab'.repeat(20), 'ab'.repeat(19)],
    ['^(?:a{4}){5}$', 'a'.repeat(20), 'a'.repeat(19)],
    ['^(\\d{2}:){3,20}$', '10:'.repeat(20), '10:'.repeat(21)],
    ['^a{17,}?$', 'a'.repeat(30), 'a'.repeat(16)],
  ] as const) {
    const re = compileUserRegex(p);
    assert.ok(re.test(yes), `${p} matches`);
    assert.ok(!re.test(no), `${p} does not match`);
  }
});

test('er-9 / atc-2: nothing a caller writes takes more than a bounded time per line', () => {
  const lines = ['a'.repeat(MAX_MATCH_INPUT * 2), 'hello world '.repeat(12_000), '1'.repeat(MAX_MATCH_INPUT)];
  const patterns = ['(a+)+$', '^(\\w+\\s?)*$', '(\\w+\\s?){1,80}$', '(.*a){16}x', '(a?)'.repeat(200), `${'a'.repeat(900)}b`, '[a-z]{1,150}x', '(a|aa){1,60}b', '(?:\\w+\\s){16}x'];
  for (const p of patterns) {
    const re = compileUserRegex(p);
    for (const line of lines) {
      const { ms } = cpuMs(() => testBounded(re, line));
      // The point is that it stays bounded (see cpuMs).
      assert.ok(ms < 2500, `${p.slice(0, 40)} on ${line.length} chars took ${Math.round(ms)} ms of CPU`);
    }
  }
});

test('er-9: a large pattern gets a smaller match window, and testBounded says when it cut', () => {
  const small = compileUserRegex('ERROR');
  assert.equal(matchWindow(small), MAX_MATCH_INPUT);
  const big = compileUserRegex('(a?)'.repeat(200));
  assert.ok(matchWindow(big) < MAX_MATCH_INPUT && matchWindow(big) >= MIN_WINDOW, String(matchWindow(big)));
  // The floor: a thousand literal characters get MIN_WINDOW, where the cost of one match is MIN_WINDOW × size.
  const huge = compileUserRegex('a'.repeat(1000));
  assert.equal(matchWindow(huge), MIN_WINDOW);
  assert.ok(MIN_WINDOW * 1000 <= 2_000_000, 'the largest common pattern costs at most twice MATCH_COST');
  const { ms } = cpuMs(() => testBounded(huge, 'b'.repeat(MAX_MATCH_INPUT)));
  assert.ok(ms < 1000, `the floor case took ${Math.round(ms)} ms of CPU`);
  // execBounded gives the match itself, from the same window.
  assert.deepEqual(execBounded(small, `${'x'.repeat(100)}ERROR`).match?.[0], 'ERROR');
  assert.equal(execBounded(small, `${'x'.repeat(MAX_MATCH_INPUT)}ERROR`).match, null);
  assert.deepEqual(testBounded(small, `${'x'.repeat(100)}ERROR`), { matched: true, clipped: false });
  // Past the window the head is matched; the cut is reported.
  assert.deepEqual(testBounded(small, `${'x'.repeat(MAX_MATCH_INPUT)}ERROR`), { matched: false, clipped: true });
  assert.deepEqual(testBounded(small, `ERROR${'x'.repeat(MAX_MATCH_INPUT)}`), { matched: true, clipped: true });
  // A regex compiled elsewhere gets the full window.
  assert.equal(matchWindow(/x/), MAX_MATCH_INPUT);
});

test('er-9: groups are compiled non-capturing; the match itself is unchanged', () => {
  const m = compileUserRegex('(?<word>fail)(ed|ure)').exec('it failed');
  assert.equal(m?.[0], 'failed');
  assert.equal(m?.index, 3);
  assert.equal(m?.groups, undefined);
  // An octal escape is not mistaken for a back-reference, and stays an octal escape.
  assert.ok(compileUserRegex('a\\12b').test('a\nb'));
  assert.ok(compileUserRegex('[\\1]').test('\x01'));
});

test('an engine without lookbehind (Node 20) refuses it instead of silently using backtracking', { skip: LINEAR_LOOKBEHIND ? 'this engine takes lookbehind' : false }, () => {
  for (const pattern of ['(?<=y)b', '(?<=y)(a+)+$', '(?<=y)(a|aa)+$']) {
    assert.throws(() => compileUserRegex(pattern), /not supported by this Node's linear-time regex engine/);
  }
});

test('nullable optional groups either preserve JavaScript match priority or explain the engine limitation', () => {
  for (const [pattern, text] of [['a(?:b*?)?', 'ab'], ['e(?:c+?|[W-Zb-eA-z]*?)?', 'eY']]) {
    if (LINEAR_NULLABLE_REPETITION) assert.deepEqual(compileUserRegex(pattern!).exec(text!)?.[0], new RegExp(pattern!).exec(text!)?.[0]);
    else assert.throws(() => compileUserRegex(pattern!), /misorders nullable bounded repetitions/);
  }
});
