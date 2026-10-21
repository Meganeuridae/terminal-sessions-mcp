/**
 * Spans of the journal by seq, inclusive at both ends, as a gap event names one.
 */
import type { Seq } from './types.js';

/**
 * What of `ranges` none of `minus` covers: each range split around every one that overlaps it,
 * keeping the pieces on both sides, each with whatever else it carries (a gap's reason). The reader
 * reports a hole it inferred less the gap events that record part of it, and the segmenter's
 * catch-up does the same; each held its own copy of this split (a reviewer's read of the fixes
 * for #22).
 */
export function minusRanges<R extends { from: Seq; to: Seq }>(ranges: R[], minus: Iterable<{ from: Seq; to: Seq }>): R[] {
  let left = ranges;
  for (const m of minus) {
    left = left.flatMap((r) => (m.to < r.from || m.from > r.to ? [r] : [...(m.from > r.from ? [{ ...r, to: m.from - 1 }] : []), ...(m.to < r.to ? [{ ...r, from: m.to + 1 }] : [])]));
  }
  return left;
}
