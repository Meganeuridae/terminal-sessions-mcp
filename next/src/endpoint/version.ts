import * as fs from 'node:fs';

export function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}
