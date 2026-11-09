import type { Command, Exit, Front, Lines, Screen } from '../session/types.js';

export function duration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const exitText = (e: Exit): string => (e.signal ? `was killed by ${e.signal}` : e.code === null ? 'exited with no status' : `exited with status ${e.code}`);

export function frontText(front: Front, now: number): string {
  switch (front.state) {
    case 'prompt': {
      const where = front.within ? `at the prompt of the shell within ${quoted(front.within.argv)}` : 'at the prompt';
      return front.pending ? `${where}, with ${quotedString(front.pending)} typed and not yet run` : where;
    }
    case 'running': {
      const seen = front.waitVisible ? '' : " (whether it waits for input can't be seen here)";
      if (front.within) return `the shell within ${quoted(front.within.argv)} is running a command for ${duration(now - front.since)}${seen}`;
      const what = front.process.shell
        ? front.starting
          ? 'the shell is still running its startup files'
          : 'the shell itself is busy'
        : `running ${quoted(front.process.argv)}${front.starting ? " from the shell's startup files" : ''}`;
      return `${what} for ${duration(now - front.since)}${seen}`;
    }
    case 'waiting':
      return `waiting for input${front.starting ? " in the shell's startup files" : ''}: ${quoted(front.process.argv)}${front.echo === false ? ', not echoed, as for a password' : front.echo === undefined ? ', echo unknown' : ''}, for ${duration(now - front.since)}`;
    case 'unknown':
      return "whether the shell is at its prompt can't be seen now: reading its terminal failed";
    case 'exited':
      return `the shell ${exitText(front.exit)}`;
  }
}

/** A shell given the integration has no directory until its first end mark. */
export const dirText = (cwd: string): string => (cwd ? quoted(cwd) : 'directory not yet known');

export function endingText(c: Command): string[] {
  const end = c.end;
  if (!end) return [];
  const parts: string[] = [];
  const status = end.status === undefined ? 'status unknown' : `exit ${end.status}`;
  if (end.unfollowed) {
    const { by, how } = end.unfollowed;
    const seen = how === 'back' ? `the shell that ran ${quoted(by)} is at its prompt again` : `${quoted(by)} ${how === 'left' ? 'left the terminal' : 'ended'}`;
    parts.push(`no longer followed: ${seen}, so whether the command ended isn't known`);
  }
  else parts.push(end.stopped ? `stopped${end.status === undefined ? '' : ` (the shell reported ${status})`}` : status);
  if (end.pipeline && end.pipeline.some((s) => s !== 0)) parts.push(`pipeline ${end.pipeline.join('|')}`);
  parts.push(duration(end.ms));
  if (end.errexit) parts.push('set -e is on: a failing command now ends the shell');
  if (end.flushed) parts.push(`discarded typed-ahead text ${quotedString(end.flushed)}, which nothing read`);
  if (end.refusedMarks) parts.push(`${end.refusedMarks} lookalike end mark${end.refusedMarks === 1 ? '' : 's'} in its output refused`);
  return parts;
}

export interface StatusFacts {
  session: string;
  front: Front;
  cwd: string;
  command?: Command;
  unseen?: number;
  now: number;
}

export function statusLine(f: StatusFacts): string {
  const parts = [f.session];
  if (f.command) {
    parts.push(`command ${f.command.id}`);
    if (f.command.end) parts.push(...endingText(f.command));
    else parts.push('still running');
  }
  parts.push(frontText(f.front, f.now));
  parts.push(dirText(f.command?.end?.cwd ?? f.cwd));
  if (f.unseen) parts.push(`${f.unseen} report${f.unseen === 1 ? '' : 's'} not yet seen (list shows them)`);
  return `[${parts.join(' · ')}]`;
}

/**
 * The most text a result carries. agent-framework stores a tool result longer than its inline cap
 * cut to its head, with a note (DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS, 24,000 characters, in
 * src/tool-result-history.ts at aa134e75fc), so a longer result would lose its tail, where a
 * command's outcome and errors usually are. It's the smallest such cap among the hosts we know of.
 */
