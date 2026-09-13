import { authed, os, withRepoPath } from './base.ts';
import { loadClipIndex, readConfig, saveBookmark } from '#repo/store.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { PathRejectedError, assertWithinAny } from '#repo/paths.ts';
import { CommandError } from '#util/exec.ts';
import { appendBookmarks } from '#bookmarks/file.ts';
import { allowedRoots } from './system.ts';
import { atomicWriteFile } from '#util/atomic-write.ts';
import { clearHealthCache } from './health.ts';
import { commitIfChanged } from '#repo/git.ts';
import { createMutex, type Mutex } from '#util/mutex.ts';
import { ensureMigrated, migrationPaths, markMigrationCommitted } from '#repo/migrate.ts';
import { expandHome } from '#config.ts';
import { invalidateSuggestions } from '#suggest/cache.ts';
import { isErrnoException } from '#util/errors.ts';
import path from 'node:path';
import { regenerateReadme } from '#repo/generate.ts';
import { scheduleIndexUpdate } from '#qmd/client.ts';

/** The one file every append writes to, inside the configured folder. */
const BOOKMARKS_FILE = 'bookmarks.md';

/**
 * One mutex per bookmarks file.
 *
 * The repository mutex is the wrong lock here — bookmarks live outside any
 * repository, and a clip batch holding that lock must not stall a bookmark.
 * The read-modify-write below is not atomic on its own, so two windows saving
 * their tabs at once would otherwise lose one of the two appends.
 */
const fileLocks = new Map<string, Mutex>();

const lockFor = (file: string): Mutex => {
  const existing = fileLocks.get(file);
  if (existing) {
    return existing;
  }
  const created = createMutex();
  fileLocks.set(file, created);
  return created;
};

/**
 * Chooses the folder that holds `bookmarks.md`.
 *
 * Containment-checked against the same roots as the directory picker: the
 * extension can type a path as well as browse to one, and only one of those
 * two ways in may be checked.
 */
export const bookmarksSetLocation = os.bookmarks.setLocation
  .use(authed)
  .handler(async ({ context, errors, input }) => {
    const { config } = context.state;
    const candidate = path.resolve(expandHome(input.path.trim()));

    let target: string;
    try {
      target = await assertWithinAny(
        allowedRoots(config.repoPath, config.bookmarksPath),
        candidate,
      );
    } catch (error) {
      if (error instanceof PathRejectedError) {
        throw errors.PATH_REJECTED();
      }
      throw error;
    }

    await mkdir(target, { recursive: true });

    config.bookmarksPath = target;
    await context.state.persist();
    // Health reports the folder, and the extension gates its bookmark button on
    // it, so a stale cached answer would leave the button disabled for the TTL.
    await clearHealthCache();

    return { path: target };
  });

/**
 * Appends links to `bookmarks.md`.
 *
 * No git, no repository, no stub documents: a bookmark is a line in a file the
 * user chose the folder for. Duplicates are skipped rather than rejected, so
 * saving a whole window twice is safe and reports how much of it was already
 * there.
 */
export const bookmarksAppend = os.bookmarks.append
  .use(authed)
  .handler(async ({ context, errors, input }) => {
    const { bookmarksPath } = context.state.config;
    if (!bookmarksPath) {
      throw errors.NO_BOOKMARKS_DIR();
    }

    const file = path.join(bookmarksPath, BOOKMARKS_FILE);

    return lockFor(file)(async () => {
      let existing: string | null = null;
      try {
        existing = await readFile(file, 'utf8');
      } catch (cause) {
        // A first bookmark in a fresh folder is the normal case, not a failure.
        if (!isErrnoException(cause) || cause.code !== 'ENOENT') {
          throw cause;
        }
      }

      const { added, content, skipped } = appendBookmarks(existing, input.links, new Date());

      // `appendBookmarks` returns the input unchanged when nothing was added, so
      // an all-duplicate batch does not rewrite the file or touch its mtime.
      if (added > 0) {
        await mkdir(bookmarksPath, { recursive: true });
        await atomicWriteFile(file, content);
      }

      return { added, path: file, skipped };
    });
  });

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
      const [config, index] = await Promise.all([readConfig(repoPath), loadClipIndex(repoPath)]);

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
