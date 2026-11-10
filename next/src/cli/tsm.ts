#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCli, runCli, USAGE } from '../endpoint/cli-main.js';
import { endpointPaths, ensurePrivateDir } from '../endpoint/socket.js';
import { packageVersion } from '../endpoint/version.js';
import { startDaemon } from '../relay.js';

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const parsed = parseCli(argv);
  if ('help' in parsed) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if ('error' in parsed) {
    process.stderr.write(`tsm: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const paths = parsed.socket ? { dir: path.dirname(parsed.socket), socket: parsed.socket } : endpointPaths();
  try {
    ensurePrivateDir(paths.dir);
  } catch (e) {
    process.stderr.write(`tsm: ${(e as Error).message}\n`);
    return 1;
  }
  const daemonScript = fileURLToPath(new URL('../daemon.js', import.meta.url));
  return runCli({
    ...parsed,
    socket: paths.socket,
    version: packageVersion(),
    startDaemon: (budgetMs) => startDaemon(daemonScript, paths.socket, path.join(paths.dir, 'daemon.log'), budgetMs, (line) => process.stderr.write(`tsm: ${line}\n`)),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
