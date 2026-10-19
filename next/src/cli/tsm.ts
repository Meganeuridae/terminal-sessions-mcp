#!/usr/bin/env node
/**
 * tsm — a thin CLI over the daemon (§11): the tool table with a different
 * transport, `--json` on every command, so a shell-shaped harness composes
 * the server in scripts.
 *
 * Exit codes are the contract scripts rely on (atc-5, atc-20, G27):
 *   the Run's own exit code        exited with a code
 *   128 + signal number            exited on a signal (137 for SIGKILL), as shells report it
 *   124                            not finished: running, starting or queued — `await` it
 *                                  (timeout(1)'s code for "the wait ran out")
 *   75                             busy: the shell is occupied — another Run is running, or a
 *                                  person is editing a line at its prompt (EX_TEMPFAIL: retry)
 *   1                              an error; a cancelled or lost Run; a Run that exited with
 *                                  neither a code nor a signal (its status is unknown); a failed
 *                                  start or cancel; a daemon connection lost before the result
 *                                  (the outcome is then unknown)
 * A command may itself exit 124 (timeout(1) does), 75 or 1, so the code alone cannot tell a
 * Run that ended so from one not finished, busy or lost: `--json` and its `state` are the
 * authority (G27). `--until-done` on `run` and `await` keeps awaiting past the per-call cap
 * until the Run has ended, so a 124 then is the command's own, never "not finished" (the
 * house's review of #11). `start` exits 0 when the service is ready, or running with no
 * readiness condition to check; 124 while it is starting; 1 when it is unhealthy, exited or
 * lost. `cancel` exits 0 once the Run is known to have ended (exited or cancelled), 1 when it
 * survived or is lost (its end was never observed, so nothing is known to have stopped). The
 * codes and this account of them were read against each other (the house's read of 4e37a11, #22).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { analyze, readUsage, UNFINISHED } from '../api/usage.js';
import { parseDuration, setting } from '../core/env.js';

/** A result state the usage module calls unfinished (running, starting, queued). */
const isUnfinished = (state: unknown): boolean => typeof state === 'string' && UNFINISHED.has(state);

/** Not finished (running, starting, queued): the wait ran out, like timeout(1). */
const EXIT_UNFINISHED = 124;
/** Busy: the shell is occupied by another Run or a person's line; try again (sysexits EX_TEMPFAIL). */
const EXIT_BUSY = 75;

const USAGE = `tsm <command> [args] [--key value ...] [--json]
  sessions                              list sessions
  open <session> [--cwd DIR] [--shell S] [--visibility shared] [--control open]
  close <session> [--force]
  run <session> [--wait 20s] [--target process] [--queue] [--until-done] <command line>
  run <session> [flags] -- <word...>    after --, each word is one argument of the command, flags
                                        included: quoted for the shell, no word is split or expanded
  declare <session> [fish|none]         the program in front (ssh, sudo -i, a nested shell) is a shell:
                                        run goes to it until it ends; name fish when it is one; "none" takes it back
  await [<session>] <runId> [--wait 20s] [--until-done]   (--until-done: keep awaiting until the Run has ended)
  read <session> [--since N | --tail N | --run-id ID] [--as events]
  screen <session>
  input <session> [text] [--keys Enter,C-c] [--sensitive]
  cancel [<session>] <runId>
  signal <session> [--signal SIGINT]
  control <session> take|release|status
  env-capture <session>
  gui                                   print the GUI's URL (with the token, when one is set)
  usage [--file F] [--since ISO]        §16 Measure: per-tool use, errors, confusion signatures
                                        (reads <data-dir>/usage.jsonl locally; TSM_DATA_DIR, default ~/.tsm)
  <tool> --arg value ...                any tool by name
A value takes the type of the tool's parameter (the daemon's schema decides): text stays text
(--pattern 404); a yes/no flag stands alone (--queue; --queue=false turns it off); a list splits at
commas (--keys Enter,C-c) or is JSON; an object is JSON (start --ready '{"pattern":"listening"}');
--key=value works everywhere. Durations (--wait and any --*-ms flag): 500ms, 20s, 2m, or plain
milliseconds.
Env: TSM_URL (ws://127.0.0.1:3101), TSM_TOKEN.
Exit code: a run's exit code; 128+N when it died on signal N; ${EXIT_UNFINISHED} while it is still running
(await it); ${EXIT_BUSY} when the shell is busy (another Run, or a person editing a line at the prompt); 1 on
error, for a cancelled or lost Run, for one that exited with neither a code nor a signal, and when the
daemon connection was lost before the result (the outcome is then unknown). A command may itself exit
${EXIT_UNFINISHED}, ${EXIT_BUSY} or 1: --json's state is the authority. start: 0 ready, or running with nothing to check;
${EXIT_UNFINISHED} starting; 1 unhealthy, exited or lost. cancel: 0 once the Run ended (exited or cancelled); 1 if
it survived or is lost.`;

