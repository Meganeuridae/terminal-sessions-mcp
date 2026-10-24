/**
 * A scriptable host for end-to-end tests: MCP or MCPL over the real endpoint.
 * By default it answers every server-initiated request the way a real host
 * does (register → accepted, incoming → accepted, push/event → accepted) and
 * keeps a log of everything the server sent.
 */
import assert from 'node:assert/strict';
import * as net from 'node:net';
import WebSocket from 'ws';

export type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export interface Delivery {
  via: 'push' | 'incoming';
  messageId: string;
  text: string;
  tags: string[];
  metadata: Record<string, unknown>;
  channelId: string;
}

export interface HostOptions {
  port: number;
  token: string;
  connection: string;
  mcpl?: boolean;
  grant?: string[];
  enabled?: string[];
  resultText?: 'json' | 'transcript';
  profile?: string;
  /** Override the automatic answer per request: a value is the result, a Promise answers when it resolves (a slow host), undefined keeps the default. */
  answer?: (m: Msg) => unknown | undefined;
}

export const FULL_GRANT = ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.incoming', 'channels.publish', 'contextHooks.beforeInference.inject.beforeUser'];

export class TestHost {
  ws!: WebSocket;
  readonly log: Msg[] = [];
  receipt: Record<string, unknown> | undefined;
  private nextId = 1;
  private pending = new Map<number, (m: Msg) => void>();
  private listeners = new Set<(m: Msg) => void>();
  closed = false;

  constructor(readonly o: HostOptions) {}

