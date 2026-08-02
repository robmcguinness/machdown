import { atomicWriteFile } from '#util/atomic-write.ts';
import { CLIPS_DIR, slugify } from './paths.ts';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { parseDocument, serializeDocument } from './frontmatter.ts';
import { UNCATEGORIZED } from '@machdown/contract/constants';
import path from 'node:path';
import { toUrlKey } from './urlKey.ts';

/**
 * Folds a pre-existing archive of loose `.md` files at the repository root into
 * `clips/`.
 *
 * Machdown has been writing loose `.md` files into a single directory since
 * before categories existed. Rather than make the user start over, adoption
 * moves those files into `clips/` and backfills the frontmatter the daemon
 * relies on (`url_key`, `categories`) while preserving `title`, `url`, `site`,
 * and the original `clipped` timestamp.
 */
export const adoptFlatClips = async (repoPath: string): Promise<number> => {
  const entries = await readdir(repoPath, { withFileTypes: true });
  const loose = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    // README.md is generated, never adopted.
    .filter((name) => name.toLowerCase() !== 'readme.md')
    .toSorted();

  if (loose.length === 0) {
    return 0;
  }

  const target = path.join(repoPath, CLIPS_DIR);
  await mkdir(target, { recursive: true });

  let migrated = 0;

  for (const name of loose) {
    const from = path.join(repoPath, name);
    const source = await readFile(from, 'utf8').catch(() => null);
    if (source === null) {
      continue;
    }

    const { body, frontmatter, hasFrontmatter } = parseDocument(source);
    const url = frontmatter.url ?? '';
    const title = frontmatter.title ?? path.basename(name, '.md');

    // Keep the existing filename when it is already a valid slug so the file
    // is a clean rename in git rather than a delete plus an add.
    const base = path.basename(name, '.md');
    const filename = `${slugify(base) || slugify(title) || 'clip'}.md`;
    const to = path.join(target, filename);

    await rename(from, to);

    const rewritten = serializeDocument(
      {
        categories: [UNCATEGORIZED],
        clipped: frontmatter.clipped ?? new Date().toISOString(),
        excerpt: frontmatter.excerpt,
        generator: 'machdown',
        mode: frontmatter.mode,
        site: frontmatter.site ?? '',
        tags: [UNCATEGORIZED],
        title,
        url,
        urlKey: url ? toUrlKey(url) : `local/${filename}`,
      },
      hasFrontmatter ? body : source,
    );

    await atomicWriteFile(to, rewritten);
    migrated += 1;
  }

  return migrated;
};
