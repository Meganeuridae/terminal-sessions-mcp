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
 * `PRO""BE`), so an echo of the typed line never matches a mark.
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
/** The echo of a typed line that runs a Run: the wrapper's end marker or the inline start marker, split. */
const wrapperEcho = (nonce: string): RegExp => new RegExp(`<<<(?:EXI(?:""|'')T|STAR(?:""|'')T):${nonce}:`, 'g');
/** The echo of a probe line typed after a ^C, split. */
const probeEcho = (nonce: string): RegExp => new RegExp(`<<<PRO(?:""|'')BE:${nonce}`, 'g');
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
}

/**
 * A shell Run's output without the daemon's plumbing, the one rule for the live transcript and
 * for history. Under `rich` nothing is cut: the output runs from the pre-execution mark to the
 * end mark, and the marks are not output. Under `basic` the first line is the echo of the typed
 * line. Under `marker` and `inline` the marks carry the Run's nonce, and the cut is by it: the
 * echo of the typed line (its last echo: typed ahead of the prompt it echoes twice), an inline
 * Run's start-marker line or the rest of it (the output begins right after `>>>`), and
 * everything from the end marker on, or from the probe answer the session accepted — from the
 * start of that probe's echo line. A probe the session rejected (answered by a nested shell: its
 * pid is not the one the start marker named, or its token is not the Run's) is struck from the
 * output with its echo line, and the output goes on past it (the house's read of 39787b3, #22).
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
  let lastEcho = -1;
  for (const m of text.matchAll(wrapperEcho(nonce))) lastEcho = m.index;
  if (lastEcho !== -1) {
    const nl = text.indexOf('\n', lastEcho);
    if (nl === -1) return '';
    from = nl + 1;
  }
  let pid: string | undefined;
  const start = startMark(nonce).exec(text.slice(from));
  if (start?.index === 0) {
    pid = start[1];
    const nl = text.indexOf('\n', from + start[0].length);
    from = nl === -1 ? text.length : nl + 1;
  } else if (of.strategy === 'inline' && text[from] === '\n') from++;
  const rest = text.slice(from);
  const lineOf = (i: number): [number, number] => {
    const s = rest.lastIndexOf('\n', i - 1) + 1;
    const e = rest.indexOf('\n', i);
    return [s, e === -1 ? rest.length : e + 1];
  };
  let to = exitMark(nonce).exec(rest)?.index ?? rest.length;
  let accepted = -1;
  const struck: Array<[number, number]> = [];
  const answers: number[] = [];
  for (const m of rest.matchAll(probeAnswer(nonce))) {
    if (m.index >= to) break;
    answers.push(m.index);
    // Accepted as the session accepts it (applyInlineMarker): the marker strategy's answer names
    // no pid; an inline answer must carry the Run's token, or, from before tokens, the pid the
    // start marker named when the output holds it.
    if (m[2] === undefined || (m[3] !== undefined ? m[3] === m[1] : pid === undefined || m[2] === pid)) {
      accepted = to = m.index;
      break;
    }
    struck.push(lineOf(m.index));
  }
  const echoes = [...rest.matchAll(probeEcho(nonce))].map((m) => m.index).filter((i) => i < to);
  if (accepted !== -1) {
    // The accepted probe's own echo: the last one before its answer with no other answer between
    // (a probe answered by nothing leaves an echo alone). The cut moves back to its line.
    const own = echoes.filter((i) => !answers.some((a) => a > i && a < accepted)).at(-1);
    if (own !== undefined) to = lineOf(own)[0];
  }
  for (const i of echoes) if (i < to) struck.push(lineOf(i));
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
