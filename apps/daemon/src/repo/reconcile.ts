import { readConfig, invalidateClipSnapshot, warmClipSnapshot } from './store.ts';
import { regenerateReadme } from './generate.ts';
import { invalidateSuggestions } from '#suggest/cache.ts';
import { clearHealthCache } from '#router/health.ts';
import { warmIndex } from '#qmd/client.ts';

/** Called under the repository mutex after pull, before any attempted push. */
export const reconcileAfterPull = async (repoPath: string): Promise<void> => {
  invalidateSuggestions(repoPath);
  clearHealthCache();
  const config = await readConfig(repoPath);
  // Search must refresh even if rebuilding a derived file fails.
  warmIndex({ collection: config.qmdCollection, repoPath });
  invalidateClipSnapshot(repoPath);
  await regenerateReadme(repoPath);
  void warmClipSnapshot(repoPath);
};
