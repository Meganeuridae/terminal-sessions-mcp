/**
 * The layering of §13 is enforced by a test that fails on a cross-layer import. The design
 * said so, and no such test existed: a type-only import of `api` from `core` built and ran
 * the suite unchanged (the house's read of 07ab3dd, #22). Every `import … from '../x/…'` and
 * `export … from` in `next/src` is read here, type-only ones included, and checked against
 * what each layer may depend on: `core/` imports nothing from `api/` or `transport/`.
 *
 * Two upward imports passed the first version of this spec (the house's read of 78c4d6e, #22,
 * comment 6269349975): an import of `../daemon.js` or `../index.js` from any layer, because every
 * top-level target was exempt, and `../backends/node-pty.js` from `core`, because the table gave
 * `core` the whole of `backends` where it needs `backends/types` alone. Now the top-level modules
 * sit above every layer — they wire the layers together, so nothing below may import them — and an
 * allowance can name one module instead of a layer. The checker takes the tree's root as an argument,
 * so the second test runs it over a planted tree holding exactly those imports.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `next/src`, found by walking up from wherever this spec runs (compiled under next/dist/spec, or next/spec under a TypeScript runner): `../../src` from the latter would be the 1.x tree. */
const SRC = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'next', 'src')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return path.join(dir, 'next', 'src');
})();

/**
 * What each layer may import, by top-level directory under `next/src`: a whole layer by its name, or
 * one module by its path under `next/src` without the extension. `core` is the bottom; `backends/types`
 * (the interfaces a Session drives a backend through) is the one thing it takes from `backends`, never
 * a backend itself. The top-level modules (daemon, index) are listed by nobody: they are above every layer.
 */
const ALLOWED: Record<string, string[]> = {
  core: ['core', 'backends/types'],
  backends: ['core', 'backends'],
  shell: ['core', 'shell'],
  api: ['core', 'backends', 'shell', 'api'],
  transport: ['core', 'backends', 'shell', 'api', 'transport'],
  shim: ['core', 'api', 'transport', 'shim'],
  cli: ['core', 'api', 'transport', 'cli'],
};

/** Every .ts source under `dir`, in name order (readdir's order is the filesystem's: hashed on ext4), so a report reads the same everywhere. */
function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
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

/** A path under the tree's root as a module name: forward slashes, no extension (`backends/types`). */
const moduleOf = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/').replace(/\.[cm]?[jt]s$/, '');

/** The layer a module belongs to: its first directory, or '' for the top-level modules (daemon, index). */
const layerOf = (module: string): string => (module.includes('/') ? module.split('/')[0]! : '');

/**
 * Every import in the tree under `root` that crosses layers upward, as `file imports spec (from → to)` lines,
 * with the edges that were seen (`layer->layer` and `layer->module`) so a test can prove the scan reads real imports.
 */
function check(root: string): { violations: string[]; seen: Set<string>; files: number } {
  const files = [...sources(root)];
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const from = layerOf(moduleOf(root, file));
    if (from === '') continue; // daemon.ts and index.ts wire everything together; they may import any layer
    assert.ok(from in ALLOWED, `${path.relative(root, file)}: unknown layer ${from}; add it to the table`);
    for (const spec of imports(file)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(`${root}${path.sep}`)) continue;
      const module = moduleOf(root, target);
      const to = layerOf(module);
      seen.add(`${from}->${to}`).add(`${from}->${module}`);
      const edge = `${path.relative(root, file)} imports ${spec}`;
      if (to === '') violations.push(`${edge} (${from} → the top-level module ${module}, which is above every layer)`);
      else if (!ALLOWED[from]!.includes(to) && !ALLOWED[from]!.includes(module)) violations.push(`${edge} (${from} → ${to})`);
    }
  }
  return { violations, seen, files: files.length };
}

test('§13: no layer imports a layer above it (core imports nothing from api or transport), type-only imports included', () => {
  const { violations, seen, files } = check(SRC);
  assert.ok(files > 20, `the source tree was found (${files} files)`);
  assert.deepEqual(violations, [], violations.join('\n'));
  // The scan sees real imports: a few that are known to exist, the module-level one among them.
  for (const edge of ['api->core', 'transport->api', 'backends->core', 'core->backends/types']) assert.ok(seen.has(edge), `${edge} was not seen; the import regex missed something`);
});

/** A tree planted with the imports the house found passing (and two that must pass): the checker refuses exactly the upward ones. */
const PLANTED = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-layering-'));
after(() => fs.rmSync(PLANTED, { recursive: true, force: true }));

test('§13: the checker refuses an import of a top-level module from any layer, and of a backend (not its types) from core', () => {
  const root = PLANTED;
  const plant = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  plant('daemon.ts', `import { App } from './api/app.js';\nexport const d = App;\n`);
  plant('index.ts', `export * from './core/types.js';\n`);
  plant('core/types.ts', `export type Seq = number;\n`);
  plant('backends/types.ts', `export interface PtyHandle { pid: number }\n`);
  plant('backends/node-pty.ts', `import type { Seq } from '../core/types.js';\nexport const n: Seq = 1;\n`);
  plant('api/app.ts', `import type { Seq } from '../core/types.js';\nimport { d } from '../daemon.js';\nexport const App = { d } as { d: unknown; s?: Seq };\n`);
  plant('core/session.ts', [
    `import type { PtyHandle } from '../backends/types.js';`, // allowed: the one module core takes from backends
    `import type { Seq } from './types.js';`, // allowed: its own layer
    `import { n } from '../backends/node-pty.js';`, // refused: a backend, not its types
    `import type { App } from '../api/app.js';`, // refused: a layer above
    `import { d } from '../daemon.js';`, // refused: a top-level module
    `export * from '../index.js';`, // refused: a top-level module, by re-export
    `export const s = { n, d } as { n: Seq; d: unknown; h?: PtyHandle; a?: App };`,
    '',
  ].join('\n'));
  const { violations, seen } = check(root);
  assert.deepEqual(violations.map((v) => v.slice(0, v.indexOf(' ('))), [
    'api/app.ts imports ../daemon.js',
    'core/session.ts imports ../backends/node-pty.js',
    'core/session.ts imports ../api/app.js',
    'core/session.ts imports ../daemon.js',
    'core/session.ts imports ../index.js',
  ]);
  assert.match(violations[0]!, /top-level module daemon, which is above every layer/);
  assert.match(violations[1]!, /core → backends\)/);
  assert.ok(seen.has('core->backends/types') && seen.has('core->core'), 'the allowed imports were read, not skipped');
});
