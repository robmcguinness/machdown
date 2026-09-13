import { readConfig, invalidateClipSnapshot, warmClipSnapshot } from './store.ts';
import { regenerateReadme } from './generate.ts';
import { invalidateSuggestions } from '#suggest/cache.ts';
import { clearHealthCache } from '#router/health.ts';
import { warmIndex } from '#qmd/client.ts';
import { detach } from '#util/detach.ts';
import { getLog } from '#server/request-store.ts';

/** Called under the repository mutex after pull, before any attempted push. */
export const reconcileAfterPull = async (repoPath: string): Promise<void> => {
  invalidateSuggestions(repoPath);
  await clearHealthCache();
  const config = await readConfig(repoPath);
  // Search must refresh even if rebuilding a derived file fails.
  warmIndex({ collection: config.qmdCollection, repoPath });
  invalidateClipSnapshot(repoPath);
  await regenerateReadme(repoPath);
  detach(
    () => warmClipSnapshot(repoPath),
    (cause) => getLog().warn({ err: cause }, 'clip snapshot warm-up failed'),
  );
};