const SHORT: Record<string, { tool: string; positional: string[]; join?: string; single?: string }> = {
  sessions: { tool: 'session_list', positional: [] },
  open: { tool: 'session_open', positional: ['session'] },
  close: { tool: 'session_close', positional: ['session'] },
  run: { tool: 'run', positional: ['session', 'command'], join: 'command' },
  declare: { tool: 'session_declare_shell', positional: ['session', 'shell'] },
  // One positional is the runId (session is optional, as the tool allows): `tsm await r41` (atc-25).
  await: { tool: 'await', positional: ['session', 'runId'], single: 'runId' },
  read: { tool: 'read', positional: ['session'] },
  screen: { tool: 'screen', positional: ['session'] },
  input: { tool: 'input', positional: ['session', 'text'], join: 'text' },
  cancel: { tool: 'cancel', positional: ['session', 'runId'], single: 'runId' },
  signal: { tool: 'signal', positional: ['session'] },
  control: { tool: 'control', positional: ['session', 'action'] },
  'env-capture': { tool: 'session_env_capture', positional: ['session'] },
};

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const isDurationKey = (k: string) => k === 'wait' || /Ms$/.test(k);
/** Keys that are text even without a schema to say so. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['command', 'text', 'line', 'pattern']);

/** What the CLI reads of a tool's input schema: each parameter's type. */
interface Schema {
  type?: unknown;
  properties?: Record<string, Schema>;
}
type ParamType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
const PARAM_TYPES: ReadonlySet<unknown> = new Set<ParamType>(['string', 'integer', 'number', 'boolean', 'array', 'object']);
const typeOf = (s: Schema | undefined): ParamType | undefined => (PARAM_TYPES.has(s?.type) ? (s!.type as ParamType) : undefined);

function parseJson(key: string, v: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    throw new Error(`--${key}: not valid JSON: ${v}`);
  }
}

/**
 * A flag's value, typed as the tool's parameter is: the schema decides, not the value's look, so
 * `--pattern 404` and `--command true` stay strings (the house's read of 4e37a11, #22). Without a
 * schema (a tool the daemon did not list) the look decides, except for the keys that are always
 * text. A value its type cannot take stays a string, so the daemon's validation names the problem.
 */
