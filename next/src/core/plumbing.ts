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
 * (markerProbe, inlineProbe), and the cutter matches their echo from the same text; so is the line
 * that runs a Run's command file (sourceLine), whose echo the compat pack's logs find from it.
 */
import { isIntroducer, sequenceEnd, stripEscapes } from './text.js';
import type { RunStrategy } from './types.js';

const NONCE = '[^:>\\s]+';
/** Text as a regex that matches it alone. */
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
/** A piece of a declared shell's body acknowledged (inline strategy); group 1 is the piece's number. */
export const ackMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<ACK:${nonce}:(\\d+)>>>`);
/** A line of a declared shell's body that did not arrive whole, so the body was never run (inline strategy). */
export const goneMark = (nonce: string = NONCE): RegExp => new RegExp(`<<<GONE:${nonce}>>>`);
const MARK_NONCE = new RegExp(`<<<(?:START|EXIT|PROBE|ACK|GONE):(${NONCE})`);
/** The nonce a printed mark carries, for a reader that found the mark by its shape and must know whose it is (the compat pack's logs); undefined for text that is no mark. */
export const nonceOf = (mark: string): string | undefined => MARK_NONCE.exec(mark)?.[1];
/**
 * A typed line's text as the echo may show it: a line editor redrawing a long typed line can break
 * it anywhere, so whitespace may fall between any two characters, and bash 5.2 wrapping a line at a
 * narrow width writes the character at the margin again after a carriage return (`a1b2c\rc3d4`
 * inside a nonce: the house's read of 78c4d6e, #22, found such a probe line kept in a cancelled
 * Run's output), so any character may be followed by whitespace and itself again (the carriage
 * return is whitespace to the regex, and gone from stripEscapes's text). The unknown nonce keeps its class.
 * A run of whitespace in the typed text has one way to match, one `\s+` with no joins around it: as a
 * space between joins, each able to take any share of a run of spaces, it let a line of spaces after a
 * probe line's head backtrack polynomially, 9 s on one 3.2 kB line (the house's read of the 33 commits,
 * #22, comment 6307351104), on output any program prints, which the compat pack's logs read.
 */
const redrawn = (s: string): string => {
  if (s === NONCE) return NONCE;
  let out = '';
  let joined = false;
  for (const ch of s) {
    if (/\s/.test(ch)) {
      if (joined || !out) out += '\\s+';
      joined = false;
      continue;
    }
    const c = literal(ch);
    out += `${joined ? '\\s*' : ''}${c}(?:\\s*${c})?`;
    joined = true;
  }
  return out;
};
/** A mark's word as the typed lines spell it, split by two quotes (`EXI""T`), each piece as it may be redrawn. */
const splitWord = (a: string, b: string): string => `${redrawn(a)}\\s*(?:${redrawn('""')}|${redrawn("''")})\\s*${redrawn(b)}`;
/**
 * The echo of a typed line that runs a Run: the wrapper's end marker, through the end of the marker
 * strategy's typed line (a redraw that broke it after the nonce's colon left `$?>>>"` at the head of
 * the result: the house's read of the 33 commits, #22, comment 6307351104), or the inline start
 * marker, split.
 */
const wrapperEcho = (nonce: string): RegExp =>
  new RegExp(`${redrawn('<<<')}\\s*(?:${splitWord('EXI', 'T')}\\s*:\\s*${redrawn(nonce)}\\s*:(?:\\s*(?:${MARKER_RESTS.map(redrawn).join('|')}))?|${splitWord('STAR', 'T')}\\s*:\\s*${redrawn(nonce)}\\s*:)`, 'g');

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
/** How the session's own shell runs a typed line: POSIX (bash, dash, an unknown sh), zsh, or fish. */
export type ShellFlavor = 'posix' | 'zsh' | 'fish';
/** Text as one word for a POSIX shell or fish: single-quoted, each quote in it closed, escaped and reopened. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const COMMAND_FILE = 'tsm-cmd-';
/** A Run's command file's name: the integration scripts know the daemon's typed line by it. */
export const commandFile = (n: number): string => `${COMMAND_FILE}${n}`;
/**
 * The line typed to run a Run's command file: sourced text gets no history expansion, completion
 * or PS2 (G6). The leading space keeps it out of history where the shell honours ignorespace. An
 * integrated fish evaluates the file's text with `eval` (its integration's __tsm_collect prints
 * the file and returns the status the prompt had, so the text sees $status as a typed line would),
 * which runs it at the prompt's own level: jobs get process groups of their own, so cancel and
 * signal reach them and never fish (ss-2), and `set -l` persists as when typed (ss-11) — `source`
 * gave neither; without the integration fish has `source`. With `nonce`, the marker strategy's
 * line: its end mark is chained after it, with the shell's status. There a POSIX shell abandons
 * the rest of the typed line when a dot script has a syntax error or a special builtin fails;
 * `command .` strips that, so the chained mark still reports the status (ss-5). zsh never
 * abandons the line, and its `command` would look for an external `.`.
 */
