/**
 * The JSON-RPC layer on its own (the house's read of 2f357bd, #22): what each frame shape
 * classifies as — in particular that no response-shaped frame is ever answered, whatever
 * is wrong with it — and that an outbound request settles on its response, its timeout, or
 * the connection's close.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, INTERNAL, INVALID_PARAMS, INVALID_REQUEST, Outbound, RpcError, type Message } from '../src/transport/jsonrpc.js';

test('classify: requests with a bad id are answered with id null; responses with a bad or missing id are dropped, never answered', () => {
  const answered = (v: unknown) => {
    const f = classify(v);
    return f.kind === 'invalid' ? f.id : `not invalid: ${f.kind}`;
  };
  // Requests: answered, as the spec says, with id null when the id is unusable.
  assert.equal(answered({ jsonrpc: '2.0', id: {}, method: 'ping' }), null);
  assert.equal(answered({ jsonrpc: '2.0', id: true, method: 'ping' }), null);
  assert.equal(answered({ jsonrpc: '2.0', id: 7, method: 5 }), 7);
  assert.equal(answered({ jsonrpc: '2.0', id: 8, method: 'ping', params: 'x' }), 8);
  assert.equal(answered({ jsonrpc: '2.0', id: [1] }), null, 'neither request nor response, with a bad id');
  assert.equal(answered({ jsonrpc: '2.0', id: 16 }), 16);
  assert.equal(answered(null), null);
  assert.equal(answered([]), null);
  // Responses: whatever is wrong with them, nothing is sent back.
  for (const r of [
    { jsonrpc: '2.0', id: true, result: 1 },
    { jsonrpc: '2.0', id: {}, error: { code: 1, message: 'x' } },
    { jsonrpc: '2.0', id: 1.5e400, result: 1 },
    { jsonrpc: '2.0', result: {} },
    { jsonrpc: '2.0', id: null, error: { code: 1, message: 'x' } },
    { jsonrpc: '2.0', id: 99, error: 'boom' },
    { jsonrpc: '2.0', id: 99, error: { code: 'x', message: 'y' } },
  ]) {
    const f = classify(r);
    assert.equal(f.kind, 'invalid', JSON.stringify(r));
    assert.equal(f.kind === 'invalid' && f.id, undefined, `${JSON.stringify(r)} is dropped, not answered`);
  }
  // Well-formed frames.
  assert.deepEqual(classify({ jsonrpc: '2.0', id: 'a', method: 'ping' }), { kind: 'request', msg: { jsonrpc: '2.0', id: 'a', method: 'ping' } });
  assert.deepEqual(classify({ jsonrpc: '2.0', method: 'n', params: { x: 1 } }), { kind: 'request', msg: { jsonrpc: '2.0', method: 'n', params: { x: 1 } } });
  assert.deepEqual(classify({ jsonrpc: '2.0', id: 3, result: { ok: true } }), { kind: 'response', msg: { jsonrpc: '2.0', id: 3, result: { ok: true } } });
  assert.deepEqual(classify({ jsonrpc: '2.0', id: 3, error: { code: -1, message: 'm', data: [1] } }), { kind: 'response', msg: { jsonrpc: '2.0', id: 3, error: { code: -1, message: 'm', data: [1] } } });
  const codes = (v: unknown) => (classify(v) as { code: number }).code;
  assert.equal(codes({ jsonrpc: '2.0', id: 1, method: 'm', params: [1] }), INVALID_PARAMS);
  assert.equal(codes({ jsonrpc: '2.0', id: 1, method: '' }), INVALID_REQUEST);
});

test('Outbound: a request settles on its response, is rejected when no response comes in time, and is rejected when the connection closes', async () => {
  const sent: Message[] = [];
  const out = new Outbound((m) => sent.push(m), 30);
  const a = out.request('one');
  const b = out.request('two');
  const c = out.request<number>('three');
  // Handlers go on before anything can reject, so no rejection is ever unhandled.
  const aFails = assert.rejects(a, (e: unknown) => e instanceof RpcError && e.code === INTERNAL && /no response to one within 30 ms/.test(e.message));
  const bFails = assert.rejects(b, (e: unknown) => e instanceof RpcError && e.code === -5 && e.message === 'no');
  assert.equal(sent.length, 3);
  const ids = sent.map((m) => (m as { id: number }).id);
  assert.deepEqual(ids, [1, 2, 3], 'ids are distinct and sequential');
  out.handleResponse({ jsonrpc: '2.0', id: 3, result: 42 });
  assert.equal(await c, 42);
  out.handleResponse({ jsonrpc: '2.0', id: 2, error: { code: -5, message: 'no' } });
  await bFails;
  // A stray response (unknown id, or null) settles nothing and throws nothing.
  out.handleResponse({ jsonrpc: '2.0', id: 77, result: 1 });
  out.handleResponse({ jsonrpc: '2.0', id: null, result: 1 });
  // The first request has had no response: the timeout rejects it, saying which method and how long.
  // (Its timer is unref'd, as a daemon's must be; this timer keeps the loop alive until it fires.)
  await new Promise((r) => setTimeout(r, 50));
  await aFails;
  // Pending requests are rejected when the connection closes, with the reason given.
  const d = out.request('four');
  const e = out.request('five');
  const closed = (x: unknown) => x instanceof RpcError && x.code === INTERNAL && x.message === 'connection closed';
  const dFails = assert.rejects(d, closed);
  const eFails = assert.rejects(e, closed);
  out.rejectAll('connection closed');
  await Promise.all([dFails, eFails]);
  // Nothing left: a late response for a rejected request is a stray.
  out.handleResponse({ jsonrpc: '2.0', id: 4, result: 1 });
});
