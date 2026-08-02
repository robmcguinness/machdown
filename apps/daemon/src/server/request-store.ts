import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import type { RepoStats } from './context.ts';
import type { QmdStats } from '#qmd/stats.ts';

/**
 * The one wide event a request accumulates. Named optional fields, not a
 * dictionary: every contributor (the oRPC middleware, the qmd accumulator,
 * the repository mutex timer, the error handler) adds a field it owns, and
 * this is the complete list of what a request may carry.
 */
export type WideEvent = {
  err?: unknown;
  errorCode?: string;
  extensionId?: string;
  procedure?: string;
  qmd?: QmdStats;
  repo?: RepoStats;
};

export type RequestStore = {
  /** Mutable bag; the Fastify onResponse hook spreads it into the wide event. */
  event: WideEvent;
  // `FastifyBaseLogger`, not pino's `Logger`: `request.log` and `app.log`
  // carry the narrower type, and the wider one would force a cast at every
  // call site that stores them.
  log: FastifyBaseLogger;
};

const storage = new AsyncLocalStorage<RequestStore>();

// Silent until buildApp installs the real root logger: module import order
// must never decide whether a singleton can log.
let fallbackLog: FastifyBaseLogger = pino({ level: 'silent' });

export const setFallbackLog = (log: FastifyBaseLogger): void => {
  fallbackLog = log;
};

/**
 * Binds the store to the current async chain. `enterWith`, not `run`:
 * a Fastify hook cannot wrap the rest of the request lifecycle in a
 * callback, and `enterWith` makes every continuation of this request
 * inherit the store.
 */
export const enterRequest = (store: RequestStore): void => {
  storage.enterWith(store);
};

/** The request child logger inside a request; the root logger outside. */
export const getLog = (): FastifyBaseLogger => storage.getStore()?.log ?? fallbackLog;

/**
 * Adds fields to this request's wide event. Outside a request — startup,
 * fire-and-forget index updates after the response — it is a no-op, so
 * callers never need to know where they run.
 */
export const addEventFields = (fields: Partial<WideEvent>): void => {
  const store = storage.getStore();
  if (store) {
    Object.assign(store.event, fields);
  }
};

/**
 * Runs `body` with no request in scope, whatever the caller had.
 *
 * For work that outlives the request that started it: a re-index scheduled by
 * a clip save finishes long after the response, and anything it recorded would
 * land on a wide event that has already been written — or be reported through
 * a logger whose request is over. Detaching is deliberate rather than
 * inherited, because `enterWith` binds the whole continuation of a request,
 * including every timer it sets.
 */
export const runDetached = <T>(body: () => T): T => storage.exit(body);

/** For the onResponse hook: the bag to spread into the wide event. */
export const currentEvent = (): WideEvent | undefined => storage.getStore()?.event;
