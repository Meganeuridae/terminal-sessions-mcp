/**
 * The marks a shell Run's plumbing prints, and what readers cut around them: one shape each,
 * defined here for the session that prints and parses them live and for the one cutter that
 * removes them from a Run's output, live (Session.runTranscript) and from history (the
 * segmenter's journalRunText). The house's reads of a6d0c35 and 1cabc6a (#22) changed the shapes
 * in the session and found three readers parsing the old ones; its read of 39787b3 found the
 * history cutter working by shape alone, so a program line in a mark's shape cut real output.
 *
 * Shapes: the inline start marker `<<<START:nonce:pid>>>` (a declared shell's Run names the
 * shell's pid), the end marker `<<<EXIT:nonce:status>>>` (both strategies), and the end-marker
 * probe typed after a ^C: `<<<PROBE:nonce>>>` under the marker strategy, and inline
 * `<<<PROBE:nonce:pid:token>>>`, where the token is the Run's nonce again, printed from a shell
 * variable the Run's own line set — a nested shell, with another pid or the same one in another
 * PID namespace, has no such variable and answers with an empty token (the house's read of
 * 39787b3, #22). The typed lines that print them spell each word split (`EXI""T`, `STAR''T`,
 * `PRO""BE`), so an echo of the typed line never matches a mark. The probe lines are built here
 * (markerProbe, inlineProbe), and the cutter matches their echo from the same text.
 */
import { stripEscapes } from './text.js';
import type { RunStrategy } from './types.js';

const NONCE = '[^:>\\s]+';

/** The inline start marker; group 1 is the shell's pid. */
export const startMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<START:${nonce}:(\\d+)>>>`);
/** The end marker; group 1 is the status. */
export const exitMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<EXIT:${nonce}:(-?\\d+)>>>`);
/**
 * The end-marker probe; group 1 is the pid and group 2 the token, both present under the inline
 * strategy (the token empty from a shell that did not run the Run's line; absent in journals
 * from before it was printed).
 */
