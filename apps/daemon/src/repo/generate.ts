import { atomicWriteFile } from '#util/atomic-write.ts';
import { type ReadmeEntry, renderReadme } from './readme.ts';
import {
  readConfig,
  scanClips,
  snapshotClips,
  invalidateClipSnapshot,
  type ScanOptions,
} from './store.ts';
import { readFile } from 'node:fs/promises';
import { META_DIR } from './paths.ts';
import path from 'node:path';

export const README_PATH = 'README.md';
export const INTRO_PATH = `${META_DIR}/readme-intro.md`;

const readIntro = async (repoPath: string): Promise<string | undefined> => {
  try {
    return await readFile(path.join(repoPath, INTRO_PATH), 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Rebuilds `README.md` from the repository's current contents.
 *
 * Everything comes from one scan now that bookmarks are stub files rather than
 * a JSON sidecar, so there is nothing left to merge or dedupe: a URL has one
 * document, and whether it renders with a `[clip]` link is decided by that
 * document's `kind`. A bookmark that is later clipped in full keeps its file and
 * simply grows the link.
 *
 * Returns whether anything actually changed — the file is only written when
 * the bytes differ, so a no-op rebuild leaves the working tree clean.
 */
export const regenerateReadme = async (
  repoPath: string,
  options: ScanOptions = {},
): Promise<boolean> => {
  if (options.fresh) {
    invalidateClipSnapshot(repoPath);
  }
  const [config, clips, intro] = await Promise.all([
    readConfig(repoPath),
    options.snapshot ? snapshotClips(repoPath, options) : scanClips(repoPath, options),
    readIntro(repoPath),
  ]);

  const byKey = new Map<string, ReadmeEntry>();

  for (const clip of clips) {
    byKey.set(clip.urlKey, {
      title: clip.title,
      url: clip.url || clip.relPath,
      // A stub has no page contents worth linking to, so it renders as a bare
      // link — byte-identical to how bookmarks rendered before they were files.
      categories: clip.categories,
      clipPath: clip.kind === 'bookmark' ? undefined : clip.relPath,
      note: clip.note,
    });
  }

  const next = renderReadme({
    entries: [...byKey.values()],
    intro,
    title: config.readmeTitle,
  });

  const target = path.join(repoPath, README_PATH);
  const current = await readFile(target, 'utf8').catch(() => null);

  if (current === next) {
    return false;
  }

  await atomicWriteFile(target, next);
  return true;
};
