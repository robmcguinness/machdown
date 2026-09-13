import {
  listRecentClips,
  loadClipIndex,
  lookupByUrl,
  readClip,
  readConfig,
  saveClip,
} from '#repo/store.ts';
import { authed, os, withRepoPath } from './base.ts';
import { CommandError } from '#util/exec.ts';
import { PathRejectedError } from '#repo/paths.ts';
import { commitIfChanged } from '#repo/git.ts';
import { ensureMigrated, migrationPaths, markMigrationCommitted } from '#repo/migrate.ts';
import { invalidateSuggestions } from '#suggest/cache.ts';
import { parseDocument } from '#repo/frontmatter.ts';
import { readFile } from 'node:fs/promises';
import { regenerateReadme } from '#repo/generate.ts';
import { scheduleIndexUpdate } from '#qmd/client.ts';

export const clipsLookup = os.clips.lookup
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, input }) => {
    const found = await lookupByUrl(context.repoPath, input.url);
    if (!found) {
      return { exists: false };
    }

    const { frontmatter } = parseDocument(await readFile(found.absPath, 'utf8'));

    return {
      exists: true,
      // Lets the popup distinguish "you bookmarked this" from "you clipped it",
      // and offer to upgrade the stub rather than warning about a duplicate.
      categories: frontmatter.categories ?? [],
      kind: frontmatter.kind === 'bookmark' ? ('bookmark' as const) : ('clip' as const),
      path: found.clip.relPath,
      title: frontmatter.title,
      updated: frontmatter.updated ?? found.clip.updated ?? found.clip.clipped,
    };
  });

export const clipsRecent = os.clips.recent
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, input }) => {
    const clips = await listRecentClips(context.repoPath, {
      categories: input.categories,
      limit: input.limit,
    });
    return {
      results: clips.map((clip) => ({
        categories: clip.categories,
        clipped: clip.clipped,
        kind: clip.kind,
        relPath: clip.relPath,
        site: clip.site,
        title: clip.title,
        updated: clip.updated,
        url: clip.url,
      })),
    };
  });

export const clipsRead = os.clips.read
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    try {
      return await readClip(context.repoPath, input.path);
    } catch (error) {
      if (error instanceof PathRejectedError) {
        throw errors.PATH_REJECTED();
      }
      throw errors.BAD_REQUEST({ message: 'That clip could not be read.' });
    }
  });

/**
 * Writes a batch of clips and produces exactly one commit.
 *
 * Batch-first by design: the popup sends an array of one and the batch page
 * sends forty, but a forty-tab export should be a single reviewable commit,
 * not forty. Individual clips can fail without failing the batch — the caller
 * gets a per-clip status so partial success is visible rather than silent.
 */
export const clipsSave = os.clips.save
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    const { repoPath } = context;
    await ensureMigrated(repoPath, context.state.withRepo);

    return context.state.withRepo(async () => {
      const [config, index] = await Promise.all([readConfig(repoPath), loadClipIndex(repoPath)]);

      const results: {
        error?: string;
        path?: string;
        status: 'created' | 'updated' | 'upgraded' | 'failed';
        url: string;
      }[] = [];

      const changedPaths = ['README.md', ...migrationPaths(repoPath)];
      let created = 0;
      let updated = 0;

      for (const clip of input.clips) {
        try {
          const saved = await saveClip(repoPath, clip, index, config);
          changedPaths.push(saved.relPath);
          if (saved.movedFrom) {
            changedPaths.push(saved.movedFrom);
          }
          results.push({ path: saved.relPath, status: saved.status, url: clip.url });
          if (saved.status === 'created') {
            created += 1;
          } else {
            updated += 1;
          }
        } catch (error) {
          // Any per-clip failure, a rejected path included, fails only this
          // clip. The batch still commits what it wrote.
          results.push({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed',
            url: clip.url,
          });
        }
      }

      const written = created + updated;
      if (written === 0) {
        return { commit: null, pushed: false, readmeUpdated: false, results };
      }

      // The table of contents is part of the same commit as the clips it
      // lists, so the repository is never internally inconsistent.
      const readmeUpdated = await regenerateReadme(repoPath, { snapshot: true });

      // New documents change what the suggester would recommend.
      invalidateSuggestions(repoPath);

      const message =
        input.commit?.message ??
        (written === 1
          ? `clip: ${results.find((r) => r.status !== 'failed')?.path ?? 'page'}`
          : `clip: ${written} pages`);

      try {
        const commit = config.autoCommit
          ? await commitIfChanged(repoPath, message, changedPaths)
          : null;

        if (config.autoCommit) {
          markMigrationCommitted(repoPath);
        }

        // Fire-and-forget: a batch save must not wait on the indexer.
        scheduleIndexUpdate({ collection: config.qmdCollection, repoPath });

        return { commit, pushed: false, readmeUpdated, results };
      } catch (error) {
        if (error instanceof CommandError) {
          throw errors.GIT_FAILED({ data: { command: error.command, stderr: error.stderr } });
        }
        throw error;
      }
    });
  });
