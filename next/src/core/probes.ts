/**
 * Readiness and health probes for Services (§8.3, §13 `ReadinessProbe`): plain
 * modules, each answering one question from observation. None of them looks at
 * the enclosing shell's liveness (G9).
 */
import { MAX_TIMER_MS } from './clock.js';
import * as net from 'node:net';
import { compileLinePattern } from './ansi.js';
import { err } from './errors.js';

export interface TcpTarget {
  port: number;
  host?: string;
}

/**
 * What `start` accepts. Every readiness condition given must pass (they are ANDed).
 * With none, nothing can assert `ready` (G9): the service reports `running` once
 * it has stayed alive through a short liveness window (LIVENESS_MS), or `exited`
 * if it ends within it.
 */
export interface ServiceSpec {
  ready?: {
    /** Regex over the Run's output lines, per stream, as `search` reads them (a prompt with no newline counts once quiet). */
    pattern?: string;
    /** A TCP port that must accept a connection. */
    tcp?: TcpTarget;
    /** The Run must not exit within this many ms. */
    exitWithinMs?: number;
    /** Report `unhealthy` if the readiness probes have not passed within this many ms (default: stay `starting`). */
    timeoutMs?: number;
  };
  /**
   * Output that means the service is failing. A matching line makes it `unhealthy`,
   * and that verdict stands — health checks do not clear it — until a later line
   * matches `ready.pattern` again (the service says it recovered) or the Run ends.
   */
  fail?: { pattern?: string };
  /**
   * Re-evaluated after readiness (or after `running`, without a readiness probe), on
   * a schedule: a refused connection makes it `unhealthy`, and an accepted one clears
   * only an `unhealthy` a health check caused.
   */
  health?: { tcp?: TcpTarget; intervalMs?: number };
}

export type Connect = (target: TcpTarget, timeoutMs: number) => Promise<boolean>;

/** Does `host:port` accept a TCP connection within `timeoutMs`? */
export const tcpConnect: Connect = (target, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ port: target.port, host: target.host ?? '127.0.0.1' });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/** Without a readiness probe, how long a service must stay alive to be reported `running` (1.x waited the same). */
export const LIVENESS_MS = 2000;


/** Does the spec give any readiness condition? */
export const hasReadinessProbe = (spec: ServiceSpec): boolean => spec.ready?.pattern !== undefined || spec.ready?.tcp !== undefined || spec.ready?.exitWithinMs !== undefined;

/**
 * Check a spec before anything starts: patterns compile on the linear-time engine
 * and match at least one character, ports are ports, durations are positive and no
 * longer than a timer can hold. Throws invalid_argument, so a bad spec never leaves
 * a Run behind.
 */
export function validateServiceSpec(spec: ServiceSpec): void {
  for (const [what, p] of [['ready.pattern', spec.ready?.pattern], ['fail.pattern', spec.fail?.pattern]] as const) {
    if (p === undefined) continue;
    if (typeof p !== 'string') throw err('invalid_argument', `${what} must be a string`);
    try {
      compileLinePattern(p);
    } catch (e) {
      throw err('invalid_argument', `${what}: ${(e as Error).message}`);
    }
  }
  for (const [what, t] of [['ready.tcp', spec.ready?.tcp], ['health.tcp', spec.health?.tcp]] as const) {
    if (t && (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535)) throw err('invalid_argument', `${what}: invalid port ${String(t.port)}`);
  }
  for (const [what, ms] of [['ready.exitWithinMs', spec.ready?.exitWithinMs], ['ready.timeoutMs', spec.ready?.timeoutMs], ['health.intervalMs', spec.health?.intervalMs]] as const) {
    if (ms !== undefined && !(Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS)) throw err('invalid_argument', `${what} must be a positive number of ms, at most ${MAX_TIMER_MS}`);
  }
}

/** One-line description of a spec, for journal events and status lines. */
export function describeSpec(spec: ServiceSpec, livenessMs = LIVENESS_MS): string {
  const parts: string[] = [];
  const r = spec.ready ?? {};
  if (r.pattern !== undefined) parts.push(`pattern /${r.pattern}/`);
  if (r.tcp) parts.push(`tcp ${r.tcp.host ?? '127.0.0.1'}:${r.tcp.port}`);
  if (r.exitWithinMs !== undefined) parts.push(`alive ${r.exitWithinMs}ms`);
  if (!parts.length) return `no readiness probe (running once alive ${livenessMs}ms)`;
  return parts.join(' + ');
}