export function sourceLine(file: string, flavor: ShellFlavor, nonce?: string): string {
  const marker = nonce !== undefined;
  const run = flavor === 'fish' ? (marker ? ` source ${shellQuote(file)}` : ` eval (__tsm_collect ${shellQuote(file)} $status)`) : ` ${marker && flavor === 'posix' ? 'command .' : '.'} ${shellQuote(file)}`;
  return marker ? `${run}; echo "<<<EXI""T:${nonce}:${flavor === 'fish' ? '$status' : '$?'}>>>"` : run;
}
/**
 * The first line of a marker Run's command file: it prints the Run's start mark, so the cutter has
 * a bound that lands after whatever the shell printed before it ran the file (the typed line's echo,
 * a still-starting shell's banner and its second echo, a redraw's pieces), and that no program's line
 * can stand in for: with the echo alone, a history line with the echo off (`fc -l -1`) was taken for
 * it and the output before it went (the house's read of the 33 commits, #22, comment 6307351104, and
 * its answer 2). Printed from the file, the typed line, its echo and its history entry stay as they
 * are. The status the shell had is kept for the body (`$?` after `false` is still 1; a subshell only
 * when it is not 0), restored in an AND-OR list's first place so `set -e` never ends the shell on it,
 * and the group's stderr goes to /dev/null so `set -x` traces none of it in dash and bash (zsh and
 * fish write their traces elsewhere). fish has no `$?` to restore with `exit`: a function returns it.
 * It adds one line, so a message that names a line of the body names the next one.
 */
export function markerStartLine(nonce: string, flavor: ShellFlavor): string {
  return flavor === 'fish'
    ? `begin; set -g __tsm_q $status; printf '<<<STAR''T:%s:%s>>>\\n' ${nonce} $fish_pid; function __tsm_rs; return $argv[1]; end; __tsm_rs $__tsm_q; end 2>/dev/null`
    : `{ __tsm_q=$?; printf '<<<STAR''T:%s:%s>>>\\n' ${nonce} "$$"; [ "$__tsm_q" = 0 ] || (exit "$__tsm_q") && :; } 2>/dev/null`;
}
/** Where a builder's line holds the nonce, to split it there: no builder types this character. */
const AT_NONCE = '\0';
/** Where a source line holds its command file's path: no builder types it, and quoting leaves it as it is. */
const AT_FILE = '\u0001';
/** What the marker strategy's typed line holds after its end mark's nonce and colon, for each flavor (`$?>>>"`, `$status>>>"`). */
const MARKER_RESTS = [...new Set((['posix', 'zsh', 'fish'] as const).map((f) => sourceLine(AT_FILE, f, AT_NONCE).split(AT_NONCE)[1]!.slice(1)))];
/**
 * Under `set -x`, the trace of the typed line that ran a command file (`+ command . /tmp/x/tsm-cmd-3`,
 * fish's `> source …`); group 1 is the trace's prefix, PS4 as the shell expanded it. The trace does not
 * quote the path, where the typed line, and so its echo, does.
 */
