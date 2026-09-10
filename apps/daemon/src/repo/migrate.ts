import { atomicWriteFile } from '#util/atomic-write.ts';
import { CLIPS_DIR, META_DIR, resolveClipPath, sanitizeCategories } from './paths.ts';
import { LAYOUT_VERSION, UNCATEGORIZED } from '@machdown/contract/constants';
import {
  allocateFilename,
  readConfig,
  invalidateClipSnapshot,
  loadClipIndex,
  saveBookmark,
  writeConfig,
} from './store.ts';
import { type ParsedDocument, parseDocument, serializeDocument, urlKeyOf } from './frontmatter.ts';
import { readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import type { BookmarkPayload, MachdownConfig } from '@machdown/contract';
import path from 'node:path';
import { regenerateReadme } from './generate.ts';
import { getLog } from '#server/request-store.ts';
import { z } from 'zod';

/**
 * Upgrades a repository through the flat layout and the in-memory URL index.
 *
 * The old layout let the filesystem disagree with the metadata: a clip's
 * directory *was* its primary category, so renaming a category stranded files,
 * and `scanClips` would resurrect a deleted category from the directory name.
 * Flattening makes frontmatter the only source of truth.
 *
 * Everything here is idempotent and guarded by `layoutVersion` in the committed
 * config, so a repo cloned to a second machine migrates at most once.
 */

// Migration writes may precede the first save (at boot). Keep their exact paths
// until a successful commit, so scoping saves does not leave half a layout in Git.
const pendingPaths = new Map<string, Set<string>>();
const trackMigration = (repoPath: string, ...paths: string[]): void => {
  const pending = pendingPaths.get(repoPath) ?? new Set<string>();
  for (const entry of paths) {
    pending.add(entry);
  }
  pendingPaths.set(repoPath, pending);
};
export const migrationPaths = (repoPath: string): string[] => [
  ...(pendingPaths.get(repoPath) ?? []),
];
export const markMigrationCommitted = (repoPath: string): void => {
  pendingPaths.delete(repoPath);
};

const BOOKMARKS_FILE = `${META_DIR}/bookmarks.json`;

/**
 * How many nested files the flatten walk reads before it starts renaming them.
 *
 * Matches the scan: enough reads in flight to saturate the disk, small enough
 * that only a batch of file bodies is live at once rather than the whole
 * pre-flatten archive.
 */
const FLATTEN_READ_BATCH = 16;

export type MigrationReport = {
  from: number;
  to: number;
  /** Files pulled up out of a category directory. */
  flattened: number;
  /** `bookmarks.json` rows rewritten as stub documents. */
  bookmarksConverted: number;
  /** Whether the obsolete committed URL index was removed. */
  indexRemoved: boolean;
  /**
   * Collisions resolved by suffixing. Two same-titled pages could coexist as
   * `A/foo.md` and `B/foo.md`; flattened, one has to become `foo-2.md`.
   */
  removedDirs: string[];
  renamed: { from: string; to: string }[];
};

const LegacyBookmarkSchema = z.object({
  addedAt: z.string().optional(),
  categories: z.array(z.string()).optional(),
  note: z.string().optional(),
  site: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  urlKey: z.string().optional(),
});

type LegacyBookmark = z.output<typeof LegacyBookmarkSchema>;

const LegacyBookmarksFileSchema = z.looseObject({
  bookmarks: z.array(z.unknown()).optional(),
});

/** Keeps whatever rows still parse rather than discarding the whole file over one bad row. */
const readLegacyBookmarks = async (repoPath: string): Promise<LegacyBookmark[]> => {
  try {
    const raw = LegacyBookmarksFileSchema.parse(
      JSON.parse(await readFile(path.join(repoPath, BOOKMARKS_FILE), 'utf8')),
    );
    return (raw.bookmarks ?? []).flatMap((entry) => {
      const parsed = LegacyBookmarkSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
};

/** Every `*.md` under `clips/`, deepest paths last, in a stable order. */
const listNested = async (clipsRoot: string): Promise<string[]> => {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(full);
      }
    }
  };

  await walk(clipsRoot);
  return found.toSorted();
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/** Bottom-up, so a category directory whose only child was also empty goes too. */
const removeEmptyDirs = async (clipsRoot: string): Promise<string[]> => {
  const removed: string[] = [];

  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!(await walk(path.join(dir, entry.name)))) {
          empty = false;
        }
      } else {
        empty = false;
      }
    }

    if (empty && dir !== clipsRoot) {
      await rmdir(dir).catch(() => null);
      removed.push(path.basename(dir));
      return true;
    }
    return empty;
  };

  await walk(clipsRoot);
  return removed;
};

