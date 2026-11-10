import type * as net from 'node:net';
import { capabilityGranted, deriveFeatureSets, grantFromUpdate, withRevision, type CapabilityGrantState, type FeatureSetDeclaration, type FeatureSetsUpdateParams } from '@animalabs/mcpl-core';
import { CAPABILITY_DENIED, classify, INTERNAL, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, Outbound, PARSE_ERROR, RpcError, type Id, type Message } from '../transport/jsonrpc.js';
import type { Caller, Host, Wake } from '../tools/host.js';
import { helloLine, parseClientHello, STOP, versionNote, type ClientHello } from './hello.js';

export interface DaemonInfo {
  version: string;
  pid: number;
  startedAt: number;
  socket: string;
}

const TAG_ONTOLOGY = {
  coreTags: [],
  tags: {
    'terminal:ended': { desc: 'A command ended that no call showed', facet: 'lifecycle' },
    'terminal:waiting': { desc: 'A program in front of the shell is waiting for input, on the kernel\'s evidence', facet: 'lifecycle' },
    'terminal:exited': { desc: "A session's shell exited", facet: 'lifecycle' },
    'terminal:match': { desc: 'A pattern you asked to be told of appeared in the output', facet: 'lifecycle' },
  },
  suggestedTreatment: [{ tagsAny: ['terminal:ended', 'terminal:waiting', 'terminal:exited', 'terminal:match'], behavior: 'immediate' }],
  open: true,
};

export const FEATURE_SETS: Record<string, FeatureSetDeclaration> = {
  'terminal.tools': { description: 'The nine tools: open, run, send, look, read, stop, integrate, list, close', uses: ['tools'] },
  'terminal.events': {
    description: 'Wakes for what needs you: a command ended that no call showed, a program waits for input, a shell exited, a pattern you asked for appeared',
    uses: ['pushEvents'],
    tagOntology: TAG_ONTOLOGY,
  } as FeatureSetDeclaration,
};

