/**
 * Clocks and timer bounds, shared by everything that measures durations or arms timers: the
 * watches, the service monitors and probes, the segmenter's cadences, and the session's waits.
 */
import { performance } from 'node:perf_hooks';

/** The longest delay Node's timers honour (2^31-1 ms, about 24.8 days): a longer one fires at once. Durations are validated against it (the house's read of 3eade8a, #22). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A timer delay Node honours: never past MAX_TIMER_MS, never negative. */
export const timerMs = (ms: number): number => Math.min(MAX_TIMER_MS, Math.max(0, ms));

/** The monotonic clock intervals are measured on, which a wall-clock step never moves; a test may replace it. */
export const clocks = { monotonic: (): number => performance.now() };
