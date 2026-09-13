import type {
  EmbedPayload,
  QmdCommand,
  QmdMessage,
  QmdRequest,
  QmdTarget,
  RawHit,
  SearchKind,
  StatusPayload,
  UpdatePayload,
  WorkerInit,
} from './protocol.ts';
import { CLIPS_DIR } from '#repo/paths.ts';
import { qmdDbPath } from '#config.ts';
import { getLog, runDetached } from '#server/request-store.ts';
import { recordQmdCall } from './stats.ts';
import { qmdDisabled, workerEnv } from '#env';
import { isErrnoException } from '#util/errors.ts';
import { detach } from '#util/detach.ts';
import type { SearchHit, SearchMode } from '@machdown/contract';
import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from 'pino';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

/**
 * Drives the embedded qmd index.
 *
 * qmd runs as a library inside a worker thread rather than as a CLI
 * subprocess: results arrive as structured records instead of scraped text,
 * the index stays open between requests instead of being reopened per call,
 * and nothing reaches a shell. What the worker owns — the SQLite handle and
 * the local models — is deliberately kept out of the Fastify process.
 */

export type { RawHit, QmdTarget } from './protocol.ts';

export type SearchOptions = QmdTarget & {
  limit: number;
  minScore?: number;
  mode: SearchMode;
  /**
   * Defaults to a budget sized for the mode. The category suggester overrides
   * it with something a popup can actually wait for.
   */
  timeoutMs?: number;
};

export type IndexResult = {
  cancelled?: boolean;
  embedded: number;
  updated: number;
};

export type QmdStatus = StatusPayload & {
  available: boolean;
  preparing: boolean;
};

export class QmdUnavailableError extends Error {
  /**
   * A timeout is the one failure the wide event counts separately: it means
   * the index answered too slowly, not that it is broken, and the two call
   * for different action.
   */
  readonly timedOut: boolean;

  constructor(message = 'the search index is unavailable', timedOut = false) {
    super(message);
    this.name = 'QmdUnavailableError';
    this.timedOut = timedOut;
  }
}

const SEARCH_KINDS: Record<SearchMode, SearchKind> = {
  query: 'searchFull',
  search: 'searchLex',
  vsearch: 'searchVec',
};

/** BM25 against an open database; anything slower than this is a fault. */
const LEX_TIMEOUT_MS = 30_000;
/**
 * Vector and reranked search both load a local model, and the first call after
 * a fresh install downloads it. That is minutes, not seconds.
 */
const MODEL_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 5_000;
const INDEX_TIMEOUT_MS = 10 * 60_000;
/**
 * Allows ten seconds for queued maintenance and the store's dispose chain.
 * qmd applies a 1 s timeout per context, model, and runtime; context pools
 * mean the total is not fixed. This budget can cover a short in-flight embed,
 * but does not guarantee every embed or disposal finishes. Terminating earlier
 * aborted the daemon: a native llama call resuming in a terminating worker cannot
 * throw a JS error, so ggml's terminate handler aborts the process.
 */
const CLOSE_TIMEOUT_MS = 10_000;
/** After a clean `close` reply the thread ends by itself; this is a guard. */
const EXIT_WAIT_MS = 2_000;
/** A stalled log destination must not consume the remaining shutdown budget. */
const FLUSH_TIMEOUT_MS = 250;

/**
 * After a failure the worker is not respawned immediately.
 *
 * A broken native build fails on `createStore`, several seconds in, every
 * time. Without a cooldown every search would pay that again.
 */
const FAILURE_COOLDOWN_MS = 30_000;

