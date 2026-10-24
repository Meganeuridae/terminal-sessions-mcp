/**
 * The marks a shell Run's plumbing prints, and what readers cut around them: one shape each,
 * defined here for the session that prints and parses them live and for the one cutter that
 * removes them from a Run's output, live (Session.runTranscript) and from history (the
 * segmenter's journalRunText). The house's reads of a6d0c35 and 1cabc6a (#22) changed the shapes
 * in the session and found three readers parsing the old ones; its read of 39787b3 found the
 * history cutter working by shape alone, so a program line in a mark's shape cut real output.
 *
 * Shapes: the start marker `<<<START:nonce:pid>>>` (both strategies name the shell's pid: a
 * declared shell's typed line prints it, and a marker Run's command file from its first line), the
 * end marker `<<<EXIT:nonce:status>>>` (both strategies), and the end-marker probe typed after a ^C:
 * `<<<PROBE:nonce:pid>>>` under the marker strategy, with the pid of the process that evaluated it, which
 * ends the Run only when it is the pid the start marker named (an earlier build's probe, which
 * journals keep, printed none: `<<<PROBE:nonce>>>`), and
 * inline `<<<PROBE:nonce:pid:token>>>`, where the token is the Run's nonce again, printed from a shell
 * variable the Run's own line set — a nested shell, with another pid or the same one in another
 * PID namespace, has no such variable and answers with an empty token (the house's read of
 * 39787b3, #22). The typed lines that print them spell each word split (`EXI""T`, `STAR''T`,
 * `PRO""BE`), so an echo of the typed line never matches a mark, and the marker strategy's are
 * printf-built, so a `set -x` trace of one never holds a whole mark either. The probe lines are
 * built here (markerProbe, inlineProbe), and the cutter matches their echo from the same text; so
 * is the line that runs a Run's command file (sourceLine), whose echo the compat pack's logs find
 * from it.
 */
import { isIntroducer, sequenceEnd, stripEscapes } from './text.js';
import type { RunStrategy } from './types.js';

/** A nonce as any mark or typed line holds it: up to the field's end, or the quote a typed line closes after it. */
const NONCE = '[^:>"\\s]+';
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
 * return is whitespace to the regex, and gone from stripEscapes's text). fish 4 and 3.7 wrap at the
 * margin by writing a line end and moving back up, and write the two cells before the margin again on
 * both sides of it (`'%s>>>>` then `>>\n'` for `'%s>>>\n'`, or `"<` then `"<<<`), so a character may also
 * be followed by the one typed before it and itself again; striking from the line where the mark began
 * kept the typed line's head (a cancel's probe on CI's fish, behind a long prompt). `before` is what
 * the line typed before `s`, for the first character's. The unknown nonce keeps its class.
 * A run of whitespace in the typed text has one way to match, one `\s+` with no joins around it: as a
 * space between joins, each able to take any share of a run of spaces, it let a line of spaces after a
 * probe line's head backtrack polynomially, 9 s on one 3.2 kB line (the house's read of the 33 commits,
 * #22, comment 6307351104), on output any program prints, which the compat pack's logs read.
 */
