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
 *   75                             busy: the shell is running another Run (EX_TEMPFAIL: retry)
 *   1                              an error, a cancelled or lost Run, a failed start or cancel,
 *                                  or a daemon connection lost before the result (the outcome
 *                                  is then unknown)
 * A command may itself exit 124 (timeout(1) does), 75 or 1, so the code alone cannot tell a
 * Run that ended so from one not finished, busy or lost: `--json` and its `state` are the
 * authority (G27), and `--until-done` on `run` and `await` keeps awaiting past the per-call
 * cap until the Run has ended, so a script that only wants the outcome reads no 124 at all
 * (the house's review of #11). `start` exits 0 when the service is ready, 124 while it is
 * starting, 1 when it is unhealthy or exited; `cancel` exits 0 once the Run has ended and 1
 * when it survived.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { analyze, readUsage } from '../api/usage.js';

/** Not finished (running, starting, queued): the wait ran out, like timeout(1). */
const EXIT_UNFINISHED = 124;
/** Busy: the shell is occupied by another Run; try again (sysexits EX_TEMPFAIL). */
const EXIT_BUSY = 75;

const USAGE = `tsm <command> [args] [--key value ...] [--json]
  sessions                              list sessions
  open <session> [--cwd DIR] [--shell S] [--visibility shared] [--control open]
  close <session> [--force]
  run <session> [--wait 20s] [--target process] [--queue] [--until-done] [--] <command...>
                                        after --, every word is the command's, flags included
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
Durations (--wait and any --*-ms flag): 500ms, 20s, 2m, or plain milliseconds. A {…} value is JSON
(start --ready '{"pattern":"listening"}').
Env: TSM_URL (ws://127.0.0.1:3101), TSM_TOKEN.
Exit code: a run's exit code; 128+N when it died on signal N; ${EXIT_UNFINISHED} while it is still running
(await it); ${EXIT_BUSY} when the shell is busy; 1 on error, for a cancelled or lost Run, and when the
daemon connection was lost before the result (the outcome is then unknown). start: 0 ready, ${EXIT_UNFINISHED}
starting, 1 unhealthy or exited. cancel: 0 once the Run ended, 1 if it survived.`;

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

/** `500ms`, `20s`, `1.5s`, `2m`, `1h` → milliseconds; a plain integer is milliseconds already. */
function parseDuration(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const ms = n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1);
  return Math.round(ms);
}

const isDurationKey = (k: string) => k === 'wait' || /Ms$/.test(k);
/** Values that are always text, even when they look like JSON. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['command', 'text', 'line', 'pattern']);

/** A `{…}` value is an object parameter (start's --ready, --fail, --health). */
function parseObject(key: string, v: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    console.error(`--${key}: not valid JSON: ${v}`);
    process.exit(1);
  }
}

function parse(argv: string[]): { tool: string; args: Record<string, unknown>; json: boolean; untilDone: boolean } {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  const short = SHORT[cmd];
  const tool = short?.tool ?? cmd;
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  let json = false;
  let untilDone = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') {
      // ux-18: everything after `--` belongs to the command, its own flags included.
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
      let val: string | undefined = eq === -1 ? rest[i + 1] : a.slice(eq + 1);
      if (eq === -1 && (val === undefined || val.startsWith('--'))) val = 'true';
      else if (eq === -1) i++;
      if (key === 'keys') args[key] = String(val).split(',');
      else if (/^\{.*\}$/s.test(String(val)) && !TEXT_KEYS.has(key)) args[key] = parseObject(key, String(val));
      else if (val === 'true' || val === 'false') args[key] = val === 'true';
      else if (isDurationKey(key) && parseDuration(String(val)) !== undefined) args[key] = parseDuration(String(val));
      else if (/^-?\d+$/.test(String(val))) args[key] = Number(val);
      else args[key] = val;
      continue;
    }
    positional.push(a);
  }
  if (short) {
    const names = short.single !== undefined && positional.length === 1 ? [short.single] : short.positional;
    names.forEach((name, i) => {
      if (short.join === name) {
        const v = positional.slice(i).join(' ');
        if (v) args[name] = v;
      } else if (positional[i] !== undefined) args[name] = positional[i];
    });
  }
  return { tool, args, json, untilDone };
}

