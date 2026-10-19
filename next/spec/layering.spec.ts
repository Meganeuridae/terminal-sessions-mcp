/**
 * The layering of §13 is enforced by a test that fails on a cross-layer import. The design
 * said so, and no such test existed: a type-only import of `api` from `core` built and ran
 * the suite unchanged (the house's read of 07ab3dd, #22). Every `import … from '../x/…'` and
 * `export … from` in `next/src` is read here, type-only ones included, and checked against
 * what each layer may depend on: `core/` imports nothing from `api/` or `transport/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** What each layer may import, by top-level directory under `next/src` (`core` is the bottom; `backends/types` are the one thing it needs). */
const ALLOWED: Record<string, string[]> = {
  core: ['core', 'backends'],
  backends: ['core', 'backends'],
  shell: ['core', 'shell'],
  api: ['core', 'backends', 'shell', 'api'],
  transport: ['core', 'backends', 'shell', 'api', 'transport'],
  shim: ['core', 'api', 'transport', 'shim'],
  cli: ['core', 'api', 'transport', 'cli'],
};

function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) yield p;
  }
}

/** Relative module specifiers a file imports or re-exports, static and dynamic, type-only included. */
function imports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

/** The layer a path under `next/src` belongs to: its first directory, or '' for the top-level files (daemon, index). */
const layerOf = (file: string): string => {
  const rel = path.relative(SRC, file);
  return rel.includes(path.sep) ? rel.split(path.sep)[0]! : '';
};

test('§13: no layer imports a layer above it (core imports nothing from api or transport), type-only imports included', () => {
  const files = [...sources(SRC)];
  assert.ok(files.length > 20, `the source tree was found (${files.length} files)`);
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const from = layerOf(file);
    if (from === '') continue; // daemon.ts and index.ts wire everything together
    assert.ok(from in ALLOWED, `${path.relative(SRC, file)}: unknown layer ${from}; add it to the table`);
    for (const spec of imports(file)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(SRC)) continue;
      const to = layerOf(target);
      seen.add(`${from}->${to}`);
      if (to !== '' && !ALLOWED[from]!.includes(to)) violations.push(`${path.relative(SRC, file)} imports ${spec} (${from} → ${to})`);
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
  // The scan sees real imports: a few that are known to exist.
  for (const edge of ['api->core', 'transport->api', 'backends->core']) assert.ok(seen.has(edge), `${edge} was not seen; the import regex missed something`);
});