export const RESULT_MAX_CHARS = 24_000;

/** String lengths count UTF-16 units, so a cut at a unit can split a surrogate pair. */
export const cutAt = (text: string, max: number, fromEnd: boolean): string => {
  if (text.length <= max) return text;
  if (fromEnd) {
    let i = text.length - max + 1;
    if (isLowSurrogate(text.charCodeAt(i))) i++;
    return `…${text.slice(i)}`;
  }
  let n = max - 1;
  if (isHighSurrogate(text.charCodeAt(n - 1))) n--;
  return `${text.slice(0, n)}…`;
};

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

export function linesText(l: Lines, budget: number, readHint: string): string {
  const out: string[] = [];
  if (l.dropped) out.push(`… ${l.dropped} earlier line${l.dropped === 1 ? '' : 's'} no longer kept`);
  const whole = l.lines.join('\n');
  if (whole.length <= budget) return [...out, whole].join('\n');
  if (l.lines.length === 1) return [...out, ...middleCut(l.lines[0]!, budget)].join('\n');
  const marker = (left: number, cut: number): string => `… ${omitted(left, cut)} (${readHint})`;
  const room = Math.max(0, budget - marker(l.lines.length, 2).length - 2);
  const headRoom = Math.floor(room / 3);
  const head: string[] = [];
  let cut = 0;
  let used = 0;
  for (const line of l.lines) {
    if (used + line.length + 1 > headRoom) {
      if (head.length === 0) {
        head.push(cutAt(line, Math.max(1, headRoom), false));
        cut++;
      }
      break;
    }
    head.push(line);
    used += line.length + 1;
  }
  const tailRoom = room - head.reduce((n, x) => n + x.length + 1, 0);
  const tail: string[] = [];
  used = 0;
  for (let i = l.lines.length - 1; i >= head.length; i--) {
    const line = l.lines[i]!;
    if (used + line.length + 1 > tailRoom) {
      if (tail.length === 0) {
        tail.unshift(cutAt(line, Math.max(1, tailRoom), true));
        cut++;
      }
      break;
    }
    tail.unshift(line);
    used += line.length + 1;
  }
  const left = l.lines.length - head.length - tail.length;
  return [...out, ...head, marker(left, cut), ...tail].join('\n');
}

export function outputValue(lines: readonly string[], budget: number): { output: string; outputLeftOut?: { at: number; characters: number } } {
  const whole = lines.join('\n');
  if (whole.length <= budget) return { output: whole };
  let at = Math.floor(Math.max(0, budget) / 3);
  if (at > 0 && isHighSurrogate(whole.charCodeAt(at - 1))) at--;
  let end = whole.length - Math.max(0, budget - at);
  if (isLowSurrogate(whole.charCodeAt(end))) end++;
  return { output: whole.slice(0, at) + whole.slice(end), outputLeftOut: { at, characters: end - at } };
}

function omitted(left: number, cut: number): string {
  const parts: string[] = [];
  if (left) parts.push(`${left} line${left === 1 ? '' : 's'} left out`);
  if (cut) parts.push(`${cut} line${cut === 1 ? '' : 's'} cut short`);
  return parts.join(', ');
}

function middleCut(line: string, budget: number): string[] {
  const note = (n: number): string => `… ${n} characters of this line left out, which no call returns; a command that prints the line in pieces, such as \`fold -w 10000\`, shows them`;
  const room = Math.max(2, budget - note(line.length).length - 2);
  const headRoom = Math.max(1, Math.floor(room / 3));
  const start = cutAt(line, headRoom, false);
  const end = cutAt(line, Math.max(1, room - headRoom), true);
  return [start, note(line.length - (start.length - 1) - (end.length - 1)), end];
}

