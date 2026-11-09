import type { Schema } from '../api/validate.js';
import { FAR_MAX_TYPED } from '../session/integration.js';
import { RESULT_MAX_CHARS, SCREEN_ROOM_CHARS } from './render.js';

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
 * `open` holds a terminal to what one result can show whole when each cell is one UTF-16 unit: (cols + 1) × rows within
 * RESULT_MAX_CHARS less SCREEN_ROOM_CHARS (render.ts), so 23,000 characters. This maximum on each side is a backstop for the
 * schema; the widest terminal that fits is 500 by 45. Width no longer sets a session's memory: its emulator keeps only the
 * rows no freeze has taken yet, and the frozen lines are bounded by count and by characters (transcript.ts). Measured with
 * @xterm/headless 6.0.0 on Node 24.22.2, a session's transcript after 12,000 full-width lines held 2.3 MiB at 80 columns,
 * 3.7 at 200 and 7.4 at 500 by 45, or 3.1, 5.8 and 12.6 when each character takes two bytes; lines of 60,000 two-byte
 * characters, which meet the bound on characters, held 16 MiB at 80 columns and at 500.
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
        cols: { type: 'integer', minimum: 1, maximum: SIZE_MAX, description: `Terminal width in columns; 120 when left out. Columns plus one, times rows, may be at most ${RESULT_MAX_CHARS - SCREEN_ROOM_CHARS}, so a whole screen of plain text fits in one result.` },
        rows: { type: 'integer', minimum: 1, maximum: SIZE_MAX, description: 'Terminal height in rows; 40 when left out.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'run',
    description:
      'Run one command line in a session\'s shell, only when it is at its prompt. Otherwise nothing is typed, and the refusal says what is in front. ' +
      'Returns its exit status, duration, directory afterwards and output, or that it is still running when the wait ends: it keeps running, and on a host that takes wakes its end is reported to you when it comes. ' +
      '`notify_on` reports a pattern in its output once: in the result if the command has ended, otherwise as it appears, on a host that takes wakes. ' +
      'For a script, `structuredContent` has `exitCode` (null with `running` true while it runs, null with `running` false when no status is known, and null with `stopped` true when a `stop` signal stopped the job) and `output`, the command\'s own lines without the typed command or any note, ' +
      'cut past the result\'s budget to its start and end, with `outputLeftOut` giving `at` and `characters` in UTF-16 code units. ' +
      `In a shell given the integration with \`integrate\`, the command line is typed as one line of at most ${FAR_MAX_TYPED.toLocaleString('en-US')} characters, with each \`'\`, \`\\\`, \`!\`, control or non-ASCII byte counting five; a longer one is refused, and says how long it was.`,
    inputSchema: {
      type: 'object',
      properties: {
        name,
        command: { type: 'string', minLength: 1, description: 'The command line, run as if typed at the prompt; it may span lines.' },
        wait,
        notify_on: { type: 'string', description: 'A regular expression: report its first match in this command\'s output, once, and nothing after the command ends.' },
      },
      required: ['name', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    description:
      'Type into the terminal exactly the given `text`, then the named `keys`; nothing is appended, so a line needs `keys: ["Enter"]`. ' +
      'A program such as Claude Code takes long typed text as a paste, and an Enter with it; give `paste: true`, and the keys go after the paste. ' +
      'For answering a program that waits for input, or driving a full-screen one. Returns what changed: the new lines, or the screen of a full-screen program, ' +
      'once `wait_for` matches, or, without `wait_for`, once output has been quiet for 300 ms. Keys: Enter, Tab, S-Tab, Esc, Space, Backspace, Delete, Insert, Up, Down, Left, Right, Home, End, ' +
      'PageUp, PageDown, F1 to F12, C-a to C-z and C-\\, C-], C-@, C-^, C-_ (Ctrl), M-<char> (Alt), and C-, M- and S- on the arrows, Home, End, Insert, Delete, PageUp, PageDown and F-keys.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        text: { type: 'string', description: 'Text to type, exactly as given.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Named keys to press after the text, in order.' },
        paste: { type: 'boolean', description: 'Send `text` as a paste: inside the bracketed-paste frame, with `keys` after it. Only while the program in front has turned bracketed paste on.' },
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
      '`end` also returns when a program waits for input, since it won\'t end until answered; ' +
      'with `match`, for a pattern in new output. If the wait ends first, the result says whether what it waited for will be reported to you when it comes.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        until: { type: 'string', enum: ['end', 'input'], description: '`end`: until the shell is back at its prompt, or a program waits for input; `input`: until a program waits for input.' },
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
      'Read a session\'s earlier output: one command\'s output by its id (each result names its command id), a range of line numbers, or the lines matching a pattern, with context. ' +
      `Like every result it is cut to ${RESULT_MAX_CHARS} characters, keeping its start and end, so a long output is read in ranges; a single line longer than that is cut in its middle, and output older than the lines a session keeps is gone.`,
    inputSchema: {
      type: 'object',
      properties: {
        name,
        command: { type: 'integer', minimum: 1, description: 'A command id: its output.' },
        lines: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Two line numbers, [from, to]: from `from` up to, not including, `to`.' },
        match: { type: 'string', description: 'A regular expression: every line it matches, within `command` or `lines` when given. A line longer than the pattern\'s match window is searched on its head only, and the result says how many were.' },
        context: { type: 'integer', minimum: 0, description: 'With `match`, lines shown before and after each match; 2 when left out.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop',
    description:
      'Stop what runs in front of a session\'s shell, in steps, each reported: Ctrl-C typed to the terminal, so it reaches whatever is in front, a shell\'s own loop included; then TERM, then KILL to the job in front, never to the shell. ' +
      'If the shell itself is what runs and Ctrl-C doesn\'t bring back its prompt, the steps end there, and `close` is what remains. With `signal`, just that one, and never to the shell. ' +
      'With a shell given the integration in front, only Ctrl-C is typed, and a `signal` isn\'t sent: it would reach the local program, such as `ssh`.',
    inputSchema: {
      type: 'object',
      properties: {
        name,
        signal: {
          type: 'string',
          minLength: 1,
          description:
            'Send only this signal to the job in front: any this system has, by name, with or without SIG, such as INT, TERM, KILL, HUP, QUIT, USR1 or TSTP. ' +
            'A suspend signal (TSTP, STOP, TTIN, TTOU) stops the job and brings the prompt back; `run` with `fg` or `bg` continues it. A signal the job ignores or handles leaves it running.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'integrate',
    description:
      'Give the shell now in front the session\'s integration, so `run` works in it with statuses: a shell reached through a typed `ssh`, `su` or `docker exec`. ' +
      'It types a probe line, then the hooks, and they answer whatever reads the terminal. Refused at the prompt of a shell that already has the integration: the session\'s own, or one given it before. ' +
      'Refused while this terminal reads whole lines, as at the password or yes/no questions ssh, su and sudo ask on this machine. A program that holds the terminal raw, such as a connected ssh, hides its far side: a question there can\'t be seen, and the probe line would answer it. Call it once `look` shows the far prompt. ' +
      'bash, zsh and fish only; another shell is refused, and the refusal names it. If the wait runs out, nothing more is typed, and the result names the step it reached; once the hooks are all typed, a prompt drawn later still completes it. ' +
      'The integration lasts until that shell exits. Then `run` goes back to the shell it was typed from. ' +
      'In a shell that writes its history as it goes, the probe line reaches its history file, and in zsh so does the line that turns saving off. Nothing typed after them does.',
    inputSchema: {
      type: 'object',
      properties: { name, wait },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    description: 'Every session you have open: what is in front of each, its directory, and the reports you haven\'t seen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'close',
    description: 'End a session. Its shell and every process on its terminal are hung up, and the shell is killed if it hasn\'t ended after a grace. A process started with `setsid` or `nohup` outlives it.',
    inputSchema: {
      type: 'object',
      properties: { name, force: { type: 'boolean', description: 'KILL at once the shell, every process on its terminal and every process the shell started. Only a process that left the terminal and is no longer the shell\'s descendant outlives it.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];
