/** One subtraction of seq ranges for the reader's holes and the segmenter's catch-up (core/ranges.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minusRanges } from '../src/core/ranges.js';

test('a range less the ranges that overlap it keeps the pieces on both sides, with what each carries', () => {
  const hole = { from: 10, to: 30, reason: 'retention' as const };
  assert.deepEqual(minusRanges([hole], [{ from: 15, to: 20 }]), [{ from: 10, to: 14, reason: 'retention' }, { from: 21, to: 30, reason: 'retention' }], 'inside: both sides kept');
  assert.deepEqual(minusRanges([hole], [{ from: 5, to: 12 }, { from: 28, to: 40 }]), [{ from: 13, to: 27, reason: 'retention' }], 'over each end');
  assert.deepEqual(minusRanges([hole], [{ from: 10, to: 30 }]), [], 'all of it');
  assert.deepEqual(minusRanges([hole], [{ from: 1, to: 9 }, { from: 31, to: 40 }]), [hole], 'touching is not overlapping');
  assert.deepEqual(minusRanges([hole, { from: 40, to: 50, reason: 'store-error' as const }], [{ from: 25, to: 45 }]), [{ from: 10, to: 24, reason: 'retention' }, { from: 46, to: 50, reason: 'store-error' }], 'several ranges at once');
});
