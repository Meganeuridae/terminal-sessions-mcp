/**
 * Principals from transport credentials (§4.5). Today: a token map. Tomorrow:
 * `aid1` tokens verified offline against the issuer key, same interface.
 *
 * Tokens are compared in constant time (a digest of every configured token is
 * compared against the presented one's, with no early exit), are never logged,
 * and a tokens file must not be readable by group or others.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import type { Principal } from '../core/types.js';
import { SYSTEM } from '../core/types.js';

export interface PrincipalResolver {
  /** Resolve a presented token to a principal, or undefined to refuse. */
  resolve(token: string | undefined): Principal | undefined;
  /** True when no credential is required (loopback development). */
  readonly open: boolean;
}

export interface TokenMapOptions {
  /** token → principal id. */
  tokens?: Record<string, Principal>;
  /** A single shared token; its principal is `token:default`. */
  sharedToken?: string;
  /** Accept unauthenticated connections as this principal (development only). */
  anonymous?: Principal;
}

/**
 * What a credential may resolve to (§4): `agent:`, `human:`, `token:` or `host:`
 * followed by a printable name. Never `system`: that principal bypasses every
 * verb check (G18) and belongs to the daemon alone.
 */
const PRINCIPAL = /^(agent|human|token|host):[\x21-\x7e]{1,200}$/;

export function isValidPrincipal(p: unknown): p is Principal {
  return typeof p === 'string' && p !== SYSTEM && PRINCIPAL.test(p);
}

export function assertPrincipal(p: unknown, what: string): asserts p is Principal {
  if (!isValidPrincipal(p)) {
    throw new Error(`${what}: ${JSON.stringify(p)} is not a principal; use agent:<name>@<domain>, human:<provider>:<id>, token:<name> or host:<name> (never "system")`);
  }
  // `human:gui:…` is derived by the daemon from a token's own principal (guiPrincipal), never issued: a
  // credential naming one would be the GUI human of the agent it names, and pass guiActsFor for that
  // agent's sessions (the house's read of 1cabc6a, #22).
  if (p.startsWith('human:gui:')) throw new Error(`${what}: ${JSON.stringify(p)} is the GUI's own form of a principal, derived from the token's; give the token the agent's or human's principal instead`);
}

const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export class TokenMapResolver implements PrincipalResolver {
  /** sha256(token) hex → { digest, principal }; the hex key only dedupes (last mapping wins). */
  private readonly entries = new Map<string, { digest: Buffer; principal: Principal }>();
  private readonly anonymous: Principal | undefined;

  constructor(opts: TokenMapOptions) {
    const add = (token: string, principal: Principal, what: string) => {
      if (typeof token !== 'string' || token === '') throw new Error(`${what}: empty token`);
      assertPrincipal(principal, what);
      const d = digest(token);
      this.entries.set(d.toString('hex'), { digest: d, principal });
    };
    for (const [t, p] of Object.entries(opts.tokens ?? {})) add(t, p, 'tokens');
    if (opts.sharedToken) add(opts.sharedToken, 'token:default', 'shared token');
    if (opts.anonymous !== undefined) assertPrincipal(opts.anonymous, 'anonymous principal');
    this.anonymous = opts.anonymous;
  }

  get open(): boolean {
    return this.anonymous !== undefined && this.entries.size === 0;
  }

  resolve(token: string | undefined): Principal | undefined {
    if (token !== undefined && token !== '') {
      const d = digest(token);
      let found: Principal | undefined;
      // Constant time in the presented token: every entry is compared, no early exit.
      for (const e of this.entries.values()) {
        if (timingSafeEqual(e.digest, d) && found === undefined) found = e.principal;
      }
      if (found) return found;
      if (this.entries.size > 0) return undefined;
    }
    return this.anonymous;
  }
}

/**
 * The principal of a browser on the daemon's own origin (the GUI): the human at
 * the keyboard of whoever the token names. The whole token principal is the id,
 * so distinct tokens get distinct GUI humans (`agent:alice` and `token:alice`
 * stay apart): `agent:alice@corp` → `human:gui:agent:alice@corp`,
 * `token:local-aster` → `human:gui:token:local-aster`. A `human:` principal is
 * kept as it is — which is why no credential may name a `human:gui:` principal
 * (assertPrincipal): mapped as it is, it would be the GUI human of the agent it
 * names, and the two forms would meet in one id.
 */
export function guiPrincipal(p: Principal): Principal {
  return p.startsWith('human:') ? p : `human:gui:${p}`;
}

/**
 * True when `gui` is the GUI human of `owner` — the person holding `owner`'s
 * token in a browser. For verb checks (G18) that want the GUI to see and act on
 * its own token's sessions; nothing in the transport grants it by itself.
 */
export function guiActsFor(gui: Principal, owner: Principal): boolean {
  return gui !== owner && gui.startsWith('human:gui:') && guiPrincipal(owner) === gui;
}

/**
 * Read a `{ "<token>": "<principal>" }` file. Refuses a file that group or
 * others can read (the tokens are credentials), a file that is not a JSON
 * object of strings, and any mapping to an invalid principal. Messages never
 * include a token.
 */
export function readTokensFile(file: string): Record<string, Principal> {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    throw new Error(`cannot read tokens file ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  if (!st.isFile()) throw new Error(`tokens file ${file} is not a regular file`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`tokens file ${file} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
  }
  // A file stat sees but the daemon cannot read (mode 000: EACCES) is a read failure, not bad JSON (the house's read of 1cabc6a, #22).
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read tokens file ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`tokens file ${file} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`tokens file ${file} must be a JSON object { "<token>": "<principal>" }`);
  const out: Record<string, Principal> = {};
  let n = 0;
  for (const [token, principal] of Object.entries(parsed as Record<string, unknown>)) {
    n++;
    if (token === '' || token === '__proto__') throw new Error(`tokens file ${file}: entry ${n} has an empty or reserved token`);
    assertPrincipal(principal, `tokens file ${file}, entry ${n}`);
    out[token] = principal;
  }
  return out;
}