const RUN_TRACE = new RegExp(`(?:^|\\n)([^\\n]*?)(?:command \\.|\\.|source) /[^\\s']*/${literal(COMMAND_FILE)}\\d+\\r?(?=\\n|$)`);
/** A command file's path as a source line quotes it: any directory, then the file's name. */
const QUOTED_FILE = `'(?:[^'\\n]|'\\\\'')*/${literal(COMMAND_FILE)}\\d+'`;
/**
 * The echo of a line that runs a Run's command file, for each flavor, with and without the marker
 * strategy's end mark, taken from sourceLine with a placeholder path and nonce: the file's quoted
 * path matches any command file, the nonce any Run's. The longest first, so a line with its end mark
 * is matched whole. For a reader of the session's text as a whole (the compat pack's logs, which
 * kept a hand copy of these lines without fish's marker line: a reviewer's read of the fixes for #22).
 */
export const sourceLineEcho = (): RegExp => {
  const lines = new Set<string>();
  for (const flavor of ['posix', 'zsh', 'fish'] as const) for (const nonce of [undefined, AT_NONCE]) lines.add(sourceLine(AT_FILE, flavor, nonce));
  const pattern = (line: string) => line.split(shellQuote(AT_FILE)).map((part) => part.split(AT_NONCE).map(literal).join(NONCE)).join(QUOTED_FILE);
  return new RegExp([...lines].sort((a, b) => b.length - a.length).map(pattern).join('|'));
};
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
 * A Run's nonce as the session makes it, eight hex digits (randomBytes(4)), as a redraw may show it:
 * whitespace between any two digits, and a digit written again after a break (a line editor writes the
 * margin character again after a carriage return). Taken only where the rest of the typed line follows
 * (its `:` or `>`), so a line of hex printed after an echo is not taken in with it.
 */
const BROKEN_NONCE = '[0-9a-f](?:\\s*[0-9a-f]){7,8}(?=\\s*[:>])';
/** The probe lines' echo for a nonce pattern: each head, the nonce, then any of the rests that follow it. */
const probeEchoSource = (nonce: string): string =>
  [...PROBE_LINES].map(([head, rests]) => `${redrawn(head)}\\s*${nonce}(?:\\s*(?:${rests.map(redrawn).join('|')}))?`).join('|');
/** Any Run's: a nonce a redraw broke, or any unbroken one. Built once (see probeEcho). */
const PROBE_ECHO_ANY = probeEchoSource(`(?:${BROKEN_NONCE}|${NONCE})`);
/**
 * The echo of a probe line typed after a ^C, split, through the end of the typed line when it is
 * there. The rests that share a head are alternatives after it, so a line that is not the first's
 * still matches whole (one branch per line would stop sh's at the nonce of fish's line). With a
 * nonce, that Run's, as it may be redrawn; without, any Run's, a redraw's break inside the nonce
 * included: the unbroken nonce's class stopped at the break, and the line after it stayed in compat's
 * logs (the house's read of the 33 commits, #22, comment 6307351104). Matching any nonce by its class
 * keeps the pattern one size whatever the reader knows, built once: a pattern listing every nonce a
 * reader of the session's text knew, rebuilt per call, took compat's searchLogs seconds on a few
 * hundred lines (an independent read of that fix). Global: a reader strikes every line each match
 * spans, as cutPlumbing does, and the compat pack's logs use it so they cut the same echo.
 */
export const probeEcho = (nonce?: string): RegExp => new RegExp(nonce === undefined ? PROBE_ECHO_ANY : probeEchoSource(redrawn(nonce)), 'g');
/** A probe answer with its nonce (1), pid (2) and token (3). */
const probeAnswer = (nonce: string): RegExp => new RegExp(`<<<PROBE:(${nonce})(?::(\\d+)(?::(${NONCE}|))?)?>>>`, 'g');

/**
 * How each line the inline strategy types for a Run's body begins (session.ts inlineLines): the
 * first piece setting the body's variable, a later piece appending to it, and the line that runs it
 * after pieces, in sh's syntax and in fish's. A single line is a first piece that runs it too.
 */
const BODY_HEADS = [` __tsm_b='`, ` __tsm_b=\${__tsm_b-}'`, ` if [ "\${__tsm_b+set}" = set ]`, ` set -g __tsm_b '`, ` set -g __tsm_b "$__tsm_b"'`, ` if set -q __tsm_b; and `];
/**
 * The echo of a line the inline strategy typed for a declared shell's body, from its head to the end
 * of the line, for a reader of the session's text as a whole, as the terminal showed it, which no Run
 * renderer cuts for (the compat pack's logs): the compat pack kept its own copy of the marker
 * strategy's shapes, and a declared shell's typed body reached its logs (a reviewer's read of the
 * fixes for #22). The probe lines' echo is probeEcho's; the marks these lines print are startMark,
 * exitMark, ackMark and goneMark. A spec ties the heads to inlineLines.
 */