const redrawn = (s: string, before = ''): string => {
  if (s === NONCE) return NONCE;
  let out = '';
  let joined = false;
  // The typed character before this one, when it is no whitespace: a cell a line editor may write again.
  let prev = /\S$/.test(before) ? literal(before.at(-1)!) : undefined;
  for (const ch of s) {
    if (/\s/.test(ch)) {
      if (joined || !out) out += `\\s+${prev ? `(?:${prev}\\s+)?` : ''}`;
      joined = false;
      prev = undefined;
      continue;
    }
    const c = literal(ch);
    out += `${joined ? '\\s*' : ''}${c}(?:\\s*${c}${prev ? `|\\s*${prev}\\s*${c}` : ''})?`;
    joined = true;
    prev = c;
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
  new RegExp(`${redrawn('<<<')}\\s*(?:${splitWord('EXI', 'T')}\\s*:\\s*${redrawn(nonce)}(?:\\s*(?:${MARKER_RESTS.map((r) => redrawn(r)).join('|')}))?|${splitWord('STAR', 'T')}\\s*:\\s*${redrawn(nonce)}\\s*:)`, 'g');
/**
 * The echo of the line typed to run the Run with this nonce, as the cut finds it, for a reader that sees
 * a marker or inline Run's output a line at a time and drops what the cut drops (the segmenter's
 * running digests).
 */
export const runEcho = (nonce: string): RegExp => new RegExp(wrapperEcho(nonce).source);

/** How the session's own shell runs a typed line: POSIX (bash, dash, an unknown sh), zsh, or fish. */
export type ShellFlavor = 'posix' | 'zsh' | 'fish';
const FLAVORS = ['posix', 'zsh', 'fish'] as const;
/**
 * A command the marker strategy types after the shell's own, in a group whose `set -x` trace dash,
 * bash and zsh write, on a typed line, to the group's stderr, here nowhere. fish writes its trace past
 * any redirect, and so does bash given a BASH_XTRACEFD: the marks are printf-built so that no trace
 * holds a whole mark, and the cutter names that trace by the Run's nonce (markTraceStart).
 */
const untraced = (command: string, flavor: ShellFlavor): string => (flavor === 'fish' ? command : `{ ${command}; } 2>/dev/null`);
/**
 * A mark printed by printf with its `>>>` in the format and its word and nonce in an argument, so
 * that a `set -x` trace of the line (`+ printf %s>>>\n <<<PROBE:nonce`) never holds a whole mark:
 * dash traced the echo that printed the end mark as the mark itself, the Run ended at the trace, and
 * the real mark came after the Run's end (the house's review of the 40 commits through f3750e4, PR
 * #22, comment 6310921374, question 2). The word stays split, so the typed line's echo matches no
 * mark either. `fields` are printf's words for the fields after the nonce, each a `:%s` in the format.
 */
const printedMark = (word: string, nonce: string, fields: string[] = []): string =>
  `printf '%s${':%s'.repeat(fields.length)}>>>\\n' "<<<${word}:${nonce}"${fields.map((f) => ` ${f}`).join('')}`;
/**
 * The end-marker probe the marker strategy types after a ^C: a marker of its own, split so echoes
 * never match, and printf-built so no trace of it is one (printedMark), its trace kept off the
 * terminal where the shell allows (untraced). It confirms the shell is back, never the command's
 * status; and the command's own end marker, arriving after a cancel that failed, still reads as the
 * end it is (the house's read of a6d0c35, #22). It names the pid of the shell that runs it, as the
 * start mark does, so an answer counts only from the session's shell: a reader the Run started in the
 * shell's own process group (job control off) took the probe, answered it, and the shell counted as
 * back while the reader held the terminal (an independent read of the fixes for #22). The pid is that
 * of the process that evaluates the line, a child's parent: the shell's `$$` is kept by a subshell, and
 * with job control off a subshell of the Run that evaluated what it read answered as the shell, so the
 * Run ended cancelled, the shell counted idle, and a queued Run ran inside the subshell (the house's
 * review of 4f4c067..a8b6f28, PR #22, comment 6323055715, question 7, by run on dash). In the shell it
 * is the start mark's `$$`; a probe is typed only after a cancel, so its fork and exec cost nothing
 * that matters. fish has no subshells, and `$fish_pid` is the evaluating fish's. The end mark names no
 * pid: only the line typed for this Run prints it, read before the Run's program began.
 */
export const markerProbe = (nonce: string, flavor: ShellFlavor = 'posix'): string =>
  ` ${untraced(printedMark('PRO""BE', nonce, [flavor === 'fish' ? '$fish_pid' : EVALUATING_PID]), flavor)}`;
/** The pid of the process that evaluates the word: the parent of a child it starts for the purpose. */
const EVALUATING_PID = `"$(exec /bin/sh -c 'echo $PPID')"`;
/**
 * The probe the inline strategy types after a ^C (which may have cut the line before its end
 * marker): a marker of its own, with the Run's nonce, the pid of the shell that runs it, and the
 * token the Run's own line set in that shell (its nonce again). A nested shell the Run started
 * prints its own pid and an empty token: pids alone repeat across PID namespaces (`docker run -it
 * … sh` is pid 1), the variable does not travel (the house's read of 39787b3, #22). The pid is the
 * evaluating process's (INLINE_PID), as the marker probe's is, but for the fallback below: a
 * subshell keeps both the shell's `$$` and the unexported token, and with job control off a subshell
 * of the Run that evaluated what it read answered as the declared shell, so the Run ended cancelled
 * and the next Run ran inside the subshell (the house's review of a8b6f28..4860d4c, PR #22, by run with a declared dash). Its child is
 * the declared shell's `/bin/sh`, on that shell's host, which may be a container or another machine:
 * where it has none, the pid prints empty (the error goes to /dev/null), the answer is no probe mark,
 * and a cancel there cannot end by the probe. bash's restricted mode (rbash, as a jump host may
 * give) refuses the path and the redirect: it prints its refusal of the redirect and answers with its
 * own `$$`, so there a subshell answers as the shell, as every one did before the probe named the
 * evaluating process; with no fallback it printed `exec: restricted` and an empty pid, and its cancel
 * could not end by the probe (the house's review of 4860d4c..bc4bc85, PR #22, by run in bash 5.2.37).
 * zsh's restricted mode still does: its refused `exec` ends the substitution before the fallback (by
 * run in zsh 5.9), as a missing `/bin/sh` does.
 */
export const inlineProbe = (nonce: string, fish: boolean): string => inlineProbeNaming(nonce, fish ? '$fish_pid' : INLINE_PID, fish);
/** The evaluating process's pid, or where its child cannot start in a restricted shell, the shell's own. */
const INLINE_PID = `"$(exec /bin/sh -c 'echo $PPID' 2>/dev/null || echo $$)"`;
const inlineProbeNaming = (nonce: string, pid: string, fish: boolean): string => ` printf '<<<PRO''BE:${nonce}:%s:%s>>>\\n' ${pid} ${fish ? '"$__tsm_r"' : '"${__tsm_r-}"'}`;
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
 * line: its end mark is chained after it, with the shell's status, printf-built (printedMark) and
 * untraced where the shell allows. There a POSIX shell abandons the rest of the typed line when a dot
 * script has a syntax error or a special builtin fails; `command .` strips that, so the chained mark
 * still reports the status (ss-5). zsh never abandons the line, and its `command` would look for an
 * external `.`.
 */
export function sourceLine(file: string, flavor: ShellFlavor, nonce?: string): string {
  if (nonce === undefined) return flavor === 'fish' ? ` eval (__tsm_collect ${shellQuote(file)} $status)` : ` . ${shellQuote(file)}`;
  return `${markerRun(file, flavor)}; ${untraced(printedMark('EXI""T', nonce, [flavor === 'fish' ? '$status' : '"$?"']), flavor)}`;
}
/** How the marker strategy's typed line runs the command file, before its end mark. */
const markerRun = (file: string, flavor: ShellFlavor): string => (flavor === 'fish' ? ` source ${shellQuote(file)}` : ` ${flavor === 'posix' ? 'command .' : '.'} ${shellQuote(file)}`);
/**
 * The marker strategy's typed line as builds before its end mark was printf-built typed it, an echo:
 * journals keep its echo, which the cutter and the compat pack's logs still find.
 */
const legacySourceLine = (file: string, flavor: ShellFlavor, nonce: string): string =>
  `${markerRun(file, flavor)}; echo "<<<EXI""T:${nonce}:${flavor === 'fish' ? '$status' : '$?'}>>>"`;
/**
 * The first line of a marker Run's command file: it prints the Run's start mark, so the cutter has
 * a bound that lands after whatever the shell printed before it ran the file (the typed line's echo,
 * a still-starting shell's banner and its second echo, a redraw's pieces), and that no program's line
 * can stand in for: with the echo alone, a history line with the echo off (`fc -l -1`) was taken for
 * it and the output before it went (the house's read of the 33 commits, #22, comment 6307351104, and
 * its answer 2). Printed from the file, the typed line, its echo and its history entry stay as they
 * are. With `restore`, the status the shell had is kept for the body (`$?` after `false` is still 1),
 * restored in an AND-OR list's first place so `set -e` never ends the shell on it, and nothing the
 * line sets stays in the user's shell, as the integrations' temporaries do not (`__tsm_q` stayed set:
 * the house's review of the 40 commits through f3750e4, PR #22, comment 6310921374). POSIX needs no
 * variable: a case on `$?` prints the mark when the status is 0, and otherwise has /bin/sh print it and
 * exit with the status, so the mark is the last thing the line does and nothing of it is traced after
 * the mark, even where a BASH_XTRACEFD sends bash's trace past the group's redirect (the restore's
 * eval, unset and test, traced after the mark, stayed at the head of every such Run's result: the
 * house's review of f3750e4..4f4c067, PR #22, comment 6315636412, question 6); a child process only
 * when the status is not 0. zsh keeps the status local to a function; fish, whose source gives the
 * file a scope of its own, erases it from a function that sees the file's (`-S`), and the function
 * erases itself. dash and bash trace none of the line under `set -x` otherwise (the group's stderr is
 * /dev/null); zsh and fish trace a sourced file's commands whatever their stderr, so each runs the
 * mark from a function with its trace off, traced only up to the call, before the mark, and zsh's
 * AND-OR list ends in an empty group, which it does not trace (a block's end, and a `:`, were traced
 * after the mark). It adds one line, so a message that names a line of the body names the next one.
 */
export function markerStartLine(nonce: string, flavor: ShellFlavor, restore = true): string {
  const format = `'<<<STAR''T:%s:%s>>>\\n'`;
  const mark = `printf ${format} ${nonce} ${flavor === 'fish' ? '$fish_pid' : '"$$"'}`;
  if (flavor === 'fish') {
    const quiet = 'set -l fish_trace; functions -e __tsm_start';
    return restore
      ? `set -l __tsm_q $status; function __tsm_start -S; ${quiet}; set -e __tsm_q; ${mark}; return $argv[1]; end; __tsm_start $__tsm_q`
      : `function __tsm_start; ${quiet}; ${mark}; end; __tsm_start`;
  }
  if (flavor === 'zsh') return restore ? `() { local __tsm_q=$?; setopt localoptions noxtrace; ${mark}; return $__tsm_q; } && { }` : `() { setopt localoptions noxtrace; ${mark}; }`;
  const child = `/bin/sh -c 'printf "$1" "$2" "$3"; exit "$4"' sh ${format} ${nonce} "$$" "$?" && :`;
  return restore ? `{ case $? in 0) ${mark};; *) ${child};; esac; } 2>/dev/null` : `{ ${mark}; } 2>/dev/null`;
}
/**
 * A marker Run's command file: its start line, then the body. A body of blank lines and comments runs
 * no command, so the start line would be the file's last, and the status it restores the file's:
 * after `set -e; ! true` that status is 1, `command .` returns it, and `set -e` ended the shell (the
 * house's review of the 40 commits through f3750e4, PR #22, comment 6310921374). Nothing reads the
 * status there, so such a body's start line restores none, and the Run exits 0, as a sourced file
 * that runs nothing does and as a comment does under the integrations.
 */
export function markerCommandText(body: string, nonce: string, flavor: ShellFlavor): string {
  return `${markerStartLine(nonce, flavor, !/^(?:[ \t]*(?:#[^\n]*)?(?:\n|$))*$/.test(body))}\n${body}`;
}
/** Where a builder's line holds the nonce, to split it there: no builder types this character. */
const AT_NONCE = '\0';
/** Where a source line holds its command file's path: no builder types it, and quoting leaves it as it is. */
const AT_FILE = '\u0001';
/** The marker strategy's typed lines for each flavor, as this build types them and as earlier builds did (journals keep their echo). */
const MARKER_LINES = FLAVORS.flatMap((f) => [sourceLine(AT_FILE, f, AT_NONCE), legacySourceLine(AT_FILE, f, AT_NONCE)]);
/** What the marker strategy's typed lines hold after their end mark's nonce (`" "$?"; } 2>/dev/null`, an earlier build's `:$?>>>"`). */
const MARKER_RESTS = [...new Set(MARKER_LINES.map((line) => line.split(AT_NONCE)[1]!))];
/**
 * Under `set -x`, the trace of the typed line that ran a command file (`+ command . /tmp/x/tsm-cmd-3`,
 * fish's `> source …`); group 1 is the trace's prefix, PS4 as the shell expanded it, with whatever the
 * line held before it (see tracePrefix). The trace quotes the path only where it holds a character the
 * shell would (a space, in a session's own directory under a data dir with one), where the typed line,
 * and so its echo, always does; an apostrophe in it is quoted as `'\''`, as shellQuote writes it (a data
 * dir with one left the prefix unread, and the cutter took an unterminated last line with the trace: a
 * reviewer's read of the fixes for #22, by run in bash 5.2.37).
 */
const RUN_TRACE = new RegExp(`(?:^|\\n)([^\\n]*?)(?:command \\.|\\.|source) (?:/[^\\s']*|'/(?:[^'\\n]|'\\\\'')*)/${literal(COMMAND_FILE)}\\d+'?\\r?(?=\\n|$)`);
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
  const lines = new Set<string>([...FLAVORS.map((f) => sourceLine(AT_FILE, f)), ...MARKER_LINES]);
  const pattern = (line: string) => line.split(shellQuote(AT_FILE)).map((part) => part.split(AT_NONCE).map(literal).join(NONCE)).join(QUOTED_FILE);
  return new RegExp([...lines].sort((a, b) => b.length - a.length).map(pattern).join('|'));
};
/**
 * The typed probe lines around their nonce, taken from the builders above: each head, from its
 * mark's `<<<` up to the nonce, with the leads of the lines that come before it and the rests that
 * follow the nonce after it. The cutter's copy of the rests was written by hand beside the builders,
 * so a change to one could leave the echo of the line it types in a Run's output (a reviewer's read
 * of the fixes for #22). The leads are matched when they are there, so a line editor that broke the
 * typed line before its mark leaves no piece of it on the line before (see redrawn).
 */
const PROBE_LINES = new Map<string, { leads: string[]; rests: string[] }>();
/** The marker strategy's probe as builds before it was printf-built typed it, which journals keep. */
const LEGACY_PROBE = ` echo "<<<PRO""BE:${AT_NONCE}>>>"`;
/**
 * The marker strategy's probe as builds before it named the shell's pid typed it, printf-built: its lead
 * stayed on a program's prompt line once the probe named a pid (a reviewer's read of the fixes for #22);
 * and as builds before it named the evaluating process's typed it, naming the shell's `$$`.
 */
const PIDLESS_PROBES = [...FLAVORS.map((f) => ` ${untraced(printedMark('PRO""BE', AT_NONCE), f)}`), ...(['posix', 'zsh'] as const).map((f) => ` ${untraced(printedMark('PRO""BE', AT_NONCE, ['"$$"']), f)}`)];
/**
 * The inline strategy's POSIX probe as earlier builds typed it, which journals keep: naming the shell's `$$`, then the
 * evaluating process's with no fallback. An echo of one broken after its nonce kept the rest of its line in the logs (the
 * house's review of 4860d4c..bc4bc85, PR #22).
 */
const EARLIER_INLINE_PROBES = ['"$$"', EVALUATING_PID].map((pid) => inlineProbeNaming(AT_NONCE, pid, false));
for (const line of [...FLAVORS.map((f) => markerProbe(AT_NONCE, f)), ...PIDLESS_PROBES, LEGACY_PROBE, inlineProbe(AT_NONCE, false), inlineProbe(AT_NONCE, true), ...EARLIER_INLINE_PROBES]) {
  const [before, after] = line.split(AT_NONCE) as [string, string];
  const at = before.indexOf('<<<');
  const lines = PROBE_LINES.get(before.slice(at)) ?? { leads: [], rests: [] };
  const lead = before.slice(0, at).trim();
  if (!lines.leads.includes(lead)) lines.leads.push(lead);
  lines.rests.push(after);
  PROBE_LINES.set(before.slice(at), lines);
}
/**
 * A Run's nonce as the session makes it, eight hex digits (randomBytes(4)), as a redraw may show it:
 * whitespace between any two digits, and a digit written again after a break (a line editor writes the
 * margin character again after a carriage return, fish the two before the margin). Taken only where
 * the rest of the typed line follows (its `:`, `>` or closing quote), so a line of hex printed after an
 * echo is not taken in with it.
 */
const BROKEN_NONCE = '[0-9a-f](?:\\s*[0-9a-f]){7,10}(?=\\s*[:>"])';
/**
 * The probe lines' echo, for a Run's nonce or, without one, any nonce: each head, after any of its
 * leads, the nonce, then any of the rests that follow it. A known nonce is redrawn with the head's
 * last character before it, and the rests with the nonce's.
 */
const probeEchoSource = (nonce?: string): string =>
  [...PROBE_LINES]
    .map(([head, { leads, rests }]) => {
      const lead = `(?:(?:${[...leads].sort((a, b) => b.length - a.length).map((l) => redrawn(l)).join('|')})\\s*)?`;
      const n = nonce === undefined ? `(?:${BROKEN_NONCE}|${NONCE})` : redrawn(nonce, head);
      return `${lead}${redrawn(head, leads[0])}\\s*${n}(?:\\s*(?:${rests.map((r) => redrawn(r, nonce)).join('|')}))?`;
    })
    .join('|');
/** Any Run's: a nonce a redraw broke, or any unbroken one. Built once (see probeEcho). */
const PROBE_ECHO_ANY = probeEchoSource();
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
export const probeEcho = (nonce?: string): RegExp => new RegExp(nonce === undefined ? PROBE_ECHO_ANY : probeEchoSource(nonce), 'g');
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
 * the Run's output alone. `open` maps each text index whose raw gap before it lies in such a string
 * to the raw index of the string's introducer.
 * A split word counts only with the Run's nonce, and with none recorded (a journal from before it
 * was) only the marks split: a program's own `<<<PRO""BE:` inside a title split the title, and its
 * payload showed (an independent read of that fix).
 */
