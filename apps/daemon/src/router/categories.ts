import { authed, os, withRepoPath } from './base.ts';
import { loadClipIndex, readConfig } from '#repo/store.ts';
import { suggestCategories } from '#suggest/engine.ts';

/**
 * Recommends categories for pages about to be saved.
 *
 * Read-only, and deliberately outside the repo mutex: the popup asks for this
 * while a batch save may be running, and blocking a suggestion behind a commit
 * would make the picker feel broken.
 *
 * It also never fails. Every qmd path inside the engine is wrapped, so a
 * missing binary, a cold index, or an expired budget produces a weaker
 * suggestion with `degraded: true` rather than an error — nobody should be
 * unable to file a clip because the search index is not ready.
 */
export const categoriesSuggest = os.categories.suggest
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, input }) => {
    const { log, repoPath } = context;

    try {
      const [config, index] = await Promise.all([readConfig(repoPath), loadClipIndex(repoPath)]);

      return await suggestCategories(
        { config, deadline: Date.now() + input.timeoutMs, index, log, repoPath },
        input.items,
        input.limit,
      );
    } catch (error) {
      // The engine handles its own failures, so reaching here means the repo
      // config or index could not be read at all.
      log.error({ err: error }, 'category suggestion fell back without a selection');

      return {
        degraded: true,
        items: input.items.map((item) => ({
          id: item.id,
          selected: [],
          source: 'default' as const,
          suggestions: [],
        })),
        mode: null,
        tookMs: 0,
      };
    }
  });