export function manifest(): Record<string, unknown> {
  return withRevision({ version: '0.5', pushEvents: true, featureSets: FEATURE_SETS } as never) as unknown as Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Hosts deduplicate pushes by eventId (MCPL push/event), so one sequence serves every connection of the daemon. */
let eventSeq = 0;

/**
 * The MCP revisions this server speaks, newest first. What it uses (initialize, ping, tools/list,
 * tools/call with content and isError, and the initialized, cancelled and tools/list_changed
 * notifications) is the same in each; structuredContent is 2025-06-18's, and an older client
 * ignores it.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function serveConnection(socket: net.Socket, host: Host, daemon: DaemonInfo, stopDaemon: (why: string) => void): void {
  let hello: ClientHello | undefined;
  let initialized = false;
  let mcpl = false;
  let coalescing = false;
  let grant: CapabilityGrantState | null = null;
  let policyReceived = false;
  let enabled = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const calls = new Map<Id, AbortController>();
  const cancelled = new Set<Id>();

  const write = (m: Message): void => {
    if (!closed) socket.write(`${JSON.stringify(m)}\n`);
  };
  const out = new Outbound(write, null);
  const has = (path: string): boolean => grant !== null && capabilityGranted(grant.effectiveCapabilities, path);
  const disabled = (n: string): boolean => grant?.disabledFeatureSets.includes(n) === true;
  const toolsAllowed = (): boolean => !mcpl || (policyReceived ? enabled.has('terminal.tools') && has('tools') : !disabled('terminal.tools'));
  const pushes = (): boolean => mcpl && hello?.client === 'relay' && enabled.has('terminal.events') && has('pushEvents');

  const sink = async (w: Wake): Promise<boolean> => {
    if (!pushes()) return false;
    const params: Record<string, unknown> = {
      featureSet: 'terminal.events',
      eventId: `${daemon.pid}-${daemon.startedAt}-${++eventSeq}`,
      timestamp: new Date().toISOString(),
      tags: [w.tag],
      payload: { content: [{ type: 'text', text: w.text }] },
    };
    if (coalescing) params.coalesce = { key: w.key };
    const r = await out.request<{ accepted?: unknown }>('push/event', params);
    return r?.accepted === true;
  };

  const activate = (): void => {
    if (pushes() && !unsubscribe && hello) unsubscribe = host.subscribe(hello.scope, sink);
    if (!pushes() && unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  };

  const caller = (): Caller => ({ scope: hello!.scope, takes: hello!.client !== 'cli', pushes: pushes() });

  const updatePolicy = (params: FeatureSetsUpdateParams, form: 'request' | 'notification'): Record<string, unknown> => {
    const r = grantFromUpdate(grant, params, form);
    grant = r.state;
    if (r.malformed) {
      enabled = new Set();
      policyReceived = true;
      throw new RpcError(INVALID_PARAMS, 'effectiveCapabilities and deniedCapabilities overlap; nothing is granted', { conflicts: r.conflicts });
    }
    const derived = deriveFeatureSets(FEATURE_SETS, r.state.effectiveCapabilities);
    const selected = r.state.enabledFeatureSets;
    const wanted = (n: string): boolean => (selected === null || selected.includes(n) || selected.includes('*')) && !r.state.disabledFeatureSets.includes(n);
    enabled = new Set(derived.enabled.filter(wanted));
    if (form === 'request') policyReceived = true;
    const unavailable = Object.entries(derived.disabled)
      .filter(([n]) => wanted(n))
      .map(([featureSet, d]) => ({ featureSet, missingCapabilities: d.missingCapabilities, effect: 'disabled', reason: d.reason }));
    const notes = (selected ?? []).filter((n) => n !== '*' && !(n in FEATURE_SETS)).map((n) => `unknown feature set ${n}`);
    return { accepted: true, unavailableFeatures: unavailable, notes, ...(unavailable.length ? { mode: 'degraded' } : {}) };
  };

  const dispatch = async (method: string, p: Record<string, unknown>, id: Id | undefined, after: (fn: () => void) => void): Promise<unknown> => {
    const isRequest = id !== undefined;
    switch (method) {
      case 'initialize': {
        if (initialized) throw new RpcError(INVALID_REQUEST, 'this connection is already initialized');
        initialized = true;
        const caps = isObj(p.capabilities) ? p.capabilities : {};
        const exp = isObj(caps.experimental) ? caps.experimental : {};
        mcpl = exp.mcpl !== undefined;
        const ec = isObj(exp.mcpl) ? exp.mcpl.eventCoalescing : undefined;
        coalescing = ec === true || (isObj(ec) && ec.pushEvents === true);
        const note = versionNote(hello!.version, { version: daemon.version, pid: daemon.pid, startedAt: new Date(daemon.startedAt).toISOString() }, daemon.socket);
        return {
          protocolVersion: typeof p.protocolVersion === 'string' && PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true }, ...(mcpl ? { experimental: { mcpl: manifest() } } : {}) },
          serverInfo: { name: 'terminal-sessions', version: daemon.version },
          instructions:
            `Persistent shells. \`open\` one by name, then \`run\` commands in it, \`send\` keys to what runs, and \`look\` at what's new. Sessions are per scope ("${hello!.scope}" here). ` +
            (mcpl ? 'When your host grants terminal.events, a command that outlives your wait, a program waiting for input, a shell that exits and a pattern you asked for are reported to you. ' : '`look` with `until` waits for what you need. ') +
            (note ?? ''),
        };
      }
      case 'notifications/initialized':
        return undefined;
      case 'notifications/cancelled': {
        const target = p.requestId;
        if ((typeof target === 'string' || typeof target === 'number') && calls.has(target)) {
          cancelled.add(target);
          calls.get(target)!.abort();
        }
        return undefined;
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolsAllowed() ? host.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [] };
      case 'tools/call': {
        if (!toolsAllowed()) throw new RpcError(CAPABILITY_DENIED, 'tools are not granted on this connection', { capability: 'tools' });
        const ac = new AbortController();
        if (id !== undefined) calls.set(id, ac);
        try {
          const r = await host.call(caller(), typeof p.name === 'string' ? p.name : '', p.arguments ?? {}, ac.signal);
          return { content: [{ type: 'text', text: r.text }], structuredContent: r.structured, ...(r.isError ? { isError: true } : {}) };
        } finally {
          if (id !== undefined) calls.delete(id);
        }
      }
      case 'featureSets/update': {
        if (!mcpl) throw new RpcError(METHOD_NOT_FOUND, 'not an MCPL connection');
        const before = toolsAllowed();
        after(() => {
          activate();
          if (toolsAllowed() !== before) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        });
        return updatePolicy(p as unknown as FeatureSetsUpdateParams, isRequest ? 'request' : 'notification');
      }
      case 'mcpl/manifest':
        if (!mcpl) throw new RpcError(METHOD_NOT_FOUND, 'not an MCPL connection');
        return manifest();
      case STOP:
        if (hello!.client !== 'cli') throw new RpcError(METHOD_NOT_FOUND, `${STOP} is for tsm`);
        after(() => stopDaemon('tsm daemon stop asked it to'));
        return {};
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method.slice(0, 64)}`);
    }
  };

  const handle = (line: string): void => {
    if (!hello) {
      hello = parseClientHello(line);
      if (!hello) {
        write({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'the first message on this socket must be terminal-sessions/hello, with a version, a scope and the client' } });
        socket.end();
      }
      return;
    }
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'not JSON' } });
    }
    const f = classify(v);
    if (f.kind === 'invalid') {
      if (f.id !== undefined) write({ jsonrpc: '2.0', id: f.id, error: { code: f.code, message: f.message } });
      return;
    }
    if (f.kind === 'response') return out.handleResponse(f.msg);
    const req = f.msg;
    const id = req.id !== undefined && req.id !== null ? (req.id as Id) : undefined;
    const isRequest = id !== undefined;
    const afters: Array<() => void> = [];
    void dispatch(req.method, (req.params ?? {}) as Record<string, unknown>, id, (fn) => afters.push(fn)).then(
      (result) => {
        if (isRequest && !cancelled.delete(id)) write({ jsonrpc: '2.0', id, result: result ?? {} });
        for (const fn of afters) fn();
      },
      (e: unknown) => {
        for (const fn of afters) fn();
        if (isRequest && !cancelled.delete(id)) {
          const rpc = e instanceof RpcError ? e : new RpcError(INTERNAL, (e as Error).message ?? String(e));
          write({ jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message, ...(rpc.data !== undefined ? { data: rpc.data } : {}) } });
        }
      },
    );
  };

  socket.write(helloLine({ version: daemon.version, pid: daemon.pid, startedAt: new Date(daemon.startedAt).toISOString() }));
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) handle(line);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    closed = true;
    unsubscribe?.();
    for (const ac of calls.values()) ac.abort();
    out.rejectAll('the connection closed');
  });
}
