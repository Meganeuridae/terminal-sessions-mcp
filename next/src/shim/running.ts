/**
 * A supervisor's termd that runs, asked what it uses. A systemd unit's text is what the unit will run
 * next, not what its termd was started with: after an edit and a daemon-reload without a restart, the
 * text names another port or data dir than the termd it shows running, and the shim compared against the
 * edited one (the house's review of 4f4c067..a8b6f28, #22 comment 6323055715, question 1). termd retitles
 * itself (`termd --port N`, tsg-20), so its start arguments no longer show, but the title gives the port
 * it listens on, and that port's /health gives its data dir to a loopback caller that may see sessions.
 * Asked without a credential, so a termd that requires one answers without it, and the shim then reads
 * the unit's text instead.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';

/** The port a running termd's title names, as Linux shows the title in /proc/<pid>/cmdline (else `ps`); or why there is none. */
export function titlePort(pid: number): number | { error: string } {
  let title: string | undefined;
  try {
    title = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    try {
      title = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return { error: 'its title cannot be read' };
    }
  }
  const m = /^termd --port (\d+)$/.exec(title.trim());
  const port = m ? Number(m[1]) : NaN;
  return port > 0 && port <= 65535 ? port : { error: `its title is not a termd's with a port: ${JSON.stringify(title.slice(0, 80))}` };
}

/**
 * What the termd on `port` says its data dir is, over /health, and only when the one answering is `pid`:
 * another process may listen there. Tried on 127.0.0.1, then ::1; at most `timeoutMs` each.
 */
export async function askDataDir(port: number, pid: number, timeoutMs: number): Promise<{ dataDir: string } | { error: string }> {
  let last = 'it did not answer';
  for (const host of ['127.0.0.1', '::1']) {
    const r = await health(host, port, timeoutMs);
    if ('error' in r) {
      last = r.error;
      if (r.refused) continue;
      return r;
    }
    if (r.body.pid !== pid) return { error: `port ${port} is served by pid ${String(r.body.pid)}, not by it` };
    if (typeof r.body.dataDir !== 'string') return { error: 'its /health names no data dir: a termd that requires a credential tells it only to one, and one older than this shim never' };
    return { dataDir: r.body.dataDir };
  }
  return { error: last };
}

function health(host: string, port: number, timeoutMs: number): Promise<{ body: Record<string, unknown> } | { error: string; refused?: boolean }> {
  return new Promise((resolve) => {
    const hostHeader = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    // A connection of its own: a pooled one the termd has since closed answers ECONNRESET, not the termd's state.
    const req = http.get({ host, port, path: '/health', headers: { host: hostHeader }, timeout: timeoutMs, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        text += c;
        if (text.length > 1 << 20) req.destroy(new Error('its /health answer is over 1 MiB'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `its /health answered ${res.statusCode}` });
        try {
          const body: unknown = JSON.parse(text);
          resolve(typeof body === 'object' && body !== null ? { body: body as Record<string, unknown> } : { error: 'its /health answer is not an object' });
        } catch {
          resolve({ error: 'its /health answer is not JSON' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`it did not answer /health within ${timeoutMs} ms`)));
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code === 'ECONNREFUSED' ? `nothing listens on port ${port}` : e.message, refused: e.code === 'ECONNREFUSED' || e.code === 'EADDRNOTAVAIL' }));
  });
}