type Pending = {
  reject: (error: Error) => void;
  // Erased on purpose: `Live.pending` holds every in-flight request kind at
  // once, and `QmdMessage`'s own `value: unknown` (the wire protocol, which
  // cannot know a reply's shape before its request is matched by id) is
  // exactly as wide as this needs to be. `send<T>` below is what recovers T.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see above
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

type Live = {
  dead: boolean;
  key: string;
  pending: Map<number, Pending>;
  worker: Worker;
};

let live: Live | null = null;
let lastFailureAt = 0;
let nextId = 1;
let preparing = false;

/**
 * Serialized rather than joined on a separator: a repository path can contain
 * almost any character, and the one byte guaranteed not to collide — NUL —
 * makes git treat this whole file as binary.
 */
const keyOf = (target: QmdTarget): string => JSON.stringify([target.repoPath, target.collection]);

const fail = (current: Live, message: string, code?: string): void => {
  // The only report of a worker that died on spawn: nothing awaits these
  // events, and the callers below turn the rejection into an empty result.
  // The `code` is what separates a heap exhaustion (`ERR_WORKER_OUT_OF_MEMORY`)
  // from an ordinary query failure; the message alone reads the same either way.
  getLog().warn({ code, reason: message }, 'the search index worker failed');

  current.dead = true;
  lastFailureAt = Date.now();
  preparing = false;

  for (const entry of current.pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new QmdUnavailableError(message));
  }
  current.pending.clear();

  if (live === current) {
    live = null;
  }
};

const spawn = (target: QmdTarget): Live => {
  const init: WorkerInit = {
    clipsPath: path.join(target.repoPath, CLIPS_DIR),
    collection: target.collection,
    dbPath: qmdDbPath(),
  };

  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: init,
    /**
     * A pass-through of the parent's environment, nothing more.
     *
     * This option only fills the worker's JavaScript `process.env` map; it
     * never calls `setenv`, so native code that reads `getenv` cannot see
     * anything added here. The Metal residency mitigation that guards against
     * a GGML assertion during `process.exit` is node-llama-cpp's own — it
     * calls the native `setEnv` before it loads its backends — so the right
     * thing to do is leave that key alone and let the library set it.
     */
    env: workerEnv(),
  });
  const current: Live = { dead: false, key: keyOf(target), pending: new Map(), worker };

  worker.on('message', (message: QmdMessage) => {
    if ('event' in message) {
      preparing = message.preparing;
      return;
    }

    const entry = current.pending.get(message.id);
    if (!entry) {
      return;
    }
    current.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.ok) {
      entry.resolve(message.value);
    } else {
      entry.reject(new QmdUnavailableError(message.message));
    }
  });

  worker.on('error', (error: Error) => {
    fail(current, error.message, isErrnoException(error) ? error.code : undefined);
  });
  worker.on('exit', () => {
    if (!current.dead) {
      fail(current, 'the search index worker exited');
    }
  });

  // A live index must never be the reason the daemon — or a test run — refuses
  // to exit.
  worker.unref();

  return current;
};

const ensureWorker = (target: QmdTarget): Live => {
  if (qmdDisabled()) {
    throw new QmdUnavailableError('the search index is disabled');
  }

  if (live && !live.dead) {
    if (live.key === keyOf(target)) {
      return live;
    }
    // A different repo or collection is a different index: the old worker
    // holds the wrong collection config and has to go.
    detach(closeQmd, (cause) => {
      getLog().warn({ err: cause }, 'closing the stale search worker failed');
    });
  }

  if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
    // Says why a search came back empty without a worker having been spawned.
    getLog().warn(
      { cooldownMs: FAILURE_COOLDOWN_MS },
      'the search index is in its failure cooldown',
    );
    throw new QmdUnavailableError('the search index failed to start');
  }

  live = spawn(target);
  return live;
};

const send = async <T>(current: Live, message: QmdCommand, timeoutMs: number): Promise<T> => {
  const id = nextId++;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      current.pending.delete(id);
      // The worker keeps going; a late reply is simply dropped. Killing it
      // would throw away a model load that the next request needs anyway.
      reject(new QmdUnavailableError(`the search index timed out after ${timeoutMs}ms`, true));
    }, timeoutMs);
    timer.unref?.();

    current.pending.set(id, {
      reject,
      // SAFETY: erasing T to the map's shared `unknown` is exactly what lets
      // one `Live.pending` hold every in-flight request kind; `send<T>`'s own
      // `Promise<T>` executor is what `resolve` really resolves.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see above
      resolve: resolve as (value: unknown) => void,
      timer,
    });
    const request: QmdRequest = { ...message, id };
    current.worker.postMessage(request);
  });
};

