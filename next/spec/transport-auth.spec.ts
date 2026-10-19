/**
 * Credentials and argument validation at the boundary: token resolution,
 * tokens-file hygiene, principals a credential may name, the GUI principal, and
 * the schema validator's handling of prototype-named keys and typed maps (api-21).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { guiActsFor, guiPrincipal, isValidPrincipal, readTokensFile, TokenMapResolver } from '../src/api/principals.js';
import { validate, ValidationError, type Schema } from '../src/api/validate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-auth-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tokens resolve to their principal; with tokens configured an unknown or missing token is refused', () => {
  const r = new TokenMapResolver({ tokens: { alpha: 'agent:a@x', beta: 'human:gh:7' }, sharedToken: 'shared' });
  assert.equal(r.resolve('alpha'), 'agent:a@x');
  assert.equal(r.resolve('beta'), 'human:gh:7');
  assert.equal(r.resolve('shared'), 'token:default');
  assert.equal(r.resolve('alph'), undefined);
  assert.equal(r.resolve('alphaa'), undefined);
  assert.equal(r.resolve(undefined), undefined);
  assert.equal(r.resolve(''), undefined);
  assert.equal(r.open, false);
  const open = new TokenMapResolver({ anonymous: 'token:local-x' });
  assert.equal(open.open, true);
  assert.equal(open.resolve(undefined), 'token:local-x');
  assert.equal(open.resolve('anything'), 'token:local-x', 'no token map: every connection is the anonymous principal');
  const both = new TokenMapResolver({ tokens: { t: 'agent:t@x' }, anonymous: 'token:guest' });
  assert.equal(both.resolve(undefined), 'token:guest');
  assert.equal(both.resolve('wrong'), undefined, 'a wrong token is refused even when anonymous access exists');
});

test('a credential can never name the system principal or a malformed one', () => {
  assert.throws(() => new TokenMapResolver({ tokens: { t: 'system' } }), /never "system"/);
  assert.throws(() => new TokenMapResolver({ anonymous: 'system' }), /never "system"/);
  assert.throws(() => new TokenMapResolver({ tokens: { t: 'alice' } }), /not a principal/);
  assert.throws(() => new TokenMapResolver({ tokens: { t: 'agent:has space' } }), /not a principal/);
  assert.throws(() => new TokenMapResolver({ tokens: { t: 'agent:a\nforged' } }), /not a principal/);
  for (const ok of ['agent:a@test', 'human:test:9', 'token:default', 'host:claude-code', 'token:local-aster']) assert.ok(isValidPrincipal(ok), ok);
});

test('the GUI principal is the human at the keyboard of whoever the token names, one-to-one', () => {
  assert.equal(guiPrincipal('agent:alice@corp'), 'human:gui:agent:alice@corp');
  assert.equal(guiPrincipal('token:local-aster'), 'human:gui:token:local-aster');
  assert.notEqual(guiPrincipal('agent:alice'), guiPrincipal('token:alice'), 'different tokens never share a GUI human');
  assert.equal(guiPrincipal('human:github:42'), 'human:github:42');
  assert.ok(isValidPrincipal(guiPrincipal('agent:alice@corp')));
  assert.equal(guiActsFor('human:gui:agent:alice@corp', 'agent:alice@corp'), true);
  assert.equal(guiActsFor('human:gui:token:alice', 'agent:alice'), false);
  assert.equal(guiActsFor('human:github:42', 'human:github:42'), false);
  assert.equal(guiActsFor('agent:alice@corp', 'agent:alice@corp'), false);
});

test('a tokens file readable by group or others is refused, naming chmod 600; its tokens never appear in errors', () => {
  const f = path.join(tmp, 'tokens.json');
  fs.writeFileSync(f, JSON.stringify({ 'sekrit-token-1': 'agent:a@x', 'sekrit-token-2': 'human:gh:1' }));
  fs.chmodSync(f, 0o644);
  assert.throws(() => readTokensFile(f), (e: Error) => /chmod 600/.test(e.message) && /644/.test(e.message) && !e.message.includes('sekrit'));
  fs.chmodSync(f, 0o640);
  assert.throws(() => readTokensFile(f), /chmod 600/);
  fs.chmodSync(f, 0o600);
  assert.deepEqual(readTokensFile(f), { 'sekrit-token-1': 'agent:a@x', 'sekrit-token-2': 'human:gh:1' });
  const bad = path.join(tmp, 'bad.json');
  for (const [body, re] of [
    ['[1,2]', /JSON object/],
    ['{"t": 5}', /not a principal/],
    ['{"t": "system"}', /never "system"/],
    ['{"": "agent:a@x"}', /empty or reserved/],
    ['{nope', /not valid JSON/],
  ] as const) {
    fs.writeFileSync(bad, body);
    fs.chmodSync(bad, 0o600);
    assert.throws(() => readTokensFile(bad), (e: Error) => re.test(e.message) && !e.message.includes('"t"'), body);
  }
  assert.throws(() => readTokensFile(path.join(tmp, 'missing.json')), /ENOENT/);
});

const OPEN_SCHEMA: Schema = {
  type: 'object',
  properties: {
    session: { type: 'string' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['session'],
  additionalProperties: false,
};

test('api-21: prototype-named keys are refused everywhere, even where extra keys are allowed', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const args = JSON.parse(`{"session":"s","${key}":{"x":1}}`) as Record<string, unknown>;
    assert.throws(() => validate(args, OPEN_SCHEMA), (e: unknown) => e instanceof ValidationError && e.path === `.${key}`, key);
    const nested = JSON.parse(`{"session":"s","env":{"${key}":"v"}}`) as Record<string, unknown>;
    assert.throws(() => validate(nested, OPEN_SCHEMA), ValidationError, `nested ${key}`);
    assert.throws(() => validate(JSON.parse(`{"${key}":1}`), { type: 'object' }), ValidationError, `open object ${key}`);
  }
  // Inherited names are not declared parameters.
  for (const key of ['toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => validate({ session: 's', [key]: 1 }, OPEN_SCHEMA), /is not a known parameter/, key);
  }
  // `required` means an own property.
  assert.throws(() => validate({}, { type: 'object', required: ['toString'] }), /is required/);
});

test('api-21: additionalProperties may be a schema, so env values are typed as strings', () => {
  validate({ session: 's', env: { PATH: '/bin', EMPTY: '' } }, OPEN_SCHEMA);
  for (const env of [{ PATH: null }, { N: 5 }, { O: { a: 1 } }, { L: ['x'] }, { B: true }]) {
    assert.throws(() => validate({ session: 's', env }, OPEN_SCHEMA), (e: unknown) => e instanceof ValidationError && /must be a string/.test(e.message), JSON.stringify(env));
  }
  validate({ session: 's', extra: 1 }, { type: 'object', properties: { session: { type: 'string' } } });
  validate({ a: 'x' }, { type: 'object', additionalProperties: true });
});

test('a tokens file the daemon cannot read is a read failure, not bad JSON', { skip: process.getuid?.() === 0 }, () => {
  const f = path.join(tmp, 'unreadable.json');
  fs.writeFileSync(f, '{}');
  fs.chmodSync(f, 0o000);
  try {
    assert.throws(() => readTokensFile(f), (e: Error) => /cannot read tokens file/.test(e.message) && /EACCES/.test(e.message) && !/valid JSON/.test(e.message));
  } finally {
    fs.chmodSync(f, 0o600);
  }
});

test('a credential cannot name a human:gui: principal: that form is derived from the token’s own', () => {
  assert.throws(() => new TokenMapResolver({ tokens: { t: 'human:gui:agent:alice@corp' } }), /derived from the token/);
  assert.throws(() => new TokenMapResolver({ anonymous: 'human:gui:token:default' }), /derived from the token/);
  const f = path.join(tmp, 'gui.json');
  fs.writeFileSync(f, JSON.stringify({ 'sekrit-token-3': 'human:gui:agent:alice@corp' }));
  fs.chmodSync(f, 0o600);
  assert.throws(() => readTokensFile(f), (e: Error) => /derived from the token/.test(e.message) && !e.message.includes('sekrit'));
  assert.ok(isValidPrincipal(guiPrincipal('agent:alice@corp')), 'the derived form itself stays a valid principal');
});
