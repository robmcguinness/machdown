import { CLIPS_DIR, META_DIR } from '#repo/paths.ts';
import { authed, os } from './base.ts';
import { clearHealthCache } from './health.ts';
import { commitIfChanged, init, isGitRepo, status } from '#repo/git.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig, invalidateClipSnapshot, warmClipSnapshot, writeConfig } from '#repo/store.ts';
import { CommandError } from '#util/exec.ts';
import type { MachdownConfig } from '@machdown/contract';
import { adoptFlatClips } from '#repo/adopt.ts';
import {
  type MigrationReport,
  migrateRepo,
  migrationPaths,
  markMigrationCommitted,
} from '#repo/migrate.ts';
import { warmIndex } from '#qmd/client.ts';
import path from 'node:path';
import { regenerateReadme } from '#repo/generate.ts';
import { resolveRepoPath } from '#config.ts';

/** Only daemon-managed noise; the clips themselves are the point of the repo. */
const GITIGNORE = `.DS_Store
node_modules
`;

const ensureScaffold = async (repoPath: string): Promise<MachdownConfig> => {
  await mkdir(path.join(repoPath, META_DIR), { recursive: true });
  // One flat directory for clips and bookmarks alike; categories are metadata.
  await mkdir(path.join(repoPath, CLIPS_DIR), { recursive: true });

  const gitignorePath = path.join(repoPath, '.gitignore');
  await writeFile(gitignorePath, GITIGNORE, { encoding: 'utf8', flag: 'wx' }).catch(() => {
    // Already present: leave the user's version alone.
  });

  // Writing back what we read is a no-op on an initialized repo and seeds the
  // defaults on a fresh one, so scaffolding stays idempotent either way.
  const config = await readConfig(repoPath);
  await writeConfig(repoPath, config);
  return config;
};

const commitMessage = (adopted: number, layout: MigrationReport | null): string => {
  if (layout) {
    const parts = [`chore: flatten ${layout.flattened} clip${layout.flattened === 1 ? '' : 's'}`];
    if (layout.bookmarksConverted > 0) {
      parts.push(
        `${layout.bookmarksConverted} bookmark${layout.bookmarksConverted === 1 ? '' : 's'}`,
      );
    }
    return `${parts.join(' and ')} into the flat layout`;
  }
  if (adopted > 0) {
    return `chore: adopt ${adopted} existing clip${adopted === 1 ? '' : 's'} into machdown`;
  }
  return 'chore: initialize machdown repository';
};

/**
 * Points the daemon at a git-backed clip repository, creating or adopting one.
 *
 * Idempotent: running it against an already-initialized repo re-scaffolds
 * missing pieces, rebuilds the index, and commits nothing if nothing changed.
 */
export const repoInit = os.repo.init.use(authed).handler(async ({ context, errors, input }) => {
  const repoPath = resolveRepoPath(input.path);

  return context.state.withRepo(async () => {
    try {
      await mkdir(repoPath, { recursive: true });

      if (!(await isGitRepo(repoPath))) {
        await init(repoPath);
      }

      await ensureScaffold(repoPath);

      const migrated = input.adoptFlatClips ? await adoptFlatClips(repoPath) : 0;

      // Already inside the mutex, so call the migration directly rather than
      // going through `ensureMigrated` and deadlocking on a re-entrant lock.
      const layout = await migrateRepo(repoPath);

      invalidateClipSnapshot(repoPath);
      await regenerateReadme(repoPath);

      // Fire-and-forget: a repository is perfectly usable before its clips are
      // searchable, and a first index of a large archive takes a while.
      const config = await readConfig(repoPath);
      warmIndex({ collection: config.qmdCollection, repoPath });
      void warmClipSnapshot(repoPath);

      const commit = await commitIfChanged(repoPath, commitMessage(migrated, layout), [
        'README.md',
        '.gitignore',
        '.machdown',
        'clips',
        ...migrationPaths(repoPath),
      ]);
      markMigrationCommitted(repoPath);

      // Persist only after the repo is actually usable.
      context.state.config.repoPath = repoPath;
      await context.state.persist();
      // The health cache may still hold answers probed against the previous
      // repository — or against none at all — so drop them now.
      clearHealthCache();

      return {
        commit,
        layout: layout
          ? {
              bookmarksConverted: layout.bookmarksConverted,
              flattened: layout.flattened,
              from: layout.from,
              renamed: layout.renamed,
              to: layout.to,
            }
          : null,
        migrated,
        repo: await status(repoPath),
      };
    } catch (error) {
      if (error instanceof CommandError) {
        throw errors.GIT_FAILED({ data: { command: error.command, stderr: error.stderr } });
      }
      throw error;
    }
  });
});