export const inlineTypedLine = (): RegExp => new RegExp(`(?:${BODY_HEADS.map(literal).join('|')})[^\\n]*`);

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
 * The text the cutter finds its marks in: `raw` without escape sequences, as stripEscapes reads it,
 * stripped in pieces that each begin where one of the marks the cutter looks for begins in the raw
 * (the Run's start, end and probe marks, and the typed lines' split mark words with the Run's
 * nonce), so no control string left open before a mark runs over it. The live session finds the marks in the raw output and starts
 * and ends the Run by them; a banner's lone U+009E (CP1252's `ž` read as Latin-1, a C1 string
 * introducer to the emulator and to stripEscapes), or an OSC a banner never closed, opened a string
 * that hid the start mark from the cut, which then kept every line, plumbing included, and one
 * opened in the body hid the end mark, which stayed in the result (an independent read of the fix
 * for the house's read of the 33 commits, #22, comment 6307351104). What a piece holds after such a
 * string is hidden as the emulator hides it, but its line ends stay in the text, so a line the cutter
 * strikes whole (a probe's echo) takes no line of output before it along; the cut through the mark
 * leaves the string's opening on the other side, so what comes after it shows as the emulator shows
 * the Run's output alone. `open` holds each text index whose raw gap before it lies in such a string.
 * A split word counts only with the Run's nonce, and with none recorded (a journal from before it
 * was) only the marks split: a program's own `<<<PRO""BE:` inside a title split the title, and its
 * payload showed (an independent read of that fix).
 */
function stripAtMarks(raw: string, nonce: string | undefined): { text: string; map: number[]; open: Set<number> } {
  const words = nonce === undefined ? '' : `|(?:EXI""T|STAR''T|PRO""BE|PRO''BE):${nonce}[:>]`;
  const marks = new RegExp(`<<<(?:(?:START|EXIT|PROBE):${nonce ?? NONCE}[:>]${words})`, 'g');
  const at = [...raw.matchAll(marks)].map((m) => m.index).filter((i) => i > 0);
  const open = new Set<number>();
  if (!at.length) return { ...stripEscapes(raw), open };
  let text = '';
  const map: number[] = [];
  const bounds = [0, ...at, raw.length];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const slice = raw.slice(bounds[k], bounds[k + 1]);
    const piece = stripEscapes(slice);
    text += piece.text;
    for (const i of piece.map) map.push(i + bounds[k]!);
    if (k + 2 === bounds.length) break;
    // Where stripEscapes stopped: past what it kept, the first sequence that does not end in the piece.
    let cut = piece.map.length ? piece.map[piece.map.length - 1]! + 1 : 0;
    while (cut < slice.length) {
      if (!isIntroducer(slice.charCodeAt(cut))) cut++;
      else {
        const end = sequenceEnd(slice, cut);
        if (end === undefined) break;
        cut = end;
      }
    }
    if (cut === slice.length) continue;
    for (let i = slice.indexOf('\n', cut); i !== -1; i = slice.indexOf('\n', i + 1)) {
      open.add(text.length);
      text += '\n';
      map.push(i + bounds[k]!);
    }
    open.add(text.length); // the next piece's first character
  }
  return { text, map, open };
}

