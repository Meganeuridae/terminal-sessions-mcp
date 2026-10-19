/**
 * §16 Measure's analysis: records are data (a hostile tool name cannot break the
 * report), the confusion signatures read what they are defined for (runId-keyed,
 * agents only, `await` after `running` is not confusion), and the log's rotated
 * generations are all read.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyze, readUsage, usageDigest, newUsageKey, type UsageRecord } from '../src/api/usage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-usage-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const T0 = Date.parse('2026-09-24T10:00:00Z');
let n = 0;
function rec(tool: string, over: Partial<UsageRecord> = {}): UsageRecord {
  return { ts: T0 + n++ * 10, principal: 'agent:a@x', connection: 'c', host: 'mcp', profile: 'core', tool, ok: true, ms: 5, args: [], ...over };
}

test('atc-18/tsg-15: tool names that are Object.prototype members are counted, never crash the report', () => {
  const records = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'run'].map((t) => rec(t, { ok: t === 'run', error: t === 'run' ? undefined : 'constructor' } as Partial<UsageRecord>));
  const r = analyze(records);
  assert.equal(r.calls, 5);
  const own = (o: object, k: string): unknown => Object.getOwnPropertyDescriptor(o, k)?.value;
  assert.equal((own(r.byTool, 'constructor') as { calls: number }).calls, 1);
  assert.equal((own(r.byTool, '__proto__') as { calls: number }).calls, 1, '__proto__ is an own key, not the prototype');
  assert.equal(own(r.errors, 'constructor'), 4);
  assert.equal(Object.getPrototypeOf(r.byTool), Object.prototype, 'the prototype was not replaced');
});

test('atc-17/ux-23: signatures follow runIds, count only agents, and `await` after `running` is a wait measure, not confusion', () => {
  n = 0;
  const a = (tool: string, over: Partial<UsageRecord> = {}) => rec(tool, over);
  const records: UsageRecord[] = [
    // run → running, then the documented await {runId} (no session): not confusion, but a short wait.
    a('run', { session: 's', runId: 'r1', state: 'running', wait: 20000 }),
    a('await', { session: 's', runId: 'r1', state: 'running' }), // the result reports its session
    a('await', { session: 's', runId: 'r1', state: 'exited', ts: T0 + 30_000 }),
    // run → running, then read {runId}: the confusion signature, keyed by the Run.
    a('run', { session: 's', runId: 'r2', state: 'starting', ts: T0 + 40_000 }),
    a('read', { runId: 'r2', ts: T0 + 41_000 }),
    // busy, then cancel {runId} of the Run that blocked it (no session in the call).
    a('run', { session: 's', state: 'busy', blockedBy: 'r2', ts: T0 + 50_000 }),
    a('cancel', { runId: 'r2', state: 'cancelled', ts: T0 + 51_000 }),
    // A human typing Up Up in the GUI is not a blind resend; an agent sending the same input twice is.
    a('input', { principal: 'human:gui:agent:a@x', host: 'native', session: 's', digest: 'd1', ts: T0 + 60_000 }),
    a('input', { principal: 'human:gui:agent:a@x', host: 'native', session: 's', digest: 'd1', ts: T0 + 60_100 }),
    a('input', { session: 's', digest: 'd2', ts: T0 + 61_000 }),
    a('input', { session: 's', digest: 'd2', ts: T0 + 61_200 }),
    // Sensitive input has no digest: never matched.
    a('input', { session: 's', sensitive: true, ts: T0 + 62_000 }),
    a('input', { session: 's', sensitive: true, ts: T0 + 62_100 }),
  ];
  const r = analyze(records);
  assert.equal(r.signatures['read-after-short-wait']?.count, 1, 'the read {runId} after a starting result; the awaits are not counted');
  assert.equal(r.signatures['cancel-after-busy']?.count, 1, 'cancel {runId} of the blocking Run');
  assert.equal(r.signatures['input-twice']?.count, 1, "only the agent's resend");
  assert.equal(r.agentCalls, records.length - 2);
  assert.equal(r.waits.awaitAfterUnfinished, 2);
  assert.equal(r.waits.runsAwaited, 1);
  assert.equal(r.waits.extraMs.max, 30_000, 'from the first unfinished result to the call that saw the end');
});

test('readUsage reads every rotated generation, oldest first, and skips lines that are not records', () => {
  const file = path.join(tmp, 'usage.jsonl');
  const line = (tool: string, ts: number) => JSON.stringify(rec(tool, { ts })) + '\n';
  fs.writeFileSync(`${file}.3`, line('read', 1));
  fs.writeFileSync(`${file}.2`, line('screen', 2) + '{"not":"a record"}\n' + 'null\n');
  fs.writeFileSync(`${file}.1`, line('input', 3));
  fs.writeFileSync(file, line('run', 4) + '{"torn');
  assert.deepEqual(readUsage(file).map((r) => r.tool), ['read', 'screen', 'input', 'run']);
});

test('atc-4: usage digests are keyed: one key agrees with itself, another key does not', () => {
  const k1 = newUsageKey();
  const k2 = newUsageKey();
  const typed: Array<[string, unknown]> = [['text', '4821'], ['keys', ['Enter']]];
  assert.equal(usageDigest(k1, typed), usageDigest(k1, typed));
  assert.notEqual(usageDigest(k1, typed), usageDigest(k2, typed));
  assert.match(usageDigest(k1, typed), /^[0-9a-f]{16}$/);
});
