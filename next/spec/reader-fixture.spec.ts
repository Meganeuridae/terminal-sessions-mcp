/**
 * Fixtures for the reader and search specs: a journal-backed ReadSource, Runs,
 * output events, and a pager that follows `since`/`offset` as an agent should.
 * (No tests here; the name keeps it beside the specs that use it.)
 */
import assert from 'node:assert/strict';
import { readJournal, type ReadOptions, type ReadResult, type ReadSource } from '../src/api/reader.js';
import { Journal } from '../src/core/journal.js';
import type { EventInput, OutputStream } from '../src/core/types.js';

const AGENT = 'agent:a@test';

export function source(opts: { cols?: number; rows?: number; journal?: Journal } = {}): ReadSource & { journal: Journal } {
  const journal = opts.journal ?? new Journal({ sessionId: 's' });
  return {
    id: 's',
    journal,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    runOutput: (runId, range) => journal.runs.output(journal, runId, range),
    run: (runId) => journal.runs.get(runId),
  };
}

export function startRun(j: Journal, runId: string, target: 'shell' | 'process' = 'process', geometry: { cols?: number; rows?: number } = {}): void {
  j.append({ type: 'run.admit', runId, target, principal: AGENT, origin: 'self', queued: false });
  const start: EventInput = { type: 'run.start', runId, cwd: '/' };
  if (geometry.cols !== undefined) start.cols = geometry.cols;
  if (geometry.rows !== undefined) start.rows = geometry.rows;
  j.append(start);
}

export const endRun = (j: Journal, runId: string) => j.append({ type: 'run.end', runId, state: 'exited', exit: 0, durationMs: 1 });

export function out(j: Journal, data: string, stream: OutputStream = 'pty', runId?: string): number {
  const ev: EventInput = { type: 'output', data, stream };
  if (runId !== undefined) ev.runId = runId;
  return j.append(ev).seq;
}

/** Follow pages as an agent should: `since` and `offset`, joining a line a page split. */
export async function readAll(src: ReadSource, o: ReadOptions, each?: (r: ReadResult) => void): Promise<{ text: string; pages: ReadResult[] }> {
  const pages: ReadResult[] = [];
  let since = o.since;
  let offset: number | undefined;
  let text = '';
  for (let guard = 0; guard < 100_000; guard++) {
    const r = await readJournal(src, { ...o, ...(since !== undefined ? { since } : {}), ...(offset !== undefined ? { offset } : {}) }, { resultBytes: 16384 });
    each?.(r);
    pages.push(r);
    if (pages.length > 1 && !pages[pages.length - 2]!.splitLine && r.text) text += '\n';
    text += r.text ?? '';
    assert.ok(r.nextCursor > (since ?? -1) || (r.nextOffset ?? 0) > (offset ?? 0) || !r.more, `a page makes progress: ${since}/${offset} → ${r.nextCursor}/${r.nextOffset}`);
    since = r.nextCursor;
    offset = r.nextOffset;
    if (!r.more) break;
  }
  return { text, pages };
}

