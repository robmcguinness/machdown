import { authed, os, withRepoPath } from './base.ts';
import { loadClipIndex, readConfig, saveBookmark } from '#repo/store.ts';
import { CommandError } from '#util/exec.ts';
import { commitIfChanged } from '#repo/git.ts';
import { ensureMigrated, migrationPaths, markMigrationCommitted } from '#repo/migrate.ts';
import { invalidateSuggestions } from '#suggest/cache.ts';
import { regenerateReadme } from '#repo/generate.ts';
import { scheduleIndexUpdate } from '#qmd/client.ts';

/**
 * Records link-only bookmarks as stub documents alongside clips.
 *
 * They are files rather than JSON rows so qmd indexes them, search finds them,
 * and the category suggester can learn from a link the user never fully
 * clipped. Saving a bookmark for a URL that is already a full clip only merges
 * the metadata — it never throws away a captured page.
 */
export const bookmarksSave = os.bookmarks.save
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    const { repoPath } = context;
    await ensureMigrated(repoPath, context.state.withRepo);

    return context.state.withRepo(async () => {
      const config = await readConfig(repoPath);
      const index = await loadClipIndex(repoPath);

      const changedPaths = ['README.md', ...migrationPaths(repoPath)];
      let added = 0;
      let updated = 0;

      for (const bookmark of input.bookmarks) {
        const saved = await saveBookmark(repoPath, bookmark, index, config);
        changedPaths.push(saved.relPath);
        if (saved.movedFrom) {
          changedPaths.push(saved.movedFrom);
        }
        if (saved.status === 'created') {
          added += 1;
        } else {
          updated += 1;
        }
      }

      await regenerateReadme(repoPath, { snapshot: true });
      invalidateSuggestions(repoPath);
      scheduleIndexUpdate({ collection: config.qmdCollection, repoPath });

      const total = added + updated;

      try {
        const commit = config.autoCommit
          ? await commitIfChanged(
              repoPath,
              `bookmark: ${total} link${total === 1 ? '' : 's'}`,
              changedPaths,
            )
          : null;
        if (config.autoCommit) {
          markMigrationCommitted(repoPath);
        }
        return { added, commit, updated };
      } catch (error) {
        if (error instanceof CommandError) {
          throw errors.GIT_FAILED({ data: { command: error.command, stderr: error.stderr } });
        }
        throw error;
      }
    });
  });

/**
 * Regenerates README.md on demand.
 *
 * Mostly a repair hatch: the README is rewritten after every mutation anyway,
 * but a hand-edited or conflict-mangled file needs a way back. Running it
 * twice must produce no second commit.
 */
export const readmeRebuild = os.readme.rebuild
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors }) => {
    const { repoPath } = context;

    return context.state.withRepo(async () => {
      const changed = await regenerateReadme(repoPath, { fresh: true });

      try {
        const commit = changed
          ? await commitIfChanged(repoPath, 'docs: regenerate README', ['README.md'])
          : null;
        return { changed, commit };
      } catch (error) {
        if (error instanceof CommandError) {
          throw errors.GIT_FAILED({ data: { command: error.command, stderr: error.stderr } });
        }
        throw error;
      }
    });
  });
