import type { Schema } from '../api/validate.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
}

/**
 * The longest a call may wait. agent-framework gives up on a tools/call after 60 s
 * (DEFAULT_REQUEST_TIMEOUT_MS in src/mcpl/server-connection.ts at aa134e75fc), so a call that
 * waited the whole 60 s would be answered to nobody; 5 s of it are left for the answer to travel.
 */
export const WAIT_MAX_S = 55;
export const WAIT_DEFAULT_S = 15;

const name: Schema = { type: 'string', description: 'The session\'s name, as `open` gave it: 1 to 64 letters, digits, ".", "_" or "-".' };
const wait: Schema = {
  type: 'number',
  minimum: 0,
  maximum: WAIT_MAX_S,
  description: `Seconds to wait, from 0 to ${WAIT_MAX_S}; ${WAIT_DEFAULT_S} when left out.`,
};

export const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The largest terminal `open` makes. Each session's emulator keeps 10,000 lines of scrollback, so
 * its memory grows with the columns: measured with @xterm/headless 6.0.0 on Node 24, a terminal at
 * full scrollback took 20.5 MiB at 80 columns, 24.2 at 200 and 39.1 at 500, about 0.07 MiB a
 * column, all of it in the daemon that holds every session. At 500 by 500 one session stays near
 * 50 MB; at 10,000 columns it would be about 730 MiB.
 */
export const SIZE_MAX = 500;

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'open',
    description:
      'Open a session: your login shell, with your startup files, in a terminal of its own. It persists across calls and connections until you `close` it or the daemon stops, ' +
      'so `cd`, exported variables, functions, a virtualenv and background jobs carry from one command to the next. Every other tool names a session `open` made; none makes one for you.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        cwd: { type: 'string', description: 'The directory to start in: absolute, or starting with `~`. Your home directory when left out.' },
        cols: { type: 'integer', minimum: 1, maximum: SIZE_MAX, description: `Terminal width in columns, up to ${SIZE_MAX}; 120 when left out. Each column costs the daemon memory across the whole scrollback.` },
        rows: { type: 'integer', minimum: 1, maximum: SIZE_MAX, description: `Terminal height in rows, up to ${SIZE_MAX}; 40 when left out.` },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'run',
    description:
      'Run one command line in a session\'s shell, only when it is at its prompt. Otherwise nothing is typed, and the refusal says what is in front. ' +
      'Returns its exit status, duration, directory afterwards and output, or that it is still running when the wait ends: it keeps running, and its end is reported to you when it comes. ' +
      '`notify_on` reports a pattern in its output once, as it appears.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        command: { type: 'string', minLength: 1, description: 'The command line, run as if typed at the prompt; it may span lines.' },
        wait,
        notify_on: { type: 'string', description: 'A regular expression: report its first match in this command\'s output, once.' },
      },
      required: ['name', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    description:
      'Type into the terminal exactly the given `text`, then the named `keys`; nothing is appended, so a line needs `keys: ["Enter"]`. ' +
      'For answering a program that waits for input, or driving a full-screen one. Returns what changed: the new lines, or the screen of a full-screen program, ' +
      'once `wait_for` matches or output has been quiet for 300 ms. Keys: Enter, Tab, S-Tab, Esc, Space, Backspace, Delete, Insert, Up, Down, Left, Right, Home, End, ' +
      'PageUp, PageDown, F1 to F12, C-a to C-z and C-\\, C-], C-@, C-^, C-_ (Ctrl), M-<char> (Alt), and C-, M- and S- on the arrows, Home, End, Insert, Delete, PageUp, PageDown and F-keys.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        text: { type: 'string', description: 'Text to type, exactly as given.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Named keys to press after the text, in order.' },
        wait_for: { type: 'string', description: 'A regular expression: return once it matches from the line the cursor was on.' },
        wait,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'look',
    description:
      'What a session shows that you haven\'t seen yet, and what is in front now. With `until`, wait first for a command to end (`end`) or a program to wait for input (`input`); ' +
      'with `match`, for a pattern in new output. If the wait ends first, the match is reported to you when it comes.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        until: { type: 'string', enum: ['end', 'input'], description: '`end`: until the shell is back at its prompt; `input`: until a program waits for input.' },
        match: { type: 'string', description: 'A regular expression: until it matches in output from here on.' },
        wait,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      'Read a session\'s earlier output: one command\'s whole output by its id (each result names its command id), a range of line numbers, or the lines matching a pattern, with context.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        command: { type: 'integer', minimum: 1, description: 'A command id: its whole output.' },
        lines: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Two line numbers, [from, to]: from `from` up to, not including, `to`.' },
        match: { type: 'string', description: 'A regular expression: every line it matches, within `command` or `lines` when given.' },
        context: { type: 'integer', minimum: 0, description: 'With `match`, lines shown before and after each match; 2 when left out.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop',
    description:
      'Stop what runs in front of a session\'s shell, in steps, each reported: Ctrl-C, then TERM, then KILL to its job, never to the shell. ' +
      'If the shell itself is what runs, the steps end there, and `close` is what remains. With `signal`, just that one.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        signal: { type: 'string', enum: ['INT', 'TERM', 'KILL', 'HUP', 'QUIT'], description: 'Send only this signal to the job in front.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    description: 'Every session you have open: what is in front of each, its directory, and the endings you haven\'t seen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'close',
    description: 'End a session: hang up its shell, and kill it if it hasn\'t ended after a grace, or at once with `force`.',
    inputSchema: {
      type: 'object',
      properties: { name, force: { type: 'boolean', description: 'Kill the shell at once.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];
