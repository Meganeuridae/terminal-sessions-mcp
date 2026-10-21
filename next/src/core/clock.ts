/**
 * Clocks and timer bounds, shared by everything that measures durations or arms timers: the
 * watches, the service monitors and probes, the segmenter's cadences, and the session's waits.
 */
import { performance } from 'node:perf_hooks';

/** The longest delay Node's timers honour (2^31-1 ms, about 24.8 days): a longer one fires at once. Durations are validated against it (the house's read of 3eade8a, #22). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A timer delay Node honours: never past MAX_TIMER_MS, never negative. */
export const timerMs = (ms: number): number => Math.min(MAX_TIMER_MS, Math.max(0, ms));

/**
 * The monotonic clock intervals are measured on, which a wall-clock step never moves; a test may
 * replace it. The exceptions are spans with no monotonic stamp, aged by the journal's wall-clock
 * stamp: a watch's age for output the manager did not stamp on arrival — output from before the
 * manager existed, or the last output of an ended Run older than the newest 1,024 — clamped at zero (watches.ts
 * `ageOf`; the house's read of the 36 commits, #22, comment 6269992150); and a keyed Run, or an
 * idempotency key, that only a restart's journal knows (App.runAgeMs, the idempotency store's
 * recovered keys). Everything this daemon life stamps itself is measured here, the idempotency
 * window and the journal's cold-store retry included (the house's read of the 38 commits, #22,
 * comment 6274935728, item 7).
 */
export const clocks = { monotonic: (): number => performance.now() };