/**
 * A shell Run's output without the daemon's plumbing, the one rule for the live transcript and
 * for history. Under `rich` nothing is cut: the output runs from the pre-execution mark to the
 * end mark, and the marks are not output. Under `basic` the first line is the echo of the typed
 * line. Under `marker` and `inline` the marks carry the Run's nonce, and the cut is by it:
 * everything through the start mark's line, which the inline strategy's typed line prints and the
 * marker strategy's command file prints from its first line (markerStartLine), so whatever the
 * shell printed before it ran the Run goes, the echo of the typed line and a slow shell's banner and
 * second echo included, and a later line in the echo's shape is the program's; with a recorded nonce
 * the mark is the Run's own wherever an echo-shaped line falls (the house's read of the 33 commits,
 * #22, comment 6307351104: with the echo off, `fc -l -1` printed the typed line after the output had
 * begun, and the rule that let it stand for the echo cut what came before it). A marker Run whose
 * file never ran (a program read the typed line) has no start mark, and its echo is cut by today's
 * rule: the lines echoing the typed line without a break (typed ahead of the prompt it echoes twice,
 * and a redraw shows it in pieces), from its first line wherever it is, with everything before it;
 * a still-starting shell's second echo then stays, and with the echo off a program's line in the
 * echo's shape is taken for it. Without a recorded nonce, the echo is cut at the output's head, and
 * a start mark only when no echo comes before it. Everything from the end marker on goes, or from the
 * probe answer the session accepted; and under `set -x`, the end mark's own trace, when the typed
 * line's trace before the start mark shows the shell was tracing (the same read). Before that
 * end, every line of each probe's echo and every rejected answer's line is struck on its own, and the
 * output between them stays: a probe the session rejected (answered by a nested shell: its pid is
 * not the one the start marker named, or its token is not the Run's) is not an end (the house's
 * read of 39787b3, #22), and a probe nothing answered, because a program ignoring ^C read it,
 * leaves only its echo behind, with what the program printed after it still output (the house's
 * read of 78c4d6e, #22: the cut moved back to that echo and the output after it was gone).
 * Without a recorded nonce the same shapes are found with any nonce, which can take a program
 * line in a mark's shape for one. The cut is found on the text without escape sequences
 * (stripAtMarks) and made in the raw (keptRanges).
 */
export function cutPlumbing(raw: string, of: PlumbingOf = {}): string {
  return keptRanges(raw, of)
    .map(([s, e]) => raw.slice(s, e))
    .join('');
}

/**
 * The raw slices cutPlumbing keeps, `[start, end)` in order and none empty: for a reader that reports
 * where in the journal a Run's output is (the reader's Run read), not only what it says.
 */
