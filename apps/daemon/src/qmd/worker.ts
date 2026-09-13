import type {
  EmbedPayload,
  QmdMessage,
  QmdRequest,
  RawHit,
  StatusPayload,
  UpdatePayload,
  WorkerInit,
} from './protocol.ts';
import type { SearchHit } from '@machdown/contract';
import { type QmdDoc, type ValidationIssues, toRawHit, toSearchHit } from './hits.ts';
import { type QMDStore, createStore, extractSnippet } from '@tobilu/qmd';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { detach } from '#util/detach.ts';

/**
 * Owns the embedded qmd store.
 *
 * It lives in a worker because `better-sqlite3` is synchronous and an `update`
 * or `embed` run takes minutes: in the Fastify process that would stall health
 * checks, clip saves, and git for the whole run. The daemon never touches the
 * SDK directly — everything goes through the message protocol.
 */

const port = parentPort;
if (!port) {
  throw new Error('qmd worker must be started as a worker thread');
}

/** `workerData` is the daemon's own process, not external input, but it still
 * crosses a thread boundary with no static type on the other side. */
function isWorkerInit(value: unknown): value is WorkerInit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'clipsPath' in value &&
    typeof value.clipsPath === 'string' &&
    'collection' in value &&
    typeof value.collection === 'string' &&
    'dbPath' in value &&
    typeof value.dbPath === 'string'
  );
}

if (!isWorkerInit(workerData)) {
  throw new Error('qmd worker started with malformed workerData');
}

const init = workerData;
const post = (message: QmdMessage): void => {
  port.postMessage(message);
};

const snippet = (body: string, query: string, maxLen?: number, chunkPos?: number): string =>
  extractSnippet(body, query, maxLen, chunkPos).snippet;

/**
 * Reports a hit the contract rejected.
 *
 * Written to stderr rather than sent over the protocol: a worker's stderr is
 * forwarded to the daemon's, and a dropped result is a developer-facing schema
 * problem, not something a request should carry.
 */
const onInvalid = (relPath: string, issues: ValidationIssues): void => {
  process.stderr.write(
    `qmd worker: dropped a search hit that failed validation: ${relPath}: ${JSON.stringify(issues)}\n`,
  );
};

/**
 * Created on first use, not at boot, so loading the native addon does not
 * delay a daemon that may never search.
 *
 * The collection is declared inline on every creation rather than registered
 * once: the source of truth is the daemon's repo config, so a repo that moved
 * or was renamed cannot leave a stale mapping behind.
 */
let storePromise: Promise<QMDStore> | null = null;

const getStore = (): Promise<QMDStore> => {
  storePromise ??= (async () => {
    await mkdir(dirname(init.dbPath), { recursive: true });
    return createStore({
      config: {
        collections: {
          [init.collection]: { path: init.clipsPath, pattern: '**/*.md' },
        },
      },
      dbPath: init.dbPath,
    });
  })();

  return storePromise;
};

/**
 * The first vector search, reranked query, or embed run loads a local model,
 * downloading it on a fresh machine. The SDK exposes no progress hook, so the
 * best the UI can be told is that it is happening at all.
 *
 * Tracked per operation rather than once for the worker: the three use
 * different models — embedding, reranking, query expansion — so a completed
 * vector search says nothing about whether a later reranked query still has
 * hundreds of megabytes to fetch.
 */
type ModelOp = 'vec' | 'rerank' | 'embed';

const modelsReady = new Set<ModelOp>();

const withModelPhase = async <T>(op: ModelOp, run: () => Promise<T>): Promise<T> => {
  if (modelsReady.has(op)) {
    return run();
  }

  post({ event: 'phase', preparing: true });
  try {
    const value = await run();
    modelsReady.add(op);
    return value;
  } finally {
    post({ event: 'phase', preparing: false });
  }
};

/**
 * Indexing runs one at a time. Searches deliberately do *not* queue behind it:
 * `update` awaits on hashing and file reads, and SQLite reads are fine
 * alongside a write, so a re-index only slows searches down rather than
 * blocking them.
 */
let maintenance: Promise<unknown> = Promise.resolve();

const serialize = <T>(run: () => Promise<T>): Promise<T> => {
  // oxlint-disable-next-line promise/prefer-await-to-then -- promise-chain tail, same idiom as util/mutex.ts
  const next = maintenance.then(run, run);
  // oxlint-disable-next-line promise/prefer-await-to-then -- see above
  maintenance = next.catch(() => null);
  return next;
};

/** A second `update` while one is queued joins it instead of scheduling another. */
let pendingUpdate: Promise<UpdatePayload> | null = null;

/**
 * Set as soon as `close` arrives.
 *
 * Shutdown is one-way: starting new work after it would either open the store
 * again behind the teardown or leave a native call running into the parent's
 * `terminate()`, which is what aborted the whole daemon.
 */
let closing = false;

const indexedCount = async (store: QMDStore): Promise<number> => {
  const status = await store.getStatus();
  return status.collections.find((entry) => entry.name === init.collection)?.documents ?? 0;
};

