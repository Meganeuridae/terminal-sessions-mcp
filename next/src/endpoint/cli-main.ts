import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';
import { REACH_MS, reach, type Reached } from '../relay.js';
import { SCOPE_RE, STOP } from './hello.js';
import { shellQuote } from '../core/launch.js';
import { probe } from './socket.js';

export const USAGE = `usage: tsm [--scope NAME] [--socket PATH] [--json] COMMAND
  open NAME [--cwd DIR] [--cols N] [--rows N]
  run NAME [--wait S] [--notify-on REGEX] [--] COMMAND...
      one argument is a command line as typed ('make test | tee log'); several are its words,
      each quoted for the shell; put -- before a command whose words start with --
  send NAME [--text TEXT] [--keys KEY,KEY...] [--paste] [--wait-for REGEX] [--wait S]
  look NAME [--until end|input] [--match REGEX] [--wait S]
  read NAME [--command N] [--lines FROM:TO] [--match REGEX] [--context N]
  stop NAME [--signal NAME]
  integrate NAME [--wait S]
  list
  close NAME [--force]
  daemon stop        stops the daemon, which ends every shell it holds
The scope is the one an agent's relay names with --scope ("default" when it names none). What tsm
is shown is never counted as seen: the agent is still told of it. --json prints the result's
structuredContent as one line of JSON instead of its text. A refusal's text then goes to stderr.`;

export type CliCall = { tool: string; args: Record<string, unknown> } | { daemonStop: true };

export interface CliOptions {
  scope: string;
  socket?: string;
  json?: true;
  call: CliCall;
}

// Number('') is 0.
const num = (flag: string, v: string): number => {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${flag} takes a number, not ${JSON.stringify(v)}`);
  return Number(v);
};

const FLAGS: Record<string, Record<string, (v: string) => [string, unknown]>> = {
  open: { '--cwd': (v) => ['cwd', v], '--cols': (v) => ['cols', num('--cols', v)], '--rows': (v) => ['rows', num('--rows', v)] },
  run: { '--wait': (v) => ['wait', num('--wait', v)], '--notify-on': (v) => ['notify_on', v] },
  send: { '--text': (v) => ['text', v], '--keys': (v) => ['keys', v.split(',')], '--wait-for': (v) => ['wait_for', v], '--wait': (v) => ['wait', num('--wait', v)] },
  look: { '--until': (v) => ['until', v], '--match': (v) => ['match', v], '--wait': (v) => ['wait', num('--wait', v)] },
  read: {
    '--command': (v) => ['command', num('--command', v)],
    '--lines': (v) => {
      const parts = v.split(':');
      if (parts.length !== 2) throw new Error(`--lines takes FROM:TO, not ${JSON.stringify(v)}`);
      return ['lines', parts.map((p) => num('--lines', p))];
    },
    '--match': (v) => ['match', v],
    '--context': (v) => ['context', num('--context', v)],
  },
  stop: { '--signal': (v) => ['signal', v.replace(/^SIG/, '')] },
  integrate: { '--wait': (v) => ['wait', num('--wait', v)] },
  list: {},
  close: {},
};

export function parseCli(argv: readonly string[]): CliOptions | { error: string } {
  let scope = 'default';
  let socket: string | undefined;
  let json = false;
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith('--')) {
    if (argv[i] === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (argv[i + 1] === undefined) return { error: `${argv[i]} needs a value` };
    if (argv[i] === '--scope') scope = argv[i + 1]!;
    else if (argv[i] === '--socket') socket = argv[i + 1]!;
    else return { error: `unknown option ${argv[i]}` };
    i += 2;
  }
  if (!SCOPE_RE.test(scope)) return { error: `--scope ${JSON.stringify(scope)} isn't a scope: 1 to 64 letters, digits, '.', '_' or '-'` };
  const tool = argv[i++];
  if (tool === undefined) return { error: 'no command given' };
  if (tool === 'daemon') {
    if (argv[i] !== 'stop' || argv.length !== i + 1) return { error: 'the daemon command is `tsm daemon stop`' };
    if (json) return { error: '--json prints a tool\'s result, and `tsm daemon stop` calls no tool' };
    return { scope, ...(socket ? { socket } : {}), call: { daemonStop: true } };
  }
  const flags = FLAGS[tool];
  if (!flags) return { error: `unknown command ${tool}` };
  const args: Record<string, unknown> = {};
  const words: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--' && tool === 'run') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--force' && tool === 'close') args.force = true;
    else if (a === '--paste' && tool === 'send') args.paste = true;
    else if (a.startsWith('--')) {
      const f = flags[a];
      if (!f) return { error: `${tool} takes no ${a}` };
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      try {
        const [k, val] = f(v);
        args[k] = val;
      } catch (e) {
        return { error: (e as Error).message };
      }
    } else words.push(a);
  }
  if (tool !== 'list') {
    const name = words.shift();
    if (name === undefined) return { error: `${tool} needs a session name` };
    args.name = name;
  }
  if (tool === 'run') {
    if (!words.length) return { error: 'run needs a command' };
    args.command = words.length === 1 ? words[0] : words.map(shellQuote).join(' ');
  } else if (words.length) return { error: `${tool} takes no ${JSON.stringify(words[0])}` };
  return { scope, ...(socket ? { socket } : {}), ...(json ? { json: true as const } : {}), call: { tool, args } };
}