/**
 * Restores the category a pre-flatten file carried in its directory name.
 *
 * Files that predate the `categories` key encoded it as `clips/<Category>/…`.
 * Flattening throws that path away, so the category has to move into the
 * frontmatter or it is lost. This is the one place the migration rewrites a
 * document rather than renaming it, which is why it reads as a whole
 * `serializeDocument` call and not a patch.
 *
 * `source` is the untouched file: a document with no frontmatter block at all
 * keeps its bytes, byte-order mark included, rather than the normalized body.
 */
type BackfillCategoriesOptions = {
  base: string;
  parsed: ParsedDocument;
  relFromClips: string;
  source: string;
  target: string;
};

const backfillCategories = async (options: BackfillCategoriesOptions): Promise<void> => {
  const { base, parsed, relFromClips, source, target } = options;
  const { body, frontmatter, hasFrontmatter } = parsed;
  const category = relFromClips.split(path.sep)[0];
  const categories = sanitizeCategories(category ? [category] : [UNCATEGORIZED]);

  await atomicWriteFile(
    target,
    serializeDocument(
      {
        categories,
        clipped: frontmatter.clipped ?? new Date().toISOString(),
        excerpt: frontmatter.excerpt,
        generator: 'machdown',
        kind: frontmatter.kind === 'bookmark' ? 'bookmark' : undefined,
        mode: frontmatter.mode,
        note: frontmatter.note,
        site: frontmatter.site ?? '',
        tags: frontmatter.tags?.length ? frontmatter.tags : categories,
        title: frontmatter.title ?? base,
        updated: frontmatter.updated,
        url: frontmatter.url ?? '',
        urlKey: urlKeyOf(frontmatter),
      },
      hasFrontmatter ? body : source,
    ),
  );
};

/**
 * Moves one nested clip into the flat directory.
 *
 * The frontmatter is left untouched so the move is a pure rename — git detects
 * it at 100% similarity, and `git log --follow` keeps tracing the file's
 * history through the migration.
 */
type FlattenOneOptions = {
  absPath: string;
  clipsRoot: string;
  repoPath: string;
  report: MigrationReport;
  source: string | null;
};

const flattenOne = async (options: FlattenOneOptions): Promise<void> => {
  const { absPath, clipsRoot, repoPath, report, source } = options;
  // Unreadable, or read away by a concurrent process since the walk listed it.
  if (source === null) {
    return;
  }

  const relFromClips = path.relative(clipsRoot, absPath);
  const base = path.basename(absPath, '.md');

  const { body, frontmatter, hasFrontmatter } = parseDocument(source);
  const urlKey = urlKeyOf(frontmatter) ?? null;

  let target = await resolveClipPath(repoPath, base);

  if (await exists(target)) {
    // Same URL already sitting flat (a half-finished migration): drop the
    // duplicate rather than creating a second file for one document.
    const rival = parseDocument(await readFile(target, 'utf8').catch(() => ''));
    const rivalKey = urlKeyOf(rival.frontmatter) ?? null;

    if (urlKey !== null && urlKey === rivalKey) {
      trackMigration(repoPath, path.relative(repoPath, absPath));
      await rm(absPath, { force: true });
      report.flattened += 1;
      return;
    }

    const allocated = await allocateFilename(repoPath, base);
    target = await resolveClipPath(repoPath, allocated);
    report.renamed.push({
      from: `${CLIPS_DIR}/${relFromClips}`,
      to: `${CLIPS_DIR}/${allocated}.md`,
    });
  }

  trackMigration(repoPath, path.relative(repoPath, absPath), path.relative(repoPath, target));
  await rename(absPath, target);
  report.flattened += 1;

  if (!frontmatter.categories?.length) {
    await backfillCategories({
      base,
      parsed: { body, frontmatter, hasFrontmatter },
      relFromClips,
      source,
      target,
    });
  }
};

