import { PROTOCOL_VERSION } from '@machdown/contract/constants';
import { createCache } from 'async-cache-dedupe';
import { os } from './base.ts';
import { qmdStatus } from '#qmd/client.ts';
import { loadClipIndex, readConfig } from '#repo/store.ts';
import { status } from '#repo/git.ts';

/**
 * Short enough that a repository change shows up on the next poll, long enough
 * that an extension polling every second no longer costs four git subprocesses
 * plus a config read each time. Dedupe also collapses concurrent polls — two
 * browser windows asking at once share a single probe.
 */
const HEALTH_TTL_SECONDS = 2;

const cache = createCache({ storage: { type: 'memory' }, ttl: HEALTH_TTL_SECONDS })
  .define('repoStatus', (repoPath: string) => status(repoPath))
  .define('repoConfig', (repoPath: string) => readConfig(repoPath))
  .define('repoDuplicates', async (repoPath: string) => {
    try {
      return (await loadClipIndex(repoPath)).duplicates;
    } catch {
      // An unreadable index is reported elsewhere; health just has no duplicates to show.
      return [];
    }
  });

/**
 * Drops the cached probes so the next poll is truthful.
 *
 * Called when the configured repository changes: without it, `repo.init` would
 * be invisible to the extension until the TTL ran out.
 */
export const clearHealthCache = async (): Promise<void> => {
  await cache.clear();
};

/**
 * Unauthenticated on purpose: the extension polls this before it has a token,
 * and uses the answer to decide between saving to the repo and falling back to
 * a browser download. It reports status and conflicting clip paths, without clip bodies.
 */
export const health = os.health.handler(async ({ context }) => {
  const { config, version } = context.state;
  const repoPath = config.repoPath;

  const collection = repoPath ? (await cache.repoConfig(repoPath)).qmdCollection : null;

  // `available` reports whether the embedded index opened and answered, which
  // is a stronger claim than the old "is the binary installed" probe — and it
  // is also what warms the index on the extension's first poll.
  const [repo, qmd, duplicateUrls] = await Promise.all([
    repoPath ? cache.repoStatus(repoPath) : Promise.resolve(null),
    // Uncached on purpose: the first call warms the index, and `preparing` has
    // to stay live so the extension can watch the warm-up finish.
    repoPath && collection
      ? qmdStatus({ collection, repoPath })
      : Promise.resolve({ available: false, indexed: 0, preparing: false }),
    repoPath ? cache.repoDuplicates(repoPath) : Promise.resolve([]),
  ]);

  return {
    bookmarks: { path: config.bookmarksPath },
    ok: true as const,
    paired: config.extensions.length > 0,
    protocol: PROTOCOL_VERSION,
    qmd: {
      available: qmd.available,
      collection: qmd.available ? collection : null,
      indexed: qmd.indexed,
      preparing: qmd.preparing,
    },
    repo: repo ? { ...repo, duplicateUrls } : null,
    version,
  };
});
