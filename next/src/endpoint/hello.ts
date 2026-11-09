import { shellQuote } from '../core/launch.js';

export const HELLO = 'terminal-sessions/hello';

export const STOP = 'terminal-sessions/stop';

export const SCOPE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface ClientHello {
  version: string;
  scope: string;
  client: 'relay' | 'cli';
}

export interface DaemonHello {
  version: string;
  pid: number;
  startedAt: string;
}

export const helloLine = (params: ClientHello | DaemonHello): string => `${JSON.stringify({ jsonrpc: '2.0', method: HELLO, params })}\n`;

const paramsOf = (line: string): Record<string, unknown> | undefined => {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const m = v as { method?: unknown; params?: unknown };
  if (m.method !== HELLO || typeof m.params !== 'object' || m.params === null) return undefined;
  return m.params as Record<string, unknown>;
};

export function parseClientHello(line: string): ClientHello | undefined {
  const p = paramsOf(line);
  if (!p || typeof p.version !== 'string' || typeof p.scope !== 'string' || !SCOPE_RE.test(p.scope)) return undefined;
  if (p.client !== 'relay' && p.client !== 'cli') return undefined;
  return { version: p.version, scope: p.scope, client: p.client };
}

export function parseDaemonHello(line: string): DaemonHello | undefined {
  const p = paramsOf(line);
  if (!p || typeof p.version !== 'string' || typeof p.pid !== 'number' || typeof p.startedAt !== 'string') return undefined;
  return { version: p.version, pid: p.pid, startedAt: p.startedAt };
}

export function versionNote(relay: string, daemon: DaemonHello, socket: string): string | undefined {
  if (relay === daemon.version) return undefined;
  return (
    `The terminal-sessions daemon is version ${daemon.version}, running since ${daemon.startedAt}, and the relay that reached it is ${relay}. ` +
    `The daemon keeps its version until it restarts, which ends every shell it holds, so restarting it is for whoever runs it to choose: \`tsm --socket ${shellQuote(socket)} daemon stop\`, then any call.`
  );
}