const request = async <T>(
  target: QmdTarget,
  message: QmdCommand,
  timeoutMs: number,
): Promise<T> => {
  const startedAt = performance.now();
  let timedOut = false;

  try {
    return await send<T>(ensureWorker(target), message, timeoutMs);
  } catch (error) {
    timedOut = error instanceof QmdUnavailableError && error.timedOut;
    throw error;
  } finally {
    // In the `finally`, so a refusal — disabled, cooldown, timeout — counts
    // too: a request that asked the index for something and got nothing is
    // exactly what an operator is looking for on the event.
    recordQmdCall(performance.now() - startedAt, timedOut);
  }
};

const searchTimeout = (mode: SearchMode): number =>
  mode === 'search' ? LEX_TIMEOUT_MS : MODEL_TIMEOUT_MS;

/**
 * Runs a search and returns only what qmd itself reported.
 *
 * Deliberately unenriched: the category suggester issues one of these per page
 * in a batch and already has every document's metadata in the in-memory clip snapshot.
 */
export const searchRaw = async (query: string, options: SearchOptions): Promise<RawHit[]> =>
  request<RawHit[]>(
    options,
    {
      enrich: false,
      kind: SEARCH_KINDS[options.mode],
      limit: options.limit,
      minScore: options.minScore,
      query,
    },
    options.timeoutMs ?? searchTimeout(options.mode),
  );

/** Runs a search and enriches each hit with the document's own frontmatter. */
export const search = async (query: string, options: SearchOptions): Promise<SearchHit[]> =>
  request<SearchHit[]>(
    options,
    {
      enrich: true,
      kind: SEARCH_KINDS[options.mode],
      limit: options.limit,
      minScore: options.minScore,
      query,
    },
    options.timeoutMs ?? searchTimeout(options.mode),
  );

/**
 * Index posture for the health readout.
 *
 * `available` now means the store opened and answered, which is a stronger
 * claim than the old "the binary exists" probe.
 */
export const qmdStatus = async (target: QmdTarget): Promise<QmdStatus> => {
  try {
    const status = await request<StatusPayload>(target, { kind: 'status' }, STATUS_TIMEOUT_MS);
    return { ...status, available: true, preparing };
  } catch {
    return {
      available: false,
      hasVectorIndex: false,
      indexed: 0,
      needsEmbedding: 0,
      preparing: false,
    };
  }
};

export const updateIndex = async (target: QmdTarget, embed: boolean): Promise<IndexResult> => {
  const { indexed } = await request<UpdatePayload>(target, { kind: 'update' }, INDEX_TIMEOUT_MS);
  if (!embed) {
    return { embedded: 0, updated: indexed };
  }

  // Embedding loads a local model and can run for minutes, so callers
  // explicitly opt into it.
  const { cancelled, docsEmbedded } = await embedIndex(target);
  return { cancelled, embedded: docsEmbedded, updated: indexed };
};

const embedIndex = async (target: QmdTarget): Promise<EmbedPayload> => {
  const result = await request<EmbedPayload>(target, { kind: 'embed' }, INDEX_TIMEOUT_MS);
  if (result.cancelled) {
    getLog().info({ docsEmbedded: result.docsEmbedded }, 'search index embed cancelled for close');
  }
  return result;
};

/**
 * Points the index at this repo's clips and re-scans them.
 *
 * The re-scan is not an optimization. Declaring the collection only rewrites
 * qmd's collection table; documents indexed from the previous directory stay
 * active under the same collection name until a scan deactivates them, and
 * search would keep returning files from a repo the daemon no longer serves.
 *
 * Fire-and-forget: a repository is perfectly usable without search, so this
 * must not fail — or delay — the call that triggered it.
 */
export const warmIndex = (target: QmdTarget, options: { embed?: boolean } = {}): void => {
  // Detached from whatever request asked for it. A re-index outlives the
  // response that triggered it, so without this it would keep writing to a
  // wide event that has already been emitted — inflating a finished request's
  // `qmd` totals — and would report failures through a stale request logger.
  runDetached(() => {
    detach(
      async () => {
        await request(target, { kind: 'update' }, INDEX_TIMEOUT_MS);
        // Embedding may load a model and process an existing backlog. Keep
        // registration update-only; writes opt in so new clips reach vsearch.
        if (options.embed) {
          await embedIndex(target);
        }
      },
      (cause) => {
        // Search staleness is recoverable, but a silent failure here is
        // invisible — log it instead of swallowing it outright.
        getLog().warn({ err: cause }, 'background re-index failed');
      },
    );
  });
};