export function keptRanges(raw: string, of: PlumbingOf = {}): Array<[number, number]> {
  const whole = (s: number): Array<[number, number]> => (s < raw.length ? [[s, raw.length]] : []);
  if (of.strategy === 'rich') return whole(0);
  if (of.strategy === 'basic') {
    if (of.truncated) return whole(0);
    const nl = raw.indexOf('\n');
    return nl === -1 ? [] : whole(nl + 1);
  }
  const nonce = of.nonce ?? NONCE;
  const { text, map, open } = stripAtMarks(raw, of.nonce);
  let from = 0;
  let pid: string | undefined = of.pid;
  const echoes = [...text.matchAll(wrapperEcho(nonce))].map((m) => [m.index, m.index + m[0].length] as const);
  const start = startMark(nonce).exec(text);
  const own = of.nonce !== undefined && (of.strategy === 'marker' || of.strategy === 'inline');
  // Set when a marker Run's start mark bounds its output: the prefix of the typed line's trace before
  // the mark, when the shell was tracing (set -x), or null.
  let trace: string | null | undefined;
  if (start && (own || echoes.length === 0 || echoes[0]![0] < start.index)) {
    // The Run's output begins after its start marker: what the text holds before it is the shell's,
    // not the Run's (the typed line's echo, a banner or prompt a slow shell printed after the line
    // was typed, a redraw's pieces, the inline pieces' acknowledgements), and a line in the echo's
    // shape after the marker is the program's (`history 1` prints the typed line with the Run's own
    // nonce, and the rule that took the last such line for the echo cut everything before it: the
    // house's read of 78c4d6e, #22, comment 6269901528).
    pid = start[1];
    const nl = text.indexOf('\n', start.index + start[0].length);
    from = nl === -1 ? text.length : nl + 1;
    if (of.strategy === 'marker') trace = RUN_TRACE.exec(text.slice(0, start.index))?.[1] ?? null;
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
    // starting when the line was typed shows it again after its banner, which a marker Run whose
    // file never ran, with no start mark to cut to, cannot tell from the program's: those lines stay.
    const first = echoes[0];
    const anywhere = of.strategy === 'marker' && !of.truncated;
    const headEnd = text.indexOf('\n') === -1 ? text.length : text.indexOf('\n');
    if (first && (anywhere || first[0] < headEnd)) {
      from = anywhere ? text.lastIndexOf('\n', first[0] - 1) + 1 : 0;
      // The echoes and the lines both go forward: an index into the echoes, not a search of them all per line.
      for (let k = 0; ; ) {
        const nl = text.indexOf('\n', from);
        const lineEnd = nl === -1 ? text.length : nl;
        while (k < echoes.length && echoes[k]![1] <= from) k++;
        if (k === echoes.length || echoes[k]![0] >= lineEnd) break;
        if (nl === -1) return [];
        from = nl + 1;
      }
    }
    // The inline strategy's start mark is journaled before the Run's output, which begins with that
    // line's end; a read that began later (a page, a tail) begins with the output's own blank line.
    if (of.strategy === 'inline' && !of.truncated && text[from] === '\n') from++;
  }
  const rest = text.slice(from);
  let to = exitMark(nonce).exec(rest)?.index ?? rest.length;
  if (trace !== undefined) {
    // Tracing, the shell prints the end mark's echo (`+ echo <<<EXIT:…:0>>>`, bash quoting the word)
    // before the mark itself, and the first mark ends the Run: that trace's head is plumbing too. Its
    // prefix is the one the typed line's trace showed, or, in the Run that turned tracing on, PS4's
    // default at a line's start.
    const before = rest.slice(0, to);
    const tail = trace !== null ? [`${trace}echo '`, `${trace}echo `].find((t) => before.endsWith(t)) : /(?:^|\n)(\+ echo '?)$/.exec(before)?.[1];
    if (tail) to -= tail.length;
  }
  const struck: Array<[number, number]> = [];
  // Strikes the lines from a match's first character to its last. Matches come in order, and one
  // inside the lines struck last is passed over: scanning to its line's ends again for every match
  // held the event loop for half a minute on a line of 100,000 probe-shaped fragments, which a
  // journal recorded with no nonce reads by shape (an independent read of the fix for the house's
  // read of the 33 commits, #22, comment 6307351104).
  const striker = (): ((i: number, j: number) => void) => {
    let end = 0;
    return (i, j) => {
      if (j < end) return;
      const s = i < end ? end : rest.lastIndexOf('\n', i - 1) + 1;
      const nl = rest.indexOf('\n', j);
      end = nl === -1 ? rest.length : nl + 1;
      struck.push([s, end]);
    };
  };
  const strikeAnswer = striker();
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
    strikeAnswer(m.index, m.index);
  }
  // Each probe's echo before the end is plumbing on its own, the accepted probe's included, every
  // line of it: a redraw can break the typed line, its nonce included, over two lines, and striking
  // only the line where it began kept the rest (the house's read of the 38 commits, #22, comment
  // 6274773484). A probe nothing answered leaves only its echo, and what was printed after it stays.
  const strikeEcho = striker();
  for (const m of rest.matchAll(probeEcho(of.nonce))) {
    if (m.index >= to) break;
    strikeEcho(m.index, m.index + m[0].length - 1);
  }
  // Each kept piece, and whether it ends where a struck line begins.
  const kept: Array<[number, number, boolean]> = [];
  let pos = 0;
  for (const [s, e] of struck.sort((a, b) => a[0] - b[0])) {
    if (s >= to) break;
    if (s > pos) kept.push([pos, s, true]);
    pos = Math.max(pos, e);
  }
  if (pos < to) kept.push([pos, to, false]);
  // Each raw piece begins right after the last plumbing character before it, so an escape that
  // opens the output (a colour set before its first character) stays with it, and ends at the next
  // one's first character, so an escape before a struck line (a colour, a title, a link's start)
  // stays and sets what follows as it did. Where that gap lies in a string a piece left open
  // (stripAtMarks), the struck line's head is in it, which the text does not hold, and the piece ends
  // right after the line end before it instead: ending at the line's first character in the text
  // kept that head; ending after the line end everywhere dropped those escapes (an independent read
  // of the fix).
  return kept
    .map(([s, e, atLine]): [number, number] => [from + s === 0 ? 0 : map[from + s - 1]! + 1, atLine && open.has(from + e) ? map[from + e - 1]! + 1 : (map[from + e] ?? raw.length)])
    .filter(([s, e]) => s < e);
}