function coerce(key: string, raw: string, type: ParamType | undefined): unknown {
  const duration = isDurationKey(key) ? parseDuration(raw) : undefined;
  switch (type) {
    case 'string':
      return raw;
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw;
    case 'integer':
    case 'number':
      return duration ?? (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
    case 'array':
      return /^\[.*\]$/s.test(raw) ? parseJson(key, raw) : raw.split(',');
    case 'object':
      return parseJson(key, raw);
    default:
      if (key === 'keys') return raw.split(',');
      if (TEXT_KEYS.has(key)) return raw;
      if (/^\{.*\}$/s.test(raw)) return parseJson(key, raw);
      if (raw === 'true' || raw === 'false') return raw === 'true';
      if (duration !== undefined) return duration;
      return /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
}

/**
 * One argument as sh, bash, zsh and fish all read it: a plain word stays bare; anything else goes
 * in single quotes, where nothing is special to the POSIX shells and only the quote and the
 * backslash are to fish — so those two go outside the quotes, backslash-escaped, which all four
 * read the same way (`it's` → `'it'\''s'`, `a\b` → `'a'\\'b'`).
 */
function shellWord(w: string): string {
  if (w === '') return "''";
  // A word beginning with = or ~ is never left bare: zsh's EQUALS option (on by default) expands a
  // leading =name to a path (so `==` fails with "= not found"), and ~ is home-directory expansion in
  // zsh and bash (the house's read, #22 comment 6264958172). = stays bare mid-word (FOO=bar).
  if (!/^[=~]/.test(w) && /^[A-Za-z0-9_@%+=:,./-]+$/.test(w)) return w;
  return w.replace(/[^'\\]+|['\\]/g, (m) => (m === "'" || m === '\\' ? `\\${m}` : `'${m}'`));
}

/**
 * The command for `run`: the words before `--` are a command line as typed, for the shell to
 * parse (pipes and quotes work); each word after `--` is one argument of the command, quoted so
 * the session's shell passes it whole. They were joined with spaces and split again by the
 * shell, so `tsm run q -- echo "a;b"` ran `b` as a command (the house's read of 4e37a11, #22).
 */
function commandLine(words: string[], exactFrom: number): string {
  return [...words.slice(0, exactFrom), ...words.slice(exactFrom).map(shellWord)].join(' ');
}

interface Parsed {
  tool: string;
  args: Record<string, unknown>;
  json: boolean;
  untilDone: boolean;
  /** A positional word a flags-only tool does not take, left for the caller to report once the tool's schema is known. */
  stray?: string;
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The hint for a stray word on a tool called by its full name (no positional shorthand). Built from
 * the tool's own schema, so it names the tool's real parameters, or says it takes none — never a
 * fixed `--session` the tool may not have (the house's read, #22 comment 6264958172).
 */
function strayHint(cmd: string, stray: string, schema: Schema | undefined): string {
  const names = schema?.properties ? Object.keys(schema.properties) : undefined;
  if (names && names.length) return `${cmd} takes --flags only (unexpected word ${stray}): tsm ${cmd} ${names.slice(0, 4).map((p) => `--${kebab(p)} <value>`).join(' ')}${names.length > 4 ? ' …' : ''}`;
  if (schema) return `${cmd} takes no arguments (unexpected word ${stray})`;
  return `${cmd} takes --flags only (unexpected word ${stray})`;
}

/** The arguments of a tool call; `--json` and `--until-done` are tsm's own. */
function parse(argv: string[], schema: Schema | undefined): Parsed {
  const [cmd = '', ...rest] = argv;
  const short = SHORT[cmd];
  const tool = short?.tool ?? cmd;
  const props = schema?.properties ?? {};
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  /** Where in `positional` the words after `--` begin. */
  let exact: number | undefined;
  let json = false;
  let untilDone = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') {
      // ux-18: everything after `--` belongs to the command, its own flags included.
      exact = positional.length;
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--until-done') {
      untilDone = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = camel(eq === -1 ? a.slice(2) : a.slice(2, eq));
      const type = typeOf(props[key]);
      const next = rest[i + 1];
      let raw: string;
      if (eq !== -1) raw = a.slice(eq + 1);
      // A yes/no flag stands alone: `--queue echo hi` leaves `echo` to the command (the house's read of 4e37a11, #22).
      else if (type === 'boolean') raw = 'true';
      else if (next === undefined || next.startsWith('--')) {
        if (type !== undefined) throw new Error(`${a} needs a value`);
        raw = 'true';
      } else raw = rest[++i]!;
      args[key] = coerce(key, raw, type);
      continue;
    }
    positional.push(a);
  }
  const names = short ? (short.single !== undefined && positional.length === 1 ? [short.single] : short.positional) : [];
  names.forEach((name, i) => {
    if (short?.join === name) {
      const words = positional.slice(i);
      const v = name === 'command' && exact !== undefined ? commandLine(words, Math.max(0, exact - i)) : words.join(' ');
      if (v) args[name] = v;
    } else if (positional[i] !== undefined) args[name] = positional[i];
  });
  // A word nothing takes is a mistake to say, not to drop. A shorthand tool's extra positional is a
  // usage error now (its forms are fixed); a tool called by name is flags-only, and the stray word's
  // hint is built from its schema by the caller, so it is left here for the schema-aware parse.
  const stray = short?.join !== undefined ? undefined : positional[names.length];
  if (stray !== undefined && short) throw new Error(`${cmd}: unexpected word ${stray}`);
  const parsed: Parsed = { tool, args, json, untilDone };
  if (stray !== undefined && !short) parsed.stray = stray;
  return parsed;
}

/** The exit code for a finished call's envelope (see the header). */
function exitCode(tool: string, structured: Record<string, unknown>): number {
  const state = structured.state;
  if (tool === 'run' || tool === 'await') {
    if (state === 'exited') {
      if (typeof structured.exit === 'number') return Math.max(0, Math.min(structured.exit, 255));
      const signo = typeof structured.signal === 'string' ? (os.constants.signals as Record<string, number | undefined>)[structured.signal] : undefined;
      // Neither a code nor a signal: the status is unknown, which is never success.
      return signo !== undefined ? 128 + signo : 1;
    }
    if (isUnfinished(state)) return EXIT_UNFINISHED;
    if (state === 'busy') return EXIT_BUSY;
    return 1;
  }
  if (tool === 'start') {
    if (state === 'busy') return EXIT_BUSY;
    const service = structured.service;
    // `running` is a service alive with no readiness condition to check: up, which is all that
    // can be known of it, and so success (the house's read of 4e37a11, #22).
    if (service === 'ready' || service === 'running') return 0;
    if (service === 'starting') return EXIT_UNFINISHED;
    return 1;
  }
  // Known to have ended; `lost` means its end was never observed, so nothing is known to have stopped.
  if (tool === 'cancel') return state === 'cancelled' || state === 'exited' ? 0 : 1;
  return 0;
}

/** The GUI is served by termd at its own origin (§12); the page reads `?token=` once and forgets it from the address bar. */
function guiUrl(): string {
  const ws = new URL(setting('TSM_URL') ?? 'ws://127.0.0.1:3101');
  const http = new URL(`${ws.protocol === 'wss:' ? 'https:' : 'http:'}//${ws.host}/`);
  const token = setting('TSM_TOKEN') ?? ws.searchParams.get('token');
  if (token) http.searchParams.set('token', token);
  return http.toString();
}

/** `tsm usage`: the Measure report, read from the daemon's usage log on this machine. */
function usageReport(argv: string[]): void {
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      json = true;
      continue;
    }
    const m = /^--(file|since)(?:=(.*))?$/s.exec(a);
    if (!m) throw new Error(`usage: unknown argument ${a} (tsm usage [--file F] [--since ISO] [--json])`);
    const v = m[2] ?? argv[++i];
    if (v === undefined) throw new Error(`--${m[1]} needs a value`);
    opts[m[1]!] = v;
  }
  const file = opts.file ?? path.join(setting('TSM_DATA_DIR') ?? path.join(os.homedir(), '.tsm'), 'usage.jsonl');
  // A date that does not parse, or a log that cannot be read, is an error — not an empty
  // report that says nothing was recorded (the house's read of 4e37a11, #22).
  const since = opts.since !== undefined ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
  if (Number.isNaN(since)) throw new Error(`--since: not a date (ISO 8601, e.g. 2026-10-19T00:00:00Z): ${opts.since}`);
  let records: ReturnType<typeof readUsage>;
  try {
    records = readUsage(file).filter((r) => r.ts >= since);
  } catch (e) {
    throw new Error(`cannot read the usage log: ${e instanceof Error ? e.message : String(e)}`);
  }
  const report = analyze(records);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!report.calls) {
    console.log(`no usage recorded in ${file}`);
    return;
  }
  console.log(`${report.calls} calls, ${report.from} → ${report.to} · by host: ${Object.entries(report.byHost).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('\ntool                 calls  errors  p50');
  for (const [t, v] of Object.entries(report.byTool).sort((a, b) => b[1].calls - a[1].calls)) console.log(`${t.padEnd(20)} ${String(v.calls).padStart(5)}  ${String(v.errors).padStart(6)}  ${v.p50ms}ms`);
  if (Object.keys(report.errors).length) console.log(`\nerrors: ${Object.entries(report.errors).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`\nconfusion signatures (${report.agentCalls} agent calls; a human's GUI and the native family are not counted)`);
  for (const [k, v] of Object.entries(report.signatures)) console.log(`${String(v.count).padStart(5)}  ${k}: ${v.description}`);
  const w = report.waits;
  console.log(`\nwaits: ${w.awaitAfterUnfinished} awaits after an unfinished result; ${w.runsAwaited} Runs finished later, extra time p50 ${w.extraMs.p50}ms, p90 ${w.extraMs.p90}ms, max ${w.extraMs.max}ms`);
}