export const probeMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<PROBE:${nonce}(?::(\\d+)(?::(${NONCE}|))?)?>>>`);
const MARK_NONCE = new RegExp(`<<<(?:START|EXIT|PROBE):(${NONCE})`);
/** The nonce a printed mark carries, for a reader that found the mark by its shape and must know whose it is (the compat pack's logs); undefined for text that is no mark. */
export const nonceOf = (mark: string): string | undefined => MARK_NONCE.exec(mark)?.[1];
/**
 * A typed line's text as the echo may show it: a line editor redrawing a long typed line can break
 * it anywhere, so whitespace may fall between any two characters, and bash 5.2 wrapping a line at a
 * narrow width writes the character at the margin again after a carriage return (`a1b2c\rc3d4`
 * inside a nonce: the house's read of 78c4d6e, #22, found such a probe line kept in a cancelled
 * Run's output), so any character may be followed by whitespace and itself again (the carriage
 * return is whitespace to the regex, and gone from stripEscapes's text). The unknown nonce keeps its class.
 */
const redrawn = (s: string): string => {
  if (s === NONCE) return NONCE;
  const chars = s.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return chars.map((c) => `${c}(?:\\s*${c})?`).join('\\s*');
};
/** A mark's word as the typed lines spell it, split by two quotes (`EXI""T`), each piece as it may be redrawn. */
const splitWord = (a: string, b: string): string => `${redrawn(a)}\\s*(?:${redrawn('""')}|${redrawn("''")})\\s*${redrawn(b)}`;
/** The echo of a typed line that runs a Run: the wrapper's end marker or the inline start marker, split. */
const wrapperEcho = (nonce: string): RegExp => new RegExp(`${redrawn('<<<')}\\s*(?:${splitWord('EXI', 'T')}|${splitWord('STAR', 'T')})\\s*:\\s*${redrawn(nonce)}\\s*:`, 'g');

/**
 * The end-marker probe the marker strategy types after a ^C: a marker of its own, split so echoes
 * never match. It confirms the shell is back, never the command's status; and the command's own
 * end marker, arriving after a cancel that failed, still reads as the end it is (the house's read of
 * a6d0c35, #22).
 */
export const markerProbe = (nonce: string): string => ` echo "<<<PRO""BE:${nonce}>>>"`;
/**
 * The probe the inline strategy types after a ^C (which may have cut the line before its end
 * marker): a marker of its own, with the Run's nonce, the pid of the shell that runs it, and the
 * token the Run's own line set in that shell (its nonce again). A nested shell the Run started
 * prints its own pid and an empty token: pids alone repeat across PID namespaces (`docker run -it
 * … sh` is pid 1), the variable does not travel (the house's read of 39787b3, #22).
 */
export const inlineProbe = (nonce: string, fish: boolean): string => ` printf '<<<PRO''BE:${nonce}:%s:%s>>>\\n' ${fish ? '$fish_pid "$__tsm_r"' : '"$$" "$\{__tsm_r-}"'}`;
/** Where a builder's line holds the nonce, to split it there: no builder types this character. */
const AT_NONCE = '\0';
/**
 * The typed probe lines around their nonce, taken from the builders above: each head, from its
 * mark's `<<<` up to the nonce, with the rests of the lines that follow the nonce after it. The
 * cutter's copy of the rests was written by hand beside the builders, so a change to one could
 * leave the echo of the line it types in a Run's output (a reviewer's read of the fixes for #22).
 */
const PROBE_LINES = new Map<string, string[]>();
for (const line of [markerProbe(AT_NONCE), inlineProbe(AT_NONCE, false), inlineProbe(AT_NONCE, true)]) {
  const [before, after] = line.split(AT_NONCE) as [string, string];
  const head = before.slice(before.indexOf('<<<'));
  PROBE_LINES.set(head, [...(PROBE_LINES.get(head) ?? []), after]);
}
/**
 * The echo of a probe line typed after a ^C, split, through the end of the typed line when it is
 * there. The rests that share a head are alternatives after it, so a line that is not the first's
 * still matches whole (one branch per line would stop sh's at the nonce of fish's line).
 */
const probeEcho = (nonce: string): RegExp =>
  new RegExp([...PROBE_LINES].map(([head, rests]) => `${redrawn(head)}\\s*${redrawn(nonce)}(?:\\s*(?:${rests.map(redrawn).join('|')}))?`).join('|'), 'g');
/** A probe answer with its nonce (1), pid (2) and token (3). */
const probeAnswer = (nonce: string): RegExp => new RegExp(`<<<PROBE:(${nonce})(?::(\\d+)(?::(${NONCE}|))?)?>>>`, 'g');

/** What a Run's output holds besides the command's own, as its run.start recorded it. */
export interface PlumbingOf {
  /** How the Run was launched; absent for a Run journaled before it was recorded, whose plumbing is found by shape. */
  strategy?: RunStrategy | undefined;
  /** The nonce in its marks (marker and inline strategies); absent likewise. */
  nonce?: string | undefined;
  /** The output was read from after the Run's start (a byte cap): its first line is not the typed line's echo. */
  truncated?: boolean | undefined;
  /** The pid the start marker named, when the caller knows it and the output does not begin with the marker (the live transcript). */
  pid?: string | undefined;
}

/**
 * A shell Run's output without the daemon's plumbing, the one rule for the live transcript and
 * for history. Under `rich` nothing is cut: the output runs from the pre-execution mark to the
 * end mark, and the marks are not output. Under `basic` the first line is the echo of the typed
 * line. Under `marker` and `inline` the marks carry the Run's nonce, and the cut is by it: the
 * echo of the typed line (the lines echoing it without a break: typed ahead of the prompt it
 * echoes twice, and a redraw shows it in pieces), under `marker` from its first line wherever it
 * is, with everything before it, and otherwise at the output's head; under `inline` everything
 * through the start-marker line (the output begins right after `>>>`), whatever a slow shell
 * printed between the echo and the marker included (a login banner, its first prompt showing the
 * line again); and everything from the end marker on, or from the probe answer the session
 * accepted. A later line in the echo's shape is the program's. The marker strategy has no start
 * marker, so a shell that prints its banner and shows the typed line again before it runs it
 * (one still starting when the line was typed) leaves those lines in its first Run; and with the
 * terminal's echo off, a program line in the echo's shape with the Run's own nonce (`history 1`)
 * is taken for the echo, and what preceded it goes with it. Before that
 * end, every line of each probe's echo and every rejected answer's line is struck on its own, and the
 * output between them stays: a probe the session rejected (answered by a nested shell: its pid is
 * not the one the start marker named, or its token is not the Run's) is not an end (the house's
 * read of 39787b3, #22), and a probe nothing answered, because a program ignoring ^C read it,
 * leaves only its echo behind, with what the program printed after it still output (the house's
 * read of 78c4d6e, #22: the cut moved back to that echo and the output after it was gone).
 * Without a recorded nonce the same shapes are found with any nonce, which can take a program
 * line in a mark's shape for one. The cut is found on the text without escape sequences and
 * made in the raw.
 */
export function cutPlumbing(raw: string, of: PlumbingOf = {}): string {
  if (of.strategy === 'rich') return raw;
  if (of.strategy === 'basic') {
    if (of.truncated) return raw;
    const nl = raw.indexOf('\n');
    return nl === -1 ? '' : raw.slice(nl + 1);
  }
  const nonce = of.nonce ?? NONCE;
  const { text, map } = stripEscapes(raw);
  let from = 0;
  let pid: string | undefined = of.pid;
  const echoes = [...text.matchAll(wrapperEcho(nonce))].map((m) => [m.index, m.index + m[0].length] as const);
  const start = startMark(nonce).exec(text);
  if (start && (echoes.length === 0 || echoes[0]![0] < start.index)) {
    // An inline Run's output begins after its start marker: what the text holds before it is the
    // shell's, not the Run's (the typed line's echo, a banner or prompt a slow shell printed after
    // the line was typed, the pieces' acknowledgements), and a line in the echo's shape after the
    // marker is the program's (`history 1` prints the typed line with the Run's own nonce, and the
    // rule that took the last such line for the echo cut everything before it: the house's read of
    // 78c4d6e, #22, comment 6269901528).
    pid = start[1];
    const nl = text.indexOf('\n', start.index + start[0].length);
    from = nl === -1 ? text.length : nl + 1;
  } else {
    // The typed line's echo, and the lines that follow it without a break, which are more of it: the
    // same line echoed again (typed ahead of its prompt), or the pieces of a redraw, which can split
    // the nonce across lines. Under the marker strategy the echo begins at the Run's first wrapper
    // echo, wherever it is: the program starts only after its line is typed, so what comes before
    // the echo is the shell's (a banner, an empty line, the head of a typed line wrapped before its
    // marker), and the cut through it is the start of the Run's output (the house's read of the 38
    // commits, #22, comment 6274773484: with a line before the echo, the rule that took the echo only
    // on the output's first line kept the echo in the output). Otherwise the echo is only at the
    // output's head: under `inline` the output begins after the start marker, past the echo, and
    // with no nonce recorded an echo-shaped line further on may be another Run's that a program
    // printed. A truncated read began after the echo. A line in the echo's shape after output is the
    // program's (`history 1` prints the typed line with the Run's own nonce), and a shell still
    // starting when the line was typed shows it again after its banner, which the marker strategy,
    // with no start marker, cannot tell from the program's: those lines stay in its first Run.
    const first = echoes[0];
    const anywhere = of.strategy === 'marker' && !of.truncated;
    const headEnd = text.indexOf('\n') === -1 ? text.length : text.indexOf('\n');
    if (first && (anywhere || first[0] < headEnd)) {
      from = anywhere ? text.lastIndexOf('\n', first[0] - 1) + 1 : 0;
      for (;;) {
        const nl = text.indexOf('\n', from);
        const lineEnd = nl === -1 ? text.length : nl;
        if (!echoes.some(([s, e]) => s < lineEnd && e > from)) break;
        if (nl === -1) return '';
        from = nl + 1;
      }
    }
    if (of.strategy === 'inline' && text[from] === '\n') from++;
  }
  const rest = text.slice(from);
  const lineOf = (i: number): [number, number] => {
    const s = rest.lastIndexOf('\n', i - 1) + 1;
    const e = rest.indexOf('\n', i);
    return [s, e === -1 ? rest.length : e + 1];
  };
  let to = exitMark(nonce).exec(rest)?.index ?? rest.length;
  const struck: Array<[number, number]> = [];
  for (const m of rest.matchAll(probeAnswer(nonce))) {
    if (m.index >= to) break;
    // Accepted as the session accepts it (applyInlineMarker): the marker strategy's answer names
    // no pid. An inline answer is judged by the pid first: when the start marker (or the live
    // session) named the declared shell's pid, only that pid answers for the Run, with the Run's
    // token or none (no token is the declared shell replaced in place by an exec); the Run's token
    // on another pid is a nested shell that inherited the variable (`set -a`), a stranger's answer
    // the session rejects, and the cutter accepted, ending the result at it (the house's read of
    // 78c4d6e, #22, comment 6269901528). With no pid known, the token is the one evidence: the
    // Run's token is accepted, an empty one is not; from before tokens, any pid.
    const ok = m[2] === undefined || (pid !== undefined ? m[2] === pid && (m[3] === undefined || m[3] === '' || m[3] === m[1]) : m[3] === undefined || m[3] === m[1]);
    if (ok) {
      to = m.index;
      break;
    }
    struck.push(lineOf(m.index));
  }
  // Each probe's echo before the end is plumbing on its own, the accepted probe's included, every
  // line of it: a redraw can break the typed line, its nonce included, over two lines, and striking
  // only the line where it began kept the rest (the house's read of the 38 commits, #22, comment
  // 6274773484). A probe nothing answered leaves only its echo, and what was printed after it stays.
  for (const m of rest.matchAll(probeEcho(nonce))) if (m.index < to) struck.push([lineOf(m.index)[0], lineOf(m.index + m[0].length - 1)[1]]);
  const kept: Array<[number, number]> = [];
  let pos = 0;
  for (const [s, e] of struck.sort((a, b) => a[0] - b[0])) {
    if (s >= to) break;
    if (s > pos) kept.push([pos, s]);
    pos = Math.max(pos, e);
  }
  if (pos < to) kept.push([pos, to]);
  // Each raw piece begins right after the last plumbing character before it, so an escape that
  // opens the output (a colour set before its first character) stays with it.
  return kept.map(([s, e]) => raw.slice((from + s) === 0 ? 0 : map[from + s - 1]! + 1, map[from + e] ?? raw.length)).join('');
}
