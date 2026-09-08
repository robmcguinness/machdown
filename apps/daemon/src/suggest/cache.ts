import type { CategorySuggestItemResult } from '@machdown/contract';
import { LRUCache } from 'lru-cache';

/**
 * Memoizes suggestions per URL.
 *
 * Opening the batch page, deselecting a tab, and re-running the suggestion pass
 * asks the same questions again within seconds — each one a qmd process spawn.
 * The answers only change when the repo does, so they are cached until a write
 * invalidates them or the TTL expires.
 */

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

const entries = new LRUCache<string, CategorySuggestItemResult>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

const keyFor = (repoPath: string, urlKey: string): string => `${repoPath}\0${urlKey}`;

export const getCachedSuggestion = (
  repoPath: string,
  urlKey: string,
): CategorySuggestItemResult | null => entries.get(keyFor(repoPath, urlKey)) ?? null;

export const setCachedSuggestion = (
  repoPath: string,
  urlKey: string,
  value: CategorySuggestItemResult,
): void => {
  entries.set(keyFor(repoPath, urlKey), value);
};

/** Called after any write: a new document changes what the answer should be. */
export const invalidateSuggestions = (repoPath: string): void => {
  const prefix = `${repoPath}\0`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
    }
  }
};
