// Tests for the Host/Origin check that both ports (session API, web GUI) run
// before the token. Runs against the compiled output: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestGuard, tokenMatches, requestUrl, splitList } = require('../dist/src/server/request-guard');

// Silence the refusal log lines while testing.
const quiet = (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};
const req = (headers) => ({ headers, method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' } });
const verdict = (guard, headers) => quiet(() => guard.check(req(headers)));
const status = (guard, headers) => { const v = verdict(guard, headers); return v.ok ? 'ok' : v.status; };

test('no token, loopback bind: local non-browser clients are served on loopback names, any port', () => {
  const g = new RequestGuard('localhost', 3100, false);
  assert.equal(status(g, { host: 'localhost:3100' }), 'ok');
  assert.equal(status(g, { host: '127.0.0.1:3100' }), 'ok');
  assert.equal(status(g, { host: '[::1]:3100' }), 'ok');
  assert.equal(status(g, { host: 'LOCALHOST' }), 'ok');
  assert.equal(status(g, { host: 'localhost:13100' }), 'ok'); // ssh -L port forward
});

test('no token: a page on another origin is refused (403)', () => {
  const g = new RequestGuard('127.0.0.1', 3100, false);
  assert.equal(status(g, { host: 'localhost:3100', origin: 'https://other.example' }), 403);
  assert.equal(status(g, { host: 'localhost:3100', origin: 'http://localhost:5173' }), 403); // another local page
  assert.equal(status(g, { host: 'localhost:3100', origin: 'null' }), 403); // sandboxed iframe / file://
  assert.equal(status(g, { host: 'localhost:3100', origin: 'chrome-extension://abc' }), 403);
});

test('no token: an unlisted Host is refused (421), even with a matching Origin', () => {
  const g = new RequestGuard('127.0.0.1', 3100, false);
  assert.equal(status(g, { host: 'other.example:3100', origin: 'http://other.example:3100' }), 421);
  assert.equal(status(g, { host: 'other.example:3100' }), 421);
  assert.equal(status(g, {}), 421); // no Host at all
  assert.equal(status(g, { host: 'a b' }), 421); // malformed
});

test('same-origin page (our GUI) is served', () => {
  const g = new RequestGuard('localhost', 3200, false);
  assert.equal(status(g, { host: 'localhost:3200', origin: 'http://localhost:3200' }), 'ok');
  assert.equal(status(g, { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200' }), 'ok');
  // same name, different port is another origin
  assert.equal(status(g, { host: 'localhost:3200', origin: 'http://localhost:3201' }), 403);
});

test('no token, wildcard bind: only loopback names unless --allow-host', () => {
  const g = new RequestGuard('0.0.0.0', 3100, false);
  assert.equal(status(g, { host: 'localhost:3100' }), 'ok');
  assert.equal(status(g, { host: 'localhost:13100' }), 421); // not a loopback bind: our port only
  assert.equal(status(g, { host: '100.64.0.10:3100' }), 421);
  const h = new RequestGuard('0.0.0.0', 3100, false, { allowHosts: ['100.64.0.10', 'box.example:8080'] });
  assert.equal(status(h, { host: '100.64.0.10:3100' }), 'ok');
  assert.equal(status(h, { host: '100.64.0.10' }), 'ok');
  assert.equal(status(h, { host: '100.64.0.10:9999' }), 421);
  assert.equal(status(h, { host: 'box.example:8080' }), 'ok');
  assert.equal(status(h, { host: 'box.example:3100' }), 421);
});

test('no token, specific bind: the bind address is served', () => {
  const g = new RequestGuard('100.64.0.10', 3100, false);
  assert.equal(status(g, { host: '100.64.0.10:3100' }), 'ok');
  const v6 = new RequestGuard('fd00::10', 3100, false);
  assert.equal(status(v6, { host: '[fd00::10]:3100' }), 'ok');
});

test('token mode: Host is not checked (the token gates), Origin still is', () => {
  const g = new RequestGuard('0.0.0.0', 3100, true);
  assert.equal(status(g, { host: '100.64.0.10:3100' }), 'ok');
  assert.equal(status(g, { host: 'any.name:3100', origin: 'http://any.name:3100' }), 'ok'); // then 4001 without the token
  assert.equal(status(g, { host: 'localhost:3100', origin: 'https://other.example' }), 403);
});

test('--allow-origin admits a listed page and nothing else', () => {
  const g = new RequestGuard('localhost', 3100, false, { allowOrigins: ['https://dash.example/', 'not a url'] });
  assert.equal(status(g, { host: 'localhost:3100', origin: 'https://dash.example' }), 'ok');
  assert.equal(status(g, { host: 'localhost:3100', origin: 'http://dash.example' }), 403);
  assert.equal(status(g, { host: 'localhost:3100', origin: 'https://dash.example.other.example' }), 403);
});

test('port given as a function (resolved once bound)', () => {
  let bound = 0;
  const g = new RequestGuard('0.0.0.0', () => bound, false);
  bound = 4567;
  assert.equal(status(g, { host: 'localhost:4567' }), 'ok');
  assert.equal(status(g, { host: 'localhost:4568' }), 421);
});

test('tokenMatches: exact, constant-time, rejects non-strings', () => {
  assert.equal(tokenMatches('s3cret', 's3cret'), true);
  assert.equal(tokenMatches('s3cre', 's3cret'), false);
  assert.equal(tokenMatches('s3cretx', 's3cret'), false);
  assert.equal(tokenMatches(undefined, 's3cret'), false);
  assert.equal(tokenMatches(null, 's3cret'), false);
  assert.equal(tokenMatches(['s3cret'], 's3cret'), false); // ?token=a&token=b
});

test('requestUrl never uses the Host header as a base', () => {
  assert.equal(requestUrl('/?token=abc').searchParams.get('token'), 'abc');
  assert.equal(requestUrl(undefined).pathname, '/');
});

test('splitList: comma-separated and repeated values', () => {
  assert.deepEqual(splitList(['a,b', undefined, ' c ', '']), ['a', 'b', 'c']);
});
