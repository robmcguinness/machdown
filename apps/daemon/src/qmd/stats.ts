import { addEventFields, currentEvent } from '#server/request-store.ts';

/**
 * The search-index usage one request reports on its wide event.
 *
 * Its own module rather than a private helper in `client.ts`: the client can
 * only reach this through a live worker thread, so the accumulation rule —
 * add, never replace — would otherwise have no way to be tested on its own.
 */
export type QmdStats = {
  calls: number;
  ms: number;
  timeouts: number;
};

const EMPTY: QmdStats = { calls: 0, ms: 0, timeouts: 0 };

/** One decimal is enough to tell a cache hit from a model load. */
const roundMs = (ms: number): number => Math.round(ms * 10) / 10;

/**
 * Adds one index call to this request's totals.
 *
 * Accumulates, rather than overwrites: one request can issue several searches
 * — the category suggester batches them — and the wide event should show the
 * totals. Outside a request it is a no-op, so background indexing stays safe.
 */
export const recordQmdCall = (elapsedMs: number, timedOut: boolean): void => {
  const previous = currentEvent()?.qmd ?? EMPTY;

  addEventFields({
    qmd: {
      calls: previous.calls + 1,
      ms: roundMs(previous.ms + elapsedMs),
      timeouts: previous.timeouts + (timedOut ? 1 : 0),
    } satisfies QmdStats,
  });
};
