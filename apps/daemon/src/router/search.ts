import { QmdUnavailableError, search, updateIndex } from '#qmd/client.ts';
import { authed, os, withRepoPath } from './base.ts';
import { readConfig } from '#repo/store.ts';

/**
 * Proxies a query to qmd.
 *
 * Category and kind filtering happen here rather than in qmd: qmd indexes files
 * and knows nothing about our frontmatter, so hits are filtered after
 * enrichment. That means `limit` applies before filtering, and a narrow filter
 * can legitimately return fewer results than asked for.
 */
export const searchQuery = os.search.query
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    const config = await readConfig(context.repoPath);
    const startedAt = Date.now();

    try {
      const hits = await search(input.q, {
        collection: config.qmdCollection,
        limit: input.limit,
        minScore: input.minScore,
        mode: input.mode,
        repoPath: context.repoPath,
      });

      const wanted = new Set(input.categories);
      const kinds = new Set(input.kinds);

      const results = hits.filter(
        (hit) =>
          (wanted.size === 0 || hit.categories?.some((category) => wanted.has(category))) &&
          (kinds.size === 0 || kinds.has(hit.kind)),
      );

      return { mode: input.mode, results, tookMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof QmdUnavailableError) {
        throw errors.QMD_UNAVAILABLE({ message: error.message });
      }
      throw error;
    }
  });

export const indexUpdate = os.index.update
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    const config = await readConfig(context.repoPath);

    try {
      return await updateIndex(
        { collection: config.qmdCollection, repoPath: context.repoPath },
        input.embed,
      );
    } catch (error) {
      if (error instanceof QmdUnavailableError) {
        throw errors.QMD_UNAVAILABLE({ message: error.message });
      }
      throw error;
    }
  });
