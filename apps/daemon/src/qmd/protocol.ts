/**
 * The wire format between the daemon and the qmd worker thread.
 *
 * Types only, and deliberately free of any runtime import from `@tobilu/qmd`:
 * importing that package's entry point loads `better-sqlite3`'s native addon,
 * and the whole point of the worker is to keep that out of the Fastify process.
 * `import type` is fully erased under `erasableSyntaxOnly`, so this file costs
 * nothing at runtime.
 */

/** Which index a request refers to. A change here means a new worker. */
export type QmdTarget = {
  collection: string;
  repoPath: string;
};

export type WorkerInit = {
  clipsPath: string;
  collection: string;
  dbPath: string;
};

export type SearchKind = 'searchLex' | 'searchVec' | 'searchFull';

export type QmdCommand =
  | {
      kind: SearchKind;
      limit: number;
      minScore?: number;
      query: string;
      /** False returns bare `RawHit`s: the category suggester has its own metadata. */
      enrich: boolean;
    }
  | { kind: 'status' | 'update' | 'embed' | 'close' };

/** A command plus the id its reply will carry. */
export type QmdRequest = QmdCommand & { id: number };

export type QmdMessage =
  | { id: number; ok: true; value: unknown }
  | { id: number; message: string; ok: false }
  /**
   * Unsolicited. The first vector search, reranked query, or embed run loads —
   * and on a fresh machine downloads — a local model, which takes minutes with
   * no progress reported by the SDK. This is the coarse signal the UI shows in
   * its place.
   */
  | { event: 'phase'; preparing: boolean };

/** Relative to the collection root. */
export type RawHit = {
  docid: string;
  relPath: string;
  score: number;
};

export type StatusPayload = {
  /** Documents in *our* collection, not the database total. */
  hasVectorIndex: boolean;
  indexed: number;
  needsEmbedding: number;
};

export type UpdatePayload = {
  indexed: number;
};

export type EmbedPayload = {
  cancelled: boolean;
  /** Documents, not chunks — a long clip embeds as several of the latter. */
  docsEmbedded: number;
};