  async connect(): Promise<this> {
    const q = new URLSearchParams({ token: this.o.token, connection: this.o.connection, resultText: this.o.resultText ?? 'transcript' });
    if (this.o.profile) q.set('profile', this.o.profile);
    this.ws = new WebSocket(`ws://127.0.0.1:${this.o.port}/?${q}`);
    this.ws.on('message', (d) => this.onFrame(JSON.parse(d.toString()) as Msg));
    this.ws.on('close', () => (this.closed = true));
    await new Promise<void>((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
    const caps = this.o.mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true, contextHooks: { beforeInference: true }, channels: { register: true, publish: true, incoming: true, lifecycle: true }, featureSets: true } } } : {};
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 'testhost', version: '0' } });
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    if (this.o.mcpl) {
      const p: Record<string, unknown> = { effectiveCapabilities: this.o.grant ?? FULL_GRANT };
      if (this.o.enabled) p.enabled = this.o.enabled;
      this.receipt = (await this.request('featureSets/update', p)) as Record<string, unknown>;
    }
    return this;
  }

  private onFrame(m: Msg): void {
    if (m.method === undefined) {
      if (typeof m.id === 'number') this.pending.get(m.id)?.(m);
      return;
    }
    this.log.push(m);
    if (m.id !== undefined) {
      const custom = this.o.answer?.(m);
      if (custom instanceof Promise) void custom.then((v) => this.respond(m, v));
      else if (custom !== undefined) this.respond(m, custom);
      else if (m.method === 'channels/register' || m.method === 'channels/incoming' || m.method === 'push/event') this.respond(m, TestHost.accept(m));
    }
    for (const l of [...this.listeners]) l(m);
  }

  respond(m: Msg, result: unknown): void {
    if (m.id !== undefined && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  }

  respondError(m: Msg, code: number, message: string): void {
    if (m.id !== undefined) this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message } }));
  }

  /** The default answer to a server request (what an accepting host says). */
  static accept(m: Msg): unknown {
    if (m.method === 'channels/register') return { results: ((m.params as { channels: Array<{ id: string }> }).channels ?? []).map((c) => ({ id: c.id, accepted: true })) };
    if (m.method === 'channels/incoming') return { results: ((m.params as { messages: Array<{ messageId: string }> }).messages ?? []).map((x) => ({ messageId: x.messageId, accepted: true })) };
    if (m.method === 'push/event') return { accepted: true };
    return {};
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        this.pending.delete(id);
        if (m.error) reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data }));
        else resolve(m.result);
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, unknown> | undefined; isError?: boolean }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    const out: { text: string; structured: Record<string, unknown> | undefined; isError?: boolean } = { text: r.content.map((c) => c.text).join('\n'), structured: r.structuredContent };
    if (r.isError) out.isError = true;
    return out;
  }

  /** Every message delivered so far, push and incoming, flattened. */
  deliveries(): Delivery[] {
    const out: Delivery[] = [];
    for (const m of this.log) {
      if (m.method === 'push/event') {
        const p = m.params as { eventId: string; tags: string[]; origin: Record<string, unknown>; payload: { content: Array<{ text: string }> } };
        out.push({ via: 'push', messageId: p.eventId, text: p.payload.content.map((c) => c.text).join('\n'), tags: p.tags ?? [], metadata: p.origin, channelId: String(p.origin.channelId) });
      } else if (m.method === 'channels/incoming') {
        for (const x of (m.params as { messages: Array<{ messageId: string; channelId: string; tags: string[]; metadata: Record<string, unknown>; content: Array<{ text: string }> }> }).messages) {
          out.push({ via: 'incoming', messageId: x.messageId, text: x.content.map((c) => c.text).join('\n'), tags: x.tags ?? [], metadata: x.metadata, channelId: x.channelId });
        }
      }
    }
    return out;
  }

  /** Resolve with the first delivery (already received or upcoming) that satisfies `pred`. */
  delivery(pred: (d: Delivery) => boolean, ms = 5000): Promise<Delivery> {
    const found = this.deliveries().find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`no matching delivery within ${ms} ms; got: ${JSON.stringify(this.deliveries().map((d) => d.text.split('\n')[0]))}`));
      }, ms);
      const l = () => {
        const d = this.deliveries().find(pred);
        if (d) {
          clearTimeout(t);
          this.listeners.delete(l);
          resolve(d);
        }
      };
      this.listeners.add(l);
    });
  }

  /** Assert no delivery satisfying `pred` arrives within `ms`. */
  async noDelivery(pred: (d: Delivery) => boolean, ms: number, why = ''): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const bad = this.deliveries().filter(pred);
    assert.equal(bad.length, 0, `unexpected deliveries ${why}: ${JSON.stringify(bad.map((d) => d.text.split('\n')[0]))}`);
  }

  message(method: string, ms = 5000): Promise<Msg> {
    const found = this.log.find((m) => m.method === method);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`no ${method} within ${ms} ms`));
      }, ms);
      const l = (m: Msg) => {
        if (m.method === method) {
          clearTimeout(t);
          this.listeners.delete(l);
          resolve(m);
        }
      };
      this.listeners.add(l);
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((r) => {
      this.ws.once('close', () => r());
      this.ws.close(1000);
    });
  }
}

// ───────────── the helpers every spec shares (defined here once; fake-shell.ts re-exports `until`) ─────────────

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds (shells, sockets and timers answer asynchronously), or fail naming what was waited for. */
export async function until(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * Run synchronous work and give the process's CPU time it took, in ms. A bound on what code costs reads this rather than
 * the wall clock: with the suite's files run side by side, a busy machine keeps the process waiting for a core, and that
 * wait is no cost of the code. Wall time stays the measure where waiting is the point (a timer, a close, a budget, a
 * disk). It counts every thread of the process, the garbage collector's helpers included, so it can read above the wall
 * clock. An async `f` would be timed only to its first await, so a promise back is refused.
 */
export function cpuMs<T>(f: () => T): { value: T; ms: number } {
  const start = process.cpuUsage();
  const value = f();
  const { user, system } = process.cpuUsage(start);
  if (typeof (value as { then?: unknown } | null | undefined)?.then === 'function') throw new TypeError('cpuMs times synchronous work only');
  return { value, ms: (user + system) / 1000 };
}

/** A port nothing listens on right now, for a test that must name one before it starts a server. */
export function unusedPort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}
