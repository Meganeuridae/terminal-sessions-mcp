// Every published bin starts with a node shebang. npm links each bin as a
// command, and a shebang naming a dev-only tool breaks the installed command,
// as session-cli's `#!/usr/bin/env ts-node` did. Runs against the compiled
// output: `npm test` (builds first, then node --test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const { bin } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test("every bin's first line names node", () => {
  const names = Object.keys(bin);
  assert.ok(names.length > 0, 'package.json names its bins');
  for (const name of names) {
    const first = readFileSync(join(root, bin[name]), 'utf8').split('\n', 1)[0];
    assert.equal(first, '#!/usr/bin/env node', `${name} (${bin[name]})`);
  }
});
