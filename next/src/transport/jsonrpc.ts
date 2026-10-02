/** JSON-RPC 2.0 shapes and helpers for the WebSocket transport. */

export type Id = string | number;

export interface Request {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: unknown;
}

export interface Response {
  jsonrpc: '2.0';
  id: Id | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type Message = Request | Response;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL = -32603;
/** MCPL: capability denied (SPEC §14.6). */
export const CAPABILITY_DENIED = -32002;
export const CHANNEL_NOT_PERMITTED = -32017;
export const UNKNOWN_CHANNEL = -32023;
/** Too many requests in flight on one connection (implementation-defined, outside MCPL's allocations). */
export const OVERLOADED = -32050;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** What one parsed frame is. Anything a client can send lands in exactly one of these. */
export type Frame =
  | { kind: 'request'; msg: Request }
  | { kind: 'response'; msg: Response }
  /** Answer with this error, unless `id` is undefined (an invalid notification gets no answer). */
  | { kind: 'invalid'; id: Id | null | undefined; code: number; message: string };

/**
 * Classify a parsed frame. Batches are not supported (§12: one message per
 * frame); `null`, arrays and primitives are invalid requests, never a crash.
 */
export function classify(v: unknown): Frame {
  if (Array.isArray(v)) return { kind: 'invalid', id: null, code: INVALID_REQUEST, message: 'batches are not supported; send one message per frame' };
  if (!isPlainObject(v)) return { kind: 'invalid', id: null, code: INVALID_REQUEST, message: 'a message must be a JSON object' };
  const hasId = Object.hasOwn(v, 'id') && v.id !== undefined;
  if (hasId && v.id !== null && !isId(v.id)) return { kind: 'invalid', id: null, code: INVALID_REQUEST, message: 'id must be a string or a number' };
  const id = hasId ? (v.id as Id | null) : undefined;
  if (Object.hasOwn(v, 'method')) {
    if (typeof v.method !== 'string' || v.method === '') return { kind: 'invalid', id: id ?? null, code: INVALID_REQUEST, message: 'method must be a non-empty string' };
    if (v.params !== undefined && !isPlainObject(v.params)) return { kind: 'invalid', id, code: INVALID_PARAMS, message: 'params must be an object' };
    const msg: Request = { jsonrpc: '2.0', method: v.method };
    if (id !== undefined && id !== null) msg.id = id;
    else if (id === null) (msg as { id?: Id | null }).id = null;
    if (v.params !== undefined) msg.params = v.params;
    return { kind: 'request', msg };
  }
  // Neither a request nor a response: an invalid request, answered (id null when it had none).
  if (!Object.hasOwn(v, 'result') && !Object.hasOwn(v, 'error')) return { kind: 'invalid', id: id ?? null, code: INVALID_REQUEST, message: 'a message needs a method (request) or a result or error (response)' };
  // A response to one of ours. A malformed one is dropped, never answered: two peers answering
  // each other's bad responses would loop forever.
  if (!hasId || v.id === null) return { kind: 'invalid', id: undefined, code: INVALID_REQUEST, message: 'a response needs an id' };
  const msg: Response = { jsonrpc: '2.0', id: v.id as Id };
  if (Object.hasOwn(v, 'error') && v.error !== undefined) {
    const e = v.error;
    if (!isPlainObject(e) || typeof e.code !== 'number' || typeof e.message !== 'string') return { kind: 'invalid', id: undefined, code: INVALID_REQUEST, message: 'malformed error object' };
    msg.error = { code: e.code, message: e.message };
    if (e.data !== undefined) msg.error.data = e.data;
  } else msg.result = v.result;
  return { kind: 'response', msg };
}

/** Correlates outbound requests with their responses on one connection. */
export class Outbound {
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly send: (m: Message) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(INTERNAL, `no response to ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Settle the request a response (already checked by `classify`) answers; a stray one is ignored. */
  handleResponse(m: Response): void {
    const p = m.id === null ? undefined : this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id!);
    clearTimeout(p.timer);
    if (m.error) p.reject(new RpcError(m.error.code, m.error.message, m.error.data));
    else p.resolve(m.result);
  }

  rejectAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(INTERNAL, reason));
      this.pending.delete(id);
    }
  }
}