function stripAtMarks(raw: string, nonce: string | undefined): { text: string; map: number[]; open: Map<number, number> } {
  const words = nonce === undefined ? '' : `|(?:EXI""T|STAR''T|PRO""BE|PRO''BE):${nonce}[:>"]`;
  const marks = new RegExp(`<<<(?:(?:START|EXIT|PROBE):${nonce ?? NONCE}[:>]${words})`, 'g');
  const at = [...raw.matchAll(marks)].map((m) => m.index).filter((i) => i > 0);
  const open = new Map<number, number>();
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
      open.set(text.length, cut + bounds[k]!);
      text += '\n';
      map.push(i + bounds[k]!);
    }
    open.set(text.length, cut + bounds[k]!); // the next piece's first character
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
 * probe answer the session accepted, and before it the trace of the command that printed it, where
 * the shell wrote one (markTraceStart). Before that end, every line of each probe's echo and every
 * rejected answer's line is struck on its own, and the output between them stays: a probe the
 * session rejected (answered by a nested shell: its pid is not the one the start marker named, or
 * its token is not the Run's) is not an end (the house's read of 39787b3, #22), and a probe nothing
 * answered, because a program ignoring ^C read it, leaves only its echo behind, with what the
 * program printed after it still output (the house's read of 78c4d6e, #22: the cut moved back to
 * that echo and the output after it was gone).
 * A struck line that opened a string running past its end keeps the string: from its introducer on,
 * and the whole line when the echo is itself inside it (a probe a program read, typed after the
 * program opened an OSC on that line), as the emulator hides it all; striking the introducer showed
 * the payload's rest, where the Run's raw output projects without it (the house's review of the 40
 * commits through f3750e4, PR #22, comment 6310921374). Without a recorded nonce the same shapes are
 * found with any nonce, which can take a program line in a mark's shape for one. The cut is found on
 * the text without escape sequences (stripAtMarks) and made in the raw (keptRanges).
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
  // The prefix of the typed line's trace before a marker Run's start mark, when the shell was tracing.
  let trace: string | undefined;
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
    if (of.strategy === 'marker') trace = tracePrefix(raw, text, map, start.index);
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
  // Each struck line, and where in the raw the output resumes after it when a string it opened runs on.
  const struck: Array<[number, number, number | undefined]> = [];
  const opens = [...open.keys()]; // in increasing order, as stripAtMarks added them
  const ends = new Map<number, number | undefined>();
  // Whether the string introduced at raw index `o` is still open at `rawEnd`.
  const runsPast = (o: number, rawEnd: number): boolean => {
    if (!ends.has(o)) ends.set(o, sequenceEnd(raw, o));
    const e = ends.get(o);
    return e === undefined || e > rawEnd;
  };
  // Strikes the lines from a match's first character to its last. Matches come in order, and one
  // inside the lines struck last is passed over: scanning to its line's ends again for every match
  // held the event loop for half a minute on a line of 100,000 probe-shaped fragments, which a
  // journal recorded with no nonce reads by shape (an independent read of the fix for the house's
  // read of the 33 commits, #22, comment 6307351104). A string the line opened that runs past it
  // keeps what it hides (see above).
  const striker = (): ((i: number, j: number, wholeLine?: boolean) => void) => {
    let end = 0;
    return (i, j, wholeLine = true) => {
      if (j < end) return;
      const lineStart = rest.lastIndexOf('\n', i - 1) + 1;
      // From the match's own start, the typed line's leading space with it, and then the line end stays.
      const s = i < end ? end : wholeLine ? lineStart : i > lineStart && rest[i - 1] === ' ' ? i - 1 : i;
      const nl = rest.indexOf('\n', j);
      end = nl === -1 ? rest.length : !wholeLine && s > lineStart ? nl : nl + 1;
      const lineRaw = from + s === 0 ? 0 : map[from + s - 1]! + 1;
      const lineRawEnd = map[from + end - 1]! + 1;
      const inside = open.get(from + i);
      if (inside !== undefined && inside >= lineRaw && runsPast(inside, lineRawEnd)) return;
      let resume: number | undefined;
      for (let k = firstAtOrAfter(opens, from + i + 1); k < opens.length && opens[k]! < from + end; k++) {
        const o = open.get(opens[k]!)!;
        if (o >= map[from + i]! && runsPast(o, lineRawEnd)) {
          resume = o;
          break;
        }
      }
      struck.push([s, end, resume]);
    };
  };
  const strikeAnswer = striker();
  // Where each probe answer before the end is, the accepted one's included: a shell answered the probe.
  const answers: number[] = [];
  for (const m of rest.matchAll(probeAnswer(nonce))) {
    if (m.index >= to) break;
    // Accepted as the session accepts it (applyInlineMarker, scanMarker). An answer is judged by the
    // pid first: when the start marker (or the live session, or the Run's run.start) named the shell's
    // pid, only that pid answers for the Run, with the Run's token or none (no token is the declared
    // shell replaced in place by an exec, and the marker strategy's probe prints none); the Run's token
    // on another pid is a nested shell that inherited the variable (`set -a`), a stranger's answer
    // the session rejects, and the cutter accepted, ending the result at it (the house's read of
    // 78c4d6e, #22, comment 6269901528). With no pid known, the token is the one evidence: the
    // Run's token is accepted, an empty one is not; from before tokens, any pid; and a marker probe's
    // answer from before it named a pid, which names none, ends the Run as it did.
    const ok = m[2] === undefined || (pid !== undefined ? m[2] === pid && (m[3] === undefined || m[3] === '' || m[3] === m[1]) : m[3] === undefined || m[3] === m[1]);
    answers.push(m.index);
    if (ok) {
      to = m.index;
      break;
    }
    strikeAnswer(m.index, m.index);
  }
  if (of.strategy === 'marker' && of.nonce !== undefined) to = markTraceStart(rest, to, of.nonce, trace);
  // Each probe's echo before the end is plumbing on its own, the accepted probe's included, every
  // line of it: a redraw can break the typed line, its nonce included, over two lines, and striking
  // only the line where it began kept the rest (the house's read of the 38 commits, #22, comment
  // 6274773484). A probe nothing answered leaves only its echo, and what was printed after it stays.
  // A probe a shell answered, accepted or not, goes from its line's start, which is that shell's
  // prompt; one nothing answered goes from its own start, its line end kept, since a program read it
  // after whatever the program had printed on that line: striking the whole line took a program's
  // `Continue? [y/N] ` with it (the house's review of f3750e4..4f4c067, PR #22, comment 6315636412).
  const strikeEcho = striker();
  const probes = [...rest.matchAll(probeEcho(of.nonce))].filter((m) => m.index < to);
  // The echoes and the answers both go forward: one index into the answers, not a search of them all
  // per echo, which held the event loop for seconds on 100,000 echoes each followed by a rejected
  // answer (an independent read of the fixes for #22).
  let a = 0;
  probes.forEach((m, k) => {
    const next = probes[k + 1]?.index ?? Number.POSITIVE_INFINITY;
    while (a < answers.length && answers[a]! <= m.index) a++;
    strikeEcho(m.index, m.index + m[0].length - 1, a < answers.length && answers[a]! < next);
  });
  // Each kept piece, whether it ends where a struck line begins, and where in the raw it begins when a
  // string the struck line before it opened runs on into it.
  const kept: Array<[number, number, boolean, number | undefined]> = [];
  let pos = 0;
  let resume: number | undefined;
  for (const [s, e, r] of struck.sort((a, b) => a[0] - b[0])) {
    if (s >= to) break;
    if (s > pos) {
      kept.push([pos, s, true, resume]);
      resume = undefined;
    }
    if (e > pos) [pos, resume] = [e, r];
    else if (e === pos) resume ??= r;
  }
  if (pos < to) kept.push([pos, to, false, resume]);
  // Each raw piece begins right after the last plumbing character before it, so an escape that
  // opens the output (a colour set before its first character) stays with it, and ends at the next
  // one's first character, so an escape before a struck line (a colour, a title, a link's start)
  // stays and sets what follows as it did. Where that gap lies in a string a piece left open
  // (stripAtMarks), the struck line's head is in it, which the text does not hold, and the piece ends
  // right after the line end before it instead: ending at the line's first character in the text
  // kept that head; ending after the line end everywhere dropped those escapes (an independent read
  // of the fix).
  return kept
    .map(([s, e, atLine, r]): [number, number] => [r ?? (from + s === 0 ? 0 : map[from + s - 1]! + 1), atLine && open.has(from + e) ? map[from + e - 1]! + 1 : (map[from + e] ?? raw.length)])
    .filter(([s, e]) => s < e);
}

/**
 * The prefix of the typed line's trace before a marker Run's start mark at `before` in `text` (the cut's
 * text of `raw`, `map` its raw indices), when the shell was tracing: what stands on the trace's line
 * before the command, after the last carriage return the raw holds there. The text holds no carriage
 * return, so a line the cursor went back to the start of keeps what it held before: bash writes
 * `ESC[?2004l` and a CR before its trace, and a prefix holding the line's earlier text matched no trace
 * of the end mark, whose line then went whole, a last `printf abc` with it (the house's review of
 * f3750e4..4f4c067, PR #22, comment 6315636412).
 */
function tracePrefix(raw: string, text: string, map: number[], before: number): string | undefined {
  const t = RUN_TRACE.exec(text.slice(0, before));
  if (!t) return undefined;
  const from = t.index + (t[0].startsWith('\n') ? 1 : 0);
  const to = from + t[1]!.length;
  const cr = raw.lastIndexOf('\r', (map[to] ?? raw.length) - 1);
  let k = from;
  while (k < to && map[k]! < cr) k++;
  return text.slice(k, to);
}

/** The index of the first of the increasing `xs` at or after `x`. */
function firstAtOrAfter(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where a marker Run's output `text` ends before its end at `to`, without the trace of the command that
 * printed the end mark or the probe's answer. dash, bash and zsh trace neither (untraced); a shell
 * that writes its trace past the group (fish; bash given a BASH_XTRACEFD) prints the command on the
 * line before the mark: `<PS4>printf '%s:%s>>>\n' '<<<EXIT:<nonce>' 0`. A printf-built mark's trace
 * never holds the mark, so the Run ended at the real one, and the trace is named by the Run's nonce,
 * whatever PS4 is (the house's review of the 40 commits through f3750e4, PR #22, comment 6310921374,
 * question 2): from the prefix the typed line's trace showed (`prefix`), or fish's own when the trace
 * is fish's (fish has no PS4: a command the prompt runs is traced after `> `, and its trace writes the
 * format's backslash doubled, fish 4 as `'%s:%s>>>\\n'`, fish 3.7 escaping each character it would
 * quote, `\%s:\%s\>\>\>\\n`), when it stands before it, so output with no line end before the trace
 * stays, or else from its line's start. The echo that printed the end mark in earlier builds traced as
 * the mark itself, and a guess at that trace's head cut a program's line that ended in `echo `.
 *
 * The limit of the prefix rule: a PS4 that changes with every trace (`+$BASHPID `, `+$EPOCHREALTIME `)
 * gives the probe's trace no prefix the typed line's showed, so the cut falls back to the line's start
 * and takes a program's unfinished output before it; a PS4 changed during the Run to one that ends with
 * the old (`>> ` then `+>> `) leaves a `+` and the pid substitution's trace as noise, with nothing lost.
 * Cutting at PS4's first character doubled would cover bash alone and only that case, so the rule stays
 * (the house's review of 4860d4c..bc4bc85, PR #22, comment 6357989601).
 */
function markTraceStart(text: string, to: number, nonce: string, prefix: string | undefined): number {
  const lineStart = text.lastIndexOf('\n', to - 2) + 1;
  const line = text.slice(lineStart, to);
  const mark = new RegExp(`<<<(?:EXIT|PROBE):${literal(nonce)}'?(?: -?\\d+)?\\n$`).exec(line);
  // The trace's command is the line's last `printf ` before the mark: a program's unterminated line before the trace may hold
  // one of its own (`abc printf x`), and taking the first took that line with the trace (an independent read of the fixes for #22).
  const at = mark ? line.lastIndexOf('printf ', mark.index) : -1;
  if (at === -1) return to;
  const head = prefix ?? (line.slice(at, mark!.index).includes('\\\\n') ? '> ' : undefined);
  const cut = head && line.slice(0, at).endsWith(head) ? lineStart + at - head.length : lineStart;
  // The probe's pid comes from a command substitution (markerProbe), which bash traces on the line before. That trace goes from
  // its prefix, the probe's own trace's (what its line holds before `printf `), with its first character doubled where bash's
  // `exec` shows the trace is bash's, a level down, and as it is in zsh's: taking its whole line took a program's output with no
  // line end before it (the house's review of a8b6f28..4860d4c, PR #22, comment 6341260318). With no prefix there, its line.
  if (cut === lineStart && lineStart > 0 && mark![0].startsWith('<<<PROBE')) {
    const prev = text.lastIndexOf('\n', lineStart - 2) + 1;
    const sub = PID_TRACE.exec(text.slice(prev, lineStart));
    if (sub) {
      const own = line.slice(0, at);
      const p = sub[0].startsWith('exec ') ? own.slice(0, 1) + own : own;
      return text.slice(prev, prev + sub.index).endsWith(p) ? prev + sub.index - p.length : prev;
    }
  }
  return cut;
}
/**
 * The trace of the command substitution that gives the marker probe its pid (EVALUATING_PID): bash's
 * keeps the `exec` (`++ exec /bin/sh -c 'echo $PPID'`), zsh's drops the precommand (`+zsh:4> /bin/sh -c
 * 'echo $PPID'`), which this missed, and that line stayed in a cancelled Run's result (an independent
 * read of the fixes for #22).
 */
const PID_TRACE = /(?:exec )?\/bin\/sh -c '?echo \$PPID'?\n$/;