class ConnectionClosed extends Error {
  constructor() {
    super('the daemon closed the connection');
  }
}

function rpc(r: Reached, method: string, params: unknown, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // A chunk can end inside a UTF-8 character.
    const decoder = new StringDecoder('utf8');
    let buf = decoder.write(r.rest);
    const onData = (b: Buffer): void => {
      buf += decoder.write(b);
      check();
    };
    const check = (): void => {
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          r.socket.off('data', onData);
          r.socket.off('close', onClose);
          reject(new Error('the daemon sent a line that is not JSON'));
          return;
        }
        if (m.id === id && !('method' in m)) {
          r.socket.off('data', onData);
          r.socket.off('close', onClose);
          r.socket.pause();
          r.rest = Buffer.from(buf, 'utf8');
          resolve(m);
          return;
        }
      }
    };
    const onClose = (): void => reject(new ConnectionClosed());
    r.socket.on('data', onData);
    r.socket.once('close', onClose);
    r.socket.resume();
    r.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    check();
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function runCli(o: CliOptions & { socket: string; version: string; startDaemon: (budgetMs: number) => string; stdout: Writable; stderr: Writable; reachMs?: number }): Promise<number> {
  const daemonStop = 'daemonStop' in o.call;
  let r: Reached;
  try {
    r = await reach({
      socket: o.socket,
      hello: { version: o.version, scope: o.scope, client: 'cli' },
      startDaemon: daemonStop ? () => { throw new Error(`no daemon answers at ${o.socket}, so there is none to stop`); } : o.startDaemon,
      ...(o.reachMs === undefined ? {} : { reachMs: o.reachMs }),
    });
  } catch (e) {
    o.stderr.write(`tsm: ${(e as Error).message}\n`);
    return 1;
  }
  try {
    if ('daemonStop' in o.call) {
      const bound = o.reachMs ?? REACH_MS;
      const end = performance.now() + bound;
      const pid = r.daemon.pid;
      const wedged = `the daemon (pid ${pid}, as it named itself) didn't stop within ${bound} ms; if it is stuck, \`kill -KILL ${pid}\` ends it, and each shell gets the hangup a closing terminal sends: the shell ends, with the jobs it hangs up, and a job it disowned or started with nohup lives on`;
      const answer = await within(rpc(r, STOP, {}, 1).catch((e: unknown): Record<string, unknown> => {
        if (e instanceof ConnectionClosed) return {};
        throw e;
      }), bound);
      if (answer === undefined) {
        o.stderr.write(`tsm: ${wedged}\n`);
        return 1;
      }
      if (answer.error) {
        o.stderr.write(`tsm: the daemon refused to stop: ${(answer.error as { message: string }).message}\n`);
        return 1;
      }
      r.socket.destroy();
      for (;;) {
        let seen: string;
        try {
          seen = await probe(o.socket);
        } catch (e) {
          o.stderr.write(`tsm: the daemon (pid ${pid}) was asked to stop, but whether it did can't be seen: ${(e as Error).message}\n`);
          return 1;
        }
        if (seen !== 'answers') break;
        if (performance.now() >= end) {
          o.stderr.write(`tsm: ${wedged}\n`);
          return 1;
        }
        await new Promise((res) => setTimeout(res, 50));
      }
      o.stdout.write(`Stopped the daemon (pid ${pid}, running since ${r.daemon.startedAt}). It hung up each shell it held, and its log names any session whose processes may live on.\n`);
      return 0;
    }
    await rpc(r, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tsm', version: o.version } }, 1);
    const m = await rpc(r, 'tools/call', { name: o.call.tool, arguments: o.call.args }, 2);
    if (m.error) {
      o.stderr.write(`tsm: ${(m.error as { message: string }).message}\n`);
      return 1;
    }
    const result = m.result as { content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean };
    const text = `${result.content.map((c) => c.text).join('\n')}\n`;
    if (o.json) {
      o.stdout.write(`${JSON.stringify(result.structuredContent ?? null)}\n`);
      if (result.isError) o.stderr.write(text);
    } else (result.isError ? o.stderr : o.stdout).write(text);
    return result.isError ? 1 : 0;
  } catch (e) {
    o.stderr.write(`tsm: ${(e as Error).message}\n`);
    return 1;
  } finally {
    r.socket.destroy();
  }
}
