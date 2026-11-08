import type { Writable } from 'node:stream';
import { reach, type Reached } from '../relay.js';
import { SCOPE_RE } from './hello.js';

export const USAGE = `usage: tsm [--scope NAME] [--socket PATH] COMMAND
  open NAME [--cwd DIR] [--cols N] [--rows N]
  run NAME COMMAND... [--wait S] [--notify-on REGEX]
  send NAME [--text TEXT] [--keys KEY,KEY...] [--wait-for REGEX] [--wait S]
  look NAME [--until end|input] [--match REGEX] [--wait S]
  read NAME [--command N] [--lines FROM:TO] [--match REGEX] [--context N]
  stop NAME [--signal INT|TERM|KILL|HUP|QUIT]
  list
  close NAME [--force]
  daemon stop        stops the daemon, which ends every shell it holds
The scope is the one an agent's relay names with --scope ("default" when it names none). What tsm
is shown is never counted as seen: the agent is still told of it.`;

export type CliCall = { tool: string; args: Record<string, unknown> } | { daemonStop: true };

export interface CliOptions {
  scope: string;
  socket?: string;
  call: CliCall;
}

const FLAGS: Record<string, Record<string, (v: string) => [string, unknown]>> = {
  open: { '--cwd': (v) => ['cwd', v], '--cols': (v) => ['cols', Number(v)], '--rows': (v) => ['rows', Number(v)] },
  run: { '--wait': (v) => ['wait', Number(v)], '--notify-on': (v) => ['notify_on', v] },
  send: { '--text': (v) => ['text', v], '--keys': (v) => ['keys', v.split(',')], '--wait-for': (v) => ['wait_for', v], '--wait': (v) => ['wait', Number(v)] },
  look: { '--until': (v) => ['until', v], '--match': (v) => ['match', v], '--wait': (v) => ['wait', Number(v)] },
  read: {
    '--command': (v) => ['command', Number(v)],
    '--lines': (v) => ['lines', v.split(':').map(Number)],
    '--match': (v) => ['match', v],
    '--context': (v) => ['context', Number(v)],
  },
  stop: { '--signal': (v) => ['signal', v.replace(/^SIG/, '')] },
  list: {},
  close: {},
};

export function parseCli(argv: readonly string[]): CliOptions | { error: string } {
  let scope = 'default';
  let socket: string | undefined;
  let i = 0;
  for (; i < argv.length && argv[i]!.startsWith('--'); i += 2) {
    if (argv[i + 1] === undefined) return { error: `${argv[i]} needs a value` };
    if (argv[i] === '--scope') scope = argv[i + 1]!;
    else if (argv[i] === '--socket') socket = argv[i + 1]!;
    else return { error: `unknown option ${argv[i]}` };
  }
  if (!SCOPE_RE.test(scope)) return { error: `--scope ${JSON.stringify(scope)} isn't a scope: 1 to 64 letters, digits, '.', '_' or '-'` };
  const tool = argv[i++];
  if (tool === undefined) return { error: 'no command given' };
  if (tool === 'daemon') return argv[i] === 'stop' && argv.length === i + 1 ? { scope, ...(socket ? { socket } : {}), call: { daemonStop: true } } : { error: 'the daemon command is `tsm daemon stop`' };
  const flags = FLAGS[tool];
  if (!flags) return { error: `unknown command ${tool}` };
  const args: Record<string, unknown> = {};
  const words: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--force' && tool === 'close') args.force = true;
    else if (a.startsWith('--')) {
      const f = flags[a];
      if (!f) return { error: `${tool} takes no ${a}` };
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      const [k, val] = f(v);
      args[k] = val;
    } else words.push(a);
  }
  if (tool !== 'list') {
    const name = words.shift();
    if (name === undefined) return { error: `${tool} needs a session name` };
    args.name = name;
  }
  if (tool === 'run') {
    if (!words.length) return { error: 'run needs a command' };
    args.command = words.join(' ');
  } else if (words.length) return { error: `${tool} takes no ${JSON.stringify(words[0])}` };
  return { scope, ...(socket ? { socket } : {}), call: { tool, args } };
}

function rpc(r: Reached, method: string, params: unknown, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = r.rest.toString('utf8');
    const onData = (b: Buffer): void => {
      buf += b.toString('utf8');
      check();
    };
    const check = (): void => {
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = JSON.parse(line) as Record<string, unknown>;
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
    const onClose = (): void => reject(new Error('the daemon closed the connection'));
    r.socket.on('data', onData);
    r.socket.once('close', onClose);
    r.socket.resume();
    r.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    check();
  });
}

export async function runCli(o: CliOptions & { socket: string; version: string; startDaemon: () => string; stdout: Writable; stderr: Writable; reachMs?: number }): Promise<number> {
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
      process.kill(r.daemon.pid, 'SIGTERM');
      o.stdout.write(`Asked the daemon (pid ${r.daemon.pid}, running since ${r.daemon.startedAt}) to stop; it hangs up every shell it holds.\n`);
      return 0;
    }
    await rpc(r, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tsm', version: o.version } }, 1);
    const m = await rpc(r, 'tools/call', { name: o.call.tool, arguments: o.call.args }, 2);
    if (m.error) {
      o.stderr.write(`tsm: ${(m.error as { message: string }).message}\n`);
      return 1;
    }
    const result = m.result as { content: Array<{ text: string }>; isError?: boolean };
    (result.isError ? o.stderr : o.stdout).write(`${result.content.map((c) => c.text).join('\n')}\n`);
    return result.isError ? 1 : 0;
  } catch (e) {
    o.stderr.write(`tsm: ${(e as Error).message}\n`);
    return 1;
  } finally {
    r.socket.destroy();
  }
}
