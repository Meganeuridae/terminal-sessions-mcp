/**
 * The marks a shell Run's plumbing prints, and what readers cut around them: one shape each,
 * defined here for the session that prints and parses them live (by nonce, see Session's
 * printers) and for the readers that cut history by shape alone (the segmenter's completions,
 * the App's results, the compat pack's logs). The house's reads of a6d0c35 and 1cabc6a (#22)
 * changed the shapes in the session and found three readers parsing the old ones.
 *
 * Shapes: the inline start marker `<<<START:nonce:pid>>>` (a declared shell's Run names the
 * shell's pid), the end marker `<<<EXIT:nonce:status>>>` (both strategies), and the end-marker
 * probe typed after a ^C, `<<<PROBE:nonce>>>` under the marker strategy or `<<<PROBE:nonce:pid>>>`
 * inline. The typed lines that print them spell each word split (`EXI""T`, `STAR''T`,
 * `PRO""BE`), so an echo of the typed line never matches a mark.
 */
import { stripEscapes } from './text.js';

const NONCE = '[^:>\\s]+';

/** The inline start marker; group 1 is the shell's pid. */
export const startMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<START:${nonce}:(\\d+)>>>`);
/** The end marker; group 1 is the status. */
export const exitMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<EXIT:${nonce}:(-?\\d+)>>>`);
/** The end-marker probe; group 1 is the pid, present under the inline strategy. */
export const probeMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<PROBE:${nonce}(?::(\\d+))?>>>`);
/** The echo of a typed line that runs a Run: the wrapper's end marker or the inline start marker, split. */
const WRAPPER_ECHO = /<<<(?:EXI(?:""|'')T|STAR(?:""|'')T):/g;
/** The echo of a probe line typed after a ^C, split. */
const PROBE_ECHO = /<<<PRO(?:""|'')BE:/;

/** Where the first of the marks matches in `text`, or -1. */
export function firstMark(text: string, nonce: string): number {
  const found = [exitMark(nonce).exec(text), probeMark(nonce).exec(text)].filter((m): m is RegExpExecArray => m !== null).map((m) => m.index);
  return found.length ? Math.min(...found) : -1;
}

/**
 * A shell Run's plumbing cut from its journaled output by shape, as the live transcript cuts it
 * by nonce (Session.runTranscript): the echo of the typed wrapper (its last line ends the
 * plumbing before the output), a declared shell's start-marker line, and everything from the
 * first end marker or probe on — including a probe line typed after a ^C, from the start of its
 * echo. Output with none of these in it is left whole. The cut is found on the text without
 * escape sequences and made in the raw.
 */
export function cutPlumbing(raw: string): string {
  const { text, map } = stripEscapes(raw);
  let from = 0;
  let to = text.length;
  let lastEcho = -1;
  for (const m of text.matchAll(WRAPPER_ECHO)) lastEcho = m.index!;
  if (lastEcho !== -1) {
    const nl = text.indexOf('\n', lastEcho);
    if (nl === -1) return '';
    from = nl + 1;
  }
  const start = startMark().exec(text.slice(from));
  if (start?.index === 0) {
    const nl = text.indexOf('\n', from + start[0].length);
    from = nl === -1 ? text.length : nl + 1;
  }
  const rest = text.slice(from);
  const end = [exitMark().exec(rest), probeMark().exec(rest)].filter((m): m is RegExpExecArray => m !== null).map((m) => m.index);
  if (end.length) to = from + Math.min(...end);
  const probe = PROBE_ECHO.exec(rest);
  if (probe && from + probe.index < to) {
    const nl = rest.lastIndexOf('\n', probe.index);
    to = from + (nl === -1 ? 0 : nl + 1);
  }
  if (from >= to) return '';
  // The raw cut begins right after the last plumbing character kept, so an escape that opens the
  // output (a colour set before its first character) stays with it.
  return raw.slice(from === 0 ? 0 : map[from - 1]! + 1, map[to] ?? raw.length);
}
