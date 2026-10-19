/**
 * Static hosting of the GUI (§12): a fixed whitelist of paths — the page, its
 * script, and the xterm.js assets resolved from the installed packages — with
 * exact content types, `nosniff`, and a Content-Security-Policy that allows
 * only the daemon's own origin plus its own WebSocket. No path from a request
 * ever reaches the filesystem: a request either names a whitelisted asset or
 * gets 404.
 */
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface StaticAsset {
  /** Absolute path on disk, or undefined when it could not be resolved (served as 404). */
  file: string | undefined;
  type: string;
}

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';

/** The GUI directory: `next/gui`, from both `src/transport` and `dist/src/transport`. */
function defaultGuiDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../gui', '../../../gui']) {
    const dir = path.resolve(here, rel);
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

/** A file of an installed package (the xterm versions are pinned; none has an exports map hiding these). */
function packageFile(spec: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(spec);
  } catch {
    return undefined;
  }
}

/** The whitelist: request path → asset. */
function guiAssets(guiDir = defaultGuiDir()): Map<string, StaticAsset> {
  const gui = (name: string): string | undefined => (guiDir ? path.join(guiDir, name) : undefined);
  const index: StaticAsset = { file: gui('index.html'), type: HTML };
  return new Map<string, StaticAsset>([
    ['/', index],
    ['/index.html', index],
    ['/app.js', { file: gui('app.js'), type: JS }],
    ['/vendor/xterm.js', { file: packageFile('@xterm/xterm/lib/xterm.js'), type: JS }],
    ['/vendor/xterm.css', { file: packageFile('@xterm/xterm/css/xterm.css'), type: CSS }],
    ['/vendor/addon-fit.js', { file: packageFile('@xterm/addon-fit/lib/addon-fit.js'), type: JS }],
  ]);
}

/**
 * The page's policy: scripts, styles and fonts only from this origin (inline
 * styles are needed by xterm's DOM renderer), connections only to this origin
 * and its WebSocket, never framed (a framed terminal is a clickjacking target).
 * `host` is the request's Host header, already checked against the allowlist.
 */
function contentSecurityPolicy(host: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ws://${host} wss://${host}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export class StaticFiles {
  private readonly assets = guiAssets();

  /**
   * Answer a request for a whitelisted asset (200, 404 when its file is missing, 405 for a
   * method other than GET or HEAD); false when `pathname` is not one. The caller has checked
   * Host and Origin. Files are read on every request: edits to the GUI show up at once.
   */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string, host: string): boolean {
    const asset = this.assets.get(pathname);
    if (!asset) return false;
    const headers: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    };
    const text = (status: number, body: string, extra: Record<string, string> = {}): true => {
      res.writeHead(status, { ...headers, ...extra, 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return true;
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed', { allow: 'GET, HEAD' });
    let body: Buffer;
    try {
      body = fs.readFileSync(asset.file ?? '');
    } catch {
      return text(404, 'not found');
    }
    headers['content-type'] = asset.type;
    headers['content-length'] = String(body.length);
    if (asset.type === HTML) {
      // The page URL may carry the token: never cache it, never send it as a referrer, never frame it.
      headers['content-security-policy'] = contentSecurityPolicy(host);
      headers['x-frame-options'] = 'DENY';
      headers['cross-origin-opener-policy'] = 'same-origin';
      headers['cache-control'] = 'no-store';
    } else headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}
