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
    case 'prompt':
      return front.pending ? `at the prompt, with ${JSON.stringify(front.pending)} typed and not yet run` : 'at the prompt';
    case 'running': {
      const what = front.process.shell ? 'the shell itself is busy' : `running ${front.process.argv}`;
      return `${what} for ${duration(now - front.since)}${front.waitVisible ? '' : " (whether it waits for input can't be seen here)"}`;
    }
    case 'waiting':
      return `waiting for input: ${front.process.argv}${front.echo ? '' : ', not echoed, as for a password'}, for ${duration(now - front.since)}`;
    case 'exited':
      return `the shell ${exitText(front.exit)}`;
  }
}

export function endingText(c: Command): string[] {
  const end = c.end;
  if (!end) return [];
  const parts: string[] = [];
  parts.push(end.status === undefined ? 'status unknown' : `exit ${end.status}`);
  if (end.pipeline && end.pipeline.some((s) => s !== 0)) parts.push(`pipeline ${end.pipeline.join('|')}`);
  parts.push(duration(end.at - c.startedAt));
  if (end.errexit) parts.push('set -e is on: a failing command now ends the shell');
  if (end.flushed) parts.push(`discarded typed-ahead text ${JSON.stringify(end.flushed)}, which nothing read`);
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
  parts.push(f.command?.end?.cwd ?? f.cwd);
  if (f.unseen) parts.push(`${f.unseen} ending${f.unseen === 1 ? '' : 's'} not yet seen (list shows them)`);
  return `[${parts.join(' · ')}]`;
}

/**
 * The most text a result carries. agent-framework stores a tool result longer than its inline cap
 * cut to its head, with a note (DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS, 24,000 characters, in
 * src/tool-result-history.ts at aa134e75fc), so a longer result would lose its tail, where a
 * command's outcome and errors usually are. It's the smallest such cap among the hosts we know of.
 */
export const RESULT_MAX_CHARS = 24_000;

const cutAt = (text: string, max: number, fromEnd: boolean): string => {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  return fromEnd ? `…${cps.slice(cps.length - max + 1).join('')}` : `${cps.slice(0, max - 1).join('')}…`;
};

export function linesText(l: Lines, budget: number, readHint: string): string {
  const out: string[] = [];
  if (l.dropped) out.push(`… ${l.dropped} earlier line${l.dropped === 1 ? '' : 's'} no longer kept`);
  const whole = l.lines.join('\n');
  if (whole.length <= budget) return [...out, whole].join('\n');
  const marker = (n: number): string => `… ${n} line${n === 1 ? '' : 's'} left out (${readHint})`;
  const room = Math.max(0, budget - marker(l.lines.length).length - 2);
  const headRoom = Math.floor(room / 3);
  let tailRoom = room - headRoom;
  const head: string[] = [];
  let used = 0;
  for (const line of l.lines) {
    if (used + line.length + 1 > headRoom) {
      if (head.length === 0) head.push(cutAt(line, Math.max(1, headRoom), false));
      break;
    }
    head.push(line);
    used += line.length + 1;
  }
  tailRoom += headRoom - head.reduce((n, x) => n + x.length + 1, 0);
  const tail: string[] = [];
  used = 0;
  for (let i = l.lines.length - 1; i >= head.length; i--) {
    const line = l.lines[i]!;
    if (used + line.length + 1 > tailRoom) {
      if (tail.length === 0) tail.unshift(cutAt(line, Math.max(1, tailRoom), true));
      break;
    }
    tail.unshift(line);
    used += line.length + 1;
  }
  const left = l.lines.length - head.length - tail.length;
  return [...out, ...head, ...(left > 0 ? [marker(left)] : []), ...tail].join('\n');
}

/**
 * The room a result keeps beside a whole screen, for its status line, the screen's own line and a
 * matched line, which an ordinary command line, directory and title keep well within. `open` holds
 * a terminal to the size whose screen fits in RESULT_MAX_CHARS less this, so an agent sees a
 * full-screen program's screen whole, status bar and prompt included.
 */
export const SCREEN_ROOM_CHARS = 1_000;

/** The most characters a screen of `cols` by `rows` can take: each row and its line break. */
export const screenChars = (cols: number, rows: number): number => (cols + 1) * rows;

export function screenText(s: Screen, budget: number): string {
  const rows = [...s.rows];
  while (rows.length && rows[rows.length - 1]!.trimEnd() === '') rows.pop();
  const head = `(screen${s.alt ? ', full-screen program' : ''}${s.title ? `, title ${JSON.stringify(s.title)}` : ''}; cursor at row ${s.cursor.row + 1}, column ${s.cursor.col + 1})`;
  let text = [head, ...rows].join('\n');
  // Only lines past the room open's bound keeps (a very long command line in front, a long
  // title) can bring a whole screen past the budget; then its top rows go, not the cap.
  let dropped = 0;
  while (text.length > budget && rows.length > 1) {
    rows.shift();
    dropped++;
    text = [head, `(${dropped} row${dropped === 1 ? '' : 's'} above not shown)`, ...rows].join('\n');
  }
  return text;
}