const flattenLayout = async (
  repoPath: string,
  config: MachdownConfig,
  report: MigrationReport,
): Promise<void> => {
  const clipsRoot = path.join(repoPath, CLIPS_DIR);

  // Only nested files move; a file already sitting flat has nothing to flatten.
  const nested = (await listNested(clipsRoot)).filter(
    (absPath) => path.dirname(path.relative(clipsRoot, absPath)) !== '.',
  );

  // Reads overlap, renames do not. Overlapping is safe because every source
  // here is nested, while every rename target `resolveClipPath` can produce
  // sits flat in `clips/` — so no read can observe a file another iteration
  // moved. The renames stay sequential because collision suffixing depends on
  // what earlier iterations have already placed.
  //
  // Reading a batch at a time rather than the whole list keeps at most
  // `FLATTEN_READ_BATCH` file bodies in memory; each batch is flattened and
  // released before the next is read. Sorted order is preserved throughout,
  // which makes suffix assignment deterministic — migrating the same repo on
  // two machines produces the same filenames.
  for (let start = 0; start < nested.length; start += FLATTEN_READ_BATCH) {
    const batch = nested.slice(start, start + FLATTEN_READ_BATCH);
    const sources = await Promise.all(
      batch.map((absPath) => readFile(absPath, 'utf8').catch(() => null)),
    );

    for (const [offset, absPath] of batch.entries()) {
      await flattenOne({ absPath, clipsRoot, repoPath, report, source: sources[offset] });
    }
  }

  report.removedDirs = await removeEmptyDirs(clipsRoot);

  const legacy = await readLegacyBookmarks(repoPath);
  if (legacy.length > 0) {
    invalidateClipSnapshot(repoPath);
    const index = await loadClipIndex(repoPath, { fresh: true });

    for (const bookmark of legacy) {
      if (!bookmark.url) {
        continue;
      }
      const payload: BookmarkPayload = {
        addedAt: bookmark.addedAt,
        categories: bookmark.categories?.length ? bookmark.categories : [UNCATEGORIZED],
        note: bookmark.note,
        siteName: bookmark.site,
        title: bookmark.title ?? bookmark.url,
        url: bookmark.url,
      };
      // A single unconvertible row must not abandon the rest of the migration,
      // but a failure still must not count as a conversion.
      try {
        const saved = await saveBookmark(repoPath, payload, index, config);
        trackMigration(repoPath, saved.relPath);
        if (saved.movedFrom) {
          trackMigration(repoPath, saved.movedFrom);
        }
        report.bookmarksConverted += 1;
      } catch (error) {
        getLog().warn({ err: error, url: bookmark.url }, 'could not convert a legacy bookmark');
      }
    }
  }

  trackMigration(repoPath, BOOKMARKS_FILE, 'README.md');
  await rm(path.join(repoPath, BOOKMARKS_FILE), { force: true });
  invalidateClipSnapshot(repoPath);
  await regenerateReadme(repoPath);
};

/**
 * Runs the layout upgrade if this repo has not had it. Must be called with the
 * repo mutex held. Returns `null` when there was nothing to do.
 */
export const migrateRepo = async (repoPath: string): Promise<MigrationReport | null> => {
  const config = await readConfig(repoPath);
  if (config.layoutVersion >= LAYOUT_VERSION) {
    return null;
  }

  const report: MigrationReport = {
    bookmarksConverted: 0,
    flattened: 0,
    from: config.layoutVersion,
    indexRemoved: false,
    removedDirs: [],
    renamed: [],
    to: LAYOUT_VERSION,
  };

  if (config.layoutVersion < 2) {
    await flattenLayout(repoPath, config, report);
  }

  if (config.layoutVersion < 3) {
    const indexFile = `${META_DIR}/index.json`;
    report.indexRemoved = await exists(path.join(repoPath, indexFile));
    await rm(path.join(repoPath, indexFile), { force: true });
    trackMigration(repoPath, indexFile);
  }

  trackMigration(repoPath, `${META_DIR}/config.json`);
  await writeConfig(repoPath, { ...config, layoutVersion: LAYOUT_VERSION });

  return report;
};

/**
 * At most one migration per repo per process.
 *
 * The daemon can reach a repo three ways — boot, `repo.init`, and a save
 * against a path set by `MACHDOWN_REPO` — and all three should be safe to call
 * without anyone tracking whether the upgrade already ran.
 */
const inFlight = new Map<string, Promise<MigrationReport | null>>();

export const ensureMigrated = (
  repoPath: string,
  withRepo: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<MigrationReport | null> => {
  const pending = inFlight.get(repoPath);
  if (pending) {
    return pending;
  }

  const run = withRepo(() => migrateRepo(repoPath)).catch((cause: unknown) => {
    // A failed migration must not poison the cache: the next save retries.
    inFlight.delete(repoPath);
    throw cause;
  });

  inFlight.set(repoPath, run);
  return run;
};

/** Test seam: forgets which repos have been checked this process. */
export const resetMigrationCache = (): void => {
  inFlight.clear();
  pendingPaths.clear();
};