let pendingUpdate: NodeJS.Timeout | null = null;

/**
 * Re-indexes shortly after a write, coalescing bursts.
 *
 * Fire-and-forget on purpose: a 40-tab batch save should not wait on the
 * indexer, and a failed re-index must never fail the save that triggered it.
 */
export const scheduleIndexUpdate = (target: QmdTarget, delayMs = 2_000): void => {
  if (pendingUpdate) {
    clearTimeout(pendingUpdate);
  }

  // The timer is created detached as well: a timer scheduled inside a request
  // inherits that request's store, and the bookkeeping below would otherwise
  // run against it long after the response went out.
  pendingUpdate = runDetached(() =>
    setTimeout(() => {
      pendingUpdate = null;
      warmIndex(target, { embed: true });
    }, delayMs),
  );

  // Do not hold the process open just to re-index.
  pendingUpdate.unref?.();
};

/**
 * Whether the worker thread ended by itself within `ms`.
 *
 * The timer is unref'd so the exit guard itself does not keep the daemon up.
 * The worker may still have work that keeps the process alive.
 */
const waitForExit = async (worker: Worker, ms: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    if (worker.threadId === -1) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    worker.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const canFlush = (log: FastifyBaseLogger): log is FastifyBaseLogger & Pick<Logger, 'flush'> =>
  'flush' in log && typeof log.flush === 'function';

/** Closes the index. Load-bearing at shutdown: the worker holds an open database. */
export const closeQmd = async (): Promise<void> => {
  if (pendingUpdate) {
    clearTimeout(pendingUpdate);
    pendingUpdate = null;
  }

  const current = live;
  if (!current) {
    return;
  }
  live = null;

  if (current.dead) {
    await current.worker.terminate();
    return;
  }

  const startedAt = Date.now();
  let closedCleanly = false;

  getLog().info('waiting for the search index to finish before exit');
  try {
    // Sent directly rather than through `request`, which would spawn a
    // replacement worker for the one being closed.
    await send(current, { kind: 'close' }, CLOSE_TIMEOUT_MS);
    closedCleanly = true;
  } catch {
    // A worker that cannot close cleanly reaches the hard-exit fallback below.
  }

  // Before `terminate`, so the `exit` handler does not read a deliberate
  // shutdown as a crash and put the next worker behind the failure cooldown.
  current.dead = true;

  // A worker that answered `close` has already disposed its models and closed
  // its database, and its port is shut, so the thread ends on its own.
  // Terminating it anyway is the last resort: that is the call that turns a
  // still-running native operation into a process-wide abort.
  if (closedCleanly && (await waitForExit(current.worker, EXIT_WAIT_MS))) {
    getLog().info({ ms: Date.now() - startedAt }, 'search index closed');
    return;
  }

  // Node's test runner sets NODE_TEST_CONTEXT in every test process. Tests
  // also close application instances, so their fallback must only stop the
  // worker, never kill the runner. Production always uses the hard exit.
  // oxlint-disable-next-line node/no-process-env -- Node owns this test-runner marker, not application configuration.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    await current.worker.terminate();
    return;
  }

  // terminate() during a native llama call caused SIGABRT. SIGKILL avoids
  // unwinding native state and leaves no abort trace. SQLite uses WAL, so
  // unfinished embeddings can be resumed safely on the next warm.
  const log = getLog();
  log.warn({ ms: Date.now() - startedAt }, 'search index did not close in time; exiting hard');
  let flushTimer: NodeJS.Timeout | undefined;
  try {
    if (canFlush(log)) {
      await new Promise<void>((resolve) => {
        // Keep the deadline referenced so even a missing callback reaches
        // SIGKILL instead of leaving native teardown to normal process exit.
        flushTimer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        log.flush(() => resolve());
      });
    }
  } finally {
    clearTimeout(flushTimer);
    process.kill(process.pid, 'SIGKILL');
  }
};
