import { authed, os, withRepoPath } from './base.ts';
import { readConfig, writeConfig } from '#repo/store.ts';
import { CommandError } from '#util/exec.ts';
import { commitIfChanged } from '#repo/git.ts';
import { sanitizeCategory } from '#repo/paths.ts';
import { warmIndex } from '#qmd/client.ts';

/**
 * The repository owns the canonical category list; the extension keeps a cache
 * and refreshes it from here whenever the daemon is reachable. Making the repo
 * authoritative means the list survives a browser reinstall and travels with a
 * `git clone`.
 */
export const configGet = os.config.get
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context }) => readConfig(context.repoPath));

export const configUpdate = os.config.update
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    const { repoPath } = context;

    return context.state.withRepo(async () => {
      const current = await readConfig(repoPath);

      // Categories become directory names, so re-validate rather than trusting
      // the schema alone; drop anything that does not survive sanitization.
      const categories = input.categories
        ? [...new Set(input.categories.map(sanitizeCategory))]
        : current.categories;

      const next = {
        ...current,
        ...input,
        categories,
        defaultCategory: input.defaultCategory
          ? sanitizeCategory(input.defaultCategory)
          : current.defaultCategory,
        version: 1 as const,
      };

      // The default has to be selectable, or the popup offers something the
      // repo will silently reject.
      if (!next.categories.includes(next.defaultCategory)) {
        next.categories = [...next.categories, next.defaultCategory];
      }

      await writeConfig(repoPath, next);

      // Unconditional rather than only on rename: the name can stay the same
      // while the documents indexed under it came from a directory this daemon
      // no longer serves, and that failure is silent — search keeps returning
      // another repository's clips. Re-scanning is what deactivates them.
      warmIndex({ collection: next.qmdCollection, repoPath });

      try {
        await commitIfChanged(repoPath, 'chore: update machdown config', ['.machdown/config.json']);
      } catch (error) {
        if (error instanceof CommandError) {
          throw errors.GIT_FAILED({
            data: { command: error.command, stderr: error.stderr },
          });
        }
        throw error;
      }

      return next;
    });
  });