/**
 * The room a result keeps beside a whole screen, for its status line, the screen's own line and a
 * matched line, which an ordinary command line, directory and title keep well within. `open` holds
 * a terminal to the size whose screen fits in RESULT_MAX_CHARS less this, so an agent sees a
 * full-screen program's screen whole, status bar and prompt included, when each cell is one
 * UTF-16 unit.
 */
export const SCREEN_ROOM_CHARS = 1_000;

/**
 * How much a result quotes of a value the host doesn't bound: a command line (up to the kernel's
 * limit, 2 MiB on Linux), a program's title, text typed and not run, a matched line. The status
 * line, the screen's own line and a matched line share SCREEN_ROOM_CHARS, so each such value
 * gets a quarter of it, leaving the rest to the host's own parts with an ordinary directory.
 */
export const QUOTED_MAX_CHARS = SCREEN_ROOM_CHARS / 4;

const escaped = (s: string): string =>
  s.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));

function clip(s: string): { text: string; more: number } {
  if (s.length <= QUOTED_MAX_CHARS) return { text: s, more: 0 };
  const n = isHighSurrogate(s.charCodeAt(QUOTED_MAX_CHARS - 1)) ? QUOTED_MAX_CHARS - 1 : QUOTED_MAX_CHARS;
  return { text: s.slice(0, n), more: s.length - n };
}

function noted(s: string): string {
  const c = clip(s);
  return c.more ? `${c.text}… (${c.more} more characters)` : s;
}

export const quoted = (s: string): string => noted(escaped(s));

const OWN_BOUND = new Set(['unseen', 'output', 'cwd']);

export function boundedStrings<T>(v: T): T {
  if (typeof v === 'string') return noted(v) as T;
  if (Array.isArray(v)) return v.map(boundedStrings) as T;
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, OWN_BOUND.has(k) ? x : boundedStrings(x)])) as T;
  return v;
}

/** As `quoted`, in quotation marks, with the note after the closing one, so it can't read as part of the text. */
export function quotedString(s: string): string {
  const c = clip(s);
  return c.more ? `${JSON.stringify(c.text)}… (${c.more} more characters)` : JSON.stringify(s);
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/**
 * Every result and wake ends within RESULT_MAX_CHARS. What can still carry one past it, once
 * output is cut to its budget and quoted values to theirs, is a count the host doesn't bound,
 * such as many reports not yet seen; the cut keeps the head, where the status line is.
 */
const fitNote = (n: number): string => `\n… ${n} characters left out, past the ${RESULT_MAX_CHARS} a result carries`;

export function fittedLength(text: string): number {
  if (text.length <= RESULT_MAX_CHARS) return text.length;
  const n = RESULT_MAX_CHARS - fitNote(text.length).length;
  return isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n;
}

export function fitted(text: string): string {
  const n = fittedLength(text);
  return n === text.length ? text : text.slice(0, n) + fitNote(text.length - n);
}

/** The most characters a screen of `cols` by `rows` can take: each row and its line break. */
export const screenChars = (cols: number, rows: number): number => (cols + 1) * rows;

export function screenText(s: Screen, budget: number): string {
  const rows = [...s.rows];
  while (rows.length && rows[rows.length - 1]!.trimEnd() === '') rows.pop();
  const head = `(screen${s.alt ? ', full-screen program' : ''}${s.title ? `, title ${quotedString(s.title)}` : ''}; cursor at row ${s.cursor.row + 1}, column ${s.cursor.col + 1})`;
  let text = [head, ...rows].join('\n');
  // Lines past the room open's bound keeps (a very long command line in front, a long title),
  // or cells wider than one UTF-16 unit (emoji, combining marks), can bring a whole screen past
  // the budget; then its top rows go, not the cap.
  let dropped = 0;
  while (text.length > budget && rows.length > 1) {
    rows.shift();
    dropped++;
    text = [head, `(${dropped} row${dropped === 1 ? '' : 's'} above not shown)`, ...rows].join('\n');
  }
  return text;
}
