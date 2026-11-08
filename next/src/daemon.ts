#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { configuredEnv } from './core/env.js';
import { runDaemon } from './endpoint/daemon-main.js';
import { endpointPaths } from './endpoint/socket.js';
import { packageVersion } from './endpoint/version.js';
import { openSession } from './session/session.js';

const USAGE = 'usage: termd [--socket PATH] [--session-oom-score-adj N]\n  --session-oom-score-adj N  raises each shell\'s oom_score_adj on Linux, so the kernel takes a build before the daemon (default 200; 0 leaves it alone)\nOne daemon per user holds every shell, on a Unix socket only the user can open. Hosts reach it through tsm-relay, people through tsm.';

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} termd[${process.pid}] ${line}\n`);
}

export async function main(argv: readonly string[]): Promise<number> {
  let socket = endpointPaths().socket;
  let oomScoreAdj = 200;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1] !== undefined) socket = argv[++i]!;
    else if (argv[i] === '--session-oom-score-adj' && /^\d+$/.test(argv[i + 1] ?? '') && Number(argv[i + 1]) <= 1000) oomScoreAdj = Number(argv[++i]);
    else if (argv[i] === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }
  // os.userInfo() throws for a uid with no passwd entry, such as a container's arbitrary uid.
  let entry: string | null | undefined;
  try {
    entry = os.userInfo().shell;
  } catch {
    entry = undefined;
  }
  const shell = entry || process.env.SHELL || '/bin/sh';
  let d;
  try {
    d = await runDaemon({ socket, openSession, shell, env: configuredEnv(process.env, {}), version: packageVersion(), log, oomScoreAdj });
  } catch (e) {
    log(`can't start: ${(e as Error).message}`);
    return 1;
  }
  if (d === 'running') {
    log(`a daemon already answers at ${socket}; this one exits`);
    return 0;
  }
  const running = d;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void running.stop(`${sig} received`));
  process.on('SIGHUP', () => log('SIGHUP ignored: the daemon outlives the terminal that started it'));
  process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e.message}`));
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  await running.stopped;
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    if (code === 0) process.exit(0);
  });
}