/** The daemon connection, when one is open: `end` closes it cleanly. */
let socket: WebSocket | undefined;

/**
 * Print the result and end. The exit code is set first, and the process ends only once the
 * text has left for the reader: `process.exit` straight after `console.log` cut a 1 MiB `--json`
 * at the pipe's buffer and still exited 0 (the house's read of 4e37a11, #22). The daemon
 * connection is closed cleanly, so a held seat is given up at once (§9); a close the daemon
 * never acknowledges holds the exit for a second at most.
 */
function end(code: number, text: string, stream: NodeJS.WriteStream = process.stdout): void {
  process.exitCode = code;
  // A reader that went away (`tsm read … | head -1`) is no error of tsm's: the code stands.
  stream.once('error', () => process.exit());
  stream.write(`${text}\n`, () => {
    socket?.close(1000);
    setTimeout(() => process.exit(), 1000).unref();
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') return end(0, USAGE);
  if (cmd === 'gui') return end(0, parse(argv, undefined).json ? JSON.stringify({ url: guiUrl() }, null, 2) : guiUrl());
  if (cmd === 'usage') return usageReport(argv.slice(1));
  // The syntax is checked before any daemon is asked: a stray word or a flag without its value is a
  // usage error whether or not termd runs, and `--json` means tsm's own flag only before `--`.
  const syntax = parse(argv, undefined);
  const url = new URL(setting('TSM_URL') ?? 'ws://127.0.0.1:3101');
  const token = setting('TSM_TOKEN');
  if (token) url.searchParams.set('token', token);
  url.searchParams.set('profile', 'full');
  url.searchParams.set('resultText', syntax.json ? 'json' : 'transcript');
  url.searchParams.set('connection', `tsm-${process.pid}`);
  // The CLI is the native family, with the GUI: its calls are not an agent's in `tsm usage` (the house's read of 4e37a11, #22).
  url.searchParams.set('client', 'cli');
  const ws = new WebSocket(url.toString());
  socket = ws;
  const pending = new Map<number, { settle: (m: { result?: unknown; error?: { message: string } }) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let lost: Error | undefined;
  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (lost) return reject(lost);
      const id = nextId++;
      pending.set(id, { settle: (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)), reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  ws.on('message', (d) => {
    let m: { id?: number; result?: unknown; error?: { message: string } };
    try {
      m = JSON.parse(d.toString()) as typeof m;
    } catch {
      return;
    }
    if (m.id === undefined) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    p?.settle(m);
  });
  // A socket that closes (or fails) before the answer settles every pending call as an error:
  // `tsm run build 'npm test' && ./deploy` must not deploy when the daemon died mid-run (jr-18).
  const failAll = (why: string) => {
    lost ??= new Error(`daemon connection to ${url.origin} ${why} before a result; the outcome is unknown`);
    for (const p of pending.values()) p.reject(lost);
    pending.clear();
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(new Error(connectError(url, e.message))));
  });
  ws.on('error', (e) => failAll(`failed (${e.message})`));
  ws.on('close', (code) => failAll(`closed (${code})`));
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tsm', version: '0' } });
  // The daemon's schema for the tool says what each flag's value is (see coerce); a daemon that
  // lists nothing leaves the values to their look.
  const toolName = SHORT[cmd]?.tool ?? cmd;
  const listed = (await request('tools/list').catch(() => undefined)) as { tools?: Array<{ name: string; inputSchema?: Schema }> } | undefined;
  const { json, untilDone } = syntax;
  const schema = listed?.tools?.find((t) => t.name === toolName)?.inputSchema;
  const { tool, args, stray } = parse(argv, schema);
  // A flags-only tool given a positional word: report it now the schema is known, named for this tool.
  if (stray !== undefined) throw new Error(strayHint(cmd, stray, schema));
  let r = (await request('tools/call', { name: tool, arguments: args })) as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  // --until-done: after the initial observation, long-poll until the Run ends. A short
  // initial wait (including zero) must not turn this into a busy polling loop.
  const unfinished = (x: typeof r) => !x.isError && isUnfinished(x.structuredContent?.state);
  while (untilDone && (tool === 'run' || tool === 'await') && unfinished(r) && typeof r.structuredContent?.runId === 'string') {
    const again: Record<string, unknown> = { runId: r.structuredContent.runId, wait: 55_000 };
    if (typeof r.structuredContent.session === 'string') again.session = r.structuredContent.session;
    r = (await request('tools/call', { name: 'await', arguments: again })) as typeof r;
  }
  const structured = r.structuredContent ?? {};
  let text = r.content.map((c) => c.text).join('\n');
  // A command's own flag taken for a tool parameter: say how to pass it through (ux-18).
  const unknownFlag = r.isError ? /\.([A-Za-z0-9_]+): is not a known parameter/.exec(text)?.[1] : undefined;
  if (unknownFlag && (tool === 'run' || tool === 'input')) text += `\n(--${unknownFlag} is not a parameter of ${tool}; to pass it to the command, put the command after --, e.g. tsm ${cmd} <session> -- <command…>)`;
  end(r.isError ? 1 : exitCode(tool, structured), json ? JSON.stringify(r.isError ? { error: text } : structured, null, 2) : text);
}

/** What a refused or failed connect means, in words (ux-18): the ws library reports only the status. */
function connectError(url: URL, message: string): string {
  const status = /Unexpected server response: (\d+)/.exec(message)?.[1];
  const at = `the daemon at ${url.origin}`;
  if (status === '401') return `${at} refused the credential (401): set TSM_TOKEN to a token it accepts`;
  if (status === '403') return `${at} refused the connection (403): ${message}`;
  if (status === '421') return `${at} does not serve the Host name ${url.host} (421): start termd with --allow-host ${url.host}, or connect through a loopback name`;
  if (status === '429' || status === '503') return `${at} has too many connections (${status}); try again`;
  return `cannot reach ${at}: ${message}`;
}

main().catch((e: unknown) => end(1, e instanceof Error ? e.message : String(e), process.stderr));