/** The exit code for a finished call's envelope (see the header). */
function exitCode(tool: string, structured: Record<string, unknown>): number {
  const state = structured.state;
  if (tool === 'run' || tool === 'await') {
    if (state === 'exited') {
      if (typeof structured.exit === 'number') return Math.max(0, Math.min(structured.exit, 255));
      const signo = typeof structured.signal === 'string' ? (os.constants.signals as Record<string, number | undefined>)[structured.signal] : undefined;
      return signo !== undefined ? 128 + signo : 1;
    }
    if (state === 'running' || state === 'starting' || state === 'queued') return EXIT_UNFINISHED;
    if (state === 'busy') return EXIT_BUSY;
    return 1;
  }
  if (tool === 'start') {
    if (state === 'busy') return EXIT_BUSY;
    const service = structured.service;
    if (service === 'ready') return 0;
    if (service === 'starting') return EXIT_UNFINISHED;
    return 1;
  }
  if (tool === 'cancel') return state === 'cancelled' || state === 'exited' ? 0 : 1;
  return 0;
}

/** The GUI is served by termd at its own origin (§12); the page reads `?token=` once and forgets it from the address bar. */
function guiUrl(): string {
  const ws = new URL(process.env.TSM_URL ?? 'ws://127.0.0.1:3101');
  const http = new URL(`${ws.protocol === 'wss:' ? 'https:' : 'http:'}//${ws.host}/`);
  const token = process.env.TSM_TOKEN || ws.searchParams.get('token');
  if (token) http.searchParams.set('token', token);
  return http.toString();
}

/** `tsm usage`: the Measure report, read from the daemon's usage log on this machine. */
function usageReport(argv: string[]): void {
  const opt = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const file = opt('file') ?? path.join(process.env.TSM_DATA_DIR ?? path.join(os.homedir(), '.tsm'), 'usage.jsonl');
  const since = opt('since') !== undefined ? Date.parse(opt('since')!) : Number.NEGATIVE_INFINITY;
  const records = readUsage(file).filter((r) => r.ts >= since);
  const report = analyze(records);
  if (argv.includes('--json')) {
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

async function main(): Promise<void> {
  if (process.argv[2] === 'gui') {
    console.log(guiUrl());
    return;
  }
  if (process.argv[2] === 'usage') {
    usageReport(process.argv.slice(3));
    return;
  }
  const { tool, args, json, untilDone } = parse(process.argv.slice(2));
  const url = new URL(process.env.TSM_URL ?? 'ws://127.0.0.1:3101');
  if (process.env.TSM_TOKEN) url.searchParams.set('token', process.env.TSM_TOKEN);
  url.searchParams.set('profile', 'full');
  url.searchParams.set('resultText', json ? 'json' : 'transcript');
  url.searchParams.set('connection', `tsm-${process.pid}`);
  const ws = new WebSocket(url.toString());
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
  let r = (await request('tools/call', { name: tool, arguments: args })) as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  // --until-done: after the initial observation, long-poll until the Run ends. A short
  // initial wait (including zero) must not turn this into a busy polling loop.
  const unfinished = (x: typeof r) => !x.isError && ['running', 'starting', 'queued'].includes(String(x.structuredContent?.state));
  while (untilDone && (tool === 'run' || tool === 'await') && unfinished(r) && typeof r.structuredContent?.runId === 'string') {
    const again: Record<string, unknown> = { runId: r.structuredContent.runId, wait: 55_000 };
    if (typeof r.structuredContent.session === 'string') again.session = r.structuredContent.session;
    r = (await request('tools/call', { name: 'await', arguments: again })) as typeof r;
  }
  const structured = r.structuredContent ?? {};
  let text = r.content.map((c) => c.text).join('\n');
  // A command's own flag taken for a tool parameter: say how to pass it through (ux-18).
  const unknownFlag = r.isError ? /\.([A-Za-z0-9_]+): is not a known parameter/.exec(text)?.[1] : undefined;
  if (unknownFlag && (tool === 'run' || tool === 'input')) text += `\n(--${unknownFlag} is not a parameter of ${tool}; to pass it to the command, put the command after --, e.g. tsm ${process.argv[2]} <session> -- <command…>)`;
  if (json) console.log(JSON.stringify(r.isError ? { error: text } : structured, null, 2));
  else console.log(text);
  ws.close(1000);
  process.exit(r.isError ? 1 : exitCode(tool, structured));
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
