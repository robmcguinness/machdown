import { type DaemonConfig, type PairedExtension, saveDaemonConfig } from '#config.ts';
import { type Mutex, createMutex } from '#util/mutex.ts';
import { addEventFields, currentEvent } from './request-store.ts';
import { type PairingCodes, createPairingCodes } from './auth.ts';

/** How long this request spent on the repository mutex, in the wide event. */
export type RepoStats = {
  holdMs: number;
  waitMs: number;
};

const EMPTY_REPO_STATS: RepoStats = { holdMs: 0, waitMs: 0 };

/** One decimal: a queued batch save is measured in milliseconds, not ticks. */
const roundMs = (ms: number): number => Math.round(ms * 10) / 10;

/**
 * Times every trip through the repository mutex.
 *
 * The mutex is the daemon's main hidden latency: a 40-tab batch save queues
 * every write behind the one in front of it, and the request that waited looks
 * identical to the one that did not. So the wide event carries both halves —
 * the wait in the queue and the hold of the critical section.
 *
 * Totals, because one request can take the mutex more than once: a clip save
 * migrates the repository first and writes second. Outside a request the
 * fields go nowhere, so boot-time migration needs no special case.
 */
const timed = (mutex: Mutex): Mutex => {
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const queuedAt = performance.now();

    return mutex(async () => {
      const heldAt = performance.now();

      try {
        return await task();
      } finally {
        const previous = currentEvent()?.repo ?? EMPTY_REPO_STATS;

        addEventFields({
          repo: {
            holdMs: roundMs(previous.holdMs + (performance.now() - heldAt)),
            waitMs: roundMs(previous.waitMs + (heldAt - queuedAt)),
          } satisfies RepoStats,
        });
      }
    });
  };
};

/**
 * Process-wide daemon state, created once at boot and shared by every request.
 */
export type DaemonState = {
  config: DaemonConfig;
  pairingCodes: PairingCodes;
  /** Serializes every repository mutation. */
  withRepo: Mutex;
  /** Persists `config` and keeps the 0600 mode. */
  persist: () => Promise<void>;
  version: string;
};

export const createDaemonState = (config: DaemonConfig, version: string): DaemonState => ({
  config,
  pairingCodes: createPairingCodes(),
  persist: () => saveDaemonConfig(config),
  version,
  withRepo: timed(createMutex()),
});

/** What a degraded path may attach to its own log line, named by call site. */
export type LogDetails = { err: unknown } | { err: unknown; id: string };

/**
 * The slice of Pino the daemon's own code uses.
 *
 * Declared structurally, and with method shorthand so the parameter types stay
 * bivariant, so a `FastifyBaseLogger` satisfies it without any module here
 * depending on Fastify. That matters for `suggest/engine.ts`, which is unit
 * tested with no server in the picture.
 */
export type Log = {
  error(details: LogDetails, message: string): void;
  warn(details: LogDetails, message: string): void;
};

/** Discards everything. For call sites with no request in scope. */
export const silentLog: Log = { error: () => {}, warn: () => {} };

/**
 * Per-request context handed to every oRPC procedure.
 *
 * `extension` is populated by the auth middleware; it is null on the two
 * unauthenticated procedures (`health`, `pair`).
 */
export type RequestContext = {
  extension: PairedExtension | null;
  state: DaemonState;
  token: string | null;
  /** The request-scoped logger, so a degraded path can say why. */
  log: Log;
};