const runUpdate = (): Promise<UpdatePayload> => {
  const update = async (): Promise<UpdatePayload> => {
    try {
      return await serialize(async () => {
        const store = await getStore();
        await store.update({ collections: [init.collection] });
        return { indexed: await indexedCount(store) };
      });
    } finally {
      // Dedupe window closes with the update, success or not.
      pendingUpdate = null;
    }
  };
  pendingUpdate ??= update();

  return pendingUpdate;
};

/** Thrown only between native batches, after qmd has persisted their vectors. */
class EmbedCancelledError extends Error {
  constructor(message: string) {
    super(message);
    // `instanceof` survives, but logs print `name`; keep them in agreement.
    this.name = 'EmbedCancelledError';
  }
}

const runEmbed = (): Promise<EmbedPayload> =>
  serialize(async () => {
    const store = await getStore();
    const before = await store.getStatus();
    try {
      const result = await withModelPhase('embed', () =>
        store.embed({
          collection: init.collection,
          // qmd invokes this outside the native call. Throwing releases its
          // LLM session; unfinished documents remain pending for the next warm.
          onProgress: () => {
            if (closing) {
              throw new EmbedCancelledError('the search index is closing');
            }
          },
        }),
      );
      return { cancelled: false, docsEmbedded: result.docsProcessed };
    } catch (error) {
      if (!(error instanceof EmbedCancelledError)) {
        throw error;
      }
      // Progress reports chunks, not documents. Count only documents whose
      // complete vector set was persisted before cancellation.
      const after = await store.getStatus();
      return {
        cancelled: true,
        docsEmbedded: Math.max(0, before.needsEmbedding - after.needsEmbedding),
      };
    }
  });

const runStatus = async (): Promise<StatusPayload> => {
  const store = await getStore();
  const status = await store.getStatus();
  return {
    // Scoped to the configured collection: a database-wide total would report
    // other collections as if search could reach them.
    hasVectorIndex: status.hasVectorIndex,
    indexed: status.collections.find((entry) => entry.name === init.collection)?.documents ?? 0,
    needsEmbedding: status.needsEmbedding,
  };
};

const runSearch = async (
  request: Extract<QmdRequest, { kind: 'searchLex' | 'searchVec' | 'searchFull' }>,
): Promise<RawHit[] | SearchHit[]> => {
  const store = await getStore();
  const { limit, minScore, query } = request;

  let docs: QmdDoc[];

  if (request.kind === 'searchFull') {
    const results = await withModelPhase('rerank', () =>
      store.search({ collection: init.collection, limit, minScore, query }),
    );
    docs = results.map((result) => ({
      bestChunk: result.bestChunk,
      body: result.body,
      docid: result.docid,
      filepath: result.file,
      score: result.score,
      title: result.title,
    }));
  } else {
    // Neither backend takes a score threshold, so it is applied here.
    const results = await (async () => {
      if (request.kind !== 'searchVec') {
        return store.searchLex(query, { collection: init.collection, limit });
      }

      // Without a vector index there is nothing to search and no model gets
      // loaded, so announcing a model load — and worse, recording one as
      // finished — would be a lie.
      const vector = () => store.searchVector(query, { collection: init.collection, limit });
      const { hasVectorIndex } = await store.getStatus();
      return hasVectorIndex ? withModelPhase('vec', vector) : vector();
    })();

    docs = [];
    for (const result of results) {
      if (minScore === undefined || result.score >= minScore) {
        docs.push({
          body: result.body,
          chunkPos: result.chunkPos,
          docid: result.docid,
          filepath: result.filepath,
          score: result.score,
          title: result.title,
        });
      }
    }
  }

  if (!request.enrich) {
    return docs.map(toRawHit);
  }

  const hits = await Promise.all(
    docs.map((doc) => toSearchHit(doc, { clipsPath: init.clipsPath, onInvalid, query, snippet })),
  );
  return hits.filter((hit) => hit !== null);
};

const handle = async (
  request: QmdRequest,
): Promise<EmbedPayload | null | RawHit[] | SearchHit[] | StatusPayload | UpdatePayload> => {
  if (closing && request.kind !== 'close') {
    // Nothing new starts once shutdown began. The caller's own timeout would
    // have produced the same failure; refusing outright makes it immediate.
    throw new Error('the search index is closing');
  }

  switch (request.kind) {
    case 'searchLex':
    case 'searchVec':
    case 'searchFull':
      return runSearch(request);
    case 'status':
      return runStatus();
    case 'update':
      return runUpdate();
    case 'embed':
      return runEmbed();
    case 'close': {
      closing = true;
      // Queued behind maintenance: a running `embed` holds native llama work,
      // and tearing the store down underneath it is what aborted the daemon.
      return serialize(async () => {
        if (storePromise) {
          await (await storePromise).close();
        }
        return null;
      });
    }
  }
};

port.on('message', (request: QmdRequest) => {
  detach(
    async () => {
      try {
        post({ id: request.id, ok: true, value: await handle(request) });
      } catch (error) {
        // A failed query must never take the worker down with it.
        post({
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
          ok: false,
        });
      }

      if (request.kind === 'close') {
        port.close();
      }
    },
    () => {
      // Only `post` itself can throw here, when the port is already gone.
    },
  );
});
