/**
 * The GUI's static files on their own (the house's read of 2f357bd, #22): a whitelisted
 * asset whose file is missing or unreadable is a broken install — answered 500 naming the
 * asset and reported — while a path outside the whitelist is the caller's 404.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { StaticFiles } from '../src/transport/static.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-static-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function serve(statics: StaticFiles, pathname: string, method = 'GET'): Promise<{ status: number; body: string; type: string | undefined }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!statics.serve(req, res, url.pathname, req.headers.host ?? '')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
    return { status: res.status, body: await res.text(), type: res.headers.get('content-type') ?? undefined };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('a whitelisted asset that cannot be read answers 500 naming it and is reported; a wrong URL is a plain 404 and reports nothing', async () => {
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  // No app.js in this GUI directory.
  const reported: Array<{ pathname: string; file: string | undefined; error: string }> = [];
  const statics = new StaticFiles({ guiDir: dir, onError: (pathname, file, error) => reported.push({ pathname, file, error }) });
  const page = await serve(statics, '/');
  assert.equal(page.status, 200);
  assert.equal(page.type, 'text/html; charset=utf-8');
  const script = await serve(statics, '/app.js');
  assert.equal(script.status, 500, 'a whitelisted file that is missing is the install\'s fault, not a wrong URL');
  assert.match(script.body, /^gui asset unavailable: \/app\.js \(/);
  assert.match(script.body, /ENOENT/);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.pathname, '/app.js');
  assert.equal(reported[0]!.file, path.join(dir, 'app.js'));
  assert.match(reported[0]!.error, /ENOENT/);
  const wrong = await serve(statics, '/nope.js');
  assert.equal(wrong.status, 404);
  assert.equal(reported.length, 1, 'a path outside the whitelist is not an install problem');
  // The vendored assets resolve from the installed packages whatever the GUI directory holds.
  assert.equal((await serve(statics, '/vendor/xterm.css')).status, 200);
  assert.equal((await serve(statics, '/app.js', 'HEAD')).status, 500);
  assert.equal((await serve(statics, '/', 'POST')).status, 405);
});

test('with no GUI directory at all, every page asset answers 500 and says why', async () => {
  const reported: string[] = [];
  const statics = new StaticFiles({ guiDir: path.join(dir, 'absent'), onError: (pathname) => reported.push(pathname) });
  for (const p of ['/', '/index.html', '/app.js']) {
    const r = await serve(statics, p);
    assert.equal(r.status, 500, p);
    assert.match(r.body, /gui asset unavailable/);
  }
  assert.deepEqual(reported, ['/', '/index.html', '/app.js']);
});
